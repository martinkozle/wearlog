import qrcode from './qrcode.js?v=2026.11.18.7';
import {createUpdater} from './updates.js?v=2026.11.18.7';
import {project} from './model.js?v=2026.11.18.7';
import {validateRecord, photoHash} from './schema.js?v=2026.11.18.7';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateLabel = s => new Date(s).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const blankState = () => ({records: [], outbox: [], cursor: 0});
let db, state = blankState(), profile, activeId, scope, switching = false, inviteInProgress = false;
let syncTask, pendingSaves = 0, busy=false, queue=Promise.resolve(), syncError='', authRequired=false, toastTimer, syncTimer, retryDelay=2000, gridKey='', groupsKey='';
const updater=createUpdater({version:document.querySelector('meta[name="app-version"]').content,beforeReload:()=>queue,onAvailable:()=>{$('app-update').hidden=false;}});
async function updateApp(button,message){
 button.disabled=true;message.textContent='Downloading app update…';
 try{await updater.apply();}catch(error){message.textContent=error.message;button.disabled=false;}
}
$('install-update').onclick=()=>void updateApp($('install-update'),$('app-update').querySelector('span'));
function load(key) {
 return new Promise((resolve, reject) => {
  const request = db.transaction('state').objectStore('state').get(key);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
 });
}
function writeState(update) {
 return new Promise((resolve, reject) => {
  const tx = db.transaction('state', 'readwrite');
  const store = tx.objectStore('state');
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('Could not save locally'));
  update(store);
 });
}
function wardrobeScope(account, id) {
 return `wardrobe:${account}:${id}`;
}
function mutate(fn, key = scope) {
 if (!key) return Promise.reject(new Error('Choose a wardrobe first.'));
 const task = queue.then(async () => {
  let next;
  await writeState(store => {
   const request = store.get(key);
   request.onsuccess = () => {
    next = request.result || blankState();
    fn(next);
    store.put(next, key);
   };
  });
  if (key === scope) {
   state = next;
   render();
  }
 });
 queue = task.catch(() => {});
 return task;
}
async function adoptLegacy(account) {
 const key = wardrobeScope(account, 'legacy');
 await writeState(store => {
  const old = store.get('main');
  old.onsuccess = () => {
   if (!old.result) return;
   const current = store.get(key);
   current.onsuccess = () => {
    const previous = old.result;
    const saved = current.result || blankState();
    const all = new Map((current.result ? previous.outbox : previous.records).map(record => [record.id, record]));
    for (const record of saved.records) all.set(record.id, record);
    const pending = new Map(previous.outbox.map(record => [record.id, all.get(record.id) || record]));
    for (const record of saved.outbox) pending.set(record.id, record);
    store.put({...saved, records: [...all.values()], outbox: [...pending.values()], lastGroup: saved.lastGroup ?? previous.lastGroup}, key);
    store.delete('main');
   };
  };
 });
}
function record(type, fields) {
 return {
  id: crypto.randomUUID(), type, recordedAt: new Date().toISOString(), ...fields,
  actor: {id: profile.account, name: profile.name}
 };
}
async function add(records, key = scope) {
 pendingSaves++;
 renderStatus();
 try {
  await mutate(saved => {
   saved.records.push(...records);
   saved.outbox.push(...records);
   const garment = records.find(record => record.type === 'garment');
   if (garment) saved.lastGroup = garment.group;
  }, key);
  void sync();
 } finally {
  pendingSaves--;
  renderStatus();
 }
}
function notify(message, undoIds=[]) {clearTimeout(toastTimer);$('toast').hidden=false;$('toast').replaceChildren(document.createTextNode(message));if(undoIds.length){const key=scope;const b=document.createElement('button');b.textContent='Undo';b.onclick=async()=>{try{if(key!==scope)return;await add([record('undo',{eventIds:undoIds})]);notify('Undone');}catch(e){notify(e.message);}};$('toast').append(b);}toastTimer=setTimeout(()=>$('toast').hidden=true,7000);}
const shirtIcon='<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m16 9-5 3-7 9 8 6 4-5v18h16V22l4 5 8-6-7-9-5-3c0 8-16 8-16 0Z" stroke-linejoin="round"/></svg>';
function renderStatus() {
 $('signin').hidden=!authRequired;
 const pending=state.outbox.length;
 const offline=navigator.onLine===false;
 $('status').dataset.state=authRequired?'auth':(busy||pendingSaves)?'syncing':syncError?(offline||syncError.startsWith('Connection')?'offline':'error'):pending?'pending':'saved';
 $('status').textContent=authRequired?(pending?`${pending} pending`:'Sign-in needed'):pendingSaves?'Saving…':busy?'Syncing…':syncError?(pending?`${pending} pending · saved locally`:'Offline'):pending?`${pending} pending`:'Saved';
 $('status').title=syncError||'Changes sync automatically';
}
function render() {
 renderStatus();
 const active = profile?.wardrobes.find(wardrobe => wardrobe.id === activeId);
 $('wardrobe-content').hidden = !active;
 $('onboarding').hidden = !profile || Boolean(active);
 $('open-wardrobes').disabled = !profile || switching;
 $('first-wardrobe').disabled = switching;
 $('manage-wardrobe').hidden = !active;
 const list = $('wardrobe-list');
 const menuKey = JSON.stringify([profile?.wardrobes, activeId]);
 if (list.dataset.key !== menuKey) {
  list.replaceChildren(...(profile?.wardrobes || []).map(({id, name}) => {
   const button = document.createElement('button');
   button.type = 'button';
   button.className = 'wardrobe-option';
   button.textContent = name;
   button.dataset.wardrobe = id;
   if (id === activeId) button.setAttribute('aria-current', 'true');
   button.onclick = () => void selectWardrobe(id);
   return button;
  }));
  list.dataset.key = menuKey;
 }
 if (!active) return;
 $('wardrobe-title').textContent = active.name;
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
 if(response.type==='opaqueredirect'||[301,302,303,307,308,401].includes(response.status)){authRequired=true;throw new Error('AUTH_REQUIRED');}
 if(!response.ok){let message='Sync failed. Please retry.';try{message=(await response.json()).error||message;}catch{}throw Object.assign(new Error(message), {status: response.status});}
 return response;
}
function apiHeaders(account, wardrobe, headers = {}) {
 return {...headers, 'X-Wearlog-Account': account, ...(wardrobe ? {'X-Wearlog-Wardrobe': wardrobe} : {})};
}
async function api(path, {account = profile?.account, wardrobe, body} = {}) {
 const options = body === undefined ? {} : {method: 'POST', body: JSON.stringify(body)};
 options.headers = apiHeaders(account, wardrobe, body === undefined ? {} : {'Content-Type': 'application/json'});
 return (await checkedFetch(path, options)).json();
}
async function hydrate(records, localRecords, headers) {
 const local = new Map(localRecords.map(record => [record.id, record]));
 for (const record of records) {
  if (record.type !== 'garment' || !record.photoHash) continue;
  const existing = local.get(record.id);
  if (existing?.photo && existing.photoHash === record.photoHash) {
   record.photo = existing.photo;
   continue;
  }
  const response = await checkedFetch('/api/photos/' + record.photoHash, {headers});
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (await photoHash(bytes) !== record.photoHash) throw new Error('Photo verification failed');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  record.photo = 'data:image/jpeg;base64,' + btoa(binary);
 }
 return records;
}
async function setActive(nextProfile, id) {
 const key = id ? wardrobeScope(nextProfile.account, id) : null;
 const task = queue.then(async () => {
  if (key !== scope || profile?.account !== nextProfile.account) {
   const saved = key ? await load(key) : null;
   if ($('dialog').open) $('dialog').close();
   if ($('wardrobe-menu').open) $('wardrobe-menu').close();
   $('toast').hidden = true;
   state = saved || blankState();
   scope = key;
   gridKey = groupsKey = '';
   $('filter').value = '';
  }
  activeId = id;
  profile = nextProfile;
  render();
  await writeState(store => {
   store.put({profile, activeId}, 'session');
   if (id) store.put(id, 'active:' + profile.account);
  });
 });
 queue = task.catch(() => {});
 await task;
}
async function refreshWardrobes(preferred) {
 const response = await checkedFetch('/api/wardrobes');
 const next = await response.json();
 if (next.wardrobes.some(wardrobe => wardrobe.id === 'legacy')) await adoptLegacy(next.account);
 const last = preferred ?? (profile?.account === next.account ? activeId : await load('active:' + next.account));
 const id = next.wardrobes.find(wardrobe => wardrobe.id === last)?.id ?? next.wardrobes[0]?.id;
 await setActive(next, id);
 authRequired = false;
}
async function syncWardrobe(account, id, key) {
 const headers = apiHeaders(account, id);
 let more = true;
 while (more) {
  await queue;
  const saved = await load(key) || blankState();
  const batch = saved.outbox.slice(0, 25);
  const records = [];
  for (const local of batch) {
   const entry = {...local};
   if (entry.type === 'garment') {
    const bytes = entry.photo ? jpegBytes(entry.photo) : null;
    entry.photoHash ??= bytes ? await photoHash(bytes) : null;
    if (bytes) await checkedFetch('/api/photos/' + entry.photoHash, {
     method: 'PUT', headers: {...headers, 'Content-Type': 'image/jpeg'}, body: bytes
    });
   }
   records.push(validateRecord(entry));
  }
  const remote = await api('/api/sync', {account, wardrobe: id, body: {records, cursor: saved.cursor}});
  if (remote.version !== 3 || !Array.isArray(remote.records) || !Array.isArray(remote.acknowledged) || !Number.isSafeInteger(remote.cursor)) {
   throw new Error('Unexpected server response');
  }
  const incoming = await hydrate(remote.records, saved.records, headers);
  if (incoming.length || remote.acknowledged.length || remote.cursor !== saved.cursor) await mutate(current => {
   const acknowledged = new Set(remote.acknowledged);
   current.outbox = current.outbox.filter(record => !acknowledged.has(record.id));
   const all = new Map(current.records.map(record => [record.id, record]));
   for (const record of incoming) all.set(record.id, record);
   for (const record of current.outbox) all.set(record.id, record);
   current.records = [...all.values()];
   current.cursor = Math.max(current.cursor, remote.cursor);
  }, key);
  else if (key === scope) {
   // Another app window may have synchronized this wardrobe.
   await queue;
   const latest = await load(key);
   if (key === scope) {
    state = latest || blankState();
    render();
   }
  }
  more = remote.hasMore || saved.outbox.length > batch.length;
 }
}
function sync() {
 if (syncTask || !db || switching) return syncTask;
 clearTimeout(syncTimer);
 if (navigator.onLine === false) {
  syncError = 'Connection unavailable';
  renderStatus();
  return;
 }
 busy = true;
 syncError = '';
 renderStatus();
 syncTask = (async () => {
  try {
   await refreshWardrobes();
   await showInvite();
   const {account, wardrobes} = profile;
   if (activeId) await syncWardrobe(account, activeId, scope);
   for (const {id} of wardrobes) {
    if (id === activeId) continue;
    const key = wardrobeScope(account, id);
    if ((await load(key))?.outbox.length) await syncWardrobe(account, id, key);
   }
   retryDelay = 2000;
  } catch (error) {
   syncError = error.message === 'AUTH_REQUIRED' ? 'Sign in to sync; changes are saved' :
    error instanceof TypeError || error.name === 'TimeoutError' ? 'Connection unavailable; changes stay on this phone' : error.message;
  } finally {
   busy = false;
   syncTask = undefined;
   renderStatus();
   scheduleSync(syncError ? retryDelay : state.outbox.length ? 0 : 30000);
   if (syncError) retryDelay = Math.min(retryDelay * 2, 30000);
  }
 })();
 return syncTask;
}
function dialog(title,content,buttons,onSubmit){$('dialog').onpaste=null;$('dialog').onclose=null;$('dialog').oncancel=null;$('dialog-title').textContent=title;$('dialog-content').innerHTML=content;$('dialog-actions').innerHTML=buttons;$('form-error').textContent='';$('form').onsubmit=async e=>{e.preventDefault();const submit=$('form').querySelector('[type=submit]');if(submit)submit.disabled=true;try{await onSubmit();}catch(err){$('form-error').textContent=err.message;}finally{if(submit)submit.disabled=submit.dataset.unavailable==='true';}};$('dialog').showModal();}
const saveButton = text => `<button type="submit" class="primary">${text}</button>`;
function addDialog(){
 const key = scope;
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
    await add([record('garment',{name:$('name').value.trim(),group,photo,photoHash:await photoHash(jpegBytes(photo))})], key);
    if (!alive || key !== scope) return;
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
 dialog(g.name||g.group,`<div class="detail-summary">${g.photo?`<img class="detail-photo" src="${esc(g.photo)}" alt="">`:''}<div><span class="count">${g.count} <small>${g.count===1?'wear':'wears'}</small></span><p class="hint">Since washing · ${esc(g.group)}</p></div></div><label>Number of wears<input id="quantity" type="number" min="1" max="999" value="1" required></label><label>Wear date (optional)<input id="worn-on" type="date"></label><p class="hint">Leave the date blank for past wears with an unknown date. We always keep the time you logged them.</p><h3 class="section-title">History</h3><ul class="history">${history.map(r=>`<li><span>${r.type==='wash'?'Washed':`+${r.quantity} ${r.quantity===1?'wear':'wears'} · ${esc(r.wornOn||'date unknown')}`}<small>${r.actor ? esc(r.actor.name) : 'Logged before sharing'} · ${esc(dateLabel(r.recordedAt))}</small></span><button type="button" class="quiet" data-undo="${esc(r.id)}">Undo</button></li>`).join('')||'<li>No wears logged yet.</li>'}</ul>`,saveButton('Add past wears')+'<button type="button" class="secondary" id="single-wash">Wash this</button><button type="button" class="danger" id="delete-garment">Delete</button>',async()=>{const r=record('wear',{garmentId:id,quantity:Number($('quantity').value),wornOn:$('worn-on').value||null});await add([r]);$('dialog').close();notify('Wears saved',[r.id]);});
 document.querySelectorAll('[data-undo]').forEach(b=>b.onclick=async()=>{try{await add([record('undo',{eventIds:[b.dataset.undo]})]);$('dialog').close();notify('Entry undone');}catch(e){$('form-error').textContent=e.message;}});$('single-wash').onclick=()=>{$('dialog').close();washDialog(id);};
 $('delete-garment').onclick = () => {
  $('dialog').close();
  dialog('Delete garment?', '<p class="hint">The garment will disappear from this wardrobe for everyone.</p>', saveButton('Delete garment'), async () => {
   const deletion = record('delete', {garmentId: id});
   await add([deletion]);
   $('dialog').close();
   notify('Garment deleted');
  });
 };

}
function washDialog(id){const garments=project(state.records).filter(g=>id?g.id===id:!$('filter').value||g.group===$('filter').value);dialog('Wash a load',`<p class="hint">Worn garments are selected. Untick anything you’re leaving out of this load.</p>${garments.map(g=>`<label class="wash-row"><input type="checkbox" name="wash-item" value="${esc(g.id)}" ${g.count?'checked':''}>${g.photo?`<img src="${esc(g.photo)}" alt="">`:''}<span>${esc(g.name||g.group)}</span><small>${g.count} wears</small></label>`).join('')||'<p>No garments in this group yet.</p>'}`,saveButton('Record wash'),async()=>{const ids=new Set([...document.querySelectorAll('[name=wash-item]:checked')].map(c=>c.value));const wears=garments.filter(g=>ids.has(g.id)).flatMap(g=>g.wears.map(w=>w.id));if(!wears.length)throw new Error('Select a garment with wears to reset.');const r=record('wash',{wearIds:wears});await add([r]);$('dialog').close();notify('Wash recorded',[r.id]);});}
function settingsDialog(){const key = scope;dialog('Settings',`<div class="app-version"><span>App version ${esc(updater.version)}</span><button type="button" class="secondary" id="update-app">Update &amp; reload</button></div><p class="hint" id="update-status">Updates app files while keeping your wardrobe and pending entries.</p><p class="hint">Changes save on this device immediately and sync when you open the app with an internet connection. If your session expires, sign in when prompted.</p><button type="button" class="secondary backup-action" id="export">Export wardrobe backup</button><label>Restore or merge a backup<input id="import" type="file" accept="application/json,.json"></label><p class="hint">Exports contain garment photos and history. Keep a backup of pending entries before clearing browser data.</p>`,saveButton('Done'),async()=>{$('dialog').close();});
 $('export').disabled = $('import').disabled = !key;
 $('update-app').onclick=()=>void updateApp($('update-app'),$('update-status'));
 $('export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({version:1,records:state.records})],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`wearlog-${today()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 $('import').onchange=async()=>{try{const data=JSON.parse(await $('import').files[0].text());if(data.version!==1||!Array.isArray(data.records))throw new Error('Not a Wearlog backup');for(const r of data.records){if(r.type==='garment'){if(r.photo&&(!r.photo.startsWith('data:image/jpeg;base64,')||r.photo.length>800000))throw new Error('Invalid backup photo');r.photoHash=r.photo?await photoHash(jpegBytes(r.photo)):null;}validateRecord(r);}await mutate(s=>{const known=new Set(s.records.map(r=>r.id));const extra=data.records.filter(r=>!known.has(r.id)).map(({actor, ...record})=>record);s.records.push(...extra);s.outbox.push(...extra);}, key);if(key===scope && $('dialog').open && $('import')){$('dialog').close();notify('Backup merged');}void sync();}catch(e){$('form-error').textContent=e.message;}};
}
function createWardrobe() {
 const suggestion = !activeId && profile?.name ? `${profile.name}’s Wardrobe` : '';
 dialog('Name your wardrobe', `<label>Wardrobe name<input id="wardrobe-name" required maxlength="80" value="${esc(suggestion)}"></label>`,
  saveButton('Create wardrobe'), async () => {
   const name = $('wardrobe-name').value;
   const account = profile.account;
   await syncTask;
   const created = await api('/api/wardrobes', {account, body: {name}});
   await openWardrobe(created);
  });
}
async function openWardrobe(wardrobe) {
 await setActive({
  ...profile, wardrobes: [...profile.wardrobes.filter(item => item.id !== wardrobe.id), {id: wardrobe.id, name: wardrobe.name}]
 }, wardrobe.id);
 if ($('dialog').open) $('dialog').close();
 void sync();
}
function inviteToken() {
 return new URL(location.href).searchParams.get('invite');
}
function clearInvite() {
 const url = new URL(location.href);
 url.searchParams.delete('invite');
 history.replaceState(null, '', url);
}
async function previewInvite(token) {
 const account = profile.account;
 const invite = await api('/api/invites?token=' + encodeURIComponent(token), {account});
 if (account !== profile?.account) throw new Error('Your sign-in changed. Try the invite again.');
 return {invite, account};
}
async function confirmInvite(token, {invite, account}, fromLink = false) {
 if (invite.joined) {
  if (fromLink) clearInvite();
  await openWardrobe(invite);
  return;
 }
 dialog(`Join ${invite.name}?`, '<p class="hint">Everyone in this wardrobe can add and delete garments, log wears and washes, and invite others.</p>',
  saveButton('Join wardrobe'), async () => {
   const joined = await api('/api/invites', {account, body: {token}});
   if (fromLink) clearInvite();
   await openWardrobe(joined);
  });
 if (fromLink) $('dialog').onclose = clearInvite;
}
function enterInvite() {
 dialog('Join with an invite', '<label>Invite link or code<input id="invite-entry" type="text" required autocomplete="off" autocapitalize="none" spellcheck="false"></label>',
  saveButton('Continue'), async () => {
   const input = $('invite-entry');
   const value = input.value.trim();
   let token = value;
   try { token = new URL(value).searchParams.get('invite'); } catch {}
   if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(token || '')) throw new Error('Paste a Wearlog invite link or code.');
   token = token.toLowerCase();
   const preview = await previewInvite(token);
   if (!$('dialog').open || !input.isConnected) return;
   $('dialog').close();
   await confirmInvite(token, preview);
  });
}
async function showInvite() {
 const token = inviteToken();
 if (!token || inviteInProgress || $('dialog').open || $('wardrobe-menu').open) return;
 inviteInProgress = true;
 try {
  const preview = await previewInvite(token);
  if ($('dialog').open || $('wardrobe-menu').open || token !== inviteToken()) return;
  await confirmInvite(token, preview, true);
 } catch (error) {
  if (error.status !== 404) throw error;
  clearInvite();
  notify(error.message);
 } finally {
  inviteInProgress = false;
 }
}
function inviteQr(url) {
 const qr = qrcode(0, 'M');
 qr.addData(url);
 qr.make();
 return qr.createDataURL(5, 20);
}
async function manageWardrobe() {
 const id = activeId;
 const account = profile.account;
 const key = scope;
 const path = '/api/wardrobes/' + id;
 try {
  const {members} = await api(path + '/members', {account});
  if (scope !== key || $('dialog').open) return;
  const name = profile.wardrobes.find(wardrobe => wardrobe.id === id).name;
  dialog(name,
   `<ul class="history">${members.map(member => `<li>${esc(member.email ?? member.name)}${member.you ? ' (you)' : ''}</li>`).join('')}</ul>
    <section id="invite-result" hidden>
     <img id="invite-qr" class="invite-qr" alt="QR code for this wardrobe invite">
     <label>Invite link<input id="invite-link" readonly></label>
     <label>Invite code<input id="invite-code" readonly></label>
     <p class="hint">To join in the installed app, open Wardrobes and choose Join with an invite.</p>
     <button type="button" id="copy-invite" class="secondary">Copy invite link</button>
     <p id="invite-status" class="hint" role="status"></p>
    </section>`,
   '<button type="button" id="share-wardrobe" class="primary">Share invite</button><button type="button" id="leave-wardrobe" class="danger">Leave wardrobe</button>',
   async () => {});
  $('share-wardrobe').onclick = async () => {
   const button = $('share-wardrobe');
   button.disabled = true;
   try {
    const {token} = await api(path + '/invite', {account, body: {}});
    if (!button.isConnected || !$('dialog').open) return;
    const link = new URL('/', location.origin);
    link.searchParams.set('invite', token);
    $('invite-qr').src = inviteQr(link.href);
    $('invite-link').value = link.href;
    $('invite-code').value = token;
    $('invite-result').hidden = false;
    $('invite-status').textContent = 'This invite works once and expires in seven days.';
    button.textContent = 'New invite';
   } catch (error) {
    if (button.isConnected) $('form-error').textContent = error.message;
   } finally {
    button.disabled = false;
   }
  };
  $('copy-invite').onclick = async () => {
   const input = $('invite-link');
   try {
    await navigator.clipboard.writeText(input.value);
    if (input.isConnected) $('invite-status').textContent = 'Link copied.';
   } catch {
    input.select();
    if (input.isConnected) $('invite-status').textContent = 'Copy the selected link.';
   }
  };
  $('leave-wardrobe').onclick = () => {
   $('dialog').close();
   confirmLeave(path, account, id, name, members.length === 1, key);
  };
 } catch (error) {
  notify(error.message === 'AUTH_REQUIRED' ? 'Sign in to manage this wardrobe.' : error.message);
  renderStatus();
 }
}
function confirmLeave(path, account, id, name, last, key) {
 dialog(`Leave ${name}?`,
  last ? '<p class="hint">You’re the last member. Leaving permanently deletes this wardrobe and its history.</p>' :
   '<p class="hint">Other members will keep the garments and history.</p>',
  saveButton(last ? 'Leave and delete' : 'Leave wardrobe'), async () => {
   await sync();
   if (scope !== key) return;
   if ((await load(key))?.outbox.length && !window.confirm('Some changes are still pending. Cancel to export a backup or retry sync. Leave anyway?')) return;
   try {
    await api(path + '/leave', {account, body: {deleteIfLast: last}});
   } catch (error) {
    if (error.status !== 409 || last || !error.message.includes('last member')) throw error;
    $('dialog').close();
    confirmLeave(path, account, id, name, true, key);
    return;
   }
   const remaining = profile.wardrobes.filter(wardrobe => wardrobe.id !== id);
   const saved = await load(key);
   if (!saved?.outbox.length) await writeState(store => store.delete(key));
   await setActive({...profile, wardrobes: remaining}, remaining[0]?.id);
   notify('Wardrobe left');
   void sync();
  });
}
async function selectWardrobe(id) {
 $('wardrobe-menu').close();
 if (id === activeId) return;
 const account = profile.account;
 switching = true;
 render();
 try {
  await syncTask;
  if (profile.account === account && profile.wardrobes.some(wardrobe => wardrobe.id === id)) await setActive(profile, id);
 } catch (error) {
  notify(error.message);
 } finally {
  switching = false;
  render();
  void sync();
 }
}
function openWardrobeMenu() {
 if ($('open-wardrobes').disabled || $('dialog').open || $('wardrobe-menu').open) return;
 $('wardrobe-menu').showModal();
}
$('open-wardrobes').onclick = openWardrobeMenu;
$('close-wardrobes').onclick = () => $('wardrobe-menu').close();
$('wardrobe-menu').onclick = event => {
 if (event.target === $('wardrobe-menu') && event.clientX > $('wardrobe-menu').getBoundingClientRect().right) $('wardrobe-menu').close();
};
for (const [id, action] of [['create-wardrobe', createWardrobe], ['manage-wardrobe', manageWardrobe], ['enter-invite', enterInvite]]) {
 $(id).onclick = () => {
  $('wardrobe-menu').close();
  void action();
 };
}
$('first-wardrobe').onclick = createWardrobe;
let swipeStart;
document.addEventListener('touchstart', event => {
 const touch = event.touches[0];
 swipeStart = event.touches.length === 1 && touch.clientX >= 26 && touch.clientX <= 64
  ? {x: touch.clientX, y: touch.clientY} : null;
}, {passive: true});
document.addEventListener('touchend', event => {
 if (!swipeStart) return;
 const touch = event.changedTouches[0];
 if (!event.touches.length && touch.clientX - swipeStart.x > 72 && Math.abs(touch.clientY - swipeStart.y) < 48) openWardrobeMenu();
 swipeStart = null;
}, {passive: true});
document.addEventListener('touchcancel', () => { swipeStart = null; }, {passive: true});
$('signin').onclick = () => {
 const token = inviteToken();
 location.assign('/auth/resume' + (token ? '?invite=' + encodeURIComponent(token) : ''));
};
$('close').onclick=()=>$('dialog').close();$('filter').onchange=render;$('add').onclick=addDialog;$('wash').onclick=()=>washDialog();$('settings').onclick=settingsDialog;
document.addEventListener('visibilitychange',()=>{clearTimeout(syncTimer);if(document.visibilityState==='visible'){void sync();void updater.check();}});window.addEventListener('online',()=>void sync());window.addEventListener('offline',()=>{clearTimeout(syncTimer);syncError='Connection unavailable';renderStatus();});window.addEventListener('focus',()=>{if(!busy)void sync();});
try {
 db = await new Promise((resolve, reject) => {
  const request = indexedDB.open('wearlog', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('state');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
 });
 const saved = await load('session');
 if (saved && navigator.onLine === false) await setActive(saved.profile, saved.activeId);
 void updater.start().catch(() => notify('Offline setup failed. Reopen while online to retry.'));
 setInterval(() => void updater.check(), 300000);
 await sync();
 if (!profile && saved) await setActive(saved.profile, saved.activeId);
 if (!profile && !authRequired && navigator.onLine === false) $('status').textContent = 'Connect to open your wardrobes';
} catch {
 $('status').textContent = 'Phone storage unavailable. Please enable browser storage and reload.';
 for (const id of ['add', 'wash', 'settings']) $(id).disabled = true;
}
