import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { readJson, writeJson, uuidFile } from './store.mjs';
import { digest } from './journal.mjs';
import { renderPdfPage } from './pdf.mjs';
import {
  studyMaterialsSchema,
  planStudyLayout,
  renderStudyPreview,
  auditStudyGeometry,
} from './study-layout.mjs';
import { StudyNativeController } from './study-native.mjs';
import { worldBox } from './board-scan.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
export class StudyBoardController {
  constructor(a) {
    this.a = a;
    this.directory = path.join(a.config.directory, 'study-boards');
    this.native = new StudyNativeController(a);
  }
  async get(id) {
    const j = await readJson(uuidFile(this.directory, id), null);
    if (!j) throw new GoodnotesError('STUDY_NOT_FOUND', 'Unknown study workflow.');
    return j;
  }
  save(j) {
    return writeJson(uuidFile(this.directory, j.workflowId), j);
  }
  async prepare(
    { sourceItemPath, expectedSourceTitle, title, folderPath = [], requestId },
    options = {},
  ) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId))
      throw new GoodnotesError('INVALID_REQUEST_ID', 'Use a stable request ID.');
    const requestFile = path.join(this.directory, 'requests', requestId + '.json'),
      input = { sourceItemPath, expectedSourceTitle, title, folderPath };
    let binding = await readJson(requestFile, null),
      j;
    if (binding) {
      if (binding.inputHash !== digest(input))
        throw new GoodnotesError('REQUEST_CONFLICT', 'Request ID belongs to another workflow.');
      j = await this.get(binding.workflowId);
    } else {
      j = {
        workflowId: crypto.randomUUID(),
        input,
        status: 'preparing',
        startedAt: new Date().toISOString(),
        timings: [],
        steps: [],
      };
      await this.save(j);
      await writeJson(requestFile, { workflowId: j.workflowId, inputHash: digest(input) });
    }
    if (j.source) return this.packet(j);
    const a = this.a,
      op = 'study-' + j.workflowId + '-source';
    if (!j.sourceCopy) {
      const receipt = await a.journal.get(op);
      if (receipt.status === 'verified') j.sourceCopy = receipt.result;
      else {
        if (receipt.status !== 'not-found' || j.copyDispatched)
          throw new GoodnotesError(
            'REVIEW_REQUIRED',
            'Source-copy creation was already dispatched; inspect its receipt before continuing.',
            { operationId: op },
          );
        const original = await a.openItem({ itemPath: sourceItemPath });
        if (original.title !== expectedSourceTitle)
          throw new GoodnotesError(
            'SOURCE_CHANGED',
            'Source title differs from the chosen lecture.',
          );
        j.original = { url: original.url, title: original.title, itemPath: sourceItemPath };
        j.copyDispatched = true;
        await this.save(j);
        const at = Date.now();
        j.sourceCopy = await a.library.manage(
          {
            action: 'duplicate',
            itemPath: sourceItemPath,
            title: ('Quellkopie – ' + title).slice(0, 150),
            operationId: op,
          },
          options,
        );
        j.timings.push({ stage: 'source-copy', ms: Date.now() - at });
      }
      await this.save(j);
    }
    checkCancellation(options.signal);
    const at = Date.now();
    const exported = await a.documents.exportPdf({ url: j.sourceCopy.url }, options),
      { index } = await a.documents.get(exported.exportId);
    j.source = { ...exported, title: expectedSourceTitle, originalUrl: j.original?.url };
    j.timings.push({ stage: 'source-export', ms: Date.now() - at });
    j.status = 'needs-materials';
    j.preparedAt = new Date().toISOString();
    await this.save(j);
    return this.packet(j, index);
  }
  async packet(j, index) {
    index ??= (await this.a.documents.get(j.source.exportId)).index;
    return {
      workflowId: j.workflowId,
      status: j.status,
      sourceCopy: j.sourceCopy,
      source: j.source,
      pages: index.pages.map((p) => ({
        page: p.page,
        characters: p.characters,
        needsVisualReview: p.needsVisualReview,
        excerpt: p.text.slice(0, 220),
      })),
      next: 'Read the copied lecture snapshot, then supply a source-based title, summary/concept cards, questions, answers and original-figure page/crop references to plan_study_board.',
    };
  }
  async plan({ workflowId, materials }) {
    const j = await this.get(workflowId);
    if (!j.source) throw new GoodnotesError('SOURCE_NOT_READY', 'Prepare the lecture copy first.');
    if (j.steps.some((s) => s.status !== 'pending'))
      throw new GoodnotesError(
        'PLAN_ALREADY_STARTED',
        'A dispatched board plan cannot be replaced.',
      );
    const m = studyMaterialsSchema.parse(materials);
    const at = Date.now(),
      dir = path.join(this.directory, workflowId);
    await fs.mkdir(dir, { recursive: true });
    const figures = await this.renderFigures(m, j.source, dir);
    const plan = planStudyLayout(m, j.source, figures),
      planHash = digest(plan),
      previewPath = path.join(dir, 'preview.png');
    await fs.writeFile(previewPath, await renderStudyPreview(plan));
    j.materials = m;
    j.plan = plan;
    j.planHash = planHash;
    j.previewPath = previewPath;
    j.plannedAt = new Date().toISOString();
    j.status = 'planned';
    j.timings.push({ stage: 'layout-plan', ms: Date.now() - at });
    j.steps = [
      { id: 'create', kind: 'create' },
      ...plan.blocks.map((b) => ({ id: b.id, kind: 'block' })),
      { id: 'audit', kind: 'audit' },
    ].map((s, i) => ({
      ...s,
      index: i,
      status: 'pending',
      operationId: 'study-' + workflowId + '-' + i,
    }));
    await this.save(j);
    return {
      workflowId,
      status: j.status,
      previewPath,
      planHash,
      layout: {
        width: plan.width,
        height: plan.height,
        blocks: plan.blocks.map(({ id, kind, x, y, width, height }) => ({
          id,
          kind,
          x,
          y,
          width,
          height,
        })),
        audit: plan.audit,
      },
      next: 'Review the local preview, then run_study_board. The original lecture has not been edited.',
    };
  }
  async renderFigures(m, sourceRecord, dir) {
    const { record } = await this.a.documents.get(sourceRecord.exportId);
    if (sha(await fs.readFile(record.path)) !== sourceRecord.sha256)
      throw new GoodnotesError('SOURCE_SNAPSHOT_CHANGED', 'The source PDF has changed locally.');
    await fs.mkdir(dir, { recursive: true });
    const figures = [];
    for (const [i, f] of m.figures.entries()) {
      if (f.page > sourceRecord.pageCount)
        throw new GoodnotesError('INVALID_SOURCE_PAGE', 'Figure page outside source.');
      const rendered = await renderPdfPage(record.path, f.page, { maxDimension: 2200 }),
        source = await loadImage(rendered.bytes),
        c = f.crop ?? { x: 0, y: 0, width: 1, height: 1 };
      const x = Math.floor(c.x * source.width),
        y = Math.floor(c.y * source.height),
        w = Math.floor(c.width * source.width),
        h = Math.floor(c.height * source.height);
      if (w < 100 || h < 100)
        throw new GoodnotesError('FIGURE_TOO_SMALL', 'Use a larger source figure crop.');
      const canvas = createCanvas(w, h);
      canvas.getContext('2d').drawImage(source, x, y, w, h, 0, 0, w, h);
      const bytes = canvas.toBuffer('image/png'),
        filePath = path.join(dir, 'figure-' + i + '.png');
      await fs.writeFile(filePath, bytes);
      figures.push({ filePath, width: w, height: h, sha256: sha(bytes) });
    }
    return figures;
  }
  async run({ workflowId, maxSteps = 1 }, options = {}) {
    const j = await this.get(workflowId);
    if (!j.plan || digest(j.plan) !== j.planHash)
      throw new GoodnotesError('PLAN_CHANGED', 'No intact frozen layout plan.');
    for (let count = 0; count < maxSteps; count++) {
      checkCancellation(options.signal);
      const s = j.steps.find((s) => !['verified', 'reconciled'].includes(s.status));
      if (!s) break;
      if (s.kind !== 'audit') {
        const receipt = await this.a.journal.get(s.operationId);
        if (receipt.status === 'verified') {
          s.result = receipt.result;
          s.status = 'verified';
          if (s.kind === 'create') await this.bindBoard(j, s.result);
          await this.save(j);
          continue;
        }
        if (receipt.status !== 'not-found' || s.status !== 'pending') {
          j.status = 'needs-review';
          s.status = 'blocked';
          await this.save(j);
          return this.status({ workflowId });
        }
      }
      const at = Date.now();
      s.status = 'running';
      j.status = 'running';
      await this.save(j);
      try {
        if (s.kind === 'create') {
          s.result = await this.a.library.create(
            {
              kind: 'whiteboard',
              title: j.input.title,
              folderPath: j.input.folderPath,
              operationId: s.operationId,
            },
            options,
          );
          await this.bindBoard(j, s.result);
        } else if (s.kind === 'block')
          s.result = await this.native.create(
            j.board,
            j.plan.blocks.find((b) => b.id === s.id),
            s.operationId,
            options,
          );
        else s.result = await this.audit(j, options);
        s.status = 'verified';
        s.ms = Date.now() - at;
        j.timings.push({ stage: s.id, ms: s.ms });
      } catch (e) {
        s.status = 'blocked';
        s.error = { code: e.code ?? 'ACTION_FAILED', message: e.message, details: e.details };
        j.status = 'needs-review';
        j.timings.push({ stage: s.id, ms: Date.now() - at, failed: true });
        await this.save(j);
        return this.status({ workflowId });
      }
      await this.save(j);
    }
    if (j.steps.every((s) => ['verified', 'reconciled'].includes(s.status))) {
      j.status = 'completed';
      j.finishedAt ??= new Date().toISOString();
      j.elapsedMs = Date.parse(j.finishedAt) - Date.parse(j.startedAt);
    } else if (j.status !== 'needs-review') j.status = 'ready';
    await this.save(j);
    return this.status({ workflowId });
  }
  async bindBoard(j, result) {
    if (j.board) return;
    let v = await this.a.inspect({ url: result.url });
    const page = await this.a.getPage();
    for (let i = 0; v.zoom !== '100%' && i < 20; i++)
      v = await this.a.navigate({ viewId: v.viewId, zoomSteps: parseFloat(v.zoom) < 100 ? 1 : -1 });
    if (v.zoom !== '100%')
      throw new GoodnotesError('UNSUPPORTED_ZOOM', 'The layout requires native 100% zoom.');
    const anchor = await this.a.scans.anchor(page),
      worldOrigin = worldBox({ x: v.canvas.x, y: v.canvas.y, width: 1, height: 1 }, anchor);
    j.board = {
      url: result.url,
      title: result.title,
      itemPath: result.itemPath,
      anchor,
      canvas: v.canvas,
      worldOrigin,
      planHash: j.planHash,
    };
  }
  async audit(j, options) {
    const layouts = j.steps
        .filter((s) => s.kind === 'block')
        .map((s) => ({ id: s.id, ...s.result?.layout })),
      geometry = auditStudyGeometry(layouts, { width: j.plan.width, gap: 18 });
    if (!geometry.valid)
      throw new GoodnotesError(
        'NATIVE_LAYOUT_CONFLICT',
        'Actual native blocks overlap or exceed the planned board.',
        geometry,
      );
    const exportResult = await this.a.documents.exportPdf({ url: j.board.url }, options);
    if (exportResult.pageCount !== 1)
      throw new GoodnotesError('BOARD_EXPORT_CHANGED', 'Expected one infinite-board export page.');
    const rendered = await renderPdfPage(exportResult.path, 1, { maxDimension: 2800 }),
      previewPath = path.join(this.directory, j.workflowId, 'actual-board.png');
    await fs.writeFile(previewPath, rendered.bytes);
    return {
      verified: true,
      geometry,
      export: exportResult,
      previewPath,
      checks: j.steps
        .filter((s) => s.kind === 'block')
        .map((s) => ({ id: s.id, status: s.status, operationId: s.operationId })),
      note: 'Every block was independently verified after reload. The final export and actual bounds pass the geometry audit. Human/model visual review of this image still checks readability and source interpretation.',
    };
  }
  async review({ workflowId }, options = {}) {
    const j = await this.get(workflowId);
    if (!j.plan || digest(j.plan) !== j.planHash)
      throw new GoodnotesError('PLAN_CHANGED', 'No intact frozen layout plan.');
    const s = j.steps.find((s) => s.status === 'blocked' || s.status === 'running');
    if (!s) return this.status({ workflowId });
    if (s.kind === 'audit') {
      s.status = 'pending';
      delete s.error;
      j.status = 'ready';
      await this.save(j);
      return this.status({ workflowId });
    }
    const receipt = await this.a.journal.get(s.operationId);
    if (receipt.status === 'verified') {
      s.result = receipt.result;
      if (s.kind === 'create') await this.bindBoard(j, s.result);
      s.status = 'verified';
    } else if (s.kind === 'block' && j.board) {
      const verified = await this.native.verify(
        j.board,
        j.plan.blocks.find((b) => b.id === s.id),
        s.operationId,
        options,
      );
      s.result = { verified: true, ...verified, independentReconciliation: true };
      s.status = 'reconciled';
      s.priorReceiptStatus = receipt.status;
    } else
      throw new GoodnotesError(
        'REVIEW_REQUIRED',
        'The creation result is not proven; no operation will be replayed.',
        { operationId: s.operationId, receiptStatus: receipt.status },
      );
    delete s.error;
    j.status = 'ready';
    j.reconciliations = (j.reconciliations ?? 0) + 1;
    await this.save(j);
    return this.status({ workflowId });
  }
  async status({ workflowId, includeEvidence = false }) {
    const j = await this.get(workflowId);
    const finalAudit = j.steps.find((s) => s.kind === 'audit' && s.status === 'verified');
    return {
      workflowId: j.workflowId,
      status: j.status,
      source: includeEvidence
        ? j.source
        : j.source && {
            exportId: j.source.exportId,
            title: j.source.title,
            pageCount: j.source.pageCount,
          },
      sourceCopy: includeEvidence
        ? j.sourceCopy
        : j.sourceCopy && {
            url: j.sourceCopy.url,
            title: j.sourceCopy.title,
            itemPath: j.sourceCopy.itemPath,
          },
      board: j.board && { url: j.board.url, title: j.board.title, itemPath: j.board.itemPath },
      previewPath: finalAudit?.result?.previewPath ?? j.previewPath,
      planPreviewPath: j.previewPath,
      startedAt: j.startedAt,
      plannedAt: j.plannedAt,
      finishedAt: j.finishedAt,
      elapsedMs: j.elapsedMs ?? Date.now() - Date.parse(j.startedAt),
      activeMs: j.timings.reduce((n, t) => n + t.ms, 0),
      timings: j.timings,
      reconciliations: j.reconciliations ?? 0,
      steps: j.steps.map((s) => ({
        id: s.id,
        status: s.status,
        operationId: s.operationId,
        ms: s.ms,
        error: s.error,
        result: includeEvidence || s.kind === 'audit' ? s.result : undefined,
      })),
      note: 'Elapsed time includes source copying/export, assistant material preparation and layout/execution gaps. Active time counts recorded MCP work; these are not token-use measurements.',
    };
  }
}
