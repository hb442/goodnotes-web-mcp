import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PDFDocument, rgb } from 'pdf-lib';
import { PageRecoveryController, remainingOrder } from '../src/page-recovery.mjs';
import { Journal, digest } from '../src/journal.mjs';
import { extractPdf } from '../src/pdf.mjs';
import { validateReferences } from '../src/job-schema.mjs';
import { PageController } from '../src/pages.mjs';

const url = 'https://web.goodnotes.com/s/SyntheticPageRecovery',
  title = 'Page Fixture';

test('page deletion refuses an incomplete or wrong-document backup before any native delete input', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-page-backup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const order = [crypto.randomUUID(), crypto.randomUUID()],
    snapshot = { count: 2, pages: order.map((id) => ({ id })), orderHash: digest(order) };
  let checkpointed = 0,
    menus = 0;
  const page = { url: () => url, locator: () => ({ innerText: async () => title }) },
    a = {
      config: { directory, documents: [{ url, title }] },
      journal: new Journal(directory),
      openDocument: async () => page,
      invalidate: () => {},
      documents: {
        exportPdf: async () => ({ url, title, pageCount: 1, exportId: crypto.randomUUID() }),
      },
      pageRecovery: {
        checkpoint: async () => {
          checkpointed++;
        },
      },
    };
  const c = new PageController(a);
  c.sidebar = async () => {};
  c.snapshot = async () => snapshot;
  c.menu = async () => {
    menus++;
    throw Error('Unexpected delete menu');
  };
  const args = {
    url,
    command: 'delete',
    page: 1,
    expectedPageCount: 2,
    expectedOrderHash: snapshot.orderHash,
  };
  await assert.rejects(
    c.manage({ ...args, operationId: 'delete-short-backup' }),
    (e) => e.code === 'BACKUP_UNVERIFIED' && !e.details.mayHaveWritten,
  );
  a.documents.exportPdf = async () => ({
    url: 'https://web.goodnotes.com/s/DifferentBackup',
    title,
    pageCount: 2,
    exportId: crypto.randomUUID(),
  });
  await assert.rejects(
    c.manage({ ...args, operationId: 'delete-wrong-backup' }),
    (e) => e.code === 'BACKUP_UNVERIFIED' && !e.details.mayHaveWritten,
  );
  assert.equal(checkpointed, 0);
  assert.equal(menus, 0);
});
test('page recovery requires a bound deletion checkpoint and current authorization, and blocks changed order before native recovery', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-page-restore-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = new Journal(directory),
    order = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
    backupExportId = crypto.randomUUID(),
    operationId = 'page-delete-checkpoint-001';
  let browserCalls = 0;
  const a = {
      config: { directory, documents: [{ url, title }] },
      journal,
      pages: {
        list: async () => {
          browserCalls++;
          return { title, url, pages: [{ id: order[2] }, { id: order[0] }] };
        },
      },
    },
    c = new PageRecoveryController(a);
  await assert.rejects(c.source('../bad-path'), (e) => e.code === 'INVALID_OPERATION_ID');
  await assert.rejects(
    c.source('missing-checkpoint'),
    (e) => e.code === 'PAGE_CHECKPOINT_REQUIRED',
  );
  await journal.begin(operationId, { action: 'page-management' });
  await c.checkpoint({ operationId, view: { url, title }, order, page: 2, backupExportId });
  await assert.rejects(c.source(operationId), (e) => e.code === 'PAGE_CHECKPOINT_REQUIRED');
  await journal.finish(operationId, 'uncertain', { mayHaveWritten: true });
  assert.equal((await c.source(operationId)).record.pageId, order[1]);
  a.config.documents = [];
  await assert.rejects(
    c.restore({ deleteOperationId: operationId, operationId: 'restore-unauthorized' }),
    (e) => e.code === 'WRITE_NOT_ALLOWED' && !e.details.mayHaveWritten,
  );
  assert.equal(browserCalls, 0);
  a.config.documents = [{ url, title }];
  await assert.rejects(
    c.restore({ deleteOperationId: operationId, operationId: 'restore-changed-order' }),
    (e) => e.code === 'PAGE_CONFLICT' && !e.details.mayHaveWritten,
  );
  assert.equal((await journal.get(operationId)).status, 'uncertain');
  const file = c.file(operationId),
    record = JSON.parse(await fs.readFile(file, 'utf8'));
  record.fingerprint = 'tampered';
  await fs.writeFile(file, JSON.stringify(record));
  await assert.rejects(c.source(operationId), (e) => e.code === 'PAGE_CHECKPOINT_REQUIRED');
  for (const invalid of [[order[0]], [order[0], order[0]], ['invalid', order[1]]])
    assert.throws(() => remainingOrder(invalid, order[0]));
});

