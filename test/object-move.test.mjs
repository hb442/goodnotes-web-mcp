import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { ObjectMoveController, moveChildIds } from '../src/object-move.mjs';
import { Journal, digest } from '../src/journal.mjs';
import { mutate } from '../src/mutations.mjs';
import { GoodnotesError } from '../src/errors.mjs';
const url = 'https://web.goodnotes.com/s/SyntheticMoveSource',
  destination = 'https://web.goodnotes.com/s/SyntheticMoveDestination';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-move-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [],
    view = {
      viewId: 'source',
      url,
      pageUrl: url + '#page-1',
      title: 'Source',
      viewport: { width: 1000, height: 700 },
      canvas: { x: 0, y: 0, width: 1000, height: 700 },
    },
    anchor = { pageId: 'board', x: 0, y: 0, scale: 1 },
    canvas = createCanvas(1000, 700),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 1000, 700);
  const page = {
      screenshot: async () => canvas.toBuffer('image/png'),
      waitForTimeout: async () => {},
    },
    a = {
      config: {
        directory,
        documents: [
          { url, title: 'Source' },
          { url: destination, title: 'Destination' },
        ],
      },
      journal: new Journal(directory),
      inspect: async () => view,
      getView: () => view,
      getPage: async () => page,
      readText: async () => ({ text: 'Keep', kind: 'text-box', formatting: [] }),
      openItem: async () => ({ url: destination, title: 'Destination' }),
      jobs: { target: async () => ({ selectionId: 'selected' }) },
      styles: {
        selection: async () => ({
          s: { bounds: { x: 200, y: 200, width: 100, height: 100 } },
          view,
          page,
        }),
      },
      documents: {
        exportPdf: async () => {
          calls.push('backup');
          return { url, title: 'Source', exportId: crypto.randomUUID() };
        },
      },
      scans: {
        remember: async () => ({ objectId: crypto.randomUUID() }),
        recall: async () => {
          calls.push('recall');
          return {
            viewId: 'source',
            selectionId: 'selected',
            bounds: { x: 200, y: 200, width: 100, height: 100 },
          };
        },
        selectionAnchor: async () => anchor,
        position: async () => ({ view, anchor, page }),
      },
      objects: {},
    };
  const copied = {
    verified: true,
    url: destination,
    kind: 'text-box',
    viewId: 'dest',
    selectionId: 'pasted',
  };
  a.objects.copyNativeText = async (args) =>
    mutate(a, args.operationId, { action: 'copy' }, async (mark) => {
      calls.push('copy');
      mark();
      await fs.mkdir(path.join(directory, 'copy-checkpoints'), { recursive: true });
      await fs.writeFile(
        path.join(directory, 'copy-checkpoints', args.operationId + '.json'),
        JSON.stringify({
          operationId: args.operationId,
          fingerprint: (await a.journal.get(args.operationId)).fingerprint,
          kind: 'text-box',
          textHash: digest('Keep'),
          styleHash: digest([]),
        }),
      );
      return copied;
    });
  a.objects.transform = async (args) =>
    mutate(a, args.operationId, { action: 'delete' }, async (mark) => {
      calls.push('delete');
      mark();
      await fs.mkdir(path.join(directory, 'evidence'), { recursive: true });
      await fs.writeFile(
        path.join(directory, 'evidence', args.operationId + '-after.png'),
        canvas.toBuffer('image/png'),
      );
      return { verified: true, region: { x: 190, y: 190, width: 120, height: 120 } };
    });
  a.objects.verifyCopiedText = async () => {
    calls.push('verify-copy');
    return copied;
  };
  return {
    a,
    c: new ObjectMoveController(a),
    calls,
    ctx,
    args: {
      sourceUrl: url,
      target: { x: 0.3, y: 0.3 },
      content: { kind: 'text', expectedText: 'Keep' },
      destinationPath: [crypto.randomUUID()],
      x: 0.5,
      y: 0.5,
      operationId: 'move-fixture-001',
    },
  };
}
test('native moves require source permission and preserve source if copy fails or original changes', async (t) => {
  const { a, c, calls, args } = await fixture(t);
  a.config.documents = a.config.documents.filter((d) => d.url !== url);
  await assert.rejects(
    c.move(args),
    (e) => e.code === 'WRITE_NOT_ALLOWED' && !e.details.mayHaveWritten,
  );
  assert.deepEqual(calls, []);
  a.config.documents.push({ url, title: 'Source' });
  a.objects.copyNativeText = async () => {
    calls.push('copy');
    throw new GoodnotesError('COPY_UNVERIFIED', 'copy incomplete', { mayHaveWritten: true });
  };
  await assert.rejects(
    c.move({ ...args, operationId: 'move-copy-failed' }),
    (e) =>
      e.code === 'COPY_UNVERIFIED' && e.details.stage === 'prepared' && e.details.mayHaveWritten,
  );
  assert.equal(calls.includes('delete'), false);
  a.objects.copyNativeText = async () => ({ verified: true, url: destination });
  a.scans.recall = async () => {
    throw new GoodnotesError('SAVED_OBJECT_CHANGED', 'original changed');
  };
  await assert.rejects(
    c.move({ ...args, operationId: 'move-source-changed' }),
    (e) => e.code === 'SAVED_OBJECT_CHANGED' && e.details.stage === 'copy-verified',
  );
  assert.equal(calls.includes('delete'), false);
  assert.equal((await a.journal.get('move-source-changed')).status, 'uncertain');
});
test('move audit requires both child receipts and never repeats unfinished work', async (t) => {
  const { a, c, args, calls } = await fixture(t);
  a.objects.copyNativeText = async () => {
    throw new Error('interrupted copy');
  };
  await assert.rejects(c.move(args));
  const count = calls.length;
  await assert.rejects(
    c.verify({ operationId: args.operationId }),
    (e) => e.code === 'MOVE_INCOMPLETE',
  );
  assert.equal(calls.length, count);
  await assert.rejects(c.move(args), /automatic replay is blocked/);
  assert.equal(calls.length, count);
  await assert.rejects(
    c.verify({ operationId: '../invalid' }),
    (e) => e.code === 'INVALID_OPERATION_ID',
  );
  const ids = moveChildIds('x'.repeat(80));
  assert.ok(ids.copyOperationId.length <= 80);
  assert.notEqual(ids.copyOperationId, ids.deleteOperationId);
});
test('completed native move verifies destination and saved source removal, preserves receipts, and rejects later source changes', async (t) => {
  const { a, c, args, calls, ctx } = await fixture(t),
    moved = await c.move(args);
  assert.equal(moved.verified, true);
  assert.deepEqual(calls, ['backup', 'copy', 'recall', 'recall', 'delete', 'verify-copy']);
  const audited = await c.verify({ operationId: args.operationId });
  assert.equal(audited.originalMoveReceiptStatus, 'verified');
  assert.equal(calls.filter((x) => x === 'delete').length, 1);
  assert.equal(calls.filter((x) => x === 'copy').length, 1);
  const count = calls.length;
  await c.move(args);
  assert.equal(calls.length, count);
  ctx.fillStyle = 'black';
  ctx.fillRect(220, 220, 50, 50);
  await assert.rejects(
    c.verify({ operationId: args.operationId }),
    (e) => e.code === 'MOVE_SOURCE_CHANGED',
  );
  assert.equal((await a.journal.get(args.operationId)).status, 'verified');
});

