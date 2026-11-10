# Goodnotes Web MCP

An experimental, local MCP server for **Goodnotes Web documents, handwriting, text and board objects**. It uses an isolated headless browser and fixed action sequences. It does not capture your desktop or operate your personal browser profile.

Unofficial community project; not affiliated with or endorsed by Goodnotes. Current distributions use the [Personal Noncommercial License](LICENSE): personal use by individuals only, including private study. Commercial, professional and institutional use requires separate permission. Goodnotes accounts and the calling AI client are separate requirements.

**Status:** experimental 0.21.1 with 107 actions, locally developed on Windows. Individual tools remain the default; an optional [compact mode](docs/COMPACT.md) exposes three entry tools and loads action schemas on demand. See [validation and limitations](docs/LIMITATIONS.md). Browser reload checks are not proof of synchronization to an iPad.

[Deutsche Anleitung](docs/DE.md) · [Limitations](docs/LIMITATIONS.md) · [Security](SECURITY.md) · [Development](docs/DEVELOPMENT.md)

## What it does

- Plan [native learning boards from lecture copies](docs/STUDY-BOARDS.md), including original slide crops, source references, summaries, exercises, layout checks and resumable execution with recorded timings.
- Revise selected cards on [existing managed learning boards](docs/STUDY-REVISIONS.md), preserve unrelated personal additions, move verified objects and append new sections. Default to a verified native copy; in-place revisions retain a native backup.
- Adopt selected native text boxes/images from older board copies and split large lectures into [linked learning-board collections](docs/STUDY-COLLECTIONS.md), with a navigable overview and independently revisable parts.
- Arrange learning materials in one to three columns with wider blocks, named sections, compact packing, up to 24 cards and 12 original figures. Caption spacing follows each figure's actual height.
- Build a resumable recursive library index; search titles and cached page text without opening documents for every query.
- Save chained batches whose later steps use verified outputs from earlier steps; resume after restart, with PDF backups and a review stop after uncertain writes.
- Scan a bounded board region across multiple viewports, resume scans, and reacquire text objects from saved locations.
- Copy native pages between notebooks, and individual editable text boxes, sticky notes or images between documents.
- Move one native text box/sticky or image from a whiteboard or notebook page to another authorized document, with a PDF backup, verified copy and guarded source deletion.
- Create native snapshot copies with PDF baselines and restore into a new independent document.
- Change board backgrounds, apply listed native paper/cover templates, bookmark pages, and trash/restore guarded documents.
- Import PDFs; duplicate, add, reorder, rotate, outline and trash pages with native page-ID verification; restore pages from saved MCP deletion checkpoints.
- Find visible board text with local OCR, verify editable matches and plan object grids by text.
- Create text boxes, insert PNG/JPEG images, draw ink lines/arrows, set writing-tool colors/thickness, align text and add/edit HTTP(S) links.
- Combine selected exported pages and produce local study text, structured tasks and Anki-compatible TSV cards.
- List/open documents, create folders/notebooks/whiteboards, duplicate, rename and move documents.
- Organize authorized folders by name/location, color, icon and favorite state.
- Set document favorites; crop selected images with private original-pixel backups; style native text-box backgrounds, borders, corners, padding and shadows.
- Export an entire document as PDF; read pages, search excerpts and render selected pages.
- Run local English/German OCR on scanned or flattened pages without an external AI API.
- Automatically recognize pages with no PDF text when reading/searching, with a bounded OCR budget and explicit remaining/failed page lists. Set `ocrIfMissing: false` to disable it or `maxOcrPages` to change the per-call budget (default 3).
- Restore whiteboard zoom and pan for text, image and object reload checks and PDF backups, using measured native scrolling. Missing native whiteboard text-box style menus report `supported: false` without changing content.
- Read real handwriting through Goodnotes' conversion preview; explicitly convert selected ink to editable text.
- Read typed text with formatting; replace a field or edit a character range; apply bold, italic, underline, strike, custom color, font size, whole-field highlights and flat bullet/numbered lists.
- Select, move, resize, duplicate and delete board objects or lasso groups; create sticky notes, rectangles, ellipses and ink strokes.
- Navigate pages, zoom/pan, and report visible Web connectivity messages.
- Verify writes after reload and keep operation receipts plus local before/after evidence for object edits.

