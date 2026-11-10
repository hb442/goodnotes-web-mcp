import { mutate, requireWritable } from './mutations.mjs';
import { GoodnotesError } from './errors.mjs';
import { collectScrollList } from './scroll-list.mjs';
import { digest } from './journal.mjs';
const selector = '[data-document-id],[id^="trashedPage-"]';
export class TrashController {
  constructor(adapter) {
    this.a = adapter;
  }
  async readCards(page) {
    return page.locator(selector).evaluateAll((es) =>
      es.map((e) => ({
        id: e.getAttribute('data-document-id') || e.id.replace('trashedPage-', ''),
        kind:
          e.getAttribute('data-document-type') ||
          (e.id.startsWith('trashedPage-') ? 'page' : 'unknown'),
        title: (
          e.querySelector(
            '[id^="libraryDocumentNameId-"],[id^="libraryDocumentWhiteboardNameId-"],[id^="libraryFolderTitle-"]',
          )?.textContent ||
          e.innerText.split('\n').find(Boolean) ||
          ''
        ).trim(),
      })),
    );
  }
  async list({ limit = 50, offset = 0 } = {}) {
    const page = await this.a.getPage();
    await page.goto('https://web.goodnotes.com/trashbin', { waitUntil: 'domcontentloaded' });
    await page.locator('#libraryTrashFilterButton').waitFor({ state: 'visible', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
    if (
      await page
        .getByText('Your files are being moved from your iOS device to Goodnotes Cloud', {
          exact: true,
        })
        .isVisible()
        .catch(() => false)
    )
      await page.getByRole('button', { name: 'Ok', exact: true }).click();
    const scan = await collectScrollList(page, {
      selector,
      read: () => this.readCards(page),
      maxItems: 10000,
    });
    this.a.invalidate();
    return {
      items: scan.items.slice(offset, offset + limit),
      scanComplete: scan.complete,
      truncated: !scan.complete || scan.items.length > offset + limit,
      nextOffset: scan.items.length > offset + limit ? offset + limit : null,
      total: scan.items.length,
    };
  }
  async trash({ itemPath, expectedTitle, operationId }, options) {
    return mutate(
      this.a,
      operationId,
      { action: 'trash-document', itemPath, expectedTitle },
      async (mark) => {
        const a = this.a,
          view = await a.openItem({ itemPath });
        requireWritable(a, view);
        if (view.title !== expectedTitle)
          throw new GoodnotesError('TITLE_CONFLICT', 'The document title changed.');
        const backup = await a.documents.exportPdf({ url: view.url }, options),
          id = itemPath.at(-1),
          parent = itemPath.slice(0, -1),
          { page, listing } = await a.library.folder(parent);
        if (
          !listing.items.some(
            (i) => i.id === id && i.title === expectedTitle && i.kind !== 'folder',
          )
        )
          throw new GoodnotesError(
            'ITEM_CHANGED',
            'The document is no longer in its expected folder.',
          );
        await a.library.menu(page, id);
        await page.locator('#libraryRequestDeleteId').click();
        const confirm = page.locator('#libraryConfirmDeleteId');
        await confirm.waitFor({ state: 'visible' });
        mark();
        await confirm.click();
        await confirm.waitFor({ state: 'hidden' });
        await page.waitForTimeout(1200);
        const listed = await this.list({ limit: 10000 });
        if (
          !listed.scanComplete ||
          !listed.items.some((i) => i.id === id && i.title === expectedTitle)
        )
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'The exact document was not confirmed in the reloaded Trash.',
          );
        await a.documents.invalidate(view.url);
        return {
          verified: true,
          verification: 'exact-document-in-trash-after-reload',
          url: view.url,
          title: view.title,
          itemPath,
          id,
          backupExportId: backup.exportId,
          note: 'Moved to Trash, not permanently deleted. Retain this operationId for guarded restoration.',
        };
      },
      options,
    );
  }
  async source(trashOperationId) {
    const receipt = await this.a.journal.get(trashOperationId),
      r = receipt.result;
    if (
      receipt.status !== 'verified' ||
      !r?.itemPath ||
      !r.backupExportId ||
      r.id !== r.itemPath.at(-1) ||
      receipt.fingerprint !==
        digest({ action: 'trash-document', itemPath: r.itemPath, expectedTitle: r.title })
    )
      throw new GoodnotesError(
        'TRASH_RECEIPT_REQUIRED',
        'Restoration requires the verified receipt of a document moved to Trash by this server.',
      );
    requireWritable(this.a, r);
    return r;
  }
  async verifyRestore({ trashOperationId }, options) {
    const r = await this.source(trashOperationId),
      { listing } = await this.a.library.folder(r.itemPath.slice(0, -1));
    if (!listing.items.some((i) => i.id === r.id && i.title === r.title))
      throw new GoodnotesError(
        'RESTORE_NOT_VERIFIED',
        'The exact document is not in its original folder. Inspect Trash and the library.',
      );
    const view = await this.a.openItem({ itemPath: r.itemPath });
    if (view.url !== r.url || view.title !== r.title)
      throw new GoodnotesError(
        'RESTORE_IDENTITY_CHANGED',
        'The restored document identity differs from its receipt.',
      );
    const current = await this.a.documents.exportPdf({ url: r.url }, options);
    await this.a.recovery.assertSameContents(r.backupExportId, current.exportId, options);
    return {
      verified: true,
      verification: 'restored-native-document-identity-and-PDF-baseline',
      url: r.url,
      title: r.title,
      itemPath: r.itemPath,
      trashOperationId,
      backupExportId: r.backupExportId,
      currentExportId: current.exportId,
    };
  }
  async restore({ trashOperationId, operationId }, options) {
    return mutate(
      this.a,
      operationId,
      { action: 'restore-trash-document', trashOperationId },
      async (mark) => {
        const r = await this.source(trashOperationId),
          listed = await this.list({ limit: 10000 });
        if (!listed.scanComplete)
          throw new GoodnotesError(
            'TRASH_INCOMPLETE',
            'The complete Trash could not be inspected.',
          );
        const item = listed.items.find((i) => i.id === r.id);
        if (!item)
          return { ...(await this.verifyRestore({ trashOperationId }, options)), changed: false };
        if (item.title !== r.title)
          throw new GoodnotesError('TRASH_ITEM_CHANGED', 'The trashed document title changed.');
        const page = await this.a.getPage();
        await this.a.library.menu(page, r.id);
        const button = page.locator('#libraryDocumentRecoverId');
        await button.waitFor({ state: 'visible' });
        mark();
        await button.click();
        await page.waitForTimeout(1500);
        return { ...(await this.verifyRestore({ trashOperationId }, options)), changed: true };
      },
      options,
    );
  }
}
