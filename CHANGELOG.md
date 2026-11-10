# Changelog

0.21.0 is the first public prerelease. Earlier entries describe local development milestones, not previous public releases.

## 0.21.0

- Add verified-copy adoption of explicitly selected native text boxes and images from older boards, including exact text/style/image/crop evidence and whole-copy preservation checks.
- Add automatic measured splitting of supplied study materials into linked parts and an overview, with durable frozen child workflows and verified native text links.
- Support horizontal positioning and bounded previews for adopted boards. Keep original image crops and native box styles during selective updates.
- Stage wide images fully inside the viewport before enlargement; use bounded measured drag corrections and reacquire the committed frame before validating placement.
- Expose nine additional actions (107 total); compact mode still uses three entry tools.
- See VALIDATION.md for measured live evidence and LIMITATIONS.md for unsupported features. This remains an unofficial experimental adapter.

## 0.20.0 - unreleased

- 185 automated tests passed. A copied Oligopol board completed selective updates and an appended section with original slide images; an unmanaged note and the original board were independently confirmed unchanged. See validation for the deliberately inspected development repair and limits.

- Add five selective managed-board revision actions (98 total), verified native copies/backups, stable block IDs, chosen card updates, bounded moves and appended sections.
- Preserve untouched objects. Recheck original target content, formatting, style, visible padding and appearance; reject occupied destinations and verify visible surroundings after writes.
- Support one to three layout columns, variable spans, named sections, compact packing, up to 24 cards and 12 original figures. Caption spacing follows each image's height.
- Keep immutable revision plans and durable progress; reconcile complete evidence only. Permit bounded fresh attempts only for receipts proving no input was sent, retaining all prior receipts.
- Report source text/page-position changes and affected references without claiming automatic factual or diagram-change verification.
- Rescan late-loading virtualized library rows before reporting a known item missing, with no repeated document mutation.

- Reacquire image selections against fresh baselines after insertion/placement; verify complete image aspect ratio, size and position to reject internal blue artwork mistaken for selection frames.

## 0.19.0 - unreleased

- 160 automated tests passed. Five complete copied-lecture boards built in 6:47–7:38 (median 7:13) with zero manual native-write repairs. End-to-end preparation and visual review took 10:36–14:43. See validation for methodology and limits.

- Add five lecture-to-board workflow actions (93 total): copy/export preparation, local layout planning, bounded execution, saved progress and independent interrupted-block review.
- Measure and wrap source-based cards before native writes; reject invalid source references, excessive card height and conflicting geometry. Extract original figures from the copied PDF and bind their pixels to the frozen plan.
- Create native editable text cards and image objects with reload verification; export the finished board for visual review. Keep source, execution evidence and stage timings in the private runtime directory.
- Preserve uncertain receipts and stop instead of replaying partial writes. Recovery requires matching independent evidence; layout plans cannot change after execution starts.
- Keep routine study progress replies compact, with full block evidence available on request. Completed status points to the actual exported board preview rather than only the planned rendering.

## 0.18.0 - unreleased

- 149 automated tests passed (90 core, 59 Chromium fixtures). A controlled four-card copy comparison completed in 7:47 instead of 13:57 (44.14% less time), with 39 instead of 73 MCP calls. See validation for scope, development failures and final color-path regressions.
- Plan body and heading formatting together with `formatRanges`; offsets refer to the final text, all ranges are validated before writing, and text/format persistence is checked after one reload. Supported by standalone edits and batch steps.
- Reuse document readiness only within the same native document load; a reload or navigation still requires fresh readiness checks.
- Keep board restoration wheel input integral to avoid switching between accelerated wheel and fractional trackpad behavior.
- Dismiss format menus at exposed hit-tested overlay points, with bounded dismissal-only reacquisition for nested menus. Never click through an overlapping formatting control.
- Insert text lines as literal input, preserving bullet/number prefixes instead of invoking automatic list shortcuts.
- Recover a missing native box-style menu once through a guarded read-only reload; compare unselected appearance so native selection handles do not produce false content conflicts. Refresh selection guards only after unchanged text, formatting and geometry are confirmed.
- Preserve a natively verified text-box kind when recalling a visual bookmark; apply newly created color swatches only if the native palette explicitly reports them unselected.
- Allow bounded read-only settling when native formatting renders after the palette state; do not resend color or toggle commands, and still reject a format that never appears.
- Commit and reacquire fresh text before color formatting; apply color before the other style popovers and reacquire its range afterward. This avoids applying only a future typing color or losing the following bold selection in a combined edit.
- Live timings and remaining limits are recorded in `docs/VALIDATION.md` after the controlled copy comparison.

