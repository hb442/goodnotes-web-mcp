import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { JobController } from '../src/jobs.mjs';
import { stepSchema, validateReferences, resolveStep } from '../src/job-schema.mjs';
import { Journal } from '../src/journal.mjs';
import { mutate } from '../src/mutations.mjs';
const url = 'https://web.goodnotes.com/s/SyntheticDocument123';
test('unsupported whiteboard style blocks a batch before any style or later text write', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-unsupported-style-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let writes = 0;
  const a = {
    config: { directory },
    journal: new Journal(directory),
    inspect: async () => ({ viewId: 'view', url }),
    objects: { select: async () => ({ selectionId: 'selected' }) },
    textBoxStyle: {
      prepare: async () => ({
        supported: false,
        changed: false,
        text: 'TEXT',
        reason: 'Native menu unavailable',
      }),
      apply: async () => {
        writes++;
      },
    },
    text: {
      create: async () => {
        writes++;
      },
    },
  };
  const jobs = new JobController(a);
  const plan = await jobs.plan({
    title: 'Unsupported style',
    backup: false,
    steps: [
      {
        action: 'text-box-style',
        url,
        target: { x: 0.3, y: 0.3 },
        expectedText: 'TEXT',
        style: { shadow: true },
      },
      { action: 'create-text', url, x: 0.5, y: 0.5, text: 'Must not be written' },
    ],
  });
  const result = await jobs.run({ jobId: plan.jobId, maxSteps: 2 });
  assert.equal(result.steps[0].error.code, 'STYLE_UNSUPPORTED');
  assert.equal(result.steps[0].error.mayHaveWritten, false);
  assert.equal(result.steps[1].status, 'pending');
  assert.equal(writes, 0);
  assert.equal((await a.journal.get(plan.steps[0].operationId)).status, 'not-found');
});
test('safe retry preserves rejected receipts and refuses any uncertain mutation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-retry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const a = {
    config: { directory },
    journal: new Journal(directory),
    library: {
      create: async (args) =>
        mutate(a, args.operationId, { action: 'fixture' }, async () => {
          throw new Error('Read-only lookup failed');
        }),
    },
  };
  const jobs = new JobController(a),
    plan = await jobs.plan({
      title: 'Retry',
      steps: [{ action: 'create', kind: 'folder', title: 'Test' }],
    });
  await jobs.run({ jobId: plan.jobId });
  const id = plan.steps[0].operationId;
  await jobs.retryRejected({ jobId: plan.jobId, stepIndex: 0 });
  assert.equal((await a.journal.get(id)).status, 'rejected');
  const stored = await jobs.get(plan.jobId);
  assert.equal(stored.steps[0].attempts.length, 1);
  assert.notEqual(stored.steps[0].operationId, id);
  await a.journal.begin(stored.steps[0].operationId, {});
  await a.journal.finish(stored.steps[0].operationId, 'uncertain', { mayHaveWritten: true });
  stored.steps[0].status = 'blocked';
  await jobs.save(stored);
  await assert.rejects(
    jobs.retryRejected({ jobId: plan.jobId, stepIndex: 0 }),
    (e) => e.code === 'REVIEW_REQUIRED',
  );
});
test('typed references reject forward, missing, wrong-type and arbitrary-field lookups before planning', () => {
  const create = { action: 'create', kind: 'whiteboard', title: 'Test', folderPath: [] };
  const ref = (field) => ({ fromStep: 0, field });
  assert.doesNotThrow(() => validateReferences([create, { action: 'export', url: ref('url') }]));
  assert.throws(() => validateReferences([{ action: 'export', url: ref('url') }]));
  assert.throws(() => validateReferences([create, { action: 'export', url: ref('itemPath') }]));
  assert.throws(() =>
    validateReferences([
      { ...create, kind: 'folder' },
      { action: 'export', url: ref('url') },
    ]),
  );
  assert.throws(() => stepSchema.parse({ action: 'export', url: ref('__proto__') }));
  assert.throws(() =>
    resolveStep({ action: 'export', url: ref('url') }, [{ status: 'skipped', result: { url } }]),
  );
});

