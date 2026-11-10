import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../src/journal.mjs';
import { ObjectController } from '../src/objects.mjs';
test('copy reconciliation rejects missing, mismatched and inconsistent checkpoints without opening browser or replaying paste', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-copy-check-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = new Journal(directory),
    id = 'copy-checkpoint-001';
  let opened = 0;
  const c = new ObjectController({
    config: { directory },
    journal,
    getPage: async () => {
      opened++;
      throw Error('Unexpected browser access');
    },
  });
  await assert.rejects(c.verifyCopiedText({ operationId: '../bad-path' }));
  await assert.rejects(
    c.verifyCopiedText({ operationId: id }),
    (e) => e.code === 'COPY_CHECKPOINT_NOT_FOUND',
  );
  const { record } = await journal.begin(id, { action: 'copy' });
  await journal.finish(id, 'uncertain', { mayHaveWritten: true });
  await fs.mkdir(path.join(directory, 'copy-checkpoints'));
  const file = path.join(directory, 'copy-checkpoints', id + '.json');
  await fs.writeFile(file, JSON.stringify({ fingerprint: 'wrong' }));
  await assert.rejects(
    c.verifyCopiedText({ operationId: id }),
    (e) => e.code === 'COPY_CHECKPOINT_NOT_FOUND',
  );
  await fs.writeFile(
    file,
    JSON.stringify({
      fingerprint: record.fingerprint,
      operationId: id,
      url: 'https://web.goodnotes.com/s/SyntheticDestination',
      pageUrl: 'https://web.goodnotes.com/s/AnotherDestination#page-1',
    }),
  );
  await assert.rejects(
    c.verifyCopiedText({ operationId: id }),
    (e) => e.code === 'COPY_CHECKPOINT_INVALID',
  );
  assert.equal(opened, 0);
  assert.equal((await journal.get(id)).status, 'uncertain');
});
