import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeShapeStyle,
  setMeasuredSlider,
  matchingShapeBounds,
} from '../src/shape-style.mjs';
import { shapeStyleSchema, concreteStepSchema } from '../src/job-schema.mjs';
import { JobController } from '../src/jobs.mjs';

test('shape unlock batches preserve the explicit kind and require preparation before mutation', async () => {
  const step = concreteStepSchema.parse({
    action: 'unlock-object',
    url: 'https://web.goodnotes.com/s/TestShapeLock',
    x: 0.4,
    y: 0.3,
    kind: 'shape',
  });
  let calls = [];
  const a = {
    config: { directory: 'fixture' },
    inspect: async () => ({ viewId: 'view' }),
    styles: {
      prepareUnlock: async (args) => {
        assert.equal(args.kind, 'shape');
        assert.equal(args.viewId, 'view');
        calls.push('prepare');
        return { unlockId: 'prepared' };
      },
      unlockObject: async (args) => {
        assert.equal(args.unlockId, 'prepared');
        calls.push('unlock');
        return { verified: true };
      },
    },
  };
  await new JobController(a).dispatch(step, 'shape-unlock-batch');
  assert.deepEqual(calls, ['prepare', 'unlock']);
  calls = [];
  a.styles.prepareUnlock = async () => {
    throw new Error('Wrong native control');
  };
  await assert.rejects(
    new JobController(a).dispatch(step, 'shape-unlock-rejected'),
    /Wrong native control/,
  );
  assert.deepEqual(calls, []);
  assert.equal(concreteStepSchema.safeParse({ ...step, kind: 'group' }).success, false);
});

test('shape style validates conservative exact ranges and exposes batch dispatch', async () => {
  const bounds = { x: 100, y: 200, width: 200, height: 150 };
  assert.equal(matchingShapeBounds(bounds, { x: 98, y: 198, width: 204, height: 154 }), true);
  assert.equal(matchingShapeBounds(bounds, { x: 98, y: 198, width: 207, height: 154 }), false);
  assert.equal(matchingShapeBounds(bounds, { ...bounds, x: 104 }), false);
  for (const value of [
    {},
    { thicknessMm: 2.01 },
    { thicknessMm: 0.005 },
    { fillOpacityPercent: 101 },
    { fillOpacityPercent: 25 },
    { fillOpacityPercent: 2.5 },
    { fillEnabled: true },
  ]) {
    assert.throws(() => normalizeShapeStyle(value));
    assert.equal(shapeStyleSchema.safeParse(value).success, false);
  }
  assert.deepEqual(normalizeShapeStyle({ fillOpacityPercent: 0, thicknessMm: 1.25 }), {
    fillOpacityPercent: 0,
    thicknessMm: 1.25,
  });
  const step = concreteStepSchema.parse({
    action: 'shape-style',
    url: 'https://web.goodnotes.com/s/TestShapeStyle123',
    target: { x: 0.4, y: 0.4 },
    style: { fillOpacityPercent: 50 },
  });
  let selected = false,
    applied = false;
  const a = {
    config: { directory: 'fixture' },
    inspect: async () => ({ viewId: 'view' }),
    shapeStyle: {
      prepare: async ({ selectionId }) => {
        assert.equal(selectionId, 'selection');
        return { styleId: 'style' };
      },
      apply: async (args) => {
        assert.equal(args.styleId, 'style');
        assert.equal(args.style.fillOpacityPercent, 50);
        applied = true;
        return { verified: true };
      },
    },
  };
  const jobs = new JobController(a);
  jobs.target = async () => {
    selected = true;
    return { selectionId: 'selection' };
  };
  await jobs.dispatch(step, 'shape-batch');
  assert.ok(selected && applied);
});

test('measured sliders stop after bounded inputs and respect cancellation before input', async () => {
  let writes = 0;
  const page = { mouse: { click: async () => writes++ }, waitForTimeout: async () => {} },
    slider = {
      boundingBox: async () => ({ x: 0, y: 0, width: 280, height: 20 }),
      evaluate: async () => true,
    };
  await assert.rejects(
    setMeasuredSlider(
      page,
      slider,
      async () => 0.7,
      1.2,
      () => {},
    ),
    (e) => e.code === 'STYLE_STEP_UNSUPPORTED',
  );
  assert.equal(writes, 16);
  slider.evaluate = async () => false;
  await assert.rejects(
    setMeasuredSlider(
      page,
      slider,
      async () => 0.7,
      1.2,
      () => {},
    ),
    (e) => e.code === 'SLIDER_OBSCURED',
  );
  assert.equal(writes, 16);
  await assert.rejects(
    setMeasuredSlider(
      page,
      slider,
      async () => 0.7,
      1.2,
      () => {},
      { signal: AbortSignal.abort() },
    ),
  );
  assert.equal(writes, 16);
});

test('batch native shape creation accepts only implemented native shape kinds', () => {
  for (const kind of ['rectangle', 'ellipse', 'triangle', 'diamond', 'rounded-rectangle']) {
    assert.equal(
      concreteStepSchema.safeParse({
        action: 'create-object',
        url: 'https://web.goodnotes.com/s/ShapeFixture',
        kind,
        x: 0.3,
        y: 0.3,
        width: 0.2,
        height: 0.2,
      }).success,
      true,
    );
  }
  assert.equal(
    concreteStepSchema.safeParse({
      action: 'create-object',
      url: 'https://web.goodnotes.com/s/ShapeFixture',
      kind: 'heart',
      x: 0.3,
      y: 0.3,
    }).success,
    false,
  );
});
