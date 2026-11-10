import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, writeJson, uuidFile } from './store.mjs';
import { mutate } from './mutations.mjs';
import { digest } from './journal.mjs';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { renderPdfPage } from './pdf.mjs';
import { compareRegion } from './visual.mjs';

export function compareTextPages(
  left,
  right,
  startPage = 1,
  endPage = Math.max(left.length, right.length),
) {
  const differences = [];
  for (let number = startPage; number <= endPage; number++) {
    const a = left[number - 1],
      b = right[number - 1];
    if (!a && !b) break;
    const status = !a
      ? 'added'
      : !b
        ? 'removed'
        : a.text === b.text
          ? 'text-unchanged'
          : 'text-changed';
    const dimensionsEqual =
      !!a && !!b && Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01;
    let at = 0;
    if (a && b)
      while (at < Math.min(a.text.length, b.text.length) && a.text[at] === b.text[at]) at++;
    differences.push({
      page: number,
      status,
      dimensionsEqual,
      leftCharacters: a?.text.length ?? 0,
      rightCharacters: b?.text.length ?? 0,
      ...(status === 'text-changed'
        ? {
            firstDifferentOffset: at,
            before: a.text.slice(Math.max(0, at - 80), at + 240),
            after: b.text.slice(Math.max(0, at - 80), at + 240),
          }
        : {}),
    });
  }
  return differences;
}
export class RecoveryController {
  constructor(adapter) {
    this.a = adapter;
    this.directory = path.join(adapter.config.directory, 'snapshots');
  }
  async create({ itemPath, title, operationId }, options) {
    return mutate(
      this.a,
      operationId,
      { action: 'native-snapshot', itemPath, title },
      async (mark) => {
        const original = await this.a.openItem({ itemPath }),
          originalPages = await this.a.pages.list({ url: original.url });
        const sourceExport = await this.a.documents.exportPdf({ url: original.url }, options);
        mark();
        const copy = await this.a.library.manage(
          {
            action: 'duplicate',
            itemPath,
            title,
            operationId: 'snapshot-' + digest(operationId).slice(0, 60),
          },
          options,
        );
        const copiedPages = await this.a.pages.list({ url: copy.url });
        if (copiedPages.count !== originalPages.count)
          throw new GoodnotesError(
            'SAVE_UNVERIFIED',
            'Native snapshot page count differs from the source.',
          );
        const baseline = await this.a.documents.exportPdf({ url: copy.url }, options);
        await this.assertSameContents(sourceExport.exportId, baseline.exportId, options);
        const snapshotId = crypto.randomUUID(),
          record = {
            snapshotId,
            createdAt: new Date().toISOString(),
            baselineExportId: baseline.exportId,
            original: {
              url: original.url,
              title: original.title,
              itemPath,
              pageCount: originalPages.count,
              orderHash: originalPages.orderHash,
            },
            copy: {
              url: copy.url,
              title: copy.title,
              itemPath: copy.itemPath,
              pageCount: copiedPages.count,
              orderHash: copiedPages.orderHash,
            },
          };
        await writeJson(uuidFile(this.directory, snapshotId), record);
        return {
          verified: true,
          verification: 'native-duplicate-page-count-text-and-rendered-appearance',
          ...record,
          url: copy.url,
          itemPath: copy.itemPath,
          note: 'Independent native Goodnotes copy in the same library folder, with a private PDF baseline. Keep it unchanged. Visual verification uses 1000px page renders and does not check hidden metadata or every editable property.',
        };
      },
      options,
    );
  }
  async get(snapshotId) {
    const record = await readJson(uuidFile(this.directory, snapshotId), null);
    if (!record) throw new GoodnotesError('SNAPSHOT_NOT_FOUND', 'Native snapshot not found.');
    return record;
  }
  async restore({ snapshotId, title, operationId }, options) {
    return mutate(
      this.a,
      operationId,
      { action: 'restore-snapshot-copy', snapshotId, title },
      async (mark) => {
        const record = await this.get(snapshotId),
          current = await this.a.pages.list({ url: record.copy.url });
        if (
          current.title !== record.copy.title ||
          current.count !== record.copy.pageCount ||
          current.orderHash !== record.copy.orderHash
        )
          throw new GoodnotesError(
            'SNAPSHOT_CHANGED',
            'Snapshot title or page identities changed. Inspect it before restoring.',
          );
        if (!record.baselineExportId)
          throw new GoodnotesError(
            'SNAPSHOT_BASELINE_MISSING',
            'This older snapshot has no content baseline. Create a new verified snapshot before using guarded restore.',
          );
        const currentExport = await this.a.documents.exportPdf({ url: record.copy.url }, options);
        await this.assertSameContents(record.baselineExportId, currentExport.exportId, options);
        mark();
        const copy = await this.a.library.manage(
          {
            action: 'duplicate',
            itemPath: record.copy.itemPath,
            title,
            operationId: 'restore-' + digest(operationId).slice(0, 60),
          },
          options,
        );
        const after = await this.a.pages.list({ url: copy.url });
        if (after.count !== record.copy.pageCount)
          throw new GoodnotesError('SAVE_UNVERIFIED', 'Restored copy has a different page count.');
        const restoredExport = await this.a.documents.exportPdf({ url: copy.url }, options);
        await this.assertSameContents(record.baselineExportId, restoredExport.exportId, options);
        return {
          verified: true,
          verification: 'independent-native-restored-copy-with-content-baseline',
          snapshotId,
          url: copy.url,
          title: copy.title,
          itemPath: copy.itemPath,
          pageCount: after.count,
          note: 'Restored into a NEW document. Original and snapshot remain intact. Compared extracted text and 1000px rendered page appearance; hidden metadata and every editable property are not covered.',
        };
      },
      options,
    );
  }
  async verifyRestore({ snapshotId, restoreOperationId }, options) {
    const record = await this.get(snapshotId),
      receipt = await this.a.journal.get(restoreOperationId),
      child = await this.a.journal.get('restore-' + digest(restoreOperationId).slice(0, 60));
    if (
      !['uncertain', 'verified'].includes(receipt.status) ||
      child.status !== 'verified' ||
      !child.result?.url
    )
      throw new GoodnotesError(
        'RECOVERY_NOT_IDENTIFIED',
        'No verified native copy receipt identifies this restore. Inspect the library manually; do not repeat the write.',
      );
    if (!record.baselineExportId)
      throw new GoodnotesError(
        'SNAPSHOT_BASELINE_MISSING',
        'The snapshot has no saved content baseline.',
      );
    // Bind the operation to this exact snapshot; a caller cannot verify a different restore by ID.
    if (
      receipt.fingerprint !==
      digest({ action: 'restore-snapshot-copy', snapshotId, title: child.result.title })
    )
      throw new GoodnotesError(
        'RECOVERY_MISMATCH',
        'This operation receipt is not bound to the requested snapshot and restored title.',
      );
    const current = await this.a.pages.list({ url: child.result.url });
    if (current.title !== child.result.title || current.count !== record.copy.pageCount)
      throw new GoodnotesError(
        'RESTORED_COPY_CHANGED',
        'Restored title or page count differs from the native copy receipt.',
      );
    const exported = await this.a.documents.exportPdf({ url: current.url }, options);
    await this.assertSameContents(record.baselineExportId, exported.exportId, options);
    return {
      verified: true,
      verification: 'independent-read-only-restore-content-check',
      restoreOperationId,
      originalReceiptStatus: receipt.status,
      snapshotId,
      url: current.url,
      title: current.title,
      itemPath: child.result.itemPath,
      pageCount: current.count,
      note: 'Existing restored copy verified without another write. Original operation receipt remains unchanged.',
    };
  }
  async assertSameContents(leftExportId, rightExportId, options = {}) {
    let startPage = 1;
    do {
      checkCancellation(options.signal);
      const result = await this.compare(
        { leftExportId, rightExportId, startPage, maxPages: 10, visual: true },
        options,
      );
      if (
        result.leftPages !== result.rightPages ||
        result.pages.some(
          (p) => p.status !== 'text-unchanged' || !p.dimensionsEqual || !p.visualEqual,
        )
      )
        throw new GoodnotesError(
          'SNAPSHOT_CONTENT_CHANGED',
          'Exported page text, dimensions or rendered appearance differ from the saved baseline. No restore is safe without inspection.',
        );
      startPage = result.nextPage;
    } while (startPage);
  }
  async compare(
    { leftExportId, rightExportId, startPage = 1, maxPages = 10, visual = false },
    options = {},
  ) {
    const left = await this.a.documents.get(leftExportId),
      right = await this.a.documents.get(rightExportId),
      total = Math.max(left.index.pageCount, right.index.pageCount);
    if (startPage > total)
      throw new GoodnotesError('INVALID_PAGE', 'Start page is outside both exports.');
    const end = Math.min(total, startPage + maxPages - 1),
      pages = compareTextPages(left.index.pages, right.index.pages, startPage, end);
    if (visual)
      for (const result of pages) {
        checkCancellation(options.signal);
        if (!['text-changed', 'text-unchanged'].includes(result.status)) continue;
        if (!result.dimensionsEqual) {
          result.visualEqual = false;
          continue;
        }
        const a = await renderPdfPage(left.record.path, result.page, { maxDimension: 1000 }),
          b = await renderPdfPage(right.record.path, result.page, { maxDimension: 1000 });
        const comparison = await compareRegion(a.bytes, b.bytes, {
          x: 0,
          y: 0,
          width: a.width,
          height: a.height,
        });
        result.visualEqual = comparison.matches;
        result.changedPixels = comparison.missingPixels + comparison.addedPixels;
      }
    return {
      leftExportId,
      rightExportId,
      leftPages: left.index.pageCount,
      rightPages: right.index.pageCount,
      pages,
      nextPage: end < total ? end + 1 : null,
      visualCompared: visual,
      note: 'Page-position comparison of saved exports. Equal extracted text alone does not prove equal handwriting, color or images; use visual comparison for those. No document is changed.',
    };
  }
}
