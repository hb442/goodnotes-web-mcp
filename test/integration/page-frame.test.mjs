import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { frameAtPoint, pageFrame, mapPageBounds } from '../../src/page-frame.mjs';
import { BoardScanController } from '../../src/board-scan.mjs';
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
test('notebook bookmarks select one native page, measure CSS scale and reject cross-page, rotated or changed geometry', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage(),
    id = '00000000-0000-4000-8000-000000000009',
    view = { viewId: 'notebook-view' },
    controller = new BoardScanController({
      config: { directory: '.' },
      getPage: async () => page,
      inspect: async () => view,
      objects: { readingMode: async () => {} },
    });
  await page.setContent(
    `<div id="interaction-layer-page-${id}" style="position:absolute;left:0;top:0;width:800px;height:1000px;transform-origin:0 0;transform:matrix(.8,0,0,.8,200,50)"></div>`,
  );
  const bounds = { x: 250, y: 150, width: 100, height: 40 },
    anchor = await controller.selectionAnchor(page, bounds);
  assert.equal(anchor.kind, 'notebook');
  assert.equal(anchor.pageId, id);
  assert.equal(anchor.scale, 0.8);
  assert.equal(anchor.nativeHeight, 1000);
  // A reachable zoom can cross the stored value by floating-point noise.
  let zoomed = false;
  controller.a.navigate = async () => {
    zoomed = true;
    await page
      .locator('[id]')
      .evaluate((e) => (e.style.transform = 'matrix(.80000001,0,0,.80000001,200,50)'));
    return view;
  };
  await page.locator('[id]').evaluate((e) => (e.style.transform = 'matrix(1,0,0,1,200,50)'));
  await controller.position('fixture', anchor);
  assert.ok(zoomed);
  await page.locator('[id]').evaluate((e) => (e.style.transform = 'matrix(.8,0,0,.8,200,50)'));
  assert.deepEqual((await controller.position('fixture', anchor)).anchor, anchor);
  await assert.rejects(
    controller.selectionAnchor(page, { ...bounds, x: 190 }),
    (e) => e.code === 'OBJECT_CROSSES_PAGE',
  );
  await assert.rejects(controller.anchor(page), (e) => e.code === 'BOARD_ANCHOR_UNAVAILABLE');
  await page.locator('[id]').evaluate((e) => (e.style.height = '1100px'));
  await assert.rejects(
    controller.position('fixture', anchor),
    (e) => e.code === 'PAGE_GEOMETRY_CHANGED',
  );
  await page.locator('[id]').evaluate((e) => (e.style.transform = 'rotate(10deg)'));
  await assert.rejects(
    controller.notebookAnchor(page, id),
    (e) => e.code === 'PAGE_FRAME_UNAVAILABLE',
  );
});
after(() => browser?.close());
test('a native text position follows a shifted and resized page and rejects overlapping surfaces', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage(),
    id = '00000000-0000-4000-8000-000000000001';
  await page.setContent(
    '<div id="interaction-layer-page-' +
      id +
      '" style="position:absolute;left:100px;top:50px;width:500px;height:700px"></div>',
  );
  const anchor = { x: 210, y: 170, width: 1, height: 1 },
    first = await frameAtPoint(page, anchor);
  assert.equal(first.pageId, id);
  await page
    .locator('[id]')
    .evaluate(
      (e) => (e.style.cssText = 'position:absolute;left:200px;top:70px;width:750px;height:1050px'),
    );
  assert.deepEqual(mapPageBounds(anchor, first, await pageFrame(page, id)), {
    x: 365,
    y: 250,
    width: 1.5,
    height: 1.5,
  });
  await assert.rejects(
    frameAtPoint(page, { x: 10, y: 10 }),
    (e) => e.code === 'PAGE_FRAME_UNAVAILABLE',
  );
  await page.locator('[id]').evaluate((e) => {
    const c = e.cloneNode();
    c.id += '-overlap';
    document.body.append(c);
  });
  await assert.rejects(
    frameAtPoint(page, { x: 300, y: 100 }),
    (e) => e.code === 'PAGE_FRAME_UNAVAILABLE',
  );
});
