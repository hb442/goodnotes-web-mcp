import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../src/journal.mjs';
import { TrashController } from '../src/trash.mjs';
test('trash recovery binds a verified trash receipt and current URL/title authorization before any browser access', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-trash-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = new Journal(directory),
    url = 'https://web.goodnotes.com/s/SyntheticTrash',
    title = 'Fixture',
    itemPath = ['00000000-0000-4000-8000-000000000001'];
  let browserCalls = 0;
  const a = {
      config: { directory, documents: [{ url, title }] },
      journal,
      getPage: async () => {
        browserCalls++;
        throw Error('Unexpected browser access');
      },
    },
    c = new TrashController(a);
  await assert.rejects(
    c.restore({ trashOperationId: 'missing-operation', operationId: 'restore-missing-001' }),
    (e) => e.code === 'TRASH_RECEIPT_REQUIRED' && !e.details.mayHaveWritten,
  );
  await journal.begin('wrong-receipt-001', { action: 'duplicate' });
  const result = { url, title, itemPath, id: itemPath[0], backupExportId: 'backup' };
  await journal.finish('wrong-receipt-001', 'verified', result);
  await assert.rejects(c.source('wrong-receipt-001'), (e) => e.code === 'TRASH_RECEIPT_REQUIRED');
  await journal.begin('proper-trash-001', {
    action: 'trash-document',
    itemPath,
    expectedTitle: title,
  });
  await journal.finish('proper-trash-001', 'verified', result);
  assert.equal((await c.source('proper-trash-001')).url, url);
  a.config.documents = [];
  await assert.rejects(c.source('proper-trash-001'), (e) => e.code === 'WRITE_NOT_ALLOWED');
  assert.equal(browserCalls, 0);
});