## 0.17.0 - unreleased

- 88 MCP actions; 142 automated tests passed (89 core and 53 Chromium fixtures), plus a fresh stdio MCP regression against a separate learning-board copy.
- Native text selection uses the exposed frame only when two correctly aligned handles and one contained editor prove its geometry. This fixes pale text frames at small zoom without widening pixel thresholds for unrelated artwork; ambiguous, rotated and clipped frames remain rejected.
- Restore the native whiteboard camera after reload for text creation/replacement/formatting, image insertion and object creation/transforms. Adaptive measured wheel movement compensates for Goodnotes amplification/capping; document identity, exact text/formatting and visual persistence checks remain required.
- PDF export preserves the board camera, including after a read-only retry, so default batch backups do not silently change the coordinates of the next step.
- Missing whiteboard text-box style controls return `supported: false` after bounded read-only reacquisition. Batch style requests stop with `STYLE_UNSUPPORTED` and `mayHaveWritten: false` rather than being reported as successful.
- Document read/search automatically use bounded local OCR on pages without PDF text (default three pages per call), report pending/failed pages and reuse cached OCR, including blank results. This adds an approximate local search index; it does not modify the exported PDF or guarantee formula/handwriting accuracy.
- Low-confidence PDF OCR tries one bounded higher-resolution adaptive pass and retains the result with higher reported confidence. Results explicitly list low-confidence pages; cached results are not silently rerun. Pale-text regression coverage checks recovery from a blank first pass.

## 0.16.0 - unreleased

- 88 MCP actions, 134 automated tests (84 core and 50 Chromium fixtures).
- Native triangles, diamonds and rounded rectangles through the existing object creation and batch actions. Unique native toolbar choices, creation, commit and persisted appearance are checked.
- Shape locks retain a proven border point instead of guessing from padded selection bounds; missing point provenance is rejected before input.

## 0.15.0 - unreleased

- 88 MCP actions, 133 automated tests (83 core and 50 Chromium fixtures).
- Clear a native shape label with an exact empty replacement, preserving the shape; batch clear requires an explicit shape kind. Empty ordinary text/sticky replacements remain rejected.
- Replacement and rich-text edits also check native object kind before input and after reload, rejecting a same-text object of a different kind.
- Hosted CI is configured for Windows/Ubuntu and Node 22/24; this matrix has not been executed on GitHub. Setup instructions state the minimum Node 22.13 version.

## 0.14.0 - unreleased

- 88 MCP actions, 131 automated tests (83 core and 48 Chromium fixtures).
- Native shape position/size locks and guarded unlock, including batch steps. Unfilled shapes are targeted on their border.
- Lock/unlock appearance verification uses bounded read-only checks and excludes the observed floating zoom control; missing saves still stop with uncertainty.

## 0.13.0 - unreleased

- 88 MCP actions, 129 automated tests (82 core and 47 Chromium fixtures).
- Native shape labels through explicit shape targets in the existing text read, exact replacement and rich-text editing actions. Selection requires the native shape control; unfilled shapes use a border point.
- Shape labels in replacement and range-edit batch steps, with exact text and kind guards. Native text is committed on its actual page and checked after reload.
- Creation verification tolerates bounded delayed page painting without redrawing; missing native selection menus use bounded selection-only reacquisition.
- Existing text-box/sticky behavior and legacy rich-text hashes remain compatible.

## 0.12.0 - unreleased

- 88 MCP actions, 125 automated tests (80 core and 45 Chromium fixtures).
- Native clipboard copying for guarded rectangular lasso selections, including shapes and ink. Captured source appearance and saved destination appearance are verified separately; exact text and image copy tools retain their stronger type-specific checks.
- Persistent visual-copy checkpoints and read-only reconciliation without another paste; source hashes detect changed checkpoint files. Bounded rendering waits and destination-size/page guards stop unsafe or unconfirmed operations.
- Batch support for copying a lasso region, with typed destination references.

