import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TextBoxStyleController, normalizeBoxStyle } from '../../src/text-box-style.mjs';
import { Journal } from '../../src/journal.mjs';
const url = 'https://fixture.test/box',
  pageId = '00000000-0000-4000-8000-000000000099';
const html = `<style>body{margin:0;font-family:Arial}#native-box{position:absolute;left:200px;top:160px;width:260px}p{margin:0}.ql-editor{font-size:20px;text-align:left}#objectFloatingMenu{position:absolute;left:700px;top:100px;background:white;padding:12px}</style><div id="interaction-layer-page-${pageId}" style="position:absolute;left:0;top:0;width:1200px;height:800px"></div><div id="native-box"><div class="ql-editor"><p>KEEP THIS TEXT</p></div></div><button id="shared_menu_text_box_style" style="position:absolute;left:20px;top:20px">Style</button><div id="objectFloatingMenu" style="display:none"></div><script>
 let state=JSON.parse(localStorage.getItem('boxStyle')||'{"roundCornerPt":0,"borderPt":0,"paddingPt":5,"shadow":false,"backgroundColor":"none","borderColor":"none"}');const menu=document.querySelector('#objectFloatingMenu'),box=document.querySelector('#native-box');window.writes=0;
 function draw(){Object.assign(box.style,{padding:state.paddingPt+'px',borderRadius:state.roundCornerPt+'px',borderWidth:state.borderPt+'px',borderStyle:'solid',borderColor:state.borderColor==='none'?'transparent':state.borderColor,background:state.backgroundColor==='none'?'transparent':state.backgroundColor,boxShadow:state.shadow?'2px 2px 3px #888':'none'});}
 function save(){window.writes++;localStorage.setItem('totalWrites',Number(localStorage.getItem('totalWrites')||0)+1);draw();if(!localStorage.getItem('drop'))localStorage.setItem('boxStyle',JSON.stringify(state));}
 function b(parent,label,fn){const e=document.createElement('button');e.textContent=label;e.onclick=fn;parent.append(e);return e;}
 function render(){menu.innerHTML='<div id="object_text_box_style_floating_menu"><button>Presets</button><button>Advanced</button></div>';const panel=menu.firstChild;
 for(const [key,label] of Object.entries({backgroundColor:'Background Color',borderColor:'Border Color'})){const row=document.createElement('div'),p=document.createElement('p');p.textContent=label;row.append(p);b(row,state[key]==='none'?'None ›':'Color ›',()=>picker(key,label));panel.append(row);}
 for(const [key,label] of Object.entries({roundCornerPt:'Round Corner',borderPt:'Border',paddingPt:'Padding'})){const row=document.createElement('div'),p=document.createElement('p');p.textContent=state[key]+' pt '+label;row.append(p);for(const direction of [-1,1])b(row,direction<0?'-':'+',()=>{state[key]+=direction;save();render()}).disabled=direction<0&&state[key]===0;panel.append(row);}
 const shadow=b(panel,'Shadow',()=>{state.shadow=!state.shadow;save();render()});shadow.id='object_text_box_style_shadow';shadow.setAttribute('role','switch');shadow.setAttribute('aria-checked',state.shadow);
 }
 function picker(key,label){menu.innerHTML='';b(menu,'Back',render).setAttribute('aria-label','Back');const input=document.createElement('input');input.dataset.testid='colorPickerInput';input.value=state[key]==='none'?'#000000':state[key];input.onkeydown=e=>{if(e.key==='Enter'){state[key]=input.value.toLowerCase();save()}};menu.append(input);b(menu,'Delete',()=>{state[key]='none';save();render()}).setAttribute('aria-label','Delete');}
 document.querySelector('#shared_menu_text_box_style').onclick=()=>{menu.style.display='block';render()};document.onkeydown=e=>{if(e.key==='Escape')menu.style.display='none'};draw();
 </script>`;
