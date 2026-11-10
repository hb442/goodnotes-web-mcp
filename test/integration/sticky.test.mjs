import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { StyleController } from '../../src/styles.mjs';
import { compareRegion } from '../../src/visual.mjs';
import { GoodnotesAdapter } from '../../src/adapter.mjs';
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(() => browser?.close());
test('native sticky reads wait for delayed notebook objects using selection-only attempts', async (t) => {
  const context = await browser.newContext({ viewport: { width: 800, height: 700 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent(
    `<div style="position:absolute;inset:100px" onclick="if(window.ready)document.getElementById('shared_menu_options_collapse').hidden=false"></div><button id="shared_menu_options_collapse" hidden>Collapse</button><button id="object_menu_context_menu_option">More</button><button id="object_menu_context_shared_menu_options_edit_text" onclick="document.querySelector('.ql-editor').hidden=false">Edit Text</button><div class="ql-editor" contenteditable="true" hidden>Delayed sticky</div><script>setTimeout(()=>window.ready=true,1200)</script>`,
  );
  let attempts = 0;
  const a = {
    nativeStickyEditors: new WeakSet(),
    objects: {
      commitSelection: async () => {},
      tool: async () => {},
      clickCanvas: async (_p, x, y) => {
        attempts++;
        await page.mouse.click(x, y);
      },
    },
  };
  const editor = await GoodnotesAdapter.prototype.openNativeTextEditor.call(
    a,
    page,
    { canvas: { x: 0, y: 0, width: 800, height: 700 } },
    0.5,
    0.5,
    'sticky',
  );
  assert.equal(await editor.innerText(), 'Delayed sticky');
  assert.equal(attempts, 2);
  assert.ok(a.nativeStickyEditors.has(page));
});
test('notebook sticky text is committed on its native page, not in the surrounding empty margin', async (t) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent(
    `<div id="interaction-layer-page-00000000-0000-4000-8000-000000000001" style="position:absolute;left:360px;top:60px;width:720px;height:920px" onclick="if(event.target===this)document.querySelector('.ql-editor').style.display='none'"><div class="ql-editor" contenteditable="true" style="position:absolute;left:430px;top:600px;width:200px;height:200px">Saved sticky</div></div>`,
  );
  let committed = false;
  const a = {
    nativeStickyEditors: new WeakSet([page]),
    objects: {
      clickCanvas: async (_p, x, y) => page.mouse.click(x, y),
      commitSelection: async () => {
        committed = true;
      },
    },
  };
  await GoodnotesAdapter.prototype.leaveEditor.call(a, page, page.locator('.ql-editor'));
  assert.equal(committed, true);
  assert.equal(a.nativeStickyEditors.has(page), false);
  assert.equal(await page.locator('.ql-editor').innerText(), 'Saved sticky');
});
test('native multi-selection layer labels are recognized without toggling an already open menu', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent(
    '<button id="object_menu_context_menu_option" onclick="throw Error(\'unexpected toggle\')">More</button><div id="object_context_menu"><button>Bring to Front</button><button>Send to Back</button></div>',
  );
  const result = await new StyleController({}).contextOptions(page);
  assert.deepEqual(result.available, [
    { command: 'front', label: 'Bring to Front' },
    { command: 'back', label: 'Send to Back' },
  ]);
});
test('locked sticky preparation reads the visible readonly field and ignores only floating zoom UI', async (t) => {
  const context = await browser.newContext({ viewport: { width: 800, height: 700 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent(
    '<style>body{margin:0;background:white}.ql-editor{position:absolute;left:200px;top:200px;width:220px;background:yellow}#zoomControl{position:absolute;bottom:40px;right:20px;background:black;color:white;box-shadow:0 0 30px #000}</style><div class="ql-editor" contenteditable="false"><p>LOCKED TEXT</p></div><button id="shared_menu_options_unlock_sticky_note">Unlock</button><div id="zoomControl">100%</div>',
  );
  const view = { viewId: 'view', canvas: { x: 0, y: 0, width: 800, height: 700 } },
    a = {
      getView: () => view,
      assertView: async () => page,
      objects: {
        readingMode: async () => {},
        tool: async () => {},
        clickCanvas: async () => {},
        point: (v, x, y) => ({ x: x * 800, y: y * 700 }),
      },
    },
    c = new StyleController(a);
  await assert.rejects(
    c.prepareUnlock({ viewId: 'view', x: 0.3, y: 0.3, expectedText: 'wrong' }),
    (e) => e.code === 'TEXT_CONFLICT',
  );
  assert.equal(c.unlocks.size, 0);
  const prepared = await c.prepareUnlock({
      viewId: 'view',
      x: 0.3,
      y: 0.3,
      expectedText: 'LOCKED TEXT',
    }),
    saved = c.unlocks.get(prepared.unlockId);
  assert.equal(prepared.text, 'LOCKED TEXT');
  await page.locator('#zoomControl').evaluate((e) => (e.textContent = '85%'));
  assert.equal(
    (await compareRegion(saved.before, await c.unselectedImage(page), saved.region)).matches,
    true,
  );
  await page.locator('.ql-editor').evaluate((e) => (e.innerHTML = '<p>DIFFERENT TEXT</p>'));
  assert.equal(
    (await compareRegion(saved.before, await c.unselectedImage(page), saved.region)).matches,
    false,
  );
  await assert.rejects(
    c.unlockSticky({ unlockId: 'missing', operationId: 'unlock-missing-001' }),
    (e) => e.code === 'STALE_UNLOCK',
  );
  await page
    .locator('#shared_menu_options_unlock_sticky_note')
    .evaluate((e) => (e.id = 'shared_menu_options_unlock_image'));
  await assert.rejects(
    c.prepareUnlock({ viewId: 'view', x: 0.3, y: 0.3, kind: 'text' }),
    (e) => e.code === 'NOT_A_LOCKED_OBJECT',
  );
  const image = await c.prepareUnlock({ viewId: 'view', x: 0.3, y: 0.3, kind: 'image' });
  assert.equal(image.kind, 'image');
  assert.equal(image.text, null);
  await assert.rejects(
    c.unlockSticky({ unlockId: image.unlockId, operationId: 'unlock-wrong-kind' }),
    (e) => e.code === 'WRONG_OBJECT_KIND',
  );
  await page
    .locator('#shared_menu_options_unlock_image')
    .evaluate((e) => (e.id = 'shared_menu_options_unlock_text'));
  const text = await c.prepareUnlock({
    viewId: 'view',
    x: 0.3,
    y: 0.3,
    kind: 'text',
    expectedText: 'DIFFERENT TEXT',
  });
  assert.equal(text.kind, 'text');
});
