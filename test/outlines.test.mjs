import test from 'node:test';
import assert from 'node:assert/strict';
import { stepSchema, validateReferences, resolveStep } from '../src/job-schema.mjs';
import { JobController } from '../src/jobs.mjs';

test('outline batches chain only verified outline/page hashes and dispatch distinct rename/delete actions', async () => {
  const url = 'https://web.goodnotes.com/s/SyntheticOutlineBatch',
    id = '00000000-0000-4000-8000-000000000001',
    steps = [
      { action: 'list-outlines', url },
      {
        action: 'rename-outline',
        url: { fromStep: 0, field: 'url' },
        outlineId: id,
        expectedTitle: 'Alpha',
        title: 'Beta',
        expectedOutlineHash: { fromStep: 0, field: 'outlineHash' },
        expectedPageOrderHash: { fromStep: 0, field: 'pageOrderHash' },
      },
      {
        action: 'delete-outline',
        url: { fromStep: 1, field: 'url' },
        outlineId: id,
        expectedTitle: 'Beta',
        expectedOutlineHash: { fromStep: 1, field: 'outlineHash' },
        expectedPageOrderHash: { fromStep: 1, field: 'pageOrderHash' },
      },
    ].map((s) => stepSchema.parse(s));
  validateReferences(steps);
  assert.throws(
    () =>
      validateReferences([
        steps[0],
        { ...steps[1], expectedPageOrderHash: { fromStep: 0, field: 'outlineHash' } },
      ]),
    (e) => e.code === 'INVALID_REFERENCE',
  );
  assert.throws(
    () => resolveStep(steps[1], [{ status: 'uncertain', result: { url } }]),
    (e) => e.code === 'REFERENCE_UNAVAILABLE',
  );
  const resolved = resolveStep(steps[1], [
    {
      status: 'verified',
      result: { url, outlineHash: 'a'.repeat(64), pageOrderHash: 'b'.repeat(64) },
    },
  ]);
  assert.equal(resolved.expectedOutlineHash, 'a'.repeat(64));
  const calls = [],
    c = new JobController({
      config: { directory: '.' },
      outlines: {
        manage: async (args) => {
          calls.push(args);
          return { verified: true };
        },
        list: async () => ({ count: 1 }),
      },
    });
  await c.dispatch(resolved, 'outline-batch-001', {});
  assert.equal(calls[0].command, 'rename');
  assert.equal(calls[0].title, 'Beta');
  await c.dispatch({ ...resolved, action: 'delete-outline' }, 'outline-batch-002', {});
  assert.equal(calls[1].command, 'delete');
  assert.equal((await c.dispatch(steps[0], 'outline-batch-list', {})).count, 1);
});
