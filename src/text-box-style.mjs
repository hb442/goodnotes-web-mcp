import crypto from 'node:crypto';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { mutate, requireWritable } from './mutations.mjs';
import { digest } from './journal.mjs';
import { readRichText } from './text.mjs';
import { readPlainText } from './rich-text.mjs';
import { frameAtPoint, pageFrame, mapPageBounds } from './page-frame.mjs';
import { compareMappedRegions, nearBounds } from './visual.mjs';
import { captureBoardViewport, restoreBoardViewport } from './viewport.mjs';

const panelId = '#object_text_box_style_floating_menu';
const numeric = { roundCornerPt: 'Round Corner', borderPt: 'Border', paddingPt: 'Padding' };
const colors = { backgroundColor: 'Background Color', borderColor: 'Border Color' };
export function normalizeBoxStyle(patch) {
  const result = {};
  if (!patch || !Object.keys(patch).length)
    throw new GoodnotesError('EMPTY_STYLE', 'Provide at least one text-box style property.');
  for (const [key, value] of Object.entries(patch)) {
    if (Object.hasOwn(colors, key)) {
      if (typeof value !== 'string' || !/^(none|#[a-f0-9]{6})$/i.test(value))
        throw new GoodnotesError('INVALID_STYLE', 'Colors must be none or six-digit hexadecimal.');
      result[key] = value.toLowerCase();
    } else if (Object.hasOwn(numeric, key)) {
      if (!Number.isInteger(value) || value < 0 || value > (key === 'borderPt' ? 12 : 30))
        throw new GoodnotesError(
          'INVALID_STYLE',
          'Use integer point sizes from zero to 30; border maximum is 12.',
        );
      result[key] = value;
    } else if (key === 'shadow' && typeof value === 'boolean') result[key] = value;
    else throw new GoodnotesError('INVALID_STYLE', 'Unknown text-box style property or value.');
  }
  return result;
}
export async function selectedText(page, bounds) {
  const matches = await page.locator('.ql-editor').evaluateAll(
    (es, b) =>
      es
        .map((e, index) => {
          const r = e.getBoundingClientRect();
          return {
            index,
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            visible: getComputedStyle(e).visibility !== 'hidden',
          };
        })
        .filter(
          (r) =>
            r.visible &&
            r.width > 0 &&
            r.height > 0 &&
            r.x >= b.x - 3 &&
            r.y >= b.y - 3 &&
            r.x + r.width <= b.x + b.width + 3 &&
            r.y + r.height <= b.y + b.height + 3,
        ),
    bounds,
  );
  if (matches.length !== 1)
    throw new GoodnotesError('TEXT_BOX_UNAVAILABLE', 'Select exactly one visible native text box.');
  const editor = page.locator('.ql-editor').nth(matches[0].index),
    text = await editor.evaluate(readPlainText),
    runs = await editor.evaluate(readRichText);
  const anchor = await editor.evaluate((el) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode()))
      if (n.textContent.trim()) {
        const r = document.createRange();
        r.selectNodeContents(n);
        const b = [...r.getClientRects()].find((b) => b.width && b.height);
        if (b)
          return { x: b.x + Math.min(6, b.width / 2), y: b.y + b.height / 2, width: 1, height: 1 };
      }
    return null;
  });
  if (!anchor || !text.trim())
    throw new GoodnotesError(
      'EMPTY_TEXT_BOX',
      'Style changes require an existing nonempty text box.',
    );
  return { text, runs, anchor };
}
export class TextBoxStyleController {
  constructor(a) {
    this.a = a;
    this.preparations = new Map();
  }
  async open(page) {
    const panel = page.locator(panelId);
    if (!(await panel.isVisible().catch(() => false))) {
      const b = page.locator('#shared_menu_text_box_style');
      if (
        await b.waitFor({ state: 'visible', timeout: 2000 }).then(
          () => true,
          () => false,
        )
      )
        await b.click();
      else {
        const context = page.locator('#object_menu_context_menu_option');
        if (!(await context.isVisible().catch(() => false)))
          throw new GoodnotesError(
            'TEXT_BOX_STYLE_UNAVAILABLE',
            'This selection has no native Text Box Style control.',
          );
        await context.click();
        const option = page.locator('#object_menu_context_shared_menu_text_box_style');
        if (
          !(await option.waitFor({ state: 'visible', timeout: 1000 }).then(
            () => true,
            () => false,
          ))
        ) {
          const format = page.locator('#object_context_menu').getByText('Format', { exact: true });
          if (await format.isVisible().catch(() => false)) await format.click();
        }
        if (
          !(await option.waitFor({ state: 'visible', timeout: 3000 }).then(
            () => true,
            () => false,
          ))
        )
          throw new GoodnotesError(
            'TEXT_BOX_STYLE_UNAVAILABLE',
            'Cannot identify one native Text Box Style menu entry.',
          );
        await option.click();
      }
    }
    await panel.waitFor({ state: 'visible' });
    await panel.getByRole('button', { name: 'Advanced', exact: true }).click();
    return panel;
  }
  async close(page) {
    const floating = page.locator('#objectFloatingMenu');
    if (await floating.isVisible().catch(() => false)) await this.a.text.closeMenu(page, floating);
  }
  async read(page) {
    const p = await this.open(page),
      state = {};
    for (const [key, label] of Object.entries(numeric)) {
      const raw = await p.getByText(new RegExp('^\\d+(?:\\.\\d+)? pt ' + label + '$')).innerText();
      state[key] = Number(raw.split(' ')[0]);
    }
    const checked = await p.locator('#object_text_box_style_shadow').getAttribute('aria-checked');
    if (!['true', 'false'].includes(checked))
      throw new GoodnotesError('STYLE_STATE_UNAVAILABLE', 'Cannot read the native shadow state.');
    state.shadow = checked === 'true';
    for (const [key, label] of Object.entries(colors)) {
      const button = p
        .getByText(label, { exact: true })
        .locator('..')
        .getByRole('button')
        .filter({ hasText: '›' });
      if (/\bNone\b/.test(await button.innerText())) {
        state[key] = 'none';
        continue;
      }
      await button.click();
      const picker = page.locator('#objectFloatingMenu');
      state[key] = (await picker.getByTestId('colorPickerInput').inputValue()).toLowerCase();
      if (!/^#[a-f0-9]{6}$/.test(state[key]))
        throw new GoodnotesError('STYLE_STATE_UNAVAILABLE', 'Cannot read the native color value.');
      await picker.getByRole('button', { name: 'Back', exact: true }).click();
      await p.waitFor({ state: 'visible' });
    }
    return state;
  }
  async prepare({ selectionId }, options = {}) {
    checkCancellation(options.signal);
    const { s, view, page } = await this.a.styles.selection(selectionId);
    if (s.kind !== 'text-box')
      throw new GoodnotesError('NOT_A_TEXT_BOX', 'Select one native text box.');
    const content = await selectedText(page, s.bounds);
    const board = await captureBoardViewport(page);
    const attempts = board ? 2 : 4;
    let state;
    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        checkCancellation(options.signal);
        try {
          state = await this.read(page);
          break;
        } catch (error) {
          if (error.code !== 'TEXT_BOX_STYLE_UNAVAILABLE') throw error;
          if (attempt === attempts - 1) {
            if (!board) throw error;
            return {
              supported: false,
              changed: false,
              selectionId,
              viewId: view.viewId,
              text: content.text,
              reason:
                'The current native whiteboard text-box menu does not expose background/border styling.',
              alternatives: [
                'Text font/color formatting',
                'A separate native shape behind the text',
              ],
            };
          }
          // A rendered text box can expose only a reduced native toolbar.
          // Reopen the same guarded selection; no style value is sent here.
          await this.close(page).catch(() => {});
          await this.a.objects.readingMode(page);
          // Native handles change from dots to bars after a reload. Compare
          // unselected content on both sides, never the transient selection UI.
          const beforeRecovery = await page.screenshot({ animations: 'disabled' });
          if (board) {
            // A reduced native toolbar can persist for a whole load. Recover
            // once inside the read operation, without changing any style value.
            await page.reload({ waitUntil: 'domcontentloaded' });
            await this.a.openDocument(view.pageUrl);
            await this.a.closePanels(page);
            await restoreBoardViewport(this.a, page, view, board, options);
            await this.a.assertView(view);
          } else await page.waitForTimeout(1200);
          await this.a.objects.readingMode(page);
          const afterRecovery = await page.screenshot({ animations: 'disabled' });
          const again = await this.a.objects.select({
            viewId: view.viewId,
            x: (content.anchor.x - view.canvas.x) / view.canvas.width,
            y: (content.anchor.y - view.canvas.y) / view.canvas.height,
          });
          await this.a.styles.selection(again.selectionId);
          const read = await selectedText(page, again.bounds);
          const appearance = await compareMappedRegions(
            beforeRecovery,
            s.bounds,
            afterRecovery,
            again.bounds,
          );
          if (
            !nearBounds(s.bounds, again.bounds, 1) ||
            !appearance.matches ||
            read.text !== content.text ||
            digest(read.runs) !== digest(content.runs)
          )
            throw new GoodnotesError(
              'SELECTION_CHANGED',
              'Text-box content or selection changed while its native style control was loading.',
              {
                appearance,
                beforeBounds: s.bounds,
                afterBounds: again.bounds,
                exactText: read.text === content.text,
                exactFormat: digest(read.runs) === digest(content.runs),
              },
            );
          selectionId = again.selectionId;
        }
      }
    } finally {
      await this.close(page);
    }
    // Menu focus can redraw the selection frame. Refresh only after proving
    // identical geometry, exact text and character formatting; never weaken it.
    const selection = this.a.objects.selections?.get(selectionId);
    if (selection) {
      const fresh = await this.a.objects.snapshot(page, view);
      const after = await selectedText(page, fresh.bounds);
      if (
        !nearBounds(fresh.bounds, s.bounds, 1) ||
        after.text !== content.text ||
        digest(after.runs) !== digest(content.runs)
      )
        throw new GoodnotesError(
          'SELECTION_CHANGED',
          'Text-box content or geometry changed while reading its style.',
        );
      this.a.objects.selections.set(selectionId, { ...selection, ...fresh, created: Date.now() });
    }
    const styleId = crypto.randomUUID();
    this.preparations.clear();
    this.preparations.set(styleId, { selectionId, content, state, created: Date.now() });
    return {
      supported: true,
      styleId,
      selectionId,
      viewId: view.viewId,
      text: content.text,
      state,
      expiresInSeconds: 600,
    };
  }
  async writeNative(page, patch, current, mark, options = {}) {
    const expected = { ...current, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      checkCancellation(options?.signal);
      if (value === current[key]) continue;
      const p = await this.open(page);
      if (Object.hasOwn(colors, key)) {
        await p
          .getByText(colors[key], { exact: true })
          .locator('..')
          .getByRole('button')
          .filter({ hasText: '›' })
          .click();
        const picker = page.locator('#objectFloatingMenu');
        mark();
        if (value === 'none')
          await picker.getByRole('button', { name: 'Delete', exact: true }).click();
        else {
          const input = picker.getByTestId('colorPickerInput');
          await input.fill(value);
          await input.press('Enter');
        }
        if (
          await picker
            .getByRole('button', { name: 'Back', exact: true })
            .isVisible()
            .catch(() => false)
        )
          await picker.getByRole('button', { name: 'Back', exact: true }).click();
      } else if (key === 'shadow') {
        mark();
        await p.locator('#object_text_box_style_shadow').click();
      } else {
        let previous = current[key];
        for (let i = 0; previous !== value && i < 60; i++) {
          checkCancellation(options?.signal);
          const label = p.getByText(new RegExp('^\\d+(?:\\.\\d+)? pt ' + numeric[key] + '$')),
            buttons = label.locator('..').getByRole('button'),
            direction = value > previous ? 1 : -1,
            button = buttons.nth(direction > 0 ? 1 : 0);
          if ((await buttons.count()) !== 2 || (await button.isDisabled()))
            throw new GoodnotesError(
              'STYLE_RANGE_UNAVAILABLE',
              'The requested point size is outside the current native control range.',
            );
          mark();
          await button.click();
          await page.waitForTimeout(60);
          const next = Number((await label.innerText()).split(' ')[0]);
          if ((next - previous) * direction <= 0 || (value - next) * direction < 0)
            throw new GoodnotesError(
              'STYLE_STEP_UNSUPPORTED',
              'The native step size cannot reach the requested value.',
            );
          previous = next;
        }
        if (previous !== value)
          throw new GoodnotesError(
            'STYLE_RANGE_UNAVAILABLE',
            'The requested point size exceeded the bounded native adjustment.',
          );
      }
    }
    const applied = await this.read(page);
    if (digest(applied) !== digest(expected))
      throw new GoodnotesError(
        'STYLE_NOT_APPLIED',
        'Native text-box style does not match the requested values.',
        { expected, actual: applied },
      );
    return applied;
  }
  async apply({ styleId, style, operationId }, options) {
    const patch = normalizeBoxStyle(style),
      record = this.preparations.get(styleId);
    if (!record || Date.now() - record.created > 600000)
      throw new GoodnotesError('STALE_STYLE', 'Read the selected text-box style again.');
    const a = this.a,
      { s, view } = await a.styles.selection(record.selectionId);
    requireWritable(a, view);
    return mutate(
      a,
      operationId,
      {
        action: 'text-box-style',
        url: view.url,
        page: view.pageUrl,
        bounds: s.bounds,
        hash: s.hash,
        contentHash: digest(record.content.text),
        runsHash: digest(record.content.runs),
        previous: record.state,
        style: patch,
      },
      async (mark) => {
        const { page, fresh } = await a.styles.selection(record.selectionId),
          content = await selectedText(page, s.bounds),
          frame = await frameAtPoint(page, content.anchor);
        const checkpoint = await captureBoardViewport(page);
        if (
          content.text !== record.content.text ||
          digest(content.runs) !== digest(record.content.runs)
        )
          throw new GoodnotesError(
            'TEXT_CONFLICT',
            'Text or character formatting changed since preparation.',
          );
        try {
          const current = await this.read(page);
          if (digest(current) !== digest(record.state))
            throw new GoodnotesError(
              'STYLE_CONFLICT',
              'Text-box appearance changed since preparation.',
            );
          const expected = { ...current, ...patch };
          if (digest(expected) === digest(current))
            return { verified: true, changed: false, state: current };
          await this.writeNative(page, patch, current, mark, options);
          await this.close(page);
          const selected = await a.objects.snapshot(page, view),
            afterText = await selectedText(page, selected.bounds);
          if (afterText.text !== content.text || digest(afterText.runs) !== digest(content.runs))
            throw new GoodnotesError(
              'TEXT_CHANGED',
              'Changing box appearance also changed text or character formatting.',
            );
          const writtenFrame = await pageFrame(page, frame.pageId);
          await a.objects.readingMode(page);
          const baseline = await page.screenshot();
          await page.waitForTimeout(1200);
          let reopened, after, appearance, savedSelection, savedState;
          for (let attempt = 0; attempt < 2; attempt++) {
            checkCancellation(options?.signal);
            await page.reload({ waitUntil: 'domcontentloaded' });
            reopened = await a.inspect({ url: view.pageUrl });
            if (checkpoint) {
              await restoreBoardViewport(a, page, view, checkpoint, options);
              reopened = await a.inspect({ url: view.pageUrl });
            }
            if (reopened.url !== view.url || reopened.title !== view.title)
              throw new GoodnotesError('DOCUMENT_CHANGED', 'The styled document identity changed.');
            requireWritable(a, reopened);
            const savedFrame = await pageFrame(page, frame.pageId),
              mapped = mapPageBounds(selected.bounds, writtenFrame, savedFrame),
              point = mapPageBounds(afterText.anchor, writtenFrame, savedFrame);
            a.objects.validateBounds(mapped, reopened);
            await a.objects.readingMode(page);
            after = await page.screenshot();
            appearance = await compareMappedRegions(baseline, selected.bounds, after, mapped);
            if (!appearance.matches)
              throw new GoodnotesError(
                'SAVE_UNVERIFIED',
                'Text-box appearance differed after reload.',
                { appearance },
              );
            savedSelection = await a.objects.select({
              viewId: reopened.viewId,
              x: (point.x - reopened.canvas.x) / reopened.canvas.width,
              y: (point.y - reopened.canvas.y) / reopened.canvas.height,
            });
            const savedContent = await selectedText(page, savedSelection.bounds);
            if (
              savedContent.text !== content.text ||
              digest(savedContent.runs) !== digest(content.runs)
            )
              throw new GoodnotesError(
                'SAVE_UNVERIFIED',
                'Text or character formatting differed after reload.',
              );
            try {
              savedState = await this.read(page);
              break;
            } catch (error) {
              if (error.code !== 'TEXT_BOX_STYLE_UNAVAILABLE' || attempt === 1) throw error;
              // A reduced toolbar sometimes remains for this entire page load.
              // Reload once more and repeat every identity/content/appearance
              // check. No style input is replayed by this read-only recovery.
              await this.close(page).catch(() => {});
              await a.objects.readingMode(page);
              await page.waitForTimeout(1000);
            }
          }
          if (digest(savedState) !== digest(expected))
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'The native box style differed after reload.',
              { expected, actual: savedState },
            );
          await this.close(page);
          this.preparations.clear();
          await a.documents.invalidate(view.url);
          return {
            verified: true,
            changed: true,
            verification: 'native-box-style-text-format-and-appearance-after-reload',
            viewId: reopened.viewId,
            selectionId: savedSelection.selectionId,
            state: savedState,
            appearance,
            evidence: await a.objects.evidence(operationId, fresh.bytes, after),
          };
        } finally {
          await this.close(page).catch(() => {});
        }
      },
      options,
    );
  }
}
