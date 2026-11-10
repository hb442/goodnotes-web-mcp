import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readJson, writeJson, uuidFile } from './store.mjs';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { regionHash, nearBounds, waitForMappedRegion } from './visual.mjs';
import { frameAtPoint } from './page-frame.mjs';

export function worldBox(bounds, anchor) {
  return {
    x: (bounds.x - anchor.x) / anchor.scale,
    y: (bounds.y - anchor.y) / anchor.scale,
    width: bounds.width / anchor.scale,
    height: bounds.height / anchor.scale,
  };
}
export function screenBox(bounds, anchor) {
  return {
    x: bounds.x * anchor.scale + anchor.x,
    y: bounds.y * anchor.scale + anchor.y,
    width: bounds.width * anchor.scale,
    height: bounds.height * anchor.scale,
  };
}
export function sameHit(a, b) {
  if (a.text.trim().toLocaleLowerCase() !== b.text.trim().toLocaleLowerCase()) return false;
  const x = Math.max(a.world.x, b.world.x),
    y = Math.max(a.world.y, b.world.y),
    w = Math.max(0, Math.min(a.world.x + a.world.width, b.world.x + b.world.width) - x),
    h = Math.max(0, Math.min(a.world.y + a.world.height, b.world.y + b.world.height) - y);
  return (w * h) / Math.min(a.world.width * a.world.height, b.world.width * b.world.height) > 0.35;
}
export class BoardScanController {
  constructor(adapter) {
    this.a = adapter;
    this.directory = path.join(adapter.config.directory, 'board-scans');
  }
  async anchor(page) {
    const items = await page.locator('[id^="interaction-layer-page-"]').evaluateAll((es) =>
      es
        .map((e) => {
          const b = e.getBoundingClientRect(),
            m = new DOMMatrixReadOnly(getComputedStyle(e).transform);
          return {
            pageId: e.id,
            x: b.x,
            y: b.y,
            width: b.width,
            height: b.height,
            scale: m.a,
            rotated: Math.abs(m.b) + Math.abs(m.c) > 1e-6,
          };
        })
        .filter((b) => b.width > 10000 && b.height > 10000),
    );
    if (items.length !== 1 || items[0].rotated || !(items[0].scale > 0))
      throw new GoodnotesError(
        'BOARD_ANCHOR_UNAVAILABLE',
        'A single native whiteboard coordinate surface is required.',
      );
    return items[0];
  }
  async position(url, target, options = {}) {
    let view = await this.a.inspect({ url }),
      page = await this.a.getPage();
    await this.a.objects.readingMode(page);
    const readAnchor = async () => {
      const current =
        target.kind === 'notebook'
          ? await this.notebookAnchor(page, target.pageId)
          : await this.anchor(page);
      if (
        target.kind === 'notebook' &&
        (Math.abs(current.nativeWidth - target.nativeWidth) > 0.1 ||
          Math.abs(current.nativeHeight - target.nativeHeight) > 0.1)
      )
        throw new GoodnotesError(
          'PAGE_GEOMETRY_CHANGED',
          'The saved native page dimensions changed.',
        );
      return current;
    };
    let anchor = await readAnchor();
    if (anchor.pageId !== target.pageId)
      throw new GoodnotesError('BOARD_CHANGED', 'This is a different board page.');
    for (let i = 0; i < 20 && Math.abs(anchor.scale - target.scale) > 0.0001; i++) {
      checkCancellation(options.signal);
      const before = anchor.scale;
      view = await this.a.navigate({
        viewId: view.viewId,
        zoomSteps: anchor.scale < target.scale ? 1 : -1,
      });
      anchor = await readAnchor();
      if (
        (before - target.scale) * (anchor.scale - target.scale) < 0 &&
        Math.abs(anchor.scale - target.scale) > 0.0001
      )
        throw new GoodnotesError('BOARD_ZOOM_CHANGED', 'Saved zoom is no longer reachable.');
    }
    if (Math.abs(anchor.scale - target.scale) > 0.0001)
      throw new GoodnotesError('BOARD_ZOOM_CHANGED', 'Cannot restore saved zoom.');
    let previous = '';
    const wheelGain = { x: 1, y: 1 };
    for (let i = 0; i < 32; i++) {
      checkCancellation(options.signal);
      const dx = anchor.x - target.x,
        dy = anchor.y - target.y;
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return { view, anchor, page };
      const key = `${anchor.x},${anchor.y}`;
      if (previous === key)
        throw new GoodnotesError(
          'BOARD_PAN_UNVERIFIED',
          'Goodnotes did not move to the saved board position.',
        );
      previous = key;
      const axis =
        Math.abs(dx) >= Math.abs(dy)
          ? { panX: Math.max(-600, Math.min(600, dx)) }
          : { panY: Math.max(-600, Math.min(600, dy)) };
      if (target.kind === 'notebook') {
        view = await this.a.navigate({ viewId: view.viewId, ...axis });
      } else {
        // Native wheel movement is amplified and capped. Measure its gain with
        // bounded input, then correct the residual instead of oscillating.
        const coordinate = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
        const delta = coordinate === 'x' ? dx : dy;
        // Fractional deltas are classified as trackpad input (1x), whereas
        // integral wheel input is accelerated. Mixing the two causes oscillation.
        const input =
          Math.sign(delta) *
          Math.max(1, Math.min(100, Math.round(Math.abs(delta) / wheelGain[coordinate])));
        view = await this.a.navigate({
          viewId: view.viewId,
          [coordinate === 'x' ? 'panX' : 'panY']: input,
        });
        const moved = await readAnchor();
        const gain = (anchor[coordinate] - moved[coordinate]) / input;
        if (Number.isFinite(gain) && gain > 0.01 && gain < 100) wheelGain[coordinate] = gain;
      }
      anchor = await readAnchor();
    }
    throw new GoodnotesError(
      'BOARD_PAN_UNVERIFIED',
      'The saved board position could not be reached within the bounded navigation.',
    );
  }
  async notebookAnchor(page, pageId) {
    if (!/^[a-f0-9-]{36}$/i.test(pageId))
      throw new GoodnotesError('INVALID_PAGE_ID', 'A native notebook page identity is required.');
    const element = page.locator('#interaction-layer-page-' + pageId);
    if ((await element.count()) !== 1)
      throw new GoodnotesError(
        'PAGE_FRAME_UNAVAILABLE',
        'The saved notebook page is not mounted exactly once.',
      );
    const anchor = await element.evaluate((e) => {
      const b = e.getBoundingClientRect(),
        css = getComputedStyle(e),
        matrix = new DOMMatrixReadOnly(css.transform),
        nativeWidth = parseFloat(css.width),
        nativeHeight = parseFloat(css.height);
      return {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        nativeWidth,
        nativeHeight,
        scale: b.width / nativeWidth,
        scaleY: b.height / nativeHeight,
        rotated: Math.abs(matrix.b) + Math.abs(matrix.c) > 1e-6,
      };
    });
    if (
      anchor.rotated ||
      !Number.isFinite(anchor.scale + anchor.scaleY) ||
      anchor.scale <= 0 ||
      Math.abs(anchor.scale / anchor.scaleY - 1) > 0.001 ||
      anchor.nativeWidth < 10 ||
      anchor.nativeHeight < 10 ||
      anchor.width > 10000 ||
      anchor.height > 10000
    )
      throw new GoodnotesError(
        'PAGE_FRAME_UNAVAILABLE',
        'A non-rotated native notebook coordinate surface is required.',
      );
    return { ...anchor, pageId, kind: 'notebook' };
  }
  async selectionAnchor(page, bounds) {
    const frame = await frameAtPoint(page, {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    });
    if (frame.width > 10000 && frame.height > 10000) return this.anchor(page);
    if (
      bounds.x < frame.x - 2 ||
      bounds.y < frame.y - 2 ||
      bounds.x + bounds.width > frame.x + frame.width + 2 ||
      bounds.y + bounds.height > frame.y + frame.height + 2
    )
      throw new GoodnotesError(
        'OBJECT_CROSSES_PAGE',
        'The selected object must fit inside one native page.',
      );
    return this.notebookAnchor(page, frame.pageId);
  }
  async get(scanId) {
    const job = await readJson(uuidFile(this.directory, scanId), null);
    if (!job) throw new GoodnotesError('SCAN_NOT_FOUND', 'Board scan not found.');
    return job;
  }
  async scan(
    {
      scanId,
      url,
      columns = 3,
      rows = 3,
      overlap = 0.4,
      zoomSteps = 0,
      maxTiles = 1,
      savePreviews = false,
    },
    options = {},
  ) {
    let job;
    if (scanId) job = await this.get(scanId);
    else {
      if (!url) throw new GoodnotesError('URL_REQUIRED', 'Provide a board URL for a new scan.');
      let view = await this.a.inspect({ url });
      if (zoomSteps) view = await this.a.navigate({ viewId: view.viewId, zoomSteps });
      const page = await this.a.getPage();
      await this.a.objects.readingMode(page);
      const anchor = await this.anchor(page);
      scanId = crypto.randomUUID();
      job = {
        scanId,
        url: this.a.getView(view.viewId).pageUrl,
        title: view.title,
        columns,
        rows,
        overlap,
        savePreviews,
        createdAt: new Date().toISOString(),
        status: 'running',
        origin: anchor,
        cursor: anchor,
        tiles: [],
        matches: [],
      };
      await writeJson(uuidFile(this.directory, scanId), job);
    }
    const total = job.columns * job.rows;
    for (let n = 0; n < maxTiles && job.tiles.length < total && job.status === 'running'; n++) {
      checkCancellation(options.signal);
      let { view, anchor, page } = await this.position(job.url, job.cursor, options);
      const index = job.tiles.length;
      if (index) {
        const row = Math.floor(index / job.columns),
          atRowStart = index % job.columns === 0;
        view = await this.a.navigate({
          viewId: view.viewId,
          ...(atRowStart
            ? { panY: view.canvas.height * (1 - job.overlap) }
            : { panX: view.canvas.width * (1 - job.overlap) * (row % 2 ? -1 : 1) }),
        });
        anchor = await this.anchor(page);
        if (Math.hypot(anchor.x - job.cursor.x, anchor.y - job.cursor.y) < 3) {
          job.status = 'boundary-reached';
          await writeJson(uuidFile(this.directory, scanId), job);
          break;
        }
      }
      const found = await this.a.board.find({ viewId: view.viewId }, options);
      const tile = {
        index,
        anchor,
        canvas: view.canvas,
        scannedAt: new Date().toISOString(),
        hits: found.matches.length,
      };
      for (const hit of found.matches) {
        const candidate = {
          id: crypto.randomUUID(),
          text: hit.text,
          confidence: hit.confidence,
          world: worldBox(hit.bounds, anchor),
          anchor,
          x: hit.x,
          y: hit.y,
          tile: index,
        };
        const old = job.matches.find((m) => sameHit(m, candidate));
        if (!old) job.matches.push(candidate);
        else if (candidate.confidence > old.confidence)
          Object.assign(old, { ...candidate, id: old.id });
      }
      if (job.savePreviews) {
        tile.preview = path.join(this.directory, scanId + `-tile-${index}.png`);
        await fs.writeFile(tile.preview, await page.screenshot({ animations: 'disabled' }), {
          mode: 0o600,
        });
      }
      job.tiles.push(tile);
      job.cursor = anchor;
      if (job.tiles.length === total) job.status = 'completed-region';
      await writeJson(uuidFile(this.directory, scanId), job);
    }
    return {
      scanId,
      status: job.status,
      processedTiles: job.tiles.length,
      plannedTiles: total,
      matches: job.matches.length,
      scope:
        'Bounded serpentine region starting at the original viewport, moving right then down. This does not prove complete coverage of an infinite board.',
      next: 'Use search_board_scan to find saved text and select_board_match to reacquire an editable object.',
    };
  }
  async search({ scanId, query = '', offset = 0, limit = 30 }) {
    const job = await this.get(scanId),
      matches = job.matches.filter((m) =>
        m.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      );
    return {
      scanId,
      url: job.url,
      title: job.title,
      status: job.status,
      createdAt: job.createdAt,
      total: matches.length,
      matches: matches.slice(offset, offset + limit).map(({ anchor, ...m }) => m),
      nextOffset: offset + limit < matches.length ? offset + limit : null,
      scope:
        'OCR text locations, not stable Goodnotes object IDs; images and shapes need a saved explicit selection.',
    };
  }
  async select({ scanId, matchId, expectedText }, options) {
    const job = await this.get(scanId),
      hit = job.matches.find((m) => m.id === matchId);
    if (!hit) throw new GoodnotesError('MATCH_NOT_FOUND', 'Saved scan match not found.');
    const { view, anchor } = await this.position(job.url, hit.anchor, options),
      box = screenBox(hit.world, anchor),
      found = await this.a.board.find({ viewId: view.viewId, query: hit.text.trim() }, options);
    const candidates = found.matches.filter((m) =>
      sameHit({ text: hit.text, world: box }, { text: m.text, world: m.bounds }),
    );
    if (candidates.length !== 1)
      throw new GoodnotesError(
        'SAVED_MATCH_CHANGED',
        'The saved text location is missing, changed or ambiguous. Scan this area again.',
      );
    return this.a.board.select({ matchId: candidates[0].matchId, expectedText });
  }
  async remember({ selectionId, label }) {
    const { s, view, page } = await this.a.styles.selection(selectionId),
      anchor = await this.selectionAnchor(page, s.bounds),
      objectId = crypto.randomUUID();
    await this.a.objects.readingMode(page);
    const screenshot = await page.screenshot({ animations: 'disabled' }),
      fingerprint = await regionHash(screenshot, s.bounds);
    const record = {
      objectId,
      label,
      url: view.pageUrl,
      anchor,
      world: worldBox(s.bounds, anchor),
      fingerprint,
      createdAt: new Date().toISOString(),
    };
    if (anchor.kind === 'notebook') {
      const directory = path.join(this.directory, 'objects');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(directory, objectId + '.png'), screenshot, { mode: 0o600 });
      record.appearanceSha256 = crypto.createHash('sha256').update(screenshot).digest('hex');
    }
    await writeJson(uuidFile(path.join(this.directory, 'objects'), objectId), record);
    return {
      objectId,
      label,
      url: view.url,
      world: record.world,
      note: 'A guarded visual bookmark, not a backend object ID. Moving or recoloring the object invalidates it.',
    };
  }
  async recall({ objectId }, options) {
    const record = await readJson(uuidFile(path.join(this.directory, 'objects'), objectId), null);
    if (!record) throw new GoodnotesError('OBJECT_NOT_FOUND', 'Saved visual object not found.');
    const { view, anchor, page } = await this.position(record.url, record.anchor, options),
      bounds = screenBox(record.world, anchor);
    let matches, comparison;
    if (record.anchor.kind === 'notebook' && record.appearanceSha256) {
      const expected = await fs.readFile(path.join(this.directory, 'objects', objectId + '.png'));
      if (crypto.createHash('sha256').update(expected).digest('hex') !== record.appearanceSha256)
        throw new GoodnotesError(
          'BOOKMARK_CHECKPOINT_CHANGED',
          'The saved appearance checkpoint changed.',
        );
      // Native notebook pages can mount several seconds before their objects.
      // Re-read only; never reinsert or repeat a document change.
      ({ comparison } = await waitForMappedRegion(
        page,
        expected,
        screenBox(record.world, record.anchor),
        bounds,
        options,
      ));
      matches = comparison.matches;
    } else
      matches =
        (await regionHash(await page.screenshot({ animations: 'disabled' }), bounds)) ===
        record.fingerprint;
    if (!matches)
      throw new GoodnotesError(
        'SAVED_OBJECT_CHANGED',
        'The saved object appearance changed. Select and remember it again.',
        comparison ? { comparison } : {},
      );
    await this.a.objects.reselectBounds(page, this.a.getView(view.viewId), bounds);
    const fresh = await this.a.objects.snapshot(page, this.a.getView(view.viewId));
    if (!nearBounds(fresh.bounds, bounds, 2))
      throw new GoodnotesError(
        'SAVED_SELECTION_CHANGED',
        'The native selection no longer matches the saved object bounds.',
      );
    const selectionId = crypto.randomUUID();
    this.a.objects.selections.clear();
    this.a.objects.selections.set(selectionId, {
      ...fresh,
      viewId: view.viewId,
      created: Date.now(),
      kind: fresh.kind ?? 'object-or-group',
    });
    return {
      selectionId,
      viewId: view.viewId,
      label: record.label,
      bounds: fresh.bounds,
      kind: fresh.kind ?? 'object-or-group',
    };
  }
}
