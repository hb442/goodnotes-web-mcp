import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFormatRanges } from '../src/text-format-plan.mjs';

test('format plans use final UTF-16 offsets and reject ambiguous or invalid ranges before writing', () => {
  const text = 'Title 😀\nBody';
  assert.deepEqual(
    prepareFormatRanges(text, [{ start: 0, end: 8, format: { bold: true, color: '#123456' } }]),
    [{ start: 0, end: 8, format: { bold: true, color: 'rgb(18, 52, 86)' } }],
  );
  for (const ranges of [
    [{ start: 0, end: 7, format: { bold: true } }],
    [{ start: 0, end: 99, format: { bold: true } }],
    [{ start: 1, end: 1, format: { bold: true } }],
    [
      { start: 0, end: 4, format: { bold: true } },
      { start: 3, end: 6, format: { italic: true } },
    ],
    [{ start: 0, end: 4, format: {} }],
    [{ start: 0, end: 4, format: { list: 'bullet' } }],
  ])
    assert.throws(() => prepareFormatRanges(text, ranges));
  assert.throws(() =>
    prepareFormatRanges(text, [
      { start: 0, end: 4, format: { link: 'https://user:pass@example.test' } },
    ]),
  );
});
