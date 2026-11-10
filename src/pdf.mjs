import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { GoodnotesError, checkCancellation } from './errors.mjs';

const packageRoot = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
const MAX_BYTES = 150 * 1024 * 1024;

export async function openPdf(file) {
  const stat = await fs.stat(file);
  if (stat.size > MAX_BYTES)
    throw new GoodnotesError(
      'PDF_TOO_LARGE',
      'This export exceeds the local 150 MB processing limit.',
    );
  const data = new Uint8Array(await fs.readFile(file));
  if (Buffer.from(data.subarray(0, 1024)).indexOf('%PDF-') < 0)
    throw new GoodnotesError('INVALID_PDF', 'The downloaded file is not a PDF.');
  const task = getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
    standardFontDataUrl: path.join(packageRoot, 'standard_fonts').replaceAll('\\', '/') + '/',
    cMapUrl: path.join(packageRoot, 'cmaps').replaceAll('\\', '/') + '/',
    cMapPacked: true,
    wasmUrl: path.join(packageRoot, 'wasm').replaceAll('\\', '/') + '/',
  });
  const pdf = await task.promise;
  if (pdf.numPages > 2000) {
    await pdf.loadingTask.destroy();
    throw new GoodnotesError(
      'PDF_TOO_LONG',
      'The document exceeds the 2,000 page processing limit.',
    );
  }
  return pdf;
}

export function textFromItems(items) {
  let result = '',
    previous;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    if (
      previous &&
      Math.abs(item.transform[5] - previous.transform[5]) >
        Math.max(3, Math.abs(item.height || 10) * 0.6) &&
      !result.endsWith('\n')
    )
      result += '\n';
    else if (previous && result && !/\s$/.test(result) && item.str && !/^\s/.test(item.str)) {
      const gap = item.transform[4] - (previous.transform[4] + previous.width);
      if (gap > Math.max(1, Math.abs(item.height || 10) * 0.12)) result += ' ';
    }
    result += item.str;
    if (item.hasEOL && !result.endsWith('\n')) result += '\n';
    previous = item;
  }
  return result.replace(/\u0000/g, '').trim();
}

export async function extractPdf(file, { signal, maxCharacters = 3000000 } = {}) {
  const pdf = await openPdf(file),
    pages = [];
  let totalCharacters = 0;
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      checkCancellation(signal);
      const page = await pdf.getPage(number),
        viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const text = textFromItems(content.items);
      totalCharacters += text.length;
      if (totalCharacters > maxCharacters)
        throw new GoodnotesError(
          'TEXT_LIMIT',
          'The export exceeds the local 3-million-character indexing limit.',
        );
      pages.push({
        page: number,
        text,
        characters: text.length,
        width: viewport.width,
        height: viewport.height,
        needsVisualReview: text.trim().length < 30,
      });
      page.cleanup();
    }
    return { pageCount: pdf.numPages, totalCharacters, pages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

export async function renderPdfPage(file, number, { maxDimension = 1600 } = {}) {
  const pdf = await openPdf(file);
  try {
    if (!Number.isInteger(number) || number < 1 || number > pdf.numPages)
      throw new GoodnotesError('INVALID_PAGE', 'Page number is outside the exported document.');
    const page = await pdf.getPage(number),
      base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, maxDimension / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale }),
      canvas = createCanvas(
        Math.max(1, Math.ceil(viewport.width)),
        Math.max(1, Math.ceil(viewport.height)),
      );
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return {
      bytes: canvas.toBuffer('image/png'),
      width: canvas.width,
      height: canvas.height,
      page: number,
    };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

export function searchPages(pages, query, { caseSensitive = false, limit = 30 } = {}) {
  if (!query?.trim()) throw new GoodnotesError('INVALID_QUERY', 'Provide a non-empty search term.');
  const needle = caseSensitive ? query : query.toLocaleLowerCase(),
    matches = [];
  let total = 0;
  for (const page of pages) {
    const haystack = caseSensitive ? page.text : page.text.toLocaleLowerCase();
    let at = 0;
    while ((at = haystack.indexOf(needle, at)) !== -1) {
      total++;
      if (matches.length < limit)
        matches.push({
          page: page.page,
          offset: at,
          snippet: page.text.slice(
            Math.max(0, at - 85),
            Math.min(page.text.length, at + query.length + 120),
          ),
        });
      at += Math.max(1, needle.length);
    }
  }
  return {
    query,
    total,
    matches,
    truncated: total > limit,
    pagesWithoutText: pages.filter((p) => p.needsVisualReview).map((p) => p.page),
  };
}
