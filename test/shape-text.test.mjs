import test from 'node:test';
import assert from 'node:assert/strict';
import { stepSchema, targetSchema } from '../src/job-schema.mjs';
import { JobController } from '../src/jobs.mjs';

test('shape text batches bind the native kind and reject incompatible query targets', async () => {
  const url = 'https://web.goodnotes.com/s/ShapeFixture';
  const replace = stepSchema.parse({
    action: 'replace-text',
    url,
    x: 0.4,
    y: 0.3,
    expectedKind: 'shape',
    expectedText: '',
    text: 'A shape label',
  });
  const edit = stepSchema.parse({
    action: 'edit-text',
    expectedText: 'A shape label',
    url,
    target: { x: 0.4, y: 0.3, expectedKind: 'shape', expectedText: 'A shape label' },
    start: 0,
    end: 1,
    format: { bold: true },
  });
  let expected = '',
    writes = 0;
  const a = {
    config: { directory: 'fixture' },
    inspect: async () => ({ viewId: 'view' }),
    readText: async (args) => {
      assert.equal(args.expectedKind, 'shape');
      return { targetId: 'shape-target', text: expected };
    },
    writeText: async (args) => {
      assert.equal(args.targetId, 'shape-target');
      writes++;
      return { verified: true };
    },
    text: {
      edit: async (args) => {
        assert.equal(args.targetId, 'shape-target');
        writes++;
        return { verified: true };
      },
    },
  };
  const c = new JobController(a);
  await c.dispatch(replace, 'shape-replace');
  expected = 'A shape label';
  await c.dispatch(edit, 'shape-format');
  assert.equal(writes, 2);
  expected = 'Remote change';
  await assert.rejects(c.dispatch(edit, 'shape-conflict'), (e) => e.code === 'TEXT_CONFLICT');
  assert.equal(writes, 2);
  assert.equal(targetSchema.safeParse({ query: 'label', expectedKind: 'shape' }).success, false);
  assert.equal(stepSchema.safeParse({ ...replace, expectedKind: 'ink' }).success, false);
  assert.equal(stepSchema.safeParse({ ...replace, text: '' }).success, true);
  assert.equal(
    stepSchema.safeParse({ ...replace, text: '', expectedKind: 'text-box' }).success,
    false,
  );
  assert.equal(
    stepSchema.safeParse({ ...replace, text: '', expectedKind: undefined }).success,
    false,
  );
  assert.equal(stepSchema.safeParse({ ...replace, text: '   ' }).success, false);
});
