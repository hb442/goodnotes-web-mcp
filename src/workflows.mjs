import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { extractPdf } from './pdf.mjs';
import { writeJson } from './store.mjs';
import { GoodnotesError, checkCancellation } from './errors.mjs';

export function tsvCell(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replace(/^#/, '&#35;')
    .replace(/\r\n?|\n/g, '<br>')
    .replaceAll('\t', '    ');
}
export class WorkflowController {
  constructor(adapter) {
    this.a = adapter;
    this.directory = path.join(adapter.config.directory, 'outputs');
  }
  async combine({ parts, title = 'Combined notes' }, options = {}) {
    const output = await PDFDocument.create(),
      sources = [];
    let totalBytes = 0;
    for (const part of parts) {
      checkCancellation(options.signal);
      const { record, index } = await this.a.documents.get(part.exportId);
      const stat = await fs.stat(record.path);
      totalBytes += stat.size;
      if (totalBytes > 150 * 1024 * 1024)
        throw new GoodnotesError('PDF_TOO_LARGE', 'Combined inputs exceed 150 MB.');
      const selected = part.pages || index.pages.map((p) => p.page);
      if (
        selected.some((n) => !Number.isInteger(n) || n < 1 || n > index.pageCount) ||
        output.getPageCount() + selected.length > 2000
      )
        throw new GoodnotesError(
          'INVALID_PAGE_RANGE',
          'Select existing pages, at most 2000 in total.',
        );
      const source = await PDFDocument.load(await fs.readFile(record.path), {
        updateMetadata: false,
      });
      const copies = await output.copyPages(
        source,
        selected.map((n) => n - 1),
      );
      for (const [i, p] of copies.entries()) {
        output.addPage(p);
        sources.push({
          outputPage: output.getPageCount(),
          exportId: part.exportId,
          sourcePage: selected[i],
          url: record.url,
          title: record.title,
          exportedAt: record.exportedAt,
        });
      }
    }
    output.setTitle(title);
    output.setProducer('goodnotes-web-mcp');
    const bytes = await output.save(),
      id = crypto.randomUUID(),
      file = path.join(this.directory, `${id}.pdf`);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, bytes, { mode: 0o600 });
    const verified = await extractPdf(file, options);
    if (verified.pageCount !== sources.length)
      throw new GoodnotesError('SAVE_UNVERIFIED', 'Combined PDF page count mismatch.');
    await writeJson(path.join(this.directory, `${id}.json`), {
      title,
      sources,
      createdAt: new Date().toISOString(),
    });
    return {
      path: file,
      pageCount: verified.pageCount,
      title,
      sources: sources.slice(0, 50),
      sourceMapPath: path.join(this.directory, `${id}.json`),
      sourceCount: sources.length,
      note: 'New local PDF. Original cloud notes are unchanged. Native ink editing, document outlines, interactive form behavior and cross-document links are not preserved guarantees. Import this path explicitly to create a Goodnotes notebook.',
    };
  }
  async studyBundle({ exportId, summary = '', tasks = [], cards = [] }) {
    const { record, index } = await this.a.documents.get(exportId),
      id = crypto.randomUUID(),
      directory = path.join(this.directory, id);
    for (const entry of [...tasks, ...cards])
      if (entry.page !== undefined && (entry.page < 1 || entry.page > index.pageCount))
        throw new GoodnotesError('INVALID_PAGE', 'A cited page is outside the source snapshot.');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const source = {
      exportId,
      title: record.title,
      url: record.url,
      exportedAt: record.exportedAt,
      pageCount: index.pageCount,
    };
    const material = {
      source,
      summary,
      tasks,
      cards,
      createdAt: new Date().toISOString(),
      note: 'Summary, tasks and cards are supplied by the calling assistant; the MCP does not invent or validate their factual content.',
    };
    await writeJson(path.join(directory, 'study.json'), material);
    const text = [
      record.title,
      `Source: ${record.url}`,
      `Snapshot: ${record.exportedAt}`,
      '',
      summary,
      '',
      ...tasks.map((t) => `[ ] ${t.text}${t.page ? ` (page ${t.page})` : ''}`),
      '',
      'SOURCE TEXT',
      ...index.pages.map((p) => `\n--- Page ${p.page} ---\n${p.text}`),
    ].join('\n');
    await fs.writeFile(path.join(directory, 'study.txt'), text, { mode: 0o600 });
    const rows = [
      '#separator:Tab',
      '#html:true',
      '#columns:Front\tBack\tSource',
      ...cards.map((c) =>
        [c.front, c.back, `${record.title}${c.page ? ` - page ${c.page}` : ''}`]
          .map(tsvCell)
          .join('\t'),
      ),
    ];
    await fs.writeFile(path.join(directory, 'cards.tsv'), rows.join('\n') + '\n', { mode: 0o600 });
    return {
      directory,
      files: {
        text: path.join(directory, 'study.txt'),
        structured: path.join(directory, 'study.json'),
        flashcards: path.join(directory, 'cards.tsv'),
      },
      tasks: tasks.length,
      cards: cards.length,
      source,
      note: 'Files are local; no tasks were sent to another service and no cards were imported into Anki.',
    };
  }
}
