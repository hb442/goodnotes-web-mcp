import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FolderStyleController } from '../../src/folder-style.mjs';
import { authorizeFolder } from '../../src/folders.mjs';
import { Journal } from '../../src/journal.mjs';
const id = '00000000-0000-4000-8000-000000000001';
const html = `<div data-document-id="${id}"><button id="menu">Folder</button><button id="libraryDocumentFolderFavorited_${id}_false">Favorite</button><div data-testid="libraryDocumentFolderSymbol_none"></div></div><script>
let state=JSON.parse(localStorage.getItem('style')||'{"color":"#45bfdb","icon":"none","favorite":false}');
const card=document.querySelector('[data-document-id]');
function render(){card.querySelector('[id^="libraryDocumentFolderFavorited_"]').id='libraryDocumentFolderFavorited_${id}_'+state.favorite;card.querySelector('[data-testid]').dataset.testid='libraryDocumentFolderSymbol_'+state.icon;}
function save(){render();if(!localStorage.getItem('drop'))localStorage.setItem('style',JSON.stringify(state));}
render();card.querySelector('[id^="libraryDocumentFolderFavorited_"]').onclick=()=>{state.favorite=!state.favorite;save()};
let popup,dirty=false;function close(){if(dirty){save();dirty=false;}popup?.remove();}document.onkeydown=e=>{if(e.key==='Escape')close()};
function container(id){close();popup=document.createElement('div');popup.id=id;document.body.append(popup);return popup;}
function button(id,text,fn,parent=popup){const b=document.createElement('button');b.id=id;b.textContent=text;b.onclick=fn;parent.append(b);return b;}
document.querySelector('#menu').onclick=()=>{container('actions');button('libraryFolderCustomizeColorMenuItemId','Color',()=>{
container('libraryFolderCustomizeColorPopoverId');const c=button('preset','Preset',()=>{});c.dataset.colorValue='#45bfdb';
button('libraryFolderStylizeMenuCustomColorCustomTabButtonId','Custom',()=>{const input=document.createElement('input');input.dataset.testid='colorPickerInput';input.value=state.color;popup.append(input);button('confirm','Confirm',()=>{state.color=input.value;save();close()})});
});button('libraryFolderSetIconMenuItemId','Icon',()=>{container('libraryFolderCustomizeSymbolPopoverId');for(const icon of ['none','book'])button('libraryFolderStylizeMenuColorOption_'+icon,icon,()=>{state.icon=icon;render();dirty=true;});});};
</script>`;
test('folder appearance uses native state guards and verifies color, icon and favorite across reload', async (t) => {
  const browser = await chromium.launch({ headless: true }),
    context = await browser.newContext(),
    page = await context.newPage(),
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-folder-style-'));
  t.after(async () => {
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await page.route('https://fixture.test/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: html }),
  );
  let opens = 0;
  const a = {
    config: { directory },
    journal: new Journal(directory),
    invalidate: () => {},
    getPage: async () => page,
    library: {
      folder: async () => {
        opens++;
        await page.goto('https://fixture.test/');
        return { page, listing: { items: [{ id, title: 'Folder', kind: 'folder' }] } };
      },
      card: async () => page.locator('[data-document-id]'),
      menu: async () => page.locator('#menu').click(),
    },
  };
  const c = new FolderStyleController(a),
    base = { itemPath: [id], expectedTitle: 'Folder' };
  await assert.rejects(
    c.set({
      ...base,
      property: 'favorite',
      value: true,
      expectedValue: false,
      operationId: 'folder-style-denied',
    }),
    (e) => e.code === 'FOLDER_WRITE_NOT_ALLOWED' && !e.details.mayHaveWritten,
  );
  assert.equal(opens, 0);
  await authorizeFolder(directory, [id], 'Folder');
  const read = await c.inspect({ ...base, includeChoices: true });
  assert.deepEqual(read.state, { favorite: false, icon: 'none', color: '#45bfdb' });
  assert.deepEqual(read.icons, ['none', 'book']);
  await assert.rejects(
    c.set({
      ...base,
      property: 'favorite',
      value: false,
      expectedValue: true,
      operationId: 'folder-style-conflict',
    }),
    (e) => e.code === 'FOLDER_STYLE_CONFLICT' && !e.details.mayHaveWritten,
  );
  for (const [property, value, expectedValue] of [
    ['favorite', true, false],
    ['color', '#aabbcc', '#45bfdb'],
    ['icon', 'book', 'none'],
  ]) {
    const result = await c.set({
      ...base,
      property,
      value,
      expectedValue,
      operationId: 'folder-style-' + property,
    });
    assert.equal(result.verified, true);
    assert.equal(result.state[property], value);
  }
  assert.deepEqual((await c.inspect(base)).state, {
    favorite: true,
    color: '#aabbcc',
    icon: 'book',
  });
  await assert.rejects(
    c.set({
      ...base,
      property: 'icon',
      value: 'missing',
      expectedValue: 'book',
      operationId: 'folder-icon-missing',
    }),
    (e) => e.code === 'ICON_UNAVAILABLE' && !e.details.mayHaveWritten,
  );
  await page.evaluate(() => localStorage.setItem('drop', '1'));
  await assert.rejects(
    c.set({
      ...base,
      property: 'favorite',
      value: false,
      expectedValue: true,
      operationId: 'folder-style-unsaved',
    }),
    (e) => e.code === 'SAVE_UNVERIFIED' && e.details.mayHaveWritten,
  );
  assert.equal((await a.journal.get('folder-style-unsaved')).status, 'uncertain');
  await assert.rejects(
    c.set({
      ...base,
      property: 'favorite',
      value: false,
      expectedValue: true,
      operationId: 'folder-style-unsaved',
    }),
  );
});
