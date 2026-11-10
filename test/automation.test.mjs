import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { CatalogController } from '../src/catalog.mjs';
import { JobController, stepSchema } from '../src/jobs.mjs';
import { Journal } from '../src/journal.mjs';
import { writeJson, uuidFile } from '../src/store.mjs';
import { expectedPageOrder } from '../src/pages.mjs';
import { WorkflowController, tsvCell } from '../src/workflows.mjs';
import { DocumentController } from '../src/documents.mjs';
import { extractPdf } from '../src/pdf.mjs';
import { matchLines } from '../src/board.mjs';
const URL = 'https://web.goodnotes.com/s/SyntheticDocument123';
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-v03-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { config: { directory }, journal: new Journal(directory) };
}
test('index resumes across restarts, recurses, reuses TTL cache and invalidates known writes', async (t) => {
  const a = await setup(t),
    folder = crypto.randomUUID(),
    doc = crypto.randomUUID();
  let exports = 0,
    hasDoc = true;
  a.list = async ({ folderPath }) => ({
    items: folderPath.length
      ? hasDoc
        ? [
            {
              id: doc,
              title: 'Lecture',
              kind: 'notebook',
              itemPath: [folder, doc],
              revisionHint: 'date',
            },
          ]
        : []
      : [{ id: folder, title: 'Study', kind: 'folder', itemPath: [folder] }],
    truncated: false,
  });
  a.openItem = async () => ({ url: URL });
  a.documents = {
    exportPdf: async () => ({
      url: URL,
      exportId: crypto.randomUUID(),
      exportedAt: new Date().toISOString(),
      pageCount: 1,
      totalCharacters: 12,
      n: exports++,
    }),
    get: async () => ({ index: { pages: [{ page: 1, text: 'Alpha content' }] } }),
  };
  let c = new CatalogController(a),
    job = await c.refresh({ maxSteps: 1 });
  assert.equal(job.status, 'running');
  c = new CatalogController(a);
  job = await c.refresh({ jobId: job.jobId, maxSteps: 4 });
  assert.equal(job.status, 'completed');
  assert.equal(exports, 1);
  assert.equal((await c.search({ query: 'Alpha' })).results[0].matches[0].page, 1);
  await c.refresh({ maxSteps: 4 });
  assert.equal(exports, 1);
  await c.dirty(URL);
  await c.refresh({ maxSteps: 4 });
  assert.equal(exports, 2);
  hasDoc = false;
  await c.refresh({ maxSteps: 4 });
  assert.equal((await c.search({ query: 'Lecture' })).total, 0);
  assert.equal((await c.search({ query: 'Lecture', includeMissing: true })).total, 1);
});
test('index reports truncated listings and does not mark unseen documents missing', async (t) => {
  const a = await setup(t),
    id = crypto.randomUUID();
  a.list = async () => ({ items: [], truncated: true });
  const c = new CatalogController(a);
  await writeJson(c.file, {
    items: { [id]: { id, title: 'Old', kind: 'notebook', itemPath: [id] } },
    updatedAt: null,
  });
  const r = await c.refresh({ includeText: false });
  assert.equal(r.status, 'completed-with-gaps');
  assert.equal((await c.search({ query: 'Old' })).total, 1);
});
test('automatic OCR is queued per missing-text page and resumes independently', async (t) => {
  const a = await setup(t),
    id = crypto.randomUUID(),
    exportId = crypto.randomUUID();
  let calls = 0;
  const index = {
    pages: [
      { page: 1, text: '' },
      { page: 2, text: 'This is a sufficiently long existing PDF text layer.' },
    ],
    totalCharacters: 52,
  };
  a.list = async () => ({
    items: [{ id, title: 'Scan', kind: 'document', itemPath: [id] }],
    truncated: false,
  });
  a.openItem = async () => ({ url: URL });
  a.documents = {
    exportPdf: async () => ({
      exportId,
      url: URL,
      exportedAt: new Date().toISOString(),
      pageCount: 2,
      totalCharacters: 52,
    }),
    get: async () => ({ index }),
    recognize: async ({ startPage }) => {
      calls++;
      assert.equal(startPage, 1);
      index.pages[0].ocr = { confidence: 80 };
      index.pages[0].text = 'Recognized';
      index.totalCharacters = 62;
    },
  };
  const catalog = new CatalogController(a),
    first = await catalog.refresh({ ocr: true, maxSteps: 2 });
  assert.equal(first.pending, 1);
  assert.equal(calls, 0);
  const done = await new CatalogController(a).refresh({ jobId: first.jobId });
  assert.equal(done.status, 'completed');
  assert.equal(calls, 1);
  await catalog.refresh({ ocr: true, maxSteps: 3 });
  assert.equal(calls, 1);
});
test('batch validates all steps before execution, persists progress and recovers verified receipts without repeating writes', async (t) => {
  const a = await setup(t);
  let calls = 0,
    backups = 0;
  a.documents = { exportPdf: async () => ({ exportId: crypto.randomUUID(), n: ++backups }) };
  a.openItem = async () => ({ url: URL });
  a.library = {
    manage: async (args) => {
      calls++;
      await a.journal.begin(args.operationId, args);
      const result = { verified: true, url: URL };
      await a.journal.finish(args.operationId, 'verified', result);
      return result;
    },
  };
  const jobs = new JobController(a),
    itemPath = [crypto.randomUUID()];
  await assert.rejects(
    jobs.plan({
      title: 'bad',
      steps: [
        { action: 'rename', itemPath, title: 'ok' },
        { action: 'execute-code', code: 'bad' },
      ],
    }),
  );
  assert.equal(calls, 0);
  const job = await jobs.plan({
    title: 'test',
    steps: [
      { action: 'rename', itemPath, title: 'new' },
      { action: 'move', itemPath, destinationPath: [] },
    ],
  });
  let status = await jobs.run({ jobId: job.jobId });
  assert.equal(status.status, 'paused');
  assert.equal(calls, 1);
  assert.equal(backups, 1);
  // Simulate the job state write being lost after the document journal was committed.
  const stored = await jobs.get(job.jobId);
  stored.steps[0].status = 'running';
  delete stored.steps[0].result;
  await jobs.save(stored);
  const restarted = new JobController(a);
  await restarted.run({ jobId: job.jobId });
  assert.equal(calls, 1);
  status = await restarted.run({ jobId: job.jobId });
  assert.equal(status.status, 'completed');
  assert.equal(calls, 2);
  await restarted.run({ jobId: job.jobId });
  assert.equal(calls, 2);
});
test('pending journal and interrupted dispatch stop batch until explicitly skipped', async (t) => {
  const a = await setup(t),
    jobs = new JobController(a),
    job = await jobs.plan({
      title: 'test',
      backup: false,
      steps: [{ action: 'create', title: 'Test', kind: 'folder' }],
    });
  await a.journal.begin(job.steps[0].operationId, { synthetic: true });
  const status = await jobs.run({ jobId: job.jobId });
  assert.equal(status.status, 'needs-review');
  assert.equal(status.steps[0].status, 'blocked');
  await jobs.skip({ jobId: job.jobId, stepIndex: 0, reason: 'Inspected result' });
  assert.equal((await jobs.run({ jobId: job.jobId })).status, 'completed-with-skips');
  await assert.rejects(jobs.get('../outside'));
  assert.throws(() => uuidFile(a.config.directory, '../outside'));
});
test('page identity verification distinguishes reorder, addition and deletion', () => {
  assert.deepEqual(expectedPageOrder(['a', 'b', 'c'], 'move', 1, null, 3), ['b', 'c', 'a']);
  assert.deepEqual(expectedPageOrder(['a', 'b'], 'duplicate', 1, 'copy'), ['a', 'copy', 'b']);
  assert.deepEqual(expectedPageOrder(['a', 'b'], 'delete', 1), ['b']);
  assert.throws(() => expectedPageOrder(['a'], 'move', 1, null, 2));
});
test('a failed backup can retry without weakening uncertain-write handling', async (t) => {
  const a = await setup(t),
    jobs = new JobController(a);
  let reads = 0,
    writes = 0;
  a.documents = {
    exportPdf: async () => {
      if (++reads === 1) throw new Error('Read failed');
      return { exportId: 'snapshot' };
    },
  };
  a.openItem = async () => ({ url: URL });
  a.library = {
    manage: async () => {
      writes++;
      return { verified: true };
    },
  };
  const job = await jobs.plan({
    title: 'preflight',
    steps: [{ action: 'rename', itemPath: [crypto.randomUUID()], title: 'new' }],
  });
  let result = await jobs.run({ jobId: job.jobId });
  assert.equal(result.status, 'paused');
  assert.equal(result.steps[0].status, 'pending');
  assert.equal(writes, 0);
  result = await jobs.run({ jobId: job.jobId });
  assert.equal(result.status, 'completed');
  assert.equal(writes, 1);
  assert.equal(reads, 2);
});
test('combine preserves requested PDF content order; study bundle validates citations and escapes Anki HTML', async (t) => {
  const a = await setup(t),
    pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const label of ['FIRST Alpha', 'SECOND Beta'])
    pdf.addPage([300, 400]).drawText(label, { x: 20, y: 300, size: 20, font });
  const file = path.join(a.config.directory, 'source.pdf');
  await fs.writeFile(file, await pdf.save());
  const index = await extractPdf(file),
    id = crypto.randomUUID();
  a.documents = new DocumentController(a);
  a.documents.indices.set(id, {
    record: {
      exportId: id,
      path: file,
      title: 'Fixture',
      url: URL,
      exportedAt: new Date().toISOString(),
    },
    index,
  });
  const w = new WorkflowController(a),
    combined = await w.combine({ parts: [{ exportId: id, pages: [2, 1, 2] }] });
  const text = await extractPdf(combined.path);
  assert.match(text.pages[0].text, /SECOND Beta/);
  assert.match(text.pages[1].text, /FIRST Alpha/);
  assert.equal(text.pageCount, 3);
  await assert.rejects(w.combine({ parts: [{ exportId: id, pages: [3] }] }));
  await assert.rejects(
    w.studyBundle({ exportId: id, cards: [{ front: 'a', back: 'b', page: 3 }] }),
  );
  const bundle = await w.studyBundle({
    exportId: id,
    cards: [{ front: 'a<b', back: 'one\ntwo', page: 2 }],
  });
  const tsv = await fs.readFile(bundle.files.flashcards, 'utf8');
  assert.match(tsv, /a&lt;b\tone<br>two/);
  assert.equal(tsvCell('&<\t'), '&amp;&lt;    ');
});
test('OCR hit selection chooses text instead of an empty inter-word center', () => {
  const box = { x0: 0, y0: 0, x1: 100, y1: 20 };
  const matches = matchLines(
    [
      {
        text: 'Alpha Beta',
        confidence: 90,
        bbox: box,
        words: [
          { text: 'Alpha', bbox: { x0: 0, y0: 0, x1: 30, y1: 20 } },
          { text: 'Beta', bbox: { x0: 75, y0: 0, x1: 100, y1: 20 } },
        ],
      },
    ],
    'Beta',
  );
  assert.equal(matches[0].point.x, 87.5);
  assert.equal(matchLines([{ text: 'x', confidence: 10, words: [], bbox: box }], 'x').length, 0);
});
test('batch content URLs preserve the selected page and TSV leading syntax remains literal', () => {
  const parsed = stepSchema.parse({
    action: 'replace-text',
    url: URL + '#page-3',
    x: 0.2,
    y: 0.3,
    expectedText: 'old',
    text: 'new',
  });
  assert.equal(parsed.url, URL + '#page-3');
  assert.equal(tsvCell('#tag'), '&#35;tag');
  assert.equal(tsvCell('"quoted"'), '&quot;quoted&quot;');
});
