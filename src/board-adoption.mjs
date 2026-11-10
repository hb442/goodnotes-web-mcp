import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { GoodnotesError } from './errors.mjs';
import { readJson, writeJson, uuidFile } from './store.mjs';
import { digest } from './journal.mjs';
import { worldBox, screenBox } from './board-scan.mjs';
import { captureBoardViewport } from './viewport.mjs';
import { auditStudyGeometry, renderStudyPreview } from './study-layout.mjs';

// Adoption records observations of explicitly selected objects. It never infers
// that an infinite board has been exhaustively enumerated.
export function adoptionManifest(board, source, captures) {
  if (!captures.length)
    throw new GoodnotesError(
      'NO_ADOPTED_OBJECTS',
      'Capture at least one native text box or image.',
    );
  const origin = {
    x: Math.min(...captures.map((c) => c.world.x)) - 56,
    y: Math.min(...captures.map((c) => c.world.y)) - 80,
  };
  const entries = captures.map((c) => {
    const layout = {
      x: c.world.x - origin.x,
      y: c.world.y - origin.y,
      width: c.world.width,
      height: c.world.height,
    };
    return { block: { ...c.block, ...layout }, layout, checkpointPath: c.checkpointPath };
  });
  const width = Math.max(1400, ...entries.map((e) => e.block.x + e.block.width + 56)),
    height = Math.max(...entries.map((e) => e.block.y + e.block.height)) + 64;
  if (width > 12000 || height > 12000)
    throw new GoodnotesError('ADOPTION_TOO_LARGE', 'Adopt a smaller area of this board.');
  const audit = auditStudyGeometry(
    entries.map((e) => e.block),
    { width, gap: 8 },
  );
  if (!audit.valid)
    throw new GoodnotesError(
      'ADOPTION_OVERLAP',
      'Selected objects overlap or have less than 8 px clearance.',
      audit,
    );
  const plan = { width, height, blocks: entries.map((e) => e.block), scaledPreview: true };
  return {
    board: {
      ...board,
      worldOrigin: origin,
      anchor: {
        ...board.anchor,
        x: board.canvas.x - origin.x,
        y: board.canvas.y - origin.y,
        scale: 1,
      },
      horizontalPan: true,
      adopted: true,
      planHash: digest(plan),
    },
    source,
    plan,
    blocks: entries,
  };
}
export class BoardAdoptionController {
  constructor(a) {
    this.a = a;
    this.directory = path.join(a.config.directory, 'board-adoptions');
  }
  async get(id) {
    const j = await readJson(uuidFile(this.directory, id), null);
    if (!j) throw new GoodnotesError('ADOPTION_NOT_FOUND', 'Unknown board adoption.');
    return j;
  }
  save(j) {
    return writeJson(uuidFile(this.directory, j.adoptionId), j);
  }
  async prepare(input, options = {}) {
    const { itemPath, expectedTitle, title, sourceExportId, requestId } = input;
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId))
      throw new GoodnotesError('INVALID_REQUEST_ID', 'Use a stable request ID.');
    const file = path.join(this.directory, 'requests', requestId + '.json');
    let binding = await readJson(file, null);
    if (binding && binding.inputHash !== digest(input))
      throw new GoodnotesError('REQUEST_CONFLICT', 'Request belongs to another adoption.');
    if (binding?.adoptionId) return this.status({ adoptionId: binding.adoptionId });
    const a = this.a;
    if (!binding) {
      const v = await a.openItem({ itemPath });
      if (v.title !== expectedTitle)
        throw new GoodnotesError('BOARD_CHANGED', 'Original board title differs.');
      const holder = {};
      await a.study.bindBoard(holder, { url: v.url, title: v.title, itemPath });
      const { record } = await a.documents.get(sourceExportId);
      binding = {
        inputHash: digest(input),
        baseId: crypto.randomUUID(),
        base: {
          board: holder.board,
          source: record,
          plan: { width: 1400, height: 0, blocks: [] },
          blocks: [],
        },
      };
      await writeJson(file, binding);
    }
    const result = await a.studyRevision.prepare(
      {
        baseId: binding.baseId,
        title,
        copy: true,
        requestId: 'adopt-' + requestId.slice(0, 70),
        itemPath,
      },
      options,
      binding.base,
    );
    const adoptionId = result.revisionId;
    if (!(await readJson(uuidFile(this.directory, adoptionId), null)))
      await this.save({
        adoptionId,
        input,
        board: (await a.studyRevision.get(adoptionId)).board,
        source: binding.base.source,
        status: 'capturing',
        captures: [],
        startedAt: new Date().toISOString(),
      });
    binding.adoptionId = adoptionId;
    await writeJson(file, binding);
    return this.status({ adoptionId });
  }
  async capture(
    { adoptionId, selectionId, key, kind, role = 'concept', pages, expectedText },
    options = {},
  ) {
    const j = await this.get(adoptionId),
      a = this.a;
    if (j.status !== 'capturing')
      throw new GoodnotesError('ADOPTION_FINISHED', 'This manifest is already frozen.');
    if (j.captures.length >= 60)
      throw new GoodnotesError('ADOPTION_LIMIT', 'Adopt at most 60 selected objects.');
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(key) || j.captures.some((c) => c.block.id === 'adopt-' + key))
      throw new GoodnotesError('DUPLICATE_BLOCK_ID', 'Use a new safe object key.');
    if (pages.some((p) => p > j.source.pageCount))
      throw new GoodnotesError('INVALID_SOURCE_PAGE', 'Citation exceeds the source snapshot.');
    const { s, view, page } = await a.styles.selection(selectionId);
    if (view.url !== j.board.url || view.title !== j.board.title || view.zoom !== '100%')
      throw new GoodnotesError(
        'WRONG_ADOPTION_VIEW',
        'Select an object on the verified copy at 100% zoom.',
      );
    const b = s.bounds;
    if (b.width > 1288 || b.height > 620 || b.width < 40 || b.height < 30)
      throw new GoodnotesError(
        'UNSUPPORTED_OBJECT_SIZE',
        'One complete object must fit within a guarded viewport.',
      );
    const anchor = await a.scans.anchor(page),
      world = worldBox(b, anchor),
      point = {
        x: (b.x + Math.min(18, b.width / 2) - view.canvas.x) / view.canvas.width,
        y: (b.y + Math.min(18, b.height / 2) - view.canvas.y) / view.canvas.height,
      };
    if (
      j.captures.some((c) => Math.abs(c.world.x - world.x) < 3 && Math.abs(c.world.y - world.y) < 3)
    )
      throw new GoodnotesError('DUPLICATE_OBJECT', 'This object was already captured.');
    const id = 'adopt-' + key,
      operationId = 'adopt-' + adoptionId + '-' + key.slice(0, 30),
      n = a.study.native;
    let block = { id, kind, sourcePages: [...new Set(pages)], sourceExportId: j.source.exportId },
      content,
      runs,
      style;
    if (kind === 'text') {
      if (typeof expectedText !== 'string' || !expectedText.trim())
        throw new GoodnotesError(
          'EXPECTED_TEXT_REQUIRED',
          'Supply the exact previously read text.',
        );
      const read = await a.readText({ viewId: view.viewId, ...point, expectedKind: 'text-box' });
      if (read.text !== expectedText)
        throw new GoodnotesError('TEXT_CONFLICT', 'Selected text differs from expected text.');
      content = read.text;
      runs = read.formatting;
      const fresh = await a.objects.select({ viewId: view.viewId, ...point }),
        probe = await a.textBoxStyle.prepare({ selectionId: fresh.selectionId }, options);
      if (!probe.supported)
        throw new GoodnotesError(
          'STYLE_UNSUPPORTED',
          'Only native text boxes with readable style can be adopted.',
        );
      style = probe.state;
      await a.textBoxStyle.close(page);
      const lines = content.split('\n'),
        heading = lines.shift(),
        bodyRun = runs.find((r) => r.start > heading.length),
        first = runs[0];
      const fontSize = Number(bodyRun?.fontSize ?? first?.fontSize ?? 18),
        headingSize = Number(first?.fontSize ?? fontSize);
      if (!Number.isFinite(fontSize) || !Number.isFinite(headingSize))
        throw new GoodnotesError('FONT_UNSUPPORTED', 'Unreadable native font sizes.');
      block = {
        ...block,
        role,
        text: content,
        headingLength: heading.length,
        headingLines: [heading],
        bodyLines: lines,
        fontSize,
        headingSize,
        backgroundColor: style.backgroundColor ?? '#ffffff',
      };
    } else {
      const probe = await a.imageCrop.prepare({ selectionId }),
        state = a.imageCrop.preparations.get(probe.cropId).state;
      const dir = path.join(this.directory, adoptionId);
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, key + '.png');
      await fs.writeFile(filePath, state.sourceBytes);
      block = {
        ...block,
        filePath,
        sha256: crypto.createHash('sha256').update(state.sourceBytes).digest('hex'),
        nativeCrop: state.region,
        keepNativeSize: true,
        sourcePage: pages[0],
      };
      point.x = (b.x + b.width / 2 - view.canvas.x) / view.canvas.width;
      point.y = (b.y + b.height / 2 - view.canvas.y) / view.canvas.height;
    }
    const anchorPoint = worldBox(
      {
        x: view.canvas.x + point.x * view.canvas.width,
        y: view.canvas.y + point.y * view.canvas.height,
        width: 1,
        height: 1,
      },
      anchor,
    );
    const one = adoptionManifest(j.board, j.source, [{ world, block }]),
      singleBlock = one.blocks[0].block;
    await a.objects.readingMode(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await n.position(one.board, singleBlock, options);
    await a.objects.readingMode(page);
    const bounds = screenBox(world, await a.scans.anchor(page)),
      imagePath = path.join(n.directory, operationId + '.png');
    await fs.mkdir(n.directory, { recursive: true });
    await fs.writeFile(imagePath, await page.screenshot({ animations: 'disabled' }));
    const evidence = {
      operationId,
      url: j.board.url,
      title: j.board.title,
      planHash: one.board.planHash,
      blockId: id,
      kind,
      world,
      bounds,
      camera: await captureBoardViewport(page),
      content,
      runs,
      style,
      anchorPoint,
      imagePath,
    };
    await writeJson(n.file(operationId), evidence);
    await n.verifyEvidence(one.board, singleBlock, evidence, options);
    j.captures.push({ block, world, checkpointPath: n.file(operationId) });
    await this.save(j);
    return this.status({ adoptionId });
  }
  async finish({ adoptionId }, options = {}) {
    const j = await this.get(adoptionId);
    if (j.status === 'completed') return this.status({ adoptionId });
    const a = this.a,
      manifest = adoptionManifest(j.board, j.source, j.captures);
    const start = j.verifiedCaptures ?? 0;
    for (const e of manifest.blocks.slice(start, start + 3)) {
      await a.study.native.verifyEvidence(
        manifest.board,
        e.block,
        await readJson(e.checkpointPath),
        options,
      );
      j.verifiedCaptures = (j.verifiedCaptures ?? 0) + 1;
      j.status = 'verifying';
      await this.save(j);
    }
    if (j.verifiedCaptures < manifest.blocks.length) return this.status({ adoptionId });
    const revision = await a.studyRevision.get(adoptionId),
      exported = await a.documents.exportPdf({ url: j.board.url }, options);
    await a.recovery.assertSameContents(revision.baseline.exportId, exported.exportId, options);
    const dir = path.join(this.directory, adoptionId);
    await fs.mkdir(dir, { recursive: true });
    j.previewPath = path.join(dir, 'managed-preview.png');
    await fs.writeFile(j.previewPath, await renderStudyPreview(manifest.plan));
    revision.manifest = manifest;
    revision.status = 'completed';
    revision.finishedAt = new Date().toISOString();
    revision.adoption = {
      selectedOnly: true,
      objectCount: j.captures.length,
      unchangedExportId: exported.exportId,
    };
    await a.studyRevision.save(revision);
    j.status = 'completed';
    j.finishedAt = revision.finishedAt;
    await this.save(j);
    return this.status({ adoptionId });
  }
  async status({ adoptionId }) {
    const j = await this.get(adoptionId);
    return {
      adoptionId,
      baseId: j.status === 'completed' ? adoptionId : undefined,
      status: j.status,
      board: { url: j.board.url, title: j.board.title, itemPath: j.board.itemPath },
      source: { exportId: j.source.exportId, pageCount: j.source.pageCount },
      objects: j.captures.map((c) => ({
        blockId: c.block.id,
        kind: c.block.kind,
        role: c.block.role,
        pages: c.block.sourcePages,
        world: c.world,
      })),
      previewPath: j.previewPath,
      verifiedObjects: j.verifiedCaptures ?? 0,
      coverage:
        'Explicitly selected native text boxes and images only. Other content remains unmanaged. Adoption does not reformat content. Use the completed baseId with prepare_study_revision.',
    };
  }
}
