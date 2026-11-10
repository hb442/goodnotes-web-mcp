import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FolderController,
  authorizeFolder,
  revokeFolder,
  requireFolderPermission,
  updateFolderPermission,
  folderPermissions,
  validateFolderMove,
} from '../src/folders.mjs';
import { Journal } from '../src/journal.mjs';
const A = '00000000-0000-4000-8000-000000000001',
  B = '00000000-0000-4000-8000-000000000002',
  C = '00000000-0000-4000-8000-000000000003';
test('folder permissions bind exact path/title and moving a parent updates only its authorized descendants', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-folders-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await authorizeFolder(dir, [A], 'Parent');
  await authorizeFolder(dir, [A, B], 'Child');
  await authorizeFolder(dir, [C], 'Other');
  await assert.rejects(
    requireFolderPermission(dir, [A], 'Different'),
    (e) => e.code === 'FOLDER_WRITE_NOT_ALLOWED',
  );
  await assert.rejects(
    requireFolderPermission(dir, [C, A], 'Parent'),
    (e) => e.code === 'FOLDER_WRITE_NOT_ALLOWED',
  );
  await updateFolderPermission(dir, [A], [C, A], 'Moved');
  await requireFolderPermission(dir, [C, A], 'Moved');
  await requireFolderPermission(dir, [C, A, B], 'Child');
  await requireFolderPermission(dir, [C], 'Other');
  assert.equal((await folderPermissions(dir)).length, 3);
  assert.equal((await revokeFolder(dir, [C, A])).removed, true);
  await assert.rejects(
    requireFolderPermission(dir, [C, A], 'Moved'),
    (e) => e.code === 'FOLDER_WRITE_NOT_ALLOWED',
  );
});
test('folder management rejects absent authorization, changed titles and cycles before any mutation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-folder-guard-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let reads = 0,
    renames = 0;
  const a = {
      config: { directory },
      journal: new Journal(directory),
      library: {
        folder: async () => {
          reads++;
          return { listing: { items: [{ id: A, kind: 'folder', title: 'Changed' }] } };
        },
        renameCard: async () => renames++,
      },
    },
    c = new FolderController(a);
  await assert.rejects(
    c.manage({
      action: 'rename',
      itemPath: [A],
      expectedTitle: 'Original',
      title: 'New',
      operationId: 'folder-no-permission',
    }),
    (e) => e.code === 'FOLDER_WRITE_NOT_ALLOWED' && !e.details.mayHaveWritten,
  );
  assert.equal(reads, 0);
  await authorizeFolder(directory, [A], 'Original');
  await assert.rejects(
    c.manage({
      action: 'rename',
      itemPath: [A],
      expectedTitle: 'Original',
      title: 'New',
      operationId: 'folder-title-conflict',
    }),
    (e) => e.code === 'FOLDER_CONFLICT' && !e.details.mayHaveWritten,
  );
  assert.equal(renames, 0);
  assert.throws(
    () => validateFolderMove([A], [A]),
    (e) => e.code === 'INVALID_FOLDER_MOVE',
  );
  assert.throws(
    () => validateFolderMove([A], [A, B]),
    (e) => e.code === 'INVALID_FOLDER_MOVE',
  );
  assert.throws(
    () => validateFolderMove(['../outside'], []),
    (e) => e.code === 'INVALID_FOLDER_PATH',
  );
});
test('verified folder rename checks its children before updating permission or returning success', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-folder-rename-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let name = 'Before',
    children = [{ id: B, kind: 'folder', title: 'Child' }],
    writes = 0;
  const a = {
    config: { directory },
    journal: new Journal(directory),
    invalidate: () => {},
    library: {
      folder: async (p) => ({
        page: {},
        listing: { items: p.length ? children : [{ id: A, kind: 'folder', title: name }] },
      }),
      renameCard: async (p, id, title, mark) => {
        mark();
        writes++;
        name = title;
      },
    },
  };
  await authorizeFolder(directory, [A], name);
  const c = new FolderController(a),
    args = {
      action: 'rename',
      itemPath: [A],
      expectedTitle: name,
      title: 'After',
      operationId: 'folder-rename-success',
    };
  assert.equal((await c.manage(args)).verified, true);
  await requireFolderPermission(directory, [A], 'After');
  assert.equal((await c.manage(args)).replayed, true);
  assert.equal(writes, 1);
  a.library.renameCard = async (p, id, title, mark) => {
    mark();
    name = title;
    children = [];
  };
  await assert.rejects(
    c.manage({
      action: 'rename',
      itemPath: [A],
      expectedTitle: 'After',
      title: 'Uncertain',
      operationId: 'folder-children-changed',
    }),
    (e) => e.code === 'SAVE_UNVERIFIED' && e.details.mayHaveWritten,
  );
  assert.equal((await a.journal.get('folder-children-changed')).status, 'uncertain');
  await requireFolderPermission(directory, [A], 'After');
});
