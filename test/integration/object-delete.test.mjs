import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { ObjectController } from '../../src/objects.mjs';
import { Journal } from '../../src/journal.mjs';
import { regionHash } from '../../src/visual.mjs';

const url = 'https://fixture.test/delete',
  bounds = { x: 200, y: 200, width: 200, height: 100 };
const html = `<style>body{margin:0;background:white}#object{position:absolute;left:200px;top:200px;width:200px;height:100px;background:#eaaf00;box-sizing:border-box;color:black;font:24px Arial;padding:20px}.selected{outline:2px solid blue}#shared_menu_main_view{position:absolute;left:200px;top:150px}</style><div id="object" class="selected">DELETE ME</div><div id="shared_menu_main_view"><button id="shared_menu_options_delete">Delete</button></div><script>
const object=document.querySelector('#object'),menu=document.querySelector('#shared_menu_main_view');
if(localStorage.getItem('deleted'))object.hidden=true;
document.querySelector('button').onclick=()=>{window.deletes=(window.deletes||0)+1;if(!localStorage.getItem('noop')){object.hidden=true;if(!localStorage.getItem('drop'))localStorage.setItem('deleted','yes');}object.classList.remove('selected');menu.hidden=true;};
</script>`;
test('object deletion rejects a no-op click and lost persistence, then verifies real content removal without selection overlays', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-delete-')),
    browser = await chromium.launch({ headless: true }),
    page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  t.after(async () => {
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await page.route('https://fixture.test/**', (r) =>
    r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }),
  );
  await page.goto(url);
  const view = {
      viewId: 'view',
      url,
      pageUrl: url,
      title: 'Fixture',
      viewport: { width: 900, height: 700 },
      canvas: { x: 0, y: 0, width: 900, height: 700 },
    },
    a = {
      config: { directory, documents: [{ url, title: 'Fixture' }] },
      journal: new Journal(directory),
      getView: () => view,
      assertView: async () => page,
      openDocument: async () => page,
      closePanels: async () => {},
      documents: { invalidate: async () => {} },
    },
    c = new ObjectController(a);
  c.snapshot = async () => {
    const bytes = await page.screenshot();
    return { bounds, bytes, hash: await regionHash(bytes, bounds) };
  };
  c.readingMode = c.commitSelection = async () =>
    page.evaluate(() => {
      document.querySelector('#object').classList.remove('selected');
      document.querySelector('#shared_menu_main_view').hidden = true;
    });
  c.reselectBounds = async () => {
    await page.evaluate(() => {
      document.querySelector('#object').classList.add('selected');
      document.querySelector('#shared_menu_main_view').hidden = false;
    });
    return c.snapshot();
  };
  const select = async () => {
    await c.reselectBounds();
    c.selections.set('selected', { ...(await c.snapshot()), viewId: 'view', created: Date.now() });
  };
  await page.evaluate(() => localStorage.setItem('noop', 'yes'));
  await select();
  await assert.rejects(
    c.transform({ selectionId: 'selected', action: 'delete', operationId: 'delete-native-noop' }),
    (e) => e.code === 'DELETE_UNVERIFIED' && e.details.mayHaveWritten,
  );
  assert.equal(await page.locator('#object').isVisible(), true);
  assert.equal((await a.journal.get('delete-native-noop')).status, 'uncertain');
  await page.evaluate(() => {
    localStorage.removeItem('noop');
    localStorage.setItem('drop', 'yes');
  });
  await select();
  await assert.rejects(
    c.transform({
      selectionId: 'selected',
      action: 'delete',
      operationId: 'delete-native-unsaved',
    }),
    (e) => e.code === 'DELETE_UNVERIFIED' && e.details.mayHaveWritten,
  );
  assert.equal(await page.locator('#object').isVisible(), true);
  await page.evaluate(() => localStorage.removeItem('drop'));
  await select();
  const result = await c.transform({
    selectionId: 'selected',
    action: 'delete',
    operationId: 'delete-native-verified',
  });
  assert.equal(result.verified, true);
  assert.equal(result.appearance.matches, true);
  assert.equal(await page.locator('#object').isVisible(), false);
  assert.equal(
    result.verification,
    'native-delete-unselected-content-change-and-reload-appearance',
  );
});
