import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { readJson, writeJson, uuidFile } from './store.mjs';
import { digest } from './journal.mjs';
import { requireWritable } from './mutations.mjs';
import {
  makeStudyCard,
  sourceCardBody,
  studySectionSchema,
  planStudyLayout,
  renderStudyPreview,
  auditStudyGeometry,
} from './study-layout.mjs';
import { renderPdfPage } from './pdf.mjs';
import { StudyRevisionNative } from './study-revision-native.mjs';

const blockId = z.string().min(1).max(100);
export const studyRevisionChangesSchema = z
  .object({
    updates: z
      .array(
        z
          .object({
            blockId,
            heading: z.string().trim().min(1).max(90),
            body: z.string().trim().min(1).max(1800),
            pages: z.array(z.number().int().min(1).max(2000)).min(1).max(12),
          })
          .strict(),
      )
      .max(24)
      .default([]),
    moves: z
      .array(
        z
          .object({ blockId, x: z.number().min(56).max(12000), y: z.number().min(80).max(12000) })
          .strict(),
      )
      .max(24)
      .default([]),
    addition: studySectionSchema.optional(),
    appendY: z.number().int().min(80).max(12000).optional(),
    sourceExportId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (c) => c.updates.length + c.moves.length > 0 || c.addition,
    'Choose at least one change.',
  );

export function planStudyRevision(base, changes, source, additionPlan, revisionId) {
  const c = studyRevisionChangesSchema.parse(changes),
    entries = structuredClone(base.blocks),
    steps = [];
  const touched = [...c.updates, ...c.moves].map((x) => x.blockId);
  if (new Set(touched).size !== touched.length)
    throw new GoodnotesError('DUPLICATE_UPDATE', 'Change a block only once per revision.');
  const get = (id) => {
    const e = entries.find((e) => e.block.id === id);
    if (!e)
      throw new GoodnotesError('UNKNOWN_BLOCK', 'Choose an existing managed block ID.', {
        blockId: id,
      });
    return e;
  };
  const audit = () => {
    const result = auditStudyGeometry(
      entries.map((e) => e.block),
      { width: base.plan.width ?? 1400, gap: base.board.adopted ? 8 : 24 },
    );
    if (!result.valid)
      throw new GoodnotesError(
        'LAYOUT_CONFLICT',
        'The revision overlaps another managed block or leaves the board.',
        result,
      );
  };
  for (const u of c.updates) {
    const e = get(u.blockId),
      b = e.block;
    if (b.kind !== 'text' || !['summary', 'concept', 'questions', 'answers'].includes(b.role))
      throw new GoodnotesError('UNSUPPORTED_BLOCK', 'Text updates target learning cards.');
    if (u.pages.some((p) => p > source.pageCount))
      throw new GoodnotesError('INVALID_SOURCE_PAGE', 'A citation exceeds the chosen source.');
    const next = makeStudyCard(
      b.id,
      b.role,
      u.heading,
      sourceCardBody(u),
      b.x,
      b.y,
      b.width,
      b.fontSize,
      b.headingSize,
    );
    if (next.height > b.height)
      throw new GoodnotesError(
        'REVISION_CARD_TOO_TALL',
        'This update would grow beyond its reserved card. Shorten it or add a separate card.',
        { blockId: b.id, height: next.height, reserved: b.height },
      );
    next.height = b.height;
    next.backgroundColor = b.backgroundColor;
    next.sourcePages = [...new Set(u.pages)];
    next.sourceExportId = source.exportId;
    if (next.text === b.text) continue;
    steps.push({
      kind: 'edit',
      id: b.id,
      before: b,
      after: next,
      checkpointPath: e.checkpointPath,
    });
    e.block = next;
  }
  for (const move of c.moves) {
    const e = get(move.blockId),
      b = e.block;
    if (move.x === b.x && move.y === b.y) continue;
    if (Math.abs(move.y - b.y) + b.height > 700 || Math.abs(move.x - b.x) + b.width > 1288)
      throw new GoodnotesError(
        'MOVE_TOO_FAR',
        'Move must fit in one guarded viewport. Use smaller revisions.',
      );
    const next = { ...b, x: move.x, y: move.y };
    steps.push({
      kind: 'move',
      id: b.id,
      before: b,
      after: next,
      checkpointPath: e.checkpointPath,
    });
    e.block = next;
    audit(); // Also rejects swaps through an occupied intermediate position.
  }
  if (additionPlan) {
    const minimum =
      Math.max(base.plan.height, ...entries.map((e) => e.block.y + e.block.height)) + 64;
    const start = c.appendY ?? minimum;
    if (start < minimum)
      throw new GoodnotesError(
        'ADDITION_TOO_CLOSE',
        'New sections start below existing managed content.',
        { minimumY: minimum },
      );
    for (const b of additionPlan.blocks) {
      const next = {
        ...b,
        id: 'add-' + revisionId.slice(0, 8) + '-' + b.id,
        y: start + b.y - 80,
        sourceExportId: source.exportId,
      };
      entries.push({ block: next });
      steps.push({ kind: 'add', id: next.id, after: next });
    }
  }
  audit();
  if (!steps.length)
    throw new GoodnotesError(
      'EMPTY_REVISION',
      'All requested changes already match the saved plan.',
    );
  const height = Math.max(...entries.map((e) => e.block.y + e.block.height)) + 64;
  if (height > 12000)
    throw new GoodnotesError('LAYOUT_TOO_LARGE', 'Use a separate board for this section.');
  return {
    schema: 1,
    width: base.plan.width ?? 1400,
    ...(base.board.adopted ? { scaledPreview: true } : {}),
    height,
    blocks: entries.map((e) => e.block),
    entries,
    steps,
    source: {
      exportId: source.exportId,
      title: source.title,
      pageCount: source.pageCount,
      sha256: source.sha256,
    },
  };
}

export function sourceImpact(previous, next, blocks) {
  const changedPages = [];
  for (let i = 0; i < Math.max(previous.pages.length, next.pages.length); i++) {
    const a = previous.pages[i],
      b = next.pages[i];
    if (!a || !b || a.text !== b.text || a.width !== b.width || a.height !== b.height)
      changedPages.push(i + 1);
  }
  const shifted = previous.pages.length !== next.pages.length;
  return {
    changedPages,
    pageCountChanged: shifted,
    affectedBlocks: blocks
      .filter(
        (e) =>
          shifted ||
          (e.block.sourcePages ?? [e.block.sourcePage]).some((p) => changedPages.includes(p)),
      )
      .map((e) => e.block.id),
    visualReviewRequired: true,
    note: 'Text/page-position comparison only. Changed diagrams with identical text can be missed; inspect source images. Page insertion/removal flags every managed block.',
  };
}

export class StudyRevisionController {
  constructor(a) {
    this.a = a;
    this.directory = path.join(a.config.directory, 'study-revisions');
    this.native = new StudyRevisionNative(a);
  }
  async get(id) {
    const j = await readJson(uuidFile(this.directory, id), null);
    if (!j) throw new GoodnotesError('REVISION_NOT_FOUND', 'Unknown study revision.');
    return j;
  }
  save(j) {
    return writeJson(uuidFile(this.directory, j.revisionId), j);
  }
  async base(id) {
    const prior = await readJson(uuidFile(this.directory, id), null);
    if (prior) {
      if (prior.status !== 'completed')
        throw new GoodnotesError(
          'BASE_NOT_COMPLETE',
          'Finish or review the preceding revision first.',
        );
      return prior.manifest;
    }
    const j = await this.a.study.get(id);
    if (j.status !== 'completed' || digest(j.plan) !== j.planHash)
      throw new GoodnotesError(
        'BASE_NOT_COMPLETE',
        'Use an intact completed learning-board workflow.',
      );
    return {
      board: j.board,
      source: j.source,
      plan: j.plan,
      blocks: j.plan.blocks.map((b) => {
        const result = j.steps.find((s) => s.id === b.id)?.result;
        if (!result?.checkpointPath)
          throw new GoodnotesError(
            'NO_VERIFICATION_CHECKPOINT',
            'Managed block evidence is incomplete.',
          );
        const index = /^card-(\d+)$/.exec(b.id)?.[1];
        return {
          block: {
            ...b,
            sourceExportId: b.sourceExportId ?? j.source.exportId,
            sourcePages:
              b.sourcePages ??
              (index !== undefined ? j.materials.cards[Number(index)].pages : undefined),
          },
          checkpointPath: result.checkpointPath,
          layout: result.layout,
        };
      }),
    };
  }
  async prepare({ baseId, title, copy = true, requestId, itemPath }, options = {}, suppliedBase) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId))
      throw new GoodnotesError('INVALID_REQUEST_ID', 'Use a stable request ID.');
    const file = path.join(this.directory, 'requests', requestId + '.json'),
      input = { baseId, title, copy, ...(itemPath ? { itemPath } : {}) };
    let binding = await readJson(file, null),
      j;
    if (binding) {
      if (binding.inputHash !== digest(input))
        throw new GoodnotesError('REQUEST_CONFLICT', 'This request belongs to another revision.');
      j = await this.get(binding.revisionId);
    } else {
      const base = suppliedBase ?? (await this.base(baseId));
      j = {
        revisionId: crypto.randomUUID(),
        input,
        base,
        status: 'preparing',
        startedAt: new Date().toISOString(),
        steps: [],
        timings: [],
      };
      await this.save(j);
      await writeJson(file, { revisionId: j.revisionId, inputHash: digest(input) });
    }
    if (j.board) return this.status({ revisionId: j.revisionId });
    const a = this.a,
      op = 'revision-' + j.revisionId + '-copy' + (j.copyAttempt ? '-' + j.copyAttempt : '');
    if (!j.copy) {
      const receipt = await a.journal.get(op);
      if (receipt.status === 'verified') j.copy = receipt.result;
      else {
        if (
          receipt.status === 'rejected' &&
          receipt.result?.mayHaveWritten === false &&
          (j.copyAttempt ?? 0) < 2
        ) {
          j.copyHistory ??= [];
          j.copyHistory.push({
            operationId: op,
            status: receipt.status,
            reason: receipt.result.code,
          });
          j.copyAttempt = (j.copyAttempt ?? 0) + 1;
          j.copyDispatched = false;
          await this.save(j);
          return this.prepare({ baseId, title, copy, requestId, itemPath }, options, suppliedBase);
        }
        if (receipt.status !== 'not-found' || j.copyDispatched)
          throw new GoodnotesError(
            'REVIEW_REQUIRED',
            'An unconfirmed revision copy must be inspected; it will not be repeated.',
            { operationId: op },
          );
        const sourcePath = itemPath ?? j.base.board.itemPath;
        let current;
        try {
          current = await a.openItem({ itemPath: sourcePath });
        } catch (error) {
          if (error.code !== 'ITEM_NOT_FOUND') throw error;
          const { page, listing } = await a.library.folder(sourcePath.slice(0, -1));
          if (!listing.items.some((x) => x.id === sourcePath.at(-1)))
            throw new GoodnotesError(
              'BOARD_PATH_CHANGED',
              'The saved board is absent from this folder. Locate its current itemPath; the URL and title must still match.',
              { url: j.base.board.url, title: j.base.board.title },
            );
          await a.enterItem(page, sourcePath.at(-1), false);
          await a.settledDocumentUrl(page);
          current = await a.inspect({ url: page.url() });
        }
        if (current.url !== j.base.board.url || current.title !== j.base.board.title)
          throw new GoodnotesError(
            'BOARD_CHANGED',
            'The original board identity or title changed.',
          );
        if (!copy) requireWritable(a, current);
        j.baseline = await a.documents.exportPdf({ url: current.url }, options);
        await this.save(j);
        j.copyDispatched = true;
        await this.save(j);
        const at = Date.now();
        j.copy = await a.library.manage(
          { action: 'duplicate', itemPath: sourcePath, title, operationId: op },
          options,
        );
        j.timings.push({ stage: 'native-copy', ms: Date.now() - at });
      }
      await this.save(j);
    }
    const copiedExport = await a.documents.exportPdf({ url: j.copy.url }, options);
    await a.recovery.assertSameContents(j.baseline.exportId, copiedExport.exportId, options);
    j.backup = copy
      ? { url: j.base.board.url, exportId: j.baseline.exportId }
      : { ...j.copy, exportId: copiedExport.exportId };
    const target = copy ? j.copy : j.base.board;
    const view = await a.inspect({ url: target.url }),
      anchor = await a.scans.anchor(await a.getPage());
    if (view.title !== target.title)
      throw new GoodnotesError('BOARD_CHANGED', 'Target title changed.');
    // A duplicate keeps native object coordinates but receives a new page ID.
    // Every changed block must independently match its old content/appearance.
    j.board = {
      ...j.base.board,
      url: target.url,
      title: target.title,
      itemPath: target.itemPath,
      anchor: { ...j.base.board.anchor, pageId: anchor.pageId },
    };
    j.source = j.base.source;
    j.status = 'ready-to-plan';
    j.preparedAt = new Date().toISOString();
    await this.save(j);
    return this.status({ revisionId: j.revisionId });
  }
  async plan({ revisionId, changes }) {
    const j = await this.get(revisionId);
    if (!j.board)
      throw new GoodnotesError('REVISION_NOT_READY', 'Prepare the revision copy first.');
    if (j.steps.some((s) => s.status !== 'pending'))
      throw new GoodnotesError('PLAN_ALREADY_STARTED', 'A dispatched revision plan cannot change.');
    const c = studyRevisionChangesSchema.parse(changes),
      dir = path.join(this.directory, revisionId);
    await fs.mkdir(dir, { recursive: true });
    let source = j.base.source,
      impact;
    if (c.sourceExportId) {
      const old = await this.a.documents.get(j.base.source.exportId),
        next = await this.a.documents.get(c.sourceExportId);
      source = next.record;
      impact = sourceImpact(old.index, next.index, j.base.blocks);
    }
    let addition;
    if (c.addition) {
      const figures = await this.a.study.renderFigures(c.addition, source, dir);
      addition = planStudyLayout(c.addition, source, figures, { partial: true });
    }
    const plan = planStudyRevision(j.base, c, source, addition, revisionId),
      planHash = digest(plan);
    const previewPath = path.join(dir, 'preview.png');
    await fs.writeFile(previewPath, await renderStudyPreview(plan));
    j.source = source;
    j.sourceImpact = impact;
    j.plan = plan;
    j.planHash = planHash;
    j.board.planHash = planHash;
    j.previewPath = previewPath;
    j.steps = [
      ...plan.steps.map((s, i) => ({
        ...s,
        status: 'pending',
        operationId: 'revision-' + revisionId + '-' + i,
      })),
      {
        id: 'audit',
        kind: 'audit',
        status: 'pending',
        operationId: 'revision-' + revisionId + '-audit',
      },
    ];
    j.status = 'planned';
    j.plannedAt = new Date().toISOString();
    await this.save(j);
    return this.status({ revisionId });
  }
  assertPlan(j) {
    if (!j.plan || digest(j.plan) !== j.planHash || j.board.planHash !== j.planHash)
      throw new GoodnotesError('PLAN_CHANGED', 'The frozen revision plan was changed.');
  }
  accept(j, s, result) {
    s.result = result;
    s.status = 'verified';
  }
  async run({ revisionId }, options = {}) {
    const j = await this.get(revisionId);
    this.assertPlan(j);
    checkCancellation(options.signal);
    const s = j.steps.find((s) => !['verified', 'reconciled'].includes(s.status));
    if (!s) {
      j.status = 'completed';
      j.finishedAt ??= new Date().toISOString();
      await this.save(j);
      return this.status({ revisionId });
    }
    if (s.kind !== 'audit') {
      const receipt = await this.a.journal.get(s.operationId);
      if (receipt.status === 'verified') this.accept(j, s, receipt.result);
      else if (receipt.status !== 'not-found' || s.status !== 'pending') {
        s.status = 'blocked';
        j.status = 'needs-review';
        await this.save(j);
        return this.status({ revisionId });
      }
    }
    if (s.status !== 'verified') {
      s.status = 'running';
      j.status = 'running';
      await this.save(j);
      const at = Date.now();
      try {
        const result =
          s.kind === 'audit'
            ? await this.audit(j, options)
            : await this.native.apply(
                j.board,
                j.plan.steps.find((x) => x.id === s.id),
                s.operationId,
                options,
              );
        this.accept(j, s, result);
        s.ms = Date.now() - at;
        j.timings.push({ stage: s.id, ms: s.ms });
      } catch (e) {
        s.status = 'blocked';
        s.error = { code: e.code ?? 'ACTION_FAILED', message: e.message, details: e.details };
        j.status = 'needs-review';
        await this.save(j);
        return this.status({ revisionId });
      }
    }
    if (j.steps.every((s) => ['verified', 'reconciled'].includes(s.status))) {
      j.status = 'completed';
      j.finishedAt ??= new Date().toISOString();
    } else j.status = 'ready';
    await this.save(j);
    return this.status({ revisionId });
  }
  async audit(j, options = {}) {
    const blocks = j.plan.entries.map((e) => {
      const step = j.steps.find((s) => s.id === e.block.id && s.kind !== 'audit');
      return step
        ? { ...e, checkpointPath: step.result.checkpointPath, layout: step.result.layout }
        : e;
    });
    const geometry = auditStudyGeometry(
      blocks.map((e) => ({ id: e.block.id, ...e.layout })),
      { width: j.plan.width, gap: j.board.adopted ? 8 : 18 },
    );
    if (!geometry.valid)
      throw new GoodnotesError(
        'NATIVE_LAYOUT_CONFLICT',
        'Actual revised block geometry is inconsistent.',
        geometry,
      );
    const exported = await this.a.documents.exportPdf({ url: j.board.url }, options);
    if (exported.pageCount !== 1)
      throw new GoodnotesError('BOARD_EXPORT_CHANGED', 'Expected one infinite-board export.');
    const rendered = await renderPdfPage(exported.path, 1, { maxDimension: 2800 }),
      previewPath = path.join(this.directory, j.revisionId, 'actual-board.png');
    await fs.writeFile(previewPath, rendered.bytes);
    j.manifest = {
      board: j.board,
      source: j.source,
      plan: {
        width: j.plan.width,
        height: j.plan.height,
        blocks: j.plan.blocks,
        ...(j.plan.scaledPreview ? { scaledPreview: true } : {}),
      },
      blocks,
    };
    return {
      verified: true,
      geometry,
      export: exported,
      previewPath,
      note: 'Selected changes passed reload and visible surroundings checks. Other managed blocks retain prior checkpoints; this is not an exhaustive current audit of remote edits or iPad sync.',
    };
  }
  async review({ revisionId }, options = {}) {
    const j = await this.get(revisionId);
    this.assertPlan(j);
    const s = j.steps.find((s) => ['running', 'blocked'].includes(s.status));
    if (!s) return this.status({ revisionId });
    if (s.kind === 'audit') {
      s.status = 'pending';
    } else {
      const receipt = await this.a.journal.get(s.operationId);
      if (receipt.status === 'verified') this.accept(j, s, receipt.result);
      else if (
        receipt.status === 'rejected' &&
        receipt.result?.mayHaveWritten === false &&
        (s.attempt ?? 0) < 2
      ) {
        s.previousAttempts ??= [];
        s.previousAttempts.push({
          operationId: s.operationId,
          status: receipt.status,
          reason: receipt.result.code,
        });
        s.attempt = (s.attempt ?? 0) + 1;
        s.operationId = s.previousAttempts[0].operationId + '-r' + s.attempt;
        s.status = 'pending';
      } else {
        s.result = await this.native.verify(
          j.board,
          j.plan.steps.find((x) => x.id === s.id),
          s.operationId,
          options,
        );
        s.status = 'reconciled';
        s.priorReceiptStatus = receipt.status;
      }
    }
    delete s.error;
    j.status = 'ready';
    await this.save(j);
    return this.status({ revisionId });
  }
  async status({ revisionId, includeContent = false }) {
    const j = await this.get(revisionId),
      audit = j.steps.find((s) => s.kind === 'audit' && s.status === 'verified');
    const entries = j.plan?.entries ?? j.base.blocks;
    return {
      revisionId,
      status: j.status,
      baseId: j.input.baseId,
      board: j.board && { url: j.board.url, title: j.board.title, itemPath: j.board.itemPath },
      backup: j.backup,
      source: {
        exportId: j.source?.exportId ?? j.base.source.exportId,
        title: j.source?.title ?? j.base.source.title,
        pageCount: j.source?.pageCount ?? j.base.source.pageCount,
      },
      sourceImpact: j.sourceImpact,
      previewPath: audit?.result?.previewPath ?? j.previewPath,
      planPreviewPath: j.previewPath,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      elapsedMs: Date.parse(j.finishedAt ?? new Date().toISOString()) - Date.parse(j.startedAt),
      timings: j.timings,
      planHash: j.planHash,
      blocks: entries.map(({ block: b }) => ({
        id: b.id,
        kind: b.kind,
        heading: b.headingLines?.join(' '),
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        sourcePages: b.sourcePages ?? [b.sourcePage].filter(Boolean),
        sourceExportId: b.sourceExportId,
        ...(includeContent ? { text: b.text, sourceCrop: b.sourceCrop } : {}),
      })),
      steps: j.steps.map((s) => ({
        id: s.id,
        kind: s.kind,
        status: s.status,
        ms: s.ms,
        error: s.error,
        ...(s.kind === 'audit' ? { result: s.result } : {}),
      })),
      note: 'Only selected managed blocks are changed. The local plan preview does not display unmanaged personal notes; inspect the full native export too. Changed managed blocks and occupied destinations stop before overwriting.',
    };
  }
}
