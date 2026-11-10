import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  documentUrl,
  loadConfig,
  authorizeDocument,
  revokeDocument,
  selectBrowser,
} from '../src/config.mjs';
import { manualLoginArguments } from '../src/browser.mjs';
import { acquireLock } from '../src/lock.mjs';
import { Journal } from '../src/journal.mjs';
import { SerialQueue, validPoint, normalizeText } from '../src/adapter.mjs';

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gnmcp-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const url = 'https://web.goodnotes.com/s/TestDocument123';

test('only exact Goodnotes document URLs are accepted', () => {
  assert.equal(documentUrl(url + '/#page-2'), url);
  for (const bad of [
    'file:///etc/passwd',
    'http://web.goodnotes.com/s/TestDocument123',
    'https://web.goodnotes.com.evil.example/s/TestDocument123',
    'https://user:pass@web.goodnotes.com/s/TestDocument123',
    url + '?token=secret',
    url + '#other',
    'https://web.goodnotes.com/home',
    url + '/../../home',
  ])
    assert.throws(() => documentUrl(bad));
});
test('no document is writable by default; authorization binds URL and exact title', async (t) => {
  const dir = await temporary(t);
  assert.deepEqual((await loadConfig(dir)).documents, []);
  await authorizeDocument(dir, url, 'Test – Board');
  await authorizeDocument(dir, url, 'Renamed');
  assert.deepEqual((await loadConfig(dir)).documents, [{ url, title: 'Renamed' }]);
  assert.equal((await revokeDocument(dir, url)).removed, true);
  assert.deepEqual((await loadConfig(dir)).documents, []);
  await fs.writeFile(path.join(dir, 'config.json'), 'not json');
  await assert.rejects(loadConfig(dir), /Could not read/);
});
test('exclusive profile lock blocks another process and releases cleanly', async (t) => {
  const dir = await temporary(t);
  const release = await acquireLock(dir);
  await assert.rejects(acquireLock(dir), /already in use/);
  await release();
  const release2 = await acquireLock(dir);
  await release2();
});
test('lock owner does not remove a replacement lock', async (t) => {
  const dir = await temporary(t),
    release = await acquireLock(dir);
  await fs.writeFile(
    path.join(dir, 'session.lock'),
    JSON.stringify({ pid: process.pid, nonce: 'different-owner' }),
  );
  await release();
  assert.equal(
    JSON.parse(await fs.readFile(path.join(dir, 'session.lock'), 'utf8')).nonce,
    'different-owner',
  );
});
test('uncertain operations cannot replay, verified ones return receipts, text is not stored', async (t) => {
  const dir = await temporary(t),
    journal = new Journal(dir);
  const input = { text: 'private test content', x: 0.5 };
  assert.equal((await journal.begin('operation-001', input)).fresh, true);
  await assert.rejects(journal.begin('operation-001', input), /may already/);
  await journal.finish('operation-001', 'verified', { verified: true });
  assert.equal((await journal.begin('operation-001', input)).record.result.verified, true);
  assert.equal((await journal.get('operation-001')).status, 'verified');
  assert.equal((await journal.get('operation-missing')).status, 'not-found');
  await assert.rejects(journal.begin('operation-001', { text: 'different' }), /different input/);
  assert.equal(
    (await fs.readFile(journal.file('operation-001'), 'utf8')).includes(input.text),
    false,
  );
  assert.throws(() => journal.file('../../escape'));
});
test('browser operations are serialized even after a failure', async () => {
  const queue = new SerialQueue(),
    events = [];
  const a = queue.run(async () => {
    events.push('a-start');
    await new Promise((r) => setTimeout(r, 5));
    events.push('a-end');
    throw Error('test');
  });
  const b = queue.run(async () => events.push('b'));
  await assert.rejects(a);
  await b;
  assert.deepEqual(events, ['a-start', 'a-end', 'b']);
});
test('positions reject invalid numbers and preserve meaningful Unicode/newlines', () => {
  validPoint(0.5, 0.5);
  for (const pair of [
    [NaN, 0.5],
    [Infinity, 0.5],
    [-1, 0.5],
    [0.5, 0],
  ])
    assert.throws(() => validPoint(...pair));
  assert.equal(normalizeText('\uFEFFÄÖÜ\r\n\r\nß'), 'ÄÖÜ\n\nß');
});

test('browser selection preserves write permissions and uses a distinct helper profile', async (t) => {
  const dir = await temporary(t);
  await authorizeDocument(dir, url, 'Test Board');
  const before = await loadConfig(dir);
  const config = await selectBrowser(dir, 'chrome');
  assert.equal(config.browser, 'chrome');
  assert.notEqual(config.profile, before.profile);
  assert.equal(path.dirname(config.profile), dir);
  assert.deepEqual(config.documents, before.documents);
  await authorizeDocument(dir, url, 'Renamed');
  assert.equal((await loadConfig(dir)).browser, 'chrome');
  await revokeDocument(dir, url);
  assert.equal((await loadConfig(dir)).browser, 'chrome');
  await assert.rejects(selectBrowser(dir, '../../other'), /Use chrome/);
});

test('manual login does not enable automation, debugging or disabled security protections', () => {
  const profile = path.join(os.tmpdir(), 'gnmcp-example', 'browser-profile-chrome');
  const args = manualLoginArguments(profile);
  assert.deepEqual(args, [
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://web.goodnotes.com/home',
  ]);
  assert.throws(() => manualLoginArguments('relative-profile'));
});
