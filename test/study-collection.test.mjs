import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  partitionStudyCollection,
  linkCollectionPlans,
  linkedCard,
  StudyCollectionController,
} from '../src/study-collection.mjs';
import { adoptionManifest, BoardAdoptionController } from '../src/board-adoption.mjs';
import { digest } from '../src/journal.mjs';
import {
  verifyStudyImageSource,
  StudyNativeController,
  verifyStudyLinks,
  studyImageStaging,
  resizeStudyImage,
  validateStudyImageBounds,
} from '../src/study-native.mjs';
import { createCanvas } from '@napi-rs/canvas';
const source = { exportId: crypto.randomUUID(), sha256: 'source', pageCount: 50, title: 'Lecture' };
test('image placement accepts the reserved slot, rejects undersizing, overflow and displacement', () => {
  const target = { x: 235.04531722054378, y: 148, width: 929.9093655589124, height: 450 };
  for (const actual of [
    { x: 244, y: 147, width: 926, height: 449 },
    { x: 244, y: 147, width: 901, height: 437 },
  ])
    assert.doesNotThrow(() => validateStudyImageBounds(actual, target, true));
  for (const actual of [
    { x: 244, y: 147, width: 890, height: 430 },
    { x: 244, y: 147, width: 950, height: 460 },
    { x: 285, y: 148, width: 926, height: 449 },
  ])
    assert.throws(() => validateStudyImageBounds(actual, target, true), {
      code: 'IMAGE_LAYOUT_MISMATCH',
    });
  assert.throws(
    () => validateStudyImageBounds({ x: 244, y: 147, width: 926, height: 390 }, target, true),
    { code: 'IMAGE_FRAME_MISMATCH' },
  );
});
test('image sizing crosses native drag threshold and corrects measured frame before release', async () => {
  let frame = { x: 240, y: 148, width: 926, height: 448 };
  let held = false,
    active = false,
    pointer,
    origin,
    released = 0,
    snapshots = 0;
  const page = {
    waitForTimeout: async () => {},
    mouse: {
      move: async (x, y) => {
        if (held) {
          if (!active && Math.hypot(x - origin.x, y - origin.y) < 24) return;
          // The first accepted event can lose a drag threshold's displacement.
          const dx = (x - pointer.x) * (active ? 1 : 0.25);
          frame = { ...frame, width: frame.width + dx, height: ((frame.width + dx) * 448) / 926 };
          active = true;
        }
        pointer = { x, y };
      },
      down: async () => {
        held = true;
        origin = { ...pointer };
      },
      up: async () => {
        held = false;
        released++;
      },
    },
  };
  const objects = {
    validateBounds: (b) => {
      assert.ok(b.width > 0 && b.x + b.width < 1400);
    },
    snapshot: async () => {
      assert.equal(held, true);
      snapshots++;
      return { bounds: { ...frame } };
    },
  };
  const target = { width: 929.909, height: 450 };
  const actual = await resizeStudyImage(objects, page, {}, frame, target, target);
  assert.ok(Math.abs(actual.width - target.width * (442 / 450)) <= 4);
  assert.ok(Math.abs(actual.height - 442) <= 4);
  assert.ok(snapshots >= 2);
  assert.equal(released, 1);
});
test('image sizing releases the pointer when a live frame cannot be read', async () => {
  let released = false;
  const page = {
    waitForTimeout: async () => {},
    mouse: {
      move: async () => {},
      down: async () => {},
      up: async () => {
        released = true;
      },
    },
  };
  await assert.rejects(
    resizeStudyImage(
      {
        validateBounds() {},
        snapshot: async () => {
          throw Error('frame unavailable');
        },
      },
      page,
      {},
      { x: 240, y: 148, width: 400, height: 200 },
      { width: 900, height: 450 },
      { width: 900, height: 450 },
    ),
    /frame unavailable/,
  );
  assert.equal(released, true);
});
const materials = () => ({
  title: 'Lecture',
  subtitle: 'Read and practice',
  cards: Array.from({ length: 30 }, (_, i) => ({
    key: 'c' + i,
    role: ['summary', 'questions', 'answers'][i % 3],
    heading: 'Card ' + i,
    body: 'Explain the source in your own words.\nThen solve the practice problem.',
    pages: [i + 1],
  })),
  figures: Array.from({ length: 6 }, (_, i) => ({
    key: 'f' + i,
    page: i + 1,
    caption: 'Original figure ' + i,
  })),
});
const figures = () =>
  Array.from({ length: 6 }, (_, i) => ({
    filePath: 'figure-' + i + '.png',
    width: 1200,
    height: 600,
    sha256: 'hash-' + i,
  }));
