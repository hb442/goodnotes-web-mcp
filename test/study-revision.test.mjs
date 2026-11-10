import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import {
  planStudyLayout,
  makeStudyCard,
  auditStudyGeometry,
  studyMaterialsSchema,
} from '../src/study-layout.mjs';
import {
  planStudyRevision,
  sourceImpact,
  StudyRevisionController,
} from '../src/study-revision.mjs';
import {
  assertBlankStudyRegion,
  compareStudySurroundings,
  StudyRevisionNative,
} from '../src/study-revision-native.mjs';
import { digest, Journal } from '../src/journal.mjs';
import { writeJson } from '../src/store.mjs';
import { validateStudyImageBounds, verifyStudyImageSource } from '../src/study-native.mjs';

const source = { exportId: crypto.randomUUID(), title: 'Lecture', pageCount: 20, sha256: 'source' };
const cards = () =>
  ['summary', 'concept', 'questions', 'answers'].map((role, i) => ({
    role,
    heading: 'Card ' + i,
    body: 'Short content.',
    pages: [i + 1],
  }));
const materials = () => ({
  title: 'Lecture',
  subtitle: 'Practice and explain',
  cards: cards(),
  figures: [{ page: 1, caption: 'Original figure' }],
});
const figures = [{ filePath: 'figure.png', width: 1200, height: 400, sha256: 'figure' }];
test('study images reject blue artwork frames, undersized images and incorrect placement', () => {
  const target = { x: 235, y: 148, width: 930, height: 450 },
    fit = (450 - 8) / 450;
  const good = { x: 235 + (930 - 930 * fit) / 2, y: 152, width: 930 * fit, height: 442 };
  validateStudyImageBounds(good, target, true);
  assert.throws(
    () => validateStudyImageBounds({ x: 594, y: 157, width: 204, height: 428 }, target),
    { code: 'IMAGE_FRAME_MISMATCH' },
  );
  assert.throws(
    () =>
      validateStudyImageBounds(
        { ...good, width: good.width / 2, height: good.height / 2 },
        target,
        true,
      ),
    { code: 'IMAGE_LAYOUT_MISMATCH' },
  );
  assert.throws(() => validateStudyImageBounds({ ...good, x: good.x + 200 }, target, true), {
    code: 'IMAGE_LAYOUT_MISMATCH',
  });
});
const base = () => {
  const plan = planStudyLayout(materials(), source, figures);
  return {
    plan,
    source,
    board: {
      url: 'https://web.goodnotes.com/s/test',
      title: 'Test',
      itemPath: [crypto.randomUUID()],
    },
    blocks: plan.blocks.map((block) => ({
      block,
      checkpointPath: 'private-' + block.id,
      layout: { x: block.x, y: block.y, width: block.width, height: block.height },
    })),
  };
};
test('adaptive figures have height-based captions, three-column spans and many original diagrams', () => {
  const m = materials();
  m.layout = { columns: 3 };
  m.figures = [
    ...m.figures,
    { page: 2, span: 2, caption: 'Wide original' },
    { page: 3, caption: 'Third original' },
  ];
  const p = planStudyLayout(m, source, [...figures, ...figures, ...figures]);
  assert.equal(p.audit.valid, true);
  assert.equal(p.blocks.filter((b) => b.kind === 'image').length, 3);
  const a = p.blocks.find((b) => b.id === 'figure-0'),
    caption = p.blocks.find((b) => b.id === 'caption-0');
  assert.equal(caption.y - a.y - a.height, 48);
  assert.ok(p.blocks.find((b) => b.id === 'figure-1').width > a.width * 2);
});
test('sections keep their declared order and compact packing uses shorter column space', () => {
  const m = materials();
  m.sections = ['Basics', 'Practice'];
  m.cards.forEach((c, i) => (c.section = i < 2 ? 'Basics' : 'Practice'));
  m.figures[0].section = 'Basics';
  m.cards[0].body = 'Longer\n'.repeat(8);
  m.cards.push({ ...m.cards[0], heading: 'Follow-up', body: 'Short' });
  const p = planStudyLayout(m, source, figures),
    basics = p.blocks.find((b) => b.id === 'section-0'),
    practice = p.blocks.find((b) => b.id === 'section-1');
  assert.ok(practice.y > basics.y);
  assert.ok(
    p.blocks.find((b) => b.id === 'card-4').y <
      p.blocks.find((b) => b.id === 'card-0').y +
        p.blocks.find((b) => b.id === 'card-0').height +
        64,
  );
  assert.equal(p.audit.valid, true);
});
test('expanded schema accepts more than ten cards and rejects invalid spans and duplicate keys', () => {
  const m = materials();
  m.cards = Array.from({ length: 16 }, (_, i) => ({ ...cards()[i % 4], key: 'c' + i }));
  assert.equal(studyMaterialsSchema.safeParse(m).success, true);
  m.cards[1].key = 'c0';
  assert.equal(studyMaterialsSchema.safeParse(m).success, false);
  const wide = materials();
  wide.cards[0].span = 3;
  assert.throws(() => planStudyLayout(wide, source, figures), { code: 'INVALID_SPAN' });
});
test('one, two and three columns keep every source/card in bounds with both packing modes', () => {
  for (const columns of [1, 2, 3])
    for (const flow of ['rows', 'compact']) {
      const m = materials();
      m.layout = { columns, flow };
      m.cards = Array.from({ length: 8 }, (_, i) => ({
        ...cards()[i % 4],
        key: 'block-' + i,
        body: 'Explain this idea.\n'.repeat(1 + (i % 4)),
        span: i === 3 ? Math.min(columns, 2) : 1,
      }));
      const p = planStudyLayout(m, source, figures);
      assert.equal(p.audit.valid, true);
      const actual = p.blocks.filter((b) => b.id.startsWith('card-'));
      assert.equal(actual.length, m.cards.length);
      for (const b of actual) {
        assert.ok(b.x >= 56 && b.x + b.width <= 1344.01);
        assert.ok(b.y + b.height <= p.height);
        assert.ok(b.text.includes('Quelle: S. '));
      }
    }
});
test('selective revisions retain untouched entries and reject growth, stale IDs and collisions before writing', () => {
  const b = base(),
    id = crypto.randomUUID(),
    update = { blockId: 'card-0', heading: 'Updated', body: 'New content.', pages: [1] };
  const p = planStudyRevision(b, { updates: [update] }, source, null, id);
  assert.equal(p.steps.length, 1);
  assert.deepEqual(
    p.entries.find((e) => e.block.id === 'card-1'),
    b.blocks.find((e) => e.block.id === 'card-1'),
  );
  assert.throws(
    () => planStudyRevision(b, { updates: [{ ...update, blockId: 'absent' }] }, source, null, id),
    { code: 'UNKNOWN_BLOCK' },
  );
  assert.throws(
    () =>
      planStudyRevision(
        b,
        { updates: [{ ...update, body: 'More\n'.repeat(12) }] },
        source,
        null,
        id,
      ),
    { code: 'REVISION_CARD_TOO_TALL' },
  );
  assert.throws(
    () => planStudyRevision(b, { updates: [{ ...update, pages: [21] }] }, source, null, id),
    { code: 'INVALID_SOURCE_PAGE' },
  );
  const other = b.blocks.find((e) => e.block.id === 'card-1').block;
  assert.throws(
    () =>
      planStudyRevision(
        b,
        { moves: [{ blockId: 'card-0', x: other.x, y: other.y }] },
        source,
        null,
        id,
      ),
    { code: 'LAYOUT_CONFLICT' },
  );
  assert.throws(
    () =>
      planStudyRevision(
        b,
        { updates: [update], moves: [{ blockId: 'card-0', x: 56, y: 1000 }] },
        source,
        null,
        id,
      ),
    { code: 'DUPLICATE_UPDATE' },
  );
});
test('new sections append below existing content, with unique IDs and exact source references', () => {
  const b = base(),
    id = crypto.randomUUID(),
    addition = {
      title: 'Extra',
      subtitle: 'New section',
      cards: [{ ...cards()[0], pages: [8] }],
      figures: [],
    };
  const ap = planStudyLayout(addition, source, [], { partial: true });
  const p = planStudyRevision(b, { addition }, source, ap, id),
    newCards = p.steps.filter((s) => s.kind === 'add');
  assert.ok(newCards.every((s) => s.after.y >= b.plan.height + 64));
  assert.equal(auditStudyGeometry(p.blocks).valid, true);
  assert.ok(newCards.find((s) => s.after.role === 'summary').after.text.includes('Quelle: S. 8'));
  assert.throws(() => planStudyRevision(b, { addition, appendY: 80 }, source, ap, id), {
    code: 'ADDITION_TOO_CLOSE',
  });
});
test('source impact identifies affected page references and flags every block when page numbering shifts', () => {
  const pages = [
      { text: 'A', width: 10, height: 10 },
      { text: 'B', width: 10, height: 10 },
    ],
    blocks = [{ block: { id: 'a', sourcePages: [1] } }, { block: { id: 'b', sourcePages: [2] } }];
  const r = sourceImpact(
    { pages },
    { pages: [pages[0], { ...pages[1], text: 'Updated' }] },
    blocks,
  );
  assert.deepEqual(r.changedPages, [2]);
  assert.deepEqual(r.affectedBlocks, ['b']);
  assert.equal(r.visualReviewRequired, true);
  assert.deepEqual(
    sourceImpact({ pages }, { pages: [...pages, pages[0]] }, blocks).affectedBlocks,
    ['a', 'b'],
  );
});
function png(rect) {
  const c = createCanvas(400, 400),
    x = c.getContext('2d');
  x.fillStyle = 'white';
  x.fillRect(0, 0, 400, 400);
  if (rect) {
    x.fillStyle = 'black';
    x.fillRect(rect.x, rect.y, rect.width, rect.height);
  }
  return c.toBuffer('image/png');
}
test('original image verification rejects a changed pixel, dimensions or native crop', async () => {
  const bytes = png(),
    state = { sourceBytes: bytes, region: { x: 0, y: 0, width: 1, height: 1 } };
  assert.equal((await verifyStudyImageSource(bytes, state)).matches, true);
  await assert.rejects(
    verifyStudyImageSource(bytes, {
      ...state,
      sourceBytes: png({ x: 50, y: 50, width: 1, height: 1 }),
    }),
    { code: 'IMAGE_SOURCE_CHANGED' },
  );
  await assert.rejects(
    verifyStudyImageSource(bytes, { ...state, region: { x: 0, y: 0, width: 0.99, height: 1 } }),
    { code: 'IMAGE_SOURCE_CHANGED' },
  );
  await assert.rejects(
    verifyStudyImageSource(bytes, {
      ...state,
      sourceBytes: createCanvas(50, 60).toBuffer('image/png'),
    }),
    { code: 'IMAGE_SOURCE_CHANGED' },
  );
});
test('blank destination guard catches even tiny visible handwriting, and excludes only the original object', async () => {
  const r = { x: 40, y: 120, width: 120, height: 120 },
    ink = { x: 80, y: 150, width: 1, height: 2 };
  await assertBlankStudyRegion(png(), r);
  await assert.rejects(assertBlankStudyRegion(png(ink), r), { code: 'DESTINATION_NOT_EMPTY' });
  await assertBlankStudyRegion(png(ink), r, [ink]);
  await assert.rejects(assertBlankStudyRegion(png(), { ...r, x: 390 }), {
    code: 'REGION_NOT_VISIBLE',
  });
});
test('native dotted background is allowed but tiny added gray or black marks still stop writes', async () => {
  const c = createCanvas(400, 500),
    ctx = c.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 400, 500);
  for (let y = 15; y < 500; y += 25)
    for (let x = 19; x < 400; x += 25) {
      ctx.fillStyle = '#f2f2f2';
      ctx.fillRect(x, y, 2, 1);
      ctx.fillStyle = '#e2e2e2';
      ctx.fillRect(x, y + 1, 2, 1);
      ctx.fillStyle = '#f0f0f0';
      ctx.fillRect(x, y + 2, 2, 1);
    }
  const r = { x: 40, y: 120, width: 150, height: 150 };
  await assertBlankStudyRegion(c.toBuffer('image/png'), r);
  ctx.fillStyle = '#e2e2e2';
  ctx.fillRect(82, 151, 1, 1);
  await assert.rejects(assertBlankStudyRegion(c.toBuffer('image/png'), r), {
    code: 'DESTINATION_NOT_EMPTY',
  });
  ctx.fillStyle = 'white';
  ctx.fillRect(82, 151, 1, 1);
  ctx.fillStyle = 'black';
  ctx.fillRect(69, 141, 1, 1);
  await assert.rejects(assertBlankStudyRegion(c.toBuffer('image/png'), r), {
    code: 'DESTINATION_NOT_EMPTY',
  });
});
test('surroundings verification allows planned changes but rejects changes to an unrelated note', async () => {
  const note = { x: 40, y: 140, width: 30, height: 30 },
    elsewhere = { x: 250, y: 250, width: 40, height: 25 },
    canvas = { x: 0, y: 48, width: 400, height: 352 };
  await compareStudySurroundings(png(), png(note), canvas, [note]);
  await assert.rejects(compareStudySurroundings(png(), png(elsewhere), canvas, [note]), {
    code: 'SURROUNDINGS_CHANGED',
  });
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goodnotes-revision-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const receipts = new Map(),
    b = base();
  let writes = 0;
  const a = {
    config: { directory },
    journal: { get: async (id) => receipts.get(id) ?? { status: 'not-found' } },
  };
  const c = new StudyRevisionController(a),
    revisionId = crypto.randomUUID();
  const plan = planStudyRevision(
    b,
    { updates: [{ blockId: 'card-0', heading: 'Update', body: 'Revised.', pages: [1] }] },
    source,
    null,
    revisionId,
  );
  const j = {
    revisionId,
    input: { baseId: crypto.randomUUID() },
    base: b,
    source,
    board: { ...b.board, planHash: digest(plan) },
    plan,
    planHash: digest(plan),
    startedAt: new Date().toISOString(),
    status: 'planned',
    timings: [],
    steps: [
      { ...plan.steps[0], status: 'pending', operationId: 'revision-test-update' },
      { id: 'audit', kind: 'audit', status: 'pending', operationId: 'revision-test-audit' },
    ],
  };
  c.native.apply = async () => {
    writes++;
    return { verified: true, checkpointPath: 'new', layout: plan.steps[0].after };
  };
  c.audit = async () => ({ verified: true, previewPath: 'actual.png' });
  await c.save(j);
  return { a, c, j, receipts, writes: () => writes, directory };
}
test('revision resumes verified receipts without duplicate edits and completion is stable across processes', async (t) => {
  const f = await fixture(t);
  f.receipts.set('revision-test-update', { status: 'verified', result: { verified: true } });
  f.j.steps[0].status = 'running';
  await f.c.save(f.j);
  await f.c.run({ revisionId: f.j.revisionId });
  assert.equal(f.writes(), 0);
  const result = await f.c.run({ revisionId: f.j.revisionId });
  assert.equal(result.status, 'completed');
  const fresh = new StudyRevisionController(f.a);
  assert.equal((await fresh.run({ revisionId: f.j.revisionId })).status, 'completed');
  assert.equal(f.writes(), 0);
});
test('uncertain revisions stop, reconcile only matching evidence and retain old receipts', async (t) => {
  const f = await fixture(t),
    receipt = { status: 'uncertain' };
  f.receipts.set('revision-test-update', receipt);
  assert.equal((await f.c.run({ revisionId: f.j.revisionId })).status, 'needs-review');
  assert.equal(f.writes(), 0);
  f.c.native.verify = async () => ({ verified: true });
  await f.c.review({ revisionId: f.j.revisionId });
  assert.equal((await f.c.run({ revisionId: f.j.revisionId })).status, 'completed');
  assert.deepEqual(f.receipts.get('revision-test-update'), receipt);
});
test('altered revision plans stop execution and reconciliation', async (t) => {
  const f = await fixture(t);
  f.j.plan.steps[0].after.text = 'tampered';
  await f.c.save(f.j);
  await assert.rejects(f.c.run({ revisionId: f.j.revisionId }), { code: 'PLAN_CHANGED' });
  await assert.rejects(f.c.review({ revisionId: f.j.revisionId }), { code: 'PLAN_CHANGED' });
  assert.equal(f.writes(), 0);
});
test('review permits a fresh bounded attempt only after a proven no-write rejection', async (t) => {
  const f = await fixture(t),
    receipt = {
      status: 'rejected',
      result: { mayHaveWritten: false, code: 'DESTINATION_NOT_EMPTY' },
    };
  f.receipts.set('revision-test-update', receipt);
  await f.c.run({ revisionId: f.j.revisionId });
  await f.c.review({ revisionId: f.j.revisionId });
  const j = await f.c.get(f.j.revisionId);
  assert.equal(j.steps[0].status, 'pending');
  assert.equal(j.steps[0].operationId, 'revision-test-update-r1');
  assert.equal(f.writes(), 0);
  assert.deepEqual(f.receipts.get('revision-test-update'), receipt);
  await f.c.run({ revisionId: f.j.revisionId });
  assert.equal(f.writes(), 1);
});
test('a changed managed card stops before native edit input and records a no-write rejection', async (t) => {
  const f = await fixture(t),
    checkpoint = path.join(f.directory, 'original.json');
  await writeJson(checkpoint, { blockId: 'card-0' });
  let writes = 0;
  const a = {
    config: { directory: f.directory },
    journal: new Journal(f.directory),
    study: {
      native: {
        verifyEvidence: async () => {
          throw Object.assign(Error('Manual edit detected'), { code: 'TEXT_CONFLICT' });
        },
      },
    },
  };
  const native = new StudyRevisionNative(a);
  a.text = { edit: async () => writes++ };
  await assert.rejects(
    native.apply(
      f.j.board,
      { ...f.j.plan.steps[0], checkpointPath: checkpoint },
      'conflict-check-operation',
    ),
    { code: 'TEXT_CONFLICT' },
  );
  assert.equal(writes, 0);
  const receipt = await a.journal.get('conflict-check-operation');
  assert.equal(receipt.status, 'rejected');
  assert.equal(receipt.result.mayHaveWritten, false);
});
test('unknown partial revisions cannot be reconciled without a completed checkpoint', async (t) => {
  const f = await fixture(t),
    native = new StudyRevisionNative(f.a);
  await assert.rejects(native.verify(f.j.board, f.j.plan.steps[0], 'missing-revision-checkpoint'), {
    code: 'NO_VERIFICATION_CHECKPOINT',
  });
});
test('inspected repairs require verified receipts and retain original evidence and repair history', async (t) => {
  const f = await fixture(t),
    native = new StudyRevisionNative(f.a),
    step = f.j.plan.steps[0],
    operationId = 'inspected-repair-guard';
  const guard = {
    url: f.j.board.url,
    planHash: f.j.board.planHash,
    step,
    result: { original: true },
  };
  await writeJson(native.file(operationId), guard);
  await assert.rejects(
    native.recordInspectedRepair(
      f.j.board,
      step,
      operationId,
      'repair-operation',
      'repair-checkpoint',
    ),
    { code: 'REPAIR_UNVERIFIED' },
  );
  f.receipts.set('repair-operation', { status: 'verified' });
  f.a.study = {
    native: { verify: async (_b, _s, id) => ({ checkpointPath: id, verified: true }) },
  };
  native.checkSurroundings = async () => ({ matches: true });
  await native.recordInspectedRepair(
    f.j.board,
    step,
    operationId,
    'repair-operation',
    'repair-checkpoint',
  );
  await native.recordInspectedRepair(
    f.j.board,
    step,
    operationId,
    'repair-operation',
    'persisted-repair-checkpoint',
  );
  const saved = JSON.parse(await fs.readFile(native.file(operationId), 'utf8'));
  assert.deepEqual(saved.result, guard.result);
  assert.equal(saved.repairHistory[0].checkpointOperationId, 'repair-checkpoint');
  assert.equal(saved.repair.checkpointOperationId, 'persisted-repair-checkpoint');
});
async function preparation(t) {
  const f = await fixture(t),
    b = base();
  let calls = 0;
  f.c.base = async () => b;
  f.a.config.documents = [{ url: b.board.url, title: b.board.title }];
  f.a.openItem = async () => b.board;
  f.a.documents = {
    exportPdf: async ({ url }) => ({
      exportId: url.endsWith('/copy') ? 'copy-pdf' : 'original-pdf',
      url,
      pageCount: 1,
    }),
  };
  f.a.recovery = {
    assertSameContents: async (left, right) => {
      assert.equal(left, 'original-pdf');
      assert.equal(right, 'copy-pdf');
    },
  };
  f.a.library = {
    manage: async (args) => {
      calls++;
      const result = {
        verified: true,
        url: 'https://web.goodnotes.com/s/copy',
        title: args.title,
        itemPath: [crypto.randomUUID()],
      };
      f.receipts.set(args.operationId, { status: 'verified', result });
      return result;
    },
  };
  f.a.inspect = async ({ url }) => ({ url, title: url.endsWith('/copy') ? 'Copy' : b.board.title });
  f.a.scans = { anchor: async () => ({ pageId: 'copy-page' }) };
  f.a.getPage = async () => ({});
  const input = {
    baseId: crypto.randomUUID(),
    title: 'Copy',
    copy: true,
    requestId: 'stable-revision-copy',
  };
  return { ...f, b, input, calls: () => calls };
}
test('revision preparation creates one independently checked copy and rejects a different identity', async (t) => {
  const f = await preparation(t),
    first = await f.c.prepare(f.input),
    second = await f.c.prepare(f.input);
  assert.equal(first.revisionId, second.revisionId);
  assert.equal(f.calls(), 1);
  assert.equal(first.board.url, 'https://web.goodnotes.com/s/copy');
  await assert.rejects(f.c.prepare({ ...f.input, title: 'Different' }), {
    code: 'REQUEST_CONFLICT',
  });
  f.a.openItem = async () => ({ ...f.b.board, url: 'https://web.goodnotes.com/s/wrong' });
  await assert.rejects(f.c.prepare({ ...f.input, requestId: 'wrong-identity-request' }), {
    code: 'BOARD_CHANGED',
  });
  assert.equal(f.calls(), 1);
});
test('lost copy results never trigger another duplication, while explicit no-write rejection permits bounded recovery', async (t) => {
  const f = await preparation(t);
  let attempts = 0;
  f.a.library.manage = async () => {
    attempts++;
    throw Error('lost result');
  };
  await assert.rejects(f.c.prepare(f.input), /lost result/);
  await assert.rejects(f.c.prepare(f.input), { code: 'REVIEW_REQUIRED' });
  assert.equal(attempts, 1);
  const g = await preparation(t);
  let dispatched = 0;
  const success = g.a.library.manage;
  g.a.library.manage = async (args) => {
    if (!dispatched++) {
      g.receipts.set(args.operationId, {
        status: 'rejected',
        result: { mayHaveWritten: false, code: 'ITEM_NOT_FOUND' },
      });
      throw Error('before click');
    }
    return success(args);
  };
  await assert.rejects(g.c.prepare(g.input), /before click/);
  const done = await g.c.prepare(g.input);
  const saved = await g.c.get(done.revisionId);
  assert.equal(saved.copyHistory.length, 1);
  assert.equal(saved.copyAttempt, 1);
  assert.equal(g.calls(), 1);
  assert.equal(g.receipts.get(saved.copyHistory[0].operationId).status, 'rejected');
});
test('in-place revision retains a verified independent native backup and targets the allowed original', async (t) => {
  const f = await preparation(t),
    r = await f.c.prepare({ ...f.input, copy: false });
  assert.equal(r.board.url, f.b.board.url);
  assert.equal(r.backup.url, 'https://web.goodnotes.com/s/copy');
  assert.equal(f.calls(), 1);
  const g = await preparation(t);
  g.a.config.documents = [];
  await assert.rejects(g.c.prepare({ ...g.input, copy: false }), { code: 'WRITE_NOT_ALLOWED' });
  assert.equal(g.calls(), 0);
});
