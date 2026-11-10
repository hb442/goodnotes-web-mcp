import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PageController } from '../../src/pages.mjs';

test('page listing switches a remembered Outline sidebar tab before waiting for thumbnails', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(),
    c = new PageController({ closePanels: async () => {} });
  await page.setContent(
    `<button id="sidebarButton" onclick="document.getElementById('filterOptionNormal').hidden=false">Pages</button><button id="filterOptionNormal" hidden onclick="document.getElementById('thumbnailEditing_0').hidden=false">Thumbnails</button><button id="thumbnailEditing_0" hidden>First page</button>`,
  );
  await c.sidebar(page);
  assert.ok(await page.locator('#thumbnailEditing_0').isVisible());
});

test('page operations enter native editing mode once and respect an unavailable or disabled switch', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(),
    c = new PageController({});
  await page.setContent(
    `<button id="changeEditMode" onclick="window.toggles=(window.toggles||0)+1;document.getElementById('editorTopbarTools').hidden=false">Edit</button><div id="editorTopbarTools" hidden>Tools</div>`,
  );
  await c.editMode(page);
  await c.editMode(page);
  assert.equal(await page.evaluate(() => window.toggles), 1);
  await page.locator('#editorTopbarTools').evaluate((e) => (e.hidden = true));
  await page.locator('#changeEditMode').evaluate((e) => (e.disabled = true));
  await assert.rejects(c.editMode(page), (e) => e.code === 'EDIT_MODE_UNAVAILABLE');
  assert.equal(await page.evaluate(() => window.toggles), 1);
  await page.locator('#changeEditMode').evaluate((e) => e.remove());
  await assert.rejects(c.editMode(page), (e) => e.code === 'EDIT_MODE_UNAVAILABLE');
});