test('move rechecks exact source text and formatting after a visually valid recall, before deletion', async (t) => {
  for (const current of [
    { text: 'Changed', kind: 'text-box', formatting: [] },
    { text: 'Keep', kind: 'text-box', formatting: [{ bold: true }] },
    { text: 'Keep', kind: 'sticky', formatting: [] },
  ]) {
    const { a, c, args, calls } = await fixture(t);
    a.readText = async () => current;
    await assert.rejects(
      c.move(args),
      (e) => e.code === 'SOURCE_CONTENT_CHANGED' && e.details.stage === 'copy-verified',
    );
    assert.equal(calls.includes('delete'), false);
    assert.equal((await a.journal.get(args.operationId)).status, 'uncertain');
  }
});
test('source image recheck binds the verified copy checkpoint, exact pixels, dimensions and crop', async (t) => {
  const { a, c, calls } = await fixture(t),
    copyOperationId = 'move-image-checkpoint-001';
  await a.objects.copyNativeText({ operationId: copyOperationId });
  const file = path.join(a.config.directory, 'copy-checkpoints', copyOperationId + '.json'),
    copied = JSON.parse(await fs.readFile(file, 'utf8')),
    image = {
      sourceSha256: 'a'.repeat(64),
      sourceSize: { width: 300, height: 200 },
      region: { x: 0, y: 0, width: 1, height: 1 },
    };
  await fs.writeFile(file, JSON.stringify({ ...copied, kind: 'image', image }));
  let current = structuredClone(image);
  a.imageCrop = { prepare: async () => current };
  const record = { copyOperationId, objectId: crypto.randomUUID() },
    original = { selectionId: 'image', viewId: 'source' };
  assert.ok((await c.recheckSource(record, original)).selectionId);
  const count = calls.length;
  for (const changed of [
    { sourceSha256: 'b'.repeat(64) },
    { sourceSize: { width: 301, height: 200 } },
    { region: { x: 0.1, y: 0, width: 0.9, height: 1 } },
  ]) {
    current = { ...structuredClone(image), ...changed };
    await assert.rejects(
      c.recheckSource(record, original),
      (e) => e.code === 'SOURCE_CONTENT_CHANGED',
    );
  }
  assert.equal(calls.length, count);
  await fs.writeFile(file, JSON.stringify({ ...copied, fingerprint: 'different' }));
  await assert.rejects(
    c.recheckSource(record, original),
    (e) => e.code === 'COPY_CHECKPOINT_REQUIRED',
  );
});
