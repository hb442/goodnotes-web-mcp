# Repeatable workflows (0.10)

## Search a library once, reuse its snapshots

Call `goodnotes_refresh_index` with the desired `folderPath` (empty means the library root). The default performs one folder or document step. Repeat with the returned `jobId` until status is `completed` or `completed-with-gaps`. Review errors and incomplete folders. Interrupted read steps are safe to resume; already persisted work remains available.

Use `goodnotes_search_library` for title and content searches. Results include the snapshot timestamp, page excerpts, missing-text indicators and pagination. Empty query lists known items. Reading results by `exportId` requires no browser. Set `ocr: true` on a new refresh to queue local recognition for pages containing fewer than 30 extracted characters; each page is a separately resumable step. OCR can also be added explicitly with `goodnotes_ocr` to any export. Pages with a partial text layer can still need explicit OCR or visual inspection.

Incremental refresh compares visible library date hints and uses a configurable maximum snapshot age (24 hours by default). Known MCP edits invalidate matching catalog entries. Goodnotes does not expose a trustworthy content revision through these controls: a reused snapshot can miss an edit from another device. Set `force: true` on a new refresh for current exports. A folder scan covers the cards exposed by the Web UI; truncated folders and depth limits are reported, not silently declared complete.

## Batches and recovery

`goodnotes_plan_batch` stores an explicit array of supported steps. Planning never edits cloud notes. Example structure (replace the synthetic IDs with returned item paths):

```json
{
  "title": "Organize lecture copies",
  "backup": true,
  "steps": [
    {"action": "rename", "itemPath": ["00000000-0000-4000-8000-000000000001"], "title": "Lecture 01"},
    {"action": "export", "url": "https://web.goodnotes.com/s/SyntheticDocument123"}
  ]
}
```

Call `goodnotes_batch_help` for one to three actions to obtain their full schemas. The compact discovery schema keeps every action's detail out of every tool-list response; the server still strictly validates all steps before execution. Supported steps include library operations, page operations/copy, text/object edits, drawing, snapshots/restore-copy, PDF compilation, study bundles, board backgrounds, templates, document trash/recovery and sticky collapse/expansion. Unsupported fields are rejected. Use exact expected text for replacements and expected page count/order hash for page mutations.

Later steps may explicitly use a previous verified result: `{"fromStep":0,"field":"url"}` or `{"fromStep":0,"field":"itemPath"}`. Only named output fields are supported, with type checks and earlier-step references. Resolved inputs are frozen before execution and persisted across restarts. Forward references, expressions and arbitrary code are rejected. A typical chain creates a folder, creates a board using the returned folder path, adds text using the returned board URL, then exports that board.

Call `goodnotes_run_batch` with `jobId`. It runs one step by default and persists its outcome. Repeated calls resume outstanding steps. `goodnotes_batch_status` works after restart and reports saved backups and receipts. A verified operation is recovered from its journal without being sent again. Pending or uncertain writes halt the batch. Inspect their actual outcome; `goodnotes_skip_batch_step` can then explicitly skip that step with a reason. It does not undo anything. There is no automatic rollback or blind retry.

`goodnotes_retry_rejected_step` creates a new attempt only when the saved operation is explicitly `rejected` with `mayHaveWritten: false`. It preserves the old receipt. It refuses pending, uncertain, missing or partially written operations. Read-only verification tools for copies/restores can inspect an uncertain result without repeating a paste or restore or rewriting its old receipt.

Before destructive batch steps, PDF snapshots are saved by default. These retain visible content but are not lossless native backups. For editable preservation, explicitly duplicate the whole source document first and work on the returned copy. Plans and inputs contain private text and live only in the private data directory. Do not publish them.

## Pages and materials

