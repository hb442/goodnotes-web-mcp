import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson, uuidFile } from './store.mjs';
import { digest } from './journal.mjs';
import { GoodnotesError, checkCancellation } from './errors.mjs';
import { searchPages } from './pdf.mjs';

const inside = (item, root) => root.every((id, i) => item.itemPath[i] === id);
export class CatalogController {
  constructor(adapter) {
    this.a = adapter;
    this.directory = path.join(adapter.config.directory, 'catalog');
    this.file = path.join(this.directory, 'catalog.json');
  }
  async load() {
    return readJson(this.file, { schema: 1, items: {}, updatedAt: null });
  }
  async dirty(url) {
    const catalog = await this.load();
    let changed = false;
    for (const item of Object.values(catalog.items))
      if (item.url === url) {
        item.dirty = true;
        changed = true;
      }
    if (changed) await writeJson(this.file, catalog);
  }
  async refresh(
    {
      jobId,
      folderPath = [],
      includeText = true,
      ocr = false,
      recursive = true,
      force = false,
      maxAgeHours = 24,
      maxSteps = 1,
    } = {},
    { signal } = {},
  ) {
    let job;
    if (jobId) {
      job = await readJson(uuidFile(this.directory, jobId), null);
      if (!job) throw new GoodnotesError('JOB_NOT_FOUND', 'Index refresh not found.');
    } else {
      jobId = crypto.randomUUID();
      job = {
        jobId,
        status: 'running',
        startedAt: new Date().toISOString(),
        folderPath,
        includeText,
        ocr,
        recursive,
        force,
        maxAgeHours,
        queue: [{ kind: 'folder', path: folderPath }],
        visited: [],
        processed: 0,
        exported: 0,
        reused: 0,
        errors: [],
        incompleteFolders: [],
      };
      await writeJson(uuidFile(this.directory, jobId), job);
    }
    const catalog = await this.load();
    for (let n = 0; n < maxSteps && job.queue.length; n++) {
      checkCancellation(signal);
      const step = job.queue[0];
      try {
        if (step.kind === 'folder') {
          const listing = await this.a.list({ folderPath: step.path, limit: 10000 });
          if (listing.truncated) job.incompleteFolders.push(step.path);
          const seen = new Set(listing.items.map((i) => i.id));
          if (!listing.truncated)
            for (const item of Object.values(catalog.items)) {
              if (
                JSON.stringify(item.itemPath.slice(0, -1)) === JSON.stringify(step.path) &&
                !seen.has(item.id)
              ) {
                item.missing = true;
                if (item.kind === 'folder')
                  for (const child of Object.values(catalog.items))
                    if (inside(child, item.itemPath)) child.missing = true;
              }
            }
          for (const item of listing.items) {
            const old = catalog.items[item.id];
            const fingerprint = digest({
              title: item.title,
              kind: item.kind,
              revisionHint: item.revisionHint,
            });
            catalog.items[item.id] = {
              ...old,
              ...item,
              missing: false,
              seenAt: new Date().toISOString(),
              fingerprint,
              dirty: old?.dirty || old?.fingerprint !== fingerprint,
            };
            if (item.kind === 'folder') {
              if (job.recursive && step.path.length >= 12)
                job.incompleteFolders.push(item.itemPath);
              if (job.recursive && step.path.length < 12 && !job.visited.includes(item.id)) {
                job.visited.push(item.id);
                job.queue.push({ kind: 'folder', path: item.itemPath });
              }
            } else if (job.includeText) job.queue.push({ kind: 'document', id: item.id });
          }
        } else if (step.kind === 'ocr') {
          const item = catalog.items[step.id];
          if (item.exportId === step.exportId) {
            await this.a.documents.recognize(
              { exportId: step.exportId, startPage: step.page, endPage: step.page },
              { signal },
            );
            const { index } = await this.a.documents.get(step.exportId);
            item.characters = index.totalCharacters;
          }
        } else {
          const item = catalog.items[step.id];
          const fresh =
            item.exportId &&
            !item.dirty &&
            Date.now() - Date.parse(item.indexedAt) < job.maxAgeHours * 3600000;
          if (!job.force && fresh) job.reused++;
          else {
            const view = await this.a.openItem({ itemPath: item.itemPath });
            const record = await this.a.documents.exportPdf({ url: view.url }, { signal });
            Object.assign(item, {
              url: record.url,
              exportId: record.exportId,
              indexedAt: record.exportedAt,
              pageCount: record.pageCount,
              characters: record.totalCharacters,
              dirty: false,
            });
            job.exported++;
          }
          if (job.ocr && item.exportId) {
            const { index } = await this.a.documents.get(item.exportId);
            for (const page of index.pages)
              if (!page.ocr && page.text.trim().length < 30)
                job.queue.push({
                  kind: 'ocr',
                  id: item.id,
                  exportId: item.exportId,
                  page: page.page,
                });
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error; // Keep the read step pending on cancellation.
        job.errors.push({
          step,
          code: error.code || 'INDEX_FAILED',
          message: error.message.slice(0, 400),
        });
      }
      job.queue.shift();
      job.processed++;
      catalog.updatedAt = new Date().toISOString();
      await writeJson(this.file, catalog);
      await writeJson(uuidFile(this.directory, jobId), job);
    }
    job.status = job.queue.length
      ? 'running'
      : job.errors.length || job.incompleteFolders.length
        ? 'completed-with-gaps'
        : 'completed';
    await writeJson(uuidFile(this.directory, jobId), job);
    return {
      jobId,
      status: job.status,
      processed: job.processed,
      pending: job.queue.length,
      exported: job.exported,
      reused: job.reused,
      errors: job.errors,
      incompleteFolders: job.incompleteFolders,
      indexedDocuments: Object.values(catalog.items).filter((i) => i.exportId && !i.missing).length,
      freshness:
        'Visible library hints plus a time limit; Goodnotes exposes no reliable content revision here. Use force=true for a new snapshot of every document.',
    };
  }
  async search(
    {
      query = '',
      folderPath = [],
      kind,
      content = true,
      offset = 0,
      limit = 30,
      includeMissing = false,
    },
    { signal } = {},
  ) {
    const catalog = await this.load(),
      results = [];
    let total = 0,
      searchableDocuments = 0,
      unindexedDocuments = 0,
      unavailableSnapshots = 0;
    for (const item of Object.values(catalog.items).sort((a, b) =>
      a.title.localeCompare(b.title),
    )) {
      checkCancellation(signal);
      if (
        !inside(item, folderPath) ||
        (!includeMissing && item.missing) ||
        (kind && item.kind !== kind)
      )
        continue;
      let hits = null,
        error = null;
      if (item.kind !== 'folder' && !item.exportId) unindexedDocuments++;
      if (content && query && item.exportId) {
        try {
          const { index } = await this.a.documents.get(item.exportId);
          searchableDocuments++;
          hits = searchPages(index.pages, query, { limit: 3 });
        } catch (e) {
          error = e.code || 'SNAPSHOT_UNAVAILABLE';
          unavailableSnapshots++;
        }
      }
      const titleMatch = item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase());
      if (!titleMatch && !hits?.total) continue;
      if (total++ >= offset && results.length < limit)
        results.push({
          ...item,
          titleMatch,
          matches: hits?.matches || [],
          matchCount: hits?.total || 0,
          pagesWithoutText: hits?.pagesWithoutText || [],
          snapshotError: error,
        });
    }
    return {
      query,
      results,
      total,
      nextOffset: offset + results.length < total ? offset + results.length : null,
      catalogUpdatedAt: catalog.updatedAt,
      searchableDocuments,
      unindexedDocuments,
      unavailableSnapshots,
      note: 'Local snapshots only. OCR can miss text. Missing text and incomplete folder scans do not prove absence.',
    };
  }
}
