import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { nativeTextSelectionBounds } from '../../src/objects.mjs';

test('pale native text frame at 51 percent requires exact handles, editor containment and visible geometry', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const canvas = { x: 0, y: 48, width: 1200, height: 744 };
  await page.setContent(
    `<style>.rich-text-view-container{position:absolute;left:200px;top:300px;transform:scale(.512);transform-origin:0 0}.rich-text-controls-border{position:absolute;left:-12px;top:-12px;width:420px;height:90px;border:1px solid #cde3ff;box-sizing:border-box}.rich-text-resize-handle{position:absolute;top:23px;width:20px;height:20px;background:blue;border-radius:50%}.ql-editor{width:396px;height:66px}</style><div class="rich-text-view-container"><div class="ql-editor">TEST</div><div class="rich-text-controls"><div class="rich-text-controls-border"></div><div class="rich-text-resize-handle" data-testid="rich-text-resize-handle-left" style="left:-22px"></div><div class="rich-text-resize-handle" data-testid="rich-text-resize-handle-right" style="left:398px"></div></div></div>`,
  );
  assert.deepEqual(await nativeTextSelectionBounds(page, canvas), {
    x: 194,
    y: 294,
    width: 215,
    height: 46,
  });
  const right = page.locator('[data-testid="rich-text-resize-handle-right"]');
  await right.evaluate((e) => (e.style.left = '450px'));
  await assert.rejects(
    nativeTextSelectionBounds(page, canvas),
    (e) => e.code === 'AMBIGUOUS_SELECTION',
  );
  await right.evaluate((e) => (e.style.left = '398px'));
  await page.locator('.ql-editor').evaluate((e) => (e.style.width = '500px'));
  await assert.rejects(
    nativeTextSelectionBounds(page, canvas),
    (e) => e.code === 'AMBIGUOUS_SELECTION',
  );
  await page.locator('.ql-editor').evaluate((e) => (e.style.width = '396px'));
  await page
    .locator('.rich-text-view-container')
    .evaluate((e) => (e.style.transform = 'scale(.512) rotate(10deg)'));
  await assert.rejects(
    nativeTextSelectionBounds(page, canvas),
    (e) => e.code === 'AMBIGUOUS_SELECTION',
  );
  await page.locator('.rich-text-view-container').evaluate((e) => {
    e.style.transform = 'scale(.512)';
    e.style.top = '780px';
  });
  await assert.rejects(
    nativeTextSelectionBounds(page, canvas),
    (e) => e.code === 'AMBIGUOUS_SELECTION',
  );
  await page.locator('.rich-text-view-container').evaluate((e) => {
    e.style.top = '300px';
    e.after(e.cloneNode(true));
  });
  await assert.rejects(
    nativeTextSelectionBounds(page, canvas),
    (e) => e.code === 'AMBIGUOUS_SELECTION',
  );
  await page
    .locator('.rich-text-view-container')
    .evaluateAll((es) => es.forEach((e) => e.remove()));
  assert.equal(await nativeTextSelectionBounds(page, canvas), null);
});
