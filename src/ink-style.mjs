import { GoodnotesError, checkCancellation } from './errors.mjs';

export async function configureInk(
  adapter,
  page,
  { tool = 'pen', penKind, thicknessMm, color },
  mark,
  options = {},
) {
  await adapter.objects.tool(page, '#writingToolsButton');
  const id = {
    pen: 'penToolButton',
    pencil: 'pencilToolButton',
    highlighter: 'highlighterToolButton',
  }[tool];
  if (!id) throw new GoodnotesError('INVALID_INK_TOOL', 'Choose pen, pencil or highlighter.');
  const button = page.locator('#' + id);
  if (!(await button.isVisible())) await page.locator('#writingToolsButton').click();
  if ((await button.getAttribute('data-is-selected')) !== 'true') {
    mark();
    await button.click();
  }
  if (penKind) {
    if (tool !== 'pen')
      throw new GoodnotesError('INVALID_PEN_KIND', 'Pen kind applies only to the pen tool.');
    await button.click();
    const choice = page.locator(
      '#' +
        {
          ball: 'penBallTypeButton',
          fountain: 'penFountainTypeButton',
          brush: 'penBrushTypeButton',
        }[penKind],
    );
    await choice.waitFor({ state: 'visible' });
    mark();
    await choice.click();
    if (await choice.isVisible().catch(() => false)) await button.click();
  }
  let observedThickness;
  if (thicknessMm !== undefined) {
    const slider = page.getByTestId('toolThicknessSlider');
    for (let i = 0; i < 2 && !(await slider.isVisible().catch(() => false)); i++)
      await page.locator('#toolQuickThicknessOption1').click();
    await slider.waitFor({ state: 'visible' });
    const b = await slider.boundingBox();
    const value = async () => {
      const label = page.getByText(/^\d+(?:\.\d+)? mm$/);
      if ((await label.count()) !== 1)
        throw new GoodnotesError(
          'THICKNESS_UNAVAILABLE',
          'Cannot read the native thickness value.',
        );
      return parseFloat(await label.innerText());
    };
    const set = async (fraction) => {
      checkCancellation(options.signal);
      mark();
      await page.mouse.click(b.x + 1 + fraction * (b.width - 2), b.y + b.height / 2);
      await page.waitForTimeout(90);
      return value();
    };
    const min = await set(0),
      max = await set(1);
    if (thicknessMm < min - 0.005 || thicknessMm > max + 0.005)
      throw new GoodnotesError('INVALID_THICKNESS', `This tool supports ${min}–${max} mm.`);
    let low = 0,
      high = 1;
    for (let i = 0; i < 14; i++) {
      const at = (low + high) / 2;
      observedThickness = await set(at);
      if (Math.abs(observedThickness - thicknessMm) < 0.006) break;
      if (observedThickness < thicknessMm) low = at;
      else high = at;
    }
    if (Math.abs(observedThickness - thicknessMm) >= 0.006)
      throw new GoodnotesError(
        'THICKNESS_UNVERIFIED',
        'The native slider could not reach the requested thickness exactly.',
      );
    await page.locator('#toolQuickThicknessOption1').click();
    await slider.waitFor({ state: 'hidden' });
  }
  if (color) {
    await page.locator('#toolQuickColorOption3').click();
    const panel = page.locator('[id$="ColorSelector"]:visible');
    if ((await panel.count()) !== 1)
      throw new GoodnotesError(
        'COLOR_UNAVAILABLE',
        'Cannot uniquely identify the writing-tool palette.',
      );
    const selector = '#' + (await panel.getAttribute('id')),
      colors = await panel.locator('[data-color-value]').evaluateAll((es) =>
        es.map((e) => ({
          color: e.getAttribute('data-color-value'),
          selected: e.getAttribute('aria-selected') === 'true',
        })),
      );
    await adapter.styles.chooseColor(
      page,
      {
        selector,
        colors,
        nativeColor: tool === 'highlighter' ? color + '80' : color,
        customSupported: await page
          .locator(selector + 'AddColor')
          .isVisible()
          .catch(() => false),
      },
      color,
      mark,
    );
    const selected = await panel
      .locator('[data-color-value][aria-selected="true"]')
      .evaluateAll((es) => es.map((e) => e.getAttribute('data-color-value')?.toLowerCase()));
    if (!selected.includes((tool === 'highlighter' ? color + '80' : color).toLowerCase()))
      throw new GoodnotesError(
        'COLOR_UNVERIFIED',
        'The writing palette did not confirm the requested color.',
      );
    if (await panel.isVisible().catch(() => false))
      await page.locator('#toolQuickColorOption3').click();
  }
  if ((await button.getAttribute('data-is-selected')) !== 'true')
    throw new GoodnotesError('INK_TOOL_UNVERIFIED', 'The requested writing tool is not selected.');
  return {
    tool,
    ...(penKind ? { penKind } : {}),
    ...(observedThickness === undefined ? {} : { thicknessMm: observedThickness }),
    ...(color ? { color } : {}),
    note: 'Native writing-tool settings affect subsequent strokes and may persist in this isolated Goodnotes profile.',
  };
}