test('whiteboard without native text-box style reports unsupported with zero changes', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  let exposeStyle = false,
    reloadTint = false;
  await page.route(url, (r) =>
    r.fulfill({
      body:
        html +
        `<script>document.querySelector('[id^="interaction-layer-page-"]').style.cssText='position:absolute;width:100000px;height:100000px';if(!${exposeStyle})document.querySelector('#shared_menu_text_box_style').remove();if(${reloadTint})document.querySelector('#native-box').style.background='#ff0000';const info=document.createElement('span');info.id='infoButton';info.textContent='Fixture';document.body.append(info);const handle=document.createElement('div');handle.id='transient-handle';handle.style.cssText='position:absolute;left:200px;top:170px;width:8px;height:8px;background:blue';document.body.append(handle);</script>`,
      contentType: 'text/html; charset=utf-8',
    }),
  );
  await page.goto(url);
  await page.locator('[id^="interaction-layer-page-"]').evaluate((e) => {
    e.style.width = '100000px';
    e.style.height = '100000px';
  });
  const bounds = await page.locator('#native-box').boundingBox();
  let selections = 0;
  const view = {
    viewId: 'view',
    url,
    pageUrl: url,
    title: 'Fixture',
    viewport: { width: 1200, height: 800 },
    canvas: { x: 0, y: 0, width: 1200, height: 800 },
  };
  const a = {
    views: new Map(),
    openDocument: async () => page,
    closePanels: async () => {},
    assertView: async () => page,
    scans: { position: async () => ({ view }) },
    styles: {
      selection: async () => ({
        page,
        view,
        s: {
          kind: 'text-box',
          bounds,
          hash: String(await page.evaluate(() => performance.timeOrigin)),
          bytes: await page.screenshot(),
        },
      }),
    },
    objects: {
      readingMode: async () => {
        await page.locator('#transient-handle').evaluate((e) => (e.hidden = true));
      },
      select: async () => {
        selections++;
        await page.locator('#transient-handle').evaluate((e, count) => {
          e.hidden = false;
          e.style.height = count % 2 ? '20px' : '8px';
        }, selections);
        return { selectionId: 'selected', bounds };
      },
    },
    text: { closeMenu: async () => page.keyboard.press('Escape') },
  };
  const controller = new TextBoxStyleController(a);
  const result = await controller.prepare({ selectionId: 'selected' });
  assert.equal(result.supported, false);
  assert.equal(result.changed, false);
  assert.equal(result.text, 'KEEP THIS TEXT');
  assert.equal(result.styleId, undefined);
  assert.equal(controller.preparations.size, 0);
  assert.equal(selections, 1);
  assert.equal(await page.evaluate(() => window.writes), 0);
  // A reduced context menu may omit both Format and Text Box Style.
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'object_menu_context_menu_option';
    button.textContent = 'More';
    button.style.cssText = 'position:fixed;z-index:10;left:700px;top:20px';
    document.body.append(button);
    const menu = document.createElement('div');
    menu.id = 'object_context_menu';
    document.body.append(menu);
  });
  const reduced = await controller.prepare({ selectionId: 'selected' });
  assert.equal(reduced.supported, false);
  assert.equal(await page.evaluate(() => window.writes), 0);
  exposeStyle = true;
  const recovered = await controller.prepare({ selectionId: 'selected' });
  assert.equal(recovered.supported, true);
  assert.equal(recovered.text, 'KEEP THIS TEXT');
  assert.equal(await page.evaluate(() => window.writes), 0);
  // Selection UI may change; actual box appearance may not.
  reloadTint = true;
  await page.locator('#shared_menu_text_box_style').evaluate((e) => e.remove());
  await assert.rejects(
    controller.prepare({ selectionId: 'selected' }),
    (error) => error.code === 'SELECTION_CHANGED' && error.details.exactText,
  );
  assert.equal(await page.evaluate(() => window.writes), 0);
});

