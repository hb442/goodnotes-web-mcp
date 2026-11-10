import { z } from 'zod';
import { documentUrl } from './config.mjs';
import { GoodnotesError } from './errors.mjs';

const uuid = z.string().uuid();
const url = z
  .string()
  .url()
  .transform((value) => documentUrl(value) + new URL(value).hash);
const path = z.array(uuid).min(1).max(13),
  folder = z.array(uuid).max(12);
const title = z.string().trim().min(1).max(150);
const x = z.number().min(0.02).max(0.98),
  y = z.number().min(0.08).max(0.92);
export const inkStyleSchema = z
  .object({
    tool: z.enum(['pen', 'pencil', 'highlighter']).default('pen'),
    penKind: z.enum(['ball', 'fountain', 'brush']).optional(),
    thicknessMm: z.number().min(0.1).max(20).optional(),
    color: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.penKind && v.tool !== 'pen')
      ctx.addIssue({ code: 'custom', message: 'penKind requires the pen tool.' });
  });
export const formatSchema = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    list: z.enum(['bullet', 'ordered', 'none']).optional(),
    highlight: z
      .string()
      .regex(/^(#[a-fA-F0-9]{6}|none)$/)
      .optional(),
    color: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
    fontSize: z.number().int().min(8).max(144).optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    link: z
      .string()
      .url()
      .regex(/^https?:\/\//)
      .max(2000)
      .optional(),
  })
  .strict();
export const formatRangesSchema = z
  .array(
    z
      .object({
        start: z.number().int().min(0),
        end: z.number().int().min(1),
        format: formatSchema,
      })
      .strict(),
  )
  .max(20);
export const cropRegionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine(
    (v) => v.x + v.width <= 1 && v.y + v.height <= 1,
    'Crop must remain wholly inside the source image.',
  );
export const shapeStyleSchema = z
  .object({
    fillOpacityPercent: z.number().int().min(0).max(100).multipleOf(10).optional(),
    thicknessMm: z.number().min(0.1).max(2).multipleOf(0.01).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide fill opacity or thickness.');
export const textBoxStyleSchema = z
  .object({
    backgroundColor: z
      .string()
      .regex(/^(none|#[a-f0-9]{6})$/i)
      .optional(),
    borderColor: z
      .string()
      .regex(/^(none|#[a-f0-9]{6})$/i)
      .optional(),
    roundCornerPt: z.number().int().min(0).max(30).optional(),
    borderPt: z.number().int().min(0).max(12).optional(),
    paddingPt: z.number().int().min(0).max(30).optional(),
    shadow: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one box style property.');
export const targetSchema = z
  .object({
    query: z.string().min(1).max(200).optional(),
    x: x.optional(),
    y: y.optional(),
    scanId: uuid.optional(),
    matchId: uuid.optional(),
    objectId: uuid.optional(),
    expectedText: z.string().max(8000).optional(),
    expectedKind: z.enum(['text-box', 'sticky', 'shape']).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.expectedKind && (v.x === undefined || v.y === undefined))
      ctx.addIssue({ code: 'custom', message: 'expectedKind requires an x/y target.' });
    const modes = [
      !!v.query,
      v.x !== undefined || v.y !== undefined,
      !!v.scanId || !!v.matchId,
      !!v.objectId,
    ].filter(Boolean).length;
    if (modes !== 1 || (v.x !== undefined) !== (v.y !== undefined) || !!v.scanId !== !!v.matchId)
      ctx.addIssue({
        code: 'custom',
        message: 'Choose one target: query, both x/y, scanId+matchId, or objectId.',
      });
  });
export const moveContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), expectedText: z.string().min(1).max(8000) }).strict(),
  z
    .object({
      kind: z.literal('image'),
      expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
      expectedCrop: cropRegionSchema,
    })
    .strict(),
]);
const fields = [
  'url',
  'itemPath',
  'exportId',
  'path',
  'orderHash',
  'count',
  'pageCount',
  'snapshotId',
  'operationId',
  'outlineHash',
  'pageOrderHash',
];
export const referenceSchema = z
  .object({ fromStep: z.number().int().min(0).max(99), field: z.enum(fields) })
  .strict();
const region = z
  .object({ x, y, width: z.number().positive().max(0.95), height: z.number().positive().max(0.85) })
  .strict();
function schema(references) {
  const r = (s) => (references ? z.union([s, referenceSchema]) : s);
  const base = { url: r(url) };
  const outline = {
    ...base,
    outlineId: uuid,
    expectedTitle: z.string().min(1).max(5000),
    expectedOutlineHash: r(z.string().length(64)),
    expectedPageOrderHash: r(z.string().length(64)),
  };
  const createObject = {
    inkStyle: inkStyleSchema.optional(),
    kind: z.enum([
      'sticky',
      'rectangle',
      'ellipse',
      'triangle',
      'diamond',
      'rounded-rectangle',
      'ink',
    ]),
    x: x.default(0.2),
    y: y.default(0.2),
    width: z.number().min(0.02).max(0.7).default(0.15),
    height: z.number().min(0.02).max(0.7).default(0.15),
    text: z.string().max(3000).default(''),
    strokes: z
      .array(z.array(z.object({ x, y }).strict()).min(2).max(1000))
      .min(1)
      .max(100)
      .optional(),
  };
  const steps = [
    {
      action: z.literal('favorite-document'),
      itemPath: r(path),
      expectedTitle: title,
      expectedFavorite: z.boolean(),
      favorite: z.boolean(),
    },
    {
      action: z.literal('folder-style'),
      itemPath: r(z.array(uuid).min(1).max(12)),
      expectedTitle: title,
      property: z.enum(['color', 'icon', 'favorite']),
      value: z.union([z.string().max(40), z.boolean()]),
      expectedValue: z.union([z.string().max(40), z.boolean()]),
    },
    {
      action: z.literal('folder-rename'),
      itemPath: r(z.array(uuid).min(1).max(12)),
      expectedTitle: title,
      title,
    },
    {
      action: z.literal('folder-move'),
      itemPath: r(z.array(uuid).min(1).max(12)),
      expectedTitle: title,
      destinationPath: r(z.array(uuid).max(11)),
    },
    {
      action: z.literal('expand-sticky'),
      collapseOperationId: r(z.string().regex(/^[A-Za-z0-9_-]{8,80}$/)),
    },
    { action: z.literal('trash-document'), itemPath: r(path), expectedTitle: title },
    {
      action: z.literal('restore-document'),
      trashOperationId: r(z.string().regex(/^[A-Za-z0-9_-]{8,80}$/)),
    },
    {
      action: z.literal('board-background'),
      ...base,
      pattern: z.enum(['plain', 'dot', 'grid']).optional(),
      color: z.enum(['white', 'yellow', 'black']).optional(),
      expectedPattern: z.enum(['plain', 'dot', 'grid']),
      expectedColor: z.enum(['white', 'yellow', 'black']),
    },
    {
      action: z.literal('page-template'),
      ...base,
      page: z.number().int().min(1),
      kind: z.enum(['paper', 'cover']).default('paper'),
      templateId: z.string().min(1).max(200),
      expectedPageCount: r(z.number().int().min(1)),
      expectedOrderHash: r(z.string().regex(/^[a-f0-9]{64}$/)),
    },
    {
      action: z.literal('move-native-object'),
      sourceUrl: r(url),
      target: targetSchema,
      content: moveContentSchema,
      destinationPath: r(path),
      destinationPage: z.number().int().min(1).max(2000).default(1),
      x,
      y,
    },
    {
      action: z.literal('restore-page'),
      deleteOperationId: r(z.string().regex(/^[A-Za-z0-9_-]{8,80}$/)),
    },
    {
      action: z.literal('copy-image-object'),
      sourceUrl: r(url),
      target: targetSchema,
      expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
      expectedCrop: cropRegionSchema,
      destinationPath: r(path),
      destinationPage: z.number().int().min(1).max(2000).default(1),
      x,
      y,
    },
    {
      action: z.literal('copy-text-object'),
      sourceUrl: r(url),
      target: targetSchema,
      expectedText: z.string().min(1).max(8000),
      destinationPath: r(path),
      destinationPage: z.number().int().min(1).max(2000).default(1),
      x,
      y,
    },
    {
      action: z.literal('copy-page'),
      sourceUrl: r(url),
      sourcePage: z.number().int().min(1).max(2000),
      expectedSourceOrderHash: r(z.string().regex(/^[a-f0-9]{64}$/)),
      destinationPath: r(path),
      destinationPage: z.number().int().min(1).max(2000),
      placement: z.enum(['before', 'after']).default('after'),
      expectedPageCount: r(z.number().int().min(1).max(2000)),
      expectedOrderHash: r(z.string().regex(/^[a-f0-9]{64}$/)),
    },
    { action: z.literal('export'), ...base },
    { action: z.literal('snapshot'), itemPath: r(path), title },
    { action: z.literal('restore-copy'), snapshotId: r(uuid), title },
    { action: z.literal('rename'), itemPath: r(path), title },
    { action: z.literal('move'), itemPath: r(path), destinationPath: r(folder) },
    { action: z.literal('duplicate'), itemPath: r(path), title: title.optional() },
    {
      action: z.literal('create'),
      kind: z.enum(['folder', 'notebook', 'whiteboard']),
      title,
      folderPath: r(folder).default([]),
    },
    {
      action: z.literal('import'),
      filePath: r(z.string().min(1)),
      title,
      folderPath: r(folder).default([]),
    },
    {
      action: z.literal('pages'),
      ...base,
      command: z.enum([
        'duplicate',
        'delete',
        'add-before',
        'add-after',
        'rotate',
        'outline',
        'move',
        'bookmark',
        'unbookmark',
      ]),
      page: z.number().int().min(1).max(2000),
      expectedPageCount: r(z.number().int().min(1).max(2000)),
      expectedOrderHash: r(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
      destination: z.number().int().min(1).max(2000).optional(),
      title: title.optional(),
    },
    { action: z.literal('list-pages'), ...base },
    { action: z.literal('list-outlines'), ...base },
    { action: z.literal('rename-outline'), ...outline, title },
    { action: z.literal('delete-outline'), ...outline },
    {
      action: z.literal('replace-text'),
      ...base,
      x,
      y,
      expectedText: z.string().max(8000),
      expectedKind: z.enum(['text-box', 'sticky', 'shape']).optional(),
      text: z.string().max(8000),
    },
    { action: z.literal('sticky'), ...base, x, y, text: z.string().min(1).max(3000) },
    {
      action: z.literal('move-object'),
      ...base,
      query: z.string().min(1).max(200),
      expectedText: z.string().max(8000).optional(),
      toX: z.number().min(0.05).max(0.95),
      toY: z.number().min(0.1).max(0.9),
    },
    { action: z.literal('create-text'), ...base, x, y, text: z.string().min(1).max(8000) },
    {
      action: z.literal('edit-text'),
      ...base,
      target: targetSchema,
      expectedText: z.string().max(8000),
      start: z.number().int().min(0).default(0),
      end: z.number().int().min(0).optional(),
      replacement: z.string().max(8000).optional(),
      format: formatSchema.default({}),
      formatRanges: formatRangesSchema.default([]),
    },
    { action: z.literal('create-object'), ...base, ...createObject },
    { action: z.literal('image'), ...base, filePath: r(z.string().min(1)) },
    {
      action: z.literal('unlock-object'),
      ...base,
      x,
      y,
      kind: z.enum(['sticky', 'text', 'image', 'shape']),
      expectedText: z.string().max(8000).optional(),
    },
    { action: z.literal('shape-style'), ...base, target: targetSchema, style: shapeStyleSchema },
    {
      action: z.literal('copy-native-selection'),
      ...base,
      region,
      destinationPath: r(path),
      destinationPage: z.number().int().min(1).max(2000).default(1),
      x,
      y,
    },
    { action: z.literal('crop-image'), ...base, target: targetSchema, region: cropRegionSchema },
    {
      action: z.literal('text-box-style'),
      ...base,
      target: targetSchema,
      expectedText: z.string().min(1).max(8000),
      style: textBoxStyleSchema,
    },
    {
      action: z.literal('connector'),
      ...base,
      from: z.object({ x, y }).strict(),
      to: z.object({ x, y }).strict(),
      arrow: z.boolean().default(true),
      inkStyle: inkStyleSchema.optional(),
    },
    {
      action: z.literal('color-object'),
      ...base,
      target: targetSchema,
      color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    },
    {
      action: z.literal('arrange-object'),
      ...base,
      target: targetSchema,
      command: z.enum([
        'front',
        'back',
        'lock',
        'unlock',
        'collapse',
        'expand',
        'hide-author',
        'show-author',
      ]),
    },
    {
      action: z.literal('transform-object'),
      ...base,
      target: targetSchema,
      transform: z.enum(['move', 'resize', 'duplicate', 'delete']),
      dx: z.number().min(-0.8).max(0.8).default(0),
      dy: z.number().min(-0.8).max(0.8).default(0),
      scaleX: z.number().min(0.25).max(3).default(1),
      scaleY: z.number().min(0.25).max(3).default(1),
    },
    {
      action: z.literal('convert-handwriting'),
      ...base,
      region,
      text: z.string().min(1).max(8000),
    },
    {
      action: z.literal('combine'),
      parts: z
        .array(
          z
            .object({
              exportId: r(uuid),
              pages: z.array(z.number().int().min(1).max(2000)).min(1).max(2000).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(50),
      title: title.default('Combined notes'),
    },
    {
      action: z.literal('study-bundle'),
      exportId: r(uuid),
      summary: z.string().max(100000).default(''),
      tasks: z
        .array(
          z
            .object({ text: z.string().min(1).max(2000), page: z.number().int().min(1).optional() })
            .strict(),
        )
        .max(500)
        .default([]),
      cards: z
        .array(
          z
            .object({
              front: z.string().min(1).max(4000),
              back: z.string().min(1).max(10000),
              page: z.number().int().min(1).optional(),
            })
            .strict(),
        )
        .max(1000)
        .default([]),
    },
  ];
  return z.discriminatedUnion(
    'action',
    steps.map((s) => {
      const item = z.object(s).strict();
      if (s.action.value === 'replace-text')
        return item.superRefine((v, ctx) => {
          if (!v.text.trim() && !(v.text === '' && v.expectedKind === 'shape'))
            ctx.addIssue({
              code: 'custom',
              message: 'Only an explicit shape target may clear its label with an empty string.',
            });
        });
      if (s.action.value !== 'folder-style') return item;
      return item.superRefine((v, ctx) => {
        const valid =
          v.property === 'favorite'
            ? typeof v.value === 'boolean' && typeof v.expectedValue === 'boolean'
            : v.property === 'color'
              ? typeof v.value === 'string' &&
                typeof v.expectedValue === 'string' &&
                /^#[a-f0-9]{6}$/i.test(v.value) &&
                /^#[a-f0-9]{6}$/i.test(v.expectedValue)
              : typeof v.value === 'string' &&
                typeof v.expectedValue === 'string' &&
                /^[a-z0-9-]{1,40}$/.test(v.value);
        if (!valid)
          ctx.addIssue({
            code: 'custom',
            message:
              'Folder favorite requires booleans; color requires six-digit hex strings; icon requires a returned icon name.',
          });
      });
    }),
  );
}
export const concreteStepSchema = schema(false);
export const stepSchema = schema(true);
export const stepActionNames = stepSchema.options.map((option) => option.shape.action.value);
// Keep the frequently advertised MCP schema small. JobController.plan still validates
// every complete step with the strict schema before saving or executing anything.
export const batchStepEnvelopeSchema = z.object({ action: z.enum(stepActionNames) }).passthrough();
export function batchHelp(actions) {
  return {
    actions: actions.map((action) => ({
      action,
      schema: z.toJSONSchema(
        stepSchema.options.find((o) => o.shape.action.value === action),
        { io: 'input' },
      ),
    })),
    references:
      'Where a field accepts it, use {fromStep: 0, field: "url"} to read a verified earlier result. No forward references, arbitrary fields or expressions. Planning validates all steps before any execution.',
    execution:
      'Call plan_batch with flat step objects (action plus its fields), then run_batch in bounded steps. Uncertain writes stop. Heavy native copy/snapshot steps are best run one per call.',
  };
}
export const replayableReadActions = new Set([
  'export',
  'list-pages',
  'list-outlines',
  'combine',
  'study-bundle',
]);
const outputs = {
  'list-outlines': ['url', 'outlineHash', 'pageOrderHash'],
  'rename-outline': ['url', 'outlineHash', 'pageOrderHash'],
  'delete-outline': ['url', 'outlineHash', 'pageOrderHash'],
  'unlock-object': ['operationId'],
  'crop-image': ['operationId'],
  'text-box-style': ['operationId'],
  'shape-style': ['operationId'],
  'favorite-document': ['url', 'itemPath'],
  'folder-style': ['itemPath'],
  'folder-rename': ['itemPath'],
  'folder-move': ['itemPath'],
  'arrange-object': ['operationId'],
  'expand-sticky': ['url'],
  'trash-document': ['url', 'itemPath', 'operationId'],
  'restore-document': ['url', 'itemPath', 'operationId'],
  'board-background': ['url'],
  'page-template': ['url', 'count', 'orderHash'],
  'copy-text-object': ['url'],
  'copy-image-object': ['url'],
  'copy-native-selection': ['url', 'operationId'],
  'restore-page': ['url', 'count', 'orderHash'],
  'move-native-object': ['url'],
  'copy-page': ['url', 'count', 'orderHash'],
  snapshot: ['url', 'itemPath', 'snapshotId'],
  'restore-copy': ['url', 'itemPath', 'pageCount'],
  create: ['url', 'itemPath'],
  import: ['url', 'itemPath', 'pageCount'],
  duplicate: ['url', 'itemPath'],
  rename: ['url', 'itemPath'],
  move: ['url', 'itemPath'],
  export: ['url', 'exportId', 'path', 'pageCount'],
  pages: ['url', 'orderHash', 'count', 'operationId'],
  'list-pages': ['url', 'orderHash', 'count'],
  combine: ['path', 'pageCount'],
};
function walk(value, visit, keys = []) {
  if (!value || typeof value !== 'object') return value;
  if (Object.hasOwn(value, 'fromStep')) return visit(value, keys);
  if (Array.isArray(value)) return value.map((v, i) => walk(v, visit, [...keys, i]));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, walk(v, visit, [...keys, k])]),
  );
}
export function validateReferences(steps) {
  const types = {
    collapseOperationId: ['operationId'],
    trashOperationId: ['operationId'],
    deleteOperationId: ['operationId'],
    sourceUrl: ['url'],
    expectedSourceOrderHash: ['orderHash'],
    snapshotId: ['snapshotId'],
    url: ['url'],
    itemPath: ['itemPath'],
    folderPath: ['itemPath'],
    destinationPath: ['itemPath'],
    filePath: ['path'],
    exportId: ['exportId'],
    expectedPageCount: ['count', 'pageCount'],
    expectedOrderHash: ['orderHash'],
    expectedOutlineHash: ['outlineHash'],
    expectedPageOrderHash: ['pageOrderHash', 'orderHash'],
  };
  for (const [i, step] of steps.entries())
    walk(step, (ref, keys) => {
      referenceSchema.parse(ref);
      const source = steps[ref.fromStep];
      if (
        ref.fromStep >= i ||
        !outputs[source?.action]?.includes(ref.field) ||
        !types[keys.at(-1)]?.includes(ref.field) ||
        (keys.at(-1) === 'deleteOperationId' &&
          (source?.action !== 'pages' || source.command !== 'delete')) ||
        (source?.action === 'create' && source.kind === 'folder' && ref.field === 'url')
      )
        throw new GoodnotesError(
          'INVALID_REFERENCE',
          'References must name a supported result field from an earlier step.',
        );
      return ref;
    });
}
export function resolveStep(input, steps) {
  const resolved = walk(input, (ref) => {
    referenceSchema.parse(ref);
    const source = steps[ref.fromStep];
    if (source?.status !== 'verified' || !source.result || !Object.hasOwn(source.result, ref.field))
      throw new GoodnotesError(
        'REFERENCE_UNAVAILABLE',
        'The referenced step has no verified result field.',
      );
    return structuredClone(source.result[ref.field]);
  });
  return concreteStepSchema.parse(resolved);
}
