import { createCanvas, loadImage } from '@napi-rs/canvas';
import { z } from 'zod';
import { GoodnotesError } from './errors.mjs';

const pages = z.array(z.number().int().min(1).max(2000)).min(1).max(12);
const crop = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine((r) => r.x + r.width <= 1 && r.y + r.height <= 1, 'Crop exceeds source page.');
export const studyCardSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,40}$/)
      .optional(),
    section: z.string().trim().max(70).optional(),
    span: z.number().int().min(1).max(3).optional(),
    role: z.enum(['summary', 'concept', 'questions', 'answers']),
    heading: z.string().trim().min(1).max(90),
    body: z.string().trim().min(1).max(1800),
    pages,
  })
  .strict();
export const studyFigureSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,40}$/)
      .optional(),
    section: z.string().trim().max(70).optional(),
    span: z.number().int().min(1).max(3).optional(),
    page: z.number().int().min(1).max(2000),
    crop: crop.optional(),
    caption: z.string().trim().min(1).max(260),
  })
  .strict();
export const studyLayoutSchema = z
  .object({
    columns: z.number().int().min(1).max(3).default(2),
    flow: z.enum(['rows', 'compact']).default('compact'),
    imageMaxHeight: z.number().int().min(180).max(500).default(450),
  })
  .strict();
export const studySectionSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    subtitle: z.string().trim().min(1).max(180),
    layout: studyLayoutSchema.optional(),
    sections: z.array(z.string().trim().min(1).max(70)).max(12).optional(),
    cards: z.array(studyCardSchema).max(24),
    figures: z.array(studyFigureSchema).max(12),
  })
  .strict()
  .refine((m) => m.cards.length + m.figures.length > 0, 'An addition needs content.');
export const studyMaterialsSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    subtitle: z.string().trim().min(1).max(180),
    layout: studyLayoutSchema.optional(),
    sections: z.array(z.string().trim().min(1).max(70)).max(12).optional(),
    cards: z.array(studyCardSchema).min(4).max(24),
    figures: z.array(studyFigureSchema).min(1).max(12),
  })
  .strict()
  .superRefine((m, c) => {
    for (const role of ['summary', 'questions', 'answers'])
      if (!m.cards.some((x) => x.role === role))
        c.addIssue({ code: 'custom', message: 'Missing ' + role + ' card.' });
    for (const list of [m.cards, m.figures]) {
      const keys = list.map((x, i) => x.key ?? String(i));
      if (new Set(keys).size !== keys.length)
        c.addIssue({ code: 'custom', message: 'Block keys must be unique within each type.' });
    }
    if (m.sections && new Set(m.sections).size !== m.sections.length)
      c.addIssue({ code: 'custom', message: 'Section names must be unique.' });
  });

const palette = {
  title: '#ffffff',
  summary: '#e8eef6',
  concept: '#e2f1ea',
  questions: '#fff0c4',
  answers: '#edf1f6',
  caption: '#f1f5f9',
  section: '#edf1f6',
};
const context = createCanvas(1, 1).getContext('2d');
export function wrapStudyText(input, width, size, bold = false) {
  context.font = `${bold ? 'bold ' : ''}${size}px Arial`;
  // A small reserve covers platform font metrics; live native bounds are also checked.
  const limit = width * 0.94,
    lines = [];
  for (const paragraph of input.replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph.trim()) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.trim().split(/\s+/u)) {
      if (context.measureText(word).width > limit)
        throw new GoodnotesError(
          'LAYOUT_WORD_TOO_WIDE',
          'Split an overlong word or formula before creating the board.',
          { word: word.slice(0, 100) },
        );
      const next = line ? line + ' ' + word : word;
      if (line && context.measureText(next).width > limit) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}
