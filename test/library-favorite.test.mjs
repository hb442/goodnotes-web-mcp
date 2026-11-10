import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LibraryController } from '../src/library.mjs';
import { Journal } from '../src/journal.mjs';
test('document favorites keep exact authorization/title/state guards and block uncertain replay', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-favorite-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const id = '00000000-0000-4000-8000-000000000001',
    url = 'https://web.goodnotes.com/s/FavoriteFixture123';
  let saved = false,
    current = false,
    persist = true,
    writes = 0;
  const a = {
    config: { directory, documents: [] },
    journal: new Journal(directory),
    openItem: async () => ({ url, title: 'Fixture' }),
    invalidate: () => {},
  };
  const c = new LibraryController(a),
    page = { waitForTimeout: async () => {} },
    base = { itemPath: [id], expectedTitle: 'Fixture', expectedFavorite: false, favorite: true };
  c.folder = async () => {
    current = saved;
    return { page, listing: { items: [{ id, kind: 'canvas', title: 'Fixture' }] } };
  };
  c.favoriteState = async () => ({
    favorite: current,
    control: {
      click: async () => {
        writes++;
        current = !current;
        if (persist) saved = current;
      },
    },
  });
  await assert.rejects(
    c.setFavorite({ ...base, operationId: 'favorite-not-authorized' }),
    (e) => e.code === 'WRITE_NOT_ALLOWED' && !e.details.mayHaveWritten,
  );
  assert.equal(writes, 0);
  a.config.documents = [{ url, title: 'Fixture' }];
  await assert.rejects(
    c.setFavorite({ ...base, expectedTitle: 'Changed', operationId: 'favorite-wrong-title' }),
    (e) => e.code === 'DOCUMENT_CONFLICT' && !e.details.mayHaveWritten,
  );
  await assert.rejects(
    c.setFavorite({ ...base, expectedFavorite: true, operationId: 'favorite-wrong-state' }),
    (e) => e.code === 'FAVORITE_CONFLICT' && !e.details.mayHaveWritten,
  );
  assert.equal(writes, 0);
  const args = { ...base, operationId: 'favorite-success' };
  assert.equal((await c.setFavorite(args)).favorite, true);
  assert.equal((await c.setFavorite(args)).replayed, true);
  assert.equal(writes, 1);
  persist = false;
  await assert.rejects(
    c.setFavorite({
      ...base,
      expectedFavorite: true,
      favorite: false,
      operationId: 'favorite-unsaved',
    }),
    (e) => e.code === 'SAVE_UNVERIFIED' && e.details.mayHaveWritten,
  );
  assert.equal((await a.journal.get('favorite-unsaved')).status, 'uncertain');
  await assert.rejects(
    c.setFavorite({
      ...base,
      expectedFavorite: true,
      favorite: false,
      operationId: 'favorite-unsaved',
    }),
  );
  assert.equal(writes, 2);
});
