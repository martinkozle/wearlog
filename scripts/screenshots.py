"""Capture a local demo wardrobe. Requires Python Playwright and Chromium.

Run after npm run build. Photos are downloaded from Pexels into a temporary
folder. All demo records are saved to a temporary local Worker, never production.
Photo sources and terms: docs/images/CREDITS.md.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
import os, subprocess, tempfile, atexit, urllib.request, time

ROOT=Path(__file__).resolve().parents[1]
PHOTO_IDS=[9594692,34156905,18186106,18186105,36392069,34156906]
sandbox=tempfile.TemporaryDirectory();atexit.register(sandbox.cleanup)
process=subprocess.Popen(['node','scripts/test-runtime.mjs'],cwd=ROOT,env={**os.environ,'PORT':'8766'},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
atexit.register(process.terminate)
for _ in range(100):
    try:
        urllib.request.urlopen('http://localhost:8766/api/health');break
    except OSError:time.sleep(.1)
else:raise RuntimeError('Local screenshot server did not start')
files=[]
for ident in PHOTO_IDS:
    target=Path(sandbox.name)/f'{ident}.jpg'
    req=urllib.request.Request(f'https://images.pexels.com/photos/{ident}/pexels-photo-{ident}.jpeg?auto=compress&cs=tinysrgb&w=1200',headers={'User-Agent':'Wearlog README screenshots'})
    target.write_bytes(urllib.request.urlopen(req,timeout=30).read());files.append(str(target))
output=ROOT/'docs/images';output.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.getenv('PLAYWRIGHT_CHROMIUM_EXECUTABLE','/usr/bin/chromium') or None,args=['--no-sandbox'])
    desktop=browser.new_context(viewport={'width':1200,'height':980},device_scale_factor=1)
    page=desktop.new_page();page.goto('http://localhost:8766')
    expect(page.locator('#status')).to_have_attribute('data-state','saved')
    page.locator('#add').click();page.locator('#photo').set_input_files(files)
    expect(page.locator('#crop')).to_be_visible();page.locator('#group').fill('T-shirts')
    for i in range(len(files)):
        button='Save & next' if i<len(files)-1 else 'Save last'
        page.locator('#dialog').get_by_role('button',name=button,exact=True).click()
        if i<len(files)-1:expect(page.locator('#batch-position')).to_have_text(f'Photo {i+2} of {len(files)}')
    expect(page.locator('#dialog')).not_to_be_visible()
    for index,count in enumerate([2,0,3,1,0,2]):
        for _ in range(count):page.locator('.card').nth(index).get_by_role('button',name='+1 Wear now',exact=True).click()
    expect(page.locator('#status')).to_have_attribute('data-state','saved')
    page.locator('#toast').evaluate('el=>el.hidden=true')
    page.evaluate('window.scrollTo(0,0)')
    page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    page.screenshot(path=str(output/'wardrobe-desktop.png'),full_page=True)
    phone=browser.new_context(viewport={'width':390,'height':844},device_scale_factor=2,is_mobile=True,has_touch=True)
    mobile=phone.new_page();mobile.goto('http://localhost:8766')
    expect(mobile.locator('.card')).to_have_count(6)
    expect(mobile.locator('#status')).to_have_attribute('data-state','saved')
    mobile.screenshot(path=str(output/'wardrobe-mobile.png'),full_page=True)
    mobile.locator('#add').click();mobile.locator('#photo').set_input_files(files[:3])
    expect(mobile.locator('#crop')).to_be_visible()
    mobile.locator('#dialog').get_by_role('button',name='Save & next',exact=True).click()
    expect(mobile.locator('#batch-position')).to_have_text('Photo 2 of 3')
    expect(mobile.locator('#crop')).to_be_visible()
    mobile.screenshot(path=str(output/'batch-import.png'))
    browser.close()
print('Captured desktop, mobile, and batch-import screenshots from the local demo')