## 0.11.0 - unreleased

- 87 MCP actions, 119 automated tests (76 core and 44 Chromium fixtures).
- Native shape fill opacity in 10-percent steps and conservative stroke thickness, with guarded preparation, exact native readback, page-coordinate mapping and visual verification after reload. Existing color and geometry remain unchanged.
- Shape-style batch steps use the default PDF backup and stop on uncertain writes; native palette closure never causes switch input to be repeated.

## 0.10.0 - unreleased

- 85 MCP actions, 116 automated tests (74 core and 42 Chromium fixtures).

- Native outline listing and guarded rename/delete, with stable entry/page identities, metadata checkpoints and reload checks. Flat rows only; unsupported hierarchy controls are rejected.
- Chained list/rename/delete-outline batch steps pass only verified, typed outline/page hashes.
- Page writes enter the native edit mode when available; page listing restores the normal sidebar tab before waiting for thumbnails.


## 0.9.0 - unreleased

- 111 automated tests (73 core and 38 Chromium fixtures); 83 actions remain available through full or compact MCP discovery.

- Notebook sticky commits now click inside the native page, with bounded selection-only waits for delayed note loading. `read_text` accepts an optional native object-kind guard.

- Notebook bookmarks retain a private PNG checkpoint with integrity checks and bounded rendering tolerance. Moves recheck exact native source text/formatting or image pixels/crop immediately before deletion.
- Saved visual object bookmarks and native cross-document moves now support notebook pages as sources. Native page identity, dimensions, zoom, appearance and selected bounds must match before deleting the original. Board scanning remains explicitly bounded to whiteboards.

## 0.8.0 — unreleased

- Guarded native text/sticky/image moves from whiteboards to another document: source PDF backup and visual bookmark, verified copy, unchanged-source reacquisition, source deletion and independent checks of both ends. Checkpoints expose partial completion; this is not an atomic move.
- `move-native-object` batches and a read-only move audit that never repeats paste/deletion or relabels receipts.
- Saved scan/object targets resolve the internal page URL before checking document/page identity. Visual bookmark recall additionally rejects changed native selection bounds.

## 0.7.0 — unreleased

- 81 actions and 99 passing automated tests, with native copy/recovery/deletion checks through compact stdio.
- Native image copy between documents, with source-pixel/crop conflict guards and saved-pixel/crop/appearance checks after reload. Existing paste reconciliation now supports images too.
- `copy-image-object` batch action with typed destination references.
- Page deletion now saves a private PDF and native identity/order checkpoint before sending input. Guarded page recovery checks unchanged remaining pages, restores the exact native page and verifies the complete original PDF baseline and order. A separate audit preserves uncertain receipts.
- `restore-page` batch action accepts a typed deletion-operation reference.
- Object deletion compares unselected content before/after input and checks the result again after reload, rejecting no-op clicks and lost persistence.

## 0.6.0 — unreleased

- 78 actions, 92 automated tests, real compact-stdio coverage and automated version/syntax/discovery consistency checks.
- Optional compact MCP mode with three entry tools, on-demand action schemas, strict parameter validation and separate read/write routing. Existing full-mode tools remain available.
- Native document favorites with exact-title, write-permission and expected-state guards, including batches.
- Rectangular image crop preparation, source-pixel checkpoints, native handle mapping and cropped-pixel/appearance verification after reload. Goodnotes can replace the source with the cropped raster.
- Native text-box background/border colors, corner radius, border width, padding and shadow, with exact text/format preservation and native state/appearance reload checks.
- `crop-image` and `text-box-style` batch actions with existing backup, conflict and uncertain-write handling.
- Native text-box/image position locks, kind-specific unlock preparation and a general unlock action, while preserving the sticky-only entry. Batch `unlock-object` complements the existing `arrange-object` lock command.

## 0.5.0 — unreleased

- 72 MCP tools; 82 automated tests and expanded real-stdio coverage on synthetic documents.

