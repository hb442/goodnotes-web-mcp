import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { extractPdf, renderPdfPage, searchPages } from '../src/pdf.mjs';
import { DocumentController } from '../src/documents.mjs';
import { createOcr } from '../src/ocr.mjs';
import { selectionBounds, regionHash, compareRegion, changedAlongLine } from '../src/visual.mjs';
import { mutate } from '../src/mutations.mjs';
import { Journal } from '../src/journal.mjs';
import { PDFDocument } from 'pdf-lib';

async function directory(t) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-v02-'));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}
function pdfFixture() {
  const streams = [
    'BT /F1 18 Tf 50 700 Td (First page: Alpha Beta) Tj ET',
    'BT /F1 18 Tf 50 700 Td (Second page: Alpha Gamma) Tj ET',
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let value = '%PDF-1.4\n',
    offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(value));
    value += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(value);
  value +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
      .join('') +
    `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return value;
}
test('real two-page PDF extraction, search and rendering', async (t) => {
  const d = await directory(t),
    file = path.join(d, 'test.pdf');
  await fs.writeFile(file, pdfFixture());
  const result = await extractPdf(file);
  assert.equal(result.pageCount, 2);
  assert.match(result.pages[1].text, /Second page: Alpha Gamma/);
  const found = searchPages(result.pages, 'alpha', { limit: 1 });
  assert.equal(found.total, 2);
  assert.equal(found.truncated, true);
  assert.equal(found.matches[0].page, 1);
  const rendered = await renderPdfPage(file, 2, { maxDimension: 800 });
  assert.equal(rendered.height, 800);
  assert.ok(rendered.bytes.length > 1000);
  await assert.rejects(renderPdfPage(file, 3), (e) => e.code === 'INVALID_PAGE');
  const controller = new DocumentController({ config: { directory: d } }),
    id = crypto.randomUUID();
  controller.indices.set(id, {
    record: { exportId: id, title: 'Fixture', path: file },
    index: result,
  });
  const first = await controller.read({ exportId: id, maxCharacters: 8 });
  assert.equal(first.result.nextPage, 1);
  assert.equal(first.result.nextOffset, 8);
  const next = await controller.read({
    exportId: id,
    startPage: 1,
    startOffset: 8,
    maxCharacters: 1000,
  });
  assert.equal(first.result.pages[0].text + next.result.pages[0].text, result.pages[0].text);
  await assert.rejects(
    controller.read({ exportId: id, startOffset: 999 }),
    (e) => e.code === 'INVALID_OFFSET',
  );
  await assert.rejects(controller.get('../escape'), (e) => e.code === 'INVALID_EXPORT');
});
test('OCR runs locally and recognizes clear English/German print', async (t) => {
  const d = await directory(t),
    canvas = createCanvas(1200, 240),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 1200, 240);
  ctx.fillStyle = 'black';
  ctx.font = '48px Arial';
  ctx.fillText('LOCAL OCR TEST 12345', 40, 100);
  const worker = await createOcr(d);
  try {
    const result = await worker.recognize(canvas.toBuffer('image/png'));
    assert.match(result.text, /LOCAL OCR TEST 12345/);
    assert.ok(result.confidence > 80);
  } finally {
    await worker.close();
  }
});

test('automatic PDF OCR recovers pale text lost by the initial fixed threshold', async (t) => {
  const d = await directory(t),
    canvas = createCanvas(1200, 300),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 1200, 300);
  ctx.fillStyle = '#aaaaaa';
  ctx.font = '48px Arial';
  ctx.fillText('PALE TEXT RECOVERY 12345', 40, 150);
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([600, 150]);
  const png = await pdf.embedPng(canvas.toBuffer('image/png'));
  page.drawImage(png, { x: 0, y: 0, width: 600, height: 150 });
  const file = path.join(d, 'pale.pdf');
  await fs.writeFile(file, await pdf.save());
  const index = await extractPdf(file),
    exportId = crypto.randomUUID();
  const controller = new DocumentController({ config: { directory: d } });
  await fs.mkdir(controller.directory, { recursive: true });
  controller.indices.set(exportId, {
    record: { exportId, path: file, title: 'Pale fixture' },
    index,
  });
  const result = await controller.search({ exportId, query: 'PALE TEXT RECOVERY' });
  assert.equal(result.total, 1);
  assert.deepEqual(result.ocr.processed, [1]);
  assert.equal(index.pages[0].ocr.preprocessing, 'adaptive');
  const cached = await controller.search({ exportId, query: 'PALE TEXT RECOVERY' });
  assert.deepEqual(cached.ocr.processed, []);
  assert.equal(cached.needsVisualReview, true);
  const restarted = new DocumentController({ config: { directory: d } });
  const persisted = await restarted.search({ exportId, query: 'PALE TEXT RECOVERY' });
  assert.equal(persisted.total, 1);
  assert.deepEqual(persisted.ocr.processed, []);
  assert.deepEqual(persisted.ocr.lowConfidencePages, []);
});
test('selection bounds require a complete visible frame and hash its content', async () => {
  const canvas = createCanvas(1440, 1000),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 1440, 1000);
  ctx.strokeStyle = '#007aff';
  ctx.lineWidth = 1;
  ctx.strokeRect(300.5, 300.5, 250, 180);
  const bytes = canvas.toBuffer('image/png'),
    bounds = await selectionBounds(bytes, { y: 48, height: 944 });
  assert.deepEqual(bounds, { x: 300, y: 300, width: 250, height: 180 });
  const first = await regionHash(bytes, bounds);
  ctx.fillStyle = 'black';
  ctx.fillRect(330, 330, 20, 20);
  assert.notEqual(first, await regionHash(canvas.toBuffer('image/png'), bounds));
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 1440, 1000);
  await assert.rejects(
    selectionBounds(canvas.toBuffer('image/png'), { y: 48, height: 944 }),
    (e) => e.code === 'NO_OBJECT_SELECTION',
  );
});
test('selection handles may interrupt short edges; separated blue frames are rejected', async () => {
  const canvas = createCanvas(1440, 1000),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 1440, 1000);
  ctx.strokeStyle = '#208cff';
  ctx.lineWidth = 1;
  ctx.strokeRect(400.5, 300.5, 259, 63);
  ctx.fillStyle = 'white';
  ctx.fillRect(397, 324, 8, 14);
  ctx.fillRect(656, 324, 8, 14);
  assert.deepEqual(await selectionBounds(canvas.toBuffer('image/png'), { y: 48, height: 944 }), {
    x: 400,
    y: 300,
    width: 259,
    height: 63,
  });
  ctx.strokeRect(900.5, 600.5, 180, 100);
  await assert.rejects(
    selectionBounds(canvas.toBuffer('image/png'), { y: 48, height: 944 }),
    (e) => e.code === 'AMBIGUOUS_SELECTION',
  );
});
test('selection frame remains detectable when blended over dark shape outlines', async () => {
  const canvas = createCanvas(1440, 1000),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 1440, 1000);
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 4;
  ctx.strokeRect(215.5, 283.5, 173, 114);
  ctx.strokeStyle = 'rgb(9,105,182)';
  ctx.lineWidth = 1;
  ctx.strokeRect(215.5, 283.5, 173, 114);
  assert.deepEqual(await selectionBounds(canvas.toBuffer('image/png'), { y: 48, height: 944 }), {
    x: 215,
    y: 283,
    width: 173,
    height: 114,
  });
});
test('selection detection removes unchanged blue artwork using a fresh unselected baseline', async () => {
  const canvas = createCanvas(1440, 1000),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 1440, 1000);
  ctx.fillStyle = '#208cff';
  ctx.fillRect(700, 490, 60, 34);
  const before = canvas.toBuffer('image/png');
  ctx.strokeStyle = '#208cff';
  ctx.lineWidth = 1;
  ctx.strokeRect(820.5, 150.5, 257, 257);
  const after = canvas.toBuffer('image/png');
  assert.deepEqual(await selectionBounds(after, { y: 48, height: 944 }, before), {
    x: 820,
    y: 150,
    width: 257,
    height: 257,
  });
  await assert.rejects(selectionBounds(before, { y: 48, height: 944 }, before));
});
test('thin selection edges blended over cream paper remain detectable without accepting a missing edge', async () => {
  const c = createCanvas(1440, 1000),
    ctx = c.getContext('2d');
  ctx.fillStyle = '#f9f8e9';
  ctx.fillRect(0, 0, 1440, 1000);
  const baseline = c.toBuffer('image/png');
  ctx.strokeStyle = 'rgb(46,139,211)';
  ctx.lineWidth = 1;
  ctx.strokeRect(765.5, 587.5, 266, 54);
  ctx.fillStyle = 'rgb(136,184,216)';
  ctx.fillRect(765, 587, 267, 1);
  assert.deepEqual(
    await selectionBounds(c.toBuffer('image/png'), { y: 48, height: 944 }, baseline),
    { x: 765, y: 587, width: 266, height: 54 },
  );
  ctx.fillStyle = '#f9f8e9';
  ctx.fillRect(764, 585, 270, 5);
  await assert.rejects(selectionBounds(c.toBuffer('image/png'), { y: 48, height: 944 }, baseline));
});
test('connector verification rejects a truncated shaft despite a complete arrowhead', async () => {
  const c = createCanvas(500, 200),
    ctx = c.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 500, 200);
  const before = c.toBuffer('image/png');
  ctx.fillStyle = 'black';
  ctx.fillRect(30, 100, 150, 2);
  ctx.fillRect(370, 95, 10, 10);
  assert.equal(
    (await changedAlongLine(before, c.toBuffer('image/png'), { x: 30, y: 100 }, { x: 380, y: 100 }))
      .matches,
    false,
  );
  ctx.fillRect(30, 100, 350, 2);
  assert.equal(
    (await changedAlongLine(before, c.toBuffer('image/png'), { x: 30, y: 100 }, { x: 380, y: 100 }))
      .matches,
    true,
  );
  // A complete shaft alone must not satisfy the separate arrowhead segment check.
  assert.equal(
    (
      await changedAlongLine(
        before,
        c.toBuffer('image/png'),
        { x: 380, y: 100 },
        { x: 356, y: 86.8 },
      )
    ).matches,
    false,
  );
});
test('visual persistence allows edge rendering changes but rejects lost strokes and changed colors', async () => {
  const canvas = createCanvas(500, 400),
    ctx = canvas.getContext('2d'),
    bounds = { x: 50, y: 50, width: 350, height: 250 };
  const scene = (width, color = 'black', extra = false) => {
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 500, 400);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.strokeRect(100.5, 100.5, 200, 150);
    if (extra) {
      ctx.fillStyle = 'black';
      ctx.fillRect(150, 150, 30, 4);
    }
    return canvas.toBuffer('image/png');
  };
  const original = scene(4);
  assert.equal((await compareRegion(original, scene(3), bounds)).matches, true);
  assert.equal((await compareRegion(original, scene(4, 'red'), bounds)).matches, false);
  assert.equal((await compareRegion(original, scene(4, 'black', true), bounds)).matches, false);
  const withStroke = scene(4, 'black', true);
  assert.equal((await compareRegion(withStroke, original, bounds)).matches, false);
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 500, 400);
  assert.equal(
    (await compareRegion(original, canvas.toBuffer('image/png'), bounds)).matches,
    false,
  );
});
test('new mutations block replay after a partial failure', async (t) => {
  const d = await directory(t),
    a = { journal: new Journal(d) };
  let writes = 0;
  await assert.rejects(
    mutate(a, 'test-partial-write', { action: 'move' }, async (mark) => {
      mark();
      writes++;
      throw new Error('Reload failed');
    }),
    (e) => e.details.mayHaveWritten,
  );
  assert.equal((await a.journal.get('test-partial-write')).status, 'uncertain');
  await assert.rejects(
    mutate(a, 'test-partial-write', { action: 'move' }, async () => {
      writes++;
      return { verified: true };
    }),
  );
  assert.equal(writes, 1);
  const result = await mutate(a, 'test-verified-write', { action: 'rename' }, async (mark) => {
    mark();
    writes++;
    return { verified: true };
  });
  assert.equal(result.verified, true);
  assert.equal(
    (
      await mutate(a, 'test-verified-write', { action: 'rename' }, async () => {
        throw new Error('Should not run');
      })
    ).replayed,
    true,
  );
});
