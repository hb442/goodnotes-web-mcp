import fs from 'node:fs/promises';
import path from 'node:path';
import { mutate, requireWritable } from './mutations.mjs';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { digest } from './journal.mjs';
import { readJson, writeJson } from './store.mjs';
import { waitForMappedRegion } from './visual.mjs';
import { worldBox, screenBox } from './board-scan.mjs';
import { sameCrop } from './image-crop.mjs';

export function moveChildIds(operationId) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(operationId))
    throw new GoodnotesError('INVALID_OPERATION_ID', 'Use a valid move operation ID.');
  const id = digest(operationId).slice(0, 40);
  return { copyOperationId: 'move-copy-' + id, deleteOperationId: 'move-delete-' + id };
}
export class ObjectMoveController {
  constructor(a) {
    this.a = a;
    this.directory = path.join(a.config.directory, 'move-checkpoints');
  }
  file(id) {
    moveChildIds(id);
    return path.join(this.directory, id + '.json');
  }
  async recheckSource(record, original, options) {
    const a = this.a,
      copyReceipt = await a.journal.get(record.copyOperationId),
      copied = await readJson(
        path.join(a.config.directory, 'copy-checkpoints', record.copyOperationId + '.json'),
        null,
      );
    if (
      !copied ||
      copied.operationId !== record.copyOperationId ||
      copied.fingerprint !== copyReceipt.fingerprint ||
      copyReceipt.status !== 'verified'
    )
      throw new GoodnotesError(
        'COPY_CHECKPOINT_REQUIRED',
        'A verified matching copy checkpoint is required before source deletion.',
      );
    if (copied.kind === 'image') {
      const current = await a.imageCrop.prepare({ selectionId: original.selectionId });
      if (
        !copied.image ||
        current.sourceSha256 !== copied.image.sourceSha256 ||
        current.sourceSize.width !== copied.image.sourceSize.width ||
        current.sourceSize.height !== copied.image.sourceSize.height ||
        !sameCrop(current.region, copied.image.region, current.sourceSize)
      )
        throw new GoodnotesError(
          'SOURCE_CONTENT_CHANGED',
          'The original image changed after copying; it was not removed.',
        );
    } else if (['text-box', 'sticky'].includes(copied.kind)) {
      const view = a.getView(original.viewId),
        b = original.bounds,
        current = await a.readText({
          viewId: original.viewId,
          expectedKind: copied.kind,
          x: (b.x + Math.min(25, b.width / 3) - view.canvas.x) / view.canvas.width,
          y: (b.y + Math.min(25, b.height / 3) - view.canvas.y) / view.canvas.height,
        });
      if (
        current.kind !== copied.kind ||
        digest(current.text) !== copied.textHash ||
        digest(current.formatting) !== copied.styleHash
      )
        throw new GoodnotesError(
          'SOURCE_CONTENT_CHANGED',
          'The original text, kind or formatting changed after copying; it was not removed.',
        );
    } else
      throw new GoodnotesError('COPY_CHECKPOINT_REQUIRED', 'The native copy kind is unsupported.');
    checkCancellation(options?.signal);
    return a.scans.recall({ objectId: record.objectId }, options);
  }
  async move(
    { sourceUrl, target, content, destinationPath, destinationPage = 1, x, y, operationId },
    options = {},
  ) {
    if (!['text', 'image'].includes(content?.kind))
      throw new GoodnotesError('INVALID_OBJECT_KIND', 'Move one text box/sticky or native image.');
    const a = this.a,
      children = moveChildIds(operationId),
      signature =
        content.kind === 'text'
          ? { kind: 'text', expectedTextHash: digest(content.expectedText) }
          : content;
    return mutate(
      a,
      operationId,
      {
        action: 'move-native-board-object',
        sourceUrl,
        target,
        content: signature,
        destinationPath,
        destinationPage,
        x,
        y,
      },
      async (mark) => {
        let record;
        try {
          const sourceView = await a.inspect({ url: sourceUrl });
          requireWritable(a, sourceView);
          const sourceTarget = await a.jobs.target(
              sourceView,
              content.kind === 'text' ? { ...target, expectedText: content.expectedText } : target,
              true,
              options,
            ),
            selected = await a.styles.selection(sourceTarget.selectionId),
            bookmark = await a.scans.remember({
              selectionId: sourceTarget.selectionId,
              label: 'Native move original',
            });
          const backup = await a.documents.exportPdf({ url: selected.view.url }, options);
          if (backup.url !== selected.view.url || backup.title !== selected.view.title)
            throw new GoodnotesError(
              'BACKUP_UNVERIFIED',
              'The move backup belongs to a different source document.',
            );
          const destination = await a.openItem({ itemPath: destinationPath });
          requireWritable(a, destination);
          if (destination.url === selected.view.url)
            throw new GoodnotesError(
              'SAME_DOCUMENT',
              'Use the normal object transform to move inside one document.',
            );
          const receipt = await a.journal.get(operationId);
          record = {
            operationId,
            fingerprint: receipt.fingerprint,
            ...children,
            sourceUrl: selected.view.url,
            sourcePageUrl: selected.view.pageUrl,
            sourceTitle: selected.view.title,
            destinationUrl: destination.url,
            objectId: bookmark.objectId,
            backupExportId: backup.exportId,
            stage: 'prepared',
          };
          await writeJson(this.file(operationId), record);
          checkCancellation(options.signal);
          mark();
          const copyArgs = {
              sourceUrl: selected.view.pageUrl,
              target: { objectId: bookmark.objectId },
              destinationPath,
              destinationPage,
              x,
              y,
              operationId: children.copyOperationId,
            },
            copy =
              content.kind === 'text'
                ? await a.objects.copyNativeText(
                    { ...copyArgs, expectedText: content.expectedText },
                    options,
                  )
                : await a.objects.copyNativeImage(
                    {
                      ...copyArgs,
                      expectedSourceSha256: content.expectedSourceSha256,
                      expectedCrop: content.expectedCrop,
                    },
                    options,
                  );
          if (!copy.verified || copy.url !== destination.url)
            throw new GoodnotesError(
              'COPY_UNVERIFIED',
              'The expected destination copy was not verified; the source was not removed.',
            );
          record.stage = 'copy-verified';
          await writeJson(this.file(operationId), record);
          const recalled = await a.scans.recall({ objectId: bookmark.objectId }, options),
            original = await this.recheckSource(record, recalled, options),
            source = a.getView(original.viewId);
          requireWritable(a, source);
          if (source.url !== record.sourceUrl || source.title !== record.sourceTitle)
            throw new GoodnotesError(
              'SOURCE_CHANGED',
              'The source identity changed after copying.',
            );
          record.deletionAnchor = await a.scans.selectionAnchor(await a.getPage(), original.bounds);
          await writeJson(this.file(operationId), record);
          await a.objects.transform(
            {
              selectionId: original.selectionId,
              action: 'delete',
              operationId: children.deleteOperationId,
            },
            options,
          );
          record.stage = 'source-deleted';
          await writeJson(this.file(operationId), record);
          return await this.verify({ operationId }, { ...options, internal: true });
        } catch (error) {
          throw new GoodnotesError(error.code || 'MOVE_FAILED', error.message, {
            ...error.details,
            ...children,
            stage: record?.stage || 'preflight',
          });
        }
      },
      options,
    );
  }
  async verify({ operationId }, { internal = false, ...options } = {}) {
    const a = this.a,
      children = moveChildIds(operationId),
      record = await readJson(this.file(operationId), null),
      receipt = await a.journal.get(operationId);
    if (
      !record ||
      record.operationId !== operationId ||
      record.fingerprint !== receipt.fingerprint ||
      !['pending', 'uncertain', 'verified'].includes(receipt.status) ||
      record.copyOperationId !== children.copyOperationId ||
      record.deleteOperationId !== children.deleteOperationId
    )
      throw new GoodnotesError(
        'MOVE_CHECKPOINT_REQUIRED',
        'No matching native move checkpoint exists.',
      );
    const copyReceipt = await a.journal.get(children.copyOperationId),
      deleted = await a.journal.get(children.deleteOperationId);
    if (
      copyReceipt.status !== 'verified' ||
      deleted.status !== 'verified' ||
      !record.deletionAnchor ||
      !deleted.result?.region
    )
      throw new GoodnotesError(
        'MOVE_INCOMPLETE',
        'The copy and source deletion have not both been verified. Do not repeat the move.',
        {
          ...children,
          stage: record.stage,
          copyStatus: copyReceipt.status,
          deleteStatus: deleted.status,
        },
      );
    requireWritable(a, { url: record.sourceUrl, title: record.sourceTitle });
    const { view, anchor, page } = await a.scans.position(
      record.sourcePageUrl,
      record.deletionAnchor,
      options,
    );
    if (view.url !== record.sourceUrl || view.title !== record.sourceTitle)
      throw new GoodnotesError('SOURCE_CHANGED', 'The original source identity changed.');
    const region = deleted.result.region,
      mapped = screenBox(worldBox(region, record.deletionAnchor), anchor);
    if (
      mapped.x < 0 ||
      mapped.y < 0 ||
      mapped.x + mapped.width > view.viewport.width ||
      mapped.y + mapped.height > view.viewport.height
    )
      throw new GoodnotesError(
        'MOVE_REGION_UNAVAILABLE',
        'The saved source deletion region is not fully visible.',
      );
    const expected = await fs.readFile(
        path.join(a.config.directory, 'evidence', children.deleteOperationId + '-after.png'),
      ),
      { comparison: appearance } = await waitForMappedRegion(
        page,
        expected,
        region,
        mapped,
        options,
      );
    if (!appearance.matches)
      throw new GoodnotesError(
        'MOVE_SOURCE_CHANGED',
        'The original source region no longer matches the verified deletion.',
      );
    const copied = await a.objects.verifyCopiedText(
      { operationId: children.copyOperationId },
      options,
    );
    if (copied.url !== record.destinationUrl)
      throw new GoodnotesError(
        'MOVE_DESTINATION_CHANGED',
        'The copy checkpoint names a different destination.',
      );
    return {
      verified: true,
      verification: 'native-copy-preserved-and-source-deletion-rechecked',
      ...children,
      sourceUrl: record.sourceUrl,
      url: copied.url,
      kind: copied.kind,
      selectionId: copied.selectionId,
      viewId: copied.viewId,
      backupExportId: record.backupExportId,
      sourceAppearance: appearance,
      ...(internal ? {} : { operationId, originalMoveReceiptStatus: receipt.status }),
      note: 'Copy and deletion are separate verified operations, not an atomic move. A failure can leave both copies. This audit never repeats either input or changes old receipts.',
    };
  }
}