test('remaining-page PDF comparison maps around the deleted page and rejects changed artwork even with identical extracted text', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-remaining-pages-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const docs = new Map();
  async function pdf(name, colors) {
    const p = await PDFDocument.create();
    for (const color of colors) {
      const page = p.addPage([300, 400]);
      page.drawRectangle({ x: 40, y: 100, width: 90, height: 150, color });
    }
    const file = path.join(directory, name + '.pdf');
    await fs.writeFile(file, await p.save());
    const index = await extractPdf(file);
    docs.set(name, { index, record: { path: file } });
  }
  const red = rgb(0.8, 0.1, 0.1),
    green = rgb(0.1, 0.7, 0.2),
    blue = rgb(0.1, 0.2, 0.8);
  await pdf('before', [red, green, blue]);
  await pdf('after', [red, blue]);
  await pdf('changed', [red, green]);
  const order = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()],
    record = { originalOrder: order, pageId: order[1], backupExportId: 'before' },
    c = new PageRecoveryController({
      config: { directory },
      documents: { get: async (id) => docs.get(id) },
    });
  await c.assertRemainingContents(record, 'after');
  await assert.rejects(
    c.assertRemainingContents(record, 'changed'),
    (e) => e.code === 'PAGE_CONTENT_CONFLICT',
  );
  await assert.rejects(
    c.assertRemainingContents(record, 'before'),
    (e) => e.code === 'PAGE_CONTENT_CONFLICT',
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(c.assertRemainingContents(record, 'after', { signal: abort.signal }));
});

test('already restored pages are verified without another recovery and deletion references remain typed', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-page-idempotent-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const order = [crypto.randomUUID(), crypto.randomUUID()],
    backupExportId = crypto.randomUUID(),
    journal = new Journal(directory),
    deleteOperationId = 'delete-already-restored';
  let comparisons = 0;
  const a = {
      config: { directory, documents: [{ url, title }] },
      journal,
      pages: {
        list: async () => ({
          url,
          title,
          pages: order.map((id) => ({ id })),
          count: 2,
          orderHash: digest(order),
        }),
      },
      documents: { exportPdf: async () => ({ exportId: backupExportId }) },
      recovery: {
        assertSameContents: async () => {
          comparisons++;
        },
      },
      trash: {
        list: async () => {
          throw Error('Unexpected recovery');
        },
      },
    },
    c = new PageRecoveryController(a);
  await journal.begin(deleteOperationId, { action: 'page-management' });
  await c.checkpoint({
    operationId: deleteOperationId,
    view: { url, title },
    order,
    page: 1,
    backupExportId,
  });
  await journal.finish(deleteOperationId, 'uncertain', { mayHaveWritten: true });
  const result = await c.restore({ deleteOperationId, operationId: 'restore-already-restored' });
  assert.equal(result.changed, false);
  assert.equal(result.verified, true);
  assert.equal(comparisons, 1);
  assert.equal((await journal.get(deleteOperationId)).status, 'uncertain');
  await c.restore({ deleteOperationId, operationId: 'restore-already-restored' });
  assert.equal(comparisons, 1);
  assert.doesNotThrow(() =>
    validateReferences([
      { action: 'pages', url, command: 'delete', page: 1, expectedPageCount: 2 },
      { action: 'restore-page', deleteOperationId: { fromStep: 0, field: 'operationId' } },
    ]),
  );
});
