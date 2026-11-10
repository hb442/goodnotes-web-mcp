import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadImage } from '@napi-rs/canvas';
import { mutate, requireWritable } from './mutations.mjs';
import { GoodnotesError } from './errors.mjs';
import { compareRegion, regionHash } from './visual.mjs';
import { captureBoardViewport, restoreBoardViewport } from './viewport.mjs';

export class ImageController {
  constructor(adapter) {
    this.a = adapter;
  }
  async insert({ viewId, filePath, operationId }, options) {
    const a = this.a,
      view = a.getView(viewId);
    requireWritable(a, view);
    const ext = path.extname(filePath).toLowerCase();
    if (!path.isAbsolute(filePath) || !['.png', '.jpg', '.jpeg'].includes(ext))
      throw new GoodnotesError('INVALID_IMAGE', 'Provide an absolute local PNG or JPEG path.');
    const stat = await fs.stat(filePath);
    if (stat.size > 20 * 1024 * 1024)
      throw new GoodnotesError('IMAGE_TOO_LARGE', 'Image must be at most 20 MB.');
    const bytes = await fs.readFile(filePath);
    const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (bytes.length > 20 * 1024 * 1024 || !(ext === '.png' ? isPng : isJpeg))
      throw new GoodnotesError('INVALID_IMAGE', 'File bytes must match the PNG/JPEG extension.');
    const image = await loadImage(bytes);
    if (image.width * image.height > 40000000)
      throw new GoodnotesError('IMAGE_TOO_LARGE', 'Image must contain at most 40 million pixels.');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    return mutate(
      a,
      operationId,
      { action: 'insert-image', url: view.url, page: view.pageUrl, sha256 },
      async (mark) => {
        const page = await a.assertView(view);
        const checkpoint = await captureBoardViewport(page);
        await a.objects.commitSelection(page);
        await a.objects.captureBaseline(page, view);
        if (!(await page.locator('#editorTopbarTools').isVisible()))
          await page.locator('#changeEditMode').click();
        const before = await page.screenshot(),
          pending = page.waitForEvent('filechooser');
        pending.catch(() => {});
        await page.locator('#imageToolButton').click();
        const chooser = await pending;
        mark();
        await chooser.setFiles({
          name: 'image' + ext,
          mimeType: ext === '.png' ? 'image/png' : 'image/jpeg',
          buffer: bytes,
        });
        await page.waitForTimeout(1000);
        let selected = await a.objects.snapshot(page, view);
        a.objects.validateBounds(selected.bounds, view);
        await a.objects.readingMode(page);
        const expected = await page.screenshot(),
          box = {
            x: selected.bounds.x - 12,
            y: selected.bounds.y - 12,
            width: selected.bounds.width + 24,
            height: selected.bounds.height + 24,
          };
        if ((await regionHash(before, box)) === (await regionHash(expected, box)))
          throw new GoodnotesError('CREATE_UNVERIFIED', 'Image did not change the canvas.');
        await page.waitForTimeout(1200);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await a.openDocument(view.pageUrl);
        await a.closePanels(page);
        await restoreBoardViewport(a, page, view, checkpoint, options);
        await a.assertView(view);
        await a.objects.readingMode(page);
        const after = await page.screenshot(),
          appearance = await compareRegion(expected, after, box);
        if (!appearance.matches)
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Inserted image appearance differed after reload.',
          );
        selected = await a.objects.reselectBounds(page, view, selected.bounds);
        const selectionId = crypto.randomUUID();
        a.objects.selections.set(selectionId, {
          ...selected,
          viewId,
          kind: 'image',
          created: Date.now(),
        });
        await a.documents.invalidate(view.url);
        return {
          verified: true,
          verification: 'image-appearance-after-reload',
          selectionId,
          bounds: selected.bounds,
          sourceSha256: sha256,
          appearance,
          evidence: await a.objects.evidence(operationId, before, after),
          note: 'Inserted at the Goodnotes default position. Use transform_object to move or resize this selection.',
        };
      },
      options,
    );
  }
}
