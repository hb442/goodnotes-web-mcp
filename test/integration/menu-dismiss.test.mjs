import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { dismissFloatingMenu } from '../../src/ui-menu.mjs';
import { StyleController } from '../../src/styles.mjs';
import { TextController } from '../../src/text.mjs';

test('dismissal avoids an overlapping menu and does not select a formatting command', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.setContent(
    `<div data-testid="edit_menu_floating_menu_dismiss" style="position:fixed;inset:100px 100px 50px 100px"></div><div id="menu" style="position:fixed;left:100px;top:100px;width:400px;height:400px;background:white"><button id="mutation">Border Color</button></div><script>window.writes=0;document.querySelector('#mutation').onclick=()=>writes++;document.querySelector('[data-testid]').onclick=()=>{document.querySelector('#menu').hidden=true;document.querySelector('[data-testid]').hidden=true}</script>`,
  );
  await dismissFloatingMenu(page, page.locator('#menu'));
  assert.equal(await page.locator('#menu').isVisible(), false);
  assert.equal(await page.evaluate(() => writes), 0);
});

test('dismissal reacquires the overlay when a nested menu consumes its first click', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    `<div data-testid="edit_menu_floating_menu_dismiss" style="position:fixed;inset:0"></div><div id="menu" style="position:fixed;left:100px;top:100px;width:200px;height:200px;background:white"><button id="mutation">Style</button></div><script>window.dismissals=0;window.writes=0;document.querySelector('#mutation').onclick=()=>writes++;document.querySelector('[data-testid]').onclick=()=>{if(++dismissals===2){document.querySelector('#menu').hidden=true;document.querySelector('[data-testid]').hidden=true}}</script>`,
  );
  await dismissFloatingMenu(page, page.locator('#menu'));
  assert.equal(await page.locator('#menu').isVisible(), false);
  assert.equal(await page.evaluate(() => dismissals), 2);
  assert.equal(await page.evaluate(() => writes), 0);
});

test('a newly added but unapplied custom swatch is selected once, while an applied one is not repeated', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    `<div id="color"><button id="colorAddColor">Add</button><input id="colorCustomColorInput"><button id="colorCommitColorChange">Save</button></div><script>window.applies=0;window.automatic=false;document.querySelector('#colorCommitColorChange').onclick=()=>{const b=document.createElement('button');b.dataset.colorValue=document.querySelector('input').value;b.setAttribute('aria-selected',String(automatic));b.textContent='Color';b.onclick=()=>{applies++;b.setAttribute('aria-selected','true')};document.querySelector('#color').append(b);if(automatic)applies++}</script>`,
  );
  const controller = new StyleController({});
  await controller.chooseColor(
    page,
    { selector: '#color', colors: [], customSupported: true },
    '#123456',
    () => {},
  );
  assert.equal(await page.evaluate(() => applies), 1);
  await page.evaluate(() => (automatic = true));
  await controller.chooseColor(
    page,
    { selector: '#color', colors: [], customSupported: true },
    '#234567',
    () => {},
  );
  assert.equal(await page.evaluate(() => applies), 2);
});

test('combined color and bold reacquire selection and wait for native rendering without repeating color', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(
    '<div id="editor" contenteditable="true"><p><span>Delayed color</span></p></div><button id="shared_menu_floating_toggle_bold" onmousedown="event.preventDefault()" onclick="document.execCommand(\'bold\');this.hidden=true">Bold</button>',
  );
  let writes = 0;
  const a = {
    styles: {
      openPalette: async () => ({}),
      closePalette: async () => {},
      chooseColor: async () => {
        writes++;
        await page.evaluate(() => {
          window.getSelection().removeAllRanges();
          setTimeout(() => (document.querySelector('#editor span').style.color = '#123456'), 350);
        });
      },
    },
  };
  const text = new TextController(a);
  await text.applyFormat(
    page,
    page.locator('#editor'),
    { start: 0, end: 13, format: { color: 'rgb(18, 52, 86)', bold: true } },
    () => {},
  );
  assert.equal(writes, 1);
  a.styles.chooseColor = async () => {
    writes++;
  };
  await assert.rejects(
    text.applyFormat(
      page,
      page.locator('#editor'),
      { start: 0, end: 13, format: { color: 'rgb(1, 2, 3)' } },
      () => {},
    ),
    (e) => e.code === 'FORMAT_UNVERIFIED',
  );
  assert.equal(writes, 2);
});
