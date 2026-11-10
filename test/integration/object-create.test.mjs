import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { ObjectController } from '../../src/objects.mjs';
import { Journal } from '../../src/journal.mjs';

test('native object creation waits for late paint and never redraws a missing save', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const { lost, kind } of [
    { lost: false, kind: 'rectangle' },
    { lost: true, kind: 'rectangle' },
    { lost: false, kind: 'triangle' },
    { lost: false, kind: 'diamond' },
    { lost: false, kind: 'rounded-rectangle' },
  ]) {
    const context = await browser.newContext({ viewport: { width: 800, height: 800 } });
    t.after(() => context.close());
    const page = await context.newPage(),
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-object-create-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const url = 'https://web.goodnotes.com/s/CreateFixture',
      title = 'Fixture';
    await context.route('https://web.goodnotes.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<style>body{margin:0;background:white}#shape{position:absolute;left:200px;top:200px;width:200px;height:120px;box-sizing:border-box;display:none}</style><button data-kind="rectangle"><svg><rect x="3" y="3" width="18" height="18" rx="1"/></svg></button><button data-kind="triangle"><svg><path d="M2.78306 20.5H21.2169"/></svg></button><button data-kind="diamond"><svg><path d="m12.707 2.7071 8.5858 8.5858"/></svg></button><button data-kind="rounded-rectangle"><svg><rect x="3" y="4" width="18" height="16" rx="7"/></svg></button><div id="shape"></div><script>
  const shape=document.getElementById('shape');let dragging=false;
  for(const b of document.querySelectorAll('button[data-kind]'))b.onclick=()=>localStorage.setItem('choice',b.dataset.kind);
  function draw(){const k=localStorage.getItem('choice'),g=k==='triangle'?'<path d="M3 117L100 3L197 117Z"/>':k==='diamond'?'<path d="M100 3L197 60L100 117L3 60Z"/>':k==='rounded-rectangle'?'<rect x="3" y="3" width="194" height="114" rx="40"/>':'<rect x="3" y="3" width="194" height="114"/>';shape.innerHTML='<svg viewBox="0 0 200 120" width="200" height="120"><g fill="none" stroke="green" stroke-width="3">'+g+'</g></svg>';shape.style.display='block'}
  document.addEventListener('mousedown',e=>{dragging=e.clientX===200&&e.clientY===200});
  document.addEventListener('mouseup',()=>{if(!dragging)return;dragging=false;localStorage.setItem('draws',String(Number(localStorage.getItem('draws')||0)+1));localStorage.setItem('saved','yes');draw()});
  if(localStorage.getItem('saved')&&!${lost})setTimeout(draw,1800);
  </script>`,
      }),
    );
    await page.goto(url);
    const view = {
        viewId: 'view',
        viewport: { width: 800, height: 800 },
        url,
        pageUrl: url,
        title,
        canvas: { x: 0, y: 0, width: 800, height: 800 },
      },
      bounds = { x: 200, y: 200, width: 200, height: 120 };
    const a = {
      config: { directory, documents: [{ url, title }] },
      journal: new Journal(directory),
      getView: () => view,
      assertView: async () => page,
      openDocument: async () => page,
      closePanels: async () => {},
      documents: { invalidate: async () => {} },
    };
    const c = new ObjectController(a);
    a.objects = c;
    for (const name of ['readingMode', 'captureBaseline', 'tool', 'clickCanvas', 'reselectBounds'])
      c[name] = async () => {};
    c.snapshot = async () => ({ bounds, hash: 'fixture', bytes: await page.screenshot() });
    c.evidence = async () => ({});
    const args = {
      viewId: 'view',
      kind,
      x: 0.25,
      y: 0.25,
      width: 0.25,
      height: 0.15,
      operationId: 'create-delayed',
    };
    if (lost) {
      await assert.rejects(c.create(args), (e) => e.code === 'SAVE_UNVERIFIED');
      assert.equal((await a.journal.get(args.operationId)).status, 'uncertain');
      await assert.rejects(c.create(args), /automatic replay is blocked/);
    } else {
      assert.equal((await c.create(args)).verified, true);
      assert.equal((await a.journal.get(args.operationId)).status, 'verified');
    }
    assert.equal(await page.evaluate(() => localStorage.getItem('draws')), '1');
    assert.equal(await page.evaluate(() => localStorage.getItem('choice')), kind);
  }
});