`goodnotes_list_pages` returns native page identities, count and `orderHash`. Pass count and hash to `goodnotes_manage_pages`. The move destination is the final one-based position. Add-before/add-after reuse the current template. Delete moves one page to Goodnotes trash; it never empties trash. The server refuses the last-page deletion and incomplete page lists. Outline commands create one titled entry. Rotation verification compares the exported PDF page dimensions before and after rotation; square pages are refused.

`goodnotes_import_pdf` uploads an absolute local PDF path as a new notebook. New imports are authorized for editing. `goodnotes_combine_pdf` accepts existing export IDs plus optional ordered page lists and returns a new local PDF. It can extract, concatenate or reorder pages across exports. Import the result explicitly to create a notebook. This PDF route does not retain native ink objects, interactive form guarantees, cross-document links or all outline information.

For a native copy, use `goodnotes_copy_page` with a source page/order hash, the destination item path/page, placement, and destination count/order hash. The tool uses Goodnotes Copy/Paste, verifies one new page, unchanged source identity/order, and exported content/appearance. It leaves the source page in place. There is no atomic cross-document move; do not delete the source until the copy has been verified and deletion is intended. Bookmark/unbookmark are also supported page commands.

## Boards by content

`goodnotes_find_objects` runs local OCR on the current viewport and returns compact text locations. `goodnotes_select_match` checks that region again and reads the actual editable field. It rejects mismatching text or a PDF/background hit. Selection results work with the existing text and object tools. Use exact `expectedText` when available. It does not enumerate every drawing/image or detect hidden objects.

`goodnotes_plan_layout` creates move-object batch steps from unique text queries and grid centers. Choose enough spacing for the actual object sizes. It does not pack shapes, resize objects, scroll automatically or guarantee no overlap. Each step reacquires the text target and verifies its movement. `goodnotes_draw_connector` adds ink strokes; arrows do not follow objects after later movement.

`goodnotes_scan_board` scans a chosen grid of viewports, at most three new tiles per call. Resume with its `scanId`. Search the saved OCR with `goodnotes_search_board_scan`, then reacquire with `goodnotes_select_board_match`. Completion applies to that bounded region, never the entire infinite board. `goodnotes_remember_object` saves a visual location; `goodnotes_recall_object` repositions across zoom/pan and checks its appearance. Notebook bookmarks also guard native page identity and dimensions and compare saved pixels with bounded rendering tolerance. These are guarded visual bookmarks, not backend object IDs. Batch targets can use scan/match IDs or an object bookmark instead of a current-viewport text query.

Use `goodnotes_copy_text_object` for one exact native text box or sticky. It confirms editable text/format/kind, uses native Copy/Paste across in-app navigation and verifies the pasted object after reload, including zoom changes. For one native image, first read `goodnotes_image_crop_info`, then call `goodnotes_copy_image_object` with its `sourceSha256` as `expectedSourceSha256` and its `region` as `expectedCrop`, plus source URL/target and destination path/page/point. Pixel identity and crop are checked before copying and after reload. Batch `copy-image-object` supports typed destination paths. Neither operation copies arbitrary ink/groups. `goodnotes_verify_copied_object` can check either saved paste checkpoint without pasting again.

`goodnotes_object_options` lists only the selected object's currently visible native commands. `goodnotes_arrange_object` supports front/back and available author/lock/collapse controls. Collapsing removes the normal selection; save the returned operation ID and expand with `goodnotes_expand_sticky`. Expansion requires the same page/zoom/view and unchanged saved region. To unlock a sticky, text box, image or shape, call `goodnotes_prepare_unlock` at a preview point with `kind: "sticky"`, `"text"`, `"image"` or `"shape"`, optionally checking exact text, then use its `unlockId` with `goodnotes_unlock_object`. `goodnotes_unlock_sticky` remains available for stickies only. Batch `unlock-object` takes URL, point, kind and optional exact text. Locks concern native position/size; do not infer a general access-control guarantee.

