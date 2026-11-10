import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObjectController, validateVisualPaste } from '../src/objects.mjs';
import { Journal } from '../src/journal.mjs';
import { stepSchema, validateReferences } from '../src/job-schema.mjs';
import { JobController } from '../src/jobs.mjs';

test('large visual pastes must fit the visible page before any native paste input', () => {
  const source = { sourceZoom: '100%', sourceBounds: { width: 800, height: 200 } },
    view = { zoom: '100%', canvas: { x: 0, y: 48, width: 1440, height: 944 } },
    frame = { x: 0, y: 0, width: 1440, height: 1000 };
  assert.doesNotThrow(() => validateVisualPaste(source, view, frame, { x: 720, y: 520 }));
  assert.throws(
    () => validateVisualPaste(source, view, frame, { x: 288, y: 400 }),
    (e) => e.code === 'PASTE_SELECTION_NOT_VISIBLE',
  );
  assert.throws(
    () => validateVisualPaste(source, view, { ...frame, width: 600 }, { x: 400, y: 520 }),
    (e) => e.code === 'PASTE_SELECTION_NOT_VISIBLE',
  );
  assert.throws(
    () => validateVisualPaste(source, { ...view, zoom: 'Fit' }, frame, { x: 720, y: 520 }),
    (e) => e.code === 'COPY_ZOOM_UNAVAILABLE',
  );
});

test('native visual copy requires an unchanged lasso selection and blocks uncertain replay', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-visual-copy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const region = { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
    bounds = { x: 100, y: 200, width: 400, height: 200 },
    view = {
      viewId: 'view',
      viewport: { width: 1200, height: 800 },
      url: 'https://web.goodnotes.com/s/VisualSource',
      pageUrl: 'https://web.goodnotes.com/s/VisualSource#page-1',
      canvas: { x: 0, y: 0, width: 1200, height: 800 },
    },
    s = { bounds, hash: 'guarded', region, viewId: 'view' };
  let reads = 0,
    selected = 0;
  const a = {
      config: { directory },
      journal: new Journal(directory),
      styles: {
        selection: async () => {
          reads++;
          return { s, view, page: { screenshot: async () => Buffer.from('source') } };
        },
      },
    },
    c = new ObjectController(a);
  c.readingMode = async () => {};
  c.select = async () => {
    selected++;
    return { bounds: { ...bounds, x: 200 } };
  };
  const args = {
    selectionId: 'selected',
    destinationPath: ['00000000-0000-4000-8000-000000000001'],
    x: 0.5,
    y: 0.5,
  };
  delete s.region;
  await assert.rejects(
    c.copyNativeSelection({ ...args, operationId: 'visual-no-lasso' }),
    (e) => e.code === 'LASSO_SELECTION_REQUIRED',
  );
  assert.equal(selected, 0);
  s.region = region;
  await assert.rejects(
    c.copyNativeSelection({ ...args, operationId: 'visual-source-changed' }),
    (e) => e.code === 'SELECTION_CHANGED' && !e.details.mayHaveWritten,
  );
  assert.equal((await a.journal.get('visual-source-changed')).status, 'rejected');
  assert.equal(selected, 1);
  const operationId = 'visual-uncertain-copy';
  await a.journal.begin(operationId, {
    action: 'copy-native-visual-selection',
    sourceUrl: view.pageUrl,
    target: undefined,
    sourceSelection: { bounds, hash: 'guarded', region },
    destinationPath: args.destinationPath,
    destinationPage: 1,
    x: 0.5,
    y: 0.5,
  });
  await a.journal.finish(operationId, 'uncertain', { mayHaveWritten: true });
  const before = reads;
  await assert.rejects(
    c.copyNativeSelection({ ...args, operationId }),
    /automatic replay is blocked/,
  );
  assert.equal(reads, before + 1);
  assert.equal(selected, 1);
  assert.equal((await a.journal.get(operationId)).status, 'uncertain');
});

test('visual selection batches require a bounded region and dispatch a fresh guarded selection', async () => {
  const step = stepSchema.parse({
    action: 'copy-native-selection',
    url: 'https://web.goodnotes.com/s/VisualSource',
    region: { x: 0.2, y: 0.2, width: 0.4, height: 0.3 },
    destinationPath: ['00000000-0000-4000-8000-000000000001'],
    x: 0.5,
    y: 0.5,
  });
  let selected = false,
    copied = false;
  const a = {
    config: { directory: 'fixture' },
    inspect: async () => ({ viewId: 'view' }),
    objects: {
      select: async (args) => {
        assert.deepEqual(args.region, step.region);
        selected = true;
        return { selectionId: 'guard' };
      },
      copyNativeSelection: async (args) => {
        assert.equal(args.selectionId, 'guard');
        assert.equal(args.operationId, 'visual-batch-copy');
        copied = true;
        return { verified: true };
      },
    },
  };
  await new JobController(a).dispatch(step, 'visual-batch-copy');
  assert.ok(selected && copied);
  assert.equal(
    stepSchema.safeParse({ ...step, region: { ...step.region, width: 2 } }).success,
    false,
  );
  validateReferences([step, { action: 'export', url: { fromStep: 0, field: 'url' } }]);
});
