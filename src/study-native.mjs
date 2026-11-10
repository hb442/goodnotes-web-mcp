import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { mutate, requireWritable } from './mutations.mjs';
import { digest } from './journal.mjs';
import { writeJson, readJson } from './store.mjs';
import { readPlainText } from './rich-text.mjs';
import { readRichText } from './text.mjs';
import { normalizeTextFormat, prepareFormatRanges } from './text-format-plan.mjs';
import { nativeTextSelectionBounds } from './objects.mjs';
import { captureBoardViewport, restoreBoardViewport } from './viewport.mjs';
import { worldBox, screenBox } from './board-scan.mjs';
import { waitForMappedRegion, nearBounds, pixels } from './visual.mjs';

export function validateStudyImageBounds(bounds, expected, placed = false) {
  const aspect = expected.width / expected.height;
  if (Math.abs(bounds.width / bounds.height / aspect - 1) > 0.035)
    throw new GoodnotesError(
      'IMAGE_FRAME_MISMATCH',
      'The selected frame does not match the original figure aspect ratio.',
    );
  if (placed) {
    const fit = Math.min(
      (expected.width - 8) / expected.width,
      (expected.height - 8) / expected.height,
    );
    if (
      Math.abs(bounds.width - expected.width * fit) > 12 ||
      Math.abs(bounds.height - expected.height * fit) > 12 ||
      Math.abs(bounds.x + bounds.width / 2 - expected.x - expected.width / 2) > 18 ||
      Math.abs(bounds.y + bounds.height / 2 - expected.y - expected.height / 2) > 18
    )
      throw new GoodnotesError(
        'IMAGE_LAYOUT_MISMATCH',
        'The complete original figure does not match its planned size and position.',
        { planned: expected, actual: bounds },
      );
  }
}
export async function verifyStudyImageSource(
  expectedBytes,
  state,
  expectedCrop = { x: 0, y: 0, width: 1, height: 1 },
) {
  const expected = await pixels(expectedBytes),
    actual = await pixels(state.sourceBytes);
  if (
    expected.width !== actual.width ||
    expected.height !== actual.height ||
    !['x', 'y', 'width', 'height'].every(
      (k) => Math.abs(state.region[k] - expectedCrop[k]) < 0.00001,
    ) ||
    !Buffer.from(expected.data).equals(Buffer.from(actual.data))
  )
    throw new GoodnotesError(
      'IMAGE_SOURCE_CHANGED',
      'Native image pixels or crop differ from the saved original.',
    );
  return {
    matches: true,
    verification: 'exact-decoded-source-pixels-and-crop',
    width: actual.width,
    height: actual.height,
  };
}
export function verifyStudyLinks(block, runs) {
  for (const link of block.links ?? []) {
    let cursor = link.start;
    for (const run of runs) {
      if (run.end <= cursor || run.start >= link.end) continue;
      if (run.start > cursor || run.link !== link.url) break;
      cursor = Math.min(link.end, run.end);
    }
    if (cursor !== link.end)
      throw new GoodnotesError(
        'LINK_UNVERIFIED',
        'Native link does not match the planned destination.',
        { blockId: block.id, start: link.start, end: link.end },
      );
  }
}
export function studyImageStaging(bounds, target, viewport) {
  const ratio = Math.min((target.width - 8) / bounds.width, (target.height - 8) / bounds.height);
  if (ratio < 0.2 || ratio > 4)
    throw new GoodnotesError(
      'IMAGE_SCALE_UNSUPPORTED',
      'The native image cannot safely fit this slot in one drag.',
    );
  const width = bounds.width * ratio,
    height = bounds.height * ratio;
  const maxX = viewport.width - 20 - Math.max(bounds.width, width),
    maxY = viewport.height - 50 - Math.max(bounds.height, height);
  if (maxX < 20 || maxY < 148)
    throw new GoodnotesError(
      'IMAGE_SCALE_UNSUPPORTED',
      'Both original and resized frames must fit one guarded viewport.',
    );
  return {
    x: Math.min(maxX, Math.max(20, target.x + (target.width - width) / 2)),
    y: Math.min(maxY, Math.max(148, target.y + (target.height - height) / 2)),
    width: bounds.width,
    height: bounds.height,
    ratio,
  };
}
export async function resizeStudyImage(objects, page, view, bounds, target, block) {
  const fit = Math.min((target.width - 8) / target.width, (target.height - 8) / target.height);
  const wanted = { width: target.width * fit, height: target.height * fit };
  let pointer = { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
  let actual = bounds;
  await page.mouse.move(pointer.x, pointer.y);
  await page.waitForTimeout(350);
  await page.mouse.down();
  try {
    await page.waitForTimeout(200);
    for (let attempt = 0; attempt < 4; attempt++) {
      const dx = wanted.width - actual.width,
        dy = wanted.height - actual.height;
      if (Math.abs(dx) <= 4 && Math.abs(dy) <= 4) break;
      // Flutter can ignore a short initial drag. Cross its gesture threshold
      // inside the same held gesture, then measure and correct its real frame.
      const gain = attempt === 0 ? Math.max(1, 32 / Math.hypot(dx, dy)) : 1;
      objects.validateBounds(
        { ...actual, width: actual.width + dx * gain, height: actual.height + dy * gain },
        view,
      );
      pointer = { x: pointer.x + dx * gain, y: pointer.y + dy * gain };
      await page.mouse.move(pointer.x, pointer.y, { steps: 20 });
      await page.waitForTimeout(450);
      actual = (await objects.snapshot(page, view)).bounds;
      validateStudyImageBounds(actual, block);
    }
  } finally {
    await page.mouse.up();
  }
  await page.waitForTimeout(400);
  return actual;
}
export class StudyNativeController {
  constructor(a) {
    this.a = a;
    this.directory = path.join(a.config.directory, 'study-evidence');
  }
  file(operationId) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(operationId))
      throw new GoodnotesError('INVALID_OPERATION_ID', 'Use a valid operation ID.');
    return path.join(this.directory, operationId + '.json');
  }
  async position(board, block, options = {}) {
    const pan = board.adopted ? block.y - 100 : Math.max(0, block.y - 100),
      panX = board.horizontalPan ? Math.max(0, block.x - 56) : 0,
      target = { ...board.anchor, x: board.anchor.x - panX, y: board.anchor.y - pan };
    const positioned = await this.a.scans.position(board.url, target, options);
    const view = this.a.getView(positioned.view.viewId);
    if (view.title !== board.title)
      throw new GoodnotesError('DOCUMENT_CHANGED', 'The study board title changed.');
    requireWritable(this.a, view);
    const rect = {
      x: board.canvas.x + block.x - panX,
      y: board.canvas.y + block.y - pan,
      width: block.width,
      height: block.height,
    };
    return { page: positioned.page, view, rect };
  }
  point(view, rect) {
    return {
      x: (rect.x + 18 - view.canvas.x) / view.canvas.width,
      y: (rect.y + 18 - view.canvas.y) / view.canvas.height,
    };
  }
  async imageSelection(page, view, candidate, block) {
    // A baseline from before import/movement contains no image at its new
    // position. Reacquire after committing so blue artwork cannot become a frame.
    const selected = await this.a.objects.select({
      viewId: view.viewId,
      x: (candidate.x + candidate.width / 2 - view.canvas.x) / view.canvas.width,
      y: (candidate.y + candidate.height / 2 - view.canvas.y) / view.canvas.height,
    });
    if (
      !(await page
        .locator('#shared_menu_options_crop_image')
        .isVisible()
        .catch(() => false))
    )
      throw new GoodnotesError('NOT_AN_IMAGE', 'The fresh selection is not one native image.');
    validateStudyImageBounds(selected.bounds, block);
    return selected;
  }
  async create(board, block, operationId, options = {}) {
    const linkedRanges = prepareFormatRanges(
      block.text ?? '',
      (block.links ?? []).map((l) => ({ start: l.start, end: l.end, format: { link: l.url } })),
    );
    const a = this.a,
      { page, view, rect } = await this.position(board, block, options);
    return mutate(
      a,
      operationId,
      { action: 'study-block', url: board.url, planHash: board.planHash, block },
      async (mark) => {
        const stageTimings = [];
        let previous = Date.now();
        const timed = (stage) => {
          const now = Date.now();
          stageTimings.push({ stage, ms: now - previous });
          previous = now;
        };
        const camera = await captureBoardViewport(page);
        if (!camera)
          throw new GoodnotesError('NOT_A_BOARD', 'Study layouts require a native whiteboard.');
        let content, runs, style, bounds, anchorPoint;
        if (block.kind === 'text') {
          const point = this.point(view, rect);
          let editor = await a.selectEditor(page, view, point.x, point.y);
          if ((await editor.evaluate(readPlainText)).trim())
            throw new GoodnotesError(
              'OCCUPIED_POSITION',
              'The planned empty card position is occupied.',
            );
          mark();
          await editor.focus();
          for (const [i, line] of block.text.split('\n').entries()) {
            checkCancellation(options.signal);
            if (i) await editor.press('Enter');
            await page.keyboard.insertText(line);
          }
          if ((await editor.evaluate(readPlainText)) !== block.text)
            throw new GoodnotesError('INPUT_MISMATCH', 'Created card text differs.');
          await a.leaveEditor(page, editor);
          editor = await a.selectEditor(page, view, point.x, point.y, true);
          if ((await editor.evaluate(readPlainText)) !== block.text)
            throw new GoodnotesError(
              'TEXT_CONFLICT',
              'Card changed while reacquiring native formatting.',
            );
          await a.text.applyFormat(
            page,
            editor,
            {
              start: 0,
              end: block.text.length,
              format: normalizeTextFormat({
                fontSize: block.fontSize,
                bold: false,
                italic: false,
                underline: false,
                strike: false,
                color: '#213547',
                align: 'left',
              }),
            },
            mark,
            options,
          );
          await a.text.applyFormat(
            page,
            editor,
            {
              start: 0,
              end: block.headingLength,
              format: { fontSize: block.headingSize, bold: true },
            },
            mark,
            options,
          );
          for (const range of linkedRanges)
            await a.text.applyFormat(page, editor, range, mark, options);
          content = await editor.evaluate(readPlainText);
          runs = await editor.evaluate(readRichText);
          verifyStudyLinks(block, runs);
          if (content !== block.text)
            throw new GoodnotesError('INPUT_MISMATCH', 'Formatting changed card text.');
          timed('text-and-character-format');
          await a.leaveEditor(page, editor);
          await a.objects.select({ viewId: view.viewId, ...point });
          // Set native width once, within the reserved slot; explicit line wrapping
          // keeps source references and formulas stable across native font metrics.
          let frame = await nativeTextSelectionBounds(page, view.canvas);
          if (!frame)
            throw new GoodnotesError(
              'TEXT_FRAME_UNAVAILABLE',
              'The new card has no guarded text frame.',
            );
          const handle = await page.getByTestId('rich-text-resize-handle-right').boundingBox();
          if (!handle)
            throw new GoodnotesError(
              'TEXT_FRAME_UNAVAILABLE',
              'The native width handle is absent.',
            );
          const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
          mark();
          await a.objects.drag(page, from, {
            x: from.x + block.width - frame.width - 8,
            y: from.y,
          });
          let selected = await a.objects.select({ viewId: view.viewId, ...point });
          const prepared = await a.textBoxStyle.prepare(
            { selectionId: selected.selectionId },
            options,
          );
          if (!prepared.supported || prepared.text !== content)
            throw new GoodnotesError(
              'STYLE_UNSUPPORTED',
              'The native card style is not available or its content changed.',
            );
          const patch = {
            backgroundColor: block.backgroundColor,
            roundCornerPt: 8,
            borderPt: 0,
            paddingPt: 10,
            shadow: false,
          };
          style = await a.textBoxStyle.writeNative(page, patch, prepared.state, mark, options);
          await a.textBoxStyle.close(page);
          const fresh = await a.objects.snapshot(page, view);
          bounds = fresh.bounds;
          const actual = await a.readText({
            viewId: view.viewId,
            ...point,
            expectedKind: 'text-box',
          });
          if (actual.text !== content || digest(actual.formatting) !== digest(runs))
            throw new GoodnotesError(
              'TEXT_CHANGED',
              'Card styling changed text or character formatting.',
            );
          timed('native-size-style-and-readback');
          anchorPoint = {
            x: view.canvas.x + point.x * view.canvas.width,
            y: view.canvas.y + point.y * view.canvas.height,
          };
        } else {
          const bytes = await fs.readFile(block.filePath);
          if (crypto.createHash('sha256').update(bytes).digest('hex') !== block.sha256)
            throw new GoodnotesError(
              'SOURCE_ASSET_CHANGED',
              'The original figure pixels changed since planning.',
            );
          await a.objects.commitSelection(page);
          await a.objects.captureBaseline(page, view);
          if (!(await page.locator('#editorTopbarTools').isVisible()))
            await page.locator('#changeEditMode').click();
          const pending = page.waitForEvent('filechooser');
          pending.catch(() => {});
          await page.locator('#imageToolButton').click();
          const chooser = await pending;
          mark();
          await chooser.setFiles({
            name: 'original-figure.png',
            mimeType: 'image/png',
            buffer: bytes,
          });
          await page.waitForTimeout(1000);
          let selected = await a.objects.snapshot(page, view);
          selected = await this.imageSelection(page, view, selected.bounds, block);
          a.objects.validateBounds(selected.bounds, view);
          // Native resizing fixes the upper-left corner. A small, centered
          // import can grow beyond the viewport even when its final slot fits.
          // Move it to a position that fits BOTH sizes before enlarging it.
          const initial = selected.bounds,
            staging = studyImageStaging(initial, rect, view.viewport);
          a.objects.validateBounds(staging, view);
          mark();
          await a.objects.drag(
            page,
            { x: initial.x + initial.width / 2, y: initial.y + initial.height / 2 },
            { x: staging.x + initial.width / 2, y: staging.y + initial.height / 2 },
          );
          selected = await this.imageSelection(page, view, staging, block);
          mark();
          for (let attempt = 0; attempt < 3; attempt++) {
            const resized = await resizeStudyImage(
              a.objects,
              page,
              view,
              selected.bounds,
              rect,
              block,
            );
            selected = await this.imageSelection(page, view, resized, block);
            const fit = Math.min((rect.width - 8) / rect.width, (rect.height - 8) / rect.height);
            if (
              Math.abs(selected.bounds.width - rect.width * fit) <= 12 &&
              Math.abs(selected.bounds.height - rect.height * fit) <= 12
            )
              break;
            // The committed selection can differ from the active drag frame.
            // Read it afresh before a bounded correction; never re-import.
          }
          const sized = selected.bounds;
          const from = { x: sized.x + sized.width / 2, y: sized.y + sized.height / 2 };
          const to = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          mark();
          await a.objects.drag(page, from, to);
          bounds = (await this.imageSelection(page, view, { ...rect }, block)).bounds;
          validateStudyImageBounds(bounds, rect, true);
          anchorPoint = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
          timed('original-image-insert-size-and-position');
        }
        const actualAnchor = await a.scans.anchor(page),
          world = worldBox(bounds, actualAnchor);
        const expectedWorld = worldBox(rect, camera);
        if (
          bounds.width > rect.width + 16 ||
          bounds.height > rect.height + 8 ||
          bounds.x < rect.x - 24 ||
          bounds.y < rect.y - 24 ||
          bounds.x + bounds.width > rect.x + rect.width + 24 ||
          bounds.y + bounds.height > rect.y + rect.height + 24
        )
          throw new GoodnotesError(
            'NATIVE_LAYOUT_OVERFLOW',
            'The actual native card exceeds its reserved layout slot.',
            { planned: rect, actual: bounds },
          );
        await a.objects.readingMode(page);
        const before = await page.screenshot({ animations: 'disabled' });
        await fs.mkdir(this.directory, { recursive: true });
        const imagePath = path.join(this.directory, operationId + '.png');
        await fs.writeFile(imagePath, before);
        const evidence = {
          operationId,
          url: board.url,
          title: board.title,
          planHash: board.planHash,
          blockId: block.id,
          kind: block.kind,
          world,
          expectedWorld,
          bounds,
          camera,
          content,
          runs,
          style,
          anchorPoint: worldBox({ ...anchorPoint, width: 1, height: 1 }, actualAnchor),
          imagePath,
        };
        await writeJson(this.file(operationId), evidence);
        await page.waitForTimeout(1200);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await a.openDocument(board.url);
        await a.closePanels(page);
        await restoreBoardViewport(a, page, view, camera, options);
        timed('evidence-save-reload-and-camera');
        if (block.kind === 'image') {
          // Persisted images use a different rasterizer from selected images.
          // Retain both screenshots; source pixels/crop and geometry below are
          // the independent persistence proof. Later revisions compare against
          // this unselected persisted appearance, including possible overlays.
          await a.objects.readingMode(page);
          evidence.beforeReloadImagePath = evidence.imagePath;
          evidence.imagePath = path.join(this.directory, operationId + '-persisted.png');
          evidence.bounds = screenBox(world, await a.scans.anchor(page));
          await fs.writeFile(evidence.imagePath, await page.screenshot({ animations: 'disabled' }));
          await writeJson(this.file(operationId), evidence);
        }
        const verification = await this.verify(board, block, operationId, options);
        timed('independent-persistence-verification');
        await a.documents.invalidate(board.url);
        return {
          verified: true,
          verification: 'native-study-block-content-style-layout-and-appearance-after-reload',
          blockId: block.id,
          stageTimings,
          world,
          layout: {
            x: world.x - board.worldOrigin.x,
            y: world.y - board.worldOrigin.y,
            width: world.width,
            height: world.height,
          },
          ...verification,
        };
      },
      options,
    );
  }
  async verify(board, block, operationId, options = {}) {
    const a = this.a,
      e = await readJson(this.file(operationId), null);
    if (
      !e ||
      e.url !== board.url ||
      e.title !== board.title ||
      e.planHash !== board.planHash ||
      e.blockId !== block.id
    )
      throw new GoodnotesError(
        'NO_VERIFICATION_CHECKPOINT',
        'No matching saved block checkpoint; no mutation will be retried.',
      );
    return this.verifyEvidence(board, block, e, options);
  }
  async verifyEvidence(board, block, e, options = {}) {
    if (
      e.blockId !== block.id ||
      e.kind !== block.kind ||
      (block.kind === 'text' && e.content !== block.text)
    )
      throw new GoodnotesError(
        'CHECKPOINT_CONFLICT',
        'Saved native evidence does not match the expected block.',
      );
    const a = this.a;
    if (block.kind === 'image') validateStudyImageBounds(e.bounds, block);
    const { page, view } = await this.position(board, block, options),
      anchor = await a.scans.anchor(page),
      bounds = screenBox(e.world, anchor);
    await a.objects.readingMode(page);
    const { comparison: appearance } = await waitForMappedRegion(
      page,
      await fs.readFile(e.imagePath),
      e.bounds,
      bounds,
      options,
    );
    if (!appearance.matches)
      throw new GoodnotesError(
        'SAVE_UNVERIFIED',
        'Study block appearance differs from its written checkpoint.',
        { blockId: block.id, appearance },
      );
    const p = screenBox(e.anchorPoint, anchor),
      point = {
        x: (p.x - view.canvas.x) / view.canvas.width,
        y: (p.y - view.canvas.y) / view.canvas.height,
      };
    let imageSource;
    if (block.kind === 'text') {
      const read = await a.readText({ viewId: view.viewId, ...point, expectedKind: 'text-box' });
      verifyStudyLinks(block, read.formatting);
      if (read.text !== e.content || digest(read.formatting) !== digest(e.runs))
        throw new GoodnotesError(
          'SAVE_UNVERIFIED',
          'Exact study text or formatting differs after reload.',
          { blockId: block.id },
        );
      const selected = await a.objects.select({ viewId: view.viewId, ...point });
      if (!nearBounds(selected.bounds, bounds, 3))
        throw new GoodnotesError('SAVE_UNVERIFIED', 'The card geometry changed.');
      const probe = await a.textBoxStyle.prepare({ selectionId: selected.selectionId }, options);
      if (!probe.supported || digest(probe.state) !== digest(e.style))
        throw new GoodnotesError('SAVE_UNVERIFIED', 'The native card style differs.');
      await a.objects.readingMode(page);
    } else {
      const selected = await this.imageSelection(page, view, bounds, block);
      if (!nearBounds(selected.bounds, bounds, 3))
        throw new GoodnotesError('SAVE_UNVERIFIED', 'The complete image geometry changed.');
      const probe = await a.imageCrop.prepare({ selectionId: selected.selectionId });
      const bytes = await fs.readFile(block.filePath);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== block.sha256)
        throw new GoodnotesError('SOURCE_ASSET_CHANGED', 'The planned original image changed.');
      imageSource = await verifyStudyImageSource(
        bytes,
        a.imageCrop.preparations.get(probe.cropId).state,
        block.nativeCrop,
      );
      await a.objects.readingMode(page);
    }
    return {
      appearance,
      ...(imageSource ? { imageSource } : {}),
      checkpointPath: this.file(e.operationId),
      world: e.world,
      layout: {
        x: e.world.x - board.worldOrigin.x,
        y: e.world.y - board.worldOrigin.y,
        width: e.world.width,
        height: e.world.height,
      },
    };
  }
}
