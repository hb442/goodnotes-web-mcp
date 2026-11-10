import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GoodnotesAdapter } from '../../src/adapter.mjs';
import { readRichText, selectRange } from '../../src/text.mjs';
import { readPlainText } from '../../src/rich-text.mjs';
import { StyleController } from '../../src/styles.mjs';

const url = 'https://web.goodnotes.com/s/TestDocument123';
const html = await fs.readFile(new URL('../fixtures/goodnotes.html', import.meta.url), 'utf8');
let browser;
test('flat list text and UTF-16 ranges agree across paragraphs, empty lines and emoji', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent(
    '<div id="editor" contenteditable="true"><p>Intro</p><ol><li data-list="ordered">A😀lpha</li><li data-list-style="bullet">Beta</li><li><br></li></ol><p>End</p></div>',
  );
  const e = page.locator('#editor');
  assert.equal(await e.evaluate(readPlainText), 'Intro\nA😀lpha\nBeta\n\nEnd');
  const runs = await e.evaluate(readRichText);
  assert.equal(runs.find((r) => r.text === 'A😀lpha').list, 'ordered');
  assert.equal(runs.find((r) => r.text === 'Beta').list, 'bullet');
  assert.equal(runs.find((r) => r.text === 'Beta').start, 14);
  assert.equal(await selectRange(e, 14, 18), 'Beta');
  assert.equal(await selectRange(e, 7, 9), '😀');
});
before(async () => {
  browser = await chromium.launch({ headless: true, channel: 'chromium', chromiumSandbox: true });
});
test('library reads expose native notebook and folder favorite flags without guessing missing controls', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent(
    '<div data-document-id="a" data-document-type="canvas"><p id="libraryDocumentWhiteboardNameId-a">Board</p><svg id="libraryDocumentNotebookFavorited_a_true"></svg></div><div data-document-id="b" data-document-type="folder"><p id="libraryFolderTitle-b">Folder</p><svg id="libraryDocumentFolderFavorited_b_false"></svg></div><div data-document-id="c" data-document-type="document"><p id="libraryDocumentNameId-c">Unknown</p></div>',
  );
  const items = await GoodnotesAdapter.prototype.readLibraryCards.call({}, page);
  assert.deepEqual(
    items.map((i) => i.favorite),
    [true, false, null],
  );
});
test('native text highlights follow nested spans and retain mixed run boundaries', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent(
    '<div id="e"><p><span data-highlight="#FFFF0080"><strong>Alpha</strong></span><span>Beta</span><span data-highlight="#11223300">Clear</span></p></div>',
  );
  const runs = await page.locator('#e').evaluate(readRichText);
  assert.deepEqual(
    runs.map((r) => [r.text, r.highlight]),
    [
      ['Alpha', '#ffff0080'],
      ['BetaClear', undefined],
    ],
  );
  assert.equal(runs[0].bold, true);
  assert.equal(runs[1].start, 5);
});
test('highlight formatting rejects partial fields and externally changed highlight before mutation', async (t) => {
  const { adapter, page, view } = await fixture(t);
  const target = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  await assert.rejects(
    adapter.text.edit({
      targetId: target.targetId,
      start: 0,
      end: 3,
      format: { highlight: '#ffff00' },
      operationId: 'highlight-partial-field',
    }),
    (e) => e.code === 'LIST_RANGE_REQUIRED',
  );
  await page.evaluate(() => {
    const rich = {
      text: 'Original note',
      html: '<p><span data-highlight="#ffff0080">Original note</span></p>',
    };
    localStorage.setItem('fixture-rich', JSON.stringify(rich));
  });
  await assert.rejects(
    adapter.text.edit({
      targetId: target.targetId,
      format: { highlight: 'none' },
      operationId: 'highlight-external-change',
    }),
    (e) => e.code === 'TEXT_CONFLICT' && !e.details.mayHaveWritten,
  );
  assert.equal((await adapter.journal.get('highlight-external-change')).status, 'rejected');
});
after(async () => {
  await browser?.close();
});
async function fixture(t, { allowed = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('https://web.goodnotes.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  const page = await context.newPage();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gnmcp-browser-'));
  t.after(async () => {
    await context.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const config = { directory, documents: allowed ? [{ url, title: 'Fixture Board' }] : [] };
  const adapter = new GoodnotesAdapter({ config, getPage: async () => page });
  const view = await adapter.inspect({ url });
  return { adapter, page, view };
}
test('read → exact replacement → reload verification via real Chromium', async (t) => {
  const { adapter, view } = await fixture(t);
  const target = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  assert.equal(target.text, 'Original note');
  const result = await adapter.writeText({
    targetId: target.targetId,
    text: 'ÄÖÜ äöü ß\nSecond line\n\nLast line',
    operationId: 'integration-success',
  });
  assert.equal(result.verified, true);
  assert.equal(result.verification, 'reload-and-read');
  const replay = await adapter.writeText({
    targetId: target.targetId,
    text: 'ÄÖÜ äöü ß\nSecond line\n\nLast line',
    operationId: 'integration-success',
  });
  assert.equal(replay.replayed, true);
  assert.equal('bytes' in result, false);
  const after = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  assert.equal(after.text, 'ÄÖÜ äöü ß\nSecond line\n\nLast line');
});

test('planned body and heading formatting saves literal bullet prefixes in one verified reload', async (t) => {
  const { adapter, page, view } = await fixture(t);
  const target = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  const text = 'Title\n• Literal bullet\n1. Literal number\nBody 😀';
  // Model Quill's space-key shortcut. Bulk insertText must not invoke it.
  await page.evaluate(() =>
    document.addEventListener('keydown', (event) => {
      const node = getSelection()?.anchorNode;
      const paragraph = (node?.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest?.(
        'p',
      );
      if (event.key === ' ' && paragraph && ['•', '1.'].includes(paragraph.textContent)) {
        event.preventDefault();
        paragraph.textContent = '';
        localStorage.setItem('shortcut-triggered', 'yes');
      }
    }),
  );
  let loads = 0;
  page.on('domcontentloaded', () => loads++);
  const result = await adapter.text.edit({
    targetId: target.targetId,
    replacement: text,
    format: { bold: false, italic: false },
    formatRanges: [{ start: 0, end: 5, format: { bold: true } }],
    operationId: 'combined-format-plan',
  });
  assert.equal(result.verified, true);
  assert.equal(loads, 1);
  const saved = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  assert.equal(saved.text, text);
  assert.equal(await page.evaluate(() => localStorage.getItem('shortcut-triggered')), null);
  assert.equal(saved.formatting[0].bold, true);
  assert.ok(saved.formatting.filter((r) => r.start > 5).every((r) => !r.bold));
});

test('warm document opens skip network-idle waits, while a reload invalidates readiness', async (t) => {
  const { adapter, page } = await fixture(t);
  let waits = 0;
  const original = page.waitForLoadState.bind(page);
  page.waitForLoadState = async (...args) => {
    if (args[0] === 'networkidle') waits++;
    return original(...args);
  };
  await adapter.openDocument(url);
  await adapter.openDocument(url);
  assert.equal(waits, 0);
  await page.reload();
  await adapter.openDocument(url);
  assert.equal(waits, 1);
});
test('hidden BODY scroll caused by native focus is reset without changing internal document scrolling', async (t) => {
  const { adapter, page } = await fixture(t);
  const before = await page.evaluate(() => {
    document.documentElement.style.overflow = 'hidden';
    document.body.style.cssText =
      'margin:0;width:100vw;height:100vh;overflow:hidden;position:relative';
    const extra = document.createElement('div');
    extra.style.cssText = 'position:absolute;left:1500px;top:1100px;width:100px;height:100px';
    document.body.append(extra);
    const inner = document.createElement('div');
    inner.id = 'independent-scroll';
    inner.style.cssText =
      'position:absolute;left:500px;top:500px;width:100px;height:100px;overflow:scroll';
    inner.innerHTML = '<div style="width:300px;height:300px"></div>';
    document.body.append(inner);
    inner.scrollLeft = 40;
    inner.scrollTop = 30;
    document.body.scrollLeft = 25;
    document.body.scrollTop = 1;
    return document.body.scrollLeft;
  });
  assert.equal(before, 25);
  await adapter.resetOuterScroll(page);
  assert.deepEqual(
    await page.evaluate(() => ({
      bodyX: document.body.scrollLeft,
      bodyY: document.body.scrollTop,
      innerX: document.querySelector('#independent-scroll').scrollLeft,
      innerY: document.querySelector('#independent-scroll').scrollTop,
    })),
    { bodyX: 0, bodyY: 0, innerX: 40, innerY: 30 },
  );
});
test('native sticky text is read and edited instead of the empty text-tool overlay', async (t) => {
  const { adapter, page, view } = await fixture(t);
  await page.evaluate(() => localStorage.setItem('native-sticky', 'true'));
  const target = await adapter.readText({
    viewId: view.viewId,
    x: 0.4,
    y: 0.4,
    expectedKind: 'sticky',
  });
  assert.equal(target.kind, 'sticky');
  assert.equal(target.text, 'Original note');
  await adapter.writeText({
    targetId: target.targetId,
    text: 'Native sticky\nÄÖÜ',
    operationId: 'integration-native-sticky',
  });
  const saved = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  assert.equal(saved.text, 'Native sticky\nÄÖÜ');
});
test('native shape text is guarded by kind and survives reload without creating an overlay', async (t) => {
  const { adapter, page, view } = await fixture(t);
  await page.evaluate(() => localStorage.setItem('native-shape', 'true'));
  const target = await adapter.readText({
    viewId: view.viewId,
    x: 0.4,
    y: 0.4,
    expectedKind: 'shape',
  });
  assert.equal(target.kind, 'shape');
  assert.equal(target.text, 'Original note');
  const result = await adapter.writeText({
    targetId: target.targetId,
    text: 'Native shape label\nÄÖÜ',
    operationId: 'native-shape-label',
  });
  assert.equal(result.verified, true);
  const saved = await adapter.readText({
    viewId: view.viewId,
    x: 0.4,
    y: 0.4,
    expectedKind: 'shape',
  });
  assert.equal(saved.text, 'Native shape label\nÄÖÜ');
  await page.evaluate(() => {
    localStorage.removeItem('native-shape');
    localStorage.setItem('native-sticky', 'true');
  });
  await assert.rejects(
    adapter.writeText({
      targetId: saved.targetId,
      text: 'Must not replace a sticky',
      operationId: 'shape-kind-conflict',
    }),
    (e) => e.code === 'TEXT_CONFLICT',
  );
  assert.equal((await adapter.journal.get('shape-kind-conflict')).status, 'rejected');
  assert.equal(await page.locator('.ql-editor').count(), 0);
});

test('empty replacement clears only an explicitly read shape label and preserves its native kind', async (t) => {
  const { adapter, page, view } = await fixture(t);
  const ordinary = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  await assert.rejects(
    adapter.writeText({ targetId: ordinary.targetId, text: '', operationId: 'empty-ordinary' }),
    (e) => e.code === 'INVALID_TEXT',
  );
  await page.evaluate(() => localStorage.setItem('native-shape', 'true'));
  const shape = await adapter.readText({
    viewId: view.viewId,
    x: 0.4,
    y: 0.4,
    expectedKind: 'shape',
  });
  await assert.rejects(
    adapter.writeText({ targetId: shape.targetId, text: '  ', operationId: 'whitespace-shape' }),
    (e) => e.code === 'INVALID_TEXT',
  );
  const cleared = await adapter.writeText({
    targetId: shape.targetId,
    text: '',
    operationId: 'clear-shape-label',
  });
  assert.equal(cleared.verified, true);
  assert.equal(cleared.characters, 0);
  const empty = await adapter.readText({
    viewId: view.viewId,
    x: 0.4,
    y: 0.4,
    expectedKind: 'shape',
  });
  assert.equal(empty.kind, 'shape');
  assert.equal(empty.text, '');
  const noop = await adapter.writeText({
    targetId: empty.targetId,
    text: '',
    operationId: 'already-empty-shape',
  });
  assert.equal(noop.changed, false);
  assert.equal(
    (
      await adapter.writeText({
        targetId: empty.targetId,
        text: 'New label',
        operationId: 'restore-cleared-label',
      })
    ).verified,
    true,
  );
});

test('a same-text sticky replacing a text box is rejected before replacement or formatting', async (t) => {
  const { adapter, page, view } = await fixture(t);
  const ordinary = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  await page.evaluate(() => localStorage.setItem('native-sticky', 'true'));
  await assert.rejects(
    adapter.writeText({
      targetId: ordinary.targetId,
      text: 'Wrong object',
      operationId: 'kind-replacement-conflict',
    }),
    (e) => e.code === 'OBJECT_KIND_CHANGED',
  );
  await assert.rejects(
    adapter.text.edit({
      targetId: ordinary.targetId,
      start: 0,
      end: 1,
      format: { bold: true },
      operationId: 'kind-format-conflict',
    }),
    (e) => e.code === 'OBJECT_KIND_CHANGED',
  );
  assert.equal(
    (await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4, expectedKind: 'sticky' })).text,
    ordinary.text,
  );
  assert.equal((await adapter.journal.get('kind-replacement-conflict')).status, 'rejected');
  assert.equal((await adapter.journal.get('kind-format-conflict')).status, 'rejected');
});

test('format verification ignores equivalent text-node fragmentation', async (t) => {
  const { page } = await fixture(t);
  const read = async (html) => {
    await page.evaluate((html) => {
      let el = document.getElementById('format-fixture');
      if (!el) {
        el = document.createElement('div');
        el.id = 'format-fixture';
        document.body.append(el);
      }
      el.innerHTML = html;
    }, html);
    return page.locator('#format-fixture').evaluate(readRichText);
  };
  assert.deepEqual(
    await read('<p><span>MCP </span><span>fertig</span></p>'),
    await read('<p>MCP fertig</p>'),
  );
  assert.notDeepEqual(
    await read('<p><strong>MCP </strong>fertig</p>'),
    await read('<p>MCP fertig</p>'),
  );
  const links = await read(
    '<p style="text-align:right"><a href="https://example.com/a">One</a><a href="https://example.com/b">Two</a></p>',
  );
  assert.equal(links.length, 2);
  assert.equal(links[0].link, 'https://example.com/a');
  assert.equal(links[1].link, 'https://example.com/b');
  assert.equal(links[0].align, 'right');
});

test('native color palettes close through their overlay and can reopen without losing selection', async (t) => {
  const { page } = await fixture(t);
  const styles = new StyleController({});
  for (const panelId of ['colorSingleSelect', 'lassoColorSelector']) {
    await page.setContent(`<button id="shared_menu_options_change_color">Color</button>
      <div id="selected">Selected object</div>
      <div data-testid="edit_menu_floating_menu_dismiss" style="display:none;position:fixed;inset:48px 0 8px;z-index:1"></div>
      <div id="${panelId}" style="display:none;position:fixed;left:200px;top:200px;z-index:2;background:white">Change Color<button data-color-value="#fdff85" aria-selected="true">Yellow</button></div>`);
    await page.evaluate((id) => {
      const panel = document.getElementById(id),
        overlay = document.querySelector('[data-testid]');
      document.getElementById('shared_menu_options_change_color').onclick = () => {
        panel.style.display = 'block';
        overlay.style.display = 'block';
      };
      overlay.onclick = () => {
        panel.style.display = 'none';
        overlay.style.display = 'none';
      };
    }, panelId);
    const first = await styles.openPalette(page);
    assert.equal(first.colors[0].selected, true);
    assert.deepEqual(await styles.openPalette(page), first);
    await styles.closePalette(page);
    assert.equal(await page.locator('#' + panelId).isVisible(), false);
    assert.equal(await page.locator('#selected').innerText(), 'Selected object');
    assert.deepEqual(await styles.openPalette(page), first);
    await styles.closePalette(page);
  }
});
test('zoom uses the covered UI control, verifies the new level and expires old views', async (t) => {
  const { adapter, page, view } = await fixture(t);
  await page.evaluate(() => {
    for (const [id, step] of [
      ['decreaseZoomButton', -20],
      ['increaseZoomButton', 20],
    ]) {
      const b = document.createElement('button');
      b.id = id;
      b.textContent = 'Zoom';
      b.style = 'position:absolute;left:20px;top:500px;z-index:-1';
      b.onclick = () => {
        const label = document.getElementById('zoomLevelContainer');
        label.textContent = parseInt(label.textContent) + step + '%';
      };
      document.body.append(b);
    }
  });
  const smaller = await adapter.navigate({ viewId: view.viewId, zoomSteps: -1 });
  assert.equal(smaller.zoom, '80%');
  await assert.rejects(adapter.preview({ viewId: view.viewId }), (e) => e.code === 'STALE_VIEW');
  const restored = await adapter.navigate({ viewId: smaller.viewId, zoomSteps: 1 });
  assert.equal(restored.zoom, '100%');
});
test('range edits preserve surrounding rich formatting and survive reload', async (t) => {
  const { adapter, page, view } = await fixture(t);
  await page.evaluate(() =>
    localStorage.setItem(
      'fixture-rich',
      JSON.stringify({ text: 'Original note', html: '<p><strong>Original</strong> note</p>' }),
    ),
  );
  const target = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  assert.equal(target.formatting[0].bold, true);
  const result = await adapter.text.edit({
    targetId: target.targetId,
    start: 9,
    end: 13,
    replacement: 'changed',
    operationId: 'integration-range-replace',
  });
  assert.equal(result.verified, true);
  const after = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  assert.equal(after.text, 'Original changed');
  assert.equal(after.formatting[0].bold, true);
  assert.equal(after.formatting.at(-1).bold, false);
});
test('format-only edits verify style persistence and block stale style overwrites', async (t) => {
  const { adapter, page, view } = await fixture(t);
  let target = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  const result = await adapter.text.edit({
    targetId: target.targetId,
    start: 0,
    end: 8,
    format: { bold: true },
    operationId: 'integration-bold-format',
  });
  assert.equal(result.verified, true);
  target = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  assert.equal(target.formatting[0].bold, true);
  await page.evaluate(() =>
    localStorage.setItem(
      'fixture-rich',
      JSON.stringify({ text: 'Original note', html: '<p><em>Original</em> note</p>' }),
    ),
  );
  await page.reload();
  await assert.rejects(
    adapter.text.edit({
      targetId: target.targetId,
      start: 0,
      end: 8,
      format: { bold: false },
      operationId: 'integration-style-conflict',
    }),
    (e) => e.code === 'TEXT_CONFLICT',
  );
});
test('empty insertion is a no-op and does not backspace preceding text', async (t) => {
  const { adapter, view } = await fixture(t);
  const target = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  await adapter.text.edit({
    targetId: target.targetId,
    start: 4,
    end: 4,
    replacement: '',
    operationId: 'integration-empty-insert',
  });
  assert.equal(
    (await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 })).text,
    'Original note',
  );
});
test('changed text prevents overwriting', async (t) => {
  const { adapter, page, view } = await fixture(t);
  const target = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  await page.evaluate(() => localStorage.setItem('fixture-note', 'Changed by somebody else'));
  await page.reload();
  await assert.rejects(
    adapter.writeText({
      targetId: target.targetId,
      text: 'New',
      operationId: 'integration-conflict',
    }),
    (e) => e.code === 'TEXT_CONFLICT',
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem('fixture-note')),
    'Changed by somebody else',
  );
});
test('non-allowlisted documents reject writes', async (t) => {
  const { adapter, view } = await fixture(t, { allowed: false });
  const target = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  await assert.rejects(
    adapter.writeText({
      targetId: target.targetId,
      text: 'New',
      operationId: 'integration-denied',
    }),
    (e) => e.code === 'WRITE_NOT_ALLOWED',
  );
});
test('lost persistence returns uncertainty and blocks blind replay', async (t) => {
  const { adapter, page, view } = await fixture(t);
  const target = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  await page.evaluate(() => localStorage.setItem('drop-save', 'yes'));
  const args = {
    targetId: target.targetId,
    text: 'Must not be called saved',
    operationId: 'integration-unsaved',
  };
  await assert.rejects(
    adapter.writeText(args),
    (e) => e.code === 'SAVE_UNVERIFIED' && e.details.mayHaveWritten === true,
  );
  await assert.rejects(adapter.writeText(args), /may already/);
});
test('navigation invalidates an old view', async (t) => {
  const { adapter, page, view } = await fixture(t);
  await page.goto('https://web.goodnotes.com/s/DifferentDocument123');
  await assert.rejects(
    adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 }),
    (e) => e.code === 'STALE_VIEW',
  );
});
test('same-text requests still detect external changes', async (t) => {
  const { adapter, page, view } = await fixture(t);
  const target = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  await page.evaluate(() => localStorage.setItem('fixture-note', 'External change'));
  await page.reload();
  await assert.rejects(
    adapter.writeText({
      targetId: target.targetId,
      text: target.text,
      operationId: 'integration-noop',
    }),
    (e) => e.code === 'TEXT_CONFLICT',
  );
});
test('explicit page fragments are honored within the same document', async (t) => {
  const { adapter, page } = await fixture(t);
  await adapter.inspect({ url: url + '#page-2' });
  assert.equal(page.url(), url + '#page-2');
});
test('cancellation before writing preserves the existing note', async (t) => {
  const { adapter, page, view } = await fixture(t);
  const target = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  await assert.rejects(
    adapter.writeText(
      { targetId: target.targetId, text: 'New', operationId: 'integration-cancel' },
      { signal: AbortSignal.abort() },
    ),
    (e) => e.code === 'CANCELLED',
  );
  assert.equal(await page.locator('.note').innerText(), 'Original note');
  assert.equal((await adapter.journal.get('integration-cancel')).status, 'not-found');
});