test('saved board targets resolve the internal page URL and reject another document or page', async () => {
  const a = {
      config: { directory: '.' },
      getView: (id) => ({
        viewId: id,
        url,
        pageUrl: url + (id === 'wrong' ? '#page-2' : '#page-1'),
      }),
    },
    jobs = new JobController(a),
    publicView = { viewId: 'source', url };
  a.scans = { recall: async () => ({ viewId: 'match', selectionId: 'selected' }) };
  assert.equal(
    (await jobs.target(publicView, { objectId: 'bookmark' }, true)).selectionId,
    'selected',
  );
  a.scans.recall = async () => ({ viewId: 'wrong', selectionId: 'selected' });
  await assert.rejects(
    jobs.target(publicView, { objectId: 'bookmark' }, true),
    (e) => e.code === 'TARGET_DOCUMENT_CONFLICT',
  );
  a.targets = new Map([['read', { viewId: 'match' }]]);
  a.scans.select = async () => ({ targetId: 'read', selectionId: 'selected' });
  assert.equal(
    (await jobs.target(publicView, { scanId: 'scan', matchId: 'match' }, true)).targetId,
    'read',
  );
  a.targets.set('read', { viewId: 'wrong' });
  await assert.rejects(
    jobs.target(publicView, { scanId: 'scan', matchId: 'match' }, true),
    (e) => e.code === 'TARGET_DOCUMENT_CONFLICT',
  );
});
test('folder-style batch inputs reject mismatched property types before saving a plan', () => {
  const base = {
    action: 'folder-style',
    itemPath: { fromStep: 0, field: 'itemPath' },
    expectedTitle: 'Fixture Folder',
  };
  for (const bad of [
    { property: 'favorite', value: 'true', expectedValue: false },
    { property: 'color', value: 'red', expectedValue: '#123456' },
    { property: 'icon', value: true, expectedValue: 'none' },
  ])
    assert.equal(stepSchema.safeParse({ ...base, ...bad }).success, false);
  assert.equal(
    stepSchema.safeParse({ ...base, property: 'color', value: '#abcdef', expectedValue: '#123456' })
      .success,
    true,
  );
});
test('a chained create, text and export resumes across restarts with frozen resolved inputs', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-chain-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [],
    a = {
      config: { directory },
      journal: new Journal(directory),
      library: {
        create: async (args) => {
          calls.push(args);
          return { verified: true, url, itemPath: [crypto.randomUUID()] };
        },
      },
      inspect: async (args) => ({ url: args.url, viewId: crypto.randomUUID() }),
      text: {
        create: async (args) => {
          calls.push(args);
          return { verified: true };
        },
      },
      documents: {
        exportPdf: async (args) => {
          calls.push(args);
          return { url: args.url, exportId: crypto.randomUUID() };
        },
      },
    };
  let jobs = new JobController(a);
  const plan = await jobs.plan({
    title: 'Chain',
    steps: [
      { action: 'create', kind: 'whiteboard', title: 'Test' },
      {
        action: 'create-text',
        url: { fromStep: 0, field: 'url' },
        x: 0.2,
        y: 0.3,
        text: 'Persisted',
      },
      { action: 'export', url: { fromStep: 0, field: 'url' } },
    ],
  });
  assert.equal((await jobs.run({ jobId: plan.jobId })).steps[0].status, 'verified');
  jobs = new JobController(a);
  await jobs.run({ jobId: plan.jobId });
  assert.equal(calls[1].url, url);
  const stored = await jobs.get(plan.jobId);
  assert.equal(stored.steps[1].resolvedInput.url, url);
  assert.equal((await jobs.run({ jobId: plan.jobId })).status, 'completed');
  await jobs.run({ jobId: plan.jobId });
  assert.equal(calls.length, 3);
  const compact = await jobs.status({ jobId: plan.jobId });
  assert.equal('resolvedInput' in compact.steps[1], false);
});