export function auditStudyGeometry(blocks, { width = 1400, gap = 24 } = {}) {
  const issues = [];
  if (new Set(blocks.map((b) => b.id)).size !== blocks.length)
    issues.push({ code: 'DUPLICATE_BLOCK_ID' });
  for (const b of blocks) {
    if (
      !['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k])) ||
      b.width <= 0 ||
      b.height <= 0
    )
      issues.push({ code: 'INVALID_BOUNDS', id: b.id });
    if (b.x < 20 || b.y < 0 || b.x + b.width > width - 20)
      issues.push({ code: 'OUTSIDE_BOARD', id: b.id });
    for (const p of blocks.slice(0, blocks.indexOf(b))) {
      if (
        b.x < p.x + p.width + gap &&
        p.x < b.x + b.width + gap &&
        b.y < p.y + p.height + gap &&
        p.y < b.y + b.height + gap
      )
        issues.push({ code: 'OVERLAP_OR_SMALL_GAP', ids: [p.id, b.id] });
    }
  }
  return { valid: issues.length === 0, issues };
}
export function makeStudyCard(
  id,
  role,
  heading,
  body,
  x,
  y,
  width,
  fontSize = 18,
  headingSize = 22,
) {
  const headingLines = wrapStudyText(heading, width - 40, headingSize, true);
  const bodyLines = wrapStudyText(body, width - 40, fontSize);
  const height = Math.ceil(
    headingLines.length * headingSize * 1.65 + bodyLines.length * fontSize * 1.65 + 44,
  );
  if (height > 620)
    throw new GoodnotesError(
      'CARD_TOO_TALL',
      'Split this card into shorter cards before writing.',
      { id, height, maxHeight: 620 },
    );
  return {
    id,
    kind: 'text',
    role,
    x,
    y,
    width,
    height,
    text: headingLines.join('\n') + '\n' + bodyLines.join('\n'),
    headingLength: headingLines.join('\n').length,
    fontSize,
    headingSize,
    backgroundColor: palette[role],
    headingLines,
    bodyLines,
  };
}
export function sourceCardBody(card) {
  return card.body + '\nQuelle: S. ' + [...new Set(card.pages)].join(', ');
}
export function planStudyLayout(materials, source, figures, { partial = false } = {}) {
  const m = (partial ? studySectionSchema : studyMaterialsSchema).parse(materials);
  for (const p of [...m.cards.flatMap((c) => c.pages), ...m.figures.map((f) => f.page)])
    if (p > source.pageCount)
      throw new GoodnotesError(
        'INVALID_SOURCE_PAGE',
        'A citation is outside the source snapshot.',
        { page: p },
      );
  if (figures.length !== m.figures.length)
    throw new GoodnotesError(
      'FIGURE_COUNT_MISMATCH',
      'Every original figure needs a rendered source.',
    );
  const width = 1400,
    margin = 56,
    gutter = 64,
    blocks = [];
  const settings = studyLayoutSchema.parse(m.layout ?? {});
  const columns = settings.columns,
    column = (width - margin * 2 - gutter * (columns - 1)) / columns;
  function card(id, role, heading, body, x, y, w, fontSize = 18, headingSize = 22) {
    const b = makeStudyCard(id, role, heading, body, x, y, w, fontSize, headingSize);
    blocks.push(b);
    return b;
  }
  const head = card(
    'title',
    'title',
    m.title,
    m.subtitle + '\nQuelle: ' + source.title + ' · ' + source.pageCount + ' Seiten',
    margin,
    80,
    width - 2 * margin,
    18,
    30,
  );
  let y = head.y + head.height + 56;
  const sections = [
    ...new Set([
      ...(m.sections ?? []),
      ...m.figures.map((f) => f.section ?? ''),
      ...m.cards.map((c) => c.section ?? ''),
    ]),
  ];
  for (const [sectionIndex, section] of sections.entries()) {
    if (section) {
      const b = card(
        'section-' + sectionIndex,
        'section',
        section,
        '',
        margin,
        y,
        width - 2 * margin,
        16,
        24,
      );
      y = b.y + b.height + 48;
    }
    const bottoms = Array(columns).fill(y);
    let rowCursor = 0,
      rowY = y,
      rowBottom = y;
    const place = (span) => {
      if (span > columns)
        throw new GoodnotesError('INVALID_SPAN', 'A block span exceeds the number of columns.');
      if (settings.flow === 'rows') {
        if (rowCursor + span > columns) {
          rowCursor = 0;
          rowY = rowBottom;
        }
        const col = rowCursor;
        rowCursor += span;
        return {
          col,
          x: margin + col * (column + gutter),
          y: rowY,
          width: span * column + (span - 1) * gutter,
        };
      }
      const candidates = Array.from({ length: columns - span + 1 }, (_, col) => ({
        col,
        y: Math.max(...bottoms.slice(col, col + span)),
      }));
      candidates.sort((a, b) => a.y - b.y || a.col - b.col);
      const slot = candidates[0];
      return {
        ...slot,
        x: margin + slot.col * (column + gutter),
        width: span * column + (span - 1) * gutter,
      };
    };
    const finish = (slot, span, end) => {
      for (let c = slot.col; c < slot.col + span; c++) bottoms[c] = end + 64;
      rowBottom = Math.max(rowBottom, end + 64);
    };
    for (const [i, f] of figures.entries()) {
      const spec = m.figures[i];
      if ((spec.section ?? '') !== section) continue;
      const span = spec.span ?? 1,
        slot = place(span),
        x = slot.x;
      const h = Math.min(settings.imageMaxHeight, (slot.width * f.height) / f.width),
        w = (h * f.width) / f.height;
      if (w < 180 || h < 100)
        throw new GoodnotesError('FIGURE_TOO_SMALL', 'Choose a readable figure crop.', {
          figure: i,
        });
      const image = {
        id: 'figure-' + (spec.key ?? i),
        kind: 'image',
        x: x + (slot.width - w) / 2,
        y: slot.y,
        width: w,
        height: h,
        filePath: f.filePath,
        sha256: f.sha256,
        sourcePage: m.figures[i].page,
        sourceCrop: m.figures[i].crop ?? { x: 0, y: 0, width: 1, height: 1 },
      };
      blocks.push(image);
      const caption = card(
        'caption-' + (spec.key ?? i),
        'caption',
        'Originalfolie · S. ' + m.figures[i].page,
        m.figures[i].caption,
        x,
        slot.y + h + 48,
        slot.width,
        16,
        18,
      );
      finish(slot, span, caption.y + caption.height);
    }
    // Text begins below figure/caption groups; section order remains predictable.
    const afterFigures = Math.max(...bottoms);
    bottoms.fill(afterFigures);
    rowCursor = 0;
    rowY = afterFigures;
    rowBottom = afterFigures;
    for (const [j, c] of m.cards.entries()) {
      if ((c.section ?? '') !== section) continue;
      const span = c.span ?? 1,
        slot = place(span),
        b = card(
          'card-' + (c.key ?? j),
          c.role,
          c.heading,
          sourceCardBody(c),
          slot.x,
          slot.y,
          slot.width,
          columns === 3 && span === 1 ? 16 : 18,
          columns === 3 && span === 1 ? 20 : 22,
        );
      b.sourcePages = [...new Set(c.pages)];
      finish(slot, span, b.y + b.height);
    }
    y = Math.max(...bottoms);
  }
  const audit = auditStudyGeometry(blocks, { width });
  if (!audit.valid)
    throw new GoodnotesError(
      'LAYOUT_CONFLICT',
      'The planned blocks overlap or leave the board.',
      audit,
    );
  return {
    schema: 2,
    settings,
    width,
    height: Math.ceil(y),
    fontFamily: 'Arial',
    blocks,
    audit,
    source: {
      exportId: source.exportId,
      sha256: source.sha256,
      title: source.title,
      pageCount: source.pageCount,
    },
    note: 'Text is supplied by the calling assistant. Page bounds and layout are checked; factual correctness requires reviewing the source.',
  };
}
export async function renderStudyPreview(plan) {
  if (plan.width * plan.height > 18000000 && !plan.scaledPreview)
    throw new GoodnotesError('LAYOUT_TOO_LARGE', 'Split this board into smaller boards.');
  const scale = plan.scaledPreview
    ? Math.min(1, Math.sqrt(18000000 / (plan.width * plan.height)))
    : 1;
  const canvas = createCanvas(Math.floor(plan.width * scale), Math.floor(plan.height * scale)),
    ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, plan.width, plan.height);
  for (const b of plan.blocks) {
    if (b.kind === 'image') {
      const im = await loadImage(b.filePath),
        c = b.nativeCrop;
      if (c)
        ctx.drawImage(
          im,
          c.x * im.width,
          c.y * im.height,
          c.width * im.width,
          c.height * im.height,
          b.x,
          b.y,
          b.width,
          b.height,
        );
      else ctx.drawImage(im, b.x, b.y, b.width, b.height);
      continue;
    }
    ctx.fillStyle = b.backgroundColor;
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.width, b.height, 10);
    ctx.fill();
    ctx.fillStyle = '#213547';
    ctx.textBaseline = 'top';
    let y = b.y + 20;
    for (const [lines, size, bold] of [
      [b.headingLines, b.headingSize, true],
      [b.bodyLines, b.fontSize, false],
    ]) {
      ctx.font = `${bold ? 'bold ' : ''}${size}px Arial`;
      for (const line of lines) {
        ctx.fillText(line, b.x + 20, y);
        y += size * 1.65;
      }
    }
  }
  return canvas.toBuffer('image/png');
}
