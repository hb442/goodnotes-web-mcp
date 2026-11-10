import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { TextController } from '../../src/text.mjs';
import { Journal } from '../../src/journal.mjs';
import { readPlainText } from '../../src/rich-text.mjs';
test('created text is verified at its native page position after reload changes the notebook layout', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } }),
    page = await context.newPage(),
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-create-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const url = 'https://web.goodnotes.com/s/SyntheticCreate#page-1',
    documentUrl = url.split('#')[0],
    title = 'Fixture',
    pageId = '00000000-0000-4000-8000-000000000001';
  await context.route('https://web.goodnotes.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body:
        '<style>body{margin:0}#surface{position:absolute}</style><div id="interaction-layer-page-' +
        pageId +
        '" style="position:absolute;left:100px;top:50px;width:500px;height:700px"><div class="ql-editor" contenteditable="true" style="position:absolute;left:100px;top:100px;width:220px;min-height:30px"><p><br></p></div></div><script>const saved=localStorage.getItem("text");if(saved!==null){document.querySelector("[id]").style.cssText="position:absolute;left:220px;top:80px;width:750px;height:1050px";const e=document.querySelector(".ql-editor");e.style.left="150px";e.style.top="150px";e.style.transformOrigin="0 0";e.style.transform="scale(1.5)";e.querySelector("p").innerText=saved;}</script>',
    }),
  );
  await page.goto(url);
  let reads = 0;
  const view = {
      viewId: 'before',
      url: documentUrl,
      pageUrl: url,
      title,
      canvas: { x: 0, y: 0, width: 1280, height: 1000 },
    },
    a = {
      config: { directory, documents: [{ url: documentUrl, title }] },
      journal: new Journal(directory),
      getView: () => view,
      assertView: async () => page,
      selectEditor: async () => page.locator('.ql-editor'),
      resetOuterScroll: async () => {},
      leaveEditor: async () =>
        page.locator('.ql-editor').evaluate((e) => localStorage.setItem('text', e.innerText)),
      openDocument: async () => page,
      closePanels: async () => {},
      inspect: async () => ({ ...view, viewId: 'after' }),
      documents: { invalidate: async () => {} },
      readText: async ({ viewId, x, y }) => {
        reads++;
        assert.equal(viewId, 'after');
        const e = page.locator('.ql-editor'),
          b = await e.boundingBox();
        assert.ok(x * 1280 > b.x && x * 1280 < b.x + b.width);
        assert.ok(y * 1000 > b.y && y * 1000 < b.y + b.height);
        return { targetId: 'mapped', text: reads === 1 ? '' : await e.evaluate(readPlainText) };
      },
    };
  const result = await new TextController(a).create({
    viewId: 'before',
    x: 0.16,
    y: 0.16,
    text: 'Mapped text',
    operationId: 'mapped-create-001',
  });
  assert.equal(result.verified, true);
  assert.equal(result.targetId, 'mapped');
  assert.equal(reads, 2);
  assert.equal((await a.journal.get('mapped-create-001')).status, 'verified');
});
