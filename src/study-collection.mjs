import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { GoodnotesError } from './errors.mjs';
import { readJson, writeJson, uuidFile } from './store.mjs';
import { digest } from './journal.mjs';
import {
  studyCardSchema,
  studyFigureSchema,
  studyLayoutSchema,
  planStudyLayout,
  makeStudyCard,
  renderStudyPreview,
  auditStudyGeometry,
} from './study-layout.mjs';
import { prepareFormatRanges } from './text-format-plan.mjs';

export const collectionMaterialsSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    subtitle: z.string().trim().min(1).max(180),
    layout: studyLayoutSchema.optional(),
    sections: z.array(z.string().trim().min(1).max(70)).max(40).optional(),
    cards: z.array(studyCardSchema).min(3).max(240),
    figures: z.array(studyFigureSchema).min(1).max(120),
  })
  .strict()
  .superRefine((m, c) => {
    for (const role of ['summary', 'questions', 'answers'])
      if (!m.cards.some((x) => x.role === role))
        c.addIssue({ code: 'custom', message: 'Missing ' + role + ' card.' });
    for (const list of [m.cards, m.figures]) {
      const keys = list.map((x, i) => x.key ?? String(i));
      if (new Set(keys).size !== keys.length)
        c.addIssue({ code: 'custom', message: 'Duplicate block key.' });
    }
    if (m.sections && new Set(m.sections).size !== m.sections.length)
      c.addIssue({ code: 'custom', message: 'Duplicate section name.' });
  });
export const collectionLimitsSchema = z
  .object({
    maxHeight: z.number().int().min(1600).max(5000).default(2800),
    maxBlocks: z.number().int().min(6).max(26).default(14),
    maxParts: z.number().int().min(2).max(20).default(20),
  })
  .strict();

