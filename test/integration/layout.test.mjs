import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { LayoutController } from '../../src/layout.mjs';
import { PageController } from '../../src/pages.mjs';
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
});
after(() => browser?.close());
test('template catalog ignores duplicate IDs outside the active modal and hidden tab content', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent(
    '<button id="changeTemplate" onclick="document.getElementById(\'template-library-template-change-modal\').style.display=\'block\'">Change</button><div id="template-library-title-same"><div data-selected="true"></div>Outside</div><div id="template-library-template-change-modal" style="display:none"><button id="template-library-toggle-cover">Cover</button><div id="template-library-title-same"><div data-selected="false"></div>Cover</div><div id="template-library-title-same" style="display:none"><div data-selected="true"></div>Hidden</div><button id="template-library-template-change-cancel-button" onclick="this.parentElement.style.display=\'none\'">Cancel</button></div>',
  );
  const url = 'https://web.goodnotes.com/s/SyntheticTemplate',
    a = {
      inspect: async () => ({ url }),
      getPage: async () => page,
      objects: { tool: async () => {} },
      pages: {
        list: async () => ({ count: 1, orderHash: 'hash' }),
        sidebar: async () => {},
        snapshot: async () => ({ count: 1, orderHash: 'hash' }),
        menu: async () => {},
      },
    };
  const result = await new LayoutController(a).templates({ url, page: 1, kind: 'cover' });
  assert.deepEqual(result.templates, [
    { id: 'template-library-title-same', title: 'Cover', selected: false },
  ]);
  assert.equal(await page.locator('#template-library-template-change-modal').isVisible(), false);
});
test('read-only whiteboard page listing does not depend on the hidden Add Board button', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const id = '00000000-0000-4000-8000-000000000001';
  await page.setContent(
    '<style>html,body{margin:0;height:100%;overflow:hidden}</style><div style="position:fixed;inset:0;overflow:hidden"><div id="interaction-layer-page-' +
      id +
      '" style="width:100001px;height:100001px"></div></div><div id="sidebarContent_0" data-testid="' +
      id +
      '" style="position:fixed;width:100px;height:100px">Board 1</div>',
  );
  const result = await new PageController({}).snapshot(page);
  assert.equal(result.count, 1);
  assert.equal(result.pages[0].id, id);
});
