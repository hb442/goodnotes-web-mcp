import { GoodnotesError } from './errors.mjs';
export async function frameAtPoint(page, point) {
  const frames = await page.locator('[id^="interaction-layer-page-"]').evaluateAll(
    (es, p) =>
      es
        .map((e) => {
          const b = e.getBoundingClientRect();
          return {
            pageId: e.id.slice('interaction-layer-page-'.length),
            x: b.x,
            y: b.y,
            width: b.width,
            height: b.height,
          };
        })
        .filter((b) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height),
    point,
  );
  if (frames.length !== 1)
    throw new GoodnotesError(
      'PAGE_FRAME_UNAVAILABLE',
      'The text point must be inside exactly one native page surface.',
    );
  return frames[0];
}
export async function pageFrame(page, pageId) {
  if (!/^[a-f0-9-]{36}$/i.test(pageId))
    throw new GoodnotesError('INVALID_PAGE_ID', 'A native sidebar page identity is required.');
  const element = page.locator('#interaction-layer-page-' + pageId);
  if ((await element.count()) !== 1)
    throw new GoodnotesError(
      'PAGE_FRAME_UNAVAILABLE',
      'The native page surface is not mounted exactly once.',
    );
  const b = await element.boundingBox();
  if (!b || b.width < 10 || b.height < 10)
    throw new GoodnotesError(
      'PAGE_FRAME_UNAVAILABLE',
      'The native page surface has no usable dimensions.',
    );
  return { pageId, ...b };
}
export function mapPageBounds(bounds, from, to) {
  const sx = to.width / from.width,
    sy = to.height / from.height;
  if (
    from.pageId !== to.pageId ||
    !Number.isFinite(sx + sy) ||
    sx < 0.05 ||
    sx > 20 ||
    Math.abs(sx / sy - 1) > 0.01
  )
    throw new GoodnotesError(
      'PAGE_FRAME_CHANGED',
      'Page identity or aspect ratio changed; cannot map object coordinates.',
    );
  return {
    x: to.x + (bounds.x - from.x) * sx,
    y: to.y + (bounds.y - from.y) * sy,
    width: bounds.width * sx,
    height: bounds.height * sy,
  };
}
