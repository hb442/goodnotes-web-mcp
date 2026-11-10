#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.mjs';
import { openSession } from './session.mjs';
import { GoodnotesAdapter, GoodnotesError, SerialQueue } from './adapter.mjs';
import { pathToFileURL } from 'node:url';
import { installCompactTools } from './compact.mjs';
import { studyMaterialsSchema } from './study-layout.mjs';
import { studyRevisionChangesSchema } from './study-revision.mjs';
import { collectionMaterialsSchema, collectionLimitsSchema } from './study-collection.mjs';
import {
  formatSchema,
  formatRangesSchema,
  targetSchema,
  inkStyleSchema,
  cropRegionSchema,
  textBoxStyleSchema,
  shapeStyleSchema,
  moveContentSchema,
  batchStepEnvelopeSchema,
  stepActionNames,
  batchHelp,
} from './job-schema.mjs';

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
export function createServer(adapter, { mode = 'full' } = {}) {
  if (!['full', 'compact'].includes(mode))
    throw new Error('GOODNOTES_MCP_MODE must be full or compact.');
  const server = new McpServer({ name: 'goodnotes-web-mcp', version: '0.21.0' });
  const queue = new SerialQueue();
  const definitions = new Map();
  const invoke = (fn) => (args, extra) =>
    queue.run(async () => {
      try {
        if (extra.signal.aborted)
          throw new GoodnotesError('CANCELLED', 'The request was cancelled before execution.');
        return await fn(args, {
          signal: AbortSignal.any([extra.signal, AbortSignal.timeout(180000)]),
        });
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: error.code || 'ACTION_FAILED',
                message: error.message,
                ...error.details,
              }),
            },
          ],
        };
      }
    });
  const register = (name, description, inputSchema, fn, readOnly = true, destructive = false) => {
    definitions.set(name, {
      name,
      description,
      schema: z.object(inputSchema).strict(),
      fn,
      readOnly,
      destructive,
    });
    if (mode === 'full')
      server.registerTool(
        name,
        {
          description,
          inputSchema,
          annotations: {
            readOnlyHint: readOnly,
            destructiveHint: destructive,
            openWorldHint: true,
          },
        },
        invoke(fn),
      );
  };
  const uuid = z.string().uuid();
  const operationId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
  register(
    'goodnotes_prepare_board_adoption',
    'Prepare a verified native COPY of an older whiteboard, preserving all content. Bind a source PDF snapshot for citations. Then select and capture individual native text boxes/images at 100% zoom; this is not exhaustive board enumeration.',
    {
      itemPath: z.array(uuid).min(1).max(13),
      expectedTitle: z.string().min(1).max(150),
      title: z.string().min(1).max(150),
      sourceExportId: uuid,
      requestId: operationId,
    },
    async (args, options) => json(await adapter.boardAdoption.prepare(args, options)),
    false,
  );
  register(
    'goodnotes_capture_board_adoption',
    'Read and independently verify one selected native text box or image on the adoption COPY. Text needs exact expectedText; images retain exact source pixels and crop. No content is changed. Source page assignments are supplied by the caller.',
    {
      adoptionId: uuid,
      selectionId: uuid,
      key: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
      kind: z.enum(['text', 'image']),
      role: z.enum(['summary', 'concept', 'questions', 'answers']).default('concept'),
      pages: z.array(z.number().int().min(1).max(2000)).min(1).max(12),
      expectedText: z.string().min(1).max(20000).optional(),
    },
    async (args, options) => json(await adapter.boardAdoption.capture(args, options)),
    false,
  );
  register(
    'goodnotes_finish_board_adoption',
    'Freeze selected objects as a managed board after checking native content/style/images and proving the complete copied PDF is unchanged. Returns baseId for selective revisions. Other objects remain unmanaged. Preview shows selected objects only.',
    { adoptionId: uuid },
    async (args, options) => json(await adapter.boardAdoption.finish(args, options)),
    false,
  );
  register(
    'goodnotes_board_adoption_status',
    'Read adoption copy, selected managed objects and progress without opening a browser.',
    { adoptionId: uuid },
    async (args) => json(await adapter.boardAdoption.status(args)),
  );
  register(
    'goodnotes_prepare_study_collection',
    'Copy a lecture and export a stable source snapshot for multiple automatically sized learning boards. Reuses the verified study preparation; a stable requestId prevents duplicate copies.',
    {
      sourceItemPath: z.array(uuid).min(1).max(13),
      expectedSourceTitle: z.string().min(1).max(150),
      title: z.string().min(1).max(120),
      folderPath: z.array(uuid).max(12).default([]),
      requestId: operationId,
    },
    async (args, options) => json(await adapter.studyCollection.prepare(args, options)),
    false,
  );
  register(
    'goodnotes_plan_study_collection',
    'Plan up to 240 source-based cards and 120 original figures into bounded, linked boards. Measures real text/figure geometry, preserves figure-caption groups and source pages, produces previews before writing. The caller supplies explanations and exercises.',
    {
      collectionId: uuid,
      materials: collectionMaterialsSchema,
      limits: collectionLimitsSchema.optional(),
    },
    async (args) => json(await adapter.studyCollection.plan(args)),
    false,
  );
  register(
    'goodnotes_run_study_collection',
    'Run one bounded creation or independently verified native block. Creates overview and previous/next native text links. Durable child plans and operation receipts prevent replay after crashes. Stops on uncertain writes.',
    { collectionId: uuid },
    async (args, options) => json(await adapter.studyCollection.run(args, options)),
    false,
  );
  register(
    'goodnotes_study_collection_status',
    'Read collection progress, source pages, previews, overview URL and child workflows. Completed child IDs support selective study revisions.',
    { collectionId: uuid },
    async (args) => json(await adapter.studyCollection.status(args)),
  );
  register(
    'goodnotes_review_study_collection',
    'Review one interrupted collection creation or child step using existing independent evidence. Never repeats uncertain mutations. Unproven creation needs individual inspection.',
    { collectionId: uuid },
    async (args, options) => json(await adapter.studyCollection.review(args, options)),
    false,
  );
  register(
    'goodnotes_prepare_study_revision',
    'Prepare a selective revision of a completed managed learning board or prior revision. Defaults to an independently verified native COPY including personal additions. copy=false keeps a verified native backup and targets the authorized original. A stable request ID prevents duplicate copies. Returns managed block IDs and current source references.',
    {
      baseId: uuid,
      title: z.string().min(1).max(150),
      copy: z.boolean().default(true),
      requestId: operationId,
      itemPath: z.array(uuid).min(1).max(13).optional(),
    },
    async (args, options) => json(await adapter.studyRevision.prepare(args, options)),
    false,
  );
  register(
    'goodnotes_plan_study_revision',
    'Plan selected card updates, bounded object moves and new sections below an existing managed board. Retains untouched objects, checks source pages and intermediate geometry, saves a preview and freezes the plan. Optional sourceExportId reports text/page changes but still needs diagram review. Preview excludes unmanaged personal notes.',
    { revisionId: uuid, changes: studyRevisionChangesSchema },
    async (args) => json(await adapter.studyRevision.plan(args)),
    false,
  );
  register(
    'goodnotes_run_study_revision',
    'Run one saved revision step. Rechecks exact original content/style/appearance, rejects occupied visible destinations, verifies native persistence and unchanged visible surroundings. Never automatically repeats uncertain writes. Exports a final preview.',
    { revisionId: uuid },
    async (args, options) => json(await adapter.studyRevision.run(args, options)),
    false,
  );
  register(
    'goodnotes_study_revision_status',
    'Read saved revision progress, backup, selected changes, source impact, previews and stable managed block IDs. includeContent adds saved text for planning; saved content is not a fresh read of manual edits.',
    { revisionId: uuid, includeContent: z.boolean().default(false) },
    async (args) => json(await adapter.studyRevision.status(args)),
  );
  register(
    'goodnotes_review_study_revision',
    'Independently inspect an interrupted revision from complete matching evidence, including unchanged visible surroundings. Preserves uncertain receipts and never replays mutations. Missing checkpoints require individual inspection.',
    { revisionId: uuid },
    async (args, options) => json(await adapter.studyRevision.review(args, options)),
    false,
  );
  register(
    'goodnotes_prepare_study_board',
    'Begin a resumable lecture-to-board workflow: verify the chosen lecture title, duplicate it, export the copy and return source-page excerpts. Stable requestId prevents duplicate preparation. Originals remain unchanged.',
    {
      sourceItemPath: z.array(uuid).min(1).max(13),
      expectedSourceTitle: z.string().min(1).max(150),
      title: z.string().min(1).max(120),
      folderPath: z.array(uuid).max(12).default([]),
      requestId: operationId,
    },
    async (args, options) => json(await adapter.study.prepare(args, options)),
    false,
  );
  register(
    'goodnotes_plan_study_board',
    'Plan a source-based native learning board locally before writing: summaries, original PDF figure crops, questions and answers. Measures text, wraps lines, rejects overflow/overlap and saves a preview plus an immutable execution plan. Semantic content is supplied by the caller.',
    { workflowId: uuid, materials: studyMaterialsSchema },
    async (args) => json(await adapter.study.plan(args)),
    false,
  );
  register(
    'goodnotes_run_study_board',
    'Execute bounded steps of a prepared native learning board. Each block verifies text/style/layout/appearance after reload; verified receipts resume without duplicate writes. Uncertain writes stop for review. Returns progress and timings.',
    { workflowId: uuid, maxSteps: z.number().int().min(1).max(1).default(1) },
    async (args, options) => json(await adapter.study.run(args, options)),
    false,
  );
  register(
    'goodnotes_study_board_status',
    'Read saved study progress, output board, final preview, per-stage timings and errors without opening a browser. Compact by default; includeEvidence returns full saved block receipts and source-export details.',
    { workflowId: uuid, includeEvidence: z.boolean().default(false) },
    async (args) => json(await adapter.study.status(args)),
  );
  register(
    'goodnotes_review_study_board',
    'Independently verify an interrupted study block from its saved native checkpoint. Only a proven matching result advances the workflow; original uncertain receipts stay unchanged and no mutation is replayed. Audit-only failures can be safely repeated.',
    { workflowId: uuid },
    async (args, options) => json(await adapter.study.review(args, options)),
    false,
  );
  register(
    'goodnotes_image_crop_info',
    'Read one selected image’s native rectangular crop and full source identity. Cancels the draft and returns a short-lived cropId.',
    { selectionId: uuid },
    async (args) => json(await adapter.imageCrop.prepare(args)),
  );
  register(
    'goodnotes_shape_style_info',
    'Read one guarded native shape fill opacity and stroke thickness. Excludes ink and groups; returns a short-lived styleId.',
    { selectionId: uuid },
    async (args) => json(await adapter.shapeStyle.prepare(args)),
  );
  register(
    'goodnotes_set_shape_style',
    'Set a prepared native shape fill opacity (0 to 100 in steps of 10; 0 disables fill) and/or stroke thickness (0.10 to 2.00 mm). Preserves existing color, pattern and geometry; verifies values and appearance after reload.',
    { styleId: uuid, style: shapeStyleSchema, operationId },
    async (args, options) => json(await adapter.shapeStyle.apply(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_text_box_style_info',
    'Probe selected text-box styling. Returns supported:false without writing if the native whiteboard menu lacks it; otherwise returns settings and a short-lived guarded styleId.',
    { selectionId: uuid },
    async (args, options) => json(await adapter.textBoxStyle.prepare(args, options)),
  );
  register(
    'goodnotes_set_text_box_style',
    'Set prepared text-box background/border colors (hex or none), border/corner/padding points and shadow. Preserves exact text and character formatting; verifies native settings and appearance after reload.',
    { styleId: uuid, style: textBoxStyleSchema, operationId },
    async (args, options) => json(await adapter.textBoxStyle.apply(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_crop_image',
    'Apply a prepared rectangle in fractions of the current source preview. Goodnotes may replace the source with cropped pixels. Saves original pixels privately and verifies cropped pixels and appearance after reload.',
    { cropId: uuid, region: cropRegionSchema, operationId },
    async (args, options) => json(await adapter.imageCrop.apply(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_set_document_favorite',
    'Set one authorized notebook/board favorite flag. Requires its exact title and previous favorite flag from the library; checks identity and state after reload.',
    {
      itemPath: z.array(uuid).min(1).max(13),
      expectedTitle: z.string().min(1).max(150),
      expectedFavorite: z.boolean(),
      favorite: z.boolean(),
      operationId,
    },
    async (args, options) => json(await adapter.library.setFavorite(args, options)),
    false,
  );
  register(
    'goodnotes_get_folder_style',
    'Read folder color, icon and favorite state, optionally listing native color/icon choices.',
    {
      itemPath: z.array(uuid).min(1).max(12),
      expectedTitle: z.string().min(1).max(150),
      includeChoices: z.boolean().default(false),
    },
    async (args) => json(await adapter.folderStyle.inspect(args)),
  );
  register(
    'goodnotes_set_folder_style',
    'Change one authorized folder color, icon or favorite flag. Requires its current value and checks all three settings after reload.',
    {
      itemPath: z.array(uuid).min(1).max(12),
      expectedTitle: z.string().min(1).max(150),
      property: z.enum(['color', 'icon', 'favorite']),
      value: z.union([z.string().max(40), z.boolean()]),
      expectedValue: z.union([z.string().max(40), z.boolean()]),
      operationId,
    },
    async (args, options) => json(await adapter.folderStyle.set(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_manage_folder',
    'Rename or move one explicitly authorized folder. MCP-created folders are authorized automatically. Verifies folder identity, parent and direct children; refuses a move into itself.',
    {
      action: z.enum(['rename', 'move']),
      itemPath: z.array(uuid).min(1).max(12),
      expectedTitle: z.string().min(1).max(150),
      title: z.string().min(1).max(150).optional(),
      destinationPath: z.array(uuid).max(11).default([]),
      operationId,
    },
    async (args, options) => json(await adapter.folders.manage(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_prepare_unlock',
    'Select a locked sticky, text box, image or shape at a preview point (use the border for unfilled shapes). Verify its native unlock control and prepare a content/appearance guard. Does not unlock it.',
    {
      viewId: uuid,
      x: z.number().min(0.02).max(0.98),
      y: z.number().min(0.08).max(0.92),
      expectedText: z.string().max(8000).optional(),
      kind: z.enum(['sticky', 'text', 'image', 'shape']).default('sticky'),
    },
    async (args) => json(await adapter.styles.prepareUnlock(args)),
    false,
  );
  register(
    'goodnotes_unlock_object',
    'Unlock a prepared native sticky, text box, image or shape position/size lock. Checks unchanged content/view, appearance and native unlocked state after reload.',
    { unlockId: uuid, operationId },
    async (args, options) => json(await adapter.styles.unlockObject(args, options)),
    false,
  );
  register(
    'goodnotes_unlock_sticky',
    'Unlock one previously prepared native sticky. Refuses changed content/view and verifies unlocked state and unchanged appearance after reload.',
    { unlockId: uuid, operationId },
    async (args, options) => json(await adapter.styles.unlockSticky(args, options)),
    false,
  );
  register(
    'goodnotes_expand_sticky',
    'Expand a sticky collapsed by this server using its saved visual checkpoint. Requires the same page/zoom/viewport and unchanged collapsed region.',
    { collapseOperationId: operationId, operationId },
    async (args, options) => json(await adapter.styles.expandSticky(args, options)),
    false,
  );
  register(
    'goodnotes_restore_document',
    'Recover one document using its verified trash operation receipt. Checks original identity, folder and PDF content baseline.',
    { trashOperationId: operationId, operationId },
    async (args, options) => json(await adapter.trash.restore(args, options)),
    false,
  );
  register(
    'goodnotes_verify_restored_document',
    'Independently check whether a trashed document has returned with its original identity and content. Never sends Recover again or rewrites old receipts.',
    { trashOperationId: operationId },
    async (args, options) => json(await adapter.trash.verifyRestore(args, options)),
  );
  register(
    'goodnotes_list_trash',
    'List a bounded part of the native Trash, including document and page IDs. Never empties Trash.',
    {
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    },
    async (args) => json(await adapter.trash.list(args)),
  );
  register(
    'goodnotes_trash_document',
    'Move one explicitly writable document to Trash after saving a PDF backup. Binds its current title and verifies its exact ID in Trash.',
    {
      itemPath: z.array(uuid).min(1).max(13),
      expectedTitle: z.string().min(1).max(150),
      operationId,
    },
    async (args, options) => json(await adapter.trash.trash(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_list_templates',
    'Read native paper/cover templates for one page using the current size/color filter. Returns exact IDs and page-order guards.',
    {
      url: z.string().url(),
      page: z.number().int().min(1).default(1),
      kind: z.enum(['paper', 'cover']).default('paper'),
    },
    async (args) => json(await adapter.layout.templates(args)),
    false,
  );
  register(
    'goodnotes_set_template',
    'Replace a page background or cover with a listed native template. Saves a PDF backup, verifies picker selection and page identities, and compares exported appearance/text across reload.',
    {
      url: z.string().url(),
      page: z.number().int().min(1),
      kind: z.enum(['paper', 'cover']).default('paper'),
      templateId: z.string().min(1).max(200),
      expectedPageCount: z.number().int().min(1),
      expectedOrderHash: z.string().regex(/^[a-f0-9]{64}$/),
      operationId,
    },
    async (args, options) => json(await adapter.layout.setTemplate(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_board_settings',
    'Read the current whiteboard background pattern and color.',
    { url: z.string().url() },
    async (args) => json(await adapter.layout.boardSettings(args)),
  );
  register(
    'goodnotes_set_board_background',
    'Change whiteboard pattern/color with current-state guards; verify saved native settings after reload.',
    {
      url: z.string().url(),
      pattern: z.enum(['plain', 'dot', 'grid']).optional(),
      color: z.enum(['white', 'yellow', 'black']).optional(),
      expectedPattern: z.enum(['plain', 'dot', 'grid']),
      expectedColor: z.enum(['white', 'yellow', 'black']),
      operationId,
    },
    async (args, options) => json(await adapter.layout.setBoard(args, options)),
    false,
  );
  register(
    'goodnotes_status',
    'Check the isolated Goodnotes login and list explicitly writable documents.',
    {},
    async () => json(await adapter.status()),
  );
  register(
    'goodnotes_list',
    'List one library folder. Returns itemPath values for opening documents.',
    {
      folderPath: z.array(uuid).max(12).default([]),
      limit: z.number().int().min(1).max(100).default(30),
      offset: z.number().int().min(0).default(0),
    },
    async (args) => json(await adapter.list(args)),
  );
  register(
    'goodnotes_open',
    'Open an itemPath returned by goodnotes_list; return a compact view handle.',
    { itemPath: z.array(uuid).min(1).max(13) },
    async (args) => json(await adapter.openItem(args)),
  );
  register(
    'goodnotes_inspect',
    'Open an existing Goodnotes Web document URL and prepare a view. No screenshot by default.',
    { url: z.string().url() },
    async (args) => json(await adapter.inspect(args)),
  );
  register(
    'goodnotes_preview',
    'Return one image of the current document viewport, only when visual positioning is needed.',
    { viewId: uuid },
    async (args) => {
      const { bytes, description } = await adapter.preview(args);
      return {
        content: [
          { type: 'text', text: JSON.stringify(description) },
          { type: 'image', data: bytes.toString('base64'), mimeType: 'image/jpeg' },
        ],
      };
    },
  );
  register(
    'goodnotes_read_text',
    'Read typed text at a point relative to the preview canvas. Set expectedKind to sticky or shape to enter its native text editor; an unfilled shape requires a point on its border. Returns a targetId for guarded replacement or rich-text edits. No handwriting OCR.',
    {
      viewId: uuid,
      x: z.number().min(0.01).max(0.99),
      y: z.number().min(0.04).max(0.94),
      expectedKind: z.enum(['text-box', 'sticky', 'shape']).optional(),
    },
    async (args) => json(await adapter.readText(args)),
    false,
  );
  register(
    'goodnotes_write_text',
    'Replace the text of a previously read target, only in a locally allowed document. An empty string clears only an explicitly read native shape label, keeping its shape. Verifies exact text and native kind after reload. Use a unique operationId; never retry an uncertain write with a new ID.',
    {
      targetId: uuid,
      text: z.string().max(8000),
      operationId,
    },
    async (args, options) => json(await adapter.writeText(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_operation_status',
    'Read a local operation receipt after a timeout or restart. Pending/uncertain means inspect the document; do not repeat a write with a new ID.',
    { operationId },
    async (args) => json(await adapter.journal.get(args.operationId)),
  );
  const source = {
    url: z.string().url().optional(),
    exportId: uuid.optional(),
    refresh: z.boolean().default(false),
  };
  register(
    'goodnotes_export',
    'Export all pages to a private local PDF and index its text. Returns exportId and file path. Never changes the cloud document.',
    {
      url: z.string().url(),
      format: z.enum(['flattened', 'editable']).default('flattened'),
      searchableHandwriting: z.boolean().default(true),
    },
    async (args, options) => json(await adapter.documents.exportPdf(args, options)),
  );
  register(
    'goodnotes_read_document',
    'Read cached PDF pages, with bounded automatic local OCR for pages without text. Continue with nextPage/nextOffset; OCR/formulas need visual checking. Refresh explicitly for current content.',
    {
      ...source,
      startPage: z.number().int().min(1).default(1),
      startOffset: z.number().int().min(0).default(0),
      endPage: z.number().int().min(1).optional(),
      maxCharacters: z.number().int().min(100).max(60000).default(24000),
      includeImages: z.boolean().default(false),
      maxImagePages: z.number().int().min(1).max(4).default(2),
      ocrIfMissing: z.boolean().default(true),
      maxOcrPages: z.number().int().min(0).max(10).default(3),
    },
    async (args, options) => {
      const { result, images } = await adapter.documents.read(args, options);
      return {
        content: [
          ...json(result).content,
          ...images.map((i) => ({
            type: 'image',
            data: i.bytes.toString('base64'),
            mimeType: 'image/png',
          })),
        ],
      };
    },
  );
  register(
    'goodnotes_search_document',
    'Search exported pages, using bounded local OCR where text is missing. Reports incomplete coverage and OCR provenance; absence is not proof about handwriting.',
    {
      ...source,
      query: z.string().min(1).max(300),
      caseSensitive: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(30),
      ocrIfMissing: z.boolean().default(true),
      maxOcrPages: z.number().int().min(0).max(10).default(3),
    },
    async (args, options) => json(await adapter.documents.search(args, options)),
  );
  register(
    'goodnotes_render_page',
    'Render one exported PDF page for reading handwriting, scans, diagrams and layout. No desktop capture.',
    {
      exportId: uuid,
      page: z.number().int().min(1),
      maxDimension: z.number().int().min(500).max(2400).default(1600),
    },
    async (args) => {
      const { bytes, ...info } = await adapter.documents.render(args);
      return {
        content: [
          ...json(info).content,
          { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
        ],
      };
    },
  );
  register(
    'goodnotes_ocr',
    'Recognize 1–10 exported pages locally in English/German. Adds approximate OCR text to reads/searches; handwriting, formulas and tables require visual checking.',
    {
      exportId: uuid,
      startPage: z.number().int().min(1).default(1),
      endPage: z.number().int().min(1).optional(),
      replace: z.boolean().default(false),
    },
    async (args, options) => json(await adapter.documents.recognize(args, options)),
  );
  register(
    'goodnotes_create',
    'Create a folder, notebook or whiteboard in a library folder. Newly created documents become writable; use a unique operationId.',
    {
      kind: z.enum(['folder', 'notebook', 'whiteboard']),
      title: z.string().min(1).max(150),
      folderPath: z.array(uuid).max(12).default([]),
      operationId,
    },
    async (args, options) => json(await adapter.library.create(args, options)),
    false,
  );
  register(
    'goodnotes_manage_document',
    'Duplicate a document, or rename/move a writable document. Duplicates become writable. Uses library itemPath values; no permanent deletion or sharing.',
    {
      action: z.enum(['duplicate', 'rename', 'move']),
      itemPath: z.array(uuid).min(1).max(13),
      title: z.string().min(1).max(150).optional(),
      destinationPath: z.array(uuid).max(12).default([]),
      operationId,
    },
    async (args, options) => json(await adapter.library.manage(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_edit_text',
    'Edit text and apply body formatting plus up to 20 nonoverlapping formatRanges in one verified save. Extra ranges address the final text after replacement and override body formatting. List/highlight require the whole field. UTF-16 offsets; end exclusive. Reload verification remains mandatory.',
    {
      targetId: uuid,
      start: z.number().int().min(0).default(0),
      end: z.number().int().min(0).optional(),
      replacement: z.string().max(8000).optional(),
      format: formatSchema.default({}),
      formatRanges: formatRangesSchema.default([]),
      operationId,
    },
    async (args, options) => json(await adapter.text.edit(args, options)),
    false,
    true,
  );
  const point = { x: z.number().min(0.02).max(0.98), y: z.number().min(0.08).max(0.92) };
  const region = z.object({
    ...point,
    width: z.number().positive().max(0.95),
    height: z.number().positive().max(0.85),
  });
  register(
    'goodnotes_select_object',
    'Select one visible board object by point, or a group using a rectangular region. Returns a guarded selectionId; preview to check what was selected.',
    { viewId: uuid, x: point.x.optional(), y: point.y.optional(), region: region.optional() },
    async (args, options) => json(await adapter.objects.select(args, options)),
    false,
  );
  register(
    'goodnotes_transform_object',
    'Move, resize, duplicate or delete the guarded selection in a writable document. dx/dy are fractions of canvas size; scale factors are relative. Keeps local before/after evidence and checks after reload.',
    {
      selectionId: uuid,
      action: z.enum(['move', 'resize', 'duplicate', 'delete']),
      dx: z.number().min(-0.8).max(0.8).default(0),
      dy: z.number().min(-0.8).max(0.8).default(0),
      scaleX: z.number().min(0.25).max(3).default(1),
      scaleY: z.number().min(0.25).max(3).default(1),
      operationId,
    },
    async (args, options) => json(await adapter.objects.transform(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_read_handwriting',
    'Read real ink strokes in a visible rectangular region using Goodnotes native conversion preview, then cancel. Does not replace the handwriting. Background images/PDF text are not native ink.',
    { viewId: uuid, region, language: z.string().max(60).optional() },
    async (args) => json(await adapter.objects.recognize(args)),
    false,
  );
  register(
    'goodnotes_convert_handwriting',
    'Replace previously recognized handwriting with editable text in a writable document. Optionally correct recognition text first; verifies the resulting text after reload.',
    { handwritingId: uuid, text: z.string().min(1).max(8000).optional(), operationId },
    async (args, options) => json(await adapter.objects.convert(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_create_object',
    'Create a sticky note, rectangle, ellipse, triangle, diamond, rounded rectangle or ink strokes in a writable document. Coordinates are relative to the current canvas. Uses current Goodnotes tool colors; verifies appearance after reload.',
    {
      viewId: uuid,
      kind: z.enum([
        'sticky',
        'rectangle',
        'ellipse',
        'triangle',
        'diamond',
        'rounded-rectangle',
        'ink',
      ]),
      inkStyle: inkStyleSchema.optional(),
      x: point.x.default(0.2),
      y: point.y.default(0.2),
      width: z.number().min(0.02).max(0.7).default(0.15),
      height: z.number().min(0.02).max(0.7).default(0.15),
      text: z.string().max(3000).default(''),
      strokes: z
        .array(z.array(z.object(point)).min(2).max(1000))
        .min(1)
        .max(100)
        .optional(),
      operationId,
    },
    async (args, options) => json(await adapter.objects.create(args, options)),
    false,
  );
  register(
    'goodnotes_navigate',
    'Open a page, zoom in/out by steps, or pan the document by scroll pixels. Returns a fresh viewId; all previous targets expire.',
    {
      viewId: uuid,
      page: z.number().int().min(1).max(2000).optional(),
      zoomSteps: z.number().int().min(-10).max(10).default(0),
      panX: z.number().min(-3000).max(3000).default(0),
      panY: z.number().min(-3000).max(3000).default(0),
    },
    async (args) => json(await adapter.navigate(args)),
  );
  register(
    'goodnotes_sync_status',
    'Report visible Web connectivity/sync messages. Cannot confirm delivery to another device or force iPad synchronization.',
    { url: z.string().url().optional() },
    async (args) => json(await adapter.syncStatus(args)),
  );
  register(
    'goodnotes_refresh_index',
    'Build/resume a private recursive library index in bounded steps. Reuse jobId until complete. Refreshes snapshots using visible metadata hints and max age; force=true rereads all. Does not change cloud notes.',
    {
      jobId: uuid.optional(),
      folderPath: z.array(uuid).max(12).default([]),
      includeText: z.boolean().default(true),
      ocr: z.boolean().default(false),
      recursive: z.boolean().default(true),
      force: z.boolean().default(false),
      maxAgeHours: z.number().min(0).max(720).default(24),
      maxSteps: z.number().int().min(1).max(5).default(1),
    },
    async (args, options) => json(await adapter.catalog.refresh(args, options)),
    false,
  );
  register(
    'goodnotes_search_library',
    'Search persistent local document titles and indexed text across folders. Reports snapshot timestamps and gaps. Empty query lists known items. Does not open the browser.',
    {
      query: z.string().max(300).default(''),
      folderPath: z.array(uuid).max(12).default([]),
      kind: z.string().max(40).optional(),
      content: z.boolean().default(true),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(30),
      includeMissing: z.boolean().default(false),
    },
    async (args, options) => json(await adapter.catalog.search(args, options)),
  );
  register(
    'goodnotes_plan_batch',
    'Save a concrete batch plan without changing Goodnotes. Use batch_help for the fields of up to three action types. Steps are flat objects with action plus its fields; all are strictly validated before saving. Typed references to verified earlier results are supported. Run separately; private inputs persist locally.',
    {
      title: z.string().min(1).max(150),
      steps: z.array(batchStepEnvelopeSchema).min(1).max(100),
      backup: z.boolean().default(true),
    },
    async (args) => json(await adapter.jobs.plan(args)),
    false,
  );
  register(
    'goodnotes_run_batch',
    'Execute/resume a saved batch in bounded steps, with PDF snapshots before destructive edits by default. Verified operations never repeat; ambiguous writes stop for review.',
    {
      jobId: uuid,
      maxSteps: z.number().int().min(1).max(3).default(1),
    },
    async (args, options) => json(await adapter.jobs.run(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_batch_status',
    'Read batch progress, receipts, backup paths and errors after interruption. Inputs omitted by default.',
    { jobId: uuid, includeInputs: z.boolean().default(false) },
    async (args) => json(await adapter.jobs.status(args)),
  );
  register(
    'goodnotes_skip_batch_step',
    'Skip an unfinished step after inspecting its uncertain outcome. Does not undo it. Remaining work can then resume.',
    { jobId: uuid, stepIndex: z.number().int().min(0).max(99), reason: z.string().min(1).max(500) },
    async (args) => json(await adapter.jobs.skip(args)),
    false,
  );
  register(
    'goodnotes_list_outlines',
    'List native outline entries with stable entry/page identities and conflict hashes. Paginated; reports incomplete scans. Nested/imported outline structures are not supported for editing.',
    {
      url: z.string().url(),
      offset: z.number().int().min(0).max(2000).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    },
    async (args, options) => json(await adapter.outlines.list(args, options)),
  );
  register(
    'goodnotes_manage_outline',
    'Rename or delete one flat native outline entry using its exact old title, outline hash and page-order hash. Rename requires title. Saves private metadata and verifies every exposed outline entry and page order after reload. Never deletes a page.',
    {
      url: z.string().url(),
      outlineId: uuid,
      expectedTitle: z.string().min(1).max(5000),
      expectedOutlineHash: z.string().length(64),
      expectedPageOrderHash: z.string().length(64),
      command: z.enum(['rename', 'delete']),
      title: z.string().trim().min(1).max(150).optional(),
      operationId,
    },
    async (args, options) => json(await adapter.outlines.manage(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_list_pages',
    'Read native page identities, count and order fingerprint. Refuses incomplete/virtualized sidebars. Invalidates canvas handles.',
    { url: z.string().url() },
    async (args) => json(await adapter.pages.list(args)),
  );
  register(
    'goodnotes_manage_pages',
    'Duplicate, add, reorder, rotate, outline or trash one page in an allowed document. Requires expected count; provide order hash to guard concurrent changes. Deletion first saves a PDF/order checkpoint for restore_page. Verifies native identities after reload.',
    {
      url: z.string().url(),
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
      expectedPageCount: z.number().int().min(1).max(2000),
      expectedOrderHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      destination: z.number().int().min(1).max(2000).optional(),
      title: z.string().min(1).max(150).optional(),
      operationId,
    },
    async (args, options) => json(await adapter.pages.manage(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_import_pdf',
    'Import an explicitly supplied absolute local PDF path as a new notebook; verify title/page count and allow future edits. File content is uploaded to your Goodnotes account.',
    {
      filePath: z.string().min(1),
      title: z.string().min(1).max(150),
      folderPath: z.array(uuid).max(12).default([]),
      operationId,
    },
    async (args, options) => json(await adapter.pages.importPdf(args, options)),
    false,
  );
  register(
    'goodnotes_find_objects',
    'Find visible text locations on a board using local OCR. Returns compact candidates with coordinates/confidence; no screenshot tokens. Off-screen objects require pan/zoom and another scan.',
    {
      viewId: uuid,
      query: z.string().max(200).default(''),
      minConfidence: z.number().min(0).max(100).default(40),
    },
    async (args, options) => json(await adapter.board.find(args, options)),
  );
  register(
    'goodnotes_select_match',
    'Select a previously found text object after checking its pixels and reading its actual editable text. Rejects non-editable PDF/handwriting matches; returns text and selection handles.',
    { matchId: uuid, expectedText: z.string().max(8000).optional() },
    async (args) => json(await adapter.board.select(args)),
    false,
  );
  register(
    'goodnotes_plan_layout',
    'Plan a grid of existing text/sticky objects identified by unique text queries. Saves a batch; no movement until run_batch. Centers must fit in the current viewport. Does not resize objects or guarantee no overlap.',
    {
      url: z.string().url(),
      items: z
        .array(
          z.object({
            query: z.string().min(1).max(200),
            expectedText: z.string().max(8000).optional(),
          }),
        )
        .min(1)
        .max(20),
      columns: z.number().int().min(1).max(10).default(2),
      startX: z.number().min(0.05).max(0.95).default(0.25),
      startY: z.number().min(0.1).max(0.9).default(0.25),
      spacingX: z.number().min(0.01).max(0.8).default(0.3),
      spacingY: z.number().min(0.01).max(0.8).default(0.3),
      title: z.string().min(1).max(150).default('Arrange board'),
    },
    async (args) => json(await adapter.board.planLayout(args)),
    false,
  );
  register(
    'goodnotes_combine_pdf',
    'Combine or extract selected pages from existing local PDF exports into a new local PDF, preserving supplied order. Never modifies cloud originals. Import the resulting path explicitly if desired.',
    {
      parts: z
        .array(
          z.object({
            exportId: uuid,
            pages: z.array(z.number().int().min(1).max(2000)).min(1).max(2000).optional(),
          }),
        )
        .min(1)
        .max(50),
      title: z.string().min(1).max(150).default('Combined notes'),
    },
    async (args, options) => json(await adapter.workflows.combine(args, options)),
    false,
  );
  register(
    'goodnotes_study_bundle',
    'Save source text, assistant-supplied summary/tasks and Anki-compatible TSV cards locally with source references. The assistant must supply the learning content. Does not call another AI or import into task/flashcard apps.',
    {
      exportId: uuid,
      summary: z.string().max(100000).default(''),
      tasks: z
        .array(
          z.object({ text: z.string().min(1).max(2000), page: z.number().int().min(1).optional() }),
        )
        .max(500)
        .default([]),
      cards: z
        .array(
          z.object({
            front: z.string().min(1).max(4000),
            back: z.string().min(1).max(10000),
            page: z.number().int().min(1).optional(),
          }),
        )
        .max(1000)
        .default([]),
    },
    async (args) => json(await adapter.workflows.studyBundle(args)),
    false,
  );
  register(
    'goodnotes_insert_image',
    'Insert an explicitly supplied local PNG/JPEG into an allowed document and verify its appearance after reload. Uploads this image to Goodnotes. Returns a selection for moving/resizing.',
    { viewId: uuid, filePath: z.string().min(1), operationId },
    async (args, options) => json(await adapter.images.insert(args, options)),
    false,
  );
  register(
    'goodnotes_create_text',
    'Create an editable text box at an empty canvas point. Refuses an existing non-empty text field; checks exact persistence after reload.',
    { viewId: uuid, ...point, text: z.string().min(1).max(8000), operationId },
    async (args, options) => json(await adapter.text.create(args, options)),
    false,
  );
  register(
    'goodnotes_draw_connector',
    'Draw a straight line or arrow as native ink strokes using the current pen style. Endpoints are canvas fractions. This is drawn ink, not a connector that follows moved objects.',
    {
      viewId: uuid,
      from: z.object(point),
      to: z.object(point),
      arrow: z.boolean().default(true),
      inkStyle: inkStyleSchema.optional(),
      operationId,
    },
    async (args, options) => json(await adapter.board.connector(args, options)),
    false,
  );
  register(
    'goodnotes_object_colors',
    'Read the native color palette for the current guarded selection. Colors depend on its type: text, sticky, ink or shape. No custom color/palette writes.',
    { selectionId: uuid },
    async (args) => json(await adapter.styles.palette(args)),
  );
  register(
    'goodnotes_color_object',
    'Apply one color returned by object_colors to an allowed selection. Checks native color and appearance after reload. May recolor a whole selected group.',
    { selectionId: uuid, color: z.string().regex(/^#[a-fA-F0-9]{6}$/), operationId },
    async (args, options) => json(await adapter.styles.color(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_scan_board',
    'Scan a bounded grid of a whiteboard using measured native viewport coordinates and local OCR. Resumable by scanId; returns compact progress. Does not claim complete coverage of an infinite board.',
    {
      scanId: uuid.optional(),
      url: z.string().url().optional(),
      columns: z.number().int().min(1).max(9).default(3),
      rows: z.number().int().min(1).max(9).default(3),
      overlap: z.number().min(0.2).max(0.8).default(0.4),
      zoomSteps: z.number().int().min(-6).max(6).default(0),
      maxTiles: z.number().int().min(1).max(3).default(1),
      savePreviews: z.boolean().default(false),
    },
    async (args, options) => json(await adapter.scans.scan(args, options)),
    false,
  );
  register(
    'goodnotes_search_board_scan',
    'Search saved text locations across scanned whiteboard viewports without opening the browser.',
    {
      scanId: uuid,
      query: z.string().max(200).default(''),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(30),
    },
    async (args) => json(await adapter.scans.search(args)),
  );
  register(
    'goodnotes_select_board_match',
    'Return to a saved board location, verify its visible and editable text, and select it. Stops if the location or contents changed.',
    { scanId: uuid, matchId: uuid, expectedText: z.string().max(8000).optional() },
    async (args, options) => json(await adapter.scans.select(args, options)),
    false,
  );
  register(
    'goodnotes_remember_object',
    'Save a labeled visual bookmark for a guarded selected object, including shapes/images. Persists measured board or notebook-page coordinates and an appearance fingerprint; changes invalidate the bookmark.',
    { selectionId: uuid, label: z.string().min(1).max(150) },
    async (args) => json(await adapter.scans.remember(args)),
    false,
  );
  register(
    'goodnotes_recall_object',
    'Return to a saved board or notebook-page object and reselect it only if its appearance still matches. Returns a new guarded selection handle.',
    { objectId: uuid },
    async (args, options) => json(await adapter.scans.recall(args, options)),
    false,
  );
  register(
    'goodnotes_create_snapshot',
    'Create a native Goodnotes duplicate as a recovery snapshot, verify page count and save its source mapping locally. Requires a concrete title; no original contents are changed.',
    { itemPath: z.array(uuid).min(1).max(13), title: z.string().min(1).max(150), operationId },
    async (args, options) => json(await adapter.recovery.create(args, options)),
    false,
  );
  register(
    'goodnotes_restore_snapshot',
    'Restore a saved native snapshot into a NEW independently editable document. Keeps the original and snapshot intact. Checks snapshot title/page identities; does not overwrite originals.',
    { snapshotId: uuid, title: z.string().min(1).max(150), operationId },
    async (args, options) => json(await adapter.recovery.restore(args, options)),
    false,
  );
  register(
    'goodnotes_compare_exports',
    'Compare two PDF snapshots by page position, extracted text and optionally rendered appearance. Bounded page ranges; returns differences without modifying documents.',
    {
      leftExportId: uuid,
      rightExportId: uuid,
      startPage: z.number().int().min(1).default(1),
      maxPages: z.number().int().min(1).max(10).default(10),
      visual: z.boolean().default(false),
    },
    async (args, options) => json(await adapter.recovery.compare(args, options)),
  );
  register(
    'goodnotes_retry_rejected_step',
    'Prepare a fresh attempt only when the old receipt proves NO mutation was sent. Preserves the old receipt and attempt history. Rejects uncertain, pending or missing receipts; run_batch executes the prepared retry.',
    { jobId: uuid, stepIndex: z.number().int().min(0).max(99) },
    async (args) => json(await adapter.jobs.retryRejected(args)),
    false,
  );
  register(
    'goodnotes_copy_native_selection',
    'Copy a guarded rectangular lasso selection to another allowed document with the native clipboard. Verifies source and saved visible appearance; does not certify exact text or hidden properties. Different backgrounds or overlaps can prevent verification.',
    {
      selectionId: uuid,
      destinationPath: z.array(uuid).min(1).max(13),
      destinationPage: z.number().int().min(1).max(2000).default(1),
      x: point.x,
      y: point.y,
      operationId,
    },
    async (args, options) => json(await adapter.objects.copyNativeSelection(args, options)),
    false,
  );
  register(
    'goodnotes_copy_page',
    'Copy one native page into another notebook using Goodnotes in-app clipboard. Preserves editable contents; verifies page identities, text and rendered appearance. Both page-order hashes are required. Does not remove the source page.',
    {
      sourceUrl: z.string().url(),
      sourcePage: z.number().int().min(1).max(2000),
      expectedSourceOrderHash: z.string().regex(/^[a-f0-9]{64}$/),
      destinationPath: z.array(uuid).min(1).max(13),
      destinationPage: z.number().int().min(1).max(2000),
      placement: z.enum(['before', 'after']).default('after'),
      expectedPageCount: z.number().int().min(1).max(2000),
      expectedOrderHash: z.string().regex(/^[a-f0-9]{64}$/),
      operationId,
    },
    async (args, options) => json(await adapter.pages.copyNative(args, options)),
    false,
  );
  register(
    'goodnotes_object_options',
    'Read supported front/back, lock, collapse and author-display commands for the exact current selection.',
    { selectionId: uuid },
    async (args) => json(await adapter.styles.options(args)),
    false,
  );
  register(
    'goodnotes_arrange_object',
    'Apply a command returned by object_options to the guarded selection; verify its appearance and, for toggle states, its native inverse command after reload.',
    {
      selectionId: uuid,
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
      operationId,
    },
    async (args, options) => json(await adapter.styles.arrange(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_move_native_object',
    'Move one text box/sticky or image from a whiteboard or notebook page to another allowed document. Saves a source PDF, verifies a native copy, reacquires the unchanged original before deleting it, and rechecks both ends. Separate operations, not atomic; failure can leave two copies.',
    {
      sourceUrl: z.string().url(),
      target: targetSchema,
      content: moveContentSchema,
      destinationPath: z.array(uuid).min(1).max(13),
      destinationPage: z.number().int().min(1).max(2000).default(1),
      x: point.x,
      y: point.y,
      operationId,
    },
    async (args, options) => json(await adapter.objectMove.move(args, options)),
    false,
    true,
  );
  register(
    'goodnotes_verify_moved_object',
    'Audit a saved native move after interruption: requires verified copy/deletion receipts, checks the deleted source region and native destination copy, and preserves old receipt status. Never repeats paste or delete.',
    { operationId },
    async (args, options) => json(await adapter.objectMove.verify(args, options)),
    false,
  );
  register(
    'goodnotes_restore_page',
    'Restore one page deleted by this MCP using its saved pre-delete PDF checkpoint. Requires unchanged remaining pages and authorization, recovers the exact native page and verifies original order/content. Never restores arbitrary historical pages.',
    { deleteOperationId: operationId, operationId },
    async (args, options) => json(await adapter.pageRecovery.restore(args, options)),
    false,
  );
  register(
    'goodnotes_verify_restored_page',
    'Independently verify a page restoration against its saved deletion checkpoint: exact native identities/order and full PDF content baseline. Does not repeat recovery or change the original receipt.',
    { deleteOperationId: operationId },
    async (args, options) => json(await adapter.pageRecovery.verifyRestore(args, options)),
  );
  register(
    'goodnotes_copy_image_object',
    'Copy one native image into another document/page through Goodnotes Copy/Paste. Requires sourceSha256 and region from image_crop_info; checks original pixels/crop and saved appearance. Source stays intact.',
    {
      sourceUrl: z.string().url(),
      target: targetSchema,
      expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
      expectedCrop: cropRegionSchema,
      destinationPath: z.array(uuid).min(1).max(13),
      destinationPage: z.number().int().min(1).max(2000).default(1),
      x: point.x,
      y: point.y,
      operationId,
    },
    async (args, options) => json(await adapter.objects.copyNativeImage(args, options)),
    false,
  );
  register(
    'goodnotes_copy_text_object',
    'Copy one verified native text box or sticky into another document/page through Goodnotes Copy/Paste. Verifies editable text, formatting, kind and appearance after reload; leaves source intact.',
    {
      sourceUrl: z.string().url(),
      target: targetSchema,
      expectedText: z.string().min(1).max(8000),
      destinationPath: z.array(uuid).min(1).max(13),
      destinationPage: z.number().int().min(1).max(2000).default(1),
      x: point.x,
      y: point.y,
      operationId,
    },
    async (args, options) => json(await adapter.objects.copyNativeText(args, options)),
    false,
  );
  register(
    'goodnotes_verify_restore',
    'After an interrupted restore, verify the already-created native copy against its saved snapshot baseline without repeating any write. Preserves the old uncertain receipt.',
    { snapshotId: uuid, restoreOperationId: operationId },
    async (args, options) => json(await adapter.recovery.verifyRestore(args, options)),
  );
  register(
    'goodnotes_batch_help',
    'Return detailed batch input schemas only for the requested action types, avoiding the cost of advertising every action schema on every tool-discovery call.',
    { actions: z.array(z.enum(stepActionNames)).min(1).max(3) },
    async (args) => json(batchHelp(args.actions)),
  );
  register(
    'goodnotes_verify_copied_object',
    'Verify an existing native text/sticky/image or lasso-selection paste from its saved local checkpoint. Reacquires its page across zoom changes, performs type-specific content checks or compares captured source appearance, and checks saved appearance; never pastes again or rewrites the old receipt.',
    { operationId },
    async (args, options) => json(await adapter.objects.verifyCopiedText(args, options)),
    false,
  );
  if (mode === 'compact') installCompactTools(server, definitions, invoke);
  return server;
}

export async function main() {
  const config = await loadConfig();
  let sessionPromise;
  const getPage = async () => {
    sessionPromise ??= openSession(config).catch((error) => {
      sessionPromise = undefined;
      throw error;
    });
    return (await sessionPromise).page;
  };
  const server = createServer(new GoodnotesAdapter({ config, getPage }), {
    mode: process.env.GOODNOTES_MCP_MODE ?? 'full',
  });
  let closePromise;
  const close = () =>
    (closePromise ??= (async () => {
      const session = await sessionPromise?.catch(() => null);
      await session?.close();
    })());
  const shutdown = () =>
    void close().then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(`Shutdown failed: ${error.message}\n`);
        process.exit(1);
      },
    );
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // The SDK's server transport does not emit onclose for stdin EOF.
  // Handle it before a stdio client has to force-terminate the browser owner.
  process.stdin.once('end', shutdown);
  const transport = new StdioServerTransport();
  transport.onclose = () => void close();
  await server.connect(transport);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
