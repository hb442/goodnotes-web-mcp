import { GoodnotesError } from './errors.mjs';

// Menus may cover the dismiss layer's corner. Pick an exposed DOM hit target.
export async function dismissFloatingMenu(page, menu) {
  // A native submenu can consume the first dismissal while its parent stays
  // open. Reacquire an exposed dismissal target; never repeat a format action.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await dismissOnce(page, menu);
      return;
    } catch (error) {
      if (error.code !== 'MENU_DISMISS_UNAVAILABLE' || attempt === 2) throw error;
    }
  }
}

async function dismissOnce(page, menu) {
  if (!(await menu.isVisible().catch(() => false))) return;
  const point = await page
    .getByTestId('edit_menu_floating_menu_dismiss')
    .evaluateAll((elements) => {
      for (const el of elements) {
        const r = el.getBoundingClientRect();
        const left = Math.max(1, r.left),
          top = Math.max(1, r.top);
        const right = Math.min(innerWidth - 2, r.right),
          bottom = Math.min(innerHeight - 2, r.bottom);
        if (right - left < 4 || bottom - top < 4) continue;
        for (const [fx, fy] of [
          [0.5, 0.5],
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
          [0.5, 0],
          [0.5, 1],
          [0, 0.5],
          [1, 0.5],
        ]) {
          const x = left + 2 + fx * (right - left - 4),
            y = top + 2 + fy * (bottom - top - 4);
          const hit = document.elementFromPoint(x, y);
          if (hit === el) return { x, y };
        }
      }
      return null;
    });
  if (point) await page.mouse.click(point.x, point.y);
  else if (!(await page.getByTestId('edit_menu_floating_menu_dismiss').count())) {
    // Older native text toolbars have no overlay; Escape would exit editing.
    const corner = { x: 5, y: page.viewportSize().height - 5 };
    const covered = await menu.evaluate(
      (el, p) => el.contains(document.elementFromPoint(p.x, p.y)),
      corner,
    );
    if (covered)
      throw new GoodnotesError('MENU_DISMISS_UNAVAILABLE', 'No exposed dismissal target.');
    await page.mouse.click(corner.x, corner.y);
  } else await page.keyboard.press('Escape');
  try {
    await menu.waitFor({ state: 'hidden', timeout: 2000 });
  } catch {
    throw new GoodnotesError(
      'MENU_DISMISS_UNAVAILABLE',
      'The native format menu did not close; no document mutation was retried.',
    );
  }
}
