import crypto from 'node:crypto';
import { createOcr } from './ocr.mjs';
import { regionHash, compareRegion, changedAlongLine } from './visual.mjs';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { mutate, requireWritable } from './mutations.mjs';
import { configureInk } from './ink-style.mjs';

export function matchLines(lines, query, minConfidence = 40) {
  const needle = query.trim().toLocaleLowerCase();
  return lines
    .filter(
      (l) =>
        l.confidence >= minConfidence && (!needle || l.text.toLocaleLowerCase().includes(needle)),
    )
    .map((l) => {
      // Prefer a matching word for the click point; line centers can fall into blank gaps.
      const word =
        l.words.find((w) => needle && needle.includes(w.text.toLocaleLowerCase())) || l.words[0];
      return {
        ...l,
        point: word
          ? { x: (word.bbox.x0 + word.bbox.x1) / 2, y: (word.bbox.y0 + word.bbox.y1) / 2 }
          : { x: (l.bbox.x0 + l.bbox.x1) / 2, y: (l.bbox.y0 + l.bbox.y1) / 2 },
      };
    });
}
export class BoardController {
  constructor(adapter) {
    this.a = adapter;
    this.matches = new Map();
  }
  async connector({ viewId, from, to, arrow = true, inkStyle, operationId }, options) {
    const view = this.a.getView(viewId),
      dx = (to.x - from.x) * view.canvas.width,
      dy = (to.y - from.y) * view.canvas.height,
      length = Math.hypot(dx, dy);
    if (length < 40)
      throw new GoodnotesError('INVALID_LINE', 'Use a connector at least 40 visible pixels long.');
    const strokes = [[from, to]];
    if (arrow) {
      const size = Math.min(24, length * 0.2),
        ux = dx / length,
        uy = dy / length;
      // Separate straight head strokes avoid Goodnotes smoothing a V-shaped
      // stroke through its tip and losing the requested corner.
      strokes.push(
        [
          {
            x: to.x + (-ux * size - uy * size * 0.55) / view.canvas.width,
            y: to.y + (-uy * size + ux * size * 0.55) / view.canvas.height,
          },
          to,
        ],
        [
          to,
          {
            x: to.x + (-ux * size + uy * size * 0.55) / view.canvas.width,
            y: to.y + (-uy * size - ux * size * 0.55) / view.canvas.height,
          },
        ],
      );
    }
    requireWritable(this.a, view);
    for (const point of strokes.flat()) this.a.objects.point(view, point.x, point.y);
    const points = strokes.flat(),
      xs = points.map((p) => view.canvas.x + p.x * view.canvas.width),
      ys = points.map((p) => view.canvas.y + p.y * view.canvas.height),
      box = {
        x: Math.min(...xs) - 16,
        y: Math.min(...ys) - 16,
        width: Math.max(...xs) - Math.min(...xs) + 32,
        height: Math.max(...ys) - Math.min(...ys) + 32,
      };
    this.a.objects.validateBounds(box, view);
    return mutate(
      this.a,
      operationId,
      { action: 'draw-connector', url: view.url, page: view.pageUrl, from, to, arrow, inkStyle },
      async (mark) => {
        const a = this.a,
          page = await a.assertView(view);
        await a.objects.readingMode(page);
        const before = await page.screenshot();
        let configuredStyle;
        if (inkStyle) configuredStyle = await configureInk(a, page, inkStyle, mark, options);
        else {
          await a.objects.tool(page, '#writingToolsButton');
          const pen = page.locator('#penToolButton');
          if ((await pen.isVisible()) && (await pen.getAttribute('data-is-selected')) !== 'true')
            await pen.click();
        }
        for (const stroke of strokes) {
          checkCancellation(options?.signal);
          let start = a.objects.point(view, stroke[0].x, stroke[0].y);
          await page.mouse.move(start.x, start.y);
          mark();
          await page.mouse.down();
          try {
            await page.waitForTimeout(200);
            for (const point of stroke.slice(1)) {
              const end = a.objects.point(view, point.x, point.y),
                steps = Math.max(4, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 2));
              for (let i = 1; i <= steps; i++) {
                checkCancellation(options?.signal);
                await page.mouse.move(
                  start.x + ((end.x - start.x) * i) / steps,
                  start.y + ((end.y - start.y) * i) / steps,
                );
                await page.waitForTimeout(12);
              }
              start = end;
            }
            // Feed the final point through the native stroke smoother before
            // mouseup. Sparse short strokes can otherwise lose their tail.
            for (let settle = 0; settle < 3; settle++) {
              await page.mouse.move(start.x, start.y);
              await page.waitForTimeout(100);
            }
          } finally {
            await page.mouse.up();
          }
          await page.waitForTimeout(250);
        }
        await a.objects.readingMode(page);
        const expected = await page.screenshot();
        if ((await regionHash(before, box)) === (await regionHash(expected, box)))
          throw new GoodnotesError('CREATE_UNVERIFIED', 'No visible connector was created.');
        for (const stroke of strokes)
          for (let i = 1; i < stroke.length; i++) {
            const coverage = await changedAlongLine(
              before,
              expected,
              a.objects.point(view, stroke[i - 1].x, stroke[i - 1].y),
              a.objects.point(view, stroke[i].x, stroke[i].y),
            );
            if (!coverage.matches) {
              await a.objects.evidence(operationId, before, expected);
              throw new GoodnotesError(
                'CREATE_UNVERIFIED',
                'Goodnotes did not draw the full connector path, including its arrowhead.',
                {
                  coverage,
                  from: a.objects.point(view, stroke[i - 1].x, stroke[i - 1].y),
                  to: a.objects.point(view, stroke[i].x, stroke[i].y),
                },
              );
            }
          }
        await page.waitForTimeout(1200);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await a.openDocument(view.pageUrl);
        await a.closePanels(page);
        await a.assertView(view);
        await a.objects.readingMode(page);
        const after = await page.screenshot(),
          appearance = await compareRegion(expected, after, box);
        if (!appearance.matches)
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Connector appearance differed after reload.',
          );
        await a.documents.invalidate(view.url);
        return {
          verified: true,
          verification: 'connector-appearance-after-reload',
          kind: 'ink',
          ...(configuredStyle ? { inkStyle: configuredStyle } : {}),
          bounds: box,
          appearance,
          evidence: await a.objects.evidence(operationId, before, after),
        };
      },
      options,
    );
  }
  async find({ viewId, query = '', minConfidence = 40 }, options) {
    const view = this.a.getView(viewId),
      page = await this.a.assertView(view);
    await this.a.objects.readingMode(page);
    const clip = {
      x: Math.ceil(view.canvas.x),
      y: Math.ceil(view.canvas.y),
      width: Math.floor(view.canvas.width),
      height: Math.floor(view.canvas.height),
    };
    const bytes = await page.screenshot({ clip, animations: 'disabled' }),
      worker = await createOcr(this.a.config.directory, options);
    let result;
    try {
      result = await worker.recognize(bytes, { layout: true });
    } finally {
      await worker.close();
    }
    this.matches.clear();
    const screenshot = await page.screenshot({ animations: 'disabled' });
    const matches = [];
    for (const line of matchLines(result.lines, query, minConfidence).slice(0, 100)) {
      const b = line.bbox,
        box = { x: clip.x + b.x0, y: clip.y + b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 };
      const x = line.point.x / clip.width,
        y = line.point.y / clip.height;
      if (x < 0.02 || x > 0.98 || y < 0.08 || y > 0.92 || box.width < 10 || box.height < 10)
        continue;
      const matchId = crypto.randomUUID(),
        item = {
          matchId,
          viewId,
          query,
          text: line.text,
          confidence: line.confidence,
          box,
          x,
          y,
          created: Date.now(),
          hash: await regionHash(screenshot, box),
        };
      this.matches.set(matchId, item);
      matches.push({ matchId, text: item.text, confidence: item.confidence, x, y, bounds: box });
    }
    return {
      viewId,
      query,
      matches,
      scope: 'current visible viewport only',
      note: 'OCR locations are candidates, not object identities. select_match verifies actual editable text before selecting. Pan/zoom and scan again for off-screen content.',
    };
  }
  async select({ matchId, expectedText }) {
    const m = this.matches.get(matchId);
    if (!m || Date.now() - m.created > 600000)
      throw new GoodnotesError('STALE_MATCH', 'Scan this view again.');
    const view = this.a.getView(m.viewId),
      page = await this.a.assertView(view);
    await this.a.objects.readingMode(page);
    if ((await regionHash(await page.screenshot(), m.box)) !== m.hash)
      throw new GoodnotesError('MATCH_CHANGED', 'The visible text changed since scanning.');
    const target = await this.a.readText({ viewId: m.viewId, x: m.x, y: m.y });
    if (
      (expectedText !== undefined && target.text !== expectedText) ||
      (m.query && !target.text.toLocaleLowerCase().includes(m.query.toLocaleLowerCase()))
    )
      throw new GoodnotesError(
        'MATCH_NOT_EDITABLE_TEXT',
        'The OCR hit could not be verified as the requested editable text. PDF backgrounds and handwriting are not supported by this selection tool.',
      );
    if (!target.text.trim())
      throw new GoodnotesError('MATCH_NOT_EDITABLE_TEXT', 'No editable text at this match.');
    const bounds = this.a.targets.get(target.targetId).editorBounds;
    const region =
      target.formatting.some((r) => r.link) && bounds
        ? {
            x: (bounds.x - 10 - view.canvas.x) / view.canvas.width,
            y: (bounds.y - 10 - view.canvas.y) / view.canvas.height,
            width: (bounds.width + 20) / view.canvas.width,
            height: (bounds.height + 20) / view.canvas.height,
          }
        : undefined;
    const selection = await this.a.objects.select({ viewId: m.viewId, x: m.x, y: m.y, region });
    return {
      ...selection,
      targetId: target.targetId,
      text: target.text,
      kind: target.kind,
      x: m.x,
      y: m.y,
    };
  }
  async moveByText({ url, query, expectedText, toX, toY, operationId }, options) {
    const view = await this.a.inspect({ url }),
      found = await this.find({ viewId: view.viewId, query }, options);
    if (found.matches.length !== 1)
      throw new GoodnotesError(
        'AMBIGUOUS_MATCH',
        'Expected one visible text match; narrow the query or zoom/pan first.',
      );
    const selected = await this.select({ matchId: found.matches[0].matchId, expectedText });
    const currentX =
        (selected.bounds.x + selected.bounds.width / 2 - view.canvas.x) / view.canvas.width,
      currentY =
        (selected.bounds.y + selected.bounds.height / 2 - view.canvas.y) / view.canvas.height;
    return this.a.objects.transform(
      {
        selectionId: selected.selectionId,
        action: 'move',
        dx: toX - currentX,
        dy: toY - currentY,
        operationId,
      },
      options,
    );
  }
  async planLayout({
    url,
    items,
    columns = 2,
    startX = 0.25,
    startY = 0.25,
    spacingX = 0.3,
    spacingY = 0.3,
    title = 'Arrange board',
  }) {
    const steps = items.map((item, i) => ({
      action: 'move-object',
      url,
      query: item.query,
      expectedText: item.expectedText,
      toX: startX + (i % columns) * spacingX,
      toY: startY + Math.floor(i / columns) * spacingY,
    }));
    return this.a.jobs.plan({ title, steps, backup: true });
  }
}
