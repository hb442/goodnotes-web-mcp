import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPageBounds } from '../src/page-frame.mjs';
import { compareMappedRegions } from '../src/visual.mjs';
import { createCanvas } from '@napi-rs/canvas';
test('native page mapping follows zoom/pan but rejects another page and nonuniform aspect changes', () => {
  const a = { pageId: 'page', x: 100, y: 50, width: 500, height: 700 },
    b = { pageId: 'page', x: 200, y: 70, width: 750, height: 1050 };
  assert.deepEqual(mapPageBounds({ x: 150, y: 120, width: 100, height: 40 }, a, b), {
    x: 275,
    y: 175,
    width: 150,
    height: 60,
  });
  assert.throws(() =>
    mapPageBounds({ x: 1, y: 1, width: 1, height: 1 }, a, { ...b, pageId: 'other' }),
  );
  assert.throws(() => mapPageBounds({ x: 1, y: 1, width: 1, height: 1 }, a, { ...b, width: 500 }));
});
test('mapped visual verification accepts the same object at another zoom and detects recoloring', async () => {
  const draw = (scale, color) => {
    const c = createCanvas(500, 500),
      ctx = c.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 500, 500);
    ctx.translate(50, 50);
    ctx.scale(scale, scale);
    ctx.fillStyle = color;
    ctx.fillRect(10, 10, 120, 90);
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 3;
    ctx.strokeRect(20, 20, 100, 60);
    return c.toBuffer('image/png');
  };
  const first = { x: 50, y: 50, width: 140, height: 110 },
    second = { x: 50, y: 50, width: 210, height: 165 };
  assert.equal(
    (await compareMappedRegions(draw(1, 'yellow'), first, draw(1.5, 'yellow'), second)).matches,
    true,
  );
  assert.equal(
    (await compareMappedRegions(draw(1, 'yellow'), first, draw(1.5, 'red'), second)).matches,
    false,
  );
  await assert.rejects(
    compareMappedRegions(draw(1, 'yellow'), { ...first, x: -1 }, draw(1.5, 'yellow'), second),
    (e) => e.code === 'REGION_NOT_VISIBLE',
  );
});