Recognition is approximate. A background image cannot be edited as individual handwriting or text. There is no native `.goodnotes` backup decoder, permanent document deletion, sharing, iPad sync acknowledgement or transactional protection against another editor. Object selection uses visible bounding boxes, not stable backend object IDs.

This is an unofficial project, not affiliated with Goodnotes. It depends on the Web UI, not a supported Goodnotes editing API. UI changes can break it. No paid AI API key is used by the server; your MCP client still has its own usage costs.

## Install

Requires Node.js 22.13 or later, npm, installed Google Chrome (or Microsoft Edge), and a Goodnotes account with access to its Web documents. Windows is the development platform; macOS/Linux have not been tested live.

Download and extract the source archive from [Releases](https://github.com/hb442/goodnotes-web-mcp/releases), or clone this repository. Open a terminal in the extracted/cloned project directory, then run:

```sh
npm ci --ignore-scripts
npm run browser:install
npm run login
```

Sign in yourself in the separate Chrome window, then close all windows belonging to that separate profile. The login window is a normal browser launch **without automation or a debugging connection**. Your personal browser profile is not imported. Authentication challenges and two-factor prompts remain manual. On Windows, `setup.cmd` runs these installation steps.

To use installed Microsoft Edge instead, run `npm run login -- --browser msedge`. Browser selection is saved locally; the MCP server subsequently uses the same browser and dedicated profile. Switching browser brands creates a separate profile and requires a new sign-in. Bundled Chromium remains available via `--browser chromium`, but some identity providers may reject it. Google documents that software-controlled browsers can be refused during sign-in: [supported browser guidance](https://support.google.com/accounts/answer/7675428?hl=en).

```sh
npm run doctor
```

For the first write, duplicate a non-critical board in Goodnotes and give the copy a clear test title. Explicitly allow only the copy:

```sh
node src/cli.mjs allow "https://web.goodnotes.com/s/YOUR_DOCUMENT_ID" "MCP Test Board"
```

The URL and exact title are both checked. Restart the MCP server after changing permissions from the CLI. Existing documents are not writable by default. Documents explicitly created or duplicated by an MCP call are automatically authorized, and verified renames update that document's title binding. You can remove a permission using `node src/cli.mjs revoke "https://web.goodnotes.com/s/YOUR_DOCUMENT_ID"`.

## Connect an MCP client

Use a local **stdio** connection. Set `command` to your Node executable and use an absolute path to `src/server.mjs`. The server does not need a particular working directory.

```json
{
  "mcpServers": {
    "goodnotes-web": {
      "command": "node",
      "args": ["C:/path/to/goodnotes-web-mcp/src/server.mjs"]
    }
  }
}
```

Client configuration formats differ. See [example configuration](examples/mcp-client.json) and [Codex configuration](examples/codex.toml). A remote/cloud-only MCP client cannot launch this local program directly. Do not expose its stdio transport through an unauthenticated network bridge.

## A typical edit

1. Call `goodnotes_inspect` with the copied document's Web URL, or use `goodnotes_list` and `goodnotes_open`.
2. Call `goodnotes_preview` once to see the visible canvas.
3. Choose a point **inside the intended text field**, relative to the canvas rectangle returned by the preview. Use `x = (pixelX - canvas.x) / canvas.width` and the equivalent calculation for `y`.
4. Call `goodnotes_read_text`. Check that the returned text is the intended text. A blank result can mean an empty position; never infer that handwriting or an image has been read.
5. Call `goodnotes_write_text` with the returned `targetId`, complete replacement text, and a unique `operationId` such as `edit-20261109-001`.
6. If the call times out, use `goodnotes_operation_status` with the same ID. For `pending` or `uncertain`, inspect the document again. Do not retry with a new ID merely to bypass the block.

The next action receives structured results instead of screenshots of every click. [Compact mode](docs/COMPACT.md) reduces initial tool discovery; total model usage has not been measured.

For a complete new study board, use the [lecture-to-board workflow](docs/STUDY-BOARDS.md): review a local plan first, then build each native card with text, formatting and background together before its reload check. For individual edits to existing cards, use `goodnotes_edit_text` with a body `format` and heading `formatRanges`, then reuse its returned `viewId` for the next selection. See [a planned card](examples/planned-card.json) and [the planning workflow](docs/DEVELOPMENT.md#plan-edits-before-sending-them). Standalone background edits remain a separate verified operation. Measured copy comparisons and complete-board timings are documented in [validation](docs/VALIDATION.md).

## Tools

| Tool | Purpose |
| --- | --- |
| `goodnotes_prepare_study_board` | Duplicate the chosen lecture, export its copy, and begin a resumable source-to-board workflow. |
| `goodnotes_prepare_study_revision` | Prepare a selective revision from a completed managed workflow/revision, with a verified native copy or backup. |
| `goodnotes_prepare_board_adoption` | Make a content-verified native copy of an older board for selected-object adoption. |
| `goodnotes_capture_board_adoption` | Capture exact selected native text/style or image pixels/crop and source-page references without changing content. |
| `goodnotes_finish_board_adoption` | Verify up to three captured objects per call, prove the full copy unchanged, and freeze a managed manifest for revisions. |
| `goodnotes_board_adoption_status` | Read adopted object IDs, copy identity and verification progress. |
| `goodnotes_prepare_study_collection` | Copy/export a source lecture for several linked learning boards. |
| `goodnotes_plan_study_collection` | Split supplied materials by measured height/object limits; preserve figures, captions, source pages and section order. |
| `goodnotes_run_study_collection` | Execute one verified creation/block, with an overview and native previous/next links. |
| `goodnotes_study_collection_status` | Read compact progress, previews, links and independently revisable child workflows. |
| `goodnotes_review_study_collection` | Reconcile interrupted steps from evidence without replaying uncertain writes. |
| `goodnotes_plan_study_revision` | Freeze selected card updates, bounded moves and appended sections; preview layout and report source-page changes. |
| `goodnotes_run_study_revision` | Execute one guarded revision step, checking persisted content and visible surroundings. |
| `goodnotes_study_revision_status` | Read revision progress, backups, stable block IDs, source impact and optional saved text. |
| `goodnotes_review_study_revision` | Reconcile complete evidence or prepare a bounded fresh attempt after a proven no-write rejection; never replay uncertain writes. |
| `goodnotes_plan_study_board` | Measure source-based cards and original figure crops, reject overflow/overlap, and save a layout preview before writing. |
| `goodnotes_run_study_board` | Build native editable cards and original images in bounded verified steps; continue from saved receipts. |
| `goodnotes_study_board_status` | Read progress, output links, errors and measured workflow timings. |
| `goodnotes_review_study_board` | Independently check interrupted results without replaying uncertain writes. |
| `goodnotes_shape_style_info` | Read one native shape fill opacity and stroke thickness. |
| `goodnotes_set_shape_style` | Set prepared fill opacity/thickness with native readback and appearance checks after reload. |
| `goodnotes_status` | Check login and show local write permissions; navigates to the library. |
| `goodnotes_list` | List one folder, returning reusable item paths. |
| `goodnotes_open` | Open an item path from the list. |
| `goodnotes_inspect` | Prepare a view of a Web document URL. |
| `goodnotes_preview` | Return one JPEG of the current viewport. |
| `goodnotes_read_text` | Read the text field at a canvas-relative point. |
| `goodnotes_write_text` | Replace one previously read text field with conflict checking and reload verification. |
| `goodnotes_operation_status` | Read a local operation receipt, including after restart. |
| `goodnotes_export` | Export all pages to a private local PDF and text index. |
| `goodnotes_read_document` | Read a bounded page/text range, with continuation offsets and optional images. |
| `goodnotes_search_document` | Search all indexed pages and return excerpts. |
| `goodnotes_render_page` | Render one exported page as PNG. |
| `goodnotes_ocr` | Add approximate local OCR text to an export, 1–10 pages per call. |
| `goodnotes_create` | Create a folder, notebook or whiteboard. |
| `goodnotes_get_folder_style` | Read a folder's color, icon and favorite state, with optional choices. |
| `goodnotes_set_folder_style` | Change one authorized folder style with an expected-value guard. |
| `goodnotes_manage_document` | Duplicate, rename or move a document. |
| `goodnotes_set_document_favorite` | Set an authorized document's favorite flag with exact-title and expected-state guards. |
| `goodnotes_manage_folder` | Rename or move an authorized folder, preserving its identity and checking its direct children. |
| `goodnotes_edit_text` | Edit a range and body formatting; optionally apply up to 20 `formatRanges` to the final text in the same verified save. Returns a usable `viewId`. |
| `goodnotes_select_object` | Select an object or rectangular lasso group. |
| `goodnotes_transform_object` | Move, resize, duplicate or delete the guarded selection. |
| `goodnotes_create_object` | Add a sticky, rectangle, ellipse, triangle, diamond, rounded rectangle or ink strokes. |
| `goodnotes_read_handwriting` | Read native recognition without replacing ink. |
| `goodnotes_convert_handwriting` | Convert recognized ink into editable text. |
| `goodnotes_navigate` | Change page, zoom or scroll; return a new view handle. |
| `goodnotes_sync_status` | Report visible Web messages; never claims iPad delivery. |
| `goodnotes_refresh_index` / `goodnotes_search_library` | Resume recursive indexing; search local titles and content. |
| `goodnotes_plan_batch` / `goodnotes_run_batch` | Review and execute bounded, persistent batches. |
| `goodnotes_batch_status` / `goodnotes_skip_batch_step` | Inspect progress/receipts or explicitly skip reviewed work. |
| `goodnotes_list_outlines` / `goodnotes_manage_outline` | List native outline entries and rename/delete a guarded flat entry while preserving pages and other entries. |
| `goodnotes_list_pages` / `goodnotes_manage_pages` | Inspect native page order and apply guarded page commands. |
| `goodnotes_import_pdf` | Upload an explicitly supplied local PDF as a new notebook. |
| `goodnotes_find_objects` / `goodnotes_select_match` | Find visible text and verify an editable text/sticky target. |
| `goodnotes_plan_layout` | Save a text-identified object grid as a batch. |
| `goodnotes_create_text` / `goodnotes_insert_image` | Add editable text or a local PNG/JPEG. |
| `goodnotes_image_crop_info` / `goodnotes_crop_image` | Read a guarded native rectangle and crop an image, preserving original pixels privately and checking saved pixels/appearance. |
| `goodnotes_text_box_style_info` / `goodnotes_set_text_box_style` | Read and change box background/border colors, border width, round corners, padding and shadow while retaining text and character formatting. |
| `goodnotes_draw_connector` | Draw a line/arrow as editable ink, without automatic attachment to objects. |
| `goodnotes_object_colors` / `goodnotes_color_object` | Read native preset colors and apply a guarded selection color. |
| `goodnotes_combine_pdf` / `goodnotes_study_bundle` | Produce local PDF compilations and learning materials. |
| `goodnotes_batch_help` / `goodnotes_retry_rejected_step` | Load detailed schemas for selected batch actions; retry only a confirmed rejection before writing. |
| `goodnotes_scan_board` / `goodnotes_search_board_scan` / `goodnotes_select_board_match` | Resume a bounded board scan, search its OCR and reacquire an exact editable match. |
| `goodnotes_remember_object` / `goodnotes_recall_object` | Store a guarded visual location and find it again after pan/zoom or restart. |
| `goodnotes_create_snapshot` / `goodnotes_restore_snapshot` / `goodnotes_verify_restore` | Preserve a native copy plus PDF baseline, restore to a new copy, independently check a previous restore. |
| `goodnotes_compare_exports` | Compare cached PDF text, dimensions and optionally rendered page appearance. |
| `goodnotes_copy_native_selection` | Native copy of a guarded lasso selection, checked against source and saved appearance. |
| `goodnotes_copy_page` | Copy one native page to another notebook with source/destination order guards. |
| `goodnotes_copy_text_object` / `goodnotes_copy_image_object` / `goodnotes_verify_copied_object` | Copy one native text box/sticky or image, preserving text/format or source pixels/crop; independently verify a saved paste checkpoint. |
| `goodnotes_restore_page` / `goodnotes_verify_restored_page` | Recover an MCP-deleted page from Trash and verify original page identities/order and the pre-delete PDF baseline. |
| `goodnotes_move_native_object` / `goodnotes_verify_moved_object` | Copy a native board/notebook object to another document, verify it, remove the unchanged source and independently audit both ends. |
| `goodnotes_object_options` / `goodnotes_arrange_object` | Inspect native commands; send front/back, author visibility, lock or collapse actions when available. |
| `goodnotes_expand_sticky` | Expand an unchanged sticky from its saved MCP collapse checkpoint. |
| `goodnotes_prepare_unlock` / `goodnotes_unlock_object` / `goodnotes_unlock_sticky` | Prepare and unlock a native image, text box, sticky or shape with kind/text/appearance guards; the sticky-only entry remains compatible. |
| `goodnotes_board_settings` / `goodnotes_set_board_background` | Read and set native board pattern/color with expected-state checks. |
| `goodnotes_list_templates` / `goodnotes_set_template` | Read the active native paper/cover catalog; apply one template with PDF backup and reload verification. |
| `goodnotes_list_trash` / `goodnotes_trash_document` | Inspect native Trash or move one authorized document there with a PDF baseline. |
| `goodnotes_restore_document` / `goodnotes_verify_restored_document` | Recover a document using its MCP trash receipt or independently verify recovery. |

See [automation examples](docs/AUTOMATION.md) for index continuation, batch recovery and learning workflows.

View and text handles expire after ten minutes and are invalidated by navigation through the server. Only one server/login process can use a profile at a time. Calls within the server run sequentially. Reading an editable field can switch the Web editor between reading and editing modes; the server handles this through the visible toolbar controls.

Folder management has a separate exact path/title permission. Folders created by version 0.5 are authorized automatically; existing folders require the local `allow-folder` command. Folder permission permits organizing that folder, not editing the contents of its documents. Folder moves update separately authorized descendant paths. See [automation examples](docs/AUTOMATION.md#folder-organization).

## Local data

- Windows: `%LOCALAPPDATA%/goodnotes-web-mcp`
- Other platforms: `~/.local/share/goodnotes-web-mcp`
- Override: `GOODNOTES_MCP_HOME`

The folder contains the browser profile, permissions, lock, receipts, PDF snapshots/text indices, OCR language models, object-edit evidence, image crop checkpoints and original PNG pixels, catalog, batch plans and generated learning materials. Exports, plans and evidence contain private content in plaintext. **Do not share or commit this folder.** Ordinary operation receipts use hashes rather than note text; batch inputs deliberately retain the instructions needed to resume. Tool results still reach your MCP client and its model provider. Local OCR does not upload images. Explicit PDF/image import uploads the supplied file to Goodnotes. Export snapshots stay unchanged until explicitly refreshed.

## Tests and source package

```sh
npm run check
npm test
npm run test:integration
npm run package:release
```

Packaging includes an explicit list of source files, documentation, fixtures, and lockfile. It excludes browser profiles, local previews, credentials, dependencies, and personal document configuration. The package is created locally; nothing is uploaded or published.

Source available for personal, noncommercial use; this is not an OSI-approved open-source license. See [LICENSE](LICENSE) and [licensing examples and release history](docs/LICENSING.md). The historical v0.21.0 release was published under MIT; its existing permissions are unaffected. Third-party dependencies retain their own licenses. Goodnotes is a trademark of its respective owner.
