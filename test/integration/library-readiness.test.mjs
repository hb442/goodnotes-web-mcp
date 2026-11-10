import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { GoodnotesAdapter } from '../../src/adapter.mjs';
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: true });
});
after(() => browser?.close());
const id = (i) => '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
test('opening an item rescans a late-loading virtualized folder before declaring it absent', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent(
    '<div id="list" style="height:120px;overflow:auto"><div id="rows" style="height:20px;position:relative"></div></div>',
  );
  await page.evaluate(() => {
    const list = document.querySelector('#list'),
      rows = document.querySelector('#rows');
    let count = 1;
    const uid = (i) => '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
    const render = () => {
      const start = Math.floor(list.scrollTop / 20);
      rows.innerHTML = Array.from(
        { length: Math.min(8, count - start) },
        (_, i) =>
          `<div data-document-id="${uid(start + i)}" data-document-type="canvas" style="position:absolute;top:${(start + i) * 20}px;height:20px">Row ${start + i}</div>`,
      ).join('');
    };
    list.onscroll = render;
    list.ondblclick = (e) => {
      window.opened = e.target.getAttribute('data-document-id');
    };
    render();
    setTimeout(() => {
      count = 50;
      rows.style.height = '1000px';
      render();
    }, 300);
  });
  const adapter = {
    waitForLibraryRows: GoodnotesAdapter.prototype.waitForLibraryRows,
    readLibraryCards: (page) => GoodnotesAdapter.prototype.readLibraryCards.call({}, page),
  };
  await GoodnotesAdapter.prototype.enterItem.call(adapter, page, id(40));
  assert.equal(await page.evaluate(() => window.opened), id(40));
});
test('ambiguous native library IDs never dispatch an open', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent(
    `<div data-document-id="${id(1)}">A</div><div data-document-id="${id(1)}">B</div>`,
  );
  await page.evaluate(() => {
    window.clicks = 0;
    document.ondblclick = () => window.clicks++;
  });
  await assert.rejects(
    GoodnotesAdapter.prototype.enterItem.call(
      { waitForLibraryRows: GoodnotesAdapter.prototype.waitForLibraryRows },
      page,
      id(1),
    ),
    {
      code: 'ITEM_NOT_FOUND',
    },
  );
  assert.equal(await page.evaluate(() => window.clicks), 0);
});
test('a row remounted after readiness is awaited again instead of reported as a duplicate', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  const selector = `[data-document-id="${id(1)}"]`;
  await page.setContent(
    `<div data-document-id="${id(1)}" data-document-type="canvas">Target</div>`,
  );
  await page.evaluate(() => {
    window.clicks = 0;
    document.ondblclick = () => window.clicks++;
  });
  const row = page.locator(selector),
    wrapped = {
      locator(s) {
        if (s !== selector) return page.locator(s);
        return new Proxy(row, {
          get(target, key) {
            if (key === 'waitFor')
              return async (options) => {
                await target.waitFor(options);
                if (options.state === 'attached')
                  await page.evaluate((selector) => {
                    const e = document.querySelector(selector),
                      html = e.outerHTML;
                    e.remove();
                    setTimeout(() => document.body.insertAdjacentHTML('beforeend', html), 250);
                  }, selector);
              };
            const value = target[key];
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
  await GoodnotesAdapter.prototype.enterItem.call(
    { waitForLibraryRows: GoodnotesAdapter.prototype.waitForLibraryRows },
    wrapped,
    id(1),
  );
  assert.equal(await page.evaluate(() => window.clicks), 1);
});
test(
  'a hidden stale library row does not hide a ready active list',
  { timeout: 15000 },
  async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.setContent(
      `<div data-document-id="${id(1)}" hidden>Stale</div><div data-document-id="${id(2)}">Current</div>`,
    );
    await GoodnotesAdapter.prototype.waitForLibraryRows.call({}, page);
  },
);
test(
  'library readiness also accepts a delayed genuine empty state',
  { timeout: 15000 },
  async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.setContent(`<div data-document-id="${id(1)}" hidden>Stale</div>`);
    await page.evaluate(() =>
      setTimeout(
        () =>
          document.body.insertAdjacentHTML(
            'beforeend',
            '<button id="library-no-documents-view-new-button">New</button>',
          ),
        200,
      ),
    );
    await GoodnotesAdapter.prototype.waitForLibraryRows.call({}, page);
  },
);
