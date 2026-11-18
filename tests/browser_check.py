"""Browser smoke test: local Worker, temporary storage, optional system Chromium."""
from playwright.sync_api import sync_playwright, expect
from pathlib import Path
import os, subprocess, tempfile, atexit, time, urllib.request, base64
sandbox = tempfile.TemporaryDirectory()
atexit.register(sandbox.cleanup)
process = subprocess.Popen(['node', 'scripts/test-runtime.mjs'], cwd=Path(__file__).resolve().parents[1], env={**os.environ, 'PORT':'8765','TEST_STATE':sandbox.name}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
atexit.register(process.terminate)
for attempt in range(100):
    try:
        urllib.request.urlopen('http://localhost:8765/api/health'); break
    except OSError:
        time.sleep(0.1)
else:
    raise RuntimeError('Test server did not start')

def saved(page):
    expect(page.locator('#status')).to_have_attribute('data-state','saved',timeout=15000)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.getenv('PLAYWRIGHT_CHROMIUM_EXECUTABLE','/usr/bin/chromium') or None, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True, service_workers='allow')
    page = context.new_page()
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.goto('http://localhost:8765'); saved(page)
    page.evaluate('navigator.serviceWorker.ready'); page.reload(); saved(page)
    assert page.locator('#sync').count()==0
    assert page.locator('footer').count()==0
    assert 'remembered' not in page.locator('body').inner_text()
    page.locator('#add').click()
    assert page.locator('#photo-hint').count()==0
    with page.expect_file_chooser() as chooser:
        page.locator('#upload-area').click()
    assert chooser.value.is_multiple
    photo=page.evaluate('''() => {const c=document.createElement('canvas');c.width=300;c.height=450;const x=c.getContext('2d');x.fillStyle='#708273';x.fillRect(0,0,300,450);x.fillStyle='#e9e4d4';x.fillRect(70,80,160,240);return c.toDataURL('image/png').split(',')[1];}''')
    page.locator('#photo').set_input_files({'name':'shirt.png','mimeType':'image/png','buffer':base64.b64decode(photo)})
    expect(page.locator('#crop')).to_be_visible()
    page.locator('#group').fill('Merino')
    page.locator('#name').fill('Sage merino')
    # iOS avoids automatic focus zoom when text fields are at least 16px.
    assert page.locator('#group').evaluate('el=>parseFloat(getComputedStyle(el).fontSize)') >= 16
    assert page.locator('#group-select').evaluate('el=>parseFloat(getComputedStyle(el).fontSize)') >= 16
    page.locator('#dialog').get_by_role('button',name='Add garment',exact=True).click(); saved(page)
    expect(page.locator('.card')).to_have_count(1)

    # Paste a copied image and reuse the existing group without adding a name.
    page.locator('#add').click()
    expect(page.locator('#group-select')).to_have_value('0')
    expect(page.locator('#new-group-label')).to_be_hidden()
    page.locator('#group-select').select_option('new')
    expect(page.locator('#group')).to_be_focused()
    page.locator('#group-select').select_option('0')
    page.evaluate('''data => {const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));const dt=new DataTransfer();dt.items.add(new File([bytes],'pasted.png',{type:'image/png'}));document.getElementById('dialog').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));}''',photo)
    expect(page.locator('#crop')).to_be_visible()
    context.grant_permissions(['clipboard-read','clipboard-write'])
    page.evaluate('''async data => {const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));await navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([bytes],{type:'image/png'})})]);}''',photo)
    page.locator('#paste-photo').click()
    expect(page.locator('#form-error')).to_have_text('')
    page.locator('#dialog').get_by_role('button',name='Add garment',exact=True).click(); saved(page)
    expect(page.locator('.card')).to_have_count(2)
    assert page.locator('.card').nth(1).locator('h3').count()==0
    assert 'Untitled' not in page.locator('body').inner_text()
    first=page.locator('.card').first
    first.get_by_role('button',name='+1 Wear now',exact=True).click(); saved(page)
    expect(first.locator('.count')).to_contain_text('1 wear')
    context.set_offline(True)
    first.get_by_role('button',name='+1 Wear now',exact=True).click()
    expect(first.locator('.count')).to_contain_text('2 wears')
    page.reload()
    expect(first.locator('.count')).to_contain_text('2 wears')
    expect(page.locator('#status')).to_contain_text('1 pending')
    first.locator('[data-detail]').click()
    page.locator('#quantity').fill('3')
    page.get_by_role('button',name='Add past wears',exact=True).click()
    expect(first.locator('.count')).to_contain_text('5 wears')
    page.get_by_role('button',name='Wash a load',exact=True).click()
    expect(page.locator('[name=wash-item]').first).to_be_checked()
    expect(page.locator('[name=wash-item]').nth(1)).not_to_be_checked()
    page.get_by_role('button',name='Record wash',exact=True).click()
    expect(first.locator('.count')).to_contain_text('0 wears')
    page.locator('#toast').get_by_role('button',name='Undo').click()
    expect(first.locator('.count')).to_contain_text('5 wears')
    context.set_offline(False); saved(page)

    # Failed writes recover on a timer, without an online/focus event or a sync button.
    failures=[]
    def transient(route):
        if not failures:
            failures.append(True)
            route.fulfill(status=503,content_type='application/json',body='{"error":"Temporarily unavailable"}')
        else:
            route.continue_()
    page.route('**/api/sync',transient)
    first.get_by_role('button',name='+1 Wear now',exact=True).click()
    expect(page.locator('#status')).to_contain_text('1 pending')
    saved(page)
    page.unroute('**/api/sync')
    expect(first.locator('.count')).to_contain_text('6 wears')

    page.route('**/api/sync',lambda route:route.fulfill(status=401,content_type='application/json',body='{"error":"Sign in to sync"}'))
    first.get_by_role('button',name='+1 Wear now',exact=True).click()
    expect(page.locator('#signin')).to_be_visible()
    expect(page.locator('#status')).to_contain_text('1 pending')
    page.unroute('**/api/sync')
    page.evaluate("window.dispatchEvent(new Event('focus'))")
    saved(page); expect(page.locator('#signin')).to_be_hidden()

    # A second device receives photos and records; the first polls for its changes.
    other=browser.new_context()
    fresh=other.new_page();fresh.goto('http://localhost:8765');saved(fresh)
    expect(fresh.locator('.card').first.locator('.count')).to_contain_text('7 wears')
    assert fresh.locator('.card img').evaluate_all('images=>images.every(img=>img.complete&&img.naturalWidth>0)')
    fresh.locator('.card').first.get_by_role('button',name='+1 Wear now',exact=True).click();saved(fresh)
    expect(first.locator('.count')).to_contain_text('8 wears',timeout=35000)
    page.screenshot(path='/tmp/wearlog-mobile-v3.png',full_page=True)
    fresh.screenshot(path='/tmp/wearlog-desktop-v3.png',full_page=True)
    page.locator('#add').click()
    page.screenshot(path='/tmp/wearlog-add-v3.png',full_page=True)
    page.locator('#close').click()
    # Crop a gallery batch, reuse the group, skip a bad selection, and finish unnamed.
    context.set_offline(True)
    page.locator('#add').click()
    image_file={'name':'shirt.png','mimeType':'image/png','buffer':base64.b64decode(photo)}
    page.locator('#photo').set_input_files([image_file,image_file,image_file])
    expect(page.locator('#batch-position')).to_have_text('Photo 1 of 3')
    expect(page.locator('#crop')).to_be_visible()
    expect(page.locator('#name-label')).to_be_hidden()
    expect(page.locator('#group-select')).to_have_value('0')
    page.locator('#zoom').fill('1.5')
    page.locator('#dialog').get_by_role('button',name='Save & next',exact=True).click()
    expect(page.locator('#batch-position')).to_have_text('Photo 2 of 3')
    expect(page.locator('#batch-added')).to_have_text('1 added')
    expect(page.locator('#zoom')).to_have_value('1')
    expect(page.locator('.card')).to_have_count(3)
    page.locator('#skip-photo').click()
    expect(page.locator('#batch-position')).to_have_text('Photo 3 of 3')
    expect(page.locator('#crop')).to_be_visible()
    page.locator('#dialog').get_by_role('button',name='Save last',exact=True).click()
    expect(page.locator('#dialog')).not_to_be_visible()
    expect(page.locator('.card')).to_have_count(4)
    assert page.locator('.card h3').count()==1
    # An unreadable next photo cannot accidentally save the previous crop twice.
    page.locator('#add').click()
    bad={'name':'bad.png','mimeType':'image/png','buffer':b'not an image'}
    page.locator('#photo').set_input_files([image_file,bad,image_file])
    expect(page.locator('#crop')).to_be_visible()
    page.locator('#dialog').get_by_role('button',name='Save & next',exact=True).click()
    expect(page.locator('#form-error')).to_contain_text('Could not open')
    expect(page.locator('#dialog button[type=submit]')).to_be_disabled()
    page.locator('#skip-photo').click()
    expect(page.locator('#batch-position')).to_have_text('Photo 3 of 3')
    expect(page.locator('#crop')).to_be_visible()
    # Close midway: completed items survive reload; the unsaved crop is discarded.
    page.locator('#close').click()
    page.reload()
    expect(page.locator('.card')).to_have_count(5)
    context.set_offline(False);saved(page)
    page.evaluate('window.scrollTo(0,400)')
    assert abs(page.locator('.app-header').bounding_box()['y'])<1
    page.locator('#settings').click()
    expect(page.locator('#dialog-title')).to_have_text('Settings')
    page.locator('#close').click()
    page.evaluate('window.scrollTo(0,0)')
    page.locator('#add').click()
    page.locator('#photo').set_input_files([image_file,image_file])
    expect(page.locator('#crop')).to_be_visible()
    page.screenshot(path='/tmp/wearlog-batch-v4.png',full_page=True)
    page.locator('#close').click()
    page.screenshot(path='/tmp/wearlog-header-v4.png',full_page=True)
    assert not errors,errors
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    assert context.request.post('http://localhost:8765/api/sync',data={'records':[]},headers={'Origin':'https://evil.example'}).status==403
    assert context.request.post('http://localhost:8765/api/sync',data='bad').status==415
    print('PASS: gallery batch save/skip, invalid-photo recovery, partial-batch persistence, clickable picker, sticky header;  cropped photo, pasted image, group picker, optional name, 16px inputs, offline reload, wash/undo, automatic retry, session recovery, cross-device polling and mobile layout')
    browser.close()
