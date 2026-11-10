import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../src/journal.mjs';
import { StyleController } from '../src/styles.mjs';
test('sticky expansion rejects missing or mismatched collapse checkpoints before clicking', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-sticky-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = new Journal(directory),
    a = { config: { directory, documents: [] }, journal },
    c = new StyleController(a),
    collapseOperationId = 'sticky-collapse-001';
  await assert.rejects(
    c.expandSticky({ collapseOperationId, operationId: 'sticky-expand-001' }),
    (e) => e.code === 'STICKY_CHECKPOINT_REQUIRED',
  );
  await journal.begin(collapseOperationId, { action: 'collapse' });
  await journal.finish(collapseOperationId, 'verified', {});
  await fs.mkdir(path.join(directory, 'sticky-checkpoints'));
  await fs.writeFile(
    path.join(directory, 'sticky-checkpoints', collapseOperationId + '.json'),
    JSON.stringify({ operationId: collapseOperationId, fingerprint: 'different' }),
  );
  await assert.rejects(
    c.expandSticky({ collapseOperationId, operationId: 'sticky-expand-001' }),
    (e) => e.code === 'STICKY_CHECKPOINT_REQUIRED',
  );
  assert.equal((await journal.get('sticky-expand-001')).status, 'not-found');
});
