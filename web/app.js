import {project} from './model.js';
import {validateRecord, photoHash} from './schema.js';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateLabel = s => new Date(s).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
let db, state = {records:[],outbox:[],cursor:0}, busy=false, queue=Promise.resolve(), syncError='', authRequired=false, toastTimer, syncTimer, retryDelay=2000, gridKey='', groupsKey='';
function stored(value) { return new Promise((resolve,reject) => { const tx=db.transaction('state','readwrite'); tx.objectStore('state').put(value,'main'); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error); }); }
function mutate(fn) { const task=queue.then(async()=>{ const next=structuredClone(state); fn(next); await stored(next); state=next; render(); }); queue=task.catch(()=>{}); return task; }
function record(type, fields) {return {id:crypto.randomUUID(),type,recordedAt:new Date().toISOString(),...fields};}
async function add(records) {await mutate(s=>{s.records.push(...records);s.outbox.push(...records);const garment=records.find(r=>r.type==='garment');if(garment)s.lastGroup=garment.group;}); void sync();}
function notify(message, undoIds=[]) {clearTimeout(toastTimer);$('toast').hidden=false;$('toast').replaceChildren(document.createTextNode(message));if(undoIds.length){const b=document.createElement('button');b.textContent='Undo';b.onclick=async()=>{try{await add([record('undo',{eventIds:undoIds})]);notify('Undone');}catch(e){notify(e.message);}};$('toast').append(b);}toastTimer=setTimeout(()=>$('toast').hidden=true,7000);}
const shirtIcon='<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m16 9-5 3-7 9 8 6 4-5v18h16V22l4 5 8-6-7-9-5-3c0 8-16 8-16 0Z" stroke-linejoin="round"/></svg>';
function renderStatus() {
 $('signin').hidden=!authRequired;
 const pending=state.outbox.length;
 const offline=navigator.onLine===false;
 $('status').dataset.state=authRequired?'auth':busy?'syncing':syncError?(offline||syncError.startsWith('Connection')?'offline':'error'):pending?'pending':'saved';
 $('status').textContent=authRequired?(pending?`${pending} pending`:'Sign-in needed'):busy?'Syncing…':syncError?(pending?`${pending} pending · saved locally`:'Offline'):pending?`${pending} pending`:'Saved';
 $('status').title=syncError||'Changes sync automatically';
}
function render() {
 renderStatus();
 const garments=project(state.records);
 let filter=$('filter').value;
 const groups=[...new Set(garments.map(g=>g.group))].sort();
 const nextGroups=JSON.stringify(groups);
 if(groupsKey!==nextGroups){$('filter').innerHTML='<option value="">All groups</option>'+groups.map(g=>`<option>${esc(g)}</option>`).join('');$('filter').value=groups.includes(filter)?filter:'';groupsKey=nextGroups;}
 filter=$('filter').value;
 const worn=garments.filter(g=>g.count>0).length;
 $('total').textContent=garments.length?`${garments.length} ${garments.length===1?'garment':'garments'} · ${worn} worn`:'Add your clothes to get started';
 const nextKey=JSON.stringify([filter,garments.map(g=>[g.id,g.name,g.group,g.count,g.history.at(-1)?.id,Boolean(g.photo)])]);
 if(gridKey===nextKey)return;
 gridKey=nextKey;
 const shown=garments.filter(g=>!filter||g.group===filter);
 $('grid').innerHTML=shown.length?shown.map(g=>{
  const last=g.history.at(-1),label=g.name||`${g.group} garment`;
  return `<article class="card"><button class="photo-button" data-detail="${esc(g.id)}" aria-label="History for ${esc(label)}">${g.photo?`<img src="${esc(g.photo)}" alt="${esc(label)}">`:`<span class="photo-placeholder">${shirtIcon}</span>`}</button><div class="card-body"><div class="card-meta"><span class="count">${g.count} <small>${g.count===1?'wear':'wears'}</small></span><span class="group-name">${esc(g.group)}</span></div>${g.name?`<h3>${esc(g.name)}</h3>`:''}<p class="last">${last?`Logged ${esc(dateLabel(last.recordedAt))}`:'Not worn since washing'}</p><button class="wear" data-wear="${esc(g.id)}">+1 Wear now</button></div></article>`;
 }).join(''):`<div class="empty">${shirtIcon}<h2>${filter?'No garments in this group':'No garments yet'}</h2><p>Add a photo, choose a wash group, and start counting wears.</p><button class="primary" id="empty-add">Add garment</button></div>`;
 $('empty-add')?.addEventListener('click',addDialog);
 document.querySelectorAll('[data-wear]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const r=record('wear',{garmentId:b.dataset.wear,quantity:1,wornOn:today()});await add([r]);notify('Wear saved',[r.id]);}catch(e){notify('Could not save: '+e.message);b.disabled=false;}});
 document.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>detailDialog(b.dataset.detail));
}
function scheduleSync(delay=30000) {
 clearTimeout(syncTimer);
 if(!db||document.hidden||authRequired||navigator.onLine===false)return;
 syncTimer=setTimeout(()=>void sync(),delay);
}
function jpegBytes(dataURL) {
 const raw=atob(dataURL.split(',')[1]);return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
async function checkedFetch(url,options={}) {
 const response=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(20000)});
 if(response.type==='opaqueredirect'||[301,302,303,307,308,401,403].includes(response.status)){authRequired=true;throw new Error('AUTH_REQUIRED');}
 if(!response.ok){let message='Sync failed. Please retry.';try{message=(await response.json()).error||message;}catch{}throw new Error(message);}
 return response;
}
async function hydrate(records) {
 const local=new Map(state.records.map(r=>[r.id,r]));
 const hydrated=[];
 for(const r of records){
   if(r.type==='garment'&&r.photoHash){
     const existing=local.get(r.id);
     if(existing?.photo&&existing.photoHash===r.photoHash)r.photo=existing.photo;
     else {
       const response=await checkedFetch('/api/photos/'+r.photoHash);
       const bytes=new Uint8Array(await response.arrayBuffer());
       if(await photoHash(bytes)!==r.photoHash)throw new Error('Photo verification failed');
       let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
       r.photo='data:image/jpeg;base64,'+btoa(binary);
     }
   }
   hydrated.push(r);
 }
 return hydrated;
}
async function sync() {
 if(busy||!db)return;clearTimeout(syncTimer);
 if(navigator.onLine===false){syncError='Connection unavailable';renderStatus();return;}
 busy=true;syncError='';renderStatus();
 try {
  await queue;
  let more=true;
  while(more){
   const batch=state.outbox.slice(0,25);
   for(const r of batch){if(r.type==='garment'&&r.photoHash&&r.photo){
    await checkedFetch('/api/photos/'+r.photoHash,{method:'PUT',headers:{'Content-Type':'image/jpeg'},body:jpegBytes(r.photo)});
   }}
   const response=await checkedFetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({records:batch.map(validateRecord),cursor:state.cursor||0})});
   const remote=await response.json();
   if(remote.version!==2||!Array.isArray(remote.records)||!Array.isArray(remote.acknowledged)||!Number.isSafeInteger(remote.cursor))throw new Error('Unexpected server response');
   const incoming=await hydrate(remote.records);
   if(incoming.length||remote.acknowledged.length||remote.cursor!==state.cursor)await mutate(s=>{
     const acknowledged=new Set(remote.acknowledged);
     s.outbox=s.outbox.filter(r=>!acknowledged.has(r.id));
     const all=new Map(s.records.map(r=>[r.id,r]));
     for(const r of incoming)all.set(r.id,r);
     for(const r of s.outbox)all.set(r.id,r);
     s.records=[...all.values()];s.cursor=remote.cursor;
   });
   more=remote.hasMore||state.outbox.length>0;
  }
  authRequired=false;retryDelay=2000;
 }catch(e){syncError=e.message==='AUTH_REQUIRED'?'Sign in to sync; changes are saved':e instanceof TypeError||e.name==='TimeoutError'?'Connection unavailable; changes stay on this phone':e.message;}
 finally{busy=false;renderStatus();scheduleSync(syncError?retryDelay:30000);if(syncError)retryDelay=Math.min(retryDelay*2,30000);}
}
function dialog(title,content,buttons,onSubmit){$('dialog').onpaste=null;$('dialog').onclose=null;$('dialog').oncancel=null;$('dialog-title').textContent=title;$('dialog-content').innerHTML=content;$('dialog-actions').innerHTML=buttons;$('form-error').textContent='';$('form').onsubmit=async e=>{e.preventDefault();const submit=$('form').querySelector('[type=submit]');if(submit)submit.disabled=true;try{await onSubmit();}catch(err){$('form-error').textContent=err.message;}finally{if(submit)submit.disabled=submit.dataset.unavailable==='true';}};$('dialog').showModal();}
const saveButton = text => `<button type="submit" class="primary">${text}</button>`;
function addDialog(){
 const groups=[...new Set(project(state.records).map(g=>g.group))].sort();
 const preferred=$('filter').value||state.lastGroup||groups[0];
 const selected=groups.indexOf(preferred);
 const options=groups.map((g,i)=>`<option value="${i}" ${i===selected?'selected':''}>${esc(g)}</option>`).join('');
 dialog('Add garment',`
  <div id="batch-progress" class="batch-progress" hidden><div><span id="batch-position"></span><span id="batch-added"></span></div><progress id="batch-meter" aria-label="Photos processed" value="0" max="1"></progress></div>
  <button type="button" id="upload-area" class="upload-area" aria-label="Choose photos">${shirtIcon}<span id="upload-label">Choose or paste a photo</span></button>
  <canvas class="crop" id="crop" width="640" height="640" aria-label="Drag to crop garment photo" hidden></canvas>
  <input id="photo" type="file" accept="image/*" multiple aria-label="Garment photos" hidden>
  <input id="replacement-photo" type="file" accept="image/*" aria-label="Replacement photo" hidden>
  <div class="photo-controls"><button type="button" class="secondary" id="choose-photo">Choose photos</button><button type="button" class="secondary" id="paste-photo">Paste image</button></div>
  <label id="zoom-label" class="crop-label" hidden>Drag to reposition · zoom<input id="zoom" type="range" min="1" max="3" step="0.01" value="1"></label>
  <label>Wash group<select id="group-select">${options}<option value="new" ${groups.length?'':'selected'}>New group…</option></select></label>
  <label id="new-group-label" ${groups.length?'hidden':''}>New group name<input id="group" maxlength="80" placeholder="e.g. Merino" ${groups.length?'':'required'} autocomplete="off"></label>
  <button type="button" id="add-name" class="quiet add-name" hidden>Add a name</button>
  <label id="name-label">Name <span class="optional">optional</span><input id="name" maxlength="120" autocomplete="off"></label>`,
  '<button type="button" class="secondary" id="skip-photo" hidden>Skip photo</button>'+saveButton('Add garment'),async()=>{
   if(loading||saving||!image)throw new Error('Choose or paste a photo first.');
   const group=$('group-select').value==='new'?$('group').value.trim():groups[Number($('group-select').value)];
   if(!group)throw new Error('Enter a wash group.');
   saving=true;refresh();
   try{
    const photo=canvas.toDataURL('image/jpeg',0.82);
    await add([record('garment',{name:$('name').value.trim(),group,photo,photoHash:await photoHash(jpegBytes(photo))})]);
    added++;
    if(!groups.includes(group)){
     groups.push(group);
     $('group-select').add(new Option(group,String(groups.length-1)),$('group-select').options.length-1);
    }
    $('group-select').value=String(groups.indexOf(group));
    $('new-group-label').hidden=true;$('group').required=false;
    await advance();
   }finally{saving=false;if(alive)refresh();}
  });
 let image=null,scale=1,x=0,y=0,dragging=null,files=[],position=0,added=0,loading=false,saving=false,version=0,alive=true,nameVisible=false;
 const canvas=$('crop'),ctx=canvas.getContext('2d'),submit=$('form').querySelector('[type=submit]');
 function refresh(){
  const batch=files.length>1;
  $('dialog-title').textContent=batch?'Add garments':'Add garment';
  $('batch-progress').hidden=!batch;
  $('batch-position').textContent=`Photo ${position+1} of ${files.length}`;
  $('batch-added').textContent=`${added} added`;
  $('batch-meter').max=files.length||1;$('batch-meter').value=position;
  submit.textContent=batch?(position<files.length-1?'Save & next':'Save last'):'Add garment';
  submit.dataset.unavailable=String(loading||saving||!image);submit.disabled=loading||saving||!image;
  $('skip-photo').hidden=!batch;$('skip-photo').disabled=loading||saving;
  $('choose-photo').textContent=image?(batch?'Replace photo':'Change photo'):'Choose photos';
  for(const id of ['choose-photo','paste-photo','upload-area','group-select','group','name','zoom','add-name'])$(id).disabled=loading||saving;
  $('close').disabled=saving;
  $('name-label').hidden=batch&&!nameVisible;
  $('add-name').hidden=!batch||nameVisible;
 }
 function draw(){if(!image)return;scale=Math.max(640/image.width,640/image.height)*Number($('zoom').value);x=Math.max(640-image.width*scale,Math.min(0,x));y=Math.max(640-image.height*scale,Math.min(0,y));ctx.fillStyle='#fff';ctx.fillRect(0,0,640,640);ctx.drawImage(image,x,y,image.width*scale,image.height*scale);}
 async function loadPhoto(file){
  if(!file||!alive)return;
  const current=++version;
  loading=true;image?.close();image=null;canvas.hidden=true;$('upload-area').hidden=false;$('upload-label').textContent='Opening photo…';$('zoom-label').hidden=true;$('form-error').textContent='';refresh();
  try{
   const next=await createImageBitmap(file);
   if(!alive||version!==current){next.close();return;}
   image=next;$('zoom').value=1;
   scale=Math.max(640/image.width,640/image.height);x=(640-image.width*scale)/2;y=(640-image.height*scale)/2;
   canvas.hidden=false;$('upload-area').hidden=true;$('zoom-label').hidden=false;draw();
  }catch{
   if(alive&&version===current){$('upload-label').textContent='Choose another photo';$('form-error').textContent='Could not open this image. Choose another photo or skip it.';}
  }finally{if(alive&&version===current){loading=false;refresh();}}
 }
 async function advance(){
  files[position]=null;
  if(position<files.length-1){position++;$('name').value='';nameVisible=false;await loadPhoto(files[position]);$('dialog-content').scrollTop=0;if(image)submit.focus({preventScroll:true});}
  else{$('dialog').close();notify(added?added===1?'Garment added':`${added} garments added`:'No garments added');}
 }
 async function acceptPhotos(list){
  if(saving||loading||!alive)return;
  const incoming=Array.from(list);if(!incoming.length)return;
  files=incoming;position=0;added=0;nameVisible=false;
  await loadPhoto(files[0]);
 }
 async function replacePhoto(file){
  if(!file||saving||loading||!alive)return;
  if(!files.length)return acceptPhotos([file]);
  files[position]=file;await loadPhoto(file);
 }
 function choosePhoto(){if(files.length>1)$('replacement-photo').click();else $('photo').click();}
 $('group-select').onchange=()=>{const creating=$('group-select').value==='new';$('new-group-label').hidden=!creating;$('group').required=creating;if(creating)$('group').focus();};
 $('upload-area').onclick=choosePhoto;
 $('choose-photo').onclick=choosePhoto;
 $('photo').onchange=()=>{const incoming=Array.from($('photo').files);$('photo').value='';void acceptPhotos(incoming);};
 $('replacement-photo').onchange=()=>{const file=$('replacement-photo').files[0];$('replacement-photo').value='';void replacePhoto(file);};
 $('skip-photo').onclick=async()=>{if(!loading&&!saving)await advance();};
 $('add-name').onclick=()=>{nameVisible=true;refresh();$('name').focus();};
 $('dialog').onpaste=e=>{const item=[...e.clipboardData.items].find(item=>item.type.startsWith('image/'));if(item){e.preventDefault();void replacePhoto(item.getAsFile());}};
 $('paste-photo').hidden=!navigator.clipboard?.read;
 $('paste-photo').onclick=async()=>{try{const items=await navigator.clipboard.read();for(const item of items){const type=item.types.find(t=>t.startsWith('image/'));if(type){await replacePhoto(await item.getType(type));return;}}if(alive)$('form-error').textContent='Copy an image first, then paste it here.';}catch{if(alive)$('form-error').textContent='Allow clipboard access, paste directly, or choose a photo.';}};
 $('dialog').oncancel=e=>{if(saving)e.preventDefault();};
 $('dialog').onclose=()=>{alive=false;version++;image?.close();files=[];$('close').disabled=false;};
 $('zoom').oninput=()=>{if(!image)return;const old=scale,newScale=Math.max(640/image.width,640/image.height)*Number($('zoom').value);x=320-(320-x)*newScale/old;y=320-(320-y)*newScale/old;draw();};
 canvas.onpointerdown=e=>{dragging={x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);};canvas.onpointermove=e=>{if(!dragging||loading||saving)return;const factor=640/canvas.getBoundingClientRect().width;x+=(e.clientX-dragging.x)*factor;y+=(e.clientY-dragging.y)*factor;dragging={x:e.clientX,y:e.clientY};draw();};canvas.onpointerup=canvas.onpointercancel=()=>dragging=null;
 refresh();
}
function detailDialog(id){const g=project(state.records).find(g=>g.id===id);const washes=state.records.filter(r=>r.type==='wash'&&r.wearIds.some(i=>g.history.some(w=>w.id===i)));const undone=new Set(state.records.filter(r=>r.type==='undo').flatMap(r=>r.eventIds));const history=[...g.history,...washes.filter(r=>!undone.has(r.id))].sort((a,b)=>b.recordedAt.localeCompare(a.recordedAt));
 dialog(g.name||g.group,`<div class="detail-summary">${g.photo?`<img class="detail-photo" src="${esc(g.photo)}" alt="">`:''}<div><span class="count">${g.count} <small>${g.count===1?'wear':'wears'}</small></span><p class="hint">Since washing · ${esc(g.group)}</p></div></div><label>Number of wears<input id="quantity" type="number" min="1" max="999" value="1" required></label><label>Wear date (optional)<input id="worn-on" type="date"></label><p class="hint">Leave the date blank for past wears with an unknown date. We always keep the time you logged them.</p><h3 class="section-title">History</h3><ul class="history">${history.map(r=>`<li><span>${r.type==='wash'?'Washed':`+${r.quantity} ${r.quantity===1?'wear':'wears'} · ${esc(r.wornOn||'date unknown')}`}<small>Logged ${esc(dateLabel(r.recordedAt))}</small></span><button type="button" class="quiet" data-undo="${esc(r.id)}">Undo</button></li>`).join('')||'<li>No wears logged yet.</li>'}</ul>`,saveButton('Add past wears')+'<button type="button" class="secondary" id="single-wash">Wash this</button>',async()=>{const r=record('wear',{garmentId:id,quantity:Number($('quantity').value),wornOn:$('worn-on').value||null});await add([r]);$('dialog').close();notify('Wears saved',[r.id]);});
 document.querySelectorAll('[data-undo]').forEach(b=>b.onclick=async()=>{try{await add([record('undo',{eventIds:[b.dataset.undo]})]);$('dialog').close();notify('Entry undone');}catch(e){$('form-error').textContent=e.message;}});$('single-wash').onclick=()=>{$('dialog').close();washDialog(id);};
}
function washDialog(id){const garments=project(state.records).filter(g=>id?g.id===id:!$('filter').value||g.group===$('filter').value);dialog('Wash a load',`<p class="hint">Worn garments are selected. Untick anything you’re leaving out of this load.</p>${garments.map(g=>`<label class="wash-row"><input type="checkbox" name="wash-item" value="${esc(g.id)}" ${g.count?'checked':''}>${g.photo?`<img src="${esc(g.photo)}" alt="">`:''}<span>${esc(g.name||g.group)}</span><small>${g.count} wears</small></label>`).join('')||'<p>No garments in this group yet.</p>'}`,saveButton('Record wash'),async()=>{const ids=new Set([...document.querySelectorAll('[name=wash-item]:checked')].map(c=>c.value));const wears=garments.filter(g=>ids.has(g.id)).flatMap(g=>g.wears.map(w=>w.id));if(!wears.length)throw new Error('Select a garment with wears to reset.');const r=record('wash',{wearIds:wears});await add([r]);$('dialog').close();notify('Wash recorded',[r.id]);});}
function settingsDialog(){dialog('Settings',`<p class="hint">Changes save on this device immediately and sync when you open the app with an internet connection. If your session expires, sign in when prompted.</p><button type="button" class="secondary backup-action" id="export">Export wardrobe backup</button><label>Restore or merge a backup<input id="import" type="file" accept="application/json,.json"></label><p class="hint">Exports contain garment photos and history. Keep a backup of pending entries before clearing browser data.</p>`,saveButton('Done'),async()=>{$('dialog').close();});
 $('export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({version:1,records:state.records})],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`wearlog-${today()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 $('import').onchange=async()=>{try{const data=JSON.parse(await $('import').files[0].text());if(data.version!==1||!Array.isArray(data.records))throw new Error('Not a Wearlog backup');for(const r of data.records){if(r.type==='garment'){if(r.photo&&(!r.photo.startsWith('data:image/jpeg;base64,')||r.photo.length>800000))throw new Error('Invalid backup photo');r.photoHash=r.photo?await photoHash(jpegBytes(r.photo)):null;}validateRecord(r);}await mutate(s=>{const known=new Set(s.records.map(r=>r.id));const extra=data.records.filter(r=>!known.has(r.id));s.records.push(...extra);s.outbox.push(...extra);});$('dialog').close();notify('Backup merged');void sync();}catch(e){$('form-error').textContent=e.message;}};
}
$('signin').onclick=()=>window.location.assign('/auth/resume');
$('close').onclick=()=>$('dialog').close();$('filter').onchange=render;$('add').onclick=addDialog;$('wash').onclick=()=>washDialog();$('settings').onclick=settingsDialog;
document.addEventListener('visibilitychange',()=>{clearTimeout(syncTimer);if(document.visibilityState==='visible')void sync();});window.addEventListener('online',()=>void sync());window.addEventListener('offline',()=>{clearTimeout(syncTimer);syncError='Connection unavailable';renderStatus();});window.addEventListener('focus',()=>{if(!busy)void sync();});
try{db=await new Promise((resolve,reject)=>{const request=indexedDB.open('wearlog',1);request.onupgradeneeded=()=>request.result.createObjectStore('state');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});const saved=await new Promise((resolve,reject)=>{const r=db.transaction('state').objectStore('state').get('main');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});if(saved){state=saved;state.cursor??=0;for(const r of state.records){if(r.type==='garment'&&r.photoHash===undefined)r.photoHash=r.photo?await photoHash(jpegBytes(r.photo)):null;}state.outbox=state.outbox.map(r=>state.records.find(x=>x.id===r.id)||r);delete state.token;await stored(state);}render();if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>notify('Offline setup failed. Reopen while online to retry.'));void sync();}catch(e){$('status').textContent='Phone storage unavailable. Please enable browser storage and reload.';for(const id of ['add','wash','settings'])$(id).disabled=true;}