Text formatting additionally supports custom six-digit colors, strike and whole-field flat bullet/ordered/none lists. `format.highlight` applies a six-digit highlight color at the native 50% opacity, or `none` to clear it; this also requires the entire field. Reads preserve native highlight attributes, including nested formatted spans. Nested lists are rejected. `inkStyle` configures pen/pencil/highlighter, supported pen type, native thickness and color; the requested thickness must be reachable on the tool's slider. These preferences can affect later strokes. Some smoothed arrowheads fail strict path verification: inspect an uncertain result rather than drawing it again.

For one selected native text box, call `goodnotes_text_box_style_info`, then pass its `styleId` to `goodnotes_set_text_box_style`. `style` accepts `backgroundColor` and `borderColor` as six-digit hex or `none`; integer `roundCornerPt`/`paddingPt` from 0–30; `borderPt` from 0–12; and Boolean `shadow`. A native control may have a smaller range or different reachable steps. Exact text, character formatting, current box state and selection appearance are guarded; native settings and appearance are verified after reload. If Goodnotes exposes only a reduced toolbar, verification can reload once more, repeating every check without resending style changes. Batch `text-box-style` additionally requires `expectedText`.

For a selected image, read `goodnotes_image_crop_info`, then apply its `cropId` with `goodnotes_crop_image`. The rectangle uses fractions of the **current source preview**, with positive width/height wholly inside 0–1. Each side must remain at least 12 visible preview pixels. The native rectangle handles determine the actual pixel-rounded crop. Goodnotes may replace the underlying image with cropped pixels; opening the crop again cannot recover the removed area. Before applying, original PNG pixels and crop metadata are saved under private `image-checkpoints`. The saved pixel dimensions/content and canvas appearance are checked after reload. Reimporting a saved original is a separate explicit image insertion, not an automatic in-place rollback. Freehand cropping is not supported. Batch `crop-image` uses a guarded object target and enables the normal PDF backup.

## Moving native objects between documents

`goodnotes_move_native_object` supports one text box/sticky or image **from a whiteboard or notebook page** to another authorized document/page. Both source and destination must have write permission. Supply `sourceUrl`, a guarded `target`, destination path/page/point, and `content`: either `{ "kind": "text", "expectedText": "Exact field" }` or `{ "kind": "image", "expectedSourceSha256": "...", "expectedCrop": { ... } }` using current crop-info values. The batch action is `move-native-object`.

The operation saves a source PDF and visual location, verifies native Copy/Paste, reacquires the original only if its location, pixels and selected bounds still match, then deletes it with reload checks. It checks both ends again. Arbitrary ink/groups and moving within the same document are rejected; use ordinary transforms for movement within a document.

This is a sequence of operations, not a transaction. A failure after Copy can leave both objects. Error details and the private move checkpoint retain the copy/deletion operation IDs and last stage. Never repeat an uncertain move with a new ID. `goodnotes_verify_moved_object` audits only an existing move with verified copy and deletion receipts; it checks the source deletion region and destination native content without replaying either input or changing old receipts. Later edits to either region can intentionally invalidate this audit.

## Backgrounds, snapshots and Trash

Read `goodnotes_board_settings` before setting a pattern/color with its expected values. `goodnotes_list_templates` returns templates from the active native size/color filter; it is not the entire marketplace. `goodnotes_set_template` checks page order, saves a PDF backup, applies one native paper/cover choice, and compares its exported appearance across reload while retaining previous extracted text. Native ink editability and hidden metadata are not proven by a PDF comparison.

Create a native snapshot using `goodnotes_create_snapshot`. Keep the resulting library copy unchanged. The server records page identities and a rendered/text PDF baseline. `goodnotes_restore_snapshot` checks that baseline and creates a separate new copy; it never overwrites the original. `goodnotes_verify_restore` audits an existing restore independently. `goodnotes_compare_exports` compares cached PDF versions without opening live notes.

