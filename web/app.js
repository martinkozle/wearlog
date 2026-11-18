import {project} from './model.js';
import {validateRecord, photoHash} from './schema.js';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateLabel = s => new Date(s).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
let db, state = {records:[],outbox:[],cursor:0}, busy=false, queue=Promise.resolve(), lastSync='', syncError='', authRequired=false, toastTimer;
function stored(value) { return new Promise((resolve,reject) => { const tx=db.transaction('state','readwrite'); tx.objectStore('state').put(value,'main'); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error); }); }
function mutate(fn) { const task=queue.then(async()=>{ const next=structuredClone(state); fn(next); await stored(next); state=next; render(); }); queue=task.catch(()=>{}); return task; }
function record(type, fields) {return {id:crypto.randomUUID(),type,recordedAt:new Date().toISOString(),...fields};}
async function add(records) {await mutate(s=>{s.records.push(...records);s.outbox.push(...records);}); void sync();}
function notify(message, undoIds=[]) {clearTimeout(toastTimer);$('toast').hidden=false;$('toast').replaceChildren(document.createTextNode(message));if(undoIds.length){const b=document.createElement('button');b.textContent='Undo';b.onclick=async()=>{try{await add([record('undo',{eventIds:undoIds})]);notify('Undone');}catch(e){notify(e.message);}};$('toast').append(b);}toastTimer=setTimeout(()=>$('toast').hidden=true,7000);}
function render() {
 $('signin').hidden=!authRequired;
 const garments=project(state.records), filter=$('filter').value, groups=[...new Set(garments.map(g=>g.group))].sort();
 $('filter').innerHTML='<option value="">All groups</option>'+groups.map(g=>`<option>${esc(g)}</option>`).join('');$('filter').value=groups.includes(filter)?filter:'';
 $('total').textContent=garments.length;
 $('status').textContent=busy?'Syncing…':syncError?`${state.outbox.length} pending · ${syncError}`:state.outbox.length?`${state.outbox.length} pending · saved on this phone`:lastSync?`All changes synced · ${lastSync}`:'Saved on this phone';
 const shown=garments.filter(g=>!filter || g.group===filter);
 $('grid').innerHTML=shown.length?shown.map(g=>{const last=g.history.at(-1);return `<article class="card"><button class="photo-button" data-detail="${esc(g.id)}" aria-label="History for ${esc(g.name || 'garment')}">${g.photo?`<img src="${esc(g.photo)}" alt="${esc(g.name || 'Garment')}">`:'<span class="placeholder">♧</span>'}<span class="badge">${esc(g.group)}</span></button><div class="card-body"><div class="card-title"><h3>${esc(g.name || 'Untitled garment')}</h3><span class="count">${g.count} <small>${g.count===1?'wear':'wears'}</small></span></div><p class="last">${last?`Last logged ${esc(dateLabel(last.recordedAt))}`:'Fresh start. Ready to wear.'}</p><button class="wear" data-wear="${esc(g.id)}">+1 Wear now</button></div></article>`;}).join(''):'<div class="empty"><h2>A fresh start for your wardrobe.</h2><p>Add a photo of your first garment.<br>No wear limits. No complicated setup.</p><button class="primary" id="empty-add">+ Add your first garment</button></div>';
 $('empty-add')?.addEventListener('click',addDialog);
 document.querySelectorAll('[data-wear]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{const r=record('wear',{garmentId:b.dataset.wear,quantity:1,wornOn:today()});await add([r]);notify('Wear saved',[r.id]);}catch(e){notify('Could not save: '+e.message);b.disabled=false;}});
 document.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>detailDialog(b.dataset.detail));
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
 if(busy)return;busy=true;syncError='';render();
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
   await mutate(s=>{
     const acknowledged=new Set(remote.acknowledged);
     s.outbox=s.outbox.filter(r=>!acknowledged.has(r.id));
     const all=new Map(s.records.map(r=>[r.id,r]));
     for(const r of incoming)all.set(r.id,r);
     for(const r of s.outbox)all.set(r.id,r);
     s.records=[...all.values()];s.cursor=remote.cursor;
   });
   more=remote.hasMore||state.outbox.length>0;
  }
  authRequired=false;
  lastSync=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
 }catch(e){syncError=e.message==='AUTH_REQUIRED'?'Sign in to sync; changes are saved':e instanceof TypeError||e.name==='TimeoutError'?'Connection unavailable; changes stay on this phone':e.message;}
 finally{busy=false;render();}
}
function dialog(title,content,buttons,onSubmit){$('dialog-title').textContent=title;$('dialog-content').innerHTML=content;$('dialog-actions').innerHTML=buttons;$('form-error').textContent='';$('form').onsubmit=async e=>{e.preventDefault();const submit=$('form').querySelector('[type=submit]');if(submit)submit.disabled=true;try{await onSubmit();}catch(err){$('form-error').textContent=err.message;}finally{if(submit)submit.disabled=false;}};$('dialog').showModal();}
const saveButton = text => `<button type="submit" class="primary">${text}</button>`;
function addDialog(){
 dialog('Something to wear',`<p class="hint">A photo is all you need. Names are optional.</p><label>Photo from your gallery<input id="photo" type="file" accept="image/*"></label><canvas class="crop" id="crop" width="640" height="640" hidden></canvas><label id="zoom-label" hidden>Zoom · drag photo to reposition<input id="zoom" type="range" min="1" max="3" step="0.01" value="1"></label><label>Name (optional)<input id="name" maxlength="120" placeholder="The blue merino"></label><label>Wash group<input id="group" maxlength="80" value="Merino" list="groups" required></label><datalist id="groups">${[...new Set(project(state.records).map(g=>g.group))].map(g=>`<option value="${esc(g)}">`).join('')}</datalist>`,saveButton('Add to wardrobe'),async()=>{if(!image)throw new Error('Choose a garment photo first.');const group=$('group').value.trim();if(!group)throw new Error('Enter a wash group.');await add([record('garment',{name:$('name').value.trim(),group,photo:canvas.toDataURL('image/jpeg',0.82),photoHash:await photoHash(jpegBytes(canvas.toDataURL('image/jpeg',0.82)))})]);$('dialog').close();notify('Added to your wardrobe');});
 let image=null, scale=1, x=0,y=0, dragging=null;const canvas=$('crop'),ctx=canvas.getContext('2d');
 function draw(){if(!image)return;scale=Math.max(640/image.width,640/image.height)*Number($('zoom').value);x=Math.max(640-image.width*scale,Math.min(0,x));y=Math.max(640-image.height*scale,Math.min(0,y));ctx.fillStyle='#fff';ctx.fillRect(0,0,640,640);ctx.drawImage(image,x,y,image.width*scale,image.height*scale);}
 $('photo').onchange=async()=>{const f=$('photo').files[0];if(!f)return;try{image=await createImageBitmap(f);$('zoom').value=1;scale=Math.max(640/image.width,640/image.height);x=(640-image.width*scale)/2;y=(640-image.height*scale)/2;canvas.hidden=false;$('zoom-label').hidden=false;draw();$('form-error').textContent='';}catch{$('form-error').textContent='This photo format could not be opened. Try JPEG or PNG.';}};
 $('zoom').oninput=()=>{if(!image)return;const old=scale,newScale=Math.max(640/image.width,640/image.height)*Number($('zoom').value);x=320-(320-x)*newScale/old;y=320-(320-y)*newScale/old;draw();};
 canvas.onpointerdown=e=>{dragging={x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);};canvas.onpointermove=e=>{if(!dragging)return;const factor=640/canvas.getBoundingClientRect().width;x+=(e.clientX-dragging.x)*factor;y+=(e.clientY-dragging.y)*factor;dragging={x:e.clientX,y:e.clientY};draw();};canvas.onpointerup=canvas.onpointercancel=()=>dragging=null;
}
function detailDialog(id){const g=project(state.records).find(g=>g.id===id);const washes=state.records.filter(r=>r.type==='wash'&&r.wearIds.some(i=>g.history.some(w=>w.id===i)));const undone=new Set(state.records.filter(r=>r.type==='undo').flatMap(r=>r.eventIds));const history=[...g.history,...washes.filter(r=>!undone.has(r.id))].sort((a,b)=>b.recordedAt.localeCompare(a.recordedAt));
 dialog(g.name||'Garment history',`<p class="hint">${g.count} wears since washing · ${esc(g.group)}</p><label>Number of wears<input id="quantity" type="number" min="1" max="999" value="1" required></label><label>Wear date (optional)<input id="worn-on" type="date"></label><p class="hint">Leave the date blank for past wears with an unknown date. We always keep the time you logged them.</p><h2>History</h2><ul class="history">${history.map(r=>`<li><span>${r.type==='wash'?'Washed':`+${r.quantity} ${r.quantity===1?'wear':'wears'} · ${esc(r.wornOn||'date unknown')}`}<small>Logged ${esc(dateLabel(r.recordedAt))}</small></span><button type="button" class="quiet" data-undo="${esc(r.id)}">Undo</button></li>`).join('')||'<li>No wears logged yet.</li>'}</ul>`,saveButton('Add past wears')+'<button type="button" class="secondary" id="single-wash">Wash this</button>',async()=>{const r=record('wear',{garmentId:id,quantity:Number($('quantity').value),wornOn:$('worn-on').value||null});await add([r]);$('dialog').close();notify('Wears saved',[r.id]);});
 document.querySelectorAll('[data-undo]').forEach(b=>b.onclick=async()=>{try{await add([record('undo',{eventIds:[b.dataset.undo]})]);$('dialog').close();notify('Entry undone');}catch(e){$('form-error').textContent=e.message;}});$('single-wash').onclick=()=>{$('dialog').close();washDialog(id);};
}
function washDialog(id){const garments=project(state.records).filter(g=>id?g.id===id:!$('filter').value||g.group===$('filter').value);dialog('A fresh start',`<p class="hint">Worn garments are selected. Untick anything you’re leaving out of this load.</p>${garments.map(g=>`<label class="wash-row"><input type="checkbox" name="wash-item" value="${esc(g.id)}" ${g.count?'checked':''}>${g.photo?`<img src="${esc(g.photo)}" alt="">`:''}<span>${esc(g.name||'Untitled garment')}</span><small>${g.count} wears</small></label>`).join('')||'<p>No garments in this group yet.</p>'}`,saveButton('Record wash'),async()=>{const ids=new Set([...document.querySelectorAll('[name=wash-item]:checked')].map(c=>c.value));const wears=garments.filter(g=>ids.has(g.id)).flatMap(g=>g.wears.map(w=>w.id));if(!wears.length)throw new Error('Select a garment with wears to reset.');const r=record('wash',{wearIds:wears});await add([r]);$('dialog').close();notify('Wash recorded',[r.id]);});}
function settingsDialog(){dialog('Your wardrobe, safely kept',`<p class="hint">Changes save on this device immediately and sync when you open the app with an internet connection. If your session expires, use Sign in to sync.</p><button type="button" class="secondary" id="export">Export wardrobe backup</button><label>Restore or merge a backup<input id="import" type="file" accept="application/json,.json"></label><p class="hint">Exports contain garment photos and history. Keep a backup of pending entries before clearing browser data.</p>`,saveButton('Done'),async()=>{$('dialog').close();});
 $('export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({version:1,records:state.records})],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`wearlog-${today()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 $('import').onchange=async()=>{try{const data=JSON.parse(await $('import').files[0].text());if(data.version!==1||!Array.isArray(data.records))throw new Error('Not a Wearlog backup');for(const r of data.records){if(r.type==='garment'){if(r.photo&&(!r.photo.startsWith('data:image/jpeg;base64,')||r.photo.length>800000))throw new Error('Invalid backup photo');r.photoHash=r.photo?await photoHash(jpegBytes(r.photo)):null;}validateRecord(r);}await mutate(s=>{const known=new Set(s.records.map(r=>r.id));const extra=data.records.filter(r=>!known.has(r.id));s.records.push(...extra);s.outbox.push(...extra);});$('dialog').close();notify('Backup merged');void sync();}catch(e){$('form-error').textContent=e.message;}};
}
$('signin').onclick=()=>window.location.assign('/auth/resume');
$('close').onclick=()=>$('dialog').close();$('filter').onchange=render;$('add').onclick=addDialog;$('wash').onclick=()=>washDialog();$('settings').onclick=settingsDialog;$('sync').onclick=sync;
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void sync();});window.addEventListener('online',()=>void sync());
try{db=await new Promise((resolve,reject)=>{const request=indexedDB.open('wearlog',1);request.onupgradeneeded=()=>request.result.createObjectStore('state');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});const saved=await new Promise((resolve,reject)=>{const r=db.transaction('state').objectStore('state').get('main');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});if(saved){state=saved;state.cursor??=0;for(const r of state.records){if(r.type==='garment'&&r.photoHash===undefined)r.photoHash=r.photo?await photoHash(jpegBytes(r.photo)):null;}state.outbox=state.outbox.map(r=>state.records.find(x=>x.id===r.id)||r);delete state.token;await stored(state);}render();if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>notify('Offline setup failed. Reopen while online to retry.'));void sync();}catch(e){$('status').textContent='Phone storage unavailable. Please enable browser storage and reload.';for(const id of ['add','wash','settings','sync'])$(id).disabled=true;}
