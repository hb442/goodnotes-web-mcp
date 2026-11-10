import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { documentUrl } from './config.mjs';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { extractPdf, renderPdfPage, searchPages } from './pdf.mjs';
import { createOcr } from './ocr.mjs';
import { writeJson } from './store.mjs';
import { captureBoardViewport, restoreBoardViewport } from './viewport.mjs';

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export class DocumentController {
  constructor(adapter) {
    this.a = adapter;
    this.directory = path.join(adapter.config.directory, 'exports');
    this.latest = new Map();
    this.indices = new Map();
  }
  async exportPdf(args, options = {}) {
    checkCancellation(options.signal);
    const page = await this.a.openDocument(args.url);
    let checkpoint = await captureBoardViewport(page),
      view;
    if (checkpoint) {
      view = this.a.getView((await this.a.inspect({ url: args.url })).viewId);
      checkpoint = await captureBoardViewport(page);
    }
    try {
      return await this.exportSnapshot(args, options);
    } finally {
      if (checkpoint) {
        await this.a.closePanels(page);
        await restoreBoardViewport(this.a, page, view, checkpoint, options);
      }
    }
  }
  async exportSnapshot(
    { url, format = 'flattened', searchableHandwriting = true },
    { signal } = {},
  ) {
    checkCancellation(signal);
    const a = this.a,
      page = await a.openDocument(url),
      title = (await page.locator('#infoButton').innerText()).trim();
    a.invalidate();
    for (let attempt = 0; attempt < 2; attempt++) {
      checkCancellation(signal);
      try {
        await a.closePanels(page);
        await page.locator('#exportAndShareButton').click();
        await page.locator('#exportAsPdf').click();
        await page
          .locator('#pdf-export-file-name')
          .waitFor({ state: 'visible', timeout: attempt ? 30000 : 15000 });
        break;
      } catch (error) {
        if (attempt || signal?.aborted) throw error;
        // Opening export is read-only. A fresh Web load recovers transient popover failures.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await a.openDocument(url);
      }
    }
    const id = crypto.randomUUID(),
      name = `goodnotes-${id}`;
    await page.locator('#pdf-export-file-name').fill(name);
    const formatButton = page.getByRole('button', { name: /PDF Format/ });
    const wanted = format === 'editable' ? 'Editable' : 'Flattened';
    if (!(await formatButton.innerText()).includes(wanted)) {
      await formatButton.click();
      await page.getByText(wanted, { exact: true }).click();
      const back = page.getByRole('button', { name: 'Back', exact: true });
      if (await back.isVisible().catch(() => false)) await back.click();
      await page.locator('#pdf-export-file-name').waitFor({ state: 'visible' });
    }
    const handwriting = page.getByRole('switch', { name: 'Searchable handwriting', exact: true });
    let recognitionRequested = false;
    if (await handwriting.count()) {
      const enabled = (await handwriting.getAttribute('aria-checked')) === 'true';
      if (enabled !== searchableHandwriting) await handwriting.click();
      recognitionRequested = searchableHandwriting;
    }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${id}.pdf`);
    checkCancellation(signal);
    const pending = page.waitForEvent('download', { timeout: 120000 });
    pending.catch(() => {}); // A failed Export click must not leave an unhandled event timeout.
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await pending;
    const failure = await download.failure();
    if (failure) throw new GoodnotesError('EXPORT_FAILED', failure);
    await download.saveAs(file);
    const index = await extractPdf(file, { signal });
    const record = {
      exportId: id,
      url: documentUrl(page.url()),
      title,
      path: file,
      format,
      recognitionRequested,
      exportedAt: new Date().toISOString(),
      pageCount: index.pageCount,
      totalCharacters: index.totalCharacters,
      sha256: crypto
        .createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex'),
      bytes: (await fs.stat(file)).size,
      pagesWithoutText: index.pages.filter((p) => !p.text.trim()).map((p) => p.page),
    };
    await fs.writeFile(
      path.join(this.directory, `${id}.json`),
      JSON.stringify({ ...record, index }, null, 2),
      { mode: 0o600 },
    );
    this.indices.set(id, { record, index });
    if (this.indices.size > 16) this.indices.delete(this.indices.keys().next().value);
    this.latest.set(record.url, id);
    return {
      ...record,
      note: 'Local PDF snapshot. Reads/searches can recognize missing text locally with bounded OCR; formulas still require visual checking. This is not a native Goodnotes backup.',
    };
  }
  invalidate(url) {
    this.latest.delete(documentUrl(url));
    // Writes await this persistent invalidation before reporting completion.
    return this.a.catalog?.dirty(documentUrl(url));
  }
  async get(exportId) {
    if (!ID.test(exportId))
      throw new GoodnotesError('INVALID_EXPORT', 'Use an exportId returned by goodnotes_export.');
    if (this.indices.has(exportId)) return this.indices.get(exportId);
    let stored;
    try {
      stored = JSON.parse(await fs.readFile(path.join(this.directory, `${exportId}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT')
        throw new GoodnotesError(
          'EXPORT_NOT_FOUND',
          'The local export no longer exists. Export the document again.',
        );
      throw error;
    }
    // Derive the path from the trusted export directory, not from the serialized record.
    const { index, ...record } = stored;
    record.path = path.join(this.directory, `${exportId}.pdf`);
    const result = { record, index };
    this.indices.set(exportId, result);
    if (this.indices.size > 16) this.indices.delete(this.indices.keys().next().value);
    return result;
  }
  async resolve({ url, exportId, refresh = false }, options) {
    if (exportId) return this.get(exportId);
    if (!url) throw new GoodnotesError('DOCUMENT_REQUIRED', 'Provide a document URL or exportId.');
    const key = documentUrl(url),
      cached = this.latest.get(key);
    if (cached && !refresh) return this.get(cached);
    return this.get((await this.exportPdf({ url }, options)).exportId);
  }
  async ensureText(
    record,
    index,
    { startPage = 1, endPage = index.pageCount, ocrIfMissing = true, maxOcrPages = 3 } = {},
    options = {},
  ) {
    const missing = index.pages.filter(
      (p) => p.page >= startPage && p.page <= endPage && !(p.pdfText ?? p.text).trim() && !p.ocr,
    );
    const result = { processed: [], pendingPages: [], failed: [] };
    for (const p of missing) {
      checkCancellation(options.signal);
      if (!ocrIfMissing || result.processed.length + result.failed.length >= maxOcrPages) {
        result.pendingPages.push(p.page);
        continue;
      }
      try {
        await this.recognize(
          { exportId: record.exportId, startPage: p.page, endPage: p.page },
          options,
        );
        result.processed.push(p.page);
      } catch (error) {
        checkCancellation(options.signal);
        result.failed.push({ page: p.page, code: error.code || 'OCR_FAILED' });
      }
    }
    result.lowConfidencePages = index.pages
      .filter((p) => p.page >= startPage && p.page <= endPage && p.ocr && p.ocr.confidence < 65)
      .map((p) => p.page);
    return result;
  }
  async read(
    {
      url,
      exportId,
      refresh = false,
      startPage = 1,
      startOffset = 0,
      endPage,
      maxCharacters = 24000,
      includeImages = false,
      maxImagePages = 2,
      ocrIfMissing = true,
      maxOcrPages = 3,
    },
    options = {},
  ) {
    const { record, index } = await this.resolve({ url, exportId, refresh }, options);
    const last = endPage ?? Math.min(index.pageCount, startPage + 19);
    if (startPage < 1 || last < startPage || last > index.pageCount)
      throw new GoodnotesError(
        'INVALID_PAGE_RANGE',
        'The requested page range is outside the document.',
      );
    const ocr = await this.ensureText(
      record,
      index,
      { startPage, endPage: last, ocrIfMissing, maxOcrPages },
      options,
    );
    if (startOffset < 0 || startOffset > index.pages[startPage - 1].text.length)
      throw new GoodnotesError('INVALID_OFFSET', 'Offset is outside the starting page text.');
    let remaining = maxCharacters,
      nextPage = null,
      nextOffset = 0;
    const pages = [],
      images = [];
    for (const p of index.pages.slice(startPage - 1, last)) {
      checkCancellation(options.signal);
      if (remaining <= 0) {
        nextPage = p.page;
        break;
      }
      const offset = p.page === startPage ? startOffset : 0;
      const text = p.text.slice(offset, offset + remaining);
      remaining -= text.length;
      pages.push({
        page: p.page,
        text,
        characters: p.characters,
        width: p.width,
        height: p.height,
        needsVisualReview: p.needsVisualReview,
        ocrConfidence: p.ocr?.confidence,
        offset,
        truncated: offset + text.length < p.text.length,
      });
      if (includeImages && images.length < maxImagePages)
        images.push(await renderPdfPage(record.path, p.page));
      if (offset + text.length < p.text.length) {
        nextPage = p.page;
        nextOffset = offset + text.length;
        break;
      }
    }
    if (nextPage === null && last < index.pageCount) nextPage = last + 1;
    return {
      result: {
        exportId: record.exportId,
        title: record.title,
        exportedAt: record.exportedAt,
        pageCount: index.pageCount,
        pages,
        nextPage,
        nextOffset,
        imagesIncluded: images.map((i) => i.page),
        ocr,
        textSource: pages.some((p) => p.ocrConfidence !== undefined)
          ? 'PDF text layer plus approximate local OCR'
          : 'PDF text layer, including Goodnotes handwriting recognition when present',
        textCompleteness:
          'unknown; handwriting and image text can be missing even on pages with extracted text',
        notebookMayHaveChanged: true,
      },
      images,
    };
  }
  async search(
    {
      url,
      exportId,
      refresh = false,
      query,
      caseSensitive = false,
      limit = 30,
      ocrIfMissing = true,
      maxOcrPages = 3,
    },
    options = {},
  ) {
    const { record, index } = await this.resolve({ url, exportId, refresh }, options);
    const ocr = await this.ensureText(record, index, { ocrIfMissing, maxOcrPages }, options);
    return {
      exportId: record.exportId,
      title: record.title,
      exportedAt: record.exportedAt,
      ...searchPages(index.pages, query, { caseSensitive, limit }),
      ocr,
      textSource: index.pages.some((p) => p.ocr)
        ? 'PDF text plus approximate local OCR'
        : 'PDF text layer',
      incomplete: ocr.pendingPages.length > 0 || ocr.failed.length > 0,
      needsVisualReview: index.pages.some((p) => p.ocr || p.needsVisualReview),
    };
  }
  async render({ exportId, page, maxDimension = 1600 }) {
    const { record } = await this.get(exportId);
    return renderPdfPage(record.path, page, { maxDimension });
  }
  async recognize({ exportId, startPage = 1, endPage, replace = false }, { signal } = {}) {
    const { record, index } = await this.get(exportId);
    const last = endPage ?? Math.min(index.pageCount, startPage + 4);
    if (startPage < 1 || last < startPage || last > index.pageCount || last - startPage >= 10)
      throw new GoodnotesError('INVALID_PAGE_RANGE', 'Recognize 1–10 pages per call.');
    const worker = await createOcr(this.a.config.directory, { signal }),
      processed = [];
    try {
      for (const p of index.pages.slice(startPage - 1, last)) {
        checkCancellation(signal);
        if (p.ocr && !replace) {
          processed.push({ page: p.page, cached: true, confidence: p.ocr.confidence });
          continue;
        }
        const rendered = await renderPdfPage(record.path, p.page, { maxDimension: 2400 });
        let result = await worker.recognize(rendered.bytes);
        let preprocessing = 'threshold',
          renderDimensions = { width: rendered.width, height: rendered.height };
        if (result.confidence < 65) {
          // Small or pale glyphs can disappear under the screen-OCR threshold.
          // One bounded higher-resolution pass lets Tesseract binarize adaptively.
          checkCancellation(signal);
          const larger = await renderPdfPage(record.path, p.page, { maxDimension: 4800 });
          const alternative = await worker.recognize(larger.bytes, { binarize: false });
          if (alternative.confidence > result.confidence) {
            result = alternative;
            preprocessing = 'adaptive';
            renderDimensions = { width: larger.width, height: larger.height };
          }
        }
        p.pdfText ??= p.text;
        p.ocr = {
          ...result,
          preprocessing,
          renderDimensions,
          recognizedAt: new Date().toISOString(),
          engine: 'local Tesseract English+German',
        };
        p.text = p.pdfText + (p.pdfText && result.text ? '\n\n[Local OCR]\n' : '') + result.text;
        p.characters = p.text.length;
        p.needsVisualReview = true;
        processed.push({
          page: p.page,
          characters: result.text.length,
          confidence: result.confidence,
        });
      }
      index.totalCharacters = index.pages.reduce((sum, p) => sum + p.characters, 0);
      record.totalCharacters = index.totalCharacters;
      await writeJson(path.join(this.directory, `${exportId}.json`), { ...record, index });
      return {
        exportId,
        processed,
        nextPage: last < index.pageCount ? last + 1 : null,
        note: 'Local OCR is approximate, especially for handwriting, formulas and tables. Results are now included in document reads and searches. Check the page image for exact wording.',
      };
    } finally {
      await worker.close();
    }
  }
}
