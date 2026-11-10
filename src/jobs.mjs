import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { readJson, writeJson, uuidFile } from './store.mjs';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import {
  stepSchema,
  concreteStepSchema,
  validateReferences,
  resolveStep,
  replayableReadActions,
} from './job-schema.mjs';

export { stepSchema } from './job-schema.mjs';
const destructive = new Set([
  'rename',
  'move',
  'pages',
  'replace-text',
  'move-object',
  'edit-text',
  'color-object',
  'arrange-object',
  'transform-object',
  'convert-handwriting',
  'crop-image',
  'text-box-style',
  'shape-style',
  'unlock-object',
  'rename-outline',
  'delete-outline',
]);
export class JobController {
  constructor(adapter) {
    this.a = adapter;
    this.directory = path.join(adapter.config.directory, 'jobs');
  }
  async plan({ title: label, steps, backup = true }) {
    const parsed = z.array(stepSchema).min(1).max(100).parse(steps);
    validateReferences(parsed);
    const jobId = crypto.randomUUID();
    const job = {
      jobId,
      title: label,
      schema: 2,
      createdAt: new Date().toISOString(),
      status: 'planned',
      backup,
      steps: parsed.map((input, i) => ({
        index: i,
        input,
        operationId: `job-${jobId}-${i}`,
        status: 'pending',
      })),
    };
    await this.save(job);
    return {
      ...job,
      note: 'Saved plan only. Run explicitly to execute. Inputs contain private note text and are stored in the local data directory. Backups are PDF snapshots, not lossless native backups.',
    };
  }
  async get(jobId) {
    const job = await readJson(uuidFile(this.directory, jobId), null);
    if (!job) throw new GoodnotesError('JOB_NOT_FOUND', 'Batch job not found.');
    return job;
  }
  async save(job) {
    await writeJson(uuidFile(this.directory, job.jobId), job);
  }
  async status({ jobId, includeInputs = false }) {
    const job = await this.get(jobId);
    return {
      ...job,
      steps: job.steps.map((s) =>
        includeInputs
          ? s
          : {
              index: s.index,
              action: s.input.action,
              status: s.status,
              operationId: s.operationId,
              backup: s.backup,
              result: s.result,
              error: s.error,
              skippedReason: s.skippedReason,
              attempts: s.attempts,
            },
      ),
    };
  }
  async skip({ jobId, stepIndex, reason }) {
    const job = await this.get(jobId),
      step = job.steps[stepIndex];
    if (!step || !['pending', 'blocked', 'running'].includes(step.status))
      throw new GoodnotesError(
        'INVALID_STEP',
        'Only an unfinished step can be skipped after inspection.',
      );
    step.status = 'skipped';
    step.skippedReason = reason;
    job.status = 'paused';
    await this.save(job);
    return this.status({ jobId });
  }
  async run({ jobId, maxSteps = 1 }, { signal } = {}) {
    const job = await this.get(jobId);
    for (let count = 0; count < maxSteps; count++) {
      checkCancellation(signal);
      const step = job.steps.find((s) => !['verified', 'skipped'].includes(s.status));
      if (!step) break;
      if (step.status === 'blocked') {
        job.status = 'needs-review';
        break;
      }
      const receipt = await this.a.journal.get(step.operationId);
      if (receipt.status === 'verified') {
        step.status = 'verified';
        step.result = receipt.result;
        await this.save(job);
        continue;
      }
      if (
        receipt.status !== 'not-found' ||
        (step.status === 'running' && !replayableReadActions.has(step.input.action))
      ) {
        // A crash between dispatch and receipt creation is deliberately not retried automatically.
        step.status = 'blocked';
        step.error = { code: 'REVIEW_REQUIRED', receiptStatus: receipt.status };
        job.status = 'needs-review';
        await this.save(job);
        break;
      }
      try {
        const input = step.resolvedInput
          ? concreteStepSchema.parse(step.resolvedInput)
          : resolveStep(step.input, job.steps);
        step.resolvedInput = input;
        await this.save(job);
        if (job.backup && destructive.has(input.action) && !step.backup) {
          const sourceUrl = input.url || (await this.a.openItem({ itemPath: input.itemPath })).url;
          step.backup = await this.a.documents.exportPdf({ url: sourceUrl }, { signal });
          await this.save(job);
        }
        checkCancellation(signal);
        delete step.error;
        step.status = 'running';
        job.status = 'running';
        await this.save(job);
        step.result = await this.dispatch(input, step.operationId, { signal });
        step.status = 'verified';
      } catch (e) {
        const dispatched = step.status === 'running';
        step.status = dispatched ? 'blocked' : 'pending';
        step.error = {
          code: e.code || 'ACTION_FAILED',
          message: e.message.slice(0, 500),
          mayHaveWritten: dispatched ? (e.details?.mayHaveWritten ?? null) : false,
          stage: dispatched ? 'dispatch' : 'read-only-preflight',
        };
        job.status = dispatched ? 'needs-review' : 'paused';
      }
      await this.save(job);
      if (step.error) break;
    }
    if (job.steps.every((s) => ['verified', 'skipped'].includes(s.status)))
      job.status = job.steps.some((s) => s.status === 'skipped')
        ? 'completed-with-skips'
        : 'completed';
    else if (job.status !== 'needs-review') job.status = 'paused';
    await this.save(job);
    return this.status({ jobId });
  }
  async retryRejected({ jobId, stepIndex }) {
    const job = await this.get(jobId),
      step = job.steps[stepIndex];
    if (!step || step.status !== 'blocked')
      throw new GoodnotesError(
        'INVALID_STEP',
        'Only a blocked step can be considered for a safe retry.',
      );
    const receipt = await this.a.journal.get(step.operationId);
    if (receipt.status !== 'rejected' || receipt.result?.mayHaveWritten !== false)
      throw new GoodnotesError(
        'REVIEW_REQUIRED',
        'Retry requires a receipt proving no mutation was sent. Uncertain or missing receipts cannot be retried.',
      );
    step.attempts ??= [];
    if (step.attempts.length >= 10)
      throw new GoodnotesError('RETRY_LIMIT', 'This step has reached its explicit retry limit.');
    step.attempts.push({
      operationId: step.operationId,
      error: step.error,
      receiptStatus: receipt.status,
    });
    step.operationId = 'job-' + jobId + '-' + stepIndex + '-retry' + step.attempts.length;
    step.status = 'pending';
    delete step.error;
    job.status = 'paused';
    await this.save(job);
    return this.status({ jobId });
  }
  async dispatch(input, operationId, options) {
    const { action, ...args } = input,
      a = this.a;
    if (action === 'export') return a.documents.exportPdf(args, options);
    if (action === 'favorite-document')
      return a.library.setFavorite({ ...args, operationId }, options);
    if (action === 'expand-sticky') return a.styles.expandSticky({ ...args, operationId }, options);
    if (action === 'trash-document') return a.trash.trash({ ...args, operationId }, options);
    if (action === 'folder-style') return a.folderStyle.set({ ...args, operationId }, options);
    if (action === 'folder-rename' || action === 'folder-move')
      return a.folders.manage(
        { ...args, action: action === 'folder-rename' ? 'rename' : 'move', operationId },
        options,
      );
    if (action === 'restore-document') return a.trash.restore({ ...args, operationId }, options);
    if (action === 'board-background') return a.layout.setBoard({ ...args, operationId }, options);
    if (action === 'page-template') return a.layout.setTemplate({ ...args, operationId }, options);
    if (action === 'copy-page') return a.pages.copyNative({ ...args, operationId }, options);
    if (action === 'copy-text-object')
      return a.objects.copyNativeText({ ...args, operationId }, options);
    if (action === 'copy-image-object')
      return a.objects.copyNativeImage({ ...args, operationId }, options);
    if (action === 'restore-page') return a.pageRecovery.restore({ ...args, operationId }, options);
    if (action === 'move-native-object')
      return a.objectMove.move({ ...args, operationId }, options);
    if (action === 'snapshot') return a.recovery.create({ ...args, operationId }, options);
    if (action === 'restore-copy') return a.recovery.restore({ ...args, operationId }, options);
    if (action === 'list-pages') return a.pages.list(args);
    if (action === 'list-outlines') return a.outlines.list(args, options);
    if (action === 'rename-outline' || action === 'delete-outline')
      return a.outlines.manage(
        { ...args, command: action === 'rename-outline' ? 'rename' : 'delete', operationId },
        options,
      );
    if (action === 'combine') return a.workflows.combine(args, options);
    if (action === 'study-bundle') return a.workflows.studyBundle(args);
    if (['rename', 'move', 'duplicate'].includes(action))
      return a.library.manage({ action, ...args, operationId }, options);
    if (action === 'create') return a.library.create({ ...args, operationId }, options);
    if (action === 'import') return a.pages.importPdf({ ...args, operationId }, options);
    if (action === 'move-object') return a.board.moveByText({ ...args, operationId }, options);
    if (action === 'pages') return a.pages.manage({ ...args, operationId }, options);
    if (action === 'replace-text') {
      const view = await a.inspect({ url: args.url }),
        target = await a.readText({
          viewId: view.viewId,
          x: args.x,
          y: args.y,
          expectedKind: args.expectedKind,
        });
      if (target.text !== args.expectedText)
        throw new GoodnotesError(
          'TEXT_CONFLICT',
          'The batch target no longer contains its expected exact text.',
        );
      return a.writeText({ targetId: target.targetId, text: args.text, operationId }, options);
    }
    if (action === 'sticky') {
      const view = await a.inspect({ url: args.url });
      return a.objects.create(
        { viewId: view.viewId, kind: 'sticky', x: args.x, y: args.y, text: args.text, operationId },
        options,
      );
    }
    const view = await a.inspect({ url: args.url });
    if (action === 'copy-native-selection') {
      const selected = await a.objects.select({ viewId: view.viewId, region: args.region });
      return a.objects.copyNativeSelection(
        { ...args, selectionId: selected.selectionId, operationId },
        options,
      );
    }
    if (action === 'unlock-object') {
      const prepared = await a.styles.prepareUnlock({ ...args, viewId: view.viewId });
      return a.styles.unlockObject({ unlockId: prepared.unlockId, operationId }, options);
    }
    if (action === 'create-text')
      return a.text.create({ ...args, viewId: view.viewId, operationId }, options);
    if (action === 'create-object')
      return a.objects.create({ ...args, viewId: view.viewId, operationId }, options);
    if (action === 'image')
      return a.images.insert({ ...args, viewId: view.viewId, operationId }, options);
    if (action === 'crop-image') {
      const selected = await this.target(view, args.target, true, options),
        crop = await a.imageCrop.prepare({ selectionId: selected.selectionId });
      return a.imageCrop.apply({ cropId: crop.cropId, region: args.region, operationId }, options);
    }
    if (action === 'shape-style') {
      const selected = await this.target(view, args.target, true, options),
        prepared = await a.shapeStyle.prepare({ selectionId: selected.selectionId });
      return a.shapeStyle.apply(
        { styleId: prepared.styleId, style: args.style, operationId },
        options,
      );
    }
    if (action === 'text-box-style') {
      const selected = await this.target(view, args.target, true, options),
        prepared = await a.textBoxStyle.prepare({ selectionId: selected.selectionId }, options);
      if (prepared.text !== args.expectedText)
        throw new GoodnotesError('TEXT_CONFLICT', 'Expected exact text no longer matches.');
      if (prepared.supported === false)
        throw new GoodnotesError('STYLE_UNSUPPORTED', prepared.reason, { mayHaveWritten: false });
      return a.textBoxStyle.apply(
        { styleId: prepared.styleId, style: args.style, operationId },
        options,
      );
    }
    if (action === 'connector')
      return a.board.connector({ ...args, viewId: view.viewId, operationId }, options);
    if (action === 'convert-handwriting') {
      const recognized = await a.objects.recognize({ viewId: view.viewId, region: args.region });
      return a.objects.convert(
        { handwritingId: recognized.handwritingId, text: args.text, operationId },
        options,
      );
    }
    if (['edit-text', 'color-object', 'transform-object', 'arrange-object'].includes(action)) {
      const target = await this.target(view, args.target, action !== 'edit-text', options);
      if (action === 'edit-text') {
        if (target.text !== args.expectedText)
          throw new GoodnotesError('TEXT_CONFLICT', 'Expected exact text no longer matches.');
        return a.text.edit({ ...args, targetId: target.targetId, operationId }, options);
      }
      if (action === 'color-object')
        return a.styles.color(
          { selectionId: target.selectionId, color: args.color, operationId },
          options,
        );
      if (action === 'arrange-object')
        return a.styles.arrange(
          { selectionId: target.selectionId, command: args.command, operationId },
          options,
        );
      return a.objects.transform(
        { ...args, selectionId: target.selectionId, action: args.transform, operationId },
        options,
      );
    }
    throw new GoodnotesError('INVALID_ACTION', 'Unsupported batch step.');
  }
  async target(view, target, select, options) {
    const a = this.a;
    if (target.scanId || target.objectId) view = a.getView(view.viewId);
    if (target.scanId) {
      const selected = await a.scans.select(target, options),
        selectedView = a.getView(a.targets.get(selected.targetId).viewId);
      if (
        selectedView.url !== view.url ||
        new URL(selectedView.pageUrl).hash !== new URL(view.pageUrl).hash
      )
        throw new GoodnotesError(
          'TARGET_DOCUMENT_CONFLICT',
          'The saved target belongs to a different document or page.',
        );
      return selected;
    }
    if (target.objectId) {
      const saved = await a.scans.recall(target, options);
      if (
        a.getView(saved.viewId).url !== view.url ||
        new URL(a.getView(saved.viewId).pageUrl).hash !== new URL(view.pageUrl).hash
      )
        throw new GoodnotesError(
          'TARGET_DOCUMENT_CONFLICT',
          'The saved target belongs to a different document or page.',
        );
      if (select) return saved;
      const v = a.getView(saved.viewId),
        b = saved.bounds;
      return a.readText({
        viewId: saved.viewId,
        x: (b.x + b.width / 2 - v.canvas.x) / v.canvas.width,
        y: (b.y + b.height / 2 - v.canvas.y) / v.canvas.height,
      });
    }
    if (target.query) {
      const found = await a.board.find({ viewId: view.viewId, query: target.query }, options);
      if (found.matches.length !== 1)
        throw new GoodnotesError('AMBIGUOUS_MATCH', 'Expected exactly one visible text match.');
      return a.board.select({
        matchId: found.matches[0].matchId,
        expectedText: target.expectedText,
      });
    }
    let read;
    if (!select || target.expectedText !== undefined) {
      read = await a.readText({
        viewId: view.viewId,
        x: target.x,
        y: target.y,
        expectedKind: target.expectedKind,
      });
      if (target.expectedText !== undefined && read.text !== target.expectedText)
        throw new GoodnotesError('TEXT_CONFLICT', 'Expected exact text no longer matches.');
    }
    if (!select) return read;
    return {
      ...read,
      ...(await a.objects.select({ viewId: view.viewId, x: target.x, y: target.y })),
    };
  }
}