- Separate path/title permissions for folder organization, with automatic authorization for newly created folders and local CLI grant/revoke commands.
- Native folder rename/move with structural manifests, parent/identity/direct-child checks, cycle/depth guards and descendant permission updates.
- Chained `folder-rename` and `folder-move` batch actions with typed output references.
- Multi-selection native front/back labels and preservation of the lasso region during layer verification.
- Native folder color/icon/favorite inspection and guarded updates, including a `folder-style` batch action.
- Whole-field text highlighting and clearing, with native `data-highlight` reads, exact text/style reload checks and mixed-run conflict detection.
- Denser native connector input and separate arrowhead strokes; pencil, fountain, brush and a diagonal ball-pen arrow verified live.

## 0.4.0 — unreleased

- 69 MCP tools; compact batch discovery with on-demand detailed action schemas.
- Strict typed references between verified batch steps, frozen inputs, restart recovery and explicit retry only after confirmed rejection before writing.
- Scroll-aware collection of virtualized libraries/pages; resumable bounded board scans and guarded object locations across pan/zoom.
- Native cross-notebook page copy and single text/sticky copy with editable text/style/kind checks, mapped page geometry and independent paste reconciliation.
- Native snapshot copies with PDF content baselines, restore into a new copy, cached export comparisons and independent restore audits.
- Native board backgrounds, paper/cover templates, page bookmarks and guarded document Trash/recovery with PDF baselines.
- Custom text/selection colors, strike, flat bullet/ordered lists and native pen/highlighter settings including thickness.
- Native front/back, sticky author visibility, collapse/expansion checkpoints and position lock/unlock controls.
- Hardened notebook positioning after reload, readonly sticky text reads, duplicate template catalogs, hidden BODY scroll and transient renderer/menu state.
- Expanded synthetic browser and safety tests. See `docs/VALIDATION.md` for measured live coverage and remaining gaps.

## 0.3.0 — unreleased

- Persistent recursive library catalog, bounded refresh jobs, title/content search and honest snapshot freshness.
- Validated batch plans, PDF snapshots, progress, restart recovery and explicit handling of uncertain writes.
- PDF import and native page identity/order checks for add, duplicate, reorder, rotate, outline and trash.
- Local OCR text-location discovery, verified text object selection and planned grid placement.
- Editable text creation, PNG/JPEG insertion, text alignment/links and ink lines/arrows.
- Native selection color palettes, unchanged-blue-artwork masking and full connector-path verification.
- Ordered PDF page compilation and local learning bundles with tasks, source references and Anki TSV.
- Additional tests for resumed indexing, cache invalidation, batch crash recovery and output content.

## 0.2.0 — unreleased

- Full-document PDF exports, indexed text, bounded page reads, search and page rendering.
- Local English/German OCR with bundled models; native handwriting recognition and explicit conversion.
- Folder, notebook and whiteboard creation; duplicate, rename and move documents.
- Character-range edits and bold/italic/underline/font-size formatting with reload verification.
- Guarded object/group selection, move/resize/duplicate/delete and new sticky/shape/ink creation.
- Page/zoom/pan navigation and honest Web-only synchronization diagnostics.
- Local evidence images, private export cache, expanded protocol/PDF/OCR/browser tests.
- Handle transient UUID routes and formatting popovers before verifying a save.
- Native sticky editing uses its explicit Edit Text command and a two-stage commit; equivalent text-node splits no longer cause false formatting conflicts.
- Visual checks tolerate the Web renderer's antialiasing while rejecting missing strokes and color changes; object movement reports native snapping adjustments.

## 0.1.0 — unreleased

- Local stdio MCP server with an isolated Goodnotes Web browser profile.
- Explicit write allowlist tied to URL and exact title.
- On-demand preview and guarded typed-text replacement.
- Reload/read verification and operation receipts.
- Core, MCP protocol and local Chromium fixture tests.
- Live stdio MCP test on a duplicated board: existing text read, Unicode/multiline replacement, page reload and exact text verification succeeded on 2026-11-09. No public release yet.
- Manual sign-in now launches installed Chrome/Edge without automation; the server reuses only that dedicated profile after sign-in. This avoids relying on Google sign-in inside an automated test browser.
- Wait for initial document loading before capturing the canvas; ignore app-launch banners that have moved off-screen.
- Handle the editor's reading mode based on actual toolbar visibility, including after reload.
- Wait for library cards before opening them; close the isolated browser and release its lock when the MCP client disconnects.
