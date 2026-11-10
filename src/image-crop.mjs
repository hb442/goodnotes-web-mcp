import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { mutate, requireWritable } from './mutations.mjs';
import { frameAtPoint, pageFrame, mapPageBounds } from './page-frame.mjs';
import { compareMappedRegions } from './visual.mjs';
import { writeJson } from './store.mjs';

export function validateCrop(region) {
  if (
    !region ||
    !['x', 'y', 'width', 'height'].every((k) => Number.isFinite(region[k])) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width <= 0 ||
    region.height <= 0 ||
    region.x + region.width > 1.000001 ||
    region.y + region.height > 1.000001
  )
    throw new GoodnotesError(
      'INVALID_CROP',
      'Use a positive rectangle wholly within the source image, in fractions from zero to one.',
    );
  return region;
}
export function sameCrop(a, b, size, tolerance = 1.5) {
  return (
    ['x', 'width'].every((k) => Math.abs(a[k] - b[k]) * size.width <= tolerance) &&
    ['y', 'height'].every((k) => Math.abs(a[k] - b[k]) * size.height <= tolerance)
  );
}
export async function verifyCropPixels(original, region, saved) {
  if (saved.sourceSha256 === original.sourceSha256 && sameCrop(saved.region, region, saved.size))
    return { matches: true, mode: 'retained-source', destructive: false };
  const width = region.width * original.size.width,
    height = region.height * original.size.height;
  if (
    !sameCrop(saved.region, { x: 0, y: 0, width: 1, height: 1 }, saved.size, 0.5) ||
    Math.abs(saved.size.width - width) > 1 ||
    Math.abs(saved.size.height - height) > 1
  )
    return { matches: false, reason: 'saved-source-size-or-rectangle-changed' };
  const sourceBounds = {
    x: Math.floor(region.x * original.size.width),
    y: Math.floor(region.y * original.size.height),
    width: saved.size.width,
    height: saved.size.height,
  };
  if (
    sourceBounds.x + sourceBounds.width > original.size.width ||
    sourceBounds.y + sourceBounds.height > original.size.height
  )
    return { matches: false, reason: 'cropped-source-outside-original' };
  const pixels = await compareMappedRegions(original.sourceBytes, sourceBounds, saved.sourceBytes, {
    x: 0,
    y: 0,
    ...saved.size,
  });
  return { ...pixels, mode: 'cropped-source', destructive: true, sourceBounds };
}
export async function readCrop(page, { source = true } = {}) {
  const modal = page.locator('#cropModal');
  await modal.waitFor({ state: 'visible' });
  const image = modal.getByRole('img', { name: 'Crop preview', exact: true });
  await image.waitFor({ state: 'visible' });
  const dimensions = await image.evaluate((img) => ({
    width: img.naturalWidth,
    height: img.naturalHeight,
    complete: img.complete,
  }));
  if (
    !dimensions.complete ||
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width * dimensions.height > 40000000
  )
    throw new GoodnotesError(
      'CROP_SOURCE_UNAVAILABLE',
      'The crop source is not loaded or exceeds forty million pixels.',
    );
  const imageBounds = await image.boundingBox(),
    rect = await modal.getByTestId('crop-rectangle-top-left-handle').locator('..').boundingBox();
  if (
    !imageBounds ||
    !rect ||
    Math.abs(imageBounds.width / imageBounds.height - dimensions.width / dimensions.height) > 0.02
  )
    throw new GoodnotesError(
      'CROP_LAYOUT_UNSUPPORTED',
      'Cannot map the native preview to its source image.',
    );
  const region = {
    x: (rect.x - imageBounds.x) / imageBounds.width,
    y: (rect.y - imageBounds.y) / imageBounds.height,
    width: rect.width / imageBounds.width,
    height: rect.height / imageBounds.height,
  };
  for (const k of ['x', 'y']) if (Math.abs(region[k]) < 0.00001) region[k] = 0;
  validateCrop(region);
  const result = {
    region,
    size: { width: dimensions.width, height: dimensions.height },
    imageBounds,
  };
  if (source) {
    const data = await image.evaluate((img) => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png').split(',')[1];
    });
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > 20 * 1024 * 1024)
      throw new GoodnotesError(
        'CROP_SOURCE_TOO_LARGE',
        'The native image snapshot exceeds twenty MB.',
      );
    result.sourceBytes = bytes;
    result.sourceSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  return result;
}
export async function positionCrop(page, region, drag, { signal } = {}) {
  validateCrop(region);
  const initial = await readCrop(page, { source: false }),
    b = initial.imageBounds;
  if (region.width * b.width < 12 || region.height * b.height < 12)
    throw new GoodnotesError(
      'CROP_TOO_SMALL',
      'The requested crop must be at least twelve visible preview pixels in each direction.',
    );
  const move = async (name, x, y) => {
    checkCancellation(signal);
    const handle = page.getByTestId(name),
      h = await handle.boundingBox(),
      r = await handle.locator('..').boundingBox();
    if (!h || !r)
      throw new GoodnotesError('CROP_HANDLE_UNAVAILABLE', 'The native crop handle disappeared.');
    const center = { x: h.x + h.width / 2, y: h.y + h.height / 2 },
      tl = name.includes('top-left'),
      corner = { x: r.x + (tl ? 0 : r.width), y: r.y + (tl ? 0 : r.height) };
    await drag(page, center, {
      x: b.x + x * b.width + center.x - corner.x,
      y: b.y + y * b.height + center.y - corner.y,
    });
  };
  // Expand the draft before narrowing it so an old crop cannot clamp a handle.
  await move('crop-rectangle-top-left-handle', 0, 0);
  await move('crop-rectangle-bottom-right-handle', 1, 1);
  await move('crop-rectangle-top-left-handle', region.x, region.y);
  await move(
    'crop-rectangle-bottom-right-handle',
    region.x + region.width,
    region.y + region.height,
  );
  let selected = await readCrop(page, { source: false });
  for (
    let attempt = 0;
    attempt < 2 && !sameCrop(selected.region, region, { width: b.width, height: b.height });
    attempt++
  ) {
    await move('crop-rectangle-top-left-handle', region.x, region.y);
    await move(
      'crop-rectangle-bottom-right-handle',
      region.x + region.width,
      region.y + region.height,
    );
    selected = await readCrop(page, { source: false });
  }
  if (!sameCrop(selected.region, region, { width: b.width, height: b.height }))
    throw new GoodnotesError(
      'CROP_POSITION_UNVERIFIED',
      'The native crop handles did not reach the requested rectangle. The draft has not been applied.',
      { requested: region, actual: selected.region },
    );
  return selected;
}
export class ImageCropController {
  constructor(adapter) {
    this.a = adapter;
    this.preparations = new Map();
  }
  async open(page) {
    const button = page.locator('#shared_menu_options_crop_image');
    if (!(await button.isVisible().catch(() => false)))
      throw new GoodnotesError(
        'NOT_AN_IMAGE',
        'Select one image offering the native Crop Image control.',
      );
    await button.click();
    await page.locator('#cropModal').waitFor({ state: 'visible' });
    const rectangle = page.locator('#cropModalRectangleToggle');
    await rectangle.click();
  }
  async cancel(page) {
    const b = page.locator('#cropModalCancelButton');
    if (await b.isVisible().catch(() => false)) {
      await b.click();
      await page.locator('#cropModal').waitFor({ state: 'hidden' });
    }
  }
  async prepare({ selectionId }) {
    const { s, view, page } = await this.a.styles.selection(selectionId);
    let state;
    try {
      await this.open(page);
      state = await readCrop(page);
    } finally {
      await this.cancel(page);
    }
    const cropId = crypto.randomUUID();
    this.preparations.clear();
    this.preparations.set(cropId, { selectionId, viewId: view.viewId, state, created: Date.now() });
    return {
      cropId,
      viewId: view.viewId,
      selectionId,
      region: state.region,
      sourceSize: state.size,
      sourceSha256: state.sourceSha256,
      bounds: s.bounds,
      expiresInSeconds: 600,
      note: 'Rectangle coordinates refer to the current native source preview. Goodnotes can replace that source with cropped pixels; a later crop cannot reveal removed content. Applying saves the original source privately. This read cancels the draft.',
    };
  }
  async apply({ cropId, region, operationId }, options) {
    validateCrop(region);
    const record = this.preparations.get(cropId);
    if (!record || Date.now() - record.created > 600000)
      throw new GoodnotesError('STALE_CROP', 'Prepare the image crop again.');
    const a = this.a,
      { s, view } = await a.styles.selection(record.selectionId);
    requireWritable(a, view);
    return mutate(
      a,
      operationId,
      {
        action: 'crop-image',
        url: view.url,
        page: view.pageUrl,
        bounds: s.bounds,
        hash: s.hash,
        sourceSha256: record.state.sourceSha256,
        previousCrop: record.state.region,
        region,
      },
      async (mark) => {
        const { page, fresh } = await a.styles.selection(record.selectionId);
        const originalFrame = await frameAtPoint(page, {
          x: s.bounds.x + s.bounds.width / 2,
          y: s.bounds.y + s.bounds.height / 2,
        });
        try {
          await this.open(page);
          const current = await readCrop(page);
          if (
            current.sourceSha256 !== record.state.sourceSha256 ||
            !sameCrop(current.region, record.state.region, current.size)
          )
            throw new GoodnotesError(
              'IMAGE_CHANGED',
              'The native crop source or rectangle changed since preparation.',
            );
          if (sameCrop(region, current.region, current.size, 0.5))
            return {
              verified: true,
              changed: false,
              region: current.region,
              sourceSha256: current.sourceSha256,
            };
          const draft = await positionCrop(page, region, a.objects.drag.bind(a.objects), options);
          const directory = path.join(a.config.directory, 'image-checkpoints'),
            sourcePath = path.join(directory, operationId + '-source.png'),
            checkpointPath = path.join(directory, operationId + '.json');
          await fs.mkdir(directory, { recursive: true, mode: 0o700 });
          await fs.writeFile(sourcePath, current.sourceBytes, { mode: 0o600 });
          await writeJson(checkpointPath, {
            operationId,
            url: view.url,
            pageUrl: view.pageUrl,
            title: view.title,
            sourceSha256: current.sourceSha256,
            sourcePath,
            previousCrop: current.region,
            requestedCrop: region,
            appliedDraft: draft.region,
          });
          mark();
          await page.locator('#cropModalDoneButton').click();
          await page.locator('#cropModal').waitFor({ state: 'hidden' });
          await page.waitForTimeout(400);
          const selected = await a.objects.snapshot(page, view);
          a.objects.validateBounds(selected.bounds, view);
          const writtenFrame = await pageFrame(page, originalFrame.pageId);
          await a.objects.readingMode(page);
          const expected = await page.screenshot();
          await page.waitForTimeout(1200);
          await page.reload({ waitUntil: 'domcontentloaded' });
          const reopened = await a.inspect({ url: view.pageUrl });
          if (reopened.url !== view.url || reopened.title !== view.title)
            throw new GoodnotesError('DOCUMENT_CHANGED', 'The crop target document changed.');
          requireWritable(a, reopened);
          const savedFrame = await pageFrame(page, originalFrame.pageId),
            mapped = mapPageBounds(selected.bounds, writtenFrame, savedFrame);
          a.objects.validateBounds(mapped, reopened);
          await a.objects.readingMode(page);
          const after = await page.screenshot(),
            appearance = await compareMappedRegions(expected, selected.bounds, after, mapped);
          if (!appearance.matches)
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'Cropped image appearance differed after reload.',
              { appearance, evidence: await a.objects.evidence(operationId, fresh.bytes, after) },
            );
          const restored = await a.objects.select({
            viewId: reopened.viewId,
            x: (mapped.x + mapped.width / 2 - reopened.canvas.x) / reopened.canvas.width,
            y: (mapped.y + mapped.height / 2 - reopened.canvas.y) / reopened.canvas.height,
          });
          await this.open(page);
          const saved = await readCrop(page);
          const cropPixels = await verifyCropPixels(current, draft.region, saved);
          if (!cropPixels.matches)
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'The native image pixels or saved crop rectangle differed after reload.',
              { cropPixels },
            );
          await this.cancel(page);
          this.preparations.clear();
          await a.documents.invalidate(view.url);
          return {
            verified: true,
            changed: true,
            verification: 'native-cropped-pixels-and-appearance-after-reload',
            viewId: reopened.viewId,
            selectionId: restored.selectionId,
            bounds: restored.bounds,
            appliedCrop: draft.region,
            region: saved.region,
            previousCrop: current.region,
            originalSourceSha256: current.sourceSha256,
            sourceSha256: saved.sourceSha256,
            sourceSize: saved.size,
            checkpointPath,
            sourcePath,
            cropPixels,
            appearance,
            evidence: await a.objects.evidence(operationId, fresh.bytes, after),
          };
        } finally {
          await this.cancel(page).catch(() => {});
        }
      },
      options,
    );
  }
}
