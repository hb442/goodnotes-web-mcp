import { GoodnotesError, checkCancellation } from './errors.mjs';
import { dismissFloatingMenu } from './ui-menu.mjs';
import { normalizeTextFormat, prepareFormatRanges } from './text-format-plan.mjs';
import { digest } from './journal.mjs';
import { mutate, requireWritable } from './mutations.mjs';
import { readPlainText } from './rich-text.mjs';
import { frameAtPoint, pageFrame, mapPageBounds } from './page-frame.mjs';
import { captureBoardViewport, restoreBoardViewport } from './viewport.mjs';

export function readRichText(element) {
  const runs = [];
  let offset = 0;
  const blocks = Array.from(element.children).flatMap((e) =>
    ['OL', 'UL'].includes(e.tagName) ? Array.from(e.children) : [e],
  );
  for (const [i, block] of blocks.entries()) {
    if (i) offset++;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.replace(/\uFEFF/g, '');
      if (!text) continue;
      const style = getComputedStyle(node.parentElement);
      let highlight;
      for (
        let ancestor = node.parentElement;
        ancestor && ancestor !== element;
        ancestor = ancestor.parentElement
      ) {
        const nativeHighlight = ancestor.getAttribute('data-highlight');
        if (nativeHighlight && /^#[a-f0-9]{8}$/i.test(nativeHighlight)) {
          if (!nativeHighlight.toLowerCase().endsWith('00'))
            highlight = nativeHighlight.toLowerCase();
          break;
        }
        const background = getComputedStyle(ancestor).backgroundColor;
        if (background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)') {
          highlight = background;
          break;
        }
      }
      const run = {
        start: offset,
        end: offset + text.length,
        text,
        bold: Number(style.fontWeight) >= 600 || style.fontWeight === 'bold',
        italic: style.fontStyle === 'italic',
        underline:
          !!node.parentElement.closest('u') || style.textDecorationLine.includes('underline'),
        strike:
          !!node.parentElement.closest('s') || style.textDecorationLine.includes('line-through'),
        fontSize: parseFloat(style.fontSize),
        color: style.color,
        align: getComputedStyle(block).textAlign,
        link: node.parentElement.closest('a')?.getAttribute('href') || null,
        ...(highlight ? { highlight } : {}),
        ...(block.tagName === 'LI'
          ? {
              list:
                block.getAttribute('data-list-style') ||
                block.getAttribute('data-list') ||
                (block.parentElement.tagName === 'UL' ? 'bullet' : 'ordered'),
            }
          : {}),
      };
      const previous = runs.at(-1);
      if (
        previous?.end === run.start &&
        [
          'bold',
          'italic',
          'underline',
          'strike',
          'fontSize',
          'color',
          'align',
          'link',
          'list',
          'highlight',
        ].every((key) => previous[key] === run[key])
      ) {
        previous.end = run.end;
        previous.text += run.text;
      } else runs.push(run);
      offset += text.length;
    }
  }
  return runs;
}
export async function selectRange(editor, start, end) {
  const selected = await editor.evaluate(
    (el, { start, end }) => {
      const positions = [];
      let offset = 0;
      const blocks = Array.from(el.children).flatMap((e) =>
        ['OL', 'UL'].includes(e.tagName) ? Array.from(e.children) : [e],
      );
      for (const [i, block] of blocks.entries()) {
        if (i) offset++;
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let node,
          found = false;
        while ((node = walker.nextNode())) {
          const length = node.textContent.replace(/\uFEFF/g, '').length;
          if (!length) continue;
          positions.push({ node, start: offset, end: offset + length });
          offset += length;
          found = true;
        }
        if (!found) positions.push({ node: block, start: offset, end: offset });
      }
      const locate = (value) => {
        const p = positions.find((p) => value >= p.start && value <= p.end);
        if (!p) throw new Error('Unsupported text structure or range.');
        if (p.node.nodeType !== Node.TEXT_NODE) return [p.node, 0];
        let logical = 0,
          raw = 0;
        while (raw < p.node.textContent.length && logical < value - p.start) {
          if (p.node.textContent[raw] !== '\uFEFF') logical++;
          raw++;
        }
        return [p.node, raw];
      };
      const range = document.createRange();
      range.setStart(...locate(start));
      range.setEnd(...locate(end));
      el.focus();
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    },
    { start, end },
  );
  await editor.page().waitForTimeout(80);
  return selected;
}
export class TextController {
  constructor(adapter) {
    this.a = adapter;
  }
  async closeMenu(page, locator) {
    await dismissFloatingMenu(page, locator);
  }
  async create({ viewId, x, y, text, operationId }, options) {
    const a = this.a,
      view = a.getView(viewId);
    requireWritable(a, view);
    const expected = text.replace(/\r\n?/g, '\n');
    if (!expected.trim() || expected.length > 8000)
      throw new GoodnotesError('INVALID_TEXT', 'Provide 1–8000 characters.');
    return mutate(
      a,
      operationId,
      {
        action: 'create-text',
        url: view.url,
        page: view.pageUrl,
        x,
        y,
        textHash: digest(expected),
      },
      async (mark) => {
        const page = await a.assertView(view),
          editor = await a.selectEditor(page, view, x, y);
        const checkpoint = await captureBoardViewport(page);
        const initialBounds = await editor.boundingBox(),
          initialFrame = await frameAtPoint(page, {
            x: initialBounds.x + 2,
            y: initialBounds.y + 2,
          });
        await pageFrame(page, initialFrame.pageId);
        const current = await editor.evaluate((el) => el.textContent.replace(/\uFEFF/g, '').trim());
        if (current) {
          await a.leaveEditor(page, editor);
          throw new GoodnotesError(
            'OCCUPIED_POSITION',
            'Existing text occupies this point. Read/edit it explicitly or choose empty space.',
          );
        }
        try {
          mark();
          await editor.focus();
          const lines = expected.split('\n');
          for (let i = 0; i < lines.length; i++) {
            checkCancellation(options?.signal);
            if (i) await editor.press('Enter');
            await page.keyboard.insertText(lines[i]);
          }
          await a.resetOuterScroll(page);
          if ((await editor.evaluate(readPlainText)) !== expected)
            throw new GoodnotesError(
              'INPUT_MISMATCH',
              'The native text editor did not contain the complete requested text.',
            );
          const writtenFrame = await pageFrame(page, initialFrame.pageId);
          const anchor = await editor.evaluate((el) => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode()))
              if (node.textContent.replace(/\uFEFF/g, '').trim()) {
                const range = document.createRange();
                range.selectNodeContents(node);
                const b = [...range.getClientRects()].find((r) => r.width > 0 && r.height > 0);
                if (b)
                  return {
                    x: b.x + Math.min(8, b.width / 2),
                    y: b.y + b.height / 2,
                    width: 1,
                    height: 1,
                  };
              }
            return null;
          });
          if (!anchor)
            throw new GoodnotesError(
              'TEXT_POSITION_UNAVAILABLE',
              'Cannot locate the typed characters on their native page.',
            );
          await a.leaveEditor(page, editor);
          await page.waitForTimeout(1200);
          await page.reload({ waitUntil: 'domcontentloaded' });
          await a.openDocument(view.pageUrl);
          await a.closePanels(page);
          await restoreBoardViewport(a, page, view, checkpoint, options);
          let refreshed, currentFrame, mapped, saved;
          for (let attempt = 0; attempt < 4; attempt++) {
            checkCancellation(options?.signal);
            refreshed = await a.inspect({ url: view.pageUrl });
            if (refreshed.url !== view.url || refreshed.title !== view.title)
              throw new GoodnotesError(
                'DOCUMENT_CHANGED',
                'The document identity changed after text creation.',
              );
            requireWritable(a, refreshed);
            currentFrame = await pageFrame(page, initialFrame.pageId);
            mapped = mapPageBounds(anchor, writtenFrame, currentFrame);
            saved = await a.readText({
              viewId: refreshed.viewId,
              x: (mapped.x - refreshed.canvas.x) / refreshed.canvas.width,
              y: (mapped.y - refreshed.canvas.y) / refreshed.canvas.height,
            });
            if (saved.text !== '' || attempt === 3) break;
            // Goodnotes can mount a blank page before its existing text arrives.
            // Re-read only; never send the creation keystrokes a second time.
            await page.waitForTimeout(1500);
          }
          if (saved.text !== expected)
            throw new GoodnotesError('SAVE_UNVERIFIED', 'Created text differed after reload.', {
              expectedCharacters: expected.length,
              actualCharacters: saved.text.length,
              anchor,
              writtenFrame,
              currentFrame,
              mapped,
            });
          await a.documents.invalidate(view.url);
          return {
            verified: true,
            verification: 'new-text-at-native-page-position-after-reload',
            viewId: refreshed.viewId,
            targetId: saved.targetId,
            textHash: digest(expected),
            characters: expected.length,
          };
        } finally {
          if (await editor.isVisible().catch(() => false))
            await a.leaveEditor(page, editor).catch(() => {});
        }
      },
      options,
    );
  }
  async applyFormat(page, editor, { start, end: formatEnd, format }, mark, { signal } = {}) {
    const a = this.a;
    checkCancellation(signal);
    if (start === formatEnd)
      throw new GoodnotesError(
        'EMPTY_FORMAT_RANGE',
        'Formatting requires at least one selected character.',
      );
    await selectRange(editor, start, formatEnd);
    if (format.color !== undefined) {
      const hex =
        '#' +
        format.color
          .match(/\d+/g)
          .map((n) => Number(n).toString(16).padStart(2, '0'))
          .join('');
      const palette = await a.styles.openPalette(page);
      await a.styles.chooseColor(page, palette, hex, mark);
      await a.styles.closePalette(page);
      await selectRange(editor, start, formatEnd);
    }
    for (const [key, toggle] of [
      ['bold', 'bold'],
      ['italic', 'Italic'],
      ['underline', 'underline'],
      ['strike', 'strike'],
    ]) {
      if (format[key] === undefined) continue;
      const runs = (await editor.evaluate(readRichText)).filter(
        (r) => r.end > start && r.start < formatEnd,
      );
      if (runs.every((r) => r[key] === format[key])) continue;
      const button = page.locator('#shared_menu_floating_toggle_' + toggle);
      if (!(await button.isVisible().catch(() => false)))
        await page.locator('#textToolbarTextStyles').click();
      mark();
      await button.click();
      let changed = (await editor.evaluate(readRichText)).filter(
        (r) => r.end > start && r.start < formatEnd,
      );
      if (!changed.every((r) => r[key] === format[key])) await button.click();
    }
    if (
      await page
        .locator('#shared_menu_floating_toggle_bold')
        .isVisible()
        .catch(() => false)
    )
      await this.closeMenu(page, page.locator('#shared_menu_floating_toggle_bold'));
    if (format.fontSize !== undefined) {
      await selectRange(editor, start, formatEnd);
      await page.locator('#textToolbarSizeStyle').click();
      const input = page.locator('#textToolbarMenuFontSize input');
      await input.waitFor({ state: 'visible' });
      mark();
      await input.fill(String(format.fontSize));
      await input.press('Tab');
      await this.closeMenu(page, page.locator('#textToolbarMenuFontSize'));
    }
    if (format.align !== undefined) {
      await selectRange(editor, start, formatEnd);
      await page.locator('#textToolbarTextAlignments').click();
      mark();
      await page.locator('#shared_menu_floating_change_alignment_' + format.align).click();
      if (
        await page
          .locator('#object_text_alignment_floating_menu')
          .isVisible()
          .catch(() => false)
      )
        await this.closeMenu(page, page.locator('#object_text_alignment_floating_menu'));
    }
    if (format.link !== undefined) {
      const link = new URL(format.link);
      if (!['https:', 'http:'].includes(link.protocol) || link.username || link.password)
        throw new GoodnotesError(
          'INVALID_LINK',
          'Use an HTTP(S) URL without embedded credentials.',
        );
      await selectRange(editor, start, formatEnd);
      await editor.press('ControlOrMeta+k');
      await page.getByRole('dialog', { name: /Link/ }).waitFor({ state: 'visible' });
      const manageLink = page.getByRole('dialog', { name: 'Manage Link', exact: true });
      if (await manageLink.isVisible().catch(() => false))
        await manageLink.getByRole('button', { name: 'Edit Link', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: /Link/ });
      await dialog.waitFor({ state: 'visible' });
      await dialog.getByPlaceholder('Type or paste URL').fill(format.link);
      mark();
      await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    if (format.highlight !== undefined) {
      await selectRange(editor, start, formatEnd);
      await page.locator('#object_menu_context_menu_option').click();
      const menu = page.locator('#object_context_menu');
      await menu.getByText('Format', { exact: true }).click();
      await page.locator('#object_menu_context_context_menu_options_change_text_highlight').click();
      const panel = page.locator('#highlighterColorSelector');
      await panel.waitFor({ state: 'visible' });
      if (format.highlight === 'none') {
        mark();
        await page.locator('#highlighterColorSelectorNoColor').click();
      } else {
        const hex = format.highlight.slice(0, 7);
        await a.styles.chooseColor(
          page,
          {
            selector: '#highlighterColorSelector',
            nativeColor: hex + '80',
            colors: await panel.locator('[data-color-value]').evaluateAll((es) =>
              es.map((e) => ({
                color: e.getAttribute('data-color-value'),
                selected: e.getAttribute('aria-selected') === 'true',
              })),
            ),
            customSupported: await page
              .locator('#highlighterColorSelectorAddColor')
              .isVisible()
              .catch(() => false),
          },
          hex,
          mark,
        );
      }
      await this.closeMenu(page, panel);
    }
    if (format.list !== undefined) {
      await selectRange(editor, start, formatEnd);
      const current = await editor.evaluate(readRichText);
      if (!current.every((r) => (r.list ?? 'none') === format.list)) {
        const desired =
          format.list === 'none' ? (current.find((r) => r.list)?.list ?? 'bullet') : format.list;
        if (!['bullet', 'ordered'].includes(desired))
          throw new GoodnotesError(
            'LIST_STYLE_UNSUPPORTED',
            'This native list type is not supported.',
          );
        await page.locator('#textToolbarTextListStyles').click();
        const button = page.locator(
          '#shared_menu_floating_toggle_' +
            (desired === 'bullet' ? 'bullet' : 'numbered') +
            '_list_style',
        );
        mark();
        await button.click();
        await page.waitForTimeout(150);
        if (format.list === 'none' && (await editor.evaluate(readRichText)).some((r) => r.list))
          await button.click();
        await this.closeMenu(page, page.locator('#object_text_list_style_floating_menu'));
      }
    }
    const mismatch = (runs) =>
      Object.entries(format).find(
        ([key, value]) =>
          !runs
            .filter((r) => r.end > start && r.start < formatEnd)
            .every(
              (r) =>
                (key === 'list' || key === 'highlight' ? (r[key] ?? 'none') : r[key]) === value,
            ),
      );
    // Goodnotes can update a swatch before its native rich text catches up.
    // Wait only for readback; never resend a toggle or color command.
    let differing = mismatch(await editor.evaluate(readRichText));
    for (let attempt = 0; differing && attempt < 20; attempt++) {
      checkCancellation(signal);
      await page.waitForTimeout(100);
      differing = mismatch(await editor.evaluate(readRichText));
    }
    if (differing)
      throw new GoodnotesError(
        'FORMAT_UNVERIFIED',
        'Goodnotes did not apply the requested ' + differing[0] + '.',
      );
  }
  async edit(
    { targetId, start = 0, end, replacement, format = {}, formatRanges = [], operationId },
    { signal } = {},
  ) {
    format = normalizeTextFormat(format);
    if (replacement !== undefined) replacement = replacement.replace(/\r\n?/g, '\n');
    const a = this.a,
      target = a.targets.get(targetId);
    if (!target || Date.now() - target.created > 600000)
      throw new GoodnotesError('STALE_TARGET', 'Read the text field again.');
    const view = a.getView(target.viewId);
    requireWritable(a, view);
    end ??= target.text.length;
    if (
      (format.list !== undefined || format.highlight !== undefined) &&
      (start !== 0 || end !== target.text.length)
    )
      throw new GoodnotesError(
        'LIST_RANGE_REQUIRED',
        'List and highlight formatting apply to the whole text field. Select its full range.',
      );
    const splitsSurrogate = (at) =>
      at > 0 &&
      at < target.text.length &&
      /[\uD800-\uDBFF]/.test(target.text[at - 1]) &&
      /[\uDC00-\uDFFF]/.test(target.text[at]);
    if (splitsSurrogate(start) || splitsSurrogate(end))
      throw new GoodnotesError('INVALID_RANGE', 'A range cannot split a Unicode surrogate pair.');
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > target.text.length
    )
      throw new GoodnotesError(
        'INVALID_RANGE',
        'Use UTF-16 character offsets within the returned text.',
      );
    if (replacement === undefined && !Object.keys(format).length && !formatRanges.length)
      throw new GoodnotesError('EMPTY_EDIT', 'Provide replacement text or formatting.');
    const expected =
      replacement === undefined
        ? target.text
        : target.text.slice(0, start) + replacement + target.text.slice(end);
    if (!expected.trim() || expected.length > 8000)
      throw new GoodnotesError(
        'INVALID_TEXT',
        'Use 1–8000 characters. Delete a whole box through the object tool.',
      );
    formatRanges = prepareFormatRanges(expected, formatRanges);
    return mutate(
      a,
      operationId,
      {
        action: 'edit-text',
        url: view.url,
        page: view.pageUrl,
        x: target.x,
        y: target.y,
        oldHash: digest(target.text),
        styleHash: target.styleHash,
        start,
        end,
        newHash: digest(expected),
        format,
        ...(formatRanges.length ? { formatRanges } : {}),
      },
      async (mark) => {
        const page = await a.assertView(view);
        let editor = await a.selectEditor(
          page,
          view,
          target.x,
          target.y,
          true,
          target.kind === 'sticky',
          target.linked ? target.editorBounds : undefined,
          target.kind,
        );
        const checkpoint = await captureBoardViewport(page);
        const read = () => editor.evaluate(readPlainText);
        await a.checkEditorKind(page, editor, target.kind);
        const originalRuns = await editor.evaluate(readRichText);
        const simple = await editor.evaluate(
          (el) =>
            !el.querySelector('li li,img,video') &&
            Array.from(el.children)
              .flatMap((e) => (['OL', 'UL'].includes(e.tagName) ? Array.from(e.children) : [e]))
              .every(
                (p) =>
                  p.textContent.replace(/\uFEFF/g, '') === '' ||
                  p.textContent.replace(/\uFEFF/g, '') === p.innerText.replace(/\uFEFF/g, ''),
              ),
        );
        if (!simple) {
          await a.leaveEditor(page, editor);
          throw new GoodnotesError(
            'UNSUPPORTED_TEXT_STRUCTURE',
            'Range edits support paragraphs and flat lists. This field contains nested lists, embedded content or inline line breaks.',
          );
        }
        if (
          (await read()) !== target.text ||
          (target.styleHash && digest(originalRuns) !== target.styleHash)
        ) {
          await a.leaveEditor(page, editor);
          throw new GoodnotesError(
            'TEXT_CONFLICT',
            'Text or formatting changed since the last read.',
          );
        }
        try {
          let formatEnd = end;
          await selectRange(editor, start, end);
          if (replacement !== undefined && (replacement !== '' || end > start)) {
            mark();
            if (replacement === '') await editor.press('Backspace');
            else {
              const lines = replacement.replace(/\r\n?/g, '\n').split('\n');
              for (let i = 0; i < lines.length; i++) {
                checkCancellation(signal);
                if (i) await editor.press('Enter');
                await page.keyboard.insertText(lines[i]);
              }
            }
            formatEnd = start + replacement.length;
          }
          if ((await read()) !== expected)
            throw new GoodnotesError(
              'INPUT_MISMATCH',
              'The exact replacement text did not match; formatting was not sent.',
            );
          if (
            replacement !== undefined &&
            (format.color || formatRanges.some((r) => r.format.color))
          ) {
            // Commit fresh native text before opening the color palette. Its
            // selection context can otherwise still refer to the old input.
            await a.leaveEditor(page, editor);
            editor = await a.selectEditor(
              page,
              view,
              target.x,
              target.y,
              true,
              target.kind === 'sticky',
              target.linked ? target.editorBounds : undefined,
              target.kind,
            );
            await a.checkEditorKind(page, editor, target.kind);
            if ((await read()) !== expected)
              throw new GoodnotesError(
                'INPUT_MISMATCH',
                'The exact text changed while reacquiring its color selection.',
              );
          }
          if (Object.keys(format).length)
            await this.applyFormat(page, editor, { start, end: formatEnd, format }, mark, {
              signal,
            });
          for (const part of formatRanges) {
            checkCancellation(signal);
            await this.applyFormat(page, editor, part, mark, { signal });
          }
          if ((await read()) !== expected)
            throw new GoodnotesError('INPUT_MISMATCH', 'The exact edited text did not match.');
          const desiredRuns = await editor.evaluate(readRichText);
          const desiredBounds = await editor.boundingBox();
          await a.leaveEditor(page, editor);
          await page.waitForTimeout(1500);
          await page.reload({ waitUntil: 'domcontentloaded' });
          await a.openDocument(view.pageUrl);
          await a.closePanels(page);
          await restoreBoardViewport(a, page, view, checkpoint, { signal });
          await a.assertView(view);
          const reopened = await a.selectEditor(
              page,
              view,
              target.x,
              target.y,
              true,
              target.kind === 'sticky',
              desiredRuns.some((r) => r.link) ? desiredBounds : undefined,
              target.kind,
            ),
            saved = await reopened.evaluate(readRichText);
          const savedText = await reopened.evaluate(readPlainText);
          await a.checkEditorKind(page, reopened, target.kind);
          await a.leaveEditor(page, reopened);
          if (savedText !== expected || digest(saved) !== digest(desiredRuns))
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'Text or formatting differed after reopening.',
            );
          await a.documents.invalidate(view.url);
          return {
            verified: true,
            verification: 'text-and-format-reload',
            viewId: view.viewId,
            characters: expected.length,
            textHash: digest(expected),
            formatHash: digest(saved),
          };
        } finally {
          const open = page.locator('.ql-editor[contenteditable="true"]');
          if ((await open.count()) === 1) await a.leaveEditor(page, open).catch(() => {});
        }
      },
      { signal },
    );
  }
}