test('collection partitions without dropping, duplicating or separating figure captions; every plan fits', () => {
  const p = partitionStudyCollection(materials(), source, figures(), {
    maxHeight: 1800,
    maxBlocks: 10,
  });
  assert.ok(p.parts.length > 2);
  const ids = p.parts
    .flatMap((p) => p.plan.blocks.map((b) => b.id))
    .filter((id) => id.startsWith('card-') || id.startsWith('figure-'));
  assert.equal(ids.length, 36);
  assert.equal(new Set(ids).size, 36);
  for (const part of p.parts) {
    assert.ok(part.plan.height + 284 <= 1800);
    assert.ok(part.plan.blocks.length + 1 <= 10);
    for (const f of part.materials.figures)
      assert.ok(part.plan.blocks.some((b) => b.id === 'caption-' + f.key));
  }
  assert.deepEqual(
    p.parts.flatMap((p) => p.materials.cards).map((c) => c.key),
    materials().cards.map((c) => c.key),
  );
});
test('navigation resolves short exact ranges to real neighbors and keeps layout limits', () => {
  const p = partitionStudyCollection(materials(), source, figures()),
    urls = p.parts.map((_, i) => 'https://web.goodnotes.com/s/part' + i),
    plans = linkCollectionPlans(
      p.parts.map((p) => p.plan),
      urls,
      'https://web.goodnotes.com/s/index',
    );
  for (const [i, plan] of plans.entries()) {
    const nav = plan.blocks.at(-1);
    assert.equal(nav.links[0].url, 'https://web.goodnotes.com/s/index');
    for (const l of nav.links) assert.ok(plan.blocks.at(-1).text.slice(l.start, l.end).length > 2);
    assert.ok(plan.audit.valid);
    assert.ok(plan.height <= p.limits.maxHeight);
    if (i > 0) assert.equal(nav.links[1].url, urls[i - 1]);
  }
  assert.throws(
    () => linkedCard('x', 'X', [{ label: 'Bad', url: 'javascript:alert(1)' }], 56, 80),
    { code: 'INVALID_LINK' },
  );
});
test('bad references, duplicate keys, huge blocks and too many parts fail before mutation', () => {
  const m = materials();
  m.cards[0].pages = [51];
  assert.throws(() => partitionStudyCollection(m, source, figures()), {
    code: 'INVALID_SOURCE_PAGE',
  });
  const duplicate = materials();
  duplicate.cards[1].key = duplicate.cards[0].key;
  assert.throws(() => partitionStudyCollection(duplicate, source, figures()));
  assert.throws(
    () =>
      partitionStudyCollection(materials(), source, figures(), {
        maxHeight: 1600,
        maxBlocks: 6,
        maxParts: 2,
      }),
    { code: 'TOO_MANY_PARTS' },
  );
  const tall = materials();
  tall.cards[0].body = Array(25).fill('Line').join('\n');
  assert.throws(() => partitionStudyCollection(tall, source, figures()), { code: 'CARD_TOO_TALL' });
});
test('adoption retains original world coordinates, wide layouts, source and unknown neighbors', () => {
  const board = { canvas: { x: 0, y: 40 }, anchor: { scale: 1, pageId: 'page' } },
    captures = [
      {
        world: { x: -300, y: 800, width: 600, height: 200 },
        block: { id: 'a', kind: 'text', text: 'Exact text' },
      },
      { world: { x: 1400, y: 1300, width: 600, height: 400 }, block: { id: 'b', kind: 'image' } },
    ];
  const m = adoptionManifest(board, source, captures);
  assert.ok(m.board.horizontalPan);
  assert.ok(m.plan.width > 1400);
  assert.equal(m.blocks[0].block.x + m.board.worldOrigin.x, -300);
  assert.equal(m.blocks[1].block.y + m.board.worldOrigin.y, 1300);
  assert.equal(m.blocks.length, 2);
  assert.equal(m.source, source);
  assert.throws(() => adoptionManifest(board, source, []), { code: 'NO_ADOPTED_OBJECTS' });
  assert.throws(
    () => adoptionManifest(board, source, [captures[0], { ...captures[0], block: { id: 'b' } }]),
    { code: 'ADOPTION_OVERLAP' },
  );
});
test('adopted image crop is verified exactly, while changed crops or pixels reject', async () => {
  const c = createCanvas(200, 100);
  c.getContext('2d').fillRect(0, 0, 200, 100);
  const bytes = c.toBuffer('image/png'),
    crop = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
  assert.ok(
    (await verifyStudyImageSource(bytes, { sourceBytes: bytes, region: crop }, crop)).matches,
  );
  await assert.rejects(
    verifyStudyImageSource(bytes, { sourceBytes: bytes, region: { ...crop, x: 0.2 } }, crop),
    { code: 'IMAGE_SOURCE_CHANGED' },
  );
});
test('native writer rejects invalid links before positioning or mutation', async () => {
  let touched = false;
  const c = new StudyNativeController({ config: { directory: 'unused' } });
  c.position = async () => {
    touched = true;
  };
  await assert.rejects(
    c.create(
      {},
      { text: 'Link', links: [{ start: 0, end: 4, url: 'javascript:bad' }] },
      'unused-operation',
    ),
    { code: 'INVALID_LINK' },
  );
  assert.equal(touched, false);
});
test('adopted objects at the first layout row stay below the native move toolbar guard', async () => {
  const board = {
      url: 'https://web.goodnotes.com/s/SyntheticBoard',
      title: 'Copy',
      adopted: true,
      horizontalPan: true,
      canvas: { x: 0, y: 48 },
      anchor: { x: -1000, y: -2000 },
    },
    view = { title: board.title, url: board.url };
  let target;
  const n = new StudyNativeController({
    config: { directory: 'unused', documents: [view] },
    scans: {
      position: async (url, t) => {
        target = t;
        return { view: { viewId: 'view' }, page: {} };
      },
    },
    getView: () => view,
  });
  const result = await n.position(board, { x: 56, y: 80, width: 574, height: 455 });
  assert.equal(result.rect.y, 148);
  assert.equal(target.y, -1980);
  assert.ok(result.rect.y >= 130);
});
test('a centered wide image is moved before growth can push its right edge outside the viewport', () => {
  const initial = { x: 552, y: 435, width: 336, height: 163 },
    target = { x: 235, y: 148, width: 930, height: 450 },
    viewport = { width: 1440, height: 1000 },
    s = studyImageStaging(initial, target, viewport);
  assert.ok(initial.x + initial.width * s.ratio > viewport.width);
  assert.ok(s.x + s.width * s.ratio < viewport.width - 10);
  assert.ok(s.y + s.height * s.ratio < viewport.height - 40);
  assert.ok(s.y >= 130);
  const smaller = studyImageStaging(
    { x: 100, y: 180, width: 1100, height: 600 },
    { x: 1000, y: 600, width: 300, height: 180 },
    viewport,
  );
  assert.ok(smaller.x + 1100 <= 1420);
  assert.ok(smaller.y + 600 <= 950);
  assert.throws(
    () => studyImageStaging({ x: 0, y: 0, width: 1400, height: 900 }, target, viewport),
    { code: 'IMAGE_SCALE_UNSUPPORTED' },
  );
});
test('native links require complete exact destination coverage, including fragmented runs', () => {
  const b = { id: 'nav', links: [{ start: 3, end: 9, url: 'https://example.test/right' }] };
  verifyStudyLinks(b, [
    { start: 3, end: 5, link: b.links[0].url },
    { start: 5, end: 9, link: b.links[0].url },
  ]);
  for (const runs of [
    [{ start: 3, end: 9, link: 'https://example.test/wrong' }],
    [{ start: 4, end: 9, link: b.links[0].url }],
    [
      { start: 3, end: 5, link: b.links[0].url },
      { start: 6, end: 9, link: b.links[0].url },
    ],
    [],
  ])
    assert.throws(() => verifyStudyLinks(b, runs), { code: 'LINK_UNVERIFIED' });
});
test('adoption refuses capture on a different board before reading or changing content', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goodnotes-adoption-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let reads = 0;
  const a = {
    config: { directory },
    styles: {
      selection: async () => ({ s: {}, view: { url: 'wrong', title: 'Copy', zoom: '100%' } }),
    },
    readText: async () => {
      reads++;
    },
  };
  const c = new BoardAdoptionController(a),
    id = crypto.randomUUID();
  await c.save({
    adoptionId: id,
    status: 'capturing',
    captures: [],
    source,
    board: { url: 'correct', title: 'Copy' },
  });
  await assert.rejects(
    c.capture({
      adoptionId: id,
      selectionId: crypto.randomUUID(),
      key: 'one',
      kind: 'text',
      pages: [1],
      expectedText: 'Exact',
    }),
    { code: 'WRONG_ADOPTION_VIEW' },
  );
  assert.equal(reads, 0);
});
test('adoption finalization is bounded and cannot complete if the complete copy changed', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goodnotes-adoption-finish-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let verified = 0,
    saves = 0,
    compares = 0;
  const a = {
    config: { directory },
    study: {
      native: {
        verifyEvidence: async () => {
          verified++;
        },
      },
    },
    studyRevision: {
      get: async () => ({ baseline: { exportId: 'before' } }),
      save: async () => {
        saves++;
      },
    },
    documents: { exportPdf: async () => ({ exportId: 'after' }) },
    recovery: {
      assertSameContents: async () => {
        compares++;
        throw Object.assign(Error('changed'), { code: 'COPY_CHANGED' });
      },
    },
  };
  const c = new BoardAdoptionController(a),
    id = crypto.randomUUID(),
    checkpointPath = path.join(directory, 'checkpoint.json');
  await fs.writeFile(checkpointPath, '{}');
  await c.save({
    adoptionId: id,
    status: 'capturing',
    source,
    board: { url: 'copy', canvas: { x: 0, y: 48 }, anchor: {} },
    captures: Array.from({ length: 4 }, (_, i) => ({
      world: { x: 56, y: 80 + i * 250, width: 600, height: 180 },
      block: { id: 'b' + i, kind: 'text' },
      checkpointPath,
    })),
  });
  const first = await c.finish({ adoptionId: id });
  assert.equal(first.status, 'verifying');
  assert.equal(verified, 3);
  assert.equal(compares, 0);
  await assert.rejects(c.finish({ adoptionId: id }), { code: 'COPY_CHANGED' });
  assert.equal(verified, 4);
  assert.equal(compares, 1);
  assert.equal(saves, 0);
  assert.notEqual((await c.get(id)).status, 'completed');
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goodnotes-collection-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const receipts = new Map();
  let writes = 0;
  const a = {
    config: { directory },
    journal: { get: async (id) => receipts.get(id) ?? { status: 'not-found' } },
    library: {
      create: async () => {
        writes++;
        return { url: 'https://web.goodnotes.com/s/new', title: 'Part' };
      },
    },
    study: {
      bindBoard: async (j, r) => {
        j.board = { ...r };
      },
    },
  };
  const c = new StudyCollectionController(a),
    j = {
      collectionId: crypto.randomUUID(),
      input: { folderPath: [] },
      source,
      status: 'planned',
      parts: [],
      materials: {},
      limits: {},
      creations: [
        {
          title: 'Part',
          workflowId: crypto.randomUUID(),
          operationId: 'collection-test-create',
          status: 'pending',
        },
      ],
    };
  j.planHash = digest({ parts: j.parts, materials: j.materials, limits: j.limits });
  await c.save(j);
  return { a, c, j, receipts, writes: () => writes };
}
test('collection recovers a verified creation after a crash without another board', async (t) => {
  const f = await fixture(t);
  f.j.creations[0].status = 'running';
  await f.c.save(f.j);
  f.receipts.set('collection-test-create', {
    status: 'verified',
    result: { url: 'https://web.goodnotes.com/s/existing', title: 'Part' },
  });
  const r = await f.c.run({ collectionId: f.j.collectionId });
  assert.equal(f.writes(), 0);
  assert.equal(r.creations[0].status, 'verified');
});
test('collection never repeats uncertain creation and rejects changed frozen plans', async (t) => {
  const f = await fixture(t);
  f.receipts.set('collection-test-create', { status: 'uncertain' });
  assert.equal((await f.c.run({ collectionId: f.j.collectionId })).status, 'needs-review');
  await assert.rejects(f.c.review({ collectionId: f.j.collectionId }), { code: 'REVIEW_REQUIRED' });
  assert.equal(f.writes(), 0);
  f.j.materials.changed = true;
  await f.c.save(f.j);
  await assert.rejects(f.c.run({ collectionId: f.j.collectionId }), { code: 'PLAN_CHANGED' });
});
test('restarting child installation preserves executed steps and rejects changed definitions', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goodnotes-children-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const saved = new Map();
  let saves = 0;
  const a = {
    config: { directory },
    study: {
      directory: path.join(directory, 'boards'),
      get: async (id) => {
        if (!saved.has(id)) throw Object.assign(Error('missing'), { code: 'STUDY_NOT_FOUND' });
        return saved.get(id);
      },
      save: async (child) => {
        saves++;
        saved.set(child.workflowId, structuredClone(child));
      },
    },
  };
  const c = new StudyCollectionController(a),
    plan = { width: 1400, height: 300, blocks: [] },
    child = {
      workflowId: crypto.randomUUID(),
      plan,
      planHash: digest(plan),
      board: { planHash: digest(plan) },
      steps: [{ status: 'pending' }],
    },
    j = { children: [child] };
  await c.installChildren(j);
  saved.get(child.workflowId).steps[0].status = 'verified';
  await c.installChildren(j);
  assert.equal(saves, 1);
  assert.equal(saved.get(child.workflowId).steps[0].status, 'verified');
  child.plan.height = 301;
  await assert.rejects(c.installChildren(j), { code: 'CHILD_PLAN_CHANGED' });
  assert.equal(saves, 1);
});
test('repeated preparation reports saved collection status instead of resetting its source status', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goodnotes-collection-prepare-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const id = crypto.randomUUID(),
    c = new StudyCollectionController({
      config: { directory },
      study: { prepare: async () => ({ workflowId: id, status: 'needs-materials', source }) },
    });
  assert.equal((await c.prepare({ title: 'Lecture' })).status, 'needs-materials');
  const j = await c.get(id);
  j.status = 'completed';
  await c.save(j);
  assert.equal((await c.prepare({ title: 'Lecture' })).status, 'completed');
  assert.equal((await c.get(id)).status, 'completed');
});
