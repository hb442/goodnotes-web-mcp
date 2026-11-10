import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { verifyCropPixels, ImageCropController } from '../src/image-crop.mjs';
test('crop verification accepts native pixel replacement but rejects wrong size, content and removed strokes', async () => {
  const c = createCanvas(160, 100),
    ctx = c.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 160, 100);
  ctx.fillStyle = '#bb3322';
  ctx.fillRect(30, 30, 100, 40);
  ctx.fillStyle = 'black';
  ctx.fillRect(50, 30, 3, 40);
  const region = { x: 0.125, y: 0.2, width: 0.75, height: 0.6 },
    out = createCanvas(120, 60),
    oc = out.getContext('2d');
  oc.drawImage(c, 20, 20, 120, 60, 0, 0, 120, 60);
  const original = {
      sourceBytes: c.toBuffer('image/png'),
      sourceSha256: 'original',
      size: { width: 160, height: 100 },
    },
    saved = {
      sourceBytes: out.toBuffer('image/png'),
      sourceSha256: 'cropped',
      size: { width: 120, height: 60 },
      region: { x: 0, y: 0, width: 1, height: 1 },
    };
  assert.equal((await verifyCropPixels(original, region, saved)).matches, true);
  assert.equal(
    (await verifyCropPixels(original, region, { ...saved, size: { width: 124, height: 60 } }))
      .matches,
    false,
  );
  oc.fillStyle = '#bb3322';
  oc.fillRect(30, 10, 3, 40);
  assert.equal(
    (await verifyCropPixels(original, region, { ...saved, sourceBytes: out.toBuffer('image/png') }))
      .matches,
    false,
  );
  assert.equal(
    (
      await verifyCropPixels(original, region, {
        ...saved,
        sourceSha256: 'original',
        region,
        size: original.size,
      })
    ).mode,
    'retained-source',
  );
});
test('crop preparation handles expire and unauthorized selections reject before starting a mutation', async () => {
  let writes = 0;
  const view = { url: 'https://web.goodnotes.com/s/TestImageDocument', title: 'Test' },
    c = new ImageCropController({
      styles: { selection: async () => ({ view, s: {} }) },
      config: { documents: [] },
      journal: { begin: () => writes++ },
    });
  await assert.rejects(
    c.apply({
      cropId: 'missing',
      region: { x: 0, y: 0, width: 1, height: 1 },
      operationId: 'crop-stale',
    }),
    (e) => e.code === 'STALE_CROP',
  );
  c.preparations.set('allowed', { created: Date.now(), selectionId: 'one' });
  await assert.rejects(
    c.apply({
      cropId: 'allowed',
      region: { x: 0, y: 0, width: 1, height: 1 },
      operationId: 'crop-denied',
    }),
    (e) => e.code === 'WRITE_NOT_ALLOWED',
  );
  assert.equal(writes, 0);
});
