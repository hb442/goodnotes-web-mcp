import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { worldBox, screenBox, sameHit, BoardScanController } from '../src/board-scan.mjs';
import { createCanvas } from '@napi-rs/canvas';
test('world locations preserve geometry across zoom and pan; repeated nearby OCR hits merge without merging distant same-text objects', () => {
  const anchor = { x: -1000, y: -2000, scale: 0.5 },
    bounds = { x: 100, y: 150, width: 90, height: 20 };
  assert.deepEqual(screenBox(worldBox(bounds, anchor), anchor), bounds);
  const a = { text: 'ALPHA', world: { x: 100, y: 100, width: 90, height: 20 } };
  assert.equal(sameHit(a, { text: 'alpha', world: { ...a.world, x: 102 } }), true);
  assert.equal(sameHit(a, { text: 'ALPHA', world: { ...a.world, x: 500 } }), false);
  assert.equal(sameHit(a, { text: 'BETA', world: a.world }), false);
});
test('board scan persists a bounded region and resumes without repeating saved tiles', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-scan-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let finds = 0;
  const anchor = { pageId: 'native-board', x: 0, y: 0, scale: 1 },
    view = {
      viewId: 'v',
      title: 'Synthetic',
      pageUrl: 'https://web.goodnotes.com/s/SyntheticDocument123#page-1',
      canvas: { x: 0, y: 0, width: 1000, height: 800 },
    };
  const page = {};
  const a = {
    config: { directory },
    inspect: async () => view,
    getPage: async () => page,
    getView: () => view,
    objects: { readingMode: async () => {} },
    navigate: async ({ panX = 0, panY = 0 }) => {
      anchor.x -= panX;
      anchor.y -= panY;
      return view;
    },
    board: {
      find: async () => {
        finds++;
        return {
          matches: [
            {
              text: 'ALPHA',
              confidence: 90,
              x: 0.2,
              y: 0.2,
              bounds: { x: 200, y: 200, width: 90, height: 20 },
            },
          ],
        };
      },
    },
  };
  const controller = () => {
    const c = new BoardScanController(a);
    c.anchor = async () => ({ ...anchor });
    c.position = async (_url, target) => {
      Object.assign(anchor, target);
      return { view, page, anchor: { ...anchor } };
    };
    return c;
  };
  let c = controller(),
    job = await c.scan({ url: view.pageUrl, columns: 2, rows: 1, maxTiles: 1 });
  assert.equal(job.status, 'running');
  c = controller();
  job = await c.scan({ scanId: job.scanId, maxTiles: 1 });
  assert.equal(job.status, 'completed-region');
  assert.equal(finds, 2);
  await c.scan({ scanId: job.scanId, maxTiles: 3 });
  assert.equal(finds, 2);
  const results = await c.search({ scanId: job.scanId, query: 'alpha' });
  assert.equal(results.total, 2);
});

test('saved object recall rejects a different native selection even if the bookmarked pixels are unchanged', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-recall-bounds-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bounds = { x: 200, y: 200, width: 160, height: 80 },
    anchor = { x: 0, y: 0, scale: 1, pageId: 'board' },
    canvas = createCanvas(800, 600),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 800, 600);
  ctx.fillStyle = 'black';
  ctx.fillRect(220, 220, 40, 40);
  const page = {
      screenshot: async () => canvas.toBuffer('image/png'),
      waitForTimeout: async () => {},
    },
    view = {
      viewId: 'view',
      url: 'https://web.goodnotes.com/s/SyntheticRecall',
      pageUrl: 'https://web.goodnotes.com/s/SyntheticRecall#page-1',
    };
  let actual = { ...bounds };
  const a = {
      config: { directory },
      getView: () => view,
      styles: { selection: async () => ({ s: { bounds }, view, page }) },
      objects: {
        readingMode: async () => {},
        reselectBounds: async () => {},
        snapshot: async () => ({ bounds: actual, hash: 'selected', kind: 'text-box' }),
        selections: new Map(),
      },
    },
    c = new BoardScanController(a);
  c.selectionAnchor = async () => anchor;
  c.position = async () => ({ view, anchor, page });
  const remembered = await c.remember({ selectionId: 'selected', label: 'Fixture' });
  const recalled = await c.recall({ objectId: remembered.objectId });
  assert.ok(recalled.selectionId);
  assert.equal(recalled.kind, 'text-box');
  assert.equal(a.objects.selections.get(recalled.selectionId).kind, 'text-box');
  actual = { ...bounds, width: bounds.width + 100 };
  await assert.rejects(
    c.recall({ objectId: remembered.objectId }),
    (e) => e.code === 'SAVED_SELECTION_CHANGED',
  );
});
test('notebook appearance checkpoints tolerate raster shifts, reject missing content and detect changed checkpoint files', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-notebook-bookmark-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const canvas = createCanvas(800, 600),
    ctx = canvas.getContext('2d'),
    anchor = { kind: 'notebook', pageId: 'page', x: 0, y: 0, scale: 1 },
    bounds = { x: 200, y: 200, width: 160, height: 80 },
    view = {
      viewId: 'v',
      url: 'https://web.goodnotes.com/s/SyntheticBookmark',
      pageUrl: 'https://web.goodnotes.com/s/SyntheticBookmark#page-2',
    },
    draw = (offset = 0) => {
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, 800, 600);
      ctx.fillStyle = 'black';
      ctx.fillRect(220 + offset, 220, 40, 40);
    };
  draw();
  const page = {
      screenshot: async () => canvas.toBuffer('image/png'),
      waitForTimeout: async () => {},
    },
    a = {
      config: { directory },
      getView: () => view,
      styles: { selection: async () => ({ s: { bounds }, view, page }) },
      objects: {
        readingMode: async () => {},
        reselectBounds: async () => {},
        snapshot: async () => ({ bounds, hash: 'selected' }),
        selections: new Map(),
      },
    },
    c = new BoardScanController(a);
  c.selectionAnchor = async () => anchor;
  c.position = async () => ({ view, anchor, page });
  const bookmark = await c.remember({ selectionId: 'selected', label: 'Page text' });
  draw(1);
  const loadedScreenshot = page.screenshot;
  let reads = 0;
  page.screenshot = async () =>
    ++reads === 1 ? createCanvas(800, 600).toBuffer('image/png') : loadedScreenshot();
  assert.ok((await c.recall({ objectId: bookmark.objectId })).selectionId);
  assert.equal(reads, 2);
  page.screenshot = loadedScreenshot;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 800, 600);
  await assert.rejects(
    c.recall({ objectId: bookmark.objectId }),
    (e) => e.code === 'SAVED_OBJECT_CHANGED',
  );
  await fs.writeFile(
    path.join(directory, 'board-scans', 'objects', bookmark.objectId + '.png'),
    canvas.toBuffer('image/png'),
  );
  await assert.rejects(
    c.recall({ objectId: bookmark.objectId }),
    (e) => e.code === 'BOOKMARK_CHECKPOINT_CHANGED',
  );
});
