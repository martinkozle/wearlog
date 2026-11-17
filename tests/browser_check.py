"""Optional end-to-end smoke test. Requires Playwright and Chromium; starts a temporary server and database."""
from playwright.sync_api import sync_playwright, expect
from pathlib import Path
import json
import os, subprocess, tempfile, atexit, time, urllib.request
sandbox = tempfile.TemporaryDirectory()
atexit.register(sandbox.cleanup)
process = subprocess.Popen([__import__('sys').executable, 'server.py'], cwd=Path(__file__).resolve().parents[1], env={**os.environ, 'PORT':'8765','WEARLOG_DB':sandbox.name+'/wardrobe.sqlite3','WEARLOG_TOKEN':''}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
atexit.register(process.terminate)
for attempt in range(50):
    try:
        urllib.request.urlopen('http://localhost:8765/api/health'); break
    except OSError:
        time.sleep(0.1)
else:
    raise RuntimeError('Test server did not start')

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    context = browser.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True, service_workers='allow')
    page = context.new_page()
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.goto('http://localhost:8765')
    expect(page.locator('#status')).to_contain_text('All changes synced')
    page.evaluate('navigator.serviceWorker.ready')
    page.reload()
    page.get_by_role('button',name='+ Add garment',exact=True).click()
    # Valid PNG fixture, generated in browser to exercise upload/crop.
    photo=page.evaluate('''() => {const c=document.createElement('canvas');c.width=300;c.height=450;const x=c.getContext('2d');x.fillStyle='#708273';x.fillRect(0,0,300,450);x.fillStyle='#e9e4d4';x.fillRect(70,80,160,240);return c.toDataURL('image/png').split(',')[1];}''')
    import base64
    page.locator('#photo').set_input_files({'name':'shirt.png','mimeType':'image/png','buffer':base64.b64decode(photo)})
    expect(page.locator('#crop')).to_be_visible()
    page.locator('#name').fill('Sage merino')
    page.get_by_role('button',name='Add to wardrobe',exact=True).click()
    expect(page.locator('.card')).to_have_count(1)
    expect(page.locator('#status')).to_contain_text('All changes synced')
    page.get_by_role('button',name='+1 Wear now',exact=True).click()
    expect(page.locator('.count')).to_contain_text('1 wear')
    expect(page.locator('#status')).to_contain_text('All changes synced')
    context.set_offline(True)
    page.get_by_role('button',name='+1 Wear now',exact=True).click()
    expect(page.locator('.count')).to_contain_text('2 wears')
    page.reload()
    expect(page.locator('.count')).to_contain_text('2 wears')
    expect(page.locator('#status')).to_contain_text('1 pending')
    page.locator('[data-detail]').click()
    page.locator('#quantity').fill('3')
    page.get_by_role('button',name='Add past wears',exact=True).click()
    expect(page.locator('.count')).to_contain_text('5 wears')
    page.get_by_role('button',name='Wash a load',exact=True).click()
    page.get_by_role('button',name='Record wash',exact=True).click()
    expect(page.locator('.count')).to_contain_text('0 wears')
    page.locator('#toast').get_by_role('button',name='Undo').click()
    expect(page.locator('.count')).to_contain_text('5 wears')
    context.set_offline(False)
    page.locator('#sync').click()
    expect(page.locator('#status')).to_contain_text('All changes synced')
    page.screenshot(path='/tmp/wearlog-mobile.png',full_page=True)
    # A fresh device receives all records and photos.
    other=browser.new_context()
    fresh=other.new_page();fresh.goto('http://localhost:8765')
    expect(fresh.locator('.count')).to_contain_text('5 wears')
    fresh.screenshot(path='/tmp/wearlog-desktop.png',full_page=True)
    assert not errors, errors
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    print('PASS: photo cropping/upload, wear, offline reload, unknown-date batch, wash, undo, sync, second device, mobile layout; no page errors')
    assert context.request.post('http://localhost:8765/api/sync',data={'records':[]},headers={'Origin':'https://evil.example'}).status == 403
    assert context.request.post('http://localhost:8765/api/sync',data='bad').status == 415
    browser.close()
