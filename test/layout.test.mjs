import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../src/journal.mjs';
import { LayoutController, uniqueTemplates } from '../src/layout.mjs';
test('template favorites and library duplicates are one logical choice, while conflicting titles reject', () => {
  assert.deepEqual(
    uniqueTemplates([
      { id: 'a', title: 'Black', selected: false },
      { id: 'a', title: 'Black', selected: true },
    ]),
    [{ id: 'a', title: 'Black', selected: true }],
  );
  assert.throws(
    () =>
      uniqueTemplates([
        { id: 'a', title: 'Black' },
        { id: 'a', title: 'White' },
      ]),
    (e) => e.code === 'AMBIGUOUS_TEMPLATE',
  );
});
test('board state conflicts and template page-order conflicts reject before any document mutation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-layout-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const url = 'https://web.goodnotes.com/s/SyntheticLayout',
    view = { url, title: 'Fixture' };
  let clicks = 0;
  const a = {
    config: { directory, documents: [view] },
    journal: new Journal(directory),
    inspect: async () => view,
    getPage: async () => ({ locator: () => ({ click: async () => clicks++ }) }),
    documents: {
      exportPdf: async () => ({ exportId: 'backup' }),
      get: async () => ({ index: { pages: [] } }),
    },
  };
  const c = new LayoutController(a);
  c.boardMenu = async () => ({ pattern: 'dot', color: 'white' });
  await assert.rejects(
    c.setBoard({
      url,
      pattern: 'grid',
      expectedPattern: 'plain',
      expectedColor: 'white',
      operationId: 'board-conflict-001',
    }),
    (e) => e.code === 'BOARD_SETTINGS_CONFLICT' && !e.details.mayHaveWritten,
  );
  c.templateMenu = async () => ({
    view,
    page: {},
    pages: { count: 2, orderHash: 'current' },
    templates: [],
  });
  await assert.rejects(
    c.setTemplate({
      url,
      page: 1,
      templateId: 'template',
      expectedPageCount: 2,
      expectedOrderHash: 'old',
      operationId: 'template-conflict-001',
    }),
    (e) => e.code === 'PAGE_CONFLICT' && !e.details.mayHaveWritten,
  );
  assert.equal(clicks, 0);
  assert.equal((await a.journal.get('template-conflict-001')).status, 'rejected');
});
