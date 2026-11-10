import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTextPages, RecoveryController } from '../src/recovery.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Journal, digest } from '../src/journal.mjs';
test('export differences distinguish text edits, dimensions and added/removed pages', () => {
  const p = (text) => ({ text, width: 300, height: 400 });
  const r = compareTextPages(
    [p('Alpha'), p('Before')],
    [p('Alpha'), { ...p('After'), width: 400 }, p('Extra')],
  );
  assert.equal(r[0].status, 'text-unchanged');
  assert.equal(r[1].status, 'text-changed');
  assert.equal(r[1].dimensionsEqual, false);
  assert.equal(r[2].status, 'added');
  assert.equal(compareTextPages([p('Alpha')], [])[0].status, 'removed');
});
test('read-only restore reconciliation binds the exact original snapshot and preserves uncertain receipts', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-restore-check-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const snapshotId = '00000000-0000-4000-8000-000000000000',
    otherId = '00000000-0000-4000-8000-000000000001',
    operationId = 'restore-review-001',
    title = 'Restored';
  const journal = new Journal(directory);
  await journal.begin(operationId, { action: 'restore-snapshot-copy', snapshotId, title });
  await journal.finish(operationId, 'uncertain', { mayHaveWritten: true });
  const childId = 'restore-' + digest(operationId).slice(0, 60);
  await journal.begin(childId, {});
  await journal.finish(childId, 'verified', {
    url: 'https://web.goodnotes.com/s/SyntheticRestored123',
    title,
    itemPath: ['synthetic'],
  });
  const a = {
    config: { directory },
    journal,
    pages: {
      list: async () => ({
        url: 'https://web.goodnotes.com/s/SyntheticRestored123',
        title,
        count: 1,
      }),
    },
    documents: { exportPdf: async () => ({ exportId: 'now' }) },
  };
  const c = new RecoveryController(a);
  c.get = async () => ({ baselineExportId: 'before', copy: { pageCount: 1 } });
  c.assertSameContents = async () => {};
  assert.equal(
    (await c.verifyRestore({ snapshotId, restoreOperationId: operationId })).verified,
    true,
  );
  assert.equal((await journal.get(operationId)).status, 'uncertain');
  await assert.rejects(
    c.verifyRestore({ snapshotId: otherId, restoreOperationId: operationId }),
    (e) => e.code === 'RECOVERY_MISMATCH',
  );
});
test('native recovery creates independent copies, rejects changed snapshot identities and journals replay', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = 'https://web.goodnotes.com/s/SyntheticOriginal123',
    copy = 'https://web.goodnotes.com/s/SyntheticSnapshot123',
    restored = 'https://web.goodnotes.com/s/SyntheticRestored123';
  let writes = 0,
    changed = false;
  const a = {
    config: { directory },
    journal: new Journal(directory),
    openItem: async () => ({ url: original, title: 'Original' }),
    pages: {
      list: async ({ url }) => ({
        url,
        title: url === copy ? 'Backup' : 'Original',
        count: 2,
        orderHash: changed ? 'changed' : 'same',
      }),
    },
    library: {
      manage: async (args) => {
        writes++;
        return {
          url: writes === 1 ? copy : restored,
          title: args.title,
          itemPath: ['00000000-0000-4000-8000-000000000001'],
        };
      },
    },
  };
  a.documents = { exportPdf: async () => ({ exportId: 'synthetic-export' }) };
  const c = new RecoveryController(a);
  c.compare = async () => ({
    leftPages: 2,
    rightPages: 2,
    pages: [{ status: 'text-unchanged', dimensionsEqual: true, visualEqual: true }],
    nextPage: null,
  });
  const snapshot = await c.create({
    itemPath: ['00000000-0000-4000-8000-000000000000'],
    title: 'Backup',
    operationId: 'recovery-test-001',
  });
  const result = await c.restore({
    snapshotId: snapshot.snapshotId,
    title: 'Restored',
    operationId: 'recovery-test-002',
  });
  assert.equal(result.url, restored);
  await c.restore({
    snapshotId: snapshot.snapshotId,
    title: 'Restored',
    operationId: 'recovery-test-002',
  });
  assert.equal(writes, 2);
  changed = true;
  await assert.rejects(
    c.restore({
      snapshotId: snapshot.snapshotId,
      title: 'Rejected',
      operationId: 'recovery-test-003',
    }),
    (e) => e.code === 'SNAPSHOT_CHANGED',
  );
  assert.equal(writes, 2);
  changed = false;
  c.compare = async () => ({
    leftPages: 2,
    rightPages: 2,
    pages: [{ status: 'text-unchanged', dimensionsEqual: true, visualEqual: false }],
    nextPage: null,
  });
  await assert.rejects(
    c.restore({
      snapshotId: snapshot.snapshotId,
      title: 'Rejected content',
      operationId: 'recovery-test-004',
    }),
    (e) => e.code === 'SNAPSHOT_CONTENT_CHANGED' && e.details.mayHaveWritten === false,
  );
  assert.equal(writes, 2);
});
