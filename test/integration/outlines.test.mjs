import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { OutlineController } from '../../src/outlines.mjs';
import { PageController } from '../../src/pages.mjs';
import { Journal, digest } from '../../src/journal.mjs';
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(() => browser?.close());
const url = 'https://web.goodnotes.com/s/SyntheticOutlineFixture',
  title = 'Outline fixture',
  first = '00000000-0000-4000-8000-000000000001',
  second = '00000000-0000-4000-8000-000000000002',
  pageIds = ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012'];
const html = `<style>[hidden]{display:none!important}.row{display:flex;height:40px}.row>div{min-width:30px}#menu{position:absolute;left:300px;top:100px}input{display:block}</style>
<button id="infoButton">${title}</button><button id="changeEditMode" onclick="document.getElementById('editorTopbarTools').hidden=false">Edit</button><div id="editorTopbarTools" hidden>Tools</div><button id="filterOptionNormal">Pages</button><button id="filterOptionOutlines">Outlines</button><div id="rows"></div><div id="emptyOutlinesView" hidden>Empty</div>
<div id="menu" hidden><button id="outlineItemContextMenuRename">Rename</button><button id="outlineItemContextMenuDelete">Delete</button></div><input id="renameOutlineInput" hidden><button id="renameOutlineConfirmButton" hidden>Apply</button>
<script>
let entries=JSON.parse(localStorage.getItem('entries')||'null')||[{id:'${first}',title:'Alpha',page:1},{id:'${second}',title:'Beta',page:2}],active;
const el=id=>document.getElementById(id);
function render(){el('rows').replaceChildren();for(const entry of entries){const row=document.createElement('div');row.className='row';row.id='outlineItem-'+entry.id;const icon=document.createElement('div');icon.append(document.createElement('img'));const label=document.createElement('div');label.textContent=entry.title;const number=document.createElement('div');number.textContent='p. '+entry.page;row.append(icon,label,number);row.oncontextmenu=e=>{e.preventDefault();active=entry.id;el('menu').hidden=false;};el('rows').append(row);}el('emptyOutlinesView').hidden=!!entries.length;}
function save(){localStorage.setItem('writes',String(Number(localStorage.getItem('writes')||0)+1));if(!localStorage.getItem('lost-save'))localStorage.setItem('entries',JSON.stringify(entries));render();}
el('outlineItemContextMenuRename').onclick=()=>{el('renameOutlineInput').value=entries.find(e=>e.id===active).title;el('renameOutlineInput').hidden=false;el('renameOutlineConfirmButton').hidden=false;el('menu').hidden=true;};
el('renameOutlineConfirmButton').onclick=()=>{entries.find(e=>e.id===active).title=el('renameOutlineInput').value;save();el('renameOutlineInput').hidden=true;el('renameOutlineConfirmButton').hidden=true;};
el('outlineItemContextMenuDelete').onclick=()=>{entries=entries.filter(e=>e.id!==active);save();el('menu').hidden=true;};render();
</script>`;
async function fixture(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.route('https://web.goodnotes.com/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: html }),
  );
  const page = await context.newPage(),
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-outline-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const a = {
    config: { directory, documents: [{ url, title }] },
    journal: new Journal(directory),
    getPage: async () => page,
    openDocument: async () => {
      if (page.url() !== url) await page.goto(url);
      return page;
    },
    invalidate: () => {},
    documents: { invalidate: async () => {} },
    pages: {
      sidebar: async () => {},
      snapshot: async () => ({
        count: 2,
        pages: pageIds.map((id) => ({ id })),
        orderHash: digest(pageIds),
      }),
      editMode: (p) => PageController.prototype.editMode(p),
    },
  };
  return { page, a, c: new OutlineController(a) };
}
function args(listed, operationId, command = 'rename') {
  return {
    url,
    outlineId: first,
    expectedTitle: 'Alpha',
    expectedOutlineHash: listed.outlineHash,
    expectedPageOrderHash: listed.pageOrderHash,
    command,
    ...(command === 'rename' ? { title: 'Renamed' } : {}),
    operationId,
  };
}
test('outline listing paginates, guarded rename/delete preserve other entries and native pages, and verified writes do not replay', async (t) => {
  const { page, a, c } = await fixture(t),
    listed = await c.list({ url, limit: 1 });
  assert.equal(listed.count, 2);
  assert.equal(listed.nextOffset, 1);
  assert.equal(listed.entries[0].pageId, pageIds[0]);
  assert.equal(listed.entries[0].flat, true);
  await page
    .locator('#outlineItem-' + first + ' > div')
    .first()
    .evaluate((e) => (e.innerHTML = '<div class=loading></div>'));
  const loading = await c.list({ url });
  assert.equal(loading.outlineHash, listed.outlineHash);
  assert.equal(loading.entries[0].flat, true);
  assert.equal((await c.list({ url, offset: 1 })).entries[0].title, 'Beta');
  const input = args(listed, 'outline-rename-001'),
    renamed = await c.manage(input);
  assert.equal(renamed.verified, true);
  assert.equal((await c.manage(input)).verified, true);
  assert.equal(await page.evaluate(() => localStorage.getItem('writes')), '1');
  const updated = await c.list({ url });
  assert.deepEqual(
    updated.entries.map((e) => e.title),
    ['Renamed', 'Beta'],
  );
  const deleted = await c.manage({
    ...args(updated, 'outline-delete-001', 'delete'),
    expectedTitle: 'Renamed',
  });
  assert.equal(deleted.verified, true);
  assert.deepEqual(
    (await c.list({ url })).entries.map((e) => e.id),
    [second],
  );
  assert.equal(deleted.pageOrderHash, listed.pageOrderHash);
  const checkpoint = JSON.parse(
    await fs.readFile(
      path.join(a.config.directory, 'outline-checkpoints', 'outline-delete-001.json'),
      'utf8',
    ),
  );
  assert.equal(checkpoint.entries[0].title, 'Renamed');
  assert.equal((await a.journal.get('outline-delete-001')).status, 'verified');
});
test('outline writes reject unauthorized, stale and nested rows before input; a lost save stays uncertain', async (t) => {
  const { page, a, c } = await fixture(t),
    listed = await c.list({ url });
  a.config.documents = [];
  await assert.rejects(
    c.manage(args(listed, 'outline-denied-001')),
    (e) => e.code === 'WRITE_NOT_ALLOWED' && !e.details.mayHaveWritten,
  );
  a.config.documents = [{ url, title }];
  await assert.rejects(
    c.manage({ ...args(listed, 'outline-stale-001'), expectedOutlineHash: 'x'.repeat(64) }),
    (e) => e.code === 'OUTLINE_CONFLICT',
  );
  await page
    .locator('#outlineItem-' + first + ' > div')
    .first()
    .evaluate((e) => (e.innerHTML = '<button>Expand</button>'));
  const nested = await c.list({ url });
  await assert.rejects(
    c.manage(args(nested, 'outline-nested-001')),
    (e) => e.code === 'OUTLINE_STRUCTURE_UNSUPPORTED',
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('writes')), null);
  await page.reload();
  const current = await c.list({ url });
  await page.evaluate(() => localStorage.setItem('lost-save', 'true'));
  await assert.rejects(
    c.manage(args(current, 'outline-lost-001')),
    (e) => e.code === 'SAVE_UNVERIFIED' && e.details.mayHaveWritten,
  );
  assert.equal((await a.journal.get('outline-lost-001')).status, 'uncertain');
  await assert.rejects(c.manage(args(current, 'outline-lost-001')), /automatic replay is blocked/);
  assert.equal(await page.evaluate(() => localStorage.getItem('writes')), '1');
});
