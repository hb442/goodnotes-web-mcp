import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { waitForMappedRegion } from '../src/visual.mjs';

test('mapped visual reads wait for late content, remain bounded for real changes and honor cancellation before another read', async () => {
  const canvas = createCanvas(100, 100),
    ctx = canvas.getContext('2d'),
    bounds = { x: 10, y: 10, width: 80, height: 80 };
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 100, 100);
  const blank = canvas.toBuffer('image/png');
  ctx.fillStyle = 'black';
  ctx.fillRect(30, 30, 30, 30);
  const expected = canvas.toBuffer('image/png');
  let reads = 0,
    waits = 0;
  const page = {
    screenshot: async () => (++reads === 1 ? blank : expected),
    waitForTimeout: async (ms) => {
      assert.equal(ms, 2000);
      waits++;
    },
  };
  const result = await waitForMappedRegion(page, expected, bounds, bounds);
  assert.equal(result.comparison.matches, true);
  assert.equal(reads, 2);
  assert.equal(waits, 1);
  assert.deepEqual(result.bytes, expected);
  let captures = 0;
  const isolated = await waitForMappedRegion(page, expected, bounds, bounds, {
    capture: async () => {
      captures++;
      return expected;
    },
  });
  assert.equal(isolated.comparison.matches, true);
  assert.equal(captures, 1);
  assert.equal(reads, 2);
  reads = 0;
  waits = 0;
  page.screenshot = async () => {
    reads++;
    return blank;
  };
  assert.equal(
    (await waitForMappedRegion(page, expected, bounds, bounds)).comparison.matches,
    false,
  );
  assert.equal(reads, 4);
  assert.equal(waits, 3);
  const controller = new AbortController();
  reads = 0;
  page.waitForTimeout = async () => controller.abort();
  await assert.rejects(
    waitForMappedRegion(page, expected, bounds, bounds, { signal: controller.signal }),
    (e) => e.code === 'CANCELLED',
  );
  assert.equal(reads, 1);
});