test('image and box batch schemas reject malformed regions, empty styles and unsupported lock kinds', () => {
  const target = { x: 0.3, y: 0.3 };
  for (const bad of [
    { action: 'crop-image', url, target, region: { x: 0.7, y: 0, width: 0.5, height: 1 } },
    { action: 'crop-image', url, target, region: { x: 0, y: 0, width: 0, height: 1 } },
    { action: 'text-box-style', url, target, expectedText: 'Keep', style: {} },
    { action: 'text-box-style', url, target, expectedText: 'Keep', style: { shadow: 'true' } },
    { action: 'text-box-style', url, target, expectedText: 'Keep', style: { paddingPt: 1.5 } },
    { action: 'unlock-object', url, x: 0.3, y: 0.3, kind: 'group' },
    {
      action: 'favorite-document',
      itemPath: [crypto.randomUUID()],
      expectedTitle: 'Test',
      expectedFavorite: null,
      favorite: true,
    },
  ])
    assert.equal(stepSchema.safeParse(bad).success, false);
  const create = { action: 'create', kind: 'whiteboard', title: 'Test' };
  assert.doesNotThrow(() =>
    validateReferences([
      create,
      {
        action: 'favorite-document',
        itemPath: { fromStep: 0, field: 'itemPath' },
        expectedTitle: 'Test',
        expectedFavorite: false,
        favorite: true,
      },
    ]),
  );
});

test('new object batch steps back up before dispatch, preserve exact-text guards and stop before later writes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-object-batch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [],
    record = (name, result) => async (args) => {
      calls.push({ name, args });
      return result;
    };
  const a = {
    config: { directory },
    journal: new Journal(directory),
    inspect: record('inspect', { viewId: 'view', url }),
    documents: { exportPdf: record('backup', { exportId: crypto.randomUUID() }) },
    objects: { select: record('select', { selectionId: 'selected' }) },
    imageCrop: {
      prepare: record('crop-prepare', { cropId: 'crop' }),
      apply: record('crop-apply', { verified: true }),
    },
    textBoxStyle: {
      prepare: record('style-prepare', { styleId: 'style', text: 'ACTUAL TEXT' }),
      apply: record('style-apply', { verified: true }),
    },
    styles: {
      prepareUnlock: record('unlock-prepare', { unlockId: 'unlock' }),
      unlockObject: record('unlock-apply', { verified: true }),
    },
  };
  const jobs = new JobController(a),
    plan = await jobs.plan({
      title: 'Object steps',
      steps: [
        {
          action: 'crop-image',
          url,
          target: { x: 0.3, y: 0.3 },
          region: { x: 0, y: 0, width: 0.5, height: 1 },
        },
        { action: 'unlock-object', url, x: 0.3, y: 0.3, kind: 'image' },
        {
          action: 'text-box-style',
          url,
          target: { x: 0.3, y: 0.3 },
          expectedText: 'WRONG TEXT',
          style: { shadow: true },
        },
        { action: 'unlock-object', url, x: 0.5, y: 0.5, kind: 'text', expectedText: 'LATER' },
      ],
    });
  await jobs.run({ jobId: plan.jobId });
  await new JobController(a).run({ jobId: plan.jobId });
  const result = await new JobController(a).run({ jobId: plan.jobId, maxSteps: 3 });
  assert.equal(result.status, 'needs-review');
  assert.deepEqual(
    result.steps.map((s) => s.status),
    ['verified', 'verified', 'blocked', 'pending'],
  );
  assert.equal(result.steps[2].error.code, 'TEXT_CONFLICT');
  assert.deepEqual(
    calls.map((c) => c.name),
    [
      'backup',
      'inspect',
      'select',
      'crop-prepare',
      'crop-apply',
      'backup',
      'inspect',
      'unlock-prepare',
      'unlock-apply',
      'backup',
      'inspect',
      'select',
      'style-prepare',
    ],
  );
  assert.deepEqual(calls.find((c) => c.name === 'crop-apply').args, {
    cropId: 'crop',
    region: { x: 0, y: 0, width: 0.5, height: 1 },
    operationId: plan.steps[0].operationId,
  });
  assert.equal(calls.find((c) => c.name === 'unlock-prepare').args.kind, 'image');
  const count = calls.length;
  await jobs.run({ jobId: plan.jobId, maxSteps: 3 });
  assert.equal(calls.length, count);
});
