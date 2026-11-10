import { GoodnotesError, checkCancellation } from './errors.mjs';

// Reloading a whiteboard resets its camera without changing the document URL.
export async function captureBoardViewport(page) {
  const frames = await page.locator('[id^="interaction-layer-page-"]').evaluateAll((elements) =>
    elements.flatMap((element) => {
      const b = element.getBoundingClientRect();
      if (b.width <= 10000 || b.height <= 10000) return [];
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return [
        {
          pageId: element.id,
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          scale: matrix.a,
          rotated: Math.abs(matrix.b) + Math.abs(matrix.c) > 1e-6,
        },
      ];
    }),
  );
  if (!frames.length) return null;
  if (frames.length !== 1 || frames[0].rotated || !(frames[0].scale > 0))
    throw new GoodnotesError(
      'BOARD_ANCHOR_UNAVAILABLE',
      'Cannot capture one unrotated native board surface.',
    );
  return frames[0];
}

export async function restoreBoardViewport(adapter, page, view, checkpoint, options = {}) {
  if (!checkpoint) return;
  checkCancellation(options.signal);
  const title = (await page.locator('#infoButton').innerText()).trim();
  if (page.url() !== view.pageUrl || title !== view.title)
    throw new GoodnotesError(
      'DOCUMENT_CHANGED',
      'The document identity changed during reload verification.',
    );
  const restored = await adapter.scans.position(view.pageUrl, checkpoint, options);
  if (
    restored.view.url !== view.url ||
    restored.view.title !== view.title ||
    restored.view.zoom !== view.zoom ||
    JSON.stringify(restored.view.viewport) !== JSON.stringify(view.viewport)
  )
    throw new GoodnotesError(
      'VIEW_RESTORE_UNVERIFIED',
      'The original board view could not be restored.',
    );
  // Navigation invalidates targets/selections. Preserve only the restored view.
  // Callers still verify their captured exact text, formatting, kind or pixels.
  adapter.views.set(view.viewId, { ...view, created: Date.now() });
  await adapter.assertView(view);
}
