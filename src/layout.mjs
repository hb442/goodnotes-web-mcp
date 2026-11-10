import { GoodnotesError } from './errors.mjs';
import { mutate, requireWritable } from './mutations.mjs';
import { documentUrl } from './config.mjs';

const patterns = { plain: 'Plain', dot: 'Dotted', grid: 'Grid' },
  colors = { white: 'White', yellow: 'Yellow', black: 'Black' };
export function uniqueTemplates(items) {
  const result = new Map();
  for (const item of items) {
    const previous = result.get(item.id);
    if (previous && previous.title !== item.title)
      throw new GoodnotesError(
        'AMBIGUOUS_TEMPLATE',
        'The same template ID has conflicting titles in the native catalog.',
      );
    result.set(item.id, { ...item, selected: item.selected || previous?.selected || false });
  }
  return [...result.values()];
}
export class LayoutController {
  constructor(adapter) {
    this.a = adapter;
  }
  async templateMenu({ url, page: number = 1, kind = 'paper' }) {
    const a = this.a,
      view = await a.inspect({ url: documentUrl(url) + '#page-' + number }),
      page = await a.getPage();
    await a.objects.tool(page, '#lassoToolButton');
    // Reopen through the normal page-list flow after entering edit mode. The
    // notebook renderer otherwise can consume Change Template without opening it.
    const pages = await a.pages.list({ url: documentUrl(url) + '#page-' + number });
    if (number < 1 || number > pages.count)
      throw new GoodnotesError('INVALID_PAGE', 'Template page is outside the document.');
    await a.pages.menu(page, number);
    const change = page.locator('#changeTemplate');
    if (!(await change.isVisible().catch(() => false)) || (await change.isDisabled()))
      throw new GoodnotesError(
        'TEMPLATE_UNAVAILABLE',
        'This page does not offer a native template change.',
      );
    const modal = page.locator('#template-library-template-change-modal');
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 0) await change.click();
      else await change.dispatchEvent('click');
      try {
        await modal.waitFor({ state: 'visible', timeout: 4000 });
        break;
      } catch (error) {
        if (attempt) throw error;
        // The editor sometimes consumes the first menu action while settling a
        // selected page. Reopen only this read-only dialog, never replay Apply.
        await page.keyboard.press('Escape');
        await a.resetOuterScroll(page);
        await a.pages.sidebar(page);
        await a.pages.menu(page, number);
        await page.waitForTimeout(400);
      }
    }
    await page.locator('#template-library-toggle-' + kind).click();
    await page.waitForTimeout(350);
    const templates = uniqueTemplates(
      await modal.locator('[id^="template-library-title-"]:visible').evaluateAll((es) =>
        es.map((e) => ({
          id: e.id,
          title: e.innerText.trim(),
          selected: e.querySelector('[data-selected]')?.getAttribute('data-selected') === 'true',
        })),
      ),
    );
    if (!templates.length || templates.length > 500)
      throw new GoodnotesError(
        'TEMPLATE_LIST_UNAVAILABLE',
        'No bounded native template catalog could be read.',
      );
    return { view, page, pages, templates };
  }
  async templates(args) {
    const { view, page, pages, templates } = await this.templateMenu(args);
    await page.locator('#template-library-template-change-cancel-button').click();
    return {
      url: view.url,
      page: args.page ?? 1,
      kind: args.kind ?? 'paper',
      pageCount: pages.count,
      orderHash: pages.orderHash,
      templates,
      scope:
        'Templates in the current native size/color filter. Does not enumerate the entire marketplace.',
    };
  }
  async setTemplate(
    {
      url,
      page: number,
      kind = 'paper',
      templateId,
      expectedPageCount,
      expectedOrderHash,
      operationId,
    },
    options,
  ) {
    return mutate(
      this.a,
      operationId,
      {
        action: 'page-template',
        url,
        number,
        kind,
        templateId,
        expectedPageCount,
        expectedOrderHash,
      },
      async (mark) => {
        const a = this.a,
          initial = await a.inspect({ url });
        requireWritable(a, initial);
        const backup = await a.documents.exportPdf({ url: initial.url }, options),
          beforePdf = await a.documents.get(backup.exportId);
        const { page, view, pages, templates } = await this.templateMenu({
          url,
          page: number,
          kind,
        });
        if (pages.count !== expectedPageCount || pages.orderHash !== expectedOrderHash)
          throw new GoodnotesError(
            'PAGE_CONFLICT',
            'Page count or order changed before template application.',
          );
        const chosen = templates.filter((t) => t.id === templateId);
        if (chosen.length !== 1 || !/^[A-Za-z0-9 _.\-]+$/.test(templateId))
          throw new GoodnotesError(
            'TEMPLATE_NOT_FOUND',
            'Choose one exact templateId returned by list_templates for this page and kind.',
            { templateId, matches: chosen.length, available: templates.length },
          );
        await page
          .locator('#template-library-template-change-modal')
          .locator('[id="' + templateId + '"]:visible')
          .first()
          .click();
        await page.waitForTimeout(150);
        if (
          !(await page
            .locator('#template-library-template-change-modal')
            .locator('[id="' + templateId + '"] [data-selected="true"]')
            .count())
        )
          throw new GoodnotesError(
            'TEMPLATE_SELECTION_UNVERIFIED',
            'The native picker did not select the requested template.',
          );
        await page
          .locator('#template-library-template-change-apply-button')
          .waitFor({ state: 'visible' });
        mark();
        await page.locator('#template-library-template-change-apply-button').click();
        await page.locator('#template-library-template-change-modal').waitFor({ state: 'hidden' });
        await page.waitForTimeout(1500);
        // Cover pages can stop exposing the template picker after Apply. Verify
        // their actual exported content across reload instead of reopening it.
        const desiredExport = await a.documents.exportPdf({ url: view.url }, options);
        await page.reload({ waitUntil: 'domcontentloaded' });
        const verified = await a.pages.list({ url: view.url });
        if (verified.orderHash !== pages.orderHash)
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Page order changed while replacing the template.',
          );
        const afterExport = await a.documents.exportPdf({ url: view.url }, options),
          afterPdf = await a.documents.get(afterExport.exportId);
        await a.recovery.assertSameContents(desiredExport.exportId, afterExport.exportId, options);
        if (
          afterPdf.index.pages.length !== beforePdf.index.pages.length ||
          beforePdf.index.pages.some(
            (p, i) => p.text.trim() && !afterPdf.index.pages[i].text.includes(p.text.trim()),
          )
        )
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Exported page text changed while replacing its template. Inspect the saved PDF backup.',
          );
        await a.documents.invalidate(view.url);
        a.invalidate();
        return {
          verified: true,
          verification:
            'native-picker-selection-page-identities-and-exported-appearance-after-reload',
          url: view.url,
          page: number,
          kind,
          templateId,
          title: chosen[0].title,
          templateTitle: chosen[0].title,
          backupExportId: backup.exportId,
          afterExportId: afterExport.exportId,
          expectedExportId: desiredExport.exportId,
          ...pages,
        };
      },
      options,
    );
  }
  async boardMenu(page) {
    await this.a.closePanels(page);
    const pattern = page.locator('#moreMenu-whiteboardBackgroundPattern'),
      color = page.locator('#moreMenu-whiteboardBackgroundColor');
    if (!(await pattern.isVisible().catch(() => false))) await page.locator('#moreButton').click();
    await pattern.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    if (
      !(await pattern.isVisible().catch(() => false)) ||
      !(await color.isVisible().catch(() => false))
    )
      throw new GoodnotesError(
        'BOARD_SETTINGS_UNAVAILABLE',
        'The current document does not expose whiteboard background settings.',
      );
    const value = async (locator, labels) => {
      const text = (await locator.innerText()).trim().split('\n').filter(Boolean).at(-1);
      const key = Object.keys(labels).find((k) => labels[k] === text);
      if (!key)
        throw new GoodnotesError(
          'UNKNOWN_BOARD_SETTING',
          'The native setting label is not recognized.',
        );
      return key;
    };
    return { pattern: await value(pattern, patterns), color: await value(color, colors) };
  }
  async boardSettings({ url }) {
    const view = await this.a.inspect({ url }),
      page = await this.a.getPage(),
      settings = await this.boardMenu(page);
    await page.keyboard.press('Escape');
    return {
      url: view.url,
      pageUrl: this.a.getView(view.viewId).pageUrl,
      ...settings,
      available: { patterns: Object.keys(patterns), colors: Object.keys(colors) },
    };
  }
  async setBoard({ url, pattern, color, expectedPattern, expectedColor, operationId }, options) {
    if (
      (pattern !== undefined && !patterns[pattern]) ||
      (color !== undefined && !colors[color]) ||
      (!pattern && !color)
    )
      throw new GoodnotesError(
        'INVALID_BOARD_SETTING',
        'Choose at least one supported pattern or color.',
      );
    return mutate(
      this.a,
      operationId,
      { action: 'board-background', url, pattern, color, expectedPattern, expectedColor },
      async (mark) => {
        const view = await this.a.inspect({ url });
        requireWritable(this.a, view);
        const page = await this.a.getPage(),
          before = await this.boardMenu(page);
        if (before.pattern !== expectedPattern || before.color !== expectedColor)
          throw new GoodnotesError(
            'BOARD_SETTINGS_CONFLICT',
            'Background settings changed. Read them again before writing.',
          );
        for (const [key, wanted, menu, prefix] of [
          [
            'pattern',
            pattern,
            '#moreMenu-whiteboardBackgroundPattern',
            '#whiteboardBackgroundPatternButton-',
          ],
          [
            'color',
            color,
            '#moreMenu-whiteboardBackgroundColor',
            '#whiteboardBackgroundThemeButton-',
          ],
        ]) {
          if (!wanted || wanted === before[key]) continue;
          await page.locator(menu).click();
          const button = page.locator(prefix + wanted);
          await button.waitFor({ state: 'visible' });
          mark();
          await button.click();
          await page.waitForTimeout(250);
          await this.boardMenu(page);
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1200);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await this.a.openDocument(this.a.getView(view.viewId).pageUrl);
        const after = await this.boardMenu(page);
        await page.keyboard.press('Escape');
        if (
          after.pattern !== (pattern ?? before.pattern) ||
          after.color !== (color ?? before.color)
        )
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Background settings did not persist after reload.',
          );
        await this.a.documents.invalidate(view.url);
        this.a.invalidate();
        return {
          verified: true,
          verification: 'native-background-settings-after-reload',
          url: view.url,
          before,
          after,
        };
      },
      options,
    );
  }
}
