// App updates touch only service-worker shell files, never wardrobe storage.
export function createUpdater({version,beforeReload=async()=>{},onAvailable=()=>{}}){
 let registrationPromise,latestVersion=version,applying=false;
 const registration=()=>registrationPromise??=navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'});
 const available=()=>{if(latestVersion!==version)onAvailable(latestVersion);};
 if('serviceWorker'in navigator){
  navigator.serviceWorker.addEventListener('message',event=>{if(event.data?.type==='WEARLOG_UPDATE_READY'){latestVersion=event.data.version;available();}});
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
   const controller=navigator.serviceWorker.controller;if(!controller)return;
   const channel=new MessageChannel();channel.port1.onmessage=event=>{latestVersion=event.data.version;available();channel.port1.close();};
   controller.postMessage({type:'GET_VERSION'},[channel.port2]);
  });
 }
 async function serverVersion(){
  if(navigator.onLine===false)throw new Error('Connect to the internet to update.');
  const response=await fetch('/version.json?check='+Date.now(),{cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(15000)});
  if(response.type==='opaqueredirect'||[301,302,303,307,308,401,403].includes(response.status))throw new Error('Sign in again, then retry the update.');
  if(!response.ok||!response.headers.get('Content-Type')?.includes('json'))throw new Error('Could not check for an app update. Please retry.');
  const result=await response.json();if(!/^[a-zA-Z0-9.-]+$/.test(result.version||''))throw new Error('Invalid app version response.');
  latestVersion=result.version;available();return result.version;
 }
 async function check(){
  if(document.hidden||navigator.onLine===false)return;
  try{await serverVersion();if('serviceWorker'in navigator){const reg=await registration();await reg.update();}}catch{/* Update checks never interrupt wardrobe use. */}
 }
 async function waitForActive(reg){
  const started=Date.now();
  while(Date.now()-started<25000){
   if(reg.waiting)reg.waiting.postMessage({type:'SKIP_WAITING'});
   if(!reg.installing&&!reg.waiting&&reg.active?.state==='activated')return;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('The update could not finish downloading. Please retry.');
 }
 async function apply(){
  if(applying)return;applying=true;
  try{
   const expected=await serverVersion();
   await beforeReload();
   if('serviceWorker'in navigator){
    const reg=await registration();await reg.update();await waitForActive(reg);
    // A failed new-worker install can leave the old active worker in place.
    // Verify it, rather than reporting a successful update while still stale.
    const actual=await new Promise((resolve,reject)=>{
     const channel=new MessageChannel();const timer=setTimeout(()=>{channel.port1.close();reject(new Error('The new app files are not ready. Please retry.'));},5000);
     channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data?.version);};
     reg.active.postMessage({type:'GET_VERSION'},[channel.port2]);
    });
    if(actual!==expected)throw new Error('The new app files are not ready. Please retry.');
   }
   await beforeReload();
   location.replace('/?app-update='+encodeURIComponent(expected));
  }finally{applying=false;}
 }
 return {check,apply,start:async()=>{if('serviceWorker'in navigator)await registration();void check();},get version(){return version;}};
}
