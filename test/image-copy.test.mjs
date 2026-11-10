import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObjectController } from '../src/objects.mjs';
import { Journal } from '../src/journal.mjs';
import { stepSchema, validateReferences } from '../src/job-schema.mjs';
const sourceUrl = 'https://web.goodnotes.com/s/SyntheticImageSource',
  expectedSourceSha256 = '1'.repeat(64),
  region = { x: 0, y: 0, width: 1, height: 1 };

test('native image copying refuses changed source pixels or crop before clipboard/paste and preserves uncertain receipts', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-image-copy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let prepared = 0,
    clipboard = 0;
  const a = {
      config: { directory },
      journal: new Journal(directory),
      inspect: async () => ({ viewId: 'view', url: sourceUrl }),
      jobs: { target: async () => ({ selectionId: 'selected' }) },
      imageCrop: {
        prepare: async () => {
          prepared++;
          return {
            sourceSha256: expectedSourceSha256,
            region,
            sourceSize: { width: 400, height: 300 },
          };
        },
      },
      styles: {
        selection: async () => {
          clipboard++;
          throw Error('Clipboard must not open');
        },
      },
    },
    c = new ObjectController(a),
    args = {
      sourceUrl,
      target: { x: 0.3, y: 0.3 },
      expectedSourceSha256,
      expectedCrop: region,
      destinationPath: ['00000000-0000-4000-8000-000000000001'],
      x: 0.5,
      y: 0.5,
    };
  await assert.rejects(
    c.copyNativeImage({ ...args, expectedSourceSha256: 'bad', operationId: 'image-bad-hash' }),
    (e) => e.code === 'INVALID_IMAGE_HASH',
  );
  await assert.rejects(
    c.copyNativeImage({
      ...args,
      expectedCrop: { ...region, width: 2 },
      operationId: 'image-bad-crop',
    }),
    (e) => e.code === 'INVALID_CROP',
  );
  assert.equal(prepared, 0);
  for (const [suffix, patch] of [
    ['pixels', { expectedSourceSha256: '2'.repeat(64) }],
    ['crop', { expectedCrop: { ...region, width: 0.5 } }],
  ]) {
    const operationId = 'image-conflict-' + suffix;
    await assert.rejects(
      c.copyNativeImage({ ...args, ...patch, operationId }),
      (e) => e.code === 'IMAGE_CONFLICT' && e.details.mayHaveWritten === false,
    );
    assert.equal((await a.journal.get(operationId)).status, 'rejected');
  }
  assert.equal(clipboard, 0);
  const id = 'image-uncertain-copy';
  const parameters = {
    action: 'copy-native-image-object',
    sourceUrl,
    target: args.target,
    expectedSourceSha256,
    expectedCrop: region,
    destinationPath: args.destinationPath,
    destinationPage: 1,
    x: 0.5,
    y: 0.5,
  };
  await a.journal.begin(id, parameters);
  await a.journal.finish(id, 'uncertain', { mayHaveWritten: true });
  const reads = prepared;
  await assert.rejects(
    c.copyNativeImage({ ...args, operationId: id }),
    /automatic replay is blocked/,
  );
  assert.equal(prepared, reads);
  assert.equal((await a.journal.get(id)).status, 'uncertain');
});

test('image-copy batches require a guarded source and allow only typed destination paths', () => {
  const step = {
    action: 'copy-image-object',
    sourceUrl,
    target: { x: 0.3, y: 0.3 },
    expectedSourceSha256,
    expectedCrop: region,
    destinationPath: { fromStep: 0, field: 'itemPath' },
    x: 0.5,
    y: 0.5,
  };
  assert.doesNotThrow(() =>
    validateReferences([{ action: 'create', kind: 'whiteboard', title: 'Destination' }, step]),
  );
  assert.equal(stepSchema.safeParse({ ...step, expectedSourceSha256: undefined }).success, false);
  assert.equal(
    stepSchema.safeParse({ ...step, expectedCrop: { ...region, x: 0.5 } }).success,
    false,
  );
  assert.throws(() =>
    validateReferences([
      { action: 'create', kind: 'whiteboard', title: 'Destination' },
      { ...step, destinationPath: { fromStep: 0, field: 'url' } },
    ]),
  );
});
