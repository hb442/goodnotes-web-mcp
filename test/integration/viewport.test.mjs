import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BoardScanController } from '../../src/board-scan.mjs';
import { captureBoardViewport, restoreBoardViewport } from '../../src/viewport.mjs';
import { DocumentController } from '../../src/documents.mjs';

test('a reset board camera restores zoom and precise pan; identity and movement failures stop verification', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const url = 'https://fixture.test/board';
  const html = `<style>body{margin:0;overflow:hidden}#infoButton{position:fixed;z-index:2}[id^="interaction-layer-page-"]{position:absolute;width:100000px;height:100000px;transform-origin:0 0}</style><button id="infoButton">Board</button><div id="interaction-layer-page-board"></div><script>
    window.camera={x:-50000,y:-50000,scale:1};window.frozen=false;
    window.draw=()=>{const e=document.querySelector('[id^="interaction-layer-page-"]');e.style.left=camera.x+'px';e.style.top=camera.y+'px';e.style.transform='scale('+camera.scale+')'};
    let drag;document.onmousedown=e=>drag={x:e.clientX,y:e.clientY};document.onmouseup=()=>drag=null;
    document.onmousemove=e=>{if(drag&&!frozen){camera.x+=e.clientX-drag.x;camera.y+=e.clientY-drag.y;drag={x:e.clientX,y:e.clientY};draw()}};draw();</script>`;
  await page.route(url, (r) => r.fulfill({ body: html, contentType: 'text/html' }));
  await page.goto(url);
  let sequence = 0;
  const a = {
    config: { directory: '.' },
    views: new Map(),
    getPage: async () => page,
    objects: { readingMode: async () => {} },
    assertView: async () => page,
  };
  a.inspect = async () => {
    a.views.clear();
    const scale = await page.evaluate(() => camera.scale);
    const view = {
      viewId: String(++sequence),
      url,
      pageUrl: url,
      title: 'Board',
      zoom: scale * 100 + '%',
      viewport: { width: 1200, height: 800 },
      canvas: { x: 0, y: 48, width: 1200, height: 744 },
    };
    a.views.set(view.viewId, view);
    return view;
  };
  a.navigate = async ({ zoomSteps, panX = 0, panY = 0 }) => {
    await page.evaluate(
      ({ n, x, y }) => {
        if (n) camera.scale *= n > 0 ? 2 : 0.5;
        if (!frozen) {
          // Actual board classifies integral wheel and fractional trackpad
          // deltas differently. A uniform-gain fixture hid the oscillation.
          camera.x -= Math.max(-448, Math.min(448, x * (Number.isInteger(x) ? 3.5 : 1)));
          camera.y -= Math.max(-448, Math.min(448, y * (Number.isInteger(y) ? 3.5 : 1)));
        }
        draw();
      },
      { n: zoomSteps, x: panX, y: panY },
    );
    return a.inspect();
  };
  a.scans = new BoardScanController(a);
  await page.evaluate(() => {
    camera = { x: -51341.25, y: -52053.5, scale: 0.5 };
    draw();
  });
  const view = await a.inspect(),
    checkpoint = await captureBoardViewport(page);
  await page.reload();
  await restoreBoardViewport(a, page, view, checkpoint);
  const restored = await captureBoardViewport(page);
  assert.ok(Math.abs(restored.x - checkpoint.x) < 3);
  assert.ok(Math.abs(restored.y - checkpoint.y) < 3);
  assert.equal(restored.scale, checkpoint.scale);
  assert.ok(a.views.has(view.viewId));
  a.openDocument = async () => page;
  a.closePanels = async () => {};
  a.getView = (id) => a.views.get(id);
  const documents = new DocumentController(a);
  documents.exportSnapshot = async () => {
    await page.reload();
    return { exportId: 'snapshot' };
  };
  assert.deepEqual(await documents.exportPdf({ url }), { exportId: 'snapshot' });
  assert.deepEqual(await captureBoardViewport(page), restored);
  documents.exportSnapshot = async () => {
    await page.reload();
    throw new Error('export unavailable');
  };
  await assert.rejects(documents.exportPdf({ url }), /export unavailable/);
  assert.deepEqual(await captureBoardViewport(page), restored);
  await page.locator('#infoButton').evaluate((e) => (e.textContent = 'Different'));
  await assert.rejects(
    restoreBoardViewport(a, page, view, checkpoint),
    (e) => e.code === 'DOCUMENT_CHANGED',
  );
  await page.locator('#infoButton').evaluate((e) => (e.textContent = 'Board'));
  await page.evaluate(() => {
    frozen = true;
    camera.x += 200;
    draw();
  });
  await assert.rejects(
    restoreBoardViewport(a, page, view, checkpoint),
    (e) => e.code === 'BOARD_PAN_UNVERIFIED',
  );
  await page
    .locator('[id^="interaction-layer-page-"]')
    .evaluate((e) => (e.id = 'interaction-layer-page-other'));
  await assert.rejects(
    restoreBoardViewport(a, page, view, checkpoint),
    (e) => e.code === 'BOARD_CHANGED',
  );
  await page.locator('[id^="interaction-layer-page-"]').evaluate((e) => {
    e.style.width = '1000px';
    e.style.height = '1000px';
  });
  assert.equal(await captureBoardViewport(page), null);
});