export function linkedCard(id, heading, links, x, y, width = 1288) {
  const block = makeStudyCard(
    id,
    'concept',
    heading,
    links.map((l) => l.label).join('\n'),
    x,
    y,
    width,
    18,
    22,
  );
  let from = block.headingLength + 1;
  block.links = links.map((l) => {
    const start = block.text.indexOf(l.label, from);
    if (start < 0) throw new GoodnotesError('LINK_LABEL_WRAPPED', 'Use shorter navigation labels.');
    from = start + l.label.length;
    return { start, end: from, url: l.url };
  });
  prepareFormatRanges(
    block.text,
    block.links.map((l) => ({ start: l.start, end: l.end, format: { link: l.url } })),
  );
  return block;
}
export function linkCollectionPlans(plans, urls, indexUrl) {
  return plans.map((original, i) => {
    const plan = structuredClone(original),
      links = [{ label: 'Übersicht', url: indexUrl }];
    if (i > 0) links.push({ label: 'Zurück · Teil ' + i, url: urls[i - 1] });
    if (i + 1 < plans.length) links.push({ label: 'Weiter · Teil ' + (i + 2), url: urls[i + 1] });
    // Always reserve three rows, so resolving URLs cannot change pagination.
    const nav = linkedCard('navigation', 'Navigation', links, 56, plan.height, 1288);
    nav.height = Math.max(nav.height, 220);
    plan.blocks.push(nav);
    plan.height += nav.height + 64;
    plan.audit = auditStudyGeometry(plan.blocks);
    if (!plan.audit.valid)
      throw new GoodnotesError(
        'LINK_LAYOUT_CONFLICT',
        'Navigation overlaps study material.',
        plan.audit,
      );
    return plan;
  });
}
export function partitionStudyCollection(materials, source, figures, limitsInput = {}) {
  const m = collectionMaterialsSchema.parse(materials),
    limits = collectionLimitsSchema.parse(limitsInput);
  if (figures.length !== m.figures.length)
    throw new GoodnotesError('FIGURE_COUNT_MISMATCH', 'Missing source image.');
  // Stable global keys survive pagination; every figure and its caption stay together.
  const cards = m.cards.map((c, i) => ({ ...c, key: c.key ?? String(i) })),
    specs = m.figures.map((f, i) => ({ ...f, key: f.key ?? String(i) }));
  const sections = [
      ...new Set([
        ...(m.sections ?? []),
        ...specs.map((f) => f.section ?? ''),
        ...cards.map((c) => c.section ?? ''),
      ]),
    ],
    units = [];
  for (const section of sections) {
    for (const [i, f] of specs.entries())
      if ((f.section ?? '') === section) units.push({ figure: f, asset: figures[i] });
    for (const c of cards) if ((c.section ?? '') === section) units.push({ card: c });
  }
  const packs = [];
  let current = [];
  const build = (items, i) => {
    const present = [...new Set(items.map((u) => (u.card ?? u.figure).section ?? ''))];
    const part = {
      title: m.title + ' · Teil ' + (i + 1),
      subtitle: m.subtitle,
      layout: m.layout,
      sections: sections.filter((s) => s && present.includes(s)),
      cards: items.filter((u) => u.card).map((u) => u.card),
      figures: items.filter((u) => u.figure).map((u) => u.figure),
    };
    return {
      materials: part,
      plan: planStudyLayout(
        part,
        source,
        items.filter((u) => u.figure).map((u) => u.asset),
        { partial: true },
      ),
    };
  };
  const fits = (p) =>
    p.plan.height + 284 <= limits.maxHeight && p.plan.blocks.length + 1 <= limits.maxBlocks;
  for (const u of units) {
    let candidate;
    try {
      candidate = build([...current, u], packs.length);
    } catch (e) {
      if (!current.length || (!['LAYOUT_TOO_LARGE'].includes(e.code) && e.name !== 'ZodError'))
        throw e;
    }
    if (candidate && fits(candidate)) {
      current.push(u);
      continue;
    }
    if (current.length) {
      packs.push(build(current, packs.length));
      current = [];
    }
    candidate = build([u], packs.length);
    if (!fits(candidate))
      throw new GoodnotesError(
        'COLLECTION_ITEM_TOO_LARGE',
        'A single content group exceeds the chosen board limits. Shorten it or increase limits.',
      );
    current.push(u);
  }
  if (current.length) packs.push(build(current, packs.length));
  if (packs.length > limits.maxParts)
    throw new GoodnotesError(
      'TOO_MANY_PARTS',
      'Increase board limits or provide fewer materials.',
      { parts: packs.length, maxParts: limits.maxParts },
    );
  return {
    limits,
    parts: packs.map((p, i) => ({
      ...p,
      title: m.title + ' · ' + (i + 1) + '/' + packs.length,
      pages: [
        ...new Set([
          ...p.materials.cards.flatMap((c) => c.pages),
          ...p.materials.figures.map((f) => f.page),
        ]),
      ].sort((a, b) => a - b),
    })),
  };
}
function indexPlan(title, parts, urls, source) {
  const blocks = [
    makeStudyCard(
      'title',
      'title',
      title + ' · Übersicht',
      'Lernpfad: verstehen → selbst lösen → Antworten prüfen',
      56,
      80,
      1288,
      18,
      30,
    ),
  ];
  let y = blocks[0].y + blocks[0].height + 64;
  for (const [i, p] of parts.entries()) {
    const b = linkedCard(
      'part-' + i,
      'Teil ' +
        (i + 1) +
        ' · Seitenbereich ' +
        p.pages[0] +
        (p.pages.at(-1) !== p.pages[0] ? '–' + p.pages.at(-1) : ''),
      [{ label: 'Teil ' + (i + 1) + ' öffnen', url: urls[i] }],
      56,
      y,
      1288,
    );
    blocks.push(b);
    y += b.height + 64;
  }
  return {
    schema: 2,
    width: 1400,
    height: y,
    blocks,
    source,
    scaledPreview: true,
    audit: auditStudyGeometry(blocks),
  };
}
export class StudyCollectionController {
  constructor(a) {
    this.a = a;
    this.directory = path.join(a.config.directory, 'study-collections');
  }
  async get(id) {
    const j = await readJson(uuidFile(this.directory, id), null);
    if (!j) throw new GoodnotesError('COLLECTION_NOT_FOUND', 'Unknown study collection.');
    return j;
  }
  save(j) {
    return writeJson(uuidFile(this.directory, j.collectionId), j);
  }
  async prepare(input, options = {}) {
    const packet = await this.a.study.prepare(input, options),
      collectionId = packet.workflowId;
    if (!(await readJson(uuidFile(this.directory, collectionId), null)))
      await this.save({
        collectionId,
        input,
        source: packet.source,
        sourceCopy: packet.sourceCopy,
        status: 'needs-materials',
        parts: [],
        startedAt: new Date().toISOString(),
      });
    return {
      ...packet,
      collectionId,
      status: (await this.get(collectionId)).status,
      next: 'Read the copied source; supply source-based materials to plan_study_collection.',
    };
  }
  async plan({ collectionId, materials, limits = {} }) {
    const j = await this.get(collectionId);
    if (j.creations?.some((c) => c.status !== 'pending'))
      throw new GoodnotesError(
        'PLAN_ALREADY_STARTED',
        'A dispatched collection cannot be replanned.',
      );
    const m = collectionMaterialsSchema.parse(materials),
      dir = path.join(this.directory, collectionId);
    await fs.mkdir(dir, { recursive: true });
    const figures = await this.a.study.renderFigures(m, j.source, dir),
      partition = partitionStudyCollection(m, j.source, figures, limits);
    // The placeholder is a syntactically valid URL only; never written to Goodnotes.
    const previews = linkCollectionPlans(
      partition.parts.map((p) => p.plan),
      partition.parts.map(() => 'https://web.goodnotes.com/'),
      'https://web.goodnotes.com/',
    );
    for (const [i, p] of partition.parts.entries()) {
      p.previewPath = path.join(dir, 'part-' + (i + 1) + '-preview.png');
      await fs.writeFile(p.previewPath, await renderStudyPreview(previews[i]));
    }
    j.materials = m;
    j.parts = partition.parts;
    j.limits = partition.limits;
    j.planHash = digest({ parts: j.parts, materials: m, limits: j.limits });
    j.plannedAt = new Date().toISOString();
    j.status = 'planned';
    j.creations = [
      { title: m.title + ' · Übersicht' },
      ...j.parts.map((p) => ({ title: p.title })),
    ].map((c, i) => ({
      ...c,
      workflowId: crypto.randomUUID(),
      status: 'pending',
      operationId: 'collection-' + collectionId + '-create-' + i,
    }));
    delete j.children;
    await this.save(j);
    return this.status({ collectionId });
  }
  assertPlan(j) {
    if (
      !j.planHash ||
      digest({ parts: j.parts, materials: j.materials, limits: j.limits }) !== j.planHash
    )
      throw new GoodnotesError('PLAN_CHANGED', 'The collection plan changed.');
  }
  async freezeChildren(j) {
    if (j.children) return;
    const urls = j.creations.slice(1).map((c) => c.result.url),
      partPlans = linkCollectionPlans(
        j.parts.map((p) => p.plan),
        urls,
        j.creations[0].result.url,
      );
    const plans = [indexPlan(j.materials.title, j.parts, urls, j.source), ...partPlans];
    // Save complete child definitions before installing them. A crash can only
    // restore these exact frozen definitions, never regenerate a dispatched plan.
    j.children = j.creations.map((c, i) => ({
      workflowId: c.workflowId,
      input: { title: c.title, folderPath: j.input.folderPath ?? [] },
      source: j.source,
      sourceCopy: j.sourceCopy,
      materials: i ? j.parts[i - 1].materials : { cards: [] },
      plan: plans[i],
      planHash: digest(plans[i]),
      board: { ...c.board, planHash: digest(plans[i]) },
      startedAt: j.startedAt,
      plannedAt: j.plannedAt,
      timings: [],
      status: 'ready',
      steps: [
        {
          id: 'create',
          kind: 'create',
          status: 'verified',
          operationId: c.operationId,
          result: c.result,
        },
        ...plans[i].blocks.map((b, k) => ({
          id: b.id,
          kind: 'block',
          status: 'pending',
          operationId: 'study-' + c.workflowId + '-' + (k + 1),
        })),
        {
          id: 'audit',
          kind: 'audit',
          status: 'pending',
          operationId: 'study-' + c.workflowId + '-audit',
        },
      ],
    }));
    await this.save(j);
  }
  async installChildren(j) {
    for (const child of j.children) {
      if (digest(child.plan) !== child.planHash || child.board.planHash !== child.planHash)
        throw new GoodnotesError('CHILD_PLAN_CHANGED', 'Frozen child definition is inconsistent.');
      let existing;
      try {
        existing = await this.a.study.get(child.workflowId);
      } catch (e) {
        if (e.code !== 'STUDY_NOT_FOUND') throw e;
      }
      if (existing) {
        if (existing.planHash !== child.planHash || digest(existing.plan) !== existing.planHash)
          throw new GoodnotesError(
            'CHILD_PLAN_CHANGED',
            'Child plan does not match its collection.',
          );
        continue;
      }
      const dir = path.join(this.a.study.directory, child.workflowId);
      await fs.mkdir(dir, { recursive: true });
      child.previewPath = path.join(dir, 'preview.png');
      await fs.writeFile(child.previewPath, await renderStudyPreview(child.plan));
      await this.a.study.save(child);
    }
  }
  async run({ collectionId }, options = {}) {
    const j = await this.get(collectionId);
    this.assertPlan(j);
    const c = j.creations.find((c) => c.status !== 'verified');
    if (c) {
      const receipt = await this.a.journal.get(c.operationId);
      if (receipt.status === 'verified') c.result = receipt.result;
      else if (receipt.status !== 'not-found' || c.status !== 'pending') {
        j.status = 'needs-review';
        c.status = 'blocked';
        await this.save(j);
        return this.status({ collectionId });
      } else {
        c.status = 'running';
        await this.save(j);
        const at = Date.now();
        try {
          c.result = await this.a.library.create(
            {
              kind: 'whiteboard',
              title: c.title,
              folderPath: j.input.folderPath ?? [],
              operationId: c.operationId,
            },
            options,
          );
          c.ms = Date.now() - at;
        } catch (e) {
          c.status = 'blocked';
          c.error = { code: e.code, message: e.message };
          j.status = 'needs-review';
          await this.save(j);
          return this.status({ collectionId });
        }
      }
      await this.a.study.bindBoard(c, c.result);
      c.status = 'verified';
      delete c.error;
      j.status = 'ready';
      await this.save(j);
      return this.status({ collectionId });
    }
    await this.freezeChildren(j);
    await this.installChildren(j);
    // Finish content boards first, then the overview that links to them.
    for (const child of [...j.children.slice(1), j.children[0]]) {
      const state = await this.a.study.get(child.workflowId);
      if (state.status === 'completed') continue;
      const result = await this.a.study.run({ workflowId: child.workflowId }, options);
      j.status = result.status === 'needs-review' ? 'needs-review' : 'ready';
      await this.save(j);
      return this.status({ collectionId });
    }
    j.status = 'completed';
    j.finishedAt ??= new Date().toISOString();
    await this.save(j);
    return this.status({ collectionId });
  }
  async review({ collectionId }, options = {}) {
    const j = await this.get(collectionId);
    this.assertPlan(j);
    const c = j.creations.find((c) => ['blocked', 'running'].includes(c.status));
    if (c) {
      const receipt = await this.a.journal.get(c.operationId);
      if (receipt.status !== 'verified')
        throw new GoodnotesError(
          'REVIEW_REQUIRED',
          'Creation has no verified receipt; it will not be replayed.',
          { operationId: c.operationId },
        );
      c.result = receipt.result;
      await this.a.study.bindBoard(c, c.result);
      c.status = 'verified';
      delete c.error;
    } else
      for (const child of j.children ?? []) {
        const s = await this.a.study.get(child.workflowId);
        if (s.status === 'needs-review' || s.steps.some((x) => x.status === 'running')) {
          await this.a.study.review({ workflowId: child.workflowId }, options);
          break;
        }
      }
    j.status = 'ready';
    await this.save(j);
    return this.status({ collectionId });
  }
  async status({ collectionId }) {
    const j = await this.get(collectionId),
      children = [];
    for (const c of j.children ?? []) {
      let state;
      try {
        state = await this.a.study.status({ workflowId: c.workflowId });
      } catch (e) {
        if (e.code !== 'STUDY_NOT_FOUND') throw e;
      }
      children.push(
        state
          ? {
              workflowId: c.workflowId,
              status: state.status,
              board: state.board,
              previewPath: state.previewPath,
              verifiedSteps: state.steps.filter((s) =>
                ['verified', 'reconciled'].includes(s.status),
              ).length,
              totalSteps: state.steps.length,
              activeMs: state.activeMs,
              reconciliations: state.reconciliations,
              next: state.steps.find((s) => !['verified', 'reconciled'].includes(s.status)),
            }
          : { workflowId: c.workflowId, status: 'pending-install' },
      );
    }
    return {
      collectionId,
      status: j.status,
      source: { exportId: j.source.exportId, pageCount: j.source.pageCount },
      sourceCopy: j.sourceCopy,
      parts: j.parts.map((p, i) => ({
        part: i + 1,
        title: p.title,
        pages: p.pages,
        blocks: p.plan.blocks.length + 1,
        previewPath: p.previewPath,
      })),
      creations: j.creations?.map((c) => ({
        title: c.title,
        status: c.status,
        operationId: c.operationId,
        url: c.result?.url,
        ms: c.ms,
        error: c.error,
      })),
      children,
      overviewUrl: j.creations?.[0]?.result?.url,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      note: 'The caller supplies source-based explanations and exercises. Splitting and native links are automatic. Finished child workflow IDs support later selective revisions. Uncertain writes stop for review.',
    };
  }
}
