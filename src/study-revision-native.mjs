import fs from 'node:fs/promises';
import path from 'node:path';
import { GoodnotesError } from './errors.mjs';
import { mutate } from './mutations.mjs';
import { readJson, writeJson } from './store.mjs';
import { digest } from './journal.mjs';
import { pixels, compareRegion, nearBounds, waitForMappedRegion } from './visual.mjs';
import { worldBox, screenBox } from './board-scan.mjs';
import { captureBoardViewport } from './viewport.mjs';
import { validateStudyImageBounds } from './study-native.mjs';

const expanded = (r, n = 24) => ({
  x: r.x - n,
  y: r.y - n,
  width: r.width + n * 2,
  height: r.height + n * 2,
});
const inside = (x, y, r) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
// At the workflow's fixed 100% camera, the native whiteboard grid repeats every
// 25 pixels. Learn its exact light-gray dot from many independent visible tiles.
// Never exempt whole grid cells: an extra pixel or darker stroke still rejects.
function nativeDotGrid(p) {
  const period = 25,
    patterns = new Map();
  const span = (values) =>
    Math.min(
      ...values.map((start) => Math.max(...values.map((v) => (v - start + period) % period)) + 1),
    );
  for (let y = 125; y + period < p.height - 64; y += period)
    for (let x = 0; x + period < p.width; x += period) {
      const dots = [];
      let invalid = false;
      for (let dy = 0; dy < period && !invalid; dy++)
        for (let dx = 0; dx < period; dx++) {
          const i = ((y + dy) * p.width + x + dx) * 4,
            [r, g, b] = p.data.slice(i, i + 3);
          if (Math.min(r, g, b) >= 248) continue;
          if (r < 220 || r !== g || g !== b || dots.length >= 9) {
            invalid = true;
            break;
          }
          dots.push([dx, dy, r]);
        }
      if (
        invalid ||
        dots.length < 3 ||
        span(dots.map((d) => d[0])) > 3 ||
        span(dots.map((d) => d[1])) > 3
      )
        continue;
      const key = JSON.stringify(dots),
        entry = patterns.get(key) ?? { dots, count: 0, xs: new Set(), ys: new Set() };
      entry.count++;
      entry.xs.add(x);
      entry.ys.add(y);
      patterns.set(key, entry);
    }
  const best = [...patterns.values()]
    .filter((e) => e.count >= 12 && e.xs.size >= 3 && e.ys.size >= 3)
    .sort((a, b) => b.count - a.count)[0];
  const colors = new Map(best?.dots.map(([x, y, v]) => [y * period + x, v]) ?? []);
  return (x, y, i) => {
    const v = colors.get((y % period) * period + (x % period));
    return v !== undefined && [0, 1, 2].every((c) => Math.abs(p.data[i + c] - v) <= 2);
  };
}
export async function assertBlankStudyRegion(bytes, region, excluded = []) {
  const p = await pixels(bytes);
  if (
    region.x < 0 ||
    region.y < 0 ||
    region.x + region.width > p.width ||
    region.y + region.height > p.height
  )
    throw new GoodnotesError('REGION_NOT_VISIBLE', 'The complete destination must be visible.');
  const grid = nativeDotGrid(p);
  let checked = 0;
  for (let y = Math.floor(region.y); y < Math.ceil(region.y + region.height); y++)
    for (let x = Math.floor(region.x); x < Math.ceil(region.x + region.width); x++) {
      if (excluded.some((r) => inside(x, y, r))) continue;
      checked++;
      const i = (y * p.width + x) * 4;
      if (Math.min(p.data[i], p.data[i + 1], p.data[i + 2]) < 248 && !grid(x, y, i))
        throw new GoodnotesError(
          'DESTINATION_NOT_EMPTY',
          'Visible content or a nonwhite background occupies the destination. Existing notes will not be covered.',
          { x, y },
        );
    }
  return { checkedPixels: checked };
}
export async function compareStudySurroundings(before, after, canvas, allowed) {
  const a = await pixels(before),
    b = await pixels(after);
  if (a.width !== b.width || a.height !== b.height)
    throw new GoodnotesError('VIEWPORT_CHANGED', 'The viewport changed during the revision.');
  for (const p of [a, b])
    for (const r of allowed) {
      p.ctx.fillStyle = '#ffffff';
      p.ctx.fillRect(r.x, r.y, r.width, r.height);
    }
  // Fixed native toolbar and transient bottom zoom UI are not document content.
  const region = {
    x: canvas.x + 8,
    y: Math.max(canvas.y + 56, 105),
    width: canvas.width - 16,
    height: canvas.height - (Math.max(canvas.y + 56, 105) - canvas.y) - 64,
  };
  const result = await compareRegion(
    a.canvas.toBuffer('image/png'),
    b.canvas.toBuffer('image/png'),
    region,
  );
  if (!result.matches)
    throw new GoodnotesError(
      'SURROUNDINGS_CHANGED',
      'Visible content outside the selected revision regions changed.',
      result,
    );
  return result;
}
export class StudyRevisionNative {
  constructor(a) {
    this.a = a;
    this.directory = path.join(a.config.directory, 'study-revision-evidence');
  }
  file(id) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id))
      throw new GoodnotesError('INVALID_OPERATION_ID', 'Invalid revision operation.');
    return path.join(this.directory, id + '.json');
  }
  async capture(board, block, operationId, expectedStyle, options = {}) {
    const a = this.a,
      n = a.study.native,
      { page, view, rect } = await n.position(board, block, options);
    const point =
      block.kind === 'text'
        ? n.point(view, rect)
        : {
            x: (rect.x + rect.width / 2 - view.canvas.x) / view.canvas.width,
            y: (rect.y + rect.height / 2 - view.canvas.y) / view.canvas.height,
          };
    let content, runs, style;
    if (block.kind === 'text') {
      const text = await a.readText({ viewId: view.viewId, ...point, expectedKind: 'text-box' });
      if (text.text !== block.text)
        throw new GoodnotesError(
          'TEXT_CONFLICT',
          'Revised native text differs from the frozen plan.',
        );
      content = text.text;
      runs = text.formatting;
    }
    const selected = await a.objects.select({ viewId: view.viewId, ...point }),
      bounds = selected.bounds;
    if (block.kind === 'image') validateStudyImageBounds(bounds, rect, !block.keepNativeSize);
    if (block.kind === 'text') {
      const probe = await a.textBoxStyle.prepare({ selectionId: selected.selectionId }, options);
      if (!probe.supported || digest(probe.state) !== digest(expectedStyle))
        throw new GoodnotesError(
          'STYLE_CHANGED',
          'Revision changed the native card background or border.',
        );
      style = probe.state;
      await a.textBoxStyle.close(page);
    }
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
        'The revised object exceeds its reserved slot.',
        { planned: rect, actual: bounds },
      );
    const anchor = await a.scans.anchor(page),
      world = worldBox(bounds, anchor);
    await a.objects.readingMode(page);
    let evidenceBounds = bounds;
    if (block.kind === 'image') {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await n.position(board, block, options);
      await a.objects.readingMode(page);
      evidenceBounds = screenBox(world, await a.scans.anchor(page));
    }
    const imagePath = path.join(n.directory, operationId + '.png');
    await fs.mkdir(n.directory, { recursive: true });
    await fs.writeFile(imagePath, await page.screenshot({ animations: 'disabled' }));
    const e = {
      operationId,
      url: board.url,
      title: board.title,
      planHash: board.planHash,
      blockId: block.id,
      kind: block.kind,
      world,
      bounds: evidenceBounds,
      camera: await captureBoardViewport(page),
      content,
      runs,
      style,
      anchorPoint: worldBox(
        {
          x: view.canvas.x + point.x * view.canvas.width,
          y: view.canvas.y + point.y * view.canvas.height,
          width: 1,
          height: 1,
        },
        anchor,
      ),
      imagePath,
    };
    await writeJson(n.file(operationId), e);
    return { ...(await n.verify(board, block, operationId, options)), verified: true };
  }
  async apply(board, step, operationId, options = {}) {
    const a = this.a,
      n = a.study.native;
    return mutate(
      a,
      operationId,
      { action: 'study-revision-block', url: board.url, planHash: board.planHash, step },
      async (mark) => {
        let previous;
        if (step.kind !== 'add') {
          previous = await readJson(step.checkpointPath, null);
          if (!previous)
            throw new GoodnotesError('NO_VERIFICATION_CHECKPOINT', 'No original block checkpoint.');
          await n.verifyEvidence(board, step.before, previous, options);
          if (step.before.kind === 'image') {
            // Reading the native crop can activate a different image renderer.
            // Restore its persisted appearance before comparing the old padding.
            await (await a.getPage()).reload({ waitUntil: 'domcontentloaded' });
          }
        }
        const positionBlock =
          board.horizontalPan && step.before
            ? {
                ...step.before,
                x: Math.min(step.before.x, step.after.x),
                y: Math.min(step.before.y, step.after.y),
              }
            : (step.before ?? step.after);
        const { page, view } = await n.position(board, positionBlock, options);
        await a.objects.readingMode(page);
        const anchor = await a.scans.anchor(page);
        let beforeBytes = await page.screenshot({ animations: 'disabled' });
        const oldRect = previous ? screenBox(previous.world, anchor) : null;
        // Native selection bounds omit part of a text box's visible padding.
        // Exempt that margin only after comparing it against the original full
        // screenshot too, so a handwritten addition there is still a conflict.
        const oldProtected = oldRect ? expanded(oldRect) : null;
        if (previous) {
          const probe = await waitForMappedRegion(
            page,
            await fs.readFile(previous.imagePath),
            expanded(previous.bounds),
            oldProtected,
            options,
          );
          if (!probe.comparison.matches)
            throw new GoodnotesError(
              'SOURCE_REGION_CHANGED',
              'The selected object or its surrounding padding was changed.',
            );
          beforeBytes = probe.bytes;
        }
        const targetWorld = {
          x: board.worldOrigin.x + step.after.x,
          y: board.worldOrigin.y + step.after.y,
          width: step.after.width,
          height: step.after.height,
        };
        const target = screenBox(targetWorld, anchor);
        a.objects.validateBounds(target, view);
        const allowed = [...(oldRect ? [expanded(oldRect)] : []), expanded(target)];
        await assertBlankStudyRegion(
          beforeBytes,
          expanded(target, 20),
          oldProtected ? [oldProtected] : [],
        );
        await fs.mkdir(this.directory, { recursive: true });
        const beforePath = path.join(this.directory, operationId + '.png');
        await fs.writeFile(beforePath, beforeBytes);
        const guard = {
          operationId,
          url: board.url,
          planHash: board.planHash,
          step,
          positionBlock,
          beforePath,
          canvas: view.canvas,
          allowed,
        };
        await writeJson(this.file(operationId), guard);
        let result;
        if (step.kind === 'add') {
          mark();
          result = await n.create(board, step.after, operationId + '-native', options);
        } else if (step.kind === 'edit') {
          const p = screenBox(previous.anchorPoint, anchor),
            point = {
              x: (p.x - view.canvas.x) / view.canvas.width,
              y: (p.y - view.canvas.y) / view.canvas.height,
            };
          const read = await a.readText({
            viewId: view.viewId,
            ...point,
            expectedKind: 'text-box',
          });
          if (read.text !== previous.content || digest(read.formatting) !== digest(previous.runs))
            throw new GoodnotesError(
              'TEXT_CONFLICT',
              'The selected card was changed after planning.',
            );
          mark();
          await a.text.edit(
            {
              targetId: read.targetId,
              replacement: step.after.text,
              format: { fontSize: step.after.fontSize, bold: false },
              formatRanges: [
                {
                  start: 0,
                  end: step.after.headingLength,
                  format: { fontSize: step.after.headingSize, bold: true },
                },
              ],
              operationId: operationId + '-native',
            },
            options,
          );
          result = await this.capture(
            board,
            step.after,
            operationId + '-native',
            previous.style,
            options,
          );
        } else {
          const selected = await a.objects.select({
            viewId: view.viewId,
            x: (oldRect.x + oldRect.width / 2 - view.canvas.x) / view.canvas.width,
            y: (oldRect.y + oldRect.height / 2 - view.canvas.y) / view.canvas.height,
          });
          if (!nearBounds(selected.bounds, oldRect, 3))
            throw new GoodnotesError(
              'SELECTION_CHANGED',
              'The original object moved or its bounds changed.',
            );
          mark();
          await a.objects.transform(
            {
              selectionId: selected.selectionId,
              action: 'move',
              dx: (step.after.x - step.before.x) / view.canvas.width,
              dy: (step.after.y - step.before.y) / view.canvas.height,
              operationId: operationId + '-native',
            },
            options,
          );
          result = await this.capture(
            board,
            step.after,
            operationId + '-native',
            previous.style,
            options,
          );
        }
        guard.result = result;
        await writeJson(this.file(operationId), guard);
        const surroundings = await this.checkSurroundings(board, guard, options);
        return { ...result, verified: true, surroundings };
      },
      options,
    );
  }
  async checkSurroundings(board, guard, options = {}) {
    const { page } = await this.a.study.native.position(board, guard.positionBlock, options);
    await this.a.objects.readingMode(page);
    return compareStudySurroundings(
      await fs.readFile(guard.beforePath),
      await page.screenshot({ animations: 'disabled' }),
      guard.canvas,
      guard.allowed,
    );
  }
  async verify(board, step, operationId, options = {}) {
    const guard = await readJson(this.file(operationId), null);
    if (
      !guard?.result ||
      guard.url !== board.url ||
      guard.planHash !== board.planHash ||
      digest(guard.step) !== digest(step)
    )
      throw new GoodnotesError(
        'NO_VERIFICATION_CHECKPOINT',
        'The interrupted revision has no complete matching checkpoint; no write will be replayed.',
      );
    if (guard.repair) {
      const receipt = await this.a.journal.get(guard.repair.operationId);
      if (receipt.status !== 'verified')
        throw new GoodnotesError(
          'REPAIR_UNVERIFIED',
          'The separately inspected repair has no verified operation receipt.',
        );
    }
    const block = await this.a.study.native.verify(
      board,
      step.after,
      guard.repair?.checkpointOperationId ?? operationId + '-native',
      options,
    );
    return {
      ...block,
      verified: true,
      surroundings: await this.checkSurroundings(board, guard, options),
    };
  }
  async recordInspectedRepair(
    board,
    step,
    operationId,
    repairOperationId,
    checkpointOperationId,
    options = {},
  ) {
    const guard = await readJson(this.file(operationId), null),
      receipt = await this.a.journal.get(repairOperationId);
    if (
      !guard ||
      guard.url !== board.url ||
      guard.planHash !== board.planHash ||
      digest(guard.step) !== digest(step) ||
      receipt.status !== 'verified'
    )
      throw new GoodnotesError(
        'REPAIR_UNVERIFIED',
        'A matching guard and independently verified repair are required.',
      );
    const block = await this.a.study.native.verify(
      board,
      step.after,
      checkpointOperationId,
      options,
    );
    const surroundings = await this.checkSurroundings(board, guard, options);
    if (guard.repair) {
      guard.repairHistory ??= [];
      guard.repairHistory.push(guard.repair);
    }
    guard.repair = {
      operationId: repairOperationId,
      checkpointOperationId,
      checkedAt: new Date().toISOString(),
      result: { ...block, surroundings },
    };
    await writeJson(this.file(operationId), guard);
    return { ...block, surroundings, verified: true };
  }
}
