import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { ObjectController } from '../../src/objects.mjs';
import { Journal } from '../../src/journal.mjs';

test('native visual-copy audit compares captured source and saved destination without replaying paste', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-visual-audit-')),
    browser = await chromium.launch({ headless: true }),
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  t.after(async () => {
    await browser.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const url = 'https://web.goodnotes.com/s/VisualDestination',
    pageId = '11111111-2222-4333-8444-555555555555',
    bounds = { x: 390, y: 240, width: 400, height: 150 };
  let color = 'green';
  await page.route('https://web.goodnotes.com/**', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<style>body{margin:0;background:white}</style><div id="interaction-layer-page-${pageId}" style="position:absolute;width:1200px;height:800px"></div><svg id="art" width="1200" height="800" style="position:absolute"><rect x="400" y="250" width="190" height="120" fill="none" stroke="${color}" stroke-width="5"/><ellipse cx="710" cy="310" rx="70" ry="55" fill="none" stroke="green" stroke-width="5"/></svg>`,
    }),
  );
  await page.goto(url);
  const expected = await page.screenshot();
  await page.locator('#art').evaluate((e) => (e.style.transform = 'translateX(-200px)'));
  const source = await page.screenshot();
  await page.locator('#art').evaluate((e) => (e.style.display = 'none'));
  const before = await page.screenshot();
  const journal = new Journal(directory),
    operationId = 'visual-audit-copy',
    receipt = await journal.begin(operationId, { action: 'copy' });
  await journal.finish(operationId, 'uncertain', { mayHaveWritten: true });
  const folder = path.join(directory, 'copy-checkpoints');
  await fs.mkdir(folder);
  const record = {
    operationId,
    fingerprint: receipt.record.fingerprint,
    url,
    pageUrl: url,
    title: 'Fixture',
    destinationPage: 1,
    kind: 'visual-selection',
    frame: { pageId, x: 0, y: 0, width: 1200, height: 800 },
    bounds,
    createdBounds: bounds,
    visual: {
      sourceBounds: { ...bounds, x: 190 },
      sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    },
  };
  await fs.writeFile(path.join(folder, operationId + '.json'), JSON.stringify(record));
  for (const [suffix, bytes] of [
    ['source', source],
    ['expected', expected],
    ['before', before],
  ])
    await fs.writeFile(path.join(folder, operationId + '-' + suffix + '.png'), bytes);
  const view = {
      viewId: 'view',
      viewport: { width: 1200, height: 800 },
      url,
      pageUrl: url,
      title: 'Fixture',
      canvas: { x: 0, y: 0, width: 1200, height: 800 },
    },
    a = {
      config: { directory, documents: [{ url, title: 'Fixture' }] },
      journal,
      getPage: async () => page,
      inspect: async () => view,
      getView: () => view,
      documents: { invalidate: async () => {} },
    },
    c = new ObjectController(a);
  let selected = 0;
  c.readingMode = async () => {};
  c.select = async ({ region }) => {
    assert.ok(region.width > 0);
    selected++;
    return { selectionId: 'selected' };
  };
  c.snapshot = async () => ({ bounds, hash: 'selection' });
  c.evidence = async () => ({});
  const result = await c.verifyCopiedText({ operationId });
  assert.equal(result.verified, true);
  assert.equal(result.kind, 'visual-selection');
  assert.equal(result.sourceAppearance.matches, true);
  assert.equal(result.originalReceiptStatus, 'uncertain');
  assert.equal((await journal.get(operationId)).status, 'uncertain');
  assert.equal(selected, 1);
  assert.ok(c.selections.get(result.selectionId).region);
  await fs.writeFile(path.join(folder, operationId + '-source.png'), before);
  await assert.rejects(
    c.verifyCopiedText({ operationId }),
    (e) => e.code === 'COPY_CHECKPOINT_INVALID',
  );
  assert.equal(selected, 1);
  await fs.writeFile(path.join(folder, operationId + '-source.png'), source);
  color = 'red';
  await assert.rejects(c.verifyCopiedText({ operationId }), (e) => e.code === 'SAVE_UNVERIFIED');
  assert.equal(selected, 1);
  assert.equal((await journal.get(operationId)).status, 'uncertain');
});
