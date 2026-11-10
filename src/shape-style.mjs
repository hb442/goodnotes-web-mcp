import crypto from 'node:crypto';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { mutate, requireWritable } from './mutations.mjs';
import { digest } from './journal.mjs';
import { frameAtPoint, pageFrame, mapPageBounds } from './page-frame.mjs';
import { nearBounds, waitForMappedRegion } from './visual.mjs';

export function matchingShapeBounds(a, b) {
  // Native handle padding may differ by two pixels on EACH edge after reload.
  // Comparing width alone counts both edges and incorrectly rejects a 4px sum.
  return [
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - b.x - b.width),
    Math.abs(a.y + a.height - b.y - b.height),
  ].every((d) => d <= 3);
}

export function normalizeShapeStyle(style) {
  if (!style || !Object.keys(style).length)
    throw new GoodnotesError('EMPTY_STYLE', 'Provide a fill opacity or stroke thickness.');
  const result = {};
  for (const [key, value] of Object.entries(style)) {
    if (
      key === 'fillOpacityPercent' &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 100 &&
      value % 10 === 0
    )
      result[key] = value;
    else if (
      key === 'thicknessMm' &&
      Number.isFinite(value) &&
      value >= 0.1 &&
      value <= 2 &&
      Math.abs(value * 100 - Math.round(value * 100)) < 1e-8
    )
      result[key] = value;
    else
      throw new GoodnotesError(
        'INVALID_STYLE',
        'Fill opacity supports 0 to 100 in steps of 10; thickness supports 0.10 to 2.00 mm in 0.01 mm steps.',
      );
  }
  return result;
}

// Slider inputs are bounded adjustments inside one journaled mutation. Reading
// their displayed values is essential: native slider geometry is not a value API.
export async function setMeasuredSlider(page, slider, value, wanted, mark, options = {}) {
  const samples = [];
  let low = 0,
    high = 1;
  for (let i = 0; i < 16; i++) {
    checkCancellation(options.signal);
    await page.waitForTimeout(250);
    const b = await slider.boundingBox();
    if (!b || b.width < 50 || b.height < 1)
      throw new GoodnotesError('SLIDER_UNAVAILABLE', 'The native slider has no usable track.');
    const at = (low + high) / 2;
    const point = { x: b.x + 1 + at * (b.width - 2), y: b.y + b.height / 2 };
    const reachable = await slider.evaluate((element, p) => {
      const hit = document.elementFromPoint(p.x, p.y);
      // The native opacity thumb is a sibling of its track in this container.
      const scope =
        element.id === 'shapeOpacitySliderBar'
          ? element.closest('#toolOpacitySlider') || element
          : element;
      return hit === scope || scope.contains(hit);
    }, point);
    if (!reachable)
      throw new GoodnotesError(
        'SLIDER_OBSCURED',
        'The measured slider point is clipped or covered. No click was sent at that point.',
      );
    mark();
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(90);
    const observed = await value();
    samples.push({ fraction: at, value: observed });
    if (Math.abs(observed - wanted) < 0.005) return;
    if (observed < wanted) low = at;
    else high = at;
  }
  throw new GoodnotesError(
    'STYLE_STEP_UNSUPPORTED',
    'The native slider could not reach the exact requested value. Read the actual state before deciding any further action.',
    { requested: wanted, lastSamples: samples.slice(-6) },
  );
}

