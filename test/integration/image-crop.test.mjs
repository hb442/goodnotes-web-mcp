import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createCanvas } from '@napi-rs/canvas';
import {
  readCrop,
  positionCrop,
  ImageCropController,
  validateCrop,
} from '../../src/image-crop.mjs';

test('native crop reads full source, maps scaled handles, cancels drafts and rejects invalid regions', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const c = createCanvas(800, 480),
    ctx = c.getContext('2d');
  ctx.fillStyle = '#c04020';
  ctx.fillRect(0, 0, 800, 480);
  const html = `<button id="shared_menu_options_crop_image">Crop</button><div id="cropModal" style="display:none"><button id="cropModalRectangleToggle">Rectangle</button><div style="position:relative;left:100px;top:60px;width:400px;height:240px"><img alt="Crop preview" width="400" height="240" src="${c.toDataURL()}"><div id="rect" style="position:absolute;border:0;left:0;top:0;width:400px;height:240px"><div data-testid="crop-rectangle-top-left-handle" style="position:absolute;left:-4px;top:-4px;width:10px;height:10px;background:black"></div><div data-testid="crop-rectangle-bottom-right-handle" style="position:absolute;right:-6px;bottom:-6px;width:10px;height:10px;background:black"></div></div></div><button id="cropModalCancelButton">Cancel</button><button id="cropModalDoneButton">Done</button></div><script>
 let saved={x:0,y:0,width:400,height:240},draft={...saved},drag=null;window.saves=0;
 const modal=document.querySelector('#cropModal'),rect=document.querySelector('#rect');function render(){Object.assign(rect.style,{left:draft.x+'px',top:draft.y+'px',width:draft.width+'px',height:draft.height+'px'});}
 document.querySelector('#shared_menu_options_crop_image').onclick=()=>{draft={...saved};render();modal.style.display='block'};
 document.querySelector('#cropModalCancelButton').onclick=()=>modal.style.display='none';
 document.querySelector('#cropModalDoneButton').onclick=()=>{saved={...draft};window.saves++;modal.style.display='none'};
 document.querySelectorAll('[data-testid]').forEach(h=>h.onpointerdown=e=>{e.preventDefault();h.setPointerCapture(e.pointerId);drag={tl:h.dataset.testid.includes('top-left'),start:{...draft},x:e.clientX,y:e.clientY}});
 document.onpointermove=e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y,s=drag.start;draft=drag.tl?{x:s.x+dx,y:s.y+dy,width:s.width-dx,height:s.height-dy}:{...s,width:s.width+dx,height:s.height+dy};render()};document.onpointerup=()=>drag=null;
 </script>`;
  await page.setContent(html);
  const controller = new ImageCropController({});
  await controller.open(page);
  const initial = await readCrop(page);
  assert.deepEqual(initial.region, { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(initial.size, { width: 800, height: 480 });
  assert.ok(initial.sourceBytes.length > 0);
  const drag = async (p, from, to) => {
    await p.mouse.move(from.x, from.y);
    await p.mouse.down();
    await p.mouse.move(to.x, to.y, { steps: 5 });
    await p.mouse.up();
  };
  const region = { x: 0.2, y: 0.25, width: 0.6, height: 0.5 },
    draft = await positionCrop(page, region, drag);
  assert.deepEqual(draft.region, region);
  assert.equal((await readCrop(page)).sourceSha256, initial.sourceSha256);
  assert.equal(await page.evaluate(() => window.saves), 0);
  await controller.cancel(page);
  await controller.open(page);
  assert.deepEqual((await readCrop(page)).region, initial.region);
  await assert.rejects(
    positionCrop(page, { x: 0, y: 0, width: 0.01, height: 0.1 }, drag),
    (e) => e.code === 'CROP_TOO_SMALL',
  );
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(positionCrop(page, region, drag, { signal: ac.signal }));
  assert.equal(await page.evaluate(() => window.saves), 0);
  for (const value of [
    { x: -0.1, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0.8, y: 0, width: 0.3, height: 1 },
    { x: NaN, y: 0, width: 1, height: 1 },
  ])
    assert.throws(
      () => validateCrop(value),
      (e) => e.code === 'INVALID_CROP',
    );
  await positionCrop(page, region, drag);
  await page.locator('#cropModalDoneButton').click();
  await controller.open(page);
  assert.deepEqual((await readCrop(page)).region, region);
  assert.equal(await page.evaluate(() => window.saves), 1);
  await positionCrop(page, { x: 0, y: 0, width: 1, height: 1 }, drag);
  assert.deepEqual((await readCrop(page)).region, initial.region);
  await controller.cancel(page);
});
