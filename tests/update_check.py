"""Exercise legacy-PWA recovery, release updates, offline use and data retention."""
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
import threading, json, mimetypes, os
ROOT=Path(__file__).resolve().parents[1]/'web'
CURRENT=json.loads((ROOT/'version.json').read_text())['version']
NEXT=CURRENT+'-next'
BROKEN=CURRENT+'-broken'
state={'mode':'legacy','break_install':False,'auth_version':False}
LEGACY_SW="""const CACHE='wearlog-shell-v4';self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/']))));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(e.request.method==='GET')e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request)));});"""
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):self.respond(503,b'{"error":"Temporary test outage"}','application/json')
    def respond(self,status,body,mime='text/plain'):
        self.send_response(status);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.end_headers()
        try:self.wfile.write(body)
        except (BrokenPipeError,ConnectionResetError):pass
    def do_GET(self):
        path=urlsplit(self.path).path
        if (path=='/version.json' and state['auth_version']) or (path=='/schema.js' and state['break_install']):
            self.send_response(302);self.send_header('Location','/login');self.end_headers();return
        if path=='/login':return self.respond(200,b'<h1>Sign in</h1>','text/html')
        if state['mode']=='legacy':
            if path=='/':return self.respond(200,b'<!doctype html><title>Legacy</title><h1>Legacy app</h1>','text/html')
            if path=='/sw.js':return self.respond(200,LEGACY_SW.encode(),'text/javascript')
        version=CURRENT if state['mode'] in ('legacy','current') else NEXT if state['mode']=='next' else BROKEN
        if path=='/api/wardrobes':
            profile={'account':'test-account','name':'Local','wardrobes':[{'id':'legacy','name':'Martin’s Wardrobe'}]}
            return self.respond(200,json.dumps(profile).encode(),'application/json')
        if path=='/version.json':return self.respond(200,json.dumps({'version':version}).encode(),'application/json')
        name='index.html' if path=='/' else 'update.html' if path=='/update' else path.lstrip('/')
        file=ROOT/name
        if not file.is_file() or ROOT not in file.resolve().parents:return self.respond(404,b'Not found')
        body=file.read_bytes()
        if file.suffix in ('.html','.js','.css'):body=body.decode().replace(CURRENT,version).encode()
        return self.respond(200,body,mimetypes.guess_type(file)[0] or 'application/octet-stream')
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
URL=f'http://localhost:{server.server_address[1]}'
def snapshot(page):
    return page.evaluate('''() => new Promise((resolve,reject)=>{const r=indexedDB.open('wearlog',1);r.onsuccess=()=>{const db=r.result;const q=db.transaction('state').objectStore('state').get('wardrobe:test-account:legacy');q.onsuccess=()=>{db.close();resolve(q.result)};q.onerror=()=>reject(q.error)}})''')
def version(page):return page.locator('meta[name=app-version]')
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.getenv('PLAYWRIGHT_CHROMIUM_EXECUTABLE','/usr/bin/chromium') or None,args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':390,'height':844},service_workers='allow')
    page=context.new_page();page.goto(URL)
    page.evaluate("navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready)")
    page.reload();expect(page.get_by_role('heading',name='Legacy app')).to_be_visible()
    page.evaluate('''async () => {
      const records=[{id:'offline-shirt',type:'garment',name:'',group:'Merino',photoHash:null,recordedAt:'2026-11-18T08:00:00Z'},{id:'offline-wear',type:'wear',garmentId:'offline-shirt',quantity:2,wornOn:null,recordedAt:'2026-11-18T08:01:00Z'}];
      await new Promise((resolve,reject)=>{const r=indexedDB.open('wearlog',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>{const db=r.result,tx=db.transaction('state','readwrite');tx.objectStore('state').put({records,outbox:records,cursor:0},'main');tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)}});
      await (await caches.open('another-app-cache')).put('/keep',new Response('keep me'));
    }''')
    # An ordinary reload is still the old, cache-first interface.
    state['mode']='current';page.reload();expect(page.get_by_role('heading',name='Legacy app')).to_be_visible()
    # The new recovery route is reachable through that old worker.
    page.goto(URL+'/update');page.get_by_role('button',name='Update & open Wearlog').click()
    page.wait_for_url('**/?app-update='+CURRENT,timeout=30000)
    expect(version(page)).to_have_attribute('content',CURRENT,timeout=30000)
    expect(page.locator('.count')).to_contain_text('2 wears')
    assert len(snapshot(page)['outbox'])==2
    keys=page.evaluate('caches.keys()');assert 'another-app-cache' in keys and 'wearlog-shell-v4' not in keys
    context.set_offline(True);page.reload();expect(page.locator('.count')).to_contain_text('2 wears')
    page.locator('#settings').click();page.locator('#update-app').click()
    expect(page.locator('#update-status')).to_contain_text('Connect to the internet')
    assert len(snapshot(page)['outbox'])==2
    page.locator('#close').click();context.set_offline(False)
    # Keep a draft open across a new release. Activation must not reload it.
    page.locator('#add').click();page.locator('#name').fill('Unsaved draft')
    state['mode']='next'
    page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    expect(page.locator('#app-update')).to_be_visible(timeout=30000)
    expect(page.locator('#name')).to_have_value('Unsaved draft')
    expect(version(page)).to_have_attribute('content',CURRENT)
    # New navigation gets the new HTML and its matching versioned module graph.
    fresh=context.new_page();fresh.goto(URL)
    expect(version(fresh)).to_have_attribute('content',NEXT)
    expect(fresh.locator('.count')).to_contain_text('2 wears',timeout=15000);fresh.close()
    page.locator('#close').click();page.locator('#settings').click();page.locator('#update-app').click()
    expect(version(page)).to_have_attribute('content',NEXT,timeout=30000)
    assert len(snapshot(page)['outbox'])==2
    # An expired Access session is reported, never cached as app code.
    state['auth_version']=True
    page.locator('#settings').click();page.locator('#update-app').click()
    expect(page.locator('#update-status')).to_contain_text('Sign in again')
    state['auth_version']=False;state['mode']='broken';state['break_install']=True
    page.locator('#update-app').click()
    expect(page.locator('#update-status')).to_contain_text('not ready',timeout=30000)
    assert len(snapshot(page)['outbox'])==2
    keys=page.evaluate('caches.keys()');assert 'wearlog-shell-'+NEXT in keys and 'wearlog-shell-'+BROKEN not in keys
    state['mode']='next';state['break_install']=False
    page.locator('#close').click();context.set_offline(True);page.reload()
    expect(version(page)).to_have_attribute('content',NEXT);expect(page.locator('.count')).to_contain_text('2 wears')
    assert len(snapshot(page)['outbox'])==2
    browser.close()
server.shutdown();server.server_close()
print('PASS: legacy cache recovery, multi-window update, draft retention, versioned navigation, offline restart, preserved outbox, expired login and failed-install rollback')
