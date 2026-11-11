# Action reference

[Project home](../README.md) · [Setup](SETUP.md) · [Action reference](TOOLS.md) · [Deutsch](DE.md)

The full mode exposes **107 actions**. Optional [compact mode](COMPACT.md) discovers the same actions through three entry tools.

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

See [automation examples](AUTOMATION.md) for index continuation, batch recovery and learning workflows.

View and text handles expire after ten minutes and are invalidated by navigation through the server. Only one server/login process can use a profile at a time. Calls within the server run sequentially. Reading an editable field can switch the Web editor between reading and editing modes; the server handles this through the visible toolbar controls.

Folder management has a separate exact path/title permission. Folders created by version 0.5 are authorized automatically; existing folders require the local `allow-folder` command. Folder permission permits organizing that folder, not editing the contents of its documents. Folder moves update separately authorized descendant paths. See [automation examples](AUTOMATION.md#folder-organization).
