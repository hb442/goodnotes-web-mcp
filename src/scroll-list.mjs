import { checkCancellation } from './errors.mjs';

// Inspect only the rendered DOM and normal scroll containers. Virtualized rows
// are collected by identity as they become visible; no private app store access.
export async function collectScrollList(
  page,
  { selector, read, key = 'id', maxItems = 10000, maxTurns = 400, stopId, restore = true, signal },
) {
  const first = page.locator(selector).first(),
    items = new Map();
  if (!(await first.count())) return { items: [], complete: true, windows: 0 };
  const handle = await page.evaluateHandle((selector) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error('List changed before scanning. Retry the read.');
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (
        /auto|scroll/.test(s.overflowY) &&
        p.clientHeight > 0 &&
        p.scrollHeight > p.clientHeight + 1
      )
        return p;
    }
    const root = document.scrollingElement;
    return root?.scrollHeight > root?.clientHeight + 1 ? root : null;
  }, selector);
  const available = await handle.evaluate((e) => !!e);
  const initial = available ? await handle.evaluate((e) => e.scrollTop) : 0;
  let complete = false,
    reason = null,
    windows = 0,
    settledBottom = 0,
    lastSize = -1;
  const settle = async () => {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.waitForTimeout(120);
  };
  try {
    if (available) {
      await handle.evaluate((e) => {
        e.scrollTop = 0;
      });
      await settle();
    }
    for (; windows < maxTurns; windows++) {
      checkCancellation(signal);
      for (const item of await read()) items.set(item[key], item);
      if (stopId !== undefined && items.has(stopId)) {
        complete = true;
        reason = 'target-found';
        break;
      }
      if (items.size > maxItems) {
        reason = 'item-limit';
        break;
      }
      if (!available) {
        complete = true;
        break;
      }
      const state = await handle.evaluate((e) => ({
        top: e.scrollTop,
        height: e.clientHeight,
        total: e.scrollHeight,
      }));
      if (state.top + state.height >= state.total - 2) {
        settledBottom = items.size === lastSize ? settledBottom + 1 : 0;
        if (settledBottom >= 2) {
          complete = true;
          break;
        }
      } else settledBottom = 0;
      lastSize = items.size;
      await handle.evaluate((e) => {
        e.scrollTop = Math.min(e.scrollHeight, e.scrollTop + Math.max(40, e.clientHeight * 0.75));
      });
      await settle();
    }
    if (!complete && !reason) reason = 'scroll-limit';
    return {
      items: [...items.values()].slice(0, maxItems),
      complete,
      reason,
      windows: windows + 1,
    };
  } finally {
    if (available && restore) {
      await handle
        .evaluate((e, top) => {
          e.scrollTop = top;
        }, initial)
        .catch(() => {});
      await page.waitForTimeout(120);
    }
    await handle.dispose();
  }
}
export async function revealListItem(page, selector, id, read) {
  const result = await collectScrollList(page, { selector, read, stopId: id, restore: false });
  return (
    result.items.some((item) => item.id === id) &&
    (await page
      .locator(selector)
      .evaluateAll(
        (es, id) =>
          es.some(
            (e) =>
              e.getAttribute('data-document-id') === id || e.getAttribute('data-testid') === id,
          ),
        id,
      ))
  );
}
