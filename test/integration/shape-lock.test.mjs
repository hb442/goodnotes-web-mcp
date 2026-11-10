import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { StyleController } from '../../src/styles.mjs';
import { Journal } from '../../src/journal.mjs';

test('shape locks use a border target, preserve appearance and refuse changed content or lost persistence', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 900, height: 800 } }),
    page = await context.newPage(),
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-shape-lock-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const url = 'https://web.goodnotes.com/s/ShapeLockFixture',
    title = 'Shape fixture',
    bounds = { x: 198, y: 198, width: 264, height: 164 };
  await context.route('https://web.goodnotes.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<style>body{margin:0;background:white}#shape{position:absolute;left:200px;top:200px;width:260px;height:160px;border:3px solid green;box-sizing:border-box}#object_context_menu,#object_menu_context_menu_option,#shared_menu_options_unlock_shape{position:absolute;left:550px;top:150px}</style><div id="shape"></div><button id="object_menu_context_menu_option" hidden>More</button><button id="shared_menu_options_unlock_shape" hidden>Unlock Shape</button><div id="object_context_menu" hidden><button>Front</button><button id="lock">Lock Shape</button></div><script>
 let locked=localStorage.getItem('locked')==='true';const shape=document.getElementById('shape'),more=document.getElementById('object_menu_context_menu_option'),unlock=document.getElementById('shared_menu_options_unlock_shape'),menu=document.getElementById('object_context_menu');
 window.hideMenus=()=>{more.hidden=unlock.hidden=menu.hidden=true};
 shape.onclick=e=>{if(e.clientY>204)return;hideMenus();if(locked)unlock.hidden=false;else more.hidden=false;};
 more.onclick=()=>{menu.hidden=false};
 function save(value){locked=value;localStorage.setItem('writes',String(Number(localStorage.getItem('writes')||0)+1));if(!localStorage.getItem('drop'))localStorage.setItem('locked',String(value));hideMenus();}
 document.getElementById('lock').onclick=()=>save(true);unlock.onclick=()=>save(false);
 document.onkeydown=e=>{if(e.key==='Escape')hideMenus()};
 if(localStorage.getItem('locked')!==null){shape.style.visibility='hidden';setTimeout(()=>shape.style.visibility='visible',900);}
 </script>`,
    }),
  );
  await page.goto(url);
  const view = {
    viewId: 'view',
    url,
    pageUrl: url,
    title,
    viewport: { width: 900, height: 800 },
    canvas: { x: 0, y: 0, width: 900, height: 800 },
  };
  const a = {
    config: { directory, documents: [{ url, title }] },
    journal: new Journal(directory),
    getView: () => view,
    assertView: async () => page,
    openDocument: async () => page,
    closePanels: async () => {},
    documents: { invalidate: async () => {} },
    objects: {
      selections: new Map(),
      readingMode: async () => page.evaluate(() => window.hideMenus()),
      tool: async () => {},
      clickCanvas: async (_p, x, y) => page.mouse.click(x, y),
      point: (v, x, y) => ({ x: x * v.canvas.width, y: y * v.canvas.height }),
      evidence: async () => ({}),
      select: async () => {
        await page.mouse.click(330, 201);
        return { selectionId: 'selected', bounds };
      },
    },
  };
  const c = new StyleController(a);
  c.selection = async () => {
    await page.mouse.click(330, 201);
    return {
      page,
      view,
      s: { bounds, hash: 'guard', x: 330 / 900, y: 201 / 800 },
      fresh: { bytes: await page.screenshot() },
    };
  };
  const selected = c.selection;
  c.selection = async () => {
    const r = await selected();
    delete r.s.x;
    delete r.s.y;
    return r;
  };
  await assert.rejects(
    c.arrange({ selectionId: 'selected', command: 'lock', operationId: 'missing-shape-border' }),
    (e) => e.code === 'SHAPE_POINT_REQUIRED',
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('writes')), null);
  c.selection = selected;
  const lock = await c.arrange({
    selectionId: 'selected',
    command: 'lock',
    operationId: 'shape-lock-success',
  });
  assert.equal(lock.verified, true);
  assert.equal(lock.kind, 'shape');
  assert.equal(lock.locked, true);
  await page.locator('#shape').evaluate((e) => (e.style.borderColor = 'red'));
  await assert.rejects(
    c.unlockObject({ unlockId: lock.unlockId, operationId: 'shape-lock-conflict' }),
    (e) => e.code === 'OBJECT_CHANGED',
  );
  assert.equal((await a.journal.get('shape-lock-conflict')).status, 'rejected');
  assert.equal(await page.evaluate(() => localStorage.getItem('writes')), '1');
  await page.locator('#shape').evaluate((e) => (e.style.borderColor = 'green'));
  const prepared = await c.prepareUnlock({
    viewId: 'view',
    x: 330 / 900,
    y: 201 / 800,
    kind: 'shape',
  });
  const unlocked = await c.unlockObject({
    unlockId: prepared.unlockId,
    operationId: 'shape-unlock-success',
  });
  assert.equal(unlocked.verified, true);
  assert.equal(unlocked.kind, 'shape');
  await page.evaluate(() => localStorage.setItem('drop', 'true'));
  const lost = { selectionId: 'selected', command: 'lock', operationId: 'shape-lock-lost' };
  await assert.rejects(c.arrange(lost), (e) => e.code === 'NOT_A_LOCKED_OBJECT');
  assert.equal((await a.journal.get(lost.operationId)).status, 'uncertain');
  await assert.rejects(c.arrange(lost), /automatic replay is blocked/);
  assert.equal(await page.evaluate(() => localStorage.getItem('writes')), '3');
});
