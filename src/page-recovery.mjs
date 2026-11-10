import path from 'node:path';
import { readJson, writeJson } from './store.mjs';
import { digest } from './journal.mjs';
import { documentUrl } from './config.mjs';
import { mutate, requireWritable } from './mutations.mjs';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { renderPdfPage } from './pdf.mjs';
import { compareRegion } from './visual.mjs';
import { collectScrollList } from './scroll-list.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function remainingOrder(original, pageId) {
  if (
    !Array.isArray(original) ||
    original.length < 2 ||
    original.length > 2000 ||
    original.some((id) => !uuid.test(id)) ||
    new Set(original).size !== original.length ||
    !original.includes(pageId)
  )
    throw new GoodnotesError(
      'PAGE_CHECKPOINT_INVALID',
      'The saved native page identities are inconsistent.',
    );
  return original.filter((id) => id !== pageId);
}
export class PageRecoveryController {
  constructor(a) {
    this.a = a;
    this.directory = path.join(a.config.directory, 'page-checkpoints');
  }
  file(operationId) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(operationId))
      throw new GoodnotesError(
        'INVALID_OPERATION_ID',
        'Use the original page deletion operation ID.',
      );
    return path.join(this.directory, operationId + '.json');
  }
  async checkpoint({ operationId, view, order, page, backupExportId }) {
    const receipt = await this.a.journal.get(operationId),
      pageId = order[page - 1];
    remainingOrder(order, pageId);
    const record = {
      operationId,
      fingerprint: receipt.fingerprint,
      url: view.url,
      title: view.title,
      originalOrder: order,
      pageId,
      page,
      backupExportId,
    };
    await writeJson(this.file(operationId), record);
    return { deleteOperationId: operationId, trashPageId: pageId, backupExportId };
  }
  async source(deleteOperationId) {
    const record = await readJson(this.file(deleteOperationId), null),
      receipt = await this.a.journal.get(deleteOperationId);
    if (
      !record ||
      !['verified', 'uncertain'].includes(receipt.status) ||
      !record.fingerprint ||
      record.fingerprint !== receipt.fingerprint ||
      record.operationId !== deleteOperationId
    )
      throw new GoodnotesError(
        'PAGE_CHECKPOINT_REQUIRED',
        'A verified or uncertain MCP page deletion with its saved pre-delete checkpoint is required.',
      );
    if (
      documentUrl(record.url) !== record.url ||
      !uuid.test(record.backupExportId) ||
      record.originalOrder?.[record.page - 1] !== record.pageId
    )
      throw new GoodnotesError(
        'PAGE_CHECKPOINT_INVALID',
        'The saved page, document or export identity is inconsistent.',
      );
    remainingOrder(record.originalOrder, record.pageId);
    requireWritable(this.a, record);
    return { record, receipt };
  }
  async assertRemainingContents(record, currentExportId, options = {}) {
    const a = this.a,
      original = await a.documents.get(record.backupExportId),
      current = await a.documents.get(currentExportId),
      remaining = remainingOrder(record.originalOrder, record.pageId);
    if (
      original.index.pageCount !== record.originalOrder.length ||
      current.index.pageCount !== remaining.length
    )
      throw new GoodnotesError(
        'PAGE_CONTENT_CONFLICT',
        'Exported page counts differ from the saved deletion checkpoint.',
      );
    for (let i = 0; i < remaining.length; i++) {
      checkCancellation(options.signal);
      const oldIndex = record.originalOrder.indexOf(remaining[i]),
        before = original.index.pages[oldIndex],
        after = current.index.pages[i];
      if (
        before.text !== after.text ||
        Math.abs(before.width - after.width) > 1 ||
        Math.abs(before.height - after.height) > 1
      )
        throw new GoodnotesError(
          'PAGE_CONTENT_CONFLICT',
          'An existing page changed after deletion. Inspect it before restoring.',
        );
      const left = await renderPdfPage(original.record.path, oldIndex + 1, { maxDimension: 1000 }),
        right = await renderPdfPage(current.record.path, i + 1, { maxDimension: 1000 }),
        comparison = await compareRegion(left.bytes, right.bytes, {
          x: 0,
          y: 0,
          width: left.width,
          height: left.height,
        });
      if (!comparison.matches)
        throw new GoodnotesError(
          'PAGE_CONTENT_CONFLICT',
          'The rendered appearance of an existing page changed after deletion.',
        );
    }
  }
  async verifyRestore({ deleteOperationId }, options = {}) {
    const { record, receipt } = await this.source(deleteOperationId),
      listed = await this.a.pages.list({ url: record.url });
    if (
      listed.title !== record.title ||
      digest(listed.pages.map((p) => p.id)) !== digest(record.originalOrder)
    )
      throw new GoodnotesError(
        'PAGE_RESTORE_UNVERIFIED',
        'The original page identities and order have not been restored.',
      );
    const current = await this.a.documents.exportPdf({ url: record.url }, options);
    await this.a.recovery.assertSameContents(record.backupExportId, current.exportId, options);
    return {
      verified: true,
      verification: 'restored-page-identity-order-and-PDF-baseline',
      url: record.url,
      title: record.title,
      count: listed.count,
      orderHash: listed.orderHash,
      pageId: record.pageId,
      page: record.page,
      deleteOperationId,
      originalDeleteReceiptStatus: receipt.status,
      backupExportId: record.backupExportId,
      currentExportId: current.exportId,
      note: 'Original deletion receipt remains unchanged. PDF checks do not prove every native editing property or cloud delivery.',
    };
  }
  async restore({ deleteOperationId, operationId }, options = {}) {
    return mutate(
      this.a,
      operationId,
      { action: 'restore-deleted-page', deleteOperationId },
      async (mark) => {
        const a = this.a,
          { record } = await this.source(deleteOperationId),
          listed = await a.pages.list({ url: record.url }),
          ids = listed.pages.map((p) => p.id),
          remaining = remainingOrder(record.originalOrder, record.pageId);
        if (listed.title !== record.title)
          throw new GoodnotesError('TITLE_CONFLICT', 'The original document title changed.');
        if (digest(ids) === digest(record.originalOrder))
          return { ...(await this.verifyRestore({ deleteOperationId }, options)), changed: false };
        if (digest(ids) !== digest(remaining))
          throw new GoodnotesError(
            'PAGE_CONFLICT',
            'The remaining page identities/order changed after deletion.',
          );
        const current = await a.documents.exportPdf({ url: record.url }, options);
        await this.assertRemainingContents(record, current.exportId, options);
        const trash = await a.trash.list({ limit: 10000 });
        if (!trash.scanComplete)
          throw new GoodnotesError('TRASH_INCOMPLETE', 'Cannot verify the complete native Trash.');
        const item = trash.items.find((i) => i.id === record.pageId);
        if (!item || item.kind !== 'page' || item.title !== record.title)
          throw new GoodnotesError(
            'TRASH_PAGE_UNAVAILABLE',
            'The exact deleted page is not available in native Trash.',
          );
        const page = await a.getPage();
        await collectScrollList(page, {
          selector: '[data-document-id],[id^="trashedPage-"]',
          read: () => a.trash.readCards(page),
          stopId: record.pageId,
          restore: false,
          maxItems: 10000,
        });
        const card = page.locator('#trashedPage-' + record.pageId);
        if (
          (await card.count()) !== 1 ||
          (await card.getAttribute('data-page-id')) !== record.pageId
        )
          throw new GoodnotesError(
            'TRASH_PAGE_UNAVAILABLE',
            'Cannot locate one exact native deleted-page card.',
          );
        await card.click({ button: 'right' });
        const recover = page.locator('#recoverPage');
        await recover.waitFor({ state: 'visible' });
        checkCancellation(options.signal);
        mark();
        await recover.click();
        await page.waitForTimeout(1200);
        await page.reload({ waitUntil: 'domcontentloaded' });
        const restored = await a.pages.list({ url: record.url }),
          restoredIds = restored.pages.map((p) => p.id);
        if (
          restored.title !== record.title ||
          restoredIds.filter((id) => id === record.pageId).length !== 1 ||
          digest(restoredIds.filter((id) => id !== record.pageId)) !== digest(remaining)
        )
          throw new GoodnotesError(
            'PAGE_RESTORE_UNVERIFIED',
            'Recover did not add exactly the original native page.',
          );
        if (digest(restoredIds) !== digest(record.originalOrder)) {
          await a.pages.manage(
            {
              url: record.url,
              command: 'move',
              page: restoredIds.indexOf(record.pageId) + 1,
              destination: record.page,
              expectedPageCount: restored.count,
              expectedOrderHash: restored.orderHash,
              operationId: 'restore-page-order-' + digest(operationId).slice(0, 32),
            },
            options,
          );
        }
        return { ...(await this.verifyRestore({ deleteOperationId }, options)), changed: true };
      },
      options,
    );
  }
}
