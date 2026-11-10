# Development

## Layout

- `src/server.mjs`: MCP transport, schemas, tool definitions and serialized calls.
- `src/compact.mjs`: optional on-demand discovery and strict routing to the same registered actions.
- `src/adapter.mjs`: Goodnotes Web UI actions and verification.
- `src/library.mjs`: folder/document creation, rename, duplication and move.
- `src/folders.mjs`: separate folder permissions, structural manifests and guarded folder rename/move.
- `src/folder-style.mjs`: native folder color/icon/favorite reads and guarded updates.
- `src/documents.mjs`, `src/pdf.mjs`, `src/ocr.mjs`: private PDF snapshots, indexing, rendering and local OCR.
- `src/text.mjs`: rich text reads, range selection, targeted edits and formatting.
- `src/text-box-style.mjs`, `src/image-crop.mjs`: native box styling and rectangle cropping with source-pixel and reload verification.
- `src/objects.mjs`, `src/visual.mjs`: native handwriting and guarded canvas object actions.
- `src/object-move.mjs`: checkpointed native copy-then-delete moves from whiteboards and independent audits of both ends.
- `src/mutations.mjs`: shared journal/error handling for new write operations.
- `src/session.mjs`: isolated Chromium profile and login.
- `src/browser.mjs`: installed browser discovery and ordinary manual sign-in launch.
- `src/config.mjs`: data paths, URL validation and write permissions.
- `src/lock.mjs`: exclusive profile use.
- `src/journal.mjs`: operation fingerprints and receipts without note text.
- `src/catalog.mjs`, `src/store.mjs`: persistent catalog and atomic local state files.
- `src/jobs.mjs`: strict batch schemas, checkpointing and recovery from operation receipts.
- `src/job-schema.mjs`: strict step types, typed references and on-demand batch help.
- `src/scroll-list.mjs`: bounded, scroll-aware collection of virtualized DOM lists.
- `src/board-scan.mjs`: resumable multi-viewport OCR and guarded object locations.
- `src/recovery.mjs`, `src/trash.mjs`: native copies, PDF baselines, read-only audits and guarded Trash recovery.
- `src/layout.mjs`: native board backgrounds and page paper/cover templates.
- `src/rich-text.mjs`, `src/ink-style.mjs`, `src/styles.mjs`: flat lists, native pen settings, palettes, layer/author/collapse/lock controls.
- `src/page-frame.mjs`: page-identity geometry mapping across zoom and pan for native paste verification.
- `src/pages.mjs`: PDF import and stable native page identity/order verification.
- `src/page-recovery.mjs`: pre-delete page checkpoints, remaining-page PDF comparison and guarded native recovery.
- `src/board.mjs`, `src/images.mjs`: OCR-based editable-text discovery, planned layout, connectors and image insertion.
- `src/workflows.mjs`: local PDF compilation and study bundle exports.
- `test/`: core, MCP protocol and browser fixture tests.

## Run checks

```sh
npm ci --ignore-scripts
npm run browser:install
npm run check
npm run format:check
npm test
npm run test:integration
```

Browser tests intercept all Goodnotes URLs and serve a local fixture. They require no account and never touch a real library. Use a separate profile and a duplicated, synthetic document for any live test. Never put credentials or private document URLs in source files.

`npm run check` parses every source/script/test module, checks package/server/lockfile version agreement, and exercises real full and compact MCP discovery. It also verifies that every advertised full-mode action is documented. Discovery byte counts measure the JSON schemas only, not overall model token usage.

## Live smoke test

### Plan edits before sending them

Prepare the final text, positions, body format, heading ranges and box styles before editing. `goodnotes_edit_text.formatRanges` uses nonoverlapping UTF-16 ranges in the final text, after replacement; each range overrides the body format. For a heading, use `start: 0`, `end: text.indexOf('\n')` and the heading's format. Up to 20 ranges share one save and reload verification. Reuse the returned `viewId` for a following object selection rather than inspecting the same document again. Existing exact-content guards and operation receipts still apply. Background styling remains a separate verified operation.

See `examples/planned-card.json` for a complete two-step card plan. Replace its synthetic URL, point and exact original text with a verified read before using `goodnotes_plan_batch`; execute bounded steps through `goodnotes_run_batch`. Planning alone does not edit the document.

Do not remove persistence checks for speed. A timed-out write is uncertain: read back the saved text and its format before continuing, never replay it automatically. Use integral native wheel inputs when restoring whiteboards; fractional wheel events can be classified as trackpad gestures with a different gain. Ready-document caching is tied to native `performance.timeOrigin` and the full page URL, so same-URL reloads cannot reuse stale readiness.

Combined text-color edits need a fresh native selection context: commit and reacquire replaced text before opening the color palette, apply color before other style popovers, and reselect the range afterward. Native palette state alone does not prove the text was colored. Exact rich-text readback and final reload verification remain mandatory; bounded read-only rendering waits must never resend a color command.

After login, `node scripts/smoke.mjs inspect "<test document URL>"` connects through the real stdio transport, lists available tools, opens the document, and stores a preview under ignored `.local/`. It does not write note text.

To test an edit, first examine that preview and identify a typed text box. Prepare a local JSON file containing the test URL, relative `x`/`y`, exact expected text, replacement text and unique operation ID, following `examples/live-edit.json`. Keep it under `.local/`. Then run `node scripts/smoke.mjs edit .local/live-edit.json`.

The script verifies the expected text before calling the write tool. It saves compact evidence and a final preview locally. It never authorizes a document on its own. Successful reload verification still does not prove remote synchronization.

## Release preparation

The optional GitHub Actions matrix is provided as `docs/github-actions-ci.yml`. It is not active in the public repository: the publishing credentials lacked GitHub's workflow permission. A repository owner can install this reviewed template at `.github/workflows/ci.yml` after granting that permission. Local checks are reported separately; no hosted Windows/Linux matrix result is claimed.

`npm run package:release` uses an explicit source allowlist and creates a tar.gz archive plus SHA-256 checksum under `dist/`. It rejects symbolic links. `tar` must be installed (included in current Windows releases and common Unix systems).

Before publishing, run all checks, repeat the live test on a synthetic board, inspect the archive contents, replace any remaining pending verification statements with measured evidence, and confirm compatibility for the documented platforms. Do not copy `.local/`, a browser profile or personal config into the repository.

Keep `private: true` in `package.json` until an npm release is intentionally prepared. GitHub publication is separate from creating a local archive.

## New automation boundaries

All live UI work is serialized. Index refresh and batch execution default to one step per call so clients can checkpoint rather than hold a long request open. Batch inputs are strict discriminated schemas; add a handler and validation together. Preserve page fragments in content-operation URLs. Never auto-retry a dispatched mutation without checking its receipt. Private plans store note text by design; public fixtures must remain synthetic.

Use the real Web DOM selectors, not hidden application stores. Page IDs are read from sidebar DOM attributes and cross-checked after reload; they are not undocumented backend endpoints. Thumbnail canvases use fixed sizing, so rotation needs actual exported page dimensions. OCR positions are candidates: a text read must confirm them before exposing a writable object target.

PDF compilation uses [pdf-lib copyPages](https://pdf-lib.js.org/docs/api/classes/pdfdocument#copypages). OCR layout uses the [Tesseract.js structured blocks output](https://github.com/naptha/tesseract.js/blob/master/docs/api.md). These dependencies are pinned in the lockfile.

`src/outlines.mjs` reads native outline rows, saves metadata checkpoints and verifies guarded rename/delete. `PageController.editMode` enters native editing without overriding a disabled control; sidebar opening normalizes the remembered tab before waiting for pages.