test('reading mode is exited through the visible edit control before reading a field', async (t) => {
  const { adapter, page, view } = await fixture(t);
  await page.locator('#changeEditMode').click();
  assert.equal(await page.locator('#textToolButton').isVisible(), false);
  const target = await adapter.readText({ viewId: view.viewId, x: 0.4, y: 0.4 });
  assert.equal(target.text, 'Original note');
  assert.equal(await page.locator('.ql-editor[contenteditable="true"]').count(), 0);
});

test('opening a library item waits for delayed cards after the sidebar appears', async (t) => {
  const { adapter, page } = await fixture(t);
  const id = '11111111-1111-4111-8111-111111111111';
  await page.context().route('https://web.goodnotes.com/home', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<button id="homeSidebarDocumentsOptionId">Documents</button><script>setTimeout(()=>{const card=document.createElement('div');card.dataset.documentId='${id}';card.dataset.documentType='canvas';card.textContent='Fixture Board';card.ondblclick=()=>location.href='${url}';document.body.append(card);},900);</script>`,
    }),
  );
  const view = await adapter.openItem({ itemPath: [id] });
  assert.equal(view.title, 'Fixture Board');
  assert.equal(page.url(), url);
});
test('folder listing ignores outgoing cards and waits for the arriving folder', async (t) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-folder-'));
  t.after(async () => {
    await context.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const folder = '11111111-1111-4111-8111-111111111111',
    child = '22222222-2222-4222-8222-222222222222';
  await context.route('https://web.goodnotes.com/home', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<button id="homeSidebarDocumentsOptionId">Documents</button><div id="folder" data-document-id="${folder}" data-document-type="folder">Folder</div><div id="outgoing" data-document-id="33333333-3333-4333-8333-333333333333">Old</div><script>document.getElementById('folder').ondblclick=()=>{document.getElementById('folder').remove();setTimeout(()=>document.getElementById('outgoing').remove(),200);setTimeout(()=>{const e=document.createElement('div');e.dataset.documentId='${child}';e.dataset.documentType='canvas';e.innerHTML='<span id="libraryDocumentNameId-child">Arrived</span>';document.body.append(e);},650);};</script>`,
    }),
  );
  const adapter = new GoodnotesAdapter({
    config: { directory, documents: [] },
    getPage: async () => page,
  });
  const result = await adapter.list({ folderPath: [folder] });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, child);
  assert.equal(result.items[0].title, 'Arrived');
});
