import { GoodnotesError } from './errors.mjs';

export function normalizeTextFormat(input) {
  const format = { ...input };
  if (format.color)
    format.color = `rgb(${format.color
      .slice(1)
      .match(/../g)
      .map((h) => parseInt(h, 16))
      .join(', ')})`;
  if (format.highlight && format.highlight !== 'none')
    format.highlight = format.highlight.toLowerCase() + '80';
  if (format.link !== undefined) {
    const link = new URL(format.link);
    if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password)
      throw new GoodnotesError('INVALID_LINK', 'Use an HTTP(S) URL without embedded credentials.');
  }
  return format;
}

// Ranges address the final text after replacement; reject the entire plan before writing.
export function prepareFormatRanges(text, ranges = []) {
  if (!Array.isArray(ranges) || ranges.length > 20)
    throw new GoodnotesError('INVALID_FORMAT_PLAN', 'Use at most 20 formatting ranges.');
  const split = (at) =>
    at > 0 &&
    at < text.length &&
    /[\uD800-\uDBFF]/.test(text[at - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[at]);
  let previousEnd = -1;
  return [...ranges]
    .sort((a, b) => a.start - b.start)
    .map((r) => {
      if (
        !Number.isInteger(r.start) ||
        !Number.isInteger(r.end) ||
        r.start < 0 ||
        r.end <= r.start ||
        r.end > text.length ||
        r.start < previousEnd ||
        split(r.start) ||
        split(r.end)
      )
        throw new GoodnotesError(
          'INVALID_FORMAT_PLAN',
          'Formatting ranges must be nonempty, nonoverlapping UTF-16 ranges within the final text.',
        );
      if (!r.format || !Object.keys(r.format).length)
        throw new GoodnotesError('INVALID_FORMAT_PLAN', 'Each formatting range requires a format.');
      if (
        (r.format.list !== undefined || r.format.highlight !== undefined) &&
        (r.start !== 0 || r.end !== text.length)
      )
        throw new GoodnotesError(
          'LIST_RANGE_REQUIRED',
          'List and highlight formatting require the whole final field.',
        );
      previousEnd = r.end;
      return { start: r.start, end: r.end, format: normalizeTextFormat(r.format) };
    });
}
