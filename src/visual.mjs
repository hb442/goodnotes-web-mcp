import { createCanvas, loadImage } from '@napi-rs/canvas';
import crypto from 'node:crypto';
import { GoodnotesError, checkCancellation } from './errors.mjs';

export async function pixels(bytes) {
  const image = await loadImage(bytes),
    canvas = createCanvas(image.width, image.height),
    ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return {
    canvas,
    ctx,
    width: canvas.width,
    height: canvas.height,
    data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
  };
}
export async function compareMappedRegions(before, fromBounds, after, toBounds) {
  const a = await loadImage(before),
    b = await loadImage(after);
  for (const [im, r] of [
    [a, fromBounds],
    [b, toBounds],
  ])
    if (
      r.x < 0 ||
      r.y < 0 ||
      r.x + r.width > im.width ||
      r.y + r.height > im.height ||
      r.width < 8 ||
      r.height < 8
    )
      throw new GoodnotesError(
        'REGION_NOT_VISIBLE',
        'Both mapped object regions must be fully visible.',
      );
  const width = Math.ceil(Math.min(fromBounds.width, toBounds.width)),
    height = Math.ceil(Math.min(fromBounds.height, toBounds.height));
  const crop = (im, r) => {
    const c = createCanvas(width, height),
      ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, r.x, r.y, r.width, r.height, 0, 0, width, height);
    return c.toBuffer('image/png');
  };
  return {
    ...(await compareRegion(crop(a, fromBounds), crop(b, toBounds), { x: 0, y: 0, width, height })),
    mapped: true,
    comparedWidth: width,
    comparedHeight: height,
  };
}
export async function waitForMappedRegion(page, expected, fromBounds, toBounds, options = {}) {
  let comparison, bytes;
  // Re-read an already opened page while its native objects arrive. This never
  // sends or repeats document input, even when the final comparison fails.
  for (let attempt = 0; attempt < 4; attempt++) {
    checkCancellation(options.signal);
    if (attempt) await page.waitForTimeout(2000);
    checkCancellation(options.signal);
    bytes = options.capture
      ? await options.capture()
      : await page.screenshot({ animations: 'disabled' });
    comparison = await compareMappedRegions(expected, fromBounds, bytes, toBounds);
    if (comparison.matches) break;
  }
  return { comparison, bytes };
}
export async function selectionBounds(bytes, canvas, baseline) {
  const p = await pixels(bytes),
    previous = baseline ? await pixels(baseline) : null,
    blue = (x, y) => {
      const i = (y * p.width + x) * 4;
      if (
        previous &&
        previous.width === p.width &&
        previous.height === p.height &&
        [0, 1, 2].every((c) => Math.abs(previous.data[i + c] - p.data[i + c]) < 12)
      )
        return false;
      // Blue selection lines become darker when antialiased over black ink.
      return (
        p.data[i] < 180 &&
        p.data[i + 1] > 60 &&
        p.data[i + 1] < 225 &&
        p.data[i + 2] > 120 &&
        p.data[i + 2] - p.data[i] > 65 &&
        p.data[i + 2] - p.data[i + 1] > 22
      );
    };
  const horizontal = [],
    vertical = [];
  const minY = Math.max(110, Math.ceil(canvas.y)),
    maxY = Math.min(p.height - 35, Math.floor(canvas.y + canvas.height));
  for (let y = minY; y < maxY; y++) {
    let start = -1;
    for (let x = 1; x < p.width - 1; x++) {
      if (blue(x, y)) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        if (x - start >= 35) horizontal.push({ x: start, y, end: x - 1 });
        start = -1;
      }
    }
  }
  for (let x = 1; x < p.width - 1; x++) {
    let start = -1;
    for (let y = minY; y < maxY; y++) {
      if (blue(x, y)) {
        if (start < 0) start = y;
      } else if (start >= 0) {
        if (y - start >= 12) vertical.push({ x, y: start, end: y - 1 });
        start = -1;
      }
    }
  }
  if (horizontal.length < 2 || vertical.length < 2)
    throw new GoodnotesError(
      'NO_OBJECT_SELECTION',
      'No complete blue object bounding box is visible. Select one unlocked object fully inside the viewport.',
    );
  const horizontalTop = Math.min(...horizontal.map((l) => l.y)),
    horizontalBottom = Math.max(...horizontal.map((l) => l.y));
  const aligned = [...new Set(vertical.map((l) => l.x))].filter((x) => {
    let count = 0;
    for (let y = horizontalTop; y <= horizontalBottom; y++) if (blue(x, y)) count++;
    return count / (horizontalBottom - horizontalTop + 1) >= 0.55;
  });
  if (aligned.length < 2)
    throw new GoodnotesError('AMBIGUOUS_SELECTION', 'The visible frame edges do not align.');
  const left = Math.min(...aligned),
    right = Math.max(...aligned),
    top = Math.min(...horizontal.map((l) => l.y)),
    bottom = Math.max(...horizontal.map((l) => l.y));
  if (
    right - left < 20 ||
    bottom - top < 20 ||
    right - left > p.width * 0.95 ||
    bottom - top > p.height * 0.9
  )
    throw new GoodnotesError(
      'AMBIGUOUS_SELECTION',
      'The visible selection bounds are not safe to manipulate.',
    );
  const edgeCoverage = (horizontalEdge, position) => {
    let count = 0;
    const begin = horizontalEdge ? left : top,
      end = horizontalEdge ? right : bottom;
    for (let i = begin; i <= end; i++)
      if (horizontalEdge ? blue(i, position) : blue(position, i)) count++;
    return count / (end - begin + 1);
  };
  if (
    edgeCoverage(true, top) < 0.55 ||
    edgeCoverage(true, bottom) < 0.55 ||
    edgeCoverage(false, left) < 0.55 ||
    edgeCoverage(false, right) < 0.55
  )
    throw new GoodnotesError(
      'AMBIGUOUS_SELECTION',
      'Blue artwork or multiple frames obscure the selection boundary.',
    );
  return { x: left, y: top, width: right - left, height: bottom - top };
}
export async function regionHash(bytes, bounds) {
  const p = await pixels(bytes);
  const r = {
    x: Math.max(0, Math.round(bounds.x + 4)),
    y: Math.max(0, Math.round(bounds.y + 4)),
    width: Math.max(1, Math.round(bounds.width - 8)),
    height: Math.max(1, Math.round(bounds.height - 8)),
  };
  return crypto
    .createHash('sha256')
    .update(p.ctx.getImageData(r.x, r.y, r.width, r.height).data)
    .digest('hex');
}
export async function changedAlongLine(before, after, from, to) {
  const a = await pixels(before),
    b = await pixels(after),
    samples = Math.max(8, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 8));
  let changed = 0;
  for (let i = 0; i <= samples; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / samples),
      y = Math.round(from.y + ((to.y - from.y) * i) / samples);
    let hit = false;
    for (let dy = -3; dy <= 3 && !hit; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx,
          yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= a.width || yy >= a.height || xx >= b.width || yy >= b.height)
          continue;
        const ai = (yy * a.width + xx) * 4,
          bi = (yy * b.width + xx) * 4;
        if ([0, 1, 2].some((c) => Math.abs(a.data[ai + c] - b.data[bi + c]) > 25)) {
          hit = true;
          break;
        }
      }
    if (hit) changed++;
  }
  // Quantize the 90% threshold to whole samples. Short arrowhead segments have
  // nine samples; permit one rounded endpoint rather than requiring all nine.
  return { coverage: changed / (samples + 1), matches: changed >= Math.floor((samples + 1) * 0.9) };
}
export function nearBounds(a, b, tolerance = 4) {
  return ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) <= tolerance);
}

