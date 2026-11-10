import { readJson, writeJson } from './store.mjs';
import { documentUrl } from './config.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { mutate, requireWritable } from './mutations.mjs';
import {
  selectionBounds,
  regionHash,
  nearBounds,
  compareRegion,
  waitForMappedRegion,
  compareMappedRegions,
} from './visual.mjs';
import { pageFrame, mapPageBounds, frameAtPoint } from './page-frame.mjs';
import { digest } from './journal.mjs';
import { configureInk } from './ink-style.mjs';
import { sameCrop, validateCrop } from './image-crop.mjs';
import { captureBoardViewport, restoreBoardViewport } from './viewport.mjs';

export function validateVisualPaste(visual, view, destinationFrame, point) {
  const percent = (v) =>
    typeof v === 'string' && /^\d+(?:\.\d+)?%$/.test(v) ? parseFloat(v) : NaN;
  const scale = percent(view.zoom) / percent(visual.sourceZoom);
  if (!Number.isFinite(scale) || scale <= 0)
    throw new GoodnotesError(
      'COPY_ZOOM_UNAVAILABLE',
      'Native lasso copying requires readable numeric source and destination zoom.',
    );
  const w = visual.sourceBounds.width * scale,
    h = visual.sourceBounds.height * scale;
  if (
    point.x - w / 2 < Math.max(view.canvas.x + 30, destinationFrame.x + 15) ||
    point.y - h / 2 < Math.max(view.canvas.y + 60, destinationFrame.y + 15) ||
    point.x + w / 2 >
      Math.min(
        view.canvas.x + view.canvas.width - 30,
        destinationFrame.x + destinationFrame.width - 15,
      ) ||
    point.y + h / 2 >
      Math.min(
        view.canvas.y + view.canvas.height - 50,
        destinationFrame.y + destinationFrame.height - 15,
      )
  )
    throw new GoodnotesError(
      'PASTE_SELECTION_NOT_VISIBLE',
      'Choose a more central position or reduce the selection so its estimated full size fits the visible destination page. No paste was sent.',
    );
}
const EDITOR = '.ql-editor[contenteditable="true"]';
export async function nativeTextSelectionBounds(page, canvas) {
  const frames = await page.locator('.rich-text-controls-border').evaluateAll((elements) => {
    const visible = (e) => {
      const b = e.getBoundingClientRect(),
        s = getComputedStyle(e);
      return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    return elements.filter(visible).map((e) => {
      const b = e.getBoundingClientRect(),
        controls = e.parentElement;
      const container = e.closest('.rich-text-view-container');
      const handles = [...controls.querySelectorAll('.rich-text-resize-handle')].filter(visible);
      const editors = container
        ? [...container.querySelectorAll('.ql-editor')].filter(visible)
        : [];
      let rotated = false;
      for (let p = e; p; p = p.parentElement) {
        const m = new DOMMatrixReadOnly(getComputedStyle(p).transform);
        if (Math.abs(m.b) + Math.abs(m.c) > 1e-6) rotated = true;
      }
      const side = (name, x) =>
        handles.filter((h) => {
          const r = h.getBoundingClientRect();
          return (
            h.dataset.testid === 'rich-text-resize-handle-' + name &&
            Math.abs(r.x + r.width / 2 - x) < 3 &&
            Math.abs(r.y + r.height / 2 - b.y - b.height / 2) < 3
          );
        }).length === 1;
      const text = editors[0]?.getBoundingClientRect();
      return {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        valid:
          !rotated &&
          handles.length === 2 &&
          side('left', b.x) &&
          side('right', b.right) &&
          editors.length === 1 &&
          text.x >= b.x - 2 &&
          text.y >= b.y - 2 &&
          text.right <= b.right + 2 &&
          text.bottom <= b.bottom + 2,
      };
    });
  });
  if (!frames.length) return null;
  const b = frames[0];
  if (
    frames.length !== 1 ||
    !b.valid ||
    b.width < 20 ||
    b.height < 20 ||
    b.x < canvas.x + 2 ||
    b.y < Math.max(110, canvas.y + 2) ||
    b.x + b.width > canvas.x + canvas.width - 2 ||
    b.y + b.height > canvas.y + canvas.height - 35
  )
    throw new GoodnotesError(
      'AMBIGUOUS_SELECTION',
      'Native text selection requires one complete, unrotated frame with two matching handles and one contained editor.',
    );
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  };
}
export class ObjectController {
  constructor(adapter) {
    this.a = adapter;
    this.selections = new Map();
    this.handwriting = new Map();
    this.baselines = new WeakMap();
  }
  async captureBaseline(page, view) {
    await page.mouse.move(5, page.viewportSize().height - 5);
    await page.waitForTimeout(120);
    this.baselines.set(page, {
      viewId: view.viewId,
      bytes: await page.screenshot({ animations: 'disabled' }),
    });
  }
  async tool(page, id) {
    const toolbar = page.locator('#editorTopbarTools');
    await toolbar.waitFor({ state: 'attached' });
    if (!(await toolbar.isVisible())) await page.locator('#changeEditMode').click();
    const button = page.locator(id);
    await button.waitFor({ state: 'visible' });
    if ((await button.getAttribute('data-is-selected')) !== 'true') await button.click();
    await this.a.dismissKnownPopups(page);
    await page.waitForTimeout(250);
  }
  point(view, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0.02 || x > 0.98 || y < 0.08 || y > 0.92)
      throw new GoodnotesError(
        'INVALID_POSITION',
        'Keep the target inside the visible canvas, away from toolbars.',
      );
    return { x: view.canvas.x + x * view.canvas.width, y: view.canvas.y + y * view.canvas.height };
  }
  async drag(page, from, to) {
    await page.mouse.move(from.x, from.y);
    // Hover determines whether the next drag moves an object or grabs its handle.
    await page.waitForTimeout(350);
    await page.mouse.down();
    try {
      // Goodnotes consumes pointer events on render frames. Allow both ends to
      // settle so mouseup cannot overtake the last movement in its renderer.
      await page.waitForTimeout(200);
      await page.mouse.move(to.x, to.y, { steps: 20 });
      await page.waitForTimeout(250);
    } finally {
      await page.mouse.up();
    }
    await page.waitForTimeout(400);
  }
  async clickCanvas(page, x, y) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(200);
    await page.mouse.click(x, y, { delay: 80 });
    await page.waitForTimeout(250);
  }
  async lasso(page, view, region) {
    await this.commitSelection(page);
    await this.captureBaseline(page, view);
    await this.tool(page, '#lassoToolButton');
    // Explicitly choose rectangular lasso; do not depend on a previously selected shape.
    await page.locator('#lassoToolButton').click();
    const rectangular = page.getByText('Rectangular', { exact: true });
    await rectangular.waitFor({ state: 'visible' });
    await rectangular.click();
    // Clicking the selected tool dismisses its configuration without touching the document.
    if (await rectangular.isVisible()) await page.locator('#lassoToolButton').click();
    const from = this.point(view, region.x, region.y),
      to = this.point(view, region.x + region.width, region.y + region.height);
    await this.drag(page, from, to);
    await this.selectionMenu(page);
    await this.a.dismissKnownPopups(page);
  }
  async selectionMenu(page) {
    try {
      await page.locator('#shared_menu_main_view').waitFor({ state: 'visible', timeout: 5000 });
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      throw new GoodnotesError(
        'NO_OBJECT_SELECTION',
        'No native selection menu appeared. The object may still be loading or the point may be empty.',
      );
    }
  }
  async snapshot(page, view) {
    await page.waitForTimeout(200);
    const bytes = await page.screenshot({ animations: 'disabled' });
    const baseline = this.baselines.get(page);
    // At small zoom the native text frame is too pale for pixel thresholds.
    // Use its exposed border only with matching native handles/editor guards.
    const nativeTextBounds = await nativeTextSelectionBounds(page, view.canvas);
    const bounds =
      nativeTextBounds ??
      (await selectionBounds(
        bytes,
        view.canvas,
        baseline?.viewId === view.viewId ? baseline.bytes : undefined,
      ));
    return {
      bounds,
      hash: await regionHash(bytes, bounds),
      bytes,
      kind: nativeTextBounds ? 'text-box' : 'object-or-group',
    };
  }
  async select(args, options = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      checkCancellation(options.signal);
      try {
        return await this.selectOnce(args);
      } catch (error) {
        if (!['NO_OBJECT_SELECTION', 'AMBIGUOUS_SELECTION'].includes(error.code) || attempt === 2)
          throw error;
        // Objects can arrive after the baseline screenshot. Fresh selection-only
        // attempts reacquire a settled baseline; no edit, paste or drag-to-move is replayed.
        const page = await this.a.getPage();
        await this.commitSelection(page);
        await page.waitForTimeout(1200);
      }
    }
  }
  async selectOnce({ viewId, x, y, region }) {
    const view = this.a.getView(viewId),
      page = await this.a.assertView(view);
    // Clicking an already-selected shape can enter its separate edit mode.
    // Start a fresh selection so a repeated select remains predictable.
    await this.commitSelection(page);
    await this.captureBaseline(page, view);
    if (region) {
      await this.lasso(page, view, region);
      const resize = page.locator('#shared_menu_options_resize');
      if (await resize.isVisible().catch(() => false)) await resize.click();
    } else {
      await this.tool(page, '#lassoToolButton');
      const p = this.point(view, x, y);
      await this.clickCanvas(page, p.x, p.y);
      await this.a.dismissKnownPopups(page);
    }
    await this.selectionMenu(page);
    const shot = await this.snapshot(page, view),
      selectionId = crypto.randomUUID();
    const textBox = (await page.locator('.rich-text-resize-handle').count()) > 0;
    const item = {
      selectionId,
      viewId,
      ...shot,
      kind: textBox ? 'text-box' : 'object-or-group',
      ...(region ? { region } : { x, y }),
      created: Date.now(),
    };
    this.selections.clear();
    this.selections.set(selectionId, item);
    return {
      selectionId,
      kind: item.kind,
      bounds: shot.bounds,
      coordinateSpace: 'viewport pixels',
      expiresInSeconds: 600,
      warning: 'Selection can contain multiple objects. Preview before a destructive edit.',
    };
  }
  async evidence(operationId, before, after) {
    const directory = path.join(this.a.config.directory, 'evidence');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const files = {
      before: path.join(directory, operationId + '-before.png'),
      after: path.join(directory, operationId + '-after.png'),
    };
    await fs.writeFile(files.before, before, { mode: 0o600 });
    await fs.writeFile(files.after, after, { mode: 0o600 });
    return files;
  }
  async copyNativeText(args, options) {
    return this.copyNative({ ...args, copyKind: 'text' }, options);
  }
  async copyNativeSelection({ selectionId, ...args }, options) {
    const { s, view } = await this.a.styles.selection(selectionId);
    if (!s.region)
      throw new GoodnotesError(
        'LASSO_SELECTION_REQUIRED',
        'Select the source with a rectangular lasso region first. Point selections use the exact text/image copy tools.',
      );
    return this.copyNative(
      {
        ...args,
        sourceUrl: view.pageUrl,
        copyKind: 'visual',
        sourceSelectionId: selectionId,
        sourceSelection: { bounds: s.bounds, hash: s.hash, region: s.region },
      },
      options,
    );
  }
  async copyNativeImage(args, options) {
    if (!/^[a-f0-9]{64}$/i.test(args.expectedSourceSha256 || ''))
      throw new GoodnotesError('INVALID_IMAGE_HASH', 'Use the sourceSha256 from image_crop_info.');
    validateCrop(args.expectedCrop);
    return this.copyNative({ ...args, copyKind: 'image' }, options);
  }
  async copyNative(
    {
      sourceUrl,
      target,
      expectedText,
      expectedSourceSha256,
      expectedCrop,
      copyKind,
      sourceSelectionId,
      sourceSelection,
      destinationPath,
      destinationPage = 1,
      x,
      y,
      operationId,
    },
    options,
  ) {
    const a = this.a;
    return mutate(
      a,
      operationId,
      {
        action:
          copyKind === 'image'
            ? 'copy-native-image-object'
            : copyKind === 'visual'
              ? 'copy-native-visual-selection'
              : 'copy-native-text-object',
        sourceUrl,
        target,
        ...(copyKind === 'visual'
          ? { sourceSelection }
          : copyKind === 'image'
            ? { expectedSourceSha256, expectedCrop }
            : { expectedTextHash: digest(expectedText) }),
        destinationPath,
        destinationPage,
        x,
        y,
      },
      async (mark) => {
        const guardedSource =
          copyKind === 'visual' ? await a.styles.selection(sourceSelectionId) : null;
        const sourceView = guardedSource?.view ?? (await a.inspect({ url: sourceUrl }));
        let selected = guardedSource
            ? {
                selectionId: sourceSelectionId,
                viewId: sourceView.viewId,
                bounds: guardedSource.s.bounds,
              }
            : await a.jobs.target(
                sourceView,
                copyKind === 'image' ? target : { ...target, expectedText },
                true,
                options,
              ),
          original;
        if (copyKind === 'visual') {
          const p = guardedSource.page;
          this.validateBounds(guardedSource.s.bounds, sourceView);
          await this.readingMode(p);
          const sourceBytes = await p.screenshot({ animations: 'disabled' });
          selected = await this.select({
            viewId: sourceView.viewId,
            region: guardedSource.s.region,
          });
          if (!nearBounds(selected.bounds, guardedSource.s.bounds, 2))
            throw new GoodnotesError(
              'SELECTION_CHANGED',
              'The source lasso selection changed before copying.',
            );
          const b = selected.bounds,
            sourceFrame = await frameAtPoint(p, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
          if (
            b.x < sourceFrame.x ||
            b.y < sourceFrame.y ||
            b.x + b.width > sourceFrame.x + sourceFrame.width ||
            b.y + b.height > sourceFrame.y + sourceFrame.height
          )
            throw new GoodnotesError(
              'COPY_CROSSES_PAGES',
              'Keep the complete source selection inside one native page.',
            );
          original = {
            kind: 'visual-selection',
            sourceBytes,
            visual: {
              sourceUrl,
              sourceBounds: selected.bounds,
              sourceZoom: sourceView.zoom,
              sourceFrame,
              sourceSha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
            },
          };
        } else if (copyKind === 'image') {
          const image = await a.imageCrop.prepare({ selectionId: selected.selectionId });
          if (
            image.sourceSha256 !== expectedSourceSha256.toLowerCase() ||
            !sameCrop(image.region, expectedCrop, image.sourceSize)
          )
            throw new GoodnotesError(
              'IMAGE_CONFLICT',
              'The selected native image or crop differs from the expected source. No paste was sent.',
            );
          original = {
            kind: 'image',
            image: {
              sourceSha256: image.sourceSha256,
              sourceSize: image.sourceSize,
              region: image.region,
            },
          };
        } else {
          if (!selected.targetId) {
            const v = a.getView(selected.viewId),
              b = selected.bounds,
              px = (b.x + b.width / 2 - v.canvas.x) / v.canvas.width,
              py = (b.y + b.height / 2 - v.canvas.y) / v.canvas.height,
              isSticky = await (
                await a.getPage()
              )
                .locator('#shared_menu_options_collapse')
                .isVisible()
                .catch(() => false),
              read = await a.readText({
                viewId: v.viewId,
                x: px,
                y: py,
                ...(isSticky ? { expectedKind: 'sticky' } : {}),
              });
            selected = { ...read, ...(await a.objects.select({ viewId: v.viewId, x: px, y: py })) };
          }
          original = a.targets.get(selected.targetId);
          if (
            !original ||
            original.text !== expectedText ||
            !['sticky', 'text-box'].includes(original.kind)
          )
            throw new GoodnotesError(
              'TEXT_CONFLICT',
              'Native object copy requires one verified text box or sticky with the exact expected text.',
            );
        }
        const { page } = await a.styles.selection(selected.selectionId);
        await page.locator('#object_menu_context_menu_option').click();
        const copy = page.locator(
          copyKind === 'visual'
            ? '#object_context_menu #shared_menu_options_copy:visible'
            : '#object_menu_context_shared_menu_options_copy',
        );
        await copy.waitFor({ state: 'visible' });
        await copy.click();
        await page.waitForTimeout(400);
        let destination = await a.openItemInApp({ itemPath: destinationPath });
        requireWritable(a, destination);
        await a.pages.sidebar(page);
        const pages = await a.pages.snapshot(page);
        if (destinationPage < 1 || destinationPage > pages.count)
          throw new GoodnotesError('INVALID_PAGE', 'Destination page is outside this document.');
        // Select within the SPA: changing the URL through page.goto would discard the clipboard.
        await a.pages.menu(page, destinationPage);
        await page.keyboard.press('Escape');
        await page.locator(`#sidebarThumbnail_${destinationPage - 1}`).click();
        await page.waitForURL((u) => u.hash === '#page-' + destinationPage, { timeout: 10000 });
        const indicator = page.locator('#pageIndicator');
        if (await indicator.count())
          await page.waitForFunction(
            (n) =>
              document
                .querySelector('#pageIndicator')
                ?.textContent.trim()
                .startsWith(n + ' of '),
            destinationPage,
          );
        destination = await a.inspect({ url: page.url() });
        const view = a.getView(destination.viewId),
          point = this.point(view, x, y);
        const destinationFrame = await pageFrame(page, pages.pages[destinationPage - 1].id);
        if (
          point.x < destinationFrame.x ||
          point.y < destinationFrame.y ||
          point.x > destinationFrame.x + destinationFrame.width ||
          point.y > destinationFrame.y + destinationFrame.height
        )
          throw new GoodnotesError(
            'PASTE_OUTSIDE_PAGE',
            'Choose a paste position inside the visible native page.',
          );
        if (copyKind === 'visual')
          validateVisualPaste(original.visual, view, destinationFrame, point);
        await this.readingMode(page);
        await this.captureBaseline(page, view);
        const before = await page.screenshot();
        await this.tool(page, '#lassoToolButton');
        await a.assertView(view);
        await page.mouse.click(point.x, point.y, { button: 'right' });
        await page.locator('#shared_menu_options_paste').waitFor({ state: 'visible' });
        mark();
        await page.locator('#shared_menu_options_paste').click();
        await page.waitForTimeout(500);
        await a.resetOuterScroll(page);
        let created;
        try {
          created = await this.snapshot(page, view);
        } catch (error) {
          throw new GoodnotesError(error.code || 'PASTE_SELECTION_UNVERIFIED', error.message, {
            evidence: await this.evidence(operationId, before, await page.screenshot()),
          });
        }
        this.validateBounds(created.bounds, view);
        const bounds = {
          x: created.bounds.x - 12,
          y: created.bounds.y - 12,
          width: created.bounds.width + 24,
          height: created.bounds.height + 24,
        };
        if (
          point.x < bounds.x - bounds.width ||
          point.x > bounds.x + 2 * bounds.width ||
          point.y < bounds.y - bounds.height ||
          point.y > bounds.y + 2 * bounds.height
        )
          throw new GoodnotesError(
            'PASTE_POSITION_UNVERIFIED',
            'The copied object appeared far from the requested destination.',
          );
        await this.readingMode(page);
        const frame = await pageFrame(page, pages.pages[destinationPage - 1].id);
        let expected = await page.screenshot(),
          sourceAppearance;
        if (copyKind === 'visual') {
          const observed = await waitForMappedRegion(
            page,
            original.sourceBytes,
            original.visual.sourceBounds,
            created.bounds,
            options,
          );
          expected = observed.bytes;
          sourceAppearance = observed.comparison;
        }
        if ((await regionHash(before, bounds)) === (await regionHash(expected, bounds)))
          throw new GoodnotesError(
            'PASTE_UNVERIFIED',
            'Pasting produced no verifiable visible change.',
          );
        const directory = path.join(a.config.directory, 'copy-checkpoints');
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const receipt = await a.journal.get(operationId),
          record = {
            operationId,
            fingerprint: receipt.fingerprint,
            url: view.url,
            pageUrl: view.pageUrl,
            title: view.title,
            destinationPage,
            frame,
            bounds,
            createdBounds: created.bounds,
            ...(copyKind === 'visual'
              ? { visual: original.visual }
              : copyKind === 'image'
                ? { image: original.image }
                : { textHash: digest(expectedText), styleHash: original.styleHash }),
            kind: original.kind,
          };
        if (copyKind === 'visual')
          await fs.writeFile(
            path.join(directory, operationId + '-source.png'),
            original.sourceBytes,
            { mode: 0o600 },
          );
        await fs.writeFile(path.join(directory, operationId + '-expected.png'), expected, {
          mode: 0o600,
        });
        await fs.writeFile(path.join(directory, operationId + '-before.png'), before, {
          mode: 0o600,
        });
        await writeJson(path.join(directory, operationId + '.json'), record);
        if (sourceAppearance && !sourceAppearance.matches)
          throw new GoodnotesError(
            'COPY_SOURCE_MISMATCH',
            'The pasted selection does not visually match the source. Different page backgrounds or overlapping destination content can prevent verification; inspect the saved checkpoint and do not repeat paste.',
            {
              sourceAppearance,
              checkpointAvailable: true,
              evidence: await this.evidence(operationId, before, expected),
            },
          );
        await page.waitForTimeout(1200);
        return this.verifyCopiedText({ operationId }, { ...options, internal: true });
      },
      options,
    );
  }

  async verifyCopiedText({ operationId }, { internal = false, ...options } = {}) {
    const a = this.a,
      receipt = await a.journal.get(operationId),
      directory = path.join(a.config.directory, 'copy-checkpoints'),
      record = await readJson(path.join(directory, operationId + '.json'), null);
    if (
      !record ||
      record.fingerprint !== receipt.fingerprint ||
      !['pending', 'uncertain', 'verified'].includes(receipt.status)
    )
      throw new GoodnotesError(
        'COPY_CHECKPOINT_NOT_FOUND',
        'No matching copy verification checkpoint exists. Inspect the destination; do not repeat an uncertain paste.',
      );
    if (
      record.operationId !== operationId ||
      documentUrl(record.pageUrl) !== record.url ||
      !['text-box', 'sticky', 'image', 'visual-selection'].includes(record.kind)
    )
      throw new GoodnotesError(
        'COPY_CHECKPOINT_INVALID',
        'The copy checkpoint identity is inconsistent.',
      );
    const page = await a.getPage(),
      expected = await fs.readFile(path.join(directory, operationId + '-expected.png')),
      before = await fs.readFile(path.join(directory, operationId + '-before.png')),
      frame = record.frame,
      bounds = record.bounds,
      created = { bounds: record.createdBounds },
      original = { styleHash: record.styleHash, kind: record.kind },
      destinationPage = record.destinationPage;
    await page.goto(record.pageUrl, { waitUntil: 'domcontentloaded' });
    let inspected = await a.inspect({ url: record.pageUrl }),
      currentView = a.getView(inspected.viewId),
      currentFrame = await pageFrame(page, frame.pageId),
      mappedBounds = mapPageBounds(bounds, frame, currentFrame);
    // A notebook may restore fit-to-width zoom after reload. Reacquire by the
    // visible native page frame, rather than treating old viewport pixels as stable.
    for (let attempt = 0; attempt < 8; attempt++) {
      const c = currentView.canvas;
      if (
        mappedBounds.x >= c.x + 5 &&
        mappedBounds.y >= c.y + 45 &&
        mappedBounds.x + mappedBounds.width <= c.x + c.width - 5 &&
        mappedBounds.y + mappedBounds.height <= c.y + c.height - 40
      )
        break;
      checkCancellation(options?.signal);
      inspected = await a.navigate({
        viewId: currentView.viewId,
        ...(currentFrame.width > 10000
          ? {
              panX: Math.max(
                -600,
                Math.min(600, mappedBounds.x + mappedBounds.width / 2 - c.x - c.width / 2),
              ),
              panY: Math.max(
                -600,
                Math.min(600, mappedBounds.y + mappedBounds.height / 2 - c.y - c.height / 2),
              ),
            }
          : { zoomSteps: -1 }),
      });
      currentView = a.getView(inspected.viewId);
      currentFrame = await pageFrame(page, frame.pageId);
      mappedBounds = mapPageBounds(bounds, frame, currentFrame);
    }
    requireWritable(a, currentView);
    if (currentView.title !== record.title)
      throw new GoodnotesError(
        'COPY_CHECKPOINT_INVALID',
        'The destination title changed after the copy checkpoint.',
      );
    this.validateBounds(mappedBounds, currentView);
    const mappedObject = mapPageBounds(created.bounds, frame, currentFrame);
    await this.readingMode(page);
    const { comparison: appearance, bytes: after } = await waitForMappedRegion(
      page,
      expected,
      bounds,
      mappedBounds,
      options,
    );
    if (!appearance.matches)
      throw new GoodnotesError(
        'SAVE_UNVERIFIED',
        'Pasted object appearance differed after reload.',
      );
    let read;
    if (['text-box', 'sticky'].includes(original.kind)) {
      read = await a.readText({
        viewId: currentView.viewId,
        expectedKind: original.kind,
        x:
          (mappedObject.x + Math.min(25, mappedObject.width / 3) - currentView.canvas.x) /
          currentView.canvas.width,
        y:
          (mappedObject.y + Math.min(25, mappedObject.height / 3) - currentView.canvas.y) /
          currentView.canvas.height,
      });
      if (
        digest(read.text) !== record.textHash ||
        read.kind !== original.kind ||
        digest(read.formatting) !== original.styleHash
      )
        throw new GoodnotesError(
          'SAVE_UNVERIFIED',
          'Copied native text, formatting or object kind did not match the source.',
        );
    }
    let sourceAppearance, selectionRegion;
    if (original.kind === 'visual-selection') {
      const sourceBytes = await fs.readFile(path.join(directory, operationId + '-source.png'));
      if (
        !record.visual ||
        crypto.createHash('sha256').update(sourceBytes).digest('hex') !== record.visual.sourceSha256
      )
        throw new GoodnotesError(
          'COPY_CHECKPOINT_INVALID',
          'The saved source appearance checkpoint changed.',
        );
      sourceAppearance = await compareMappedRegions(
        sourceBytes,
        record.visual.sourceBounds,
        after,
        mappedObject,
      );
      if (!sourceAppearance.matches)
        throw new GoodnotesError(
          'SAVE_UNVERIFIED',
          'The saved selection does not visually match its captured source.',
          { sourceAppearance },
        );
      selectionRegion = {
        x: (mappedObject.x - 5 - currentView.canvas.x) / currentView.canvas.width,
        y: (mappedObject.y - 5 - currentView.canvas.y) / currentView.canvas.height,
        width: (mappedObject.width + 10) / currentView.canvas.width,
        height: (mappedObject.height + 10) / currentView.canvas.height,
      };
      await this.select({ viewId: currentView.viewId, region: selectionRegion });
    } else await this.reselectBounds(page, currentView, mappedObject);
    const saved = await this.snapshot(page, currentView),
      selectionId = crypto.randomUUID();
    if (original.kind === 'visual-selection' && !nearBounds(saved.bounds, mappedObject, 3))
      throw new GoodnotesError(
        'SAVE_UNVERIFIED',
        'The pasted native multi-selection bounds differ from its checkpoint.',
        { expectedBounds: mappedObject, actualBounds: saved.bounds },
      );
    this.selections.clear();
    this.selections.set(selectionId, {
      ...saved,
      viewId: currentView.viewId,
      kind: original.kind,
      ...(selectionRegion ? { region: selectionRegion } : {}),
      created: Date.now(),
    });
    let image;
    if (original.kind === 'image') {
      image = await a.imageCrop.prepare({ selectionId });
      if (
        !record.image ||
        image.sourceSha256 !== record.image.sourceSha256 ||
        digest(image.sourceSize) !== digest(record.image.sourceSize) ||
        !sameCrop(image.region, record.image.region, image.sourceSize)
      )
        throw new GoodnotesError(
          'SAVE_UNVERIFIED',
          'The pasted native image pixels, dimensions or crop did not match the source.',
        );
    }
    await a.documents.invalidate(record.url);
    return {
      ...(internal ? {} : { originalReceiptStatus: receipt.status, operationId }),
      verified: true,
      verification:
        original.kind === 'visual-selection'
          ? 'native-paste-source-and-reload-appearance'
          : original.kind === 'image'
            ? 'native-paste-image-pixels-crop-and-reload-appearance'
            : 'native-paste-editable-text-format-kind-and-reload-appearance',
      url: record.url,
      page: destinationPage,
      viewId: currentView.viewId,
      selectionId,
      ...(read
        ? { targetId: read.targetId }
        : image
          ? {
              image: {
                sourceSha256: image.sourceSha256,
                sourceSize: image.sourceSize,
                region: image.region,
              },
            }
          : { sourceAppearance }),
      bounds: saved.bounds,
      kind: original.kind,
      appearance,
      evidence: await this.evidence(operationId, before, after),
      note:
        original.kind === 'visual-selection'
          ? 'Native clipboard copy of a lasso selection; source remains unchanged. Verification compares visible source and saved appearance, not exact text, hidden properties or native object counts. Different backgrounds or overlapping content may prevent verification.'
          : 'Copied with native Goodnotes Copy/Paste. Source remains unchanged. Exact text/image tools preserve their type-specific verification.',
    };
  }
  async commitSelection(page) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    if (
      await page
        .locator('#shared_menu_main_view')
        .isVisible()
        .catch(() => false)
    ) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
    }
  }
  async readingMode(page) {
    await this.commitSelection(page);
    const toolbar = page.locator('#editorTopbarTools');
    if (await toolbar.isVisible()) await page.locator('#changeEditMode').click();
    await toolbar.waitFor({ state: 'hidden' });
    await page.waitForTimeout(350);
  }
  async reselectBounds(page, view, bounds) {
    await this.commitSelection(page);
    await this.captureBaseline(page, view);
    await this.tool(page, '#lassoToolButton');
    await this.clickCanvas(page, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    try {
      return await this.snapshot(page, view);
    } catch {
      if (
        await page
          .getByText('External link', { exact: true })
          .isVisible()
          .catch(() => false)
      )
        await page.getByRole('button', { name: 'No', exact: true }).click();
      // Unfilled shapes can only be hit on their outline, not their blank center.
      await this.clickCanvas(page, bounds.x + bounds.width / 2, bounds.y + 5);
      try {
        return await this.snapshot(page, view);
      } catch {
        if (
          await page
            .getByText('External link', { exact: true })
            .isVisible()
            .catch(() => false)
        )
          await page.getByRole('button', { name: 'No', exact: true }).click();
      }
      await this.lasso(page, view, {
        x: (bounds.x - 5 - view.canvas.x) / view.canvas.width,
        y: (bounds.y - 5 - view.canvas.y) / view.canvas.height,
        width: (bounds.width + 10) / view.canvas.width,
        height: (bounds.height + 10) / view.canvas.height,
      });
      const resize = page.locator('#shared_menu_options_resize');
      if (await resize.isVisible()) await resize.click();
      return this.snapshot(page, view);
    }
  }
  async transform(
    { selectionId, action, dx = 0, dy = 0, scaleX = 1, scaleY = 1, operationId },
    options,
  ) {
    const a = this.a,
      s = this.selections.get(selectionId);
    if (!s || Date.now() - s.created > 600000)
      throw new GoodnotesError('STALE_SELECTION', 'Select the object again.');
    const view = a.getView(s.viewId);
    requireWritable(a, view);
    return mutate(
      a,
      operationId,
      {
        action: 'object-' + action,
        url: view.url,
        page: view.pageUrl,
        bounds: s.bounds,
        hash: s.hash,
        dx,
        dy,
        scaleX,
        scaleY,
      },
      async (mark) => {
        const page = await a.assertView(view),
          fresh = await this.snapshot(page, view);
        if (!nearBounds(fresh.bounds, s.bounds, 1) || fresh.hash !== s.hash)
          throw new GoodnotesError(
            'SELECTION_CHANGED',
            'The selection or its content changed. Select it again.',
          );
        const checkpoint = await captureBoardViewport(page);
        const b = s.bounds;
        let expected = { ...b },
          deletion;
        if (action === 'move') {
          expected.x += dx * view.canvas.width;
          expected.y += dy * view.canvas.height;
          this.validateBounds(expected, view);
          const outlineOnly = await page
            .locator('#shared_menu_options_edit_shape')
            .isVisible()
            .catch(() => false);
          const grip = outlineOnly
            ? { x: b.x + b.width * 0.25, y: b.y + 5 }
            : { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          mark();
          await this.drag(page, grip, {
            x: grip.x + expected.x - b.x,
            y: grip.y + expected.y - b.y,
          });
        } else if (action === 'resize') {
          if (scaleX < 0.25 || scaleX > 3 || scaleY < 0.25 || scaleY > 3)
            throw new GoodnotesError('INVALID_SCALE', 'Scale factors must be 0.25–3.');
          expected.width *= scaleX;
          expected.height *= scaleY;
          if (s.kind === 'text-box' && scaleY !== 1)
            throw new GoodnotesError(
              'UNSUPPORTED_RESIZE',
              'Text boxes support width resizing; height follows their text.',
            );
          this.validateBounds(expected, view);
          const handle =
            s.kind === 'text-box' ? page.getByTestId('rich-text-resize-handle-right') : null;
          const position = handle ? await handle.boundingBox() : null;
          const from = position
            ? { x: position.x + position.width / 2, y: position.y + position.height / 2 }
            : { x: b.x + b.width, y: b.y + b.height };
          mark();
          await this.drag(page, from, {
            x: from.x + b.width * (scaleX - 1),
            y: from.y + (s.kind === 'text-box' ? 0 : b.height * (scaleY - 1)),
          });
        } else if (action === 'delete') {
          await this.readingMode(page);
          const before = await page.screenshot({ animations: 'disabled' }),
            region = { x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16 };
          if (s.region) await this.select({ viewId: view.viewId, region: s.region });
          else await this.reselectBounds(page, view, b);
          const guarded = await this.snapshot(page, view);
          if (!nearBounds(guarded.bounds, b, 1) || guarded.hash !== s.hash)
            throw new GoodnotesError(
              'SELECTION_CHANGED',
              'The selection changed while preparing unselected deletion evidence.',
            );
          mark();
          await page.locator('#shared_menu_main_view #shared_menu_options_delete').click();
          await page.waitForTimeout(400);
          await this.readingMode(page);
          const written = await page.screenshot({ animations: 'disabled' }),
            change = await compareRegion(before, written, region);
          if (change.matches)
            throw new GoodnotesError(
              'DELETE_UNVERIFIED',
              'The native delete command produced no confirmed content change.',
            );
          deletion = { before, written, region };
        } else if (action === 'duplicate') {
          mark();
          await page.locator('#shared_menu_main_view #shared_menu_options_duplicate').click();
        } else
          throw new GoodnotesError('INVALID_ACTION', 'Choose move, resize, duplicate or delete.');
        await page.waitForTimeout(700);
        let afterBounds;
        if (action !== 'delete') afterBounds = (await this.snapshot(page, view)).bounds;
        await this.commitSelection(page);
        if (action !== 'delete')
          afterBounds = (await this.reselectBounds(page, view, afterBounds)).bounds;
        // Native board snapping (25px at 100%) and selection padding can adjust
        // placement. Report actual/requested bounds rather than claiming exact placement.
        if (
          action === 'move' &&
          (Math.abs(afterBounds.x - expected.x) > 18 ||
            Math.abs(afterBounds.y - expected.y) > 18 ||
            Math.abs(afterBounds.width - b.width) > 6 ||
            Math.abs(afterBounds.height - b.height) > 6)
        )
          throw new GoodnotesError(
            'MOVE_UNVERIFIED',
            'The selected object did not move by the requested distance.',
          );
        if (
          action === 'resize' &&
          (Math.abs(afterBounds.width - expected.width) > 8 ||
            (s.kind !== 'text-box' && Math.abs(afterBounds.height - expected.height) > 8))
        )
          throw new GoodnotesError(
            'RESIZE_UNVERIFIED',
            'Goodnotes constrained the resize differently than requested. Inspect the result.',
          );
        if (action === 'duplicate' && nearBounds(afterBounds, b, 2))
          throw new GoodnotesError(
            'DUPLICATE_UNVERIFIED',
            'A distinct duplicate position could not be confirmed.',
          );
        await this.commitSelection(page);
        await page.waitForTimeout(1500);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await a.openDocument(view.pageUrl);
        await a.closePanels(page);
        await restoreBoardViewport(a, page, view, checkpoint, options);
        await a.assertView(view);
        if (action === 'delete') {
          await this.readingMode(page);
          const after = await page.screenshot({ animations: 'disabled' });
          const persisted = await compareRegion(deletion.written, after, deletion.region),
            removed = await compareRegion(deletion.before, after, deletion.region);
          if (!persisted.matches || removed.matches)
            throw new GoodnotesError(
              'DELETE_UNVERIFIED',
              'The unselected deletion result did not persist after reloading.',
            );
          await a.documents.invalidate(view.url);
          this.selections.clear();
          return {
            verified: true,
            verification: 'native-delete-unselected-content-change-and-reload-appearance',
            region: deletion.region,
            appearance: persisted,
            evidence: await this.evidence(operationId, deletion.before, after),
          };
        }
        const saved = await this.reselectBounds(page, view, afterBounds);
        if (!nearBounds(saved.bounds, afterBounds, 6))
          throw new GoodnotesError('SAVE_UNVERIFIED', 'The object bounds did not survive reload.');
        await a.documents.invalidate(view.url);
        this.selections.clear();
        return {
          verified: true,
          verification: 'bounds-after-reload',
          bounds: saved.bounds,
          requestedBounds: action === 'move' || action === 'resize' ? expected : undefined,
          adjustedByGoodnotes: action === 'move' && !nearBounds(saved.bounds, expected, 5),
          evidence: await this.evidence(operationId, s.bytes, saved.bytes),
        };
      },
      options,
    );
  }
  validateBounds(b, view) {
    if (
      b.x < 10 ||
      b.y < 130 ||
      b.x + b.width > view.viewport.width - 10 ||
      b.y + b.height > view.viewport.height - 40
    )
      throw new GoodnotesError(
        'OUTSIDE_VIEW',
        'Keep the complete object within the current viewport. Pan or zoom first.',
      );
  }
  async create(
    { viewId, kind, x, y, width = 0.15, height = 0.15, text = '', strokes, inkStyle, operationId },
    { signal } = {},
  ) {
    if (inkStyle && kind !== 'ink')
      throw new GoodnotesError('INVALID_INK_STYLE', 'inkStyle only applies to ink objects.');
    const a = this.a,
      view = a.getView(viewId);
    requireWritable(a, view);
    let region = { x, y, width, height };
    if (kind === 'ink') {
      if (
        !strokes?.length ||
        strokes.length > 100 ||
        strokes.reduce((sum, s) => sum + s.length, 0) > 3000
      )
        throw new GoodnotesError(
          'INVALID_STROKES',
          'Provide 1–100 strokes with at most 3,000 points total.',
        );
      const points = strokes.flat();
      for (const p of points) this.point(view, p.x, p.y);
      const xs = points.map((p) => p.x),
        ys = points.map((p) => p.y);
      region = {
        x: Math.min(...xs) - 0.015,
        y: Math.min(...ys) - 0.015,
        width: Math.max(...xs) - Math.min(...xs) + 0.03,
        height: Math.max(...ys) - Math.min(...ys) + 0.03,
      };
    }
    return mutate(
      a,
      operationId,
      {
        action: 'create-object',
        url: view.url,
        page: view.pageUrl,
        kind,
        region,
        textHash: digest(text),
        strokesHash: digest(strokes ?? []),
        inkStyle,
      },
      async (mark) => {
        const page = await a.assertView(view),
          origin = this.point(view, region.x, region.y),
          end = this.point(view, region.x + region.width, region.y + region.height);
        const checkpoint = await captureBoardViewport(page);
        await this.readingMode(page);
        await this.captureBaseline(page, view);
        const before = await page.screenshot();
        if (kind === 'ink') {
          if (inkStyle) await configureInk(a, page, inkStyle, mark, { signal });
          else {
            await this.tool(page, '#writingToolsButton');
            const pen = page.locator('#penToolButton');
            if ((await pen.isVisible()) && (await pen.getAttribute('data-is-selected')) !== 'true')
              await pen.click();
          }
          for (const stroke of strokes) {
            if (stroke.length < 2)
              throw new GoodnotesError('INVALID_STROKE', 'Every stroke needs at least two points.');
            checkCancellation(signal);
            const p = this.point(view, stroke[0].x, stroke[0].y);
            mark();
            await page.mouse.move(p.x, p.y);
            await page.mouse.down();
            try {
              await page.waitForTimeout(100);
              for (const point of stroke.slice(1)) {
                checkCancellation(signal);
                const q = this.point(view, point.x, point.y);
                await page.mouse.move(q.x, q.y, { steps: 3 });
                await page.waitForTimeout(35);
              }
              await page.waitForTimeout(150);
            } finally {
              await page.mouse.up();
            }
          }
        } else if (kind === 'sticky') {
          await this.tool(page, '#stickyNotesToolButton');
          mark();
          await this.clickCanvas(page, origin.x, origin.y);
          const editor = page.locator(EDITOR);
          await editor.waitFor({ state: 'visible' });
          if (text) {
            const lines = text.replace(/\r\n?/g, '\n').split('\n');
            for (let i = 0; i < lines.length; i++) {
              checkCancellation(signal);
              if (i) await editor.press('Enter');
              await editor.pressSequentially(lines[i]);
            }
          }
          a.nativeStickyEditors.add(page);
          await a.leaveEditor(page, editor);
        } else {
          await this.tool(page, '#shapeToolButton');
          const svg =
            kind === 'rectangle'
              ? 'rect[x="3"][y="3"][width="18"][height="18"][rx="1"]'
              : kind === 'ellipse'
                ? 'circle[cx="12"][cy="12"][r="10"]'
                : kind === 'triangle'
                  ? 'path[d^="M2.78306 20.5H21.2169"]'
                  : kind === 'diamond'
                    ? 'path[d^="m12.707 2.7071 8.5858 8.5858"]'
                    : kind === 'rounded-rectangle'
                      ? 'rect[x="3"][y="4"][width="18"][height="16"][rx="7"]'
                      : null;
          if (!svg)
            throw new GoodnotesError(
              'INVALID_KIND',
              'Choose sticky, rectangle, ellipse, triangle, diamond, rounded-rectangle or ink.',
            );
          const choice = page.locator(`button:has(svg > ${svg}):visible`);
          if ((await choice.count()) !== 1)
            throw new GoodnotesError(
              'SHAPE_TOOL_CHANGED',
              'Cannot uniquely identify this shape in the visible toolbar.',
            );
          await choice.click();
          mark();
          await this.drag(page, origin, end);
        }
        // The shape editor leaves a separate editing overlay active even when
        // the lasso button appears selected. Switch tools to commit that overlay.
        if (['rectangle', 'ellipse', 'triangle', 'diamond', 'rounded-rectangle'].includes(kind))
          await this.tool(page, '#textToolButton');
        await this.tool(page, '#lassoToolButton');
        if (kind === 'ink') {
          await this.lasso(page, view, region);
          await page.locator('#shared_menu_options_resize').click();
        } else if (kind === 'sticky') await this.clickCanvas(page, origin.x + 10, origin.y + 10);
        else await this.clickCanvas(page, (origin.x + end.x) / 2, origin.y + 2);
        const created = await this.snapshot(page, view);
        this.validateBounds(created.bounds, view);
        // Creation/edit/selection modes draw different padding and handles.
        // Compare the actual unselected content in one fixed region instead.
        const contentBounds = {
          x: created.bounds.x - 12,
          y: created.bounds.y - 12,
          width: created.bounds.width + 24,
          height: created.bounds.height + 24,
        };
        await this.readingMode(page);
        const expectedBytes = await page.screenshot(),
          expectedHash = await regionHash(expectedBytes, contentBounds);
        if ((await regionHash(before, contentBounds)) === expectedHash)
          throw new GoodnotesError('CREATE_UNVERIFIED', 'No visible content change was found.');
        await page.waitForTimeout(1500);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await a.openDocument(view.pageUrl);
        await a.closePanels(page);
        await restoreBoardViewport(a, page, view, checkpoint, { signal });
        await a.assertView(view);
        await this.readingMode(page);
        const persisted = await waitForMappedRegion(
          page,
          expectedBytes,
          contentBounds,
          contentBounds,
          { signal },
        );
        const persistedBytes = persisted.bytes;
        const appearance = persisted.comparison;
        if (!appearance.matches) {
          await this.evidence(operationId, expectedBytes, persistedBytes);
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'The new unselected content changed after reload. Inspect the saved evidence.',
          );
        }
        if (kind === 'sticky') {
          const actual = await a.readText({
            viewId,
            x: (origin.x + 20 - view.canvas.x) / view.canvas.width,
            y: (origin.y + 20 - view.canvas.y) / view.canvas.height,
          });
          if (actual.text !== text.replace(/\r\n?/g, '\n'))
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'The new sticky text did not match after reload.',
            );
        }
        await this.tool(page, '#lassoToolButton');
        if (kind === 'ink') {
          await this.lasso(page, view, region);
          await page.locator('#shared_menu_options_resize').click();
        } else await this.reselectBounds(page, view, created.bounds);
        const saved = await this.snapshot(page, view);
        await a.documents.invalidate(view.url);
        const selectionId = crypto.randomUUID();
        this.selections.set(selectionId, {
          ...saved,
          viewId,
          kind: 'object-or-group',
          ...(['rectangle', 'ellipse', 'triangle', 'diamond', 'rounded-rectangle'].includes(kind)
            ? {
                x: ((origin.x + end.x) / 2 - view.canvas.x) / view.canvas.width,
                y: (origin.y + 2 - view.canvas.y) / view.canvas.height,
              }
            : {}),
          created: Date.now(),
        });
        return {
          verified: true,
          verification: 'new-content-and-appearance-after-reload',
          selectionId,
          bounds: saved.bounds,
          appearance,
          evidence: await this.evidence(operationId, before, saved.bytes),
        };
      },
      { signal },
    );
  }
  async recognize({ viewId, region, language }) {
    const a = this.a,
      view = a.getView(viewId),
      page = await a.assertView(view);
    const box = {
      x: view.canvas.x + region.x * view.canvas.width,
      y: view.canvas.y + region.y * view.canvas.height,
      width: region.width * view.canvas.width,
      height: region.height * view.canvas.height,
    };
    // Animated selection outlines are not document content and must not enter
    // the conflict fingerprint.
    await this.commitSelection(page);
    const hash = await regionHash(await page.screenshot(), box);
    await this.lasso(page, view, region);
    await page.locator('#object_menu_context_menu_option').click();
    const convert = page.locator('#object_menu_context_shared_menu_options_convert_to_text');
    if (!(await convert.isVisible()))
      throw new GoodnotesError(
        'CONVERSION_UNAVAILABLE',
        'This selection does not offer native handwriting conversion.',
      );
    await convert.click();
    await page.locator('#convert_to_text_converted_text_editor').waitFor({ state: 'visible' });
    if (language) {
      await page.locator('#convert_to_text_language_selector').click();
      await page.getByText(language, { exact: true }).last().click();
    }
    const input = page.locator('#convert_to_text_converted_text_editor');
    await page
      .waitForFunction(
        () => {
          const e = document.getElementById('convert_to_text_converted_text_editor');
          return e && e.value.trim().length > 0;
        },
        null,
        { timeout: 20000 },
      )
      .catch(() => {});
    const text = await input.inputValue(),
      detectedLanguage = await page.locator('#convert_to_text_language_selector').innerText();
    await page.locator('#convert_to_text_cancel_button').click();
    if (!text.trim())
      throw new GoodnotesError(
        'NO_HANDWRITING_TEXT',
        'Goodnotes did not recognize text in this selection.',
      );
    const handwritingId = crypto.randomUUID();
    this.handwriting.set(handwritingId, {
      viewId,
      region,
      box,
      hash,
      text,
      language: detectedLanguage,
      created: Date.now(),
    });
    return {
      handwritingId,
      text,
      language: detectedLanguage,
      source: 'Goodnotes native handwriting recognition',
      documentChanged: false,
    };
  }
  async convert({ handwritingId, text, operationId }, options) {
    const a = this.a,
      h = this.handwriting.get(handwritingId);
    if (!h || Date.now() - h.created > 600000)
      throw new GoodnotesError(
        'STALE_HANDWRITING',
        'Read the handwriting again before converting.',
      );
    const view = a.getView(h.viewId);
    requireWritable(a, view);
    const expected = text ?? h.text;
    return mutate(
      a,
      operationId,
      {
        action: 'convert-handwriting',
        url: view.url,
        page: view.pageUrl,
        region: h.region,
        oldHash: h.hash,
        textHash: digest(expected),
      },
      async (mark) => {
        const page = await a.assertView(view);
        await this.commitSelection(page);
        if ((await regionHash(await page.screenshot(), h.box)) !== h.hash)
          throw new GoodnotesError(
            'HANDWRITING_CHANGED',
            'The handwriting region changed since recognition.',
          );
        await this.lasso(page, view, h.region);
        await page.locator('#object_menu_context_menu_option').click();
        await page.locator('#object_menu_context_shared_menu_options_convert_to_text').click();
        await page.locator('#convert_to_text_converted_text_editor').fill(expected);
        mark();
        await page.locator('#convert_to_text_convert_button').click();
        await page.locator('#convert_to_text_modal').waitFor({ state: 'detached' });
        await page.waitForTimeout(300);
        // Conversion returns Goodnotes to reading mode without a selection.
        // Select the resulting text explicitly before locating its editor.
        await this.lasso(page, view, h.region);
        const resize = page.locator('#shared_menu_options_resize');
        if (await resize.isVisible()) await resize.click();
        const selected = await this.snapshot(page, view);
        const x =
            (selected.bounds.x + selected.bounds.width / 2 - view.canvas.x) / view.canvas.width,
          y = (selected.bounds.y + selected.bounds.height / 2 - view.canvas.y) / view.canvas.height;
        await this.commitSelection(page);
        await page.waitForTimeout(1500);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await a.openDocument(view.pageUrl);
        await a.closePanels(page);
        await a.assertView(view);
        const editor = await a.selectEditor(page, view, x, y);
        const saved = await editor.innerText();
        await a.leaveEditor(page, editor);
        if (saved.trimEnd() !== expected.trimEnd())
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'The converted text could not be confirmed after reload.',
          );
        await a.documents.invalidate(view.url);
        this.handwriting.delete(handwritingId);
        return {
          verified: true,
          verification: 'converted-text-after-reload',
          textHash: digest(expected),
          characters: expected.length,
          x,
          y,
        };
      },
      options,
    );
  }
}
