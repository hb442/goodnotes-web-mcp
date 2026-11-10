import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectController } from '../src/objects.mjs';
import { GoodnotesError } from '../src/errors.mjs';

test('only a timed-out native selection menu becomes a retryable empty selection', async () => {
  const c = new ObjectController({});
  const page = (error) => ({
    locator: () => ({
      waitFor: async () => {
        throw error;
      },
    }),
  });
  await assert.rejects(
    c.selectionMenu(page(Object.assign(new Error('late menu'), { name: 'TimeoutError' }))),
    (e) => e.code === 'NO_OBJECT_SELECTION',
  );
  const closed = new Error('Target page closed');
  await assert.rejects(c.selectionMenu(page(closed)), (e) => e === closed);
});

test('late object rendering permits only bounded fresh selection attempts and respects cancellation', async () => {
  let calls = 0,
    waits = 0,
    clears = 0;
  const controller = new ObjectController({
    getPage: async () => ({ waitForTimeout: async () => waits++ }),
  });
  controller.commitSelection = async () => clears++;
  controller.selectOnce = async () => {
    calls++;
    if (calls < 3) throw new GoodnotesError('AMBIGUOUS_SELECTION', 'Late blue artwork');
    return { selectionId: 'settled' };
  };
  assert.deepEqual(await controller.select({ viewId: 'view', region: {} }), {
    selectionId: 'settled',
  });
  assert.equal(calls, 3);
  assert.equal(waits, 2);
  assert.equal(clears, 2);
  calls = 0;
  controller.selectOnce = async () => {
    calls++;
    throw new GoodnotesError('NO_OBJECT_SELECTION', 'No object');
  };
  await assert.rejects(
    controller.select({ viewId: 'view' }),
    (e) => e.code === 'NO_OBJECT_SELECTION',
  );
  assert.equal(calls, 3);
  calls = 0;
  controller.selectOnce = async () => {
    calls++;
    throw new GoodnotesError('VIEW_CHANGED', 'Do not retry a changed page');
  };
  await assert.rejects(controller.select({ viewId: 'view' }), (e) => e.code === 'VIEW_CHANGED');
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(controller.select({ viewId: 'view' }, { signal: AbortSignal.abort() }));
  assert.equal(calls, 0);
});
