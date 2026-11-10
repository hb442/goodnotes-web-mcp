import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  studyMaterialsSchema,
  planStudyLayout,
  auditStudyGeometry,
  wrapStudyText,
} from '../src/study-layout.mjs';
import { StudyBoardController } from '../src/study-board.mjs';
import { digest } from '../src/journal.mjs';

const material = () => ({
  title: 'Oligopol',
  subtitle: 'Verstehen, rechnen, selbst prüfen',
  cards: ['summary', 'concept', 'questions', 'answers'].map((role, i) => ({
    role,
    heading: 'Karte ' + i,
    body: 'Preis und Menge\nP₁* = 3 + P₂ / 6\nMehrere Anbieter reagieren aufeinander.',
    pages: [1, 2],
  })),
  figures: [{ page: 2, caption: 'Originaldiagramm der Vorlesung.' }],
});
const source = {
  pageCount: 11,
  title: '09 Oligopol',
  sha256: 'source-hash',
  exportId: crypto.randomUUID(),
};
const figures = [{ filePath: 'figure.png', width: 1200, height: 700, sha256: 'figure-hash' }];
test('study layout keeps sources, original figures and all learning roles in separated slots', () => {
  const p = planStudyLayout(material(), source, figures);
  assert.equal(p.audit.valid, true);
  assert.equal(p.blocks.length, 7);
  assert.ok(p.blocks.find((b) => b.id === 'card-0').text.endsWith('Quelle: S. 1, 2'));
  assert.equal(p.blocks.find((b) => b.kind === 'image').sha256, 'figure-hash');
  assert.equal(p.source.sha256, source.sha256);
  const image = p.blocks.find((b) => b.kind === 'image');
  const caption = p.blocks.find((b) => b.id === 'caption-0');
  // Native text frames can extend 24px above the visible reserved card.
  assert.ok(caption.y - 24 - (image.y + image.height) >= 18);
  assert.deepEqual(wrapStudyText('A\n\nP₁* = 3', 500, 18), ['A', '', 'P₁* = 3']);
});
test('layout refuses missing exercises, invalid crops, excessive text and references beyond source', () => {
  const m = material();
  m.cards[2].role = 'concept';
  assert.equal(studyMaterialsSchema.safeParse(m).success, false);
  const c = material();
  c.figures[0].crop = { x: 0.9, y: 0, width: 0.2, height: 1 };
  assert.equal(studyMaterialsSchema.safeParse(c).success, false);
  const bad = material();
  bad.cards[0].pages = [12];
  assert.throws(() => planStudyLayout(bad, source, figures), { code: 'INVALID_SOURCE_PAGE' });
  const tall = material();
  tall.cards[0].body = Array(25).fill('Eine Zeile').join('\n');
  assert.throws(() => planStudyLayout(tall, source, figures), { code: 'CARD_TOO_TALL' });
  assert.throws(() => wrapStudyText('X'.repeat(200), 200, 18), { code: 'LAYOUT_WORD_TOO_WIDE' });
  assert.throws(() => planStudyLayout(material(), source, []), { code: 'FIGURE_COUNT_MISMATCH' });
});
test('actual geometry catches overlaps, small gaps, missing evidence and board overflow', () => {
  const b = { id: 'a', x: 56, y: 80, width: 600, height: 100 };
  for (const next of [
    { id: 'b', x: 600, y: 80, width: 600, height: 100 },
    { id: 'b', x: 56, y: 190, width: 600, height: 100 },
    { id: 'b' },
    { id: 'b', x: 1350, y: 500, width: 100, height: 100 },
  ])
    assert.equal(auditStudyGeometry([b, next]).valid, false);
  assert.equal(auditStudyGeometry([b, { ...b, id: 'b', y: 220 }]).valid, true);
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goodnotes-study-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const receipts = new Map();
  let writes = 0;
  const adapter = {
    config: { directory },
    journal: { get: async (id) => receipts.get(id) ?? { status: 'not-found' } },
    library: {
      create: async () => {
        writes++;
        return { url: 'https://web.goodnotes.com/s/test', title: 'copy' };
      },
    },
  };
  const c = new StudyBoardController(adapter);
  c.bindBoard = async (j, r) => {
    j.board = { ...r, planHash: j.planHash };
  };
  c.native.create = async () => {
    writes++;
    return { verified: true, layout: { x: 56, y: 80, width: 600, height: 100 } };
  };
  c.audit = async () => ({ verified: true });
  const plan = { blocks: [{ id: 'card', kind: 'text', text: 'source-based' }] };
  const j = {
    workflowId: crypto.randomUUID(),
    input: { title: 'copy', folderPath: [] },
    startedAt: new Date().toISOString(),
    timings: [],
    status: 'planned',
    plan,
    planHash: digest(plan),
    steps: [
      { id: 'create', kind: 'create', operationId: 'study-test-create', status: 'pending' },
      { id: 'card', kind: 'block', operationId: 'study-test-card', status: 'pending' },
      { id: 'audit', kind: 'audit', operationId: 'study-test-audit', status: 'pending' },
    ],
  };
  await c.save(j);
  return { c, j, adapter, receipts, writes: () => writes };
}
test('completed workflow resumes without repeating writes and retains duration evidence', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) await f.c.run({ workflowId: f.j.workflowId });
  const r = await f.c.run({ workflowId: f.j.workflowId });
  assert.equal(r.status, 'completed');
  assert.equal(f.writes(), 2);
  assert.equal(r.timings.length, 3);
  assert.ok(r.elapsedMs >= 0);
});
test('a crash after a verified creation recovers its receipt without creating another board', async (t) => {
  const f = await fixture(t);
  f.j.steps[0].status = 'running';
  await f.c.save(f.j);
  f.receipts.set('study-test-create', { status: 'verified', result: { url: 'existing' } });
  const r = await f.c.run({ workflowId: f.j.workflowId });
  assert.equal(f.writes(), 0);
  assert.equal(r.board.url, 'existing');
  assert.equal(r.steps[0].status, 'verified');
});
test('uncertain mutation never replays; independent read reconciliation preserves its receipt', async (t) => {
  const f = await fixture(t);
  await f.c.run({ workflowId: f.j.workflowId });
  const receipt = { status: 'uncertain' };
  f.receipts.set('study-test-card', receipt);
  let r = await f.c.run({ workflowId: f.j.workflowId });
  assert.equal(r.status, 'needs-review');
  assert.equal(f.writes(), 1);
  let verified = 0;
  f.c.native.verify = async () => {
    verified++;
    return { layout: { x: 56, y: 80, width: 600, height: 100 } };
  };
  r = await f.c.review({ workflowId: f.j.workflowId });
  assert.equal(r.steps[1].status, 'reconciled');
  assert.equal(verified, 1);
  assert.deepEqual(f.receipts.get('study-test-card'), receipt);
  r = await f.c.run({ workflowId: f.j.workflowId });
  assert.equal(r.status, 'completed');
  assert.equal(f.writes(), 1);
});
test('altered frozen plans block both execution and reconciliation', async (t) => {
  const f = await fixture(t);
  f.j.plan.blocks[0].text = 'changed';
  await f.c.save(f.j);
  await assert.rejects(f.c.run({ workflowId: f.j.workflowId }), { code: 'PLAN_CHANGED' });
  await assert.rejects(f.c.review({ workflowId: f.j.workflowId }), { code: 'PLAN_CHANGED' });
  assert.equal(f.writes(), 0);
});
test('unknown partial creation cannot be cleared or replayed by review', async (t) => {
  const f = await fixture(t);
  f.j.steps[0].status = 'running';
  await f.c.save(f.j);
  const r = await f.c.run({ workflowId: f.j.workflowId });
  assert.equal(r.status, 'needs-review');
  await assert.rejects(f.c.review({ workflowId: f.j.workflowId }), { code: 'REVIEW_REQUIRED' });
  assert.equal(f.writes(), 0);
});