`goodnotes_trash_document` checks the exact authorized title/path, saves a PDF baseline and verifies the document ID in native Trash. `goodnotes_restore_document` requires that verified trash receipt and current authorization; it restores and checks the original folder, identity and PDF baseline. `goodnotes_verify_restored_document` only audits the result. Listing Trash is available, but arbitrary historical trash items, deleted folders and permanent emptying are not managed by this restore flow.

From 0.7, `goodnotes_manage_pages` with `command: "delete"` saves a private full-document PDF and native page order before deletion. Retain its `operationId`/`deleteOperationId`; call `goodnotes_restore_page` with that `deleteOperationId` and a new restore operation ID. It accepts a verified or uncertain deletion only when the original checkpoint matches, remaining page identities/order are unchanged, and their exported text and appearance match the corresponding original pages. It recovers the exact page from native Trash, restores its original position if necessary, and checks all original page identities/order and the full PDF baseline. Already restored pages are verified without repeating Recover. `goodnotes_verify_restored_page` performs only that final audit and never relabels the old deletion receipt. Batch `restore-page` can refer to the `operationId` of an earlier verified page-delete step. Historical deletions without this checkpoint and changed remaining pages are deliberately refused.

## Folder organization

Library cards expose document/folder `favorite` flags when their native controls are present; otherwise the value is `null`. `goodnotes_set_document_favorite` requires the document's `itemPath`, exact `expectedTitle`, Boolean `expectedFavorite`, desired `favorite` and an operation ID. The document must be authorized for writes. It verifies identity/title/state after reload. Batch action `favorite-document` supports the same fields and typed item-path references.

`goodnotes_get_folder_style` reads native color, icon and favorite state; `includeChoices: true` also returns available presets and icon names. `goodnotes_set_folder_style` changes exactly one property, with `expectedValue` taken from the read. Colors use six-digit hex, icons use returned names (including `none`), and favorites use booleans. The operation checks all three settings after reload. The matching batch action is `folder-style`.

`goodnotes_manage_folder` supports `rename` and `move`, using the exact `itemPath` and `expectedTitle`. Newly created folders are authorized automatically from 0.5 onward. Existing folders require a local permission, independently of document permissions:

```sh
node src/cli.mjs allow-folder '["00000000-0000-4000-8000-000000000001"]' "Exact folder title"
node src/cli.mjs revoke-folder '["00000000-0000-4000-8000-000000000001"]'
```

Replace the JSON array with the folder's returned item path, including ancestors. The command binds both path and exact title. It does not authorize editing any document's contents. Folder permissions are checked from disk on each operation; independently authorized child folders retain their own permissions.

The server saves a private structural manifest before renaming/moving, checks the reloaded parent/title/identity and exact direct child identities/titles afterward, and updates known descendant permission paths. This manifest is not a backup of nested document contents. Self/descendant moves and ambiguous destination names are rejected. Refresh the library index after reorganizing folders. Batches support `folder-rename` and `folder-move`, including typed `itemPath` references.

## Learning workflow

Import or locate documents, index/export them, then read their text and relevant page images. The calling assistant writes a grounded summary, tasks and question/answer cards. Pass those to `goodnotes_study_bundle` with the source export ID and optional page references. It writes a text file, structured JSON and escaped HTML-compatible TSV. It does not call another AI, check factual accuracy, send tasks elsewhere or import into Anki. Review content before importing into a learning app.

## Native outline entries

`goodnotes_list_outlines` returns native entry IDs, exact titles, page numbers/page IDs, `outlineHash` and `pageOrderHash`. Use `offset`/`limit` for pagination and check `scanComplete`. `goodnotes_manage_outline` renames or deletes one flat entry with its exact `outlineId`, `expectedTitle`, `expectedOutlineHash` and `expectedPageOrderHash`; rename also needs `title`. Unsupported hierarchy controls and incomplete lists are rejected. The private checkpoint saves outline metadata, not a lossless document backup or automatic rollback. Other exposed entries and page order must remain unchanged after reload.

