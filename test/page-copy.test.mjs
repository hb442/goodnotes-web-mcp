import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PageController } from '../src/pages.mjs';
import { Journal } from '../src/journal.mjs';
test('native page copy rejects stale destination/source and unauthorized targets before any paste', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-page-copy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceUrl = 'https://web.goodnotes.com/s/SyntheticSource123',
    dest = 'https://web.goodnotes.com/s/SyntheticDestination123';
  const a = {
    config: { documents: [{ url: dest, title: 'Destination' }] },
    journal: new Journal(directory),
    openItem: async () => ({ url: dest, title: 'Destination' }),
  };
  const c = new PageController(a);
  c.list = async ({ url }) => ({
    url,
    count: 2,
    orderHash: url === dest ? 'destination-current' : 'source-current',
  });
  const args = {
    sourceUrl,
    sourcePage: 1,
    expectedSourceOrderHash: 'source-current',
    destinationPath: ['synthetic'],
    destinationPage: 1,
    expectedPageCount: 2,
    expectedOrderHash: 'destination-current',
  };
  await assert.rejects(
    c.copyNative({ ...args, expectedOrderHash: 'stale', operationId: 'copy-conflict-destination' }),
    (e) => e.code === 'PAGE_CONFLICT' && e.details.mayHaveWritten === false,
  );
  await assert.rejects(
    c.copyNative({
      ...args,
      expectedSourceOrderHash: 'stale',
      operationId: 'copy-conflict-source',
    }),
    (e) => e.code === 'PAGE_CONFLICT' && e.details.mayHaveWritten === false,
  );
  await assert.rejects(
    c.copyNative({ ...args, sourceUrl: dest, operationId: 'copy-conflict-same-document' }),
    (e) => e.code === 'SAME_DOCUMENT',
  );
  a.config.documents = [];
  await assert.rejects(
    c.copyNative({ ...args, operationId: 'copy-unauthorized-document' }),
    (e) => e.code === 'WRITE_NOT_ALLOWED' && e.details.mayHaveWritten === false,
  );
});