test('stable preparation request copies only once and conflicts never dispatch a mutation', async (t) => {
  const f = await fixture(t);
  let copied = 0,
    exported = 0;
  f.adapter.openItem = async () => ({ url: 'original', title: 'Lecture' });
  f.adapter.library.manage = async () => {
    copied++;
    return { url: 'copy', title: 'Quellkopie' };
  };
  f.adapter.documents = {
    exportPdf: async ({ url }) => {
      assert.equal(url, 'copy');
      exported++;
      return { exportId: 'saved', pageCount: 1 };
    },
    get: async () => ({ index: { pages: [{ page: 1, text: 'Original source', characters: 15 }] } }),
  };
  const input = {
    sourceItemPath: [crypto.randomUUID()],
    expectedSourceTitle: 'Lecture',
    title: 'Board',
    requestId: 'study-preparation-stable',
  };
  const first = await f.c.prepare(input),
    second = await f.c.prepare(input);
  assert.equal(first.workflowId, second.workflowId);
  assert.equal(copied, 1);
  assert.equal(exported, 1);
  await assert.rejects(f.c.prepare({ ...input, title: 'Different' }), { code: 'REQUEST_CONFLICT' });
  assert.equal(copied, 1);
});

test('source title mismatch stops before duplication and a dispatched unknown copy never repeats', async (t) => {
  const f = await fixture(t);
  let copied = 0;
  f.adapter.openItem = async () => ({ url: 'source', title: 'Changed' });
  f.adapter.library.manage = async () => {
    copied++;
    throw Error('simulated lost result');
  };
  const input = {
    sourceItemPath: [crypto.randomUUID()],
    expectedSourceTitle: 'Lecture',
    title: 'Board',
    requestId: 'study-preparation-stop',
  };
  await assert.rejects(f.c.prepare(input), { code: 'SOURCE_CHANGED' });
  assert.equal(copied, 0);
  f.adapter.openItem = async () => ({ url: 'source', title: 'Lecture' });
  await assert.rejects(f.c.prepare(input), /simulated lost result/);
  assert.equal(copied, 1);
  await assert.rejects(f.c.prepare(input), { code: 'REVIEW_REQUIRED' });
  assert.equal(copied, 1);
});

test('routine progress omits repeated block evidence; detailed status preserves it and points to actual output', async (t) => {
  const f = await fixture(t);
  f.j.source = {
    title: 'Lecture',
    exportId: 'source',
    pageCount: 10,
    path: 'private-source.pdf',
    sha256: 'source-hash',
  };
  f.j.previewPath = 'planned.png';
  f.j.steps[1].result = {
    verified: true,
    checkpointPath: 'private-checkpoint',
    details: 'evidence'.repeat(2000),
  };
  f.j.steps[2].status = 'verified';
  f.j.steps[2].result = { verified: true, previewPath: 'actual.png' };
  await f.c.save(f.j);
  const compact = await f.c.status({ workflowId: f.j.workflowId }),
    full = await f.c.status({ workflowId: f.j.workflowId, includeEvidence: true });
  assert.equal(compact.steps[1].result, undefined);
  assert.equal(compact.source.path, undefined);
  assert.equal(full.steps[1].result.checkpointPath, 'private-checkpoint');
  assert.equal(full.source.path, 'private-source.pdf');
  assert.equal(compact.previewPath, 'actual.png');
  assert.equal(compact.planPreviewPath, 'planned.png');
  assert.equal(compact.steps[2].result.verified, true);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length / 2);
});