export class ShapeStyleController {
  constructor(a) {
    this.a = a;
    this.preparations = new Map();
  }
  async requireShape(page) {
    if (
      !(await page
        .locator('#shared_menu_options_edit_shape')
        .isVisible()
        .catch(() => false))
    )
      throw new GoodnotesError(
        'NOT_A_NATIVE_SHAPE',
        'Select one editable native shape, not ink or a group.',
      );
  }
  async close(page) {
    const menu = page.locator('#objectFloatingMenu');
    if (await menu.isVisible().catch(() => false)) await this.a.text.closeMenu(page, menu);
  }
  async thickness(page) {
    const label = page.locator('#objectFloatingMenu').getByText(/^\d+(?:\.\d+)? mm$/);
    if ((await label.count()) !== 1)
      throw new GoodnotesError(
        'STYLE_STATE_UNAVAILABLE',
        'Cannot read one native stroke thickness.',
      );
    return parseFloat(await label.innerText());
  }
  async opacity(page) {
    const raw = await page.locator('#colorPickerOpacityValue').innerText();
    if (!/^\d{1,3}%$/.test(raw.trim()) || parseInt(raw) > 100)
      throw new GoodnotesError('STYLE_STATE_UNAVAILABLE', 'Cannot read the native fill opacity.');
    return parseInt(raw);
  }
  async read(page) {
    await this.requireShape(page);
    try {
      await this.close(page);
      await page.locator('#shared_menu_options_change_color').click();
      const toggle = page.locator('#fillsColorOptionsItem');
      await toggle.waitFor({ state: 'visible' });
      const checked = await toggle.getAttribute('aria-checked');
      if (!['true', 'false'].includes(checked))
        throw new GoodnotesError(
          'STYLE_STATE_UNAVAILABLE',
          'Cannot read the native shape fill switch.',
        );
      const fillEnabled = checked === 'true',
        fillOpacityPercent = await this.opacity(page);
      await this.close(page);
      await page.locator('#shared_menu_options_stroke').click();
      const thicknessMm = await this.thickness(page);
      return { fillEnabled, fillOpacityPercent, thicknessMm };
    } finally {
      await this.close(page);
    }
  }
  async prepare({ selectionId }) {
    const { s, view, page } = await this.a.styles.selection(selectionId);
    if (s.region)
      throw new GoodnotesError('NOT_A_NATIVE_SHAPE', 'Use a point selection of one native shape.');
    const state = await this.read(page),
      styleId = crypto.randomUUID();
    this.preparations.clear();
    this.preparations.set(styleId, { selectionId, state, created: Date.now() });
    return {
      styleId,
      selectionId,
      viewId: view.viewId,
      state,
      expiresInSeconds: 600,
      note: 'Fill uses the existing shape color. Zero disables fill; positive values enable it. Stroke pattern and shape geometry are preserved.',
    };
  }
  async apply({ styleId, style, operationId }, options) {
    const patch = normalizeShapeStyle(style),
      record = this.preparations.get(styleId);
    if (!record || Date.now() - record.created > 600000)
      throw new GoodnotesError('STALE_STYLE', 'Read this selected shape style again.');
    const a = this.a,
      { s, view } = await a.styles.selection(record.selectionId);
    requireWritable(a, view);
    return mutate(
      a,
      operationId,
      {
        action: 'shape-style',
        url: view.url,
        page: view.pageUrl,
        bounds: s.bounds,
        hash: s.hash,
        previous: record.state,
        style: patch,
      },
      async (mark) => {
        const { page, fresh } = await a.styles.selection(record.selectionId);
        try {
          const current = await this.read(page);
          if (digest(current) !== digest(record.state))
            throw new GoodnotesError(
              'STYLE_CONFLICT',
              'The native shape style changed since preparation.',
            );
          const expected = {
            ...current,
            ...patch,
            ...(patch.fillOpacityPercent === undefined
              ? {}
              : { fillEnabled: patch.fillOpacityPercent > 0 }),
          };
          if (digest(expected) === digest(current))
            return { verified: true, changed: false, state: current };
          const frame = await frameAtPoint(page, {
            x: s.bounds.x + s.bounds.width / 2,
            y: s.bounds.y + s.bounds.height / 2,
          });
          if (
            patch.fillOpacityPercent !== undefined &&
            (expected.fillEnabled !== current.fillEnabled ||
              expected.fillOpacityPercent !== current.fillOpacityPercent)
          ) {
            await page.locator('#shared_menu_options_change_color').click();
            const toggle = page.locator('#fillsColorOptionsItem');
            if (current.fillEnabled !== expected.fillEnabled) {
              mark();
              await toggle.click();
              // This switch can rerender a clipped palette whose slider still
              // reports off-panel geometry. Close/reopen the UI before measuring.
              await this.close(page);
              await page.locator('#shared_menu_options_change_color').click();
            }
            // Applying fill can close the entire native palette. Reopen only the
            // UI to read its new value; never repeat the switch input.
            if (
              !(await page
                .locator('#colorPickerOpacityValue')
                .isVisible()
                .catch(() => false))
            )
              await page.locator('#shared_menu_options_change_color').click();
            if ((await this.opacity(page)) !== expected.fillOpacityPercent)
              await setMeasuredSlider(
                page,
                page.locator('#shapeOpacitySliderBar'),
                () => this.opacity(page),
                expected.fillOpacityPercent,
                mark,
                options,
              );
            await this.close(page);
          }
          if (patch.thicknessMm !== undefined && patch.thicknessMm !== current.thicknessMm) {
            await page.locator('#shared_menu_options_stroke').click();
            await setMeasuredSlider(
              page,
              page.getByTestId('toolThicknessSlider'),
              () => this.thickness(page),
              patch.thicknessMm,
              mark,
              options,
            );
            await this.close(page);
          }
          const actual = await this.read(page);
          if (digest(actual) !== digest(expected))
            throw new GoodnotesError(
              'STYLE_NOT_APPLIED',
              'Native shape settings do not match the requested values.',
              { expected, actual },
            );
          const edited = await a.objects.snapshot(page, view);
          if (!nearBounds(s.bounds, edited.bounds, 12))
            throw new GoodnotesError(
              'SHAPE_GEOMETRY_CHANGED',
              'The shape geometry changed unexpectedly.',
            );
          // The style editor uses smaller round handles than a fresh lasso
          // selection. Normalize selection mode before recording its bounds.
          await a.objects.readingMode(page);
          const selected = await a.objects.reselectBounds(page, view, edited.bounds);
          if (!nearBounds(s.bounds, selected.bounds, 12))
            throw new GoodnotesError(
              'SHAPE_GEOMETRY_CHANGED',
              'The committed shape geometry changed unexpectedly.',
            );
          const writtenFrame = await pageFrame(page, frame.pageId);
          await a.objects.readingMode(page);
          const baseline = await page.screenshot();
          // Keep the exact written rendering even when a later reload check fails.
          const writtenEvidence = await a.objects.evidence(
            operationId + '-written',
            fresh.bytes,
            baseline,
          );
          await page.waitForTimeout(1200);
          checkCancellation(options?.signal);
          await page.reload({ waitUntil: 'domcontentloaded' });
          const reopened = await a.inspect({ url: view.pageUrl });
          if (reopened.url !== view.url || reopened.title !== view.title)
            throw new GoodnotesError('DOCUMENT_CHANGED', 'The styled document identity changed.');
          requireWritable(a, reopened);
          const mapped = mapPageBounds(
            selected.bounds,
            writtenFrame,
            await pageFrame(page, frame.pageId),
          );
          a.objects.validateBounds(mapped, reopened);
          await a.objects.readingMode(page);
          const verification = await waitForMappedRegion(
            page,
            baseline,
            selected.bounds,
            mapped,
            options,
          );
          if (!verification.comparison.matches)
            throw new GoodnotesError('SAVE_UNVERIFIED', 'Shape appearance differs after reload.', {
              appearance: verification.comparison,
            });
          const savedView = a.getView(reopened.viewId);
          const saved = await a.objects.reselectBounds(page, savedView, mapped);
          if (!matchingShapeBounds(mapped, saved.bounds))
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'The saved shape geometry differs after reload.',
              { expectedBounds: mapped, actualBounds: saved.bounds, writtenEvidence },
            );
          const state = await this.read(page);
          if (digest(state) !== digest(expected))
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'Native shape settings differ after reload.',
              { expected, actual: state },
            );
          const final = await a.objects.snapshot(page, savedView),
            selectionId = crypto.randomUUID();
          a.objects.selections.clear();
          a.objects.selections.set(selectionId, {
            ...final,
            viewId: reopened.viewId,
            kind: 'object-or-group',
            created: Date.now(),
          });
          this.preparations.clear();
          await a.documents.invalidate(view.url);
          return {
            verified: true,
            changed: true,
            verification: 'native-shape-style-and-appearance-after-reload',
            state,
            viewId: reopened.viewId,
            selectionId,
            bounds: final.bounds,
            appearance: verification.comparison,
            evidence: await a.objects.evidence(operationId, fresh.bytes, verification.bytes),
          };
        } finally {
          await this.close(page).catch(() => {});
        }
      },
      options,
    );
  }
}