Batches support `list-outlines`, `rename-outline` and `delete-outline`. Later hash fields can reference `outlineHash` and `pageOrderHash` of an earlier verified list/edit step. Default batch backups also save a PDF before outline rename/delete. Each edit remains separately verified and journaled; an uncertain step stops the batch.

## Native shape appearance

Select one shape using a point on its border (unfilled centers may not select). Call `goodnotes_shape_style_info`, then `goodnotes_set_shape_style` with its `styleId` and, for example, `style: {"fillOpacityPercent": 40, "thicknessMm": 1.2}`. Fill uses the current native color in steps of 10 percent; zero disables fill. `shape-style` is also available as a batch step with a `target` and `style`; a visual object bookmark can identify the target while unchanged. Each write checks current appearance and values, then checks again after reload. This does not edit vertices, patterns or independent border/fill colors.

## Native lasso copies

Use `goodnotes_select_object` with a rectangular `region`, inspect the selection, then call `goodnotes_copy_native_selection` with its `selectionId`, a destination path/page, and a central paste point. The whole source selection must stay on one native page and fit the visible destination. The `copy-native-selection` batch action accepts `url`, `region`, `destinationPath`, `destinationPage`, `x` and `y`.

This uses Goodnotes native Copy/Paste. It compares the source rendering to the pasted result and verifies that result again after reload. The saved checkpoint can be audited with `goodnotes_verify_copied_object` without repeating paste. Matching appearance is not a check of exact text, every native property or hidden objects; prefer the specific text/image copy tools when those checks matter. Different paper backgrounds, overlapping destination artwork or offscreen groups can prevent verification. An uncertain receipt stops a batch and must not be bypassed with a fresh operation ID.


## Native shape labels

Use `goodnotes_read_text` with `expectedKind: "shape"` and a point on the shape border (an unfilled center is not a reliable selection). The native shape control must be present before opening Edit Text. The returned target supports `goodnotes_write_text` and `goodnotes_edit_text`, including an initially empty label. To clear only the native label, use `goodnotes_write_text` with `text: ""`; the shape remains. Ordinary text boxes/stickies and whitespace-only replacements cannot use this path. Save verification reopens the native shape editor after reload. Full replacement can change mixed formatting; prefer range edits for local corrections. Shape label targets are not accepted by the dedicated text/sticky copy tool; use a guarded lasso with `goodnotes_copy_native_selection` to copy the whole shape.

Batch `replace-text` accepts `expectedKind: "shape"` beside its x/y and expectedText; `text: ""` clears the label, and planning rejects empty replacements without that explicit kind. Batch `edit-text` accepts `target: {x, y, expectedKind: "shape"}` plus its required exact expectedText, range and format/replacement. Kind-bound targets require coordinates; OCR query and bookmark modes do not automatically infer native shape labels.


## Native shape position locks

Select a shape on its actual border (selection-frame padding is not the contour), inspect `goodnotes_object_options`, then call `goodnotes_arrange_object` with `command: "lock"`. A verified lock returns an unlock handle. The selection retains that proven border point for post-reload verification; if no point is available, locking stops before input and asks for a fresh point selection. After navigation or a new process, use `goodnotes_prepare_unlock` with `kind: "shape"` at a point on the border, then `goodnotes_unlock_object`. The exact native control, unchanged visible contents and saved native state are checked. This is a position/size lock, not an access-control permission. Batch steps use `arrange-object` with a point target and `unlock-object` with kind shape and the same border point.


## Additional native shapes

`goodnotes_create_object` and batch `create-object` support `triangle`, `diamond` and `rounded-rectangle` in addition to rectangle and ellipse. Each uses an observed native shape button, with unique-selector checking before drawing, native overlay commit, and unselected appearance verification after reload. These are actual Goodnotes shapes, not imported images. Choose a fully visible empty region and keep the native object within the page.
