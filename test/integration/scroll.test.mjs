import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { collectScrollList } from '../../src/scroll-list.mjs';
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: true });
});
after(() => browser?.close());
async function fixture(t) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent(
    '<div id="list" style="height:120px;overflow:auto"><div style="height:1000px;position:relative" id="rows"></div></div>',
  );
  await page.evaluate(() => {
    const list = document.getElementById('list'),
      rows = document.getElementById('rows');
    function render() {
      const start = Math.floor(list.scrollTop / 20);
      rows.innerHTML = Array.from(
        { length: Math.min(8, 50 - start) },
        (_, i) =>
          `<div data-document-id="${start + i}" style="position:absolute;top:${(start + i) * 20}px;height:20px">Row ${start + i}</div>`,
      ).join('');
    }
    list.onscroll = render;
    render();
  });
  return page;
}
const read = (page) => () =>
  page
    .locator('[data-document-id]')
    .evaluateAll((es) =>
      es.map((e) => ({ id: e.getAttribute('data-document-id'), title: e.innerText })),
    );
test('virtualized lists collect every recycled row and restore the initial scroll position', async (t) => {
  const page = await fixture(t);
  await page.locator('#list').evaluate((e) => {
    e.scrollTop = 300;
  });
  await page.waitForTimeout(100);
  const r = await collectScrollList(page, { selector: '[data-document-id]', read: read(page) });
  assert.equal(r.complete, true);
  assert.equal(r.items.length, 50, JSON.stringify(r.items.map((i) => i.id)));
  assert.equal(await page.locator('#list').evaluate((e) => e.scrollTop), 300);
});
test('bounded scans report gaps and targeted scans leave the requested row available', async (t) => {
  const page = await fixture(t);
  const partial = await collectScrollList(page, {
    selector: '[data-document-id]',
    read: read(page),
    maxTurns: 2,
  });
  assert.equal(partial.complete, false);
  assert.equal(partial.reason, 'scroll-limit');
  const r = await collectScrollList(page, {
    selector: '[data-document-id]',
    read: read(page),
    stopId: '40',
    restore: false,
  });
  assert.equal(r.reason, 'target-found');
  assert.equal(await page.locator('[data-document-id="40"]').count(), 1);
});
