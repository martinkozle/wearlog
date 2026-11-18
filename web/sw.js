const CACHE='wearlog-shell-v3';
const SHELL=['/','/index.html','/style.css','/app.js','/model.js','/schema.js','/manifest.webmanifest','/icon.svg','/icon.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{const u=new URL(event.request.url);if(event.request.method!=='GET'||u.origin!==self.location.origin||(u.pathname.startsWith('/api/')||u.pathname.startsWith('/auth/')||u.pathname.startsWith('/cdn-cgi/')))return;event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request)));});