// Goodnotes uses different rasterizers for active objects and reloaded pages.
// Compare both directions with a two-pixel neighborhood, rather than requiring
// identical antialiasing. A hard mismatch cap prevents large blank/fill areas
// from hiding a missing small stroke. Typed text is also checked as exact text.
export async function compareRegion(before, after, bounds) {
  const a = await pixels(before),
    b = await pixels(after);
  const left = Math.max(2, Math.floor(bounds.x)),
    top = Math.max(2, Math.floor(bounds.y));
  const right = Math.min(a.width - 3, b.width - 3, Math.ceil(bounds.x + bounds.width));
  const bottom = Math.min(a.height - 3, b.height - 3, Math.ceil(bounds.y + bounds.height));
  const distance = (p, i, q, j) =>
    Math.max(
      Math.abs(p.data[i] - q.data[j]),
      Math.abs(p.data[i + 1] - q.data[j + 1]),
      Math.abs(p.data[i + 2] - q.data[j + 2]),
    );
  function mismatches(p, q) {
    let count = 0;
    for (let y = top; y <= bottom; y++)
      for (let x = left; x <= right; x++) {
        const i = (y * p.width + x) * 4;
        if (distance(p, i, q, (y * q.width + x) * 4) <= 40) continue;
        let matched = false,
          lo = null,
          hi = null,
          loL = Infinity,
          hiL = -Infinity;
        for (let dy = -2; dy <= 2 && !matched; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const j = ((y + dy) * q.width + x + dx) * 4;
            if (distance(p, i, q, j) <= 40) {
              matched = true;
              break;
            }
            const c = [q.data[j], q.data[j + 1], q.data[j + 2]],
              l = c[0] + c[1] + c[2];
            if (l < loL) {
              loL = l;
              lo = c;
            }
            if (l > hiL) {
              hiL = l;
              hi = c;
            }
          }
        // Antialiasing may use a different blend of the same local foreground and
        // background. Accept only colors on their RGB segment, not arbitrary hues.
        if (!matched && lo && hi) {
          const d = hi.map((v, k) => v - lo[k]),
            den = d.reduce((s, v) => s + v * v, 0);
          const t = den
            ? Math.max(
                0,
                Math.min(1, d.reduce((s, v, k) => s + (p.data[i + k] - lo[k]) * v, 0) / den),
              )
            : 0;
          matched = Math.max(...lo.map((v, k) => Math.abs(p.data[i + k] - (v + t * d[k])))) <= 25;
        }
        if (!matched) count++;
      }
    return count;
  }
  const missingPixels = mismatches(a, b),
    addedPixels = mismatches(b, a);
  return {
    matches: missingPixels <= 10 && addedPixels <= 10,
    missingPixels,
    addedPixels,
    positionTolerance: 2,
    colorTolerance: 40,
  };
}