test('text-box styling preserves text, reads native settings after reload, and stops on conflicts or lost saves', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-box-style-')),
    browser = await chromium.launch({ headless: true }),
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  t.after(async () => {
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await page.route('https://fixture.test/**', (r) =>
    r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }),
  );
  await page.goto(url);
  let missingToolbarLoads = 0,
    toolbarMissing = false;
  const reloadWriteCounts = [];
  const view = {
      viewId: 'view',
      url,
      pageUrl: url,
      title: 'Fixture',
      canvas: { x: 0, y: 0, width: 1200, height: 800 },
    },
    a = {
      config: { directory, documents: [] },
      journal: new Journal(directory),
      text: { closeMenu: async (p) => p.keyboard.press('Escape') },
      documents: { invalidate: async () => {} },
      inspect: async () => {
        toolbarMissing = missingToolbarLoads-- > 0;
        await page
          .locator('#shared_menu_text_box_style')
          .evaluate((e, hidden) => (e.hidden = hidden), toolbarMissing);
        reloadWriteCounts.push(
          await page.evaluate(() => Number(localStorage.getItem('totalWrites') || 0)),
        );
        return view;
      },
    };
  a.objects = {
    snapshot: async () => ({
      bounds: await page.locator('#native-box').boundingBox(),
      hash: 'selected',
      bytes: await page.screenshot(),
    }),
    validateBounds: () => {},
    readingMode: async () => page.keyboard.press('Escape'),
    select: async () => {
      await page
        .locator('#shared_menu_text_box_style')
        .evaluate((e, hidden) => (e.hidden = hidden), toolbarMissing);
      return { selectionId: 'selected', bounds: await page.locator('#native-box').boundingBox() };
    },
    evidence: async () => ({}),
  };
  a.styles = {
    selection: async () => ({
      s: { kind: 'text-box', ...(await a.objects.snapshot()) },
      view,
      page,
      fresh: await a.objects.snapshot(),
    }),
  };
  const controller = new TextBoxStyleController(a);
  // Native text can be ready before optional style entries. Reacquiring must
  // remain a read and preserve the original selection/content guards.
  await page.locator('#shared_menu_text_box_style').evaluate((e) => (e.hidden = true));
  const prepared = await controller.prepare({ selectionId: 'selected' });
  assert.equal(prepared.text, 'KEEP THIS TEXT');
  assert.equal(await page.evaluate(() => window.writes), 0);
  await assert.rejects(
    controller.apply({
      styleId: prepared.styleId,
      style: { shadow: true },
      operationId: 'box-denied',
    }),
    (e) => e.code === 'WRITE_NOT_ALLOWED',
  );
  a.config.documents.push({ url, title: view.title });
  missingToolbarLoads = 1;
  const patch = {
      backgroundColor: '#ffe3b0',
      borderColor: '#873783',
      roundCornerPt: 6,
      borderPt: 2,
      paddingPt: 9,
      shadow: true,
    },
    result = await controller.apply({
      styleId: prepared.styleId,
      style: patch,
      operationId: 'box-style-verified',
    });
  assert.equal(result.verified, true);
  assert.equal(reloadWriteCounts.length, 2);
  assert.equal(reloadWriteCounts[0], reloadWriteCounts[1]);
  assert.ok(reloadWriteCounts[0] > 0);
  assert.deepEqual(result.state, {
    roundCornerPt: 6,
    borderPt: 2,
    paddingPt: 9,
    shadow: true,
    backgroundColor: '#ffe3b0',
    borderColor: '#873783',
  });
  const again = await controller.prepare({ selectionId: 'selected' });
  await page.evaluate(() => {
    state.shadow = false;
    save();
  });
  await assert.rejects(
    controller.apply({
      styleId: again.styleId,
      style: { shadow: false },
      operationId: 'box-conflict',
    }),
    (e) => e.code === 'STYLE_CONFLICT' && !e.details.mayHaveWritten,
  );
  const beforeDrop = await controller.prepare({ selectionId: 'selected' });
  await page.evaluate(() => localStorage.setItem('drop', 'yes'));
  await assert.rejects(
    controller.apply({
      styleId: beforeDrop.styleId,
      style: { backgroundColor: '#774422' },
      operationId: 'box-unsaved',
    }),
    (e) => e.code === 'SAVE_UNVERIFIED' && e.details.mayHaveWritten,
  );
  assert.equal((await a.journal.get('box-unsaved')).status, 'uncertain');
  await page.evaluate(() => localStorage.removeItem('drop'));
  const clear = await controller.prepare({ selectionId: 'selected' }),
    cleared = await controller.apply({
      styleId: clear.styleId,
      style: { backgroundColor: 'none', borderColor: 'none', borderPt: 0 },
      operationId: 'box-clear-colors',
    });
  assert.equal(cleared.verified, true);
  assert.equal(cleared.state.backgroundColor, 'none');
  assert.equal(cleared.state.borderColor, 'none');
  for (const patch of [
    {},
    { paddingPt: 31 },
    { roundCornerPt: -1 },
    { borderPt: 13 },
    { shadow: 'true' },
    { backgroundColor: 'red' },
    { constructor: 'bad' },
  ])
    assert.throws(() => normalizeBoxStyle(patch));
});
