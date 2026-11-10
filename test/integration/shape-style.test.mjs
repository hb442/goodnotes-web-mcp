import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { ShapeStyleController, setMeasuredSlider } from '../../src/shape-style.mjs';
import { Journal } from '../../src/journal.mjs';

const url = 'https://fixture.test/shape',
  pageId = '11111111-2222-4333-8444-555555555555';
const html = `<style>body{margin:0}#shape{position:absolute;left:150px;top:200px;width:250px;height:200px;box-sizing:border-box}#objectFloatingMenu{position:absolute;left:700px;top:150px;background:white;padding:20px}.slider{width:280px;height:20px;background:#bbb;margin:20px}</style>
<div id="interaction-layer-page-${pageId}" style="position:absolute;width:1200px;height:800px"></div><div id="shape"></div><div style="position:absolute"><button id="shared_menu_options_edit_shape">Edit Shape</button><button id="shared_menu_options_change_color">Color</button><button id="shared_menu_options_stroke">Stroke</button></div><div id="objectFloatingMenu" hidden></div>
<script>
let state=JSON.parse(localStorage.getItem('state')||'{"fillEnabled":false,"fillOpacityPercent":0,"thicknessMm":0.7}');const menu=document.querySelector('#objectFloatingMenu');
function draw(){const e=document.querySelector('#shape');e.style.border=state.thicknessMm*5+'px solid #1b7a33';e.style.background=state.fillEnabled?'rgb(27 122 51 / '+state.fillOpacityPercent+'%)':'transparent'}
function save(){localStorage.setItem('writes',Number(localStorage.getItem('writes')||0)+1);if(!localStorage.getItem('drop'))localStorage.setItem('state',JSON.stringify(state));draw()}
function fill(){state.fillEnabled=state.fillOpacityPercent>0;menu.hidden=false;menu.innerHTML='<button role="switch" aria-checked="'+state.fillEnabled+'" id="fillsColorOptionsItem">Fill</button><p id="colorPickerOpacityValue">'+state.fillOpacityPercent+'%</p><div id="shapeOpacitySliderBar" class="slider"></div>';document.querySelector('#fillsColorOptionsItem').onclick=()=>{state.fillEnabled=!state.fillEnabled;if(!state.fillEnabled)state.fillOpacityPercent=0;save();menu.innerHTML="";menu.hidden=true};document.querySelector('#shapeOpacitySliderBar').onclick=e=>{const b=e.currentTarget.getBoundingClientRect();state.fillOpacityPercent=Math.round(Math.max(0,Math.min(1,(e.clientX-b.x)/b.width))*100);state.fillEnabled=state.fillOpacityPercent>0;save();fill()}}
function stroke(){menu.hidden=false;menu.innerHTML='<p>'+state.thicknessMm.toFixed(2)+' mm</p><div data-testid="toolThicknessSlider" class="slider"></div>';menu.querySelector('.slider').onclick=e=>{const b=e.currentTarget.getBoundingClientRect();state.thicknessMm=Math.round((0.1+Math.max(0,Math.min(1,(e.clientX-b.x)/b.width))*1.9)*100)/100;save();stroke()}}
document.querySelector('#shared_menu_options_change_color').onclick=fill;document.querySelector('#shared_menu_options_stroke').onclick=stroke;document.onkeydown=e=>{if(e.key==='Escape')menu.hidden=true};draw();
</script>`;

test('opacity slider permits its sibling thumb but rejects an unrelated covering overlay', async (t) => {
  const browser = await chromium.launch({ headless: true }),
    page = await browser.newPage();
  t.after(() => browser.close());
  await page.setContent(
    '<div id="toolOpacitySlider" style="position:absolute;left:100px;top:100px;width:280px;height:30px"><div id="shapeOpacitySliderBar" style="width:280px;height:30px;background:#ccc"></div><div style="position:absolute;left:130px;top:0;width:20px;height:30px;background:blue"></div></div><div id="cover" hidden style="position:absolute;left:100px;top:100px;width:280px;height:30px;background:red"></div>',
  );
  await page.evaluate(() => {
    window.writes = 0;
    document.querySelector('#toolOpacitySlider').onclick = () => window.writes++;
  });
  const slider = page.locator('#shapeOpacitySliderBar');
  await setMeasuredSlider(
    page,
    slider,
    async () => 50,
    50,
    () => {},
  );
  assert.equal(await page.evaluate(() => window.writes), 1);
  await page.locator('#cover').evaluate((e) => (e.hidden = false));
  await assert.rejects(
    setMeasuredSlider(
      page,
      slider,
      async () => 50,
      50,
      () => {},
    ),
    (e) => e.code === 'SLIDER_OBSCURED',
  );
  assert.equal(await page.evaluate(() => window.writes), 1);
});

