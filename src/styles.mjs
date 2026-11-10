import crypto from 'node:crypto';
import { dismissFloatingMenu } from './ui-menu.mjs';
import { mutate, requireWritable } from './mutations.mjs';
import { GoodnotesError } from './errors.mjs';
import { nearBounds, compareRegion, regionHash, waitForMappedRegion } from './visual.mjs';
import { readPlainText } from './rich-text.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson } from './store.mjs';

export class StyleController {
  constructor(adapter) {
    this.a = adapter;
    this.unlocks = new Map();
  }
  async selection(selectionId) {
    const s = this.a.objects.selections.get(selectionId);
    if (!s || Date.now() - s.created > 600000)
      throw new GoodnotesError('STALE_SELECTION', 'Select the object again.');
    const view = this.a.getView(s.viewId),
      page = await this.a.assertView(view),
      fresh = await this.a.objects.snapshot(page, view);
    if (!nearBounds(fresh.bounds, s.bounds, 1) || fresh.hash !== s.hash)
      throw new GoodnotesError(
        'SELECTION_CHANGED',
        'Selection or content changed. Select it again.',
      );
    return { s, view, page, fresh };
  }
  async openPalette(page) {
    const panel = page.locator('#colorSingleSelect:visible,#lassoColorSelector:visible');
    const button = page.locator('#shared_menu_options_change_color');
    if (
      !(await panel.isVisible().catch(() => false)) &&
      !(await button.isVisible().catch(() => false))
    )
      throw new GoodnotesError(
        'COLOR_UNAVAILABLE',
        'This selection offers no supported native color palette.',
      );
    if (!(await panel.isVisible().catch(() => false))) await button.click();
    await panel.waitFor({ state: 'visible' });
    const selector = '#' + (await panel.getAttribute('id'));
    const colors = await panel.locator('[data-color-value]').evaluateAll((es) =>
      es.map((e) => ({
        color: e.getAttribute('data-color-value'),
        selected: e.getAttribute('aria-selected') === 'true',
      })),
    );
    return {
      label: await panel.innerText(),
      colors,
      selector,
      customSupported: await page
        .locator('#colorSingleSelectAddColor')
        .isVisible()
        .catch(() => false),
    };
  }
  async closePalette(page) {
    const panel = page.locator('#colorSingleSelect:visible,#lassoColorSelector:visible');
    if (!(await panel.isVisible().catch(() => false))) return;
    await dismissFloatingMenu(page, panel);
  }
  async palette({ selectionId }) {
    const { page } = await this.selection(selectionId),
      palette = await this.openPalette(page);
    await this.closePalette(page);
    return { selectionId, ...palette };
  }
  async contextOptions(page) {
    const menu = page.locator('#object_context_menu');
    if (
      !(await menu
        .getByText(/^(Front|Bring to Front|Back|Send to Back)$/)
        .first()
        .isVisible()
        .catch(() => false))
    )
      await page.locator('#object_menu_context_menu_option').click();
    const labels = {
      front: ['Front', 'Bring to Front'],
      back: ['Back', 'Send to Back'],
      lock: ['Lock', 'Lock Sticky Note', 'Lock Image', 'Lock Textbox', 'Lock Shape'],
      unlock: ['Unlock', 'Unlock Sticky Note', 'Unlock Image', 'Unlock Textbox', 'Unlock Shape'],
      collapse: ['Collapse'],
      expand: ['Expand'],
      'hide-author': ['Hide Author'],
      'show-author': ['Show Author'],
    };
    const available = [];
    for (const [command, names] of Object.entries(labels))
      for (const label of names)
        if (
          await menu
            .getByText(label, { exact: true })
            .isVisible()
            .catch(() => false)
        )
          available.push({ command, label });
    return { menu, available };
  }
  async options({ selectionId }) {
    const { page, s } = await this.selection(selectionId),
      { available } = await this.contextOptions(page);
    await page.keyboard.press('Escape');
    return {
      selectionId,
      kind: s.kind,
      commands: available,
      note: 'Only commands visibly offered for this exact selection are returned. Front/back do not expose a numerical layer index.',
    };
  }
  async arrange({ selectionId, command, operationId }, options) {
    if (command === 'collapse') return this.collapseSticky({ selectionId, operationId }, options);
    const { s, view } = await this.selection(selectionId);
    requireWritable(this.a, view);
    return mutate(
      this.a,
      operationId,
      {
        action: 'object-arrange',
        url: view.url,
        page: view.pageUrl,
        bounds: s.bounds,
        hash: s.hash,
        command,
      },
      async (mark) => {
        const { page, fresh } = await this.selection(selectionId),
          context = await this.contextOptions(page),
          item = context.available.find((v) => v.command === command);
        if (!item)
          throw new GoodnotesError(
            'OBJECT_COMMAND_UNAVAILABLE',
            'This command is not offered for the selected object. Read object_options first.',
          );
        const button = context.menu.getByText(item.label, { exact: true });
        if ((await button.count()) !== 1)
          throw new GoodnotesError(
            'AMBIGUOUS_COMMAND',
            'Cannot identify one native object command.',
          );
        if (
          command === 'lock' &&
          item.label === 'Lock Shape' &&
          (!Number.isFinite(s.x) || !Number.isFinite(s.y))
        )
          throw new GoodnotesError(
            'SHAPE_POINT_REQUIRED',
            'Select the shape again at a point on its actual border before locking it.',
          );
        mark();
        await button.click();
        await page.waitForTimeout(300);
        if (command === 'lock') {
          const a = this.a;
          const kind =
            item.label === 'Lock Image'
              ? 'image'
              : item.label === 'Lock Textbox'
                ? 'text'
                : item.label === 'Lock Shape'
                  ? 'shape'
                  : 'sticky';
          await a.objects.readingMode(page);
          const expected = await this.unselectedImage(page);
          await page.waitForTimeout(1200);
          await page.reload({ waitUntil: 'domcontentloaded' });
          await a.openDocument(view.pageUrl);
          await a.closePanels(page);
          await a.assertView(view);
          await a.objects.readingMode(page);
          const persisted = await waitForMappedRegion(page, expected, s.bounds, s.bounds, {
              signal: options?.signal,
              capture: () => this.unselectedImage(page),
            }),
            after = persisted.bytes,
            appearance = persisted.comparison;
          if (!appearance.matches)
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'Locked object appearance changed after reload.',
            );
          const prepared = await this.prepareUnlock({
            kind,
            viewId: view.viewId,
            x:
              kind === 'shape'
                ? s.x
                : (s.bounds.x + Math.min(25, s.bounds.width / 3) - view.canvas.x) /
                  view.canvas.width,
            y:
              kind === 'shape'
                ? s.y
                : (s.bounds.y + Math.min(25, s.bounds.height / 3) - view.canvas.y) /
                  view.canvas.height,
          });
          await a.documents.invalidate(view.url);
          a.objects.selections.clear();
          return {
            verified: true,
            verification: 'native-unlock-control-and-appearance-after-reload',
            command,
            locked: true,
            kind,
            unlockId: prepared.unlockId,
            viewId: view.viewId,
            appearance,
            evidence: await a.objects.evidence(operationId, fresh.bytes, after),
            next: 'Use goodnotes_unlock_object with unlockId, or prepare_unlock again with the same kind after navigation.',
          };
        }
        const active = await this.a.objects.snapshot(page, view);
        await this.a.objects.readingMode(page);
        const expected = await page.screenshot(),
          bounds = {
            x: Math.min(s.bounds.x, active.bounds.x) - 12,
            y: Math.min(s.bounds.y, active.bounds.y) - 12,
            width:
              Math.max(s.bounds.x + s.bounds.width, active.bounds.x + active.bounds.width) -
              Math.min(s.bounds.x, active.bounds.x) +
              24,
            height:
              Math.max(s.bounds.y + s.bounds.height, active.bounds.y + active.bounds.height) -
              Math.min(s.bounds.y, active.bounds.y) +
              24,
          };
        await page.waitForTimeout(1200);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await this.a.openDocument(view.pageUrl);
        await this.a.closePanels(page);
        await this.a.assertView(view);
        await this.a.objects.readingMode(page);
        const after = await page.screenshot(),
          appearance = await compareRegion(expected, after, bounds);
        if (!appearance.matches)
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Arranged object appearance changed after reload.',
          );
        if (s.region) await this.a.objects.select({ viewId: view.viewId, region: s.region });
        else await this.a.objects.reselectBounds(page, view, active.bounds);
        const inverse = {
          lock: 'unlock',
          unlock: 'lock',
          collapse: 'expand',
          expand: 'collapse',
          'hide-author': 'show-author',
          'show-author': 'hide-author',
        }[command];
        if (inverse) {
          const saved = await this.contextOptions(page);
          if (!saved.available.some((v) => v.command === inverse))
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'The native menu did not confirm the requested object state.',
            );
          await page.keyboard.press('Escape');
        }
        const saved = await this.a.objects.snapshot(page, view),
          newId = crypto.randomUUID();
        this.a.objects.selections.clear();
        this.a.objects.selections.set(newId, {
          ...saved,
          viewId: s.viewId,
          kind: s.kind,
          ...(s.region ? { region: s.region } : {}),
          created: Date.now(),
        });
        await this.a.documents.invalidate(view.url);
        return {
          verified: true,
          verification: inverse
            ? 'native-object-state-and-appearance-after-reload'
            : 'native-layer-command-and-appearance-after-reload',
          command,
          selectionId: newId,
          bounds: saved.bounds,
          appearance,
          evidence: await this.a.objects.evidence(operationId, fresh.bytes, after),
          ...(!inverse
            ? {
                note: 'The native layer action was sent and its visible result survived reload. Goodnotes exposes no numerical layer index; non-overlapping objects may look unchanged.',
              }
            : {}),
        };
      },
      options,
    );
  }
  async prepareUnlock({ viewId, x, y, expectedText, kind = 'sticky' }) {
    const suffix = { sticky: 'sticky_note', image: 'image', text: 'text', shape: 'shape' }[kind];
    if (!suffix)
      throw new GoodnotesError('INVALID_OBJECT_KIND', 'Choose sticky, image, text or shape.');
    const a = this.a,
      view = a.getView(viewId),
      page = await a.assertView(view),
      point = a.objects.point(view, x, y);
    await a.objects.readingMode(page);
    const region = {
      x: view.canvas.x + 10,
      y: view.canvas.y + 50,
      width: view.canvas.width - 20,
      height: view.canvas.height - 110,
    };
    await a.objects.tool(page, '#lassoToolButton');
    await a.objects.clickCanvas(page, point.x, point.y);
    const unlock = page.locator('#shared_menu_options_unlock_' + suffix);
    if (!(await unlock.isVisible().catch(() => false)))
      throw new GoodnotesError(
        kind === 'sticky' ? 'NOT_A_LOCKED_STICKY' : 'NOT_A_LOCKED_OBJECT',
        'The selected point does not expose the native unlock control for ' + kind + '.',
      );
    const editor = page.locator('.ql-editor:visible'),
      text =
        kind !== 'image' && (await editor.count()) === 1
          ? await editor.evaluate(readPlainText)
          : null;
    if (expectedText !== undefined && text !== expectedText)
      throw new GoodnotesError(
        'TEXT_CONFLICT',
        'The visible locked object text does not match expectedText.',
      );
    const before = await this.unselectedImage(page);
    const unlockId = crypto.randomUUID();
    this.unlocks.set(unlockId, {
      kind,
      viewId,
      x,
      y,
      text,
      region,
      before,
      hash: await regionHash(before, region),
      created: Date.now(),
    });
    return {
      unlockId,
      kind,
      viewId,
      text,
      x,
      y,
      expiresInSeconds: 600,
      next: 'Unlock changes the native position/size lock; it does not replace the text.',
    };
  }
  async unselectedImage(page) {
    await this.a.objects.readingMode(page);
    await page.mouse.move(5, page.viewportSize().height - 5);
    await page.waitForTimeout(250);
    // The floating zoom control fades independently of the document. Hide only
    // this observed UI element during capture, including its drop shadow.
    return page.screenshot({
      animations: 'disabled',
      style: '#zoomControl { visibility: hidden !important; }',
    });
  }
  async unlockSticky({ unlockId, operationId }, options) {
    const record = this.unlocks.get(unlockId);
    if (record?.kind && record.kind !== 'sticky')
      throw new GoodnotesError(
        'WRONG_OBJECT_KIND',
        'Use goodnotes_unlock_object for a text box or image.',
      );
    return this.unlockObject({ unlockId, operationId }, options);
  }
  async unlockObject({ unlockId, operationId }, options) {
    const a = this.a,
      record = this.unlocks.get(unlockId);
    if (!record || Date.now() - record.created > 600000)
      throw new GoodnotesError('STALE_UNLOCK', 'Prepare the locked object again.');
    const kind = record.kind ?? 'sticky',
      suffix = { sticky: 'sticky_note', image: 'image', text: 'text', shape: 'shape' }[kind];
    const view = a.getView(record.viewId);
    requireWritable(a, view);
    return mutate(
      a,
      operationId,
      {
        action: kind === 'sticky' ? 'unlock-sticky' : 'unlock-' + kind,
        url: view.url,
        page: view.pageUrl,
        x: record.x,
        y: record.y,
        hash: record.hash,
      },
      async (mark) => {
        const page = await a.assertView(view),
          current = await this.unselectedImage(page);
        if (!(await compareRegion(record.before, current, record.region)).matches)
          throw new GoodnotesError(
            kind === 'sticky' ? 'STICKY_CHANGED' : 'OBJECT_CHANGED',
            'The visible board changed since the locked object was prepared.',
          );
        await a.objects.tool(page, '#lassoToolButton');
        const point = a.objects.point(view, record.x, record.y);
        await a.objects.clickCanvas(page, point.x, point.y);
        const button = page.locator('#shared_menu_options_unlock_' + suffix);
        await button.waitFor({ state: 'visible' });
        const editor = page.locator('.ql-editor:visible'),
          text =
            kind !== 'image' && (await editor.count()) === 1
              ? await editor.evaluate(readPlainText)
              : null;
        if (text !== record.text)
          throw new GoodnotesError(
            'TEXT_CONFLICT',
            'The locked object text changed after preparation.',
          );
        mark();
        await button.click();
        await a.objects.readingMode(page);
        await page.waitForTimeout(1200);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await a.openDocument(view.pageUrl);
        await a.closePanels(page);
        await a.assertView(view);
        const persisted = await waitForMappedRegion(
            page,
            record.before,
            record.region,
            record.region,
            {
              signal: options?.signal,
              capture: () => this.unselectedImage(page),
            },
          ),
          after = persisted.bytes,
          appearance = persisted.comparison;
        if (!appearance.matches)
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'The visible content changed while unlocking.',
            { appearance, evidence: await a.objects.evidence(operationId, record.before, after) },
          );
        const selected = await a.objects.select({ viewId: view.viewId, x: record.x, y: record.y }),
          context = await this.contextOptions(page);
        const lockLabels =
          kind === 'image'
            ? ['Lock Image']
            : kind === 'text'
              ? ['Lock Textbox']
              : kind === 'shape'
                ? ['Lock Shape']
                : ['Lock', 'Lock Sticky Note'];
        if (!context.available.some((c) => c.command === 'lock' && lockLabels.includes(c.label)))
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'The native menu did not confirm the unlocked state.',
          );
        await page.keyboard.press('Escape');
        this.unlocks.delete(unlockId);
        await a.documents.invalidate(view.url);
        return {
          verified: true,
          verification: 'native-lock-control-and-unchanged-appearance-after-reload',
          ...selected,
          kind,
          viewId: view.viewId,
          appearance,
          evidence: await a.objects.evidence(operationId, record.before, after),
        };
      },
      options,
    );
  }
  async collapseSticky({ selectionId, operationId }, options) {
    const a = this.a,
      { s, view } = await this.selection(selectionId);
    requireWritable(a, view);
    return mutate(
      a,
      operationId,
      {
        action: 'collapse-sticky',
        url: view.url,
        page: view.pageUrl,
        bounds: s.bounds,
        hash: s.hash,
      },
      async (mark) => {
        const { page } = await this.selection(selectionId),
          context = await this.contextOptions(page);
        if (!context.available.some((c) => c.command === 'collapse'))
          throw new GoodnotesError(
            'OBJECT_COMMAND_UNAVAILABLE',
            'Select one expanded native sticky note.',
          );
        await page.keyboard.press('Escape');
        await a.objects.readingMode(page);
        const before = await page.screenshot(),
          bounds = {
            x: s.bounds.x - 12,
            y: s.bounds.y - 12,
            width: s.bounds.width + 24,
            height: s.bounds.height + 24,
          };
        await a.objects.reselectBounds(page, view, s.bounds);
        const menu = await this.contextOptions(page);
        mark();
        await menu.menu.getByText('Collapse', { exact: true }).click();
        await page.waitForTimeout(350);
        await a.objects.readingMode(page);
        const collapsed = await page.screenshot();
        if ((await compareRegion(before, collapsed, bounds)).matches)
          throw new GoodnotesError('COLLAPSE_UNVERIFIED', 'No visible collapsed state appeared.');
        const directory = path.join(a.config.directory, 'sticky-checkpoints');
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const receipt = await a.journal.get(operationId);
        await fs.writeFile(path.join(directory, operationId + '-expanded.png'), before, {
          mode: 0o600,
        });
        await fs.writeFile(path.join(directory, operationId + '-collapsed.png'), collapsed, {
          mode: 0o600,
        });
        await writeJson(path.join(directory, operationId + '.json'), {
          operationId,
          fingerprint: receipt.fingerprint,
          url: view.url,
          pageUrl: view.pageUrl,
          title: view.title,
          canvas: view.canvas,
          zoom: view.zoom,
          bounds,
          objectBounds: s.bounds,
          anchor: { x: s.bounds.x + 12, y: s.bounds.y + 12 },
        });
        await page.waitForTimeout(1200);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await a.openDocument(view.pageUrl);
        await a.closePanels(page);
        await a.assertView(view);
        await a.objects.readingMode(page);
        const after = await page.screenshot(),
          appearance = await compareRegion(collapsed, after, bounds);
        if (!appearance.matches)
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Collapsed sticky appearance changed after reload.',
          );
        await a.documents.invalidate(view.url);
        a.objects.selections.clear();
        return {
          verified: true,
          verification: 'collapsed-sticky-appearance-after-reload',
          collapsed: true,
          collapseOperationId: operationId,
          url: view.url,
          appearance,
          evidence: await a.objects.evidence(operationId, before, after),
          next: 'Use goodnotes_expand_sticky with collapseOperationId. Collapsing removes the normal selection.',
        };
      },
      options,
    );
  }
  async expandSticky({ collapseOperationId, operationId }, options) {
    const a = this.a,
      receipt = await a.journal.get(collapseOperationId),
      directory = path.join(a.config.directory, 'sticky-checkpoints'),
      record = await readJson(path.join(directory, collapseOperationId + '.json'), null);
    if (
      !record ||
      !['verified', 'uncertain'].includes(receipt.status) ||
      record.operationId !== collapseOperationId ||
      record.fingerprint !== receipt.fingerprint
    )
      throw new GoodnotesError(
        'STICKY_CHECKPOINT_REQUIRED',
        'Expansion requires the saved checkpoint of an MCP collapse.',
      );
    requireWritable(a, record);
    return mutate(
      a,
      operationId,
      { action: 'expand-sticky', collapseOperationId },
      async (mark) => {
        const inspected = await a.inspect({ url: record.pageUrl }),
          view = a.getView(inspected.viewId),
          page = await a.getPage();
        if (
          view.title !== record.title ||
          view.zoom !== record.zoom ||
          !nearBounds(view.canvas, record.canvas, 1)
        )
          throw new GoodnotesError(
            'STICKY_VIEW_CHANGED',
            'Restore the original page, zoom and viewport before expanding this saved sticky.',
          );
        await a.objects.readingMode(page);
        const current = await page.screenshot(),
          collapsed = await fs.readFile(
            path.join(directory, collapseOperationId + '-collapsed.png'),
          ),
          original = await fs.readFile(path.join(directory, collapseOperationId + '-expanded.png'));
        if (!(await compareRegion(collapsed, current, record.bounds)).matches)
          throw new GoodnotesError(
            'STICKY_CHANGED',
            'The saved collapsed region changed. No click was sent.',
          );
        await a.objects.tool(page, '#lassoToolButton');
        await a.assertView(view);
        mark();
        await a.objects.clickCanvas(page, record.anchor.x, record.anchor.y);
        await page.waitForTimeout(400);
        await a.objects.readingMode(page);
        const expanded = await page.screenshot();
        if (!(await compareRegion(original, expanded, record.bounds)).matches)
          throw new GoodnotesError(
            'EXPAND_UNVERIFIED',
            'The expanded sticky did not match its original appearance.',
          );
        await page.waitForTimeout(1200);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await a.openDocument(record.pageUrl);
        await a.closePanels(page);
        await a.assertView(view);
        await a.objects.readingMode(page);
        const after = await page.screenshot(),
          appearance = await compareRegion(original, after, record.bounds);
        if (!appearance.matches)
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Expanded sticky did not persist after reload.',
          );
        await a.objects.reselectBounds(page, view, record.objectBounds);
        const saved = await a.objects.snapshot(page, view),
          selectionId = crypto.randomUUID();
        a.objects.selections.clear();
        a.objects.selections.set(selectionId, {
          ...saved,
          viewId: view.viewId,
          kind: 'sticky',
          created: Date.now(),
        });
        await a.documents.invalidate(record.url);
        return {
          verified: true,
          verification: 'expanded-sticky-original-appearance-after-reload',
          url: record.url,
          collapseOperationId,
          viewId: view.viewId,
          selectionId,
          bounds: saved.bounds,
          appearance,
          evidence: await a.objects.evidence(operationId, current, after),
        };
      },
      options,
    );
  }
  async chooseColor(page, palette, color, mark) {
    const wanted = palette.nativeColor ?? color;
    const option = palette.colors.find((c) => c.color?.toLowerCase() === wanted.toLowerCase());
    if (option) {
      const swatch = page.locator(palette.selector).locator(`[data-color-value="${option.color}"]`);
      if ((await swatch.count()) !== 1)
        throw new GoodnotesError('AMBIGUOUS_COLOR', 'Palette contains duplicate colors.');
      mark();
      await swatch.click();
      return;
    }
    if (!palette.customSupported)
      throw new GoodnotesError(
        'COLOR_UNAVAILABLE',
        'This native palette does not offer the requested color or a custom color input.',
      );
    await page.locator(palette.selector + 'AddColor').click();
    const input = page.locator(palette.selector + 'CustomColorInput');
    await input.waitFor({ state: 'visible' });
    mark();
    await input.fill(color);
    await page.locator(palette.selector + 'CommitColorChange').click();
    // Some versions add a custom swatch without applying it to the selection.
    // Apply the newly exposed swatch only when the native state says unselected.
    const panel = page.locator(palette.selector);
    if (await panel.isVisible().catch(() => false)) {
      const added = panel.locator('[data-color-value]').filter({ visible: true });
      const values = await added.evaluateAll((es) =>
        es.map((e) => ({
          value: e.getAttribute('data-color-value'),
          selected: e.getAttribute('aria-selected'),
        })),
      );
      const matching = values.filter((v) => v.value?.toLowerCase() === wanted.toLowerCase());
      if (matching.length > 1)
        throw new GoodnotesError('AMBIGUOUS_COLOR', 'Palette contains duplicate colors.');
      if (matching.length === 1 && matching[0].selected === 'false') {
        mark();
        await panel.locator(`[data-color-value="${matching[0].value}"]`).click();
      }
    }
  }
  async color({ selectionId, color, operationId }, options) {
    const { s, view } = await this.selection(selectionId);
    requireWritable(this.a, view);
    return mutate(
      this.a,
      operationId,
      {
        action: 'object-color',
        url: view.url,
        page: view.pageUrl,
        bounds: s.bounds,
        hash: s.hash,
        color,
      },
      async (mark) => {
        const { page, fresh } = await this.selection(selectionId),
          palette = await this.openPalette(page);
        const option = palette.colors.find((c) => c.color?.toLowerCase() === color.toLowerCase());
        if (option?.selected) {
          await this.closePalette(page);
          return { verified: true, changed: false, color };
        }
        await this.chooseColor(page, palette, color, mark);
        await this.closePalette(page);
        await this.a.objects.readingMode(page);
        const expected = await page.screenshot(),
          b = {
            x: s.bounds.x - 12,
            y: s.bounds.y - 12,
            width: s.bounds.width + 24,
            height: s.bounds.height + 24,
          };
        await page.waitForTimeout(1200);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await this.a.openDocument(view.pageUrl);
        await this.a.closePanels(page);
        await this.a.assertView(view);
        await this.a.objects.readingMode(page);
        const after = await page.screenshot(),
          appearance = await compareRegion(expected, after, b);
        if (!appearance.matches)
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Object color/appearance differed after reload.',
          );
        await this.a.objects.reselectBounds(page, view, s.bounds);
        const savedPalette = await this.openPalette(page);
        if (
          !savedPalette.colors.some(
            (c) => c.selected && c.color?.toLowerCase() === color.toLowerCase(),
          )
        )
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Native palette did not confirm the saved color.',
          );
        await this.closePalette(page);
        const saved = await this.a.objects.snapshot(page, view),
          newId = crypto.randomUUID();
        this.a.objects.selections.clear();
        this.a.objects.selections.set(newId, {
          ...saved,
          viewId: s.viewId,
          kind: s.kind,
          created: Date.now(),
        });
        await this.a.documents.invalidate(view.url);
        return {
          verified: true,
          verification: 'native-color-and-appearance-after-reload',
          color,
          selectionId: newId,
          appearance,
          evidence: await this.a.objects.evidence(operationId, fresh.bytes, after),
        };
      },
      options,
    );
  }
}
