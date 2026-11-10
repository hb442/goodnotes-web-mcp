import path from 'node:path';
import { documentUrl } from './config.mjs';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { mutate, requireWritable } from './mutations.mjs';
import { digest } from './journal.mjs';
import { writeJson } from './store.mjs';
import { collectScrollList } from './scroll-list.mjs';

const selector = '[id^="outlineItem-"]';
const outlineHash = (entries) =>
  digest(entries.map(({ id, title, page, pageId }) => ({ id, title, page, pageId })));
export class OutlineController {
  constructor(a) {
    this.a = a;
  }
  async rows(page) {
    return page.locator(selector).evaluateAll((es) =>
      es.map((e) => ({
        id: e.id.slice('outlineItem-'.length),
        title: e.children[1]?.textContent.trim(),
        page: Number(e.children[2]?.textContent.trim().match(/^p\.\s*(\d+)$/i)?.[1]),
        flat:
          e.children.length === 3 &&
          !e.querySelector('[aria-expanded],button,[role=button],[id^=outlineItem-]'),
      })),
    );
  }
  async read({ url }, options = {}) {
    const a = this.a,
      page = await a.openDocument(url);
    await a.pages.sidebar(page);
    const pages = await a.pages.snapshot(page);
    await page.locator('#filterOptionOutlines').click();
    await page
      .locator(selector + ',#emptyOutlinesView')
      .first()
      .waitFor({ state: 'visible' });
    const scan = await collectScrollList(page, {
      selector,
      read: () => this.rows(page),
      maxItems: 2000,
      signal: options.signal,
    });
    const entries = scan.items.map((entry) => {
      if (
        !/^[a-f0-9-]{36}$/i.test(entry.id) ||
        typeof entry.title !== 'string' ||
        !entry.title ||
        !Number.isInteger(entry.page) ||
        entry.page < 1 ||
        entry.page > pages.count
      )
        throw new GoodnotesError(
          'OUTLINE_LIST_UNSUPPORTED',
          'An outline row has an unsupported identity, title or page label.',
        );
      return { ...entry, pageId: pages.pages[entry.page - 1].id };
    });
    a.invalidate();
    return {
      url: documentUrl(page.url()),
      title: (await page.locator('#infoButton').innerText()).trim(),
      entries,
      count: entries.length,
      scanComplete: scan.complete,
      outlineHash: outlineHash(entries),
      pageOrderHash: pages.orderHash,
      pageCount: pages.count,
    };
  }
  async list({ url, offset = 0, limit = 100 }, options) {
    const { entries, ...state } = await this.read({ url }, options);
    return {
      ...state,
      entries: entries.slice(offset, offset + limit),
      nextOffset: offset + limit < entries.length ? offset + limit : null,
      note: 'Native rows exposed by the Web outline list. Nested/imported outline structures are not supported for editing.',
    };
  }
  async manage(
    {
      url,
      outlineId,
      expectedTitle,
      expectedOutlineHash,
      expectedPageOrderHash,
      command,
      title,
      operationId,
    },
    options = {},
  ) {
    if (!/^[a-f0-9-]{36}$/i.test(outlineId) || !['rename', 'delete'].includes(command))
      throw new GoodnotesError(
        'INVALID_OUTLINE',
        'Choose one native outline identity and rename/delete.',
      );
    if (command === 'rename' && (!title?.trim() || title.trim().length > 150))
      throw new GoodnotesError(
        'TITLE_REQUIRED',
        'Use a nonempty outline title of at most 150 characters.',
      );
    title = command === 'rename' ? title.trim() : undefined;
    const a = this.a;
    return mutate(
      a,
      operationId,
      {
        action: 'outline-management',
        url,
        outlineId,
        expectedTitle,
        expectedOutlineHash,
        expectedPageOrderHash,
        command,
        title,
      },
      async (mark) => {
        const before = await this.read({ url }, options);
        requireWritable(a, before);
        if (!before.scanComplete)
          throw new GoodnotesError(
            'OUTLINE_LIST_INCOMPLETE',
            'An incomplete outline scan cannot authorize edits.',
          );
        if (
          before.outlineHash !== expectedOutlineHash ||
          before.pageOrderHash !== expectedPageOrderHash
        )
          throw new GoodnotesError(
            'OUTLINE_CONFLICT',
            'Outline entries or native page order changed. Read the list again.',
          );
        const entry = before.entries.find((e) => e.id === outlineId);
        if (!entry || entry.title !== expectedTitle)
          throw new GoodnotesError('OUTLINE_CONFLICT', 'The exact outline entry/title changed.');
        if (!entry.flat)
          throw new GoodnotesError(
            'OUTLINE_STRUCTURE_UNSUPPORTED',
            'Only a flat native outline row can be edited.',
          );
        if (command === 'rename' && title === entry.title)
          return { verified: true, changed: false, ...before };
        const page = await a.getPage();
        await a.pages.editMode(page);
        await collectScrollList(page, {
          selector,
          read: () => this.rows(page),
          maxItems: 2000,
          stopId: outlineId,
          restore: false,
          signal: options.signal,
        });
        const row = page.locator('#outlineItem-' + outlineId);
        await row.scrollIntoViewIfNeeded();
        const current = (await this.rows(page)).find((e) => e.id === outlineId);
        if (
          !current ||
          current.title !== entry.title ||
          current.page !== entry.page ||
          !current.flat
        )
          throw new GoodnotesError('OUTLINE_CONFLICT', 'The selected native outline row changed.');
        const receipt = await a.journal.get(operationId);
        await writeJson(
          path.join(a.config.directory, 'outline-checkpoints', operationId + '.json'),
          { operationId, fingerprint: receipt.fingerprint, ...before },
        );
        checkCancellation(options.signal);
        await row.click({ button: 'right' });
        const action = page.locator(
          command === 'rename' ? '#outlineItemContextMenuRename' : '#outlineItemContextMenuDelete',
        );
        if (!(await action.isVisible()) || !(await action.isEnabled()))
          throw new GoodnotesError(
            'OUTLINE_ACTION_UNAVAILABLE',
            'Goodnotes does not expose the requested native outline action.',
          );
        if (command === 'rename') {
          await action.click();
          const input = page.locator('#renameOutlineInput');
          await input.waitFor({ state: 'visible' });
          if ((await input.inputValue()) !== expectedTitle)
            throw new GoodnotesError(
              'OUTLINE_CONFLICT',
              'The native rename dialog belongs to a different title.',
            );
          await input.fill(title);
          checkCancellation(options.signal);
          mark();
          await page.locator('#renameOutlineConfirmButton').click();
          await input.waitFor({ state: 'hidden' });
        } else {
          checkCancellation(options.signal);
          mark();
          await action.click();
        }
        await page.waitForTimeout(1000);
        await page.reload({ waitUntil: 'domcontentloaded' });
        const after = await this.read({ url: before.url }, options),
          expected =
            command === 'delete'
              ? before.entries.filter((e) => e.id !== outlineId)
              : before.entries.map((e) => (e.id === outlineId ? { ...e, title } : e));
        if (
          !after.scanComplete ||
          after.url !== before.url ||
          after.title !== before.title ||
          after.pageOrderHash !== before.pageOrderHash ||
          after.pageCount !== before.pageCount ||
          outlineHash(after.entries) !== outlineHash(expected)
        )
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'The expected outline-only change did not match after reload.',
          );
        await a.documents.invalidate(before.url);
        return {
          verified: true,
          changed: true,
          verification: 'native-outline-identities-titles-and-page-order-after-reload',
          url: after.url,
          outlineId,
          command,
          ...(command === 'rename' ? { title } : {}),
          outlineHash: after.outlineHash,
          pageOrderHash: after.pageOrderHash,
          count: after.count,
          note: 'A private metadata checkpoint was saved. This changes only the outline entry; it does not provide automatic rollback.',
        };
      },
      options,
    );
  }
}
