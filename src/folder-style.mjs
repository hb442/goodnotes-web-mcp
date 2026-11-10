import { GoodnotesError } from './errors.mjs';
import { mutate } from './mutations.mjs';
import { requireFolderPermission, validateFolderPath } from './folders.mjs';

const colorPanel = '#libraryFolderCustomizeColorPopoverId';
const iconPanel = '#libraryFolderCustomizeSymbolPopoverId';
export async function folderCardState(card) {
  const state = await card.evaluate((e) => {
    const one = (selector) => {
      const nodes = e.querySelectorAll(selector);
      return nodes.length === 1 ? nodes[0] : null;
    };
    const favorite = one('[id^="libraryDocumentFolderFavorited_"]')?.id;
    const icon = one('[data-testid^="libraryDocumentFolderSymbol_"]')?.getAttribute('data-testid');
    return {
      favorite: favorite?.endsWith('_true') ? true : favorite?.endsWith('_false') ? false : null,
      icon: icon?.slice('libraryDocumentFolderSymbol_'.length) ?? null,
    };
  });
  if (state.favorite === null || !state.icon)
    throw new GoodnotesError(
      'FOLDER_STYLE_UNAVAILABLE',
      'Cannot read one native folder favorite/icon state.',
    );
  return state;
}
export class FolderStyleController {
  constructor(adapter) {
    this.a = adapter;
  }
  async locate(itemPath, expectedTitle) {
    validateFolderPath(itemPath);
    const { page, listing } = await this.a.library.folder(itemPath.slice(0, -1));
    const item = listing.items.find((i) => i.id === itemPath.at(-1) && i.kind === 'folder');
    if (!item || item.title !== expectedTitle)
      throw new GoodnotesError('FOLDER_CONFLICT', 'The folder identity or expected title changed.');
    return { page, card: await this.a.library.card(page, item.id), item };
  }
  async palette(page, id, property) {
    await this.a.library.menu(page, id);
    await page
      .locator(
        property === 'color'
          ? '#libraryFolderCustomizeColorMenuItemId'
          : '#libraryFolderSetIconMenuItemId',
      )
      .click();
    const panel = page.locator(property === 'color' ? colorPanel : iconPanel);
    await panel.waitFor({ state: 'visible' });
    return panel;
  }
  async close(page, panel) {
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden', timeout: 3000 });
  }
  async color(page, id) {
    const panel = await this.palette(page, id, 'color');
    const presets = await panel
      .locator('[data-color-value]')
      .evaluateAll((es) => es.map((e) => e.getAttribute('data-color-value')?.toLowerCase()));
    await page.locator('#libraryFolderStylizeMenuCustomColorCustomTabButtonId').click();
    const value = (await panel.getByTestId('colorPickerInput').inputValue()).toLowerCase();
    if (!/^#[a-f0-9]{6}$/.test(value))
      throw new GoodnotesError(
        'FOLDER_STYLE_UNAVAILABLE',
        'The folder color picker did not expose a six-digit current color.',
      );
    await this.close(page, panel);
    return { value, presets: [...new Set(presets)], customSupported: true };
  }
  async inspect({ itemPath, expectedTitle, includeChoices = false }) {
    const { page, card } = await this.locate(itemPath, expectedTitle),
      color = await this.color(page, itemPath.at(-1));
    let icons;
    if (includeChoices) {
      const panel = await this.palette(page, itemPath.at(-1), 'icon');
      icons = await panel
        .locator('button[id^="libraryFolderStylizeMenuColorOption_"]')
        .evaluateAll((es) =>
          es.map((e) => e.id.slice('libraryFolderStylizeMenuColorOption_'.length)),
        );
      await this.close(page, panel);
    }
    // Library cards can briefly expose default icon/favorite metadata while
    // their native color dialog already works. Read them last and require two
    // matching observations instead of retaining the initial placeholder.
    let state = await folderCardState(card),
      settled = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.waitForTimeout(300);
      const next = await folderCardState(card);
      if (JSON.stringify(next) === JSON.stringify(state)) {
        settled = true;
        break;
      }
      state = next;
    }
    if (!settled)
      throw new GoodnotesError(
        'FOLDER_STYLE_LOADING',
        'The folder metadata is still changing. Read it again.',
      );
    return {
      itemPath,
      title: expectedTitle,
      state: { ...state, color: color.value },
      ...(includeChoices ? { colors: color.presets, customColorSupported: true, icons } : {}),
    };
  }
  async set({ itemPath, expectedTitle, property, value, expectedValue, operationId }, options) {
    validateFolderPath(itemPath);
    if (!['color', 'icon', 'favorite'].includes(property))
      throw new GoodnotesError('INVALID_FOLDER_PROPERTY', 'Choose color, icon or favorite.');
    if (
      property === 'favorite'
        ? typeof value !== 'boolean' || typeof expectedValue !== 'boolean'
        : typeof value !== 'string' || typeof expectedValue !== 'string'
    )
      throw new GoodnotesError(
        'INVALID_FOLDER_STYLE',
        'Favorite needs booleans; color and icon need strings.',
      );
    if (
      property === 'color' &&
      (!/^#[a-f0-9]{6}$/i.test(value) || !/^#[a-f0-9]{6}$/i.test(expectedValue))
    )
      throw new GoodnotesError('INVALID_COLOR', 'Folder colors require six-digit hex values.');
    if (property === 'icon' && !/^[a-z0-9-]{1,40}$/.test(value))
      throw new GoodnotesError('INVALID_ICON', 'Use an icon returned by get_folder_style.');
    if (property === 'color') {
      value = value.toLowerCase();
      expectedValue = expectedValue.toLowerCase();
    }
    return mutate(
      this.a,
      operationId,
      { action: 'folder-style', itemPath, expectedTitle, property, value, expectedValue },
      async (mark) => {
        const a = this.a;
        await requireFolderPermission(a.config.directory, itemPath, expectedTitle);
        const before = await this.inspect({ itemPath, expectedTitle });
        if (before.state[property] !== expectedValue)
          throw new GoodnotesError(
            'FOLDER_STYLE_CONFLICT',
            'The folder style changed since it was read.',
          );
        if (value === expectedValue) return { verified: true, changed: false, ...before };
        await requireFolderPermission(a.config.directory, itemPath, expectedTitle);
        const page = await a.getPage(),
          id = itemPath.at(-1),
          card = await a.library.card(page, id);
        if (property === 'favorite') {
          const current = await folderCardState(card);
          if (current.favorite !== expectedValue)
            throw new GoodnotesError('FOLDER_STYLE_CONFLICT', 'The favorite state changed.');
          mark();
          await card.locator('[id^="libraryDocumentFolderFavorited_"]').click();
        } else {
          const panel = await this.palette(page, id, property);
          if (property === 'icon') {
            const target = panel.locator(
              '[id=' + JSON.stringify('libraryFolderStylizeMenuColorOption_' + value) + ']',
            );
            if ((await target.count()) !== 1)
              throw new GoodnotesError(
                'ICON_UNAVAILABLE',
                'This native icon is not offered. Read the choices again.',
              );
            mark();
            await target.click();
            if (await panel.isVisible().catch(() => false)) await this.close(page, panel);
          } else {
            await page.locator('#libraryFolderStylizeMenuCustomColorCustomTabButtonId').click();
            const input = panel.getByTestId('colorPickerInput');
            if ((await input.inputValue()).toLowerCase() !== expectedValue)
              throw new GoodnotesError(
                'FOLDER_STYLE_CONFLICT',
                'The current color changed before applying.',
              );
            await input.fill(value);
            mark();
            await panel.getByRole('button', { name: 'Confirm', exact: true }).click();
          }
        }
        await page.waitForTimeout(1200);
        const after = await this.inspect({ itemPath, expectedTitle });
        const expectedState = { ...before.state, [property]: value };
        const matches = () =>
          ['favorite', 'icon', 'color'].every((key) => after.state[key] === expectedState[key]);
        // Re-read late library metadata without repeating the mutation or
        // restarting navigation. A persistent mismatch still stays uncertain.
        for (let attempt = 0; attempt < 4 && !matches(); attempt++) {
          await page.waitForTimeout(1000);
          Object.assign(after.state, await folderCardState(await a.library.card(page, id)));
          if (after.state.color !== expectedState.color)
            after.state.color = (await this.color(page, id)).value;
        }
        for (const key of ['favorite', 'icon', 'color'])
          if (after.state[key] !== (key === property ? value : before.state[key]))
            throw new GoodnotesError(
              'SAVE_UNVERIFIED',
              'Folder ' + key + ' differed after reload.',
              { expectedState, observedState: after.state },
            );
        a.invalidate();
        return {
          verified: true,
          changed: true,
          ...after,
          previousState: before.state,
          verification: 'folder-identity-title-and-style-after-reload',
        };
      },
      options,
    );
  }
}
