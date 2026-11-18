const VERSION='2026.11.18.5';
const CACHE='wearlog-shell-'+VERSION;
const SHELL=['/','/style.css?v='+VERSION,'/app.js?v='+VERSION,'/updates.js?v='+VERSION,'/model.js?v='+VERSION,'/schema.js?v='+VERSION,'/manifest.webmanifest','/icon.svg','/icon.png'];
function valid(response,path){
 if(!response.ok||response.redirected||new URL(response.url).origin!==self.location.origin)return false;
 const type=response.headers.get('Content-Type')||'';
 if(path==='/')return type.includes('text/html');
 if(path.split('?')[0].endsWith('.js'))return /javascript/.test(type);
 if(path.split('?')[0].endsWith('.css'))return type.includes('text/css');
 return true;
}
self.addEventListener('install',event=>{
 event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  try{
   const files=await Promise.allSettled(SHELL.map(async path=>{
    const response=await fetch(new Request(path,{cache:'reload',redirect:'error',signal:AbortSignal.timeout(15000)}));
    if(!valid(response,path))throw new Error('Could not download app files');
    await cache.put(path,response);
   }));
   if(files.some(file=>file.status==='rejected'))throw new Error('Could not download app files');
   // Activate a complete shell even when Safari or another PWA window is open.
   // Existing pages are not navigated: unfinished photo forms remain intact.
   await self.skipWaiting();
  }catch(error){await caches.delete(CACHE);throw error;}
 })());
});
self.addEventListener('activate',event=>{
 event.waitUntil((async()=>{
  await self.clients.claim();
  await Promise.all((await caches.keys()).filter(key=>key.startsWith('wearlog-shell-')&&key!==CACHE).map(key=>caches.delete(key)));
  for(const client of await self.clients.matchAll({type:'window'}))client.postMessage({type:'WEARLOG_UPDATE_READY',version:VERSION});
 })());
});
self.addEventListener('message',event=>{
 if(event.data?.type==='SKIP_WAITING')event.waitUntil(self.skipWaiting());
 if(event.data?.type==='GET_VERSION')event.ports[0]?.postMessage({version:VERSION});
});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin)return;
 // Recovery, authentication, and version checks must always reach the server.
 if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/auth/')||url.pathname.startsWith('/cdn-cgi/')||['/update','/update.html','/recover.js','/version.json','/sw.js'].includes(url.pathname))return;
 if(request.mode==='navigate'&&['/','/index.html'].includes(url.pathname)){
  event.respondWith((async()=>{
   try{
    const response=await fetch(new Request(request,{cache:'no-store'}));
    // Keep the cached shell on server failures, but allow Access sign-in redirects.
    if(response.ok||response.type==='opaqueredirect'||response.redirected)return response;
    const cached=await caches.match('/',{cacheName:CACHE});return cached||response;
   }catch{const cached=await caches.match('/',{cacheName:CACHE});return cached||Response.error();}
  })());return;
 }
 // Cache only exact versioned shell requests. A new HTML release can request its
 // matching modules immediately instead of receiving a previous release's code.
 const path=url.pathname+url.search;
 if(!SHELL.includes(path))return;
 event.respondWith((async()=>{
  const cached=await caches.match(request,{cacheName:CACHE});
  if(cached&&request.cache!=='reload'&&request.cache!=='no-store')return cached;
  return fetch(request);
 })());
});
