import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentController } from '../src/documents.mjs';

function fixture() {
  const controller = new DocumentController({ config: { directory: '.' } });
  const index = {
    pageCount: 5,
    pages: Array.from({ length: 5 }, (_, i) => ({
      page: i + 1,
      text: i === 0 ? 'Native text' : '',
      characters: i === 0 ? 11 : 0,
    })),
  };
  const record = { exportId: '00000000-0000-4000-8000-000000000017', title: 'Fixture' };
  controller.indices.set(record.exportId, { record, index });
  const calls = [];
  controller.recognize = async ({ startPage }) => {
    calls.push(startPage);
    const p = index.pages[startPage - 1];
    p.pdfText = p.text;
    p.text = startPage === 4 ? '' : 'Recognized Alpha';
    p.characters = p.text.length;
    p.ocr = { confidence: 92 };
    p.needsVisualReview = true;
  };
  return { controller, index, record, calls };
}

test('missing PDF text uses bounded OCR, resumes and caches even blank recognized pages', async () => {
  const { controller, record, calls } = fixture();
  const first = await controller.search({
    exportId: record.exportId,
    query: 'Alpha',
    maxOcrPages: 2,
  });
  assert.deepEqual(calls, [2, 3]);
  assert.deepEqual(first.ocr.pendingPages, [4, 5]);
  assert.equal(first.incomplete, true);
  assert.equal(first.total, 2);
  const second = await controller.search({ exportId: record.exportId, query: 'Alpha' });
  assert.deepEqual(calls, [2, 3, 4, 5]);
  assert.equal(second.incomplete, false);
  assert.equal(second.total, 3);
  await controller.search({ exportId: record.exportId, query: 'Alpha' });
  assert.deepEqual(calls, [2, 3, 4, 5]);
});

test('read OCR respects page scope, explicit disable, zero budget and provenance', async () => {
  const { controller, record, calls } = fixture();
  const args = { exportId: record.exportId, startPage: 3, endPage: 3 };
  const disabled = await controller.read({ ...args, ocrIfMissing: false });
  assert.deepEqual(disabled.result.ocr.pendingPages, [3]);
  await controller.read({ ...args, maxOcrPages: 0 });
  assert.deepEqual(calls, []);
  const read = await controller.read(args);
  assert.deepEqual(calls, [3]);
  assert.equal(read.result.pages[0].ocrConfidence, 92);
  assert.match(read.result.textSource, /approximate local OCR/);
  controller.indices.get(record.exportId).index.pages[2].ocr.confidence = 42;
  const lowConfidence = await controller.read(args);
  assert.deepEqual(lowConfidence.result.ocr.lowConfidencePages, [3]);
});

test('OCR errors leave coverage incomplete and cancellation propagates', async () => {
  const { controller, record } = fixture();
  controller.recognize = async () => {
    throw Object.assign(new Error('fixture'), { code: 'OCR_BROKEN' });
  };
  const result = await controller.search({
    exportId: record.exportId,
    query: 'Alpha',
    maxOcrPages: 1,
  });
  assert.deepEqual(result.ocr.failed, [{ page: 2, code: 'OCR_BROKEN' }]);
  assert.deepEqual(result.ocr.pendingPages, [3, 4, 5]);
  assert.equal(result.incomplete, true);
  const abort = new AbortController();
  controller.recognize = async () => {
    abort.abort();
    throw new Error('cancelled');
  };
  await assert.rejects(
    controller.search({ exportId: record.exportId, query: 'Alpha' }, { signal: abort.signal }),
    (e) => e.code === 'CANCELLED',
  );
});