test('native shape settings preserve geometry, require permissions and reject conflicts/lost saves without replay', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-shape-')),
    browser = await chromium.launch({ headless: true }),
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  t.after(async () => {
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await page.route('https://fixture.test/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.goto(url);
  const view = {
      viewId: 'view',
      url,
      pageUrl: url,
      title: 'Fixture',
      canvas: { x: 0, y: 0, width: 1200, height: 800 },
    },
    bounds = { x: 150, y: 200, width: 250, height: 200 };
  let grouped = false;
  const a = {
    config: { directory, documents: [] },
    journal: new Journal(directory),
    getView: () => view,
    inspect: async () => view,
    text: { closeMenu: async (p) => p.keyboard.press('Escape') },
    documents: { invalidate: async () => {} },
  };
  let selectionWriteCount = 0;
  a.objects = {
    selections: new Map(),
    snapshot: async () => {
      const writes = await page.evaluate(() => Number(localStorage.getItem('writes') || 0));
      const shown =
        writes === selectionWriteCount
          ? bounds
          : {
              x: bounds.x + 2,
              y: bounds.y + 2,
              width: bounds.width - 4,
              height: bounds.height - 4,
            };
      return { bounds: shown, hash: 'selected', bytes: await page.screenshot() };
    },
    readingMode: async () => page.keyboard.press('Escape'),
    validateBounds: () => {},
    reselectBounds: async () => {
      selectionWriteCount = await page.evaluate(() => Number(localStorage.getItem('writes') || 0));
      return a.objects.snapshot();
    },
    evidence: async () => ({}),
  };
  a.styles = {
    selection: async () => ({
      s: { ...(await a.objects.snapshot()), ...(grouped ? { region: { x: 0, y: 0 } } : {}) },
      view,
      page,
      fresh: await a.objects.snapshot(),
    }),
  };
  const controller = new ShapeStyleController(a),
    prepared = await controller.prepare({ selectionId: 'selected' });
  assert.deepEqual(prepared.state, { fillEnabled: false, fillOpacityPercent: 0, thicknessMm: 0.7 });
  assert.equal(await page.evaluate(() => localStorage.getItem('writes')), null);
  await assert.rejects(
    controller.apply({
      styleId: prepared.styleId,
      style: { fillOpacityPercent: 40 },
      operationId: 'shape-denied',
    }),
    (e) => e.code === 'WRITE_NOT_ALLOWED',
  );
  a.config.documents.push({ url, title: view.title });
  const args = {
    styleId: prepared.styleId,
    style: { fillOpacityPercent: 40, thicknessMm: 1.2 },
    operationId: 'shape-verified',
  };
  const result = await controller.apply(args);
  assert.equal(result.verified, true);
  assert.deepEqual(result.state, { fillEnabled: true, fillOpacityPercent: 40, thicknessMm: 1.2 });
  const current = await controller.prepare({ selectionId: 'selected' }),
    writes = await page.evaluate(() => localStorage.getItem('writes'));
  const noop = await controller.apply({
    styleId: current.styleId,
    style: { fillOpacityPercent: 40 },
    operationId: 'shape-no-change',
  });
  assert.equal(noop.changed, false);
  assert.equal(await page.evaluate(() => localStorage.getItem('writes')), writes);
  const again = await controller.apply({
    styleId: current.styleId,
    style: { fillOpacityPercent: 40 },
    operationId: 'shape-no-change',
  });
  assert.equal(again.replayed, true);
  await page.evaluate(() => {
    state.thicknessMm = 0.8;
    save();
  });
  await assert.rejects(
    controller.apply({
      styleId: current.styleId,
      style: { fillOpacityPercent: 20 },
      operationId: 'shape-stale-state',
    }),
    (e) => e.code === 'STYLE_CONFLICT' && !e.details.mayHaveWritten,
  );
  grouped = true;
  await assert.rejects(
    controller.prepare({ selectionId: 'selected' }),
    (e) => e.code === 'NOT_A_NATIVE_SHAPE',
  );
  grouped = false;
  await page.locator('#shared_menu_options_edit_shape').evaluate((e) => (e.hidden = true));
  await assert.rejects(
    controller.prepare({ selectionId: 'selected' }),
    (e) => e.code === 'NOT_A_NATIVE_SHAPE',
  );
  await page.locator('#shared_menu_options_edit_shape').evaluate((e) => (e.hidden = false));
  const clear = await controller.prepare({ selectionId: 'selected' });
  assert.equal(
    (
      await controller.apply({
        styleId: clear.styleId,
        style: { fillOpacityPercent: 0 },
        operationId: 'shape-clear-fill',
      })
    ).state.fillEnabled,
    false,
  );
  const lose = await controller.prepare({ selectionId: 'selected' });
  await page.evaluate(() => localStorage.setItem('drop', 'yes'));
  const lostArgs = {
    styleId: lose.styleId,
    style: { fillOpacityPercent: 80 },
    operationId: 'shape-lost-save',
  };
  await assert.rejects(
    controller.apply(lostArgs),
    (e) => e.code === 'SAVE_UNVERIFIED' && e.details.mayHaveWritten,
  );
  assert.equal((await a.journal.get('shape-lost-save')).status, 'uncertain');
  const beforeRetry = await page.evaluate(() => localStorage.getItem('writes'));
  await assert.rejects(controller.apply(lostArgs));
  assert.equal(await page.evaluate(() => localStorage.getItem('writes')), beforeRetry);
});
