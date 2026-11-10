# Validation

## Version 0.21.0 - November 10, 2026

Hosted CI is not enabled: the existing publishing credentials lack GitHub workflow permission. The optional Windows/Ubuntu and Node 22/24 matrix is supplied in `docs/github-actions-ci.yml`; the results below are local Windows/Node 24 results.

### Selected-object adoption and revision

An older Oligopol board was duplicated natively. One existing text box and one original slide image were explicitly adopted, with exact text/character formatting/box style, image pixels/crop and geometry checks. A final complete exported-PDF comparison confirmed that adoption itself left the copy unchanged. This demonstrates selected-object adoption, not exhaustive discovery of the board.

A fresh copy of that adopted board then completed one shortened text-card update, one 16 px image move and the final native export/audit, with all three steps verified and no manual write repair or reconciliation. The existing older original was independently re-exported and compared unchanged. The final actual board was visually inspected; other diagrams and learning cards remained present.

The revision took **4:24** from preparation through completion, or **4:34** including the final separate original-preservation check. Its two change steps plus audit took **3:01**; native duplication took another **0:55**. Initial older-board discovery and adoption are separate preparation work and are not included in these revision timings. This two-object update is a different workload from a nine-object full-board build and does not establish a universal seven-minute bound.

An earlier development copy stopped before moving an image because its normalized first row placed its top at 128 px, while native moves require at least 130 px clearance. Adopted boards now position that row at 148 px. The rejected/no-write receipt was preserved, a regression test covers the camera boundary, and the successful measurement above used a new copy rather than repairing the failed run.

### Collection development failures

Earlier collection attempts exposed two wide-image issues: a centered small import could grow beyond the viewport, and the placement guard incorrectly treated an eight-pixel sizing inset as a forbidden strip inside the planned slot. This could reject a correctly proportioned 926 px frame inside a 929.9 px slot. The final writer stages both sizes inside the viewport, measures the active drag, and reacquires the committed selection for at most three bounded corrections. The guard now accepts the reserved slot with integer rounding, retains its lower size limit and rejects oversized, undersized, shifted and distorted frames. Exact source pixels/crop, persisted appearance and final non-overlap checks remain required. Images are not re-imported and uncertain operations are not replayed. An isolated wide-image pilot passed all checks after reload before the final slot-guard correction; complete-run evidence is reported separately.

Another complete-run attempt stopped after creating an overview because the subsequent library read did not expose a visible row within 15 seconds. Its uncertain receipt was retained; that creation was not repeated. Library readiness now excludes hidden stale rows and allows a bounded 45-second read-only wait. Regression fixtures cover a hidden stale list and a delayed empty-library state. These interrupted attempts are development findings, not successful timing measurements.

### Automated checks

138 core/protocol tests and 62 Chromium fixture tests passed (200 total). New cases cover lossless partitioning of supplied card/figure groups, exact native link destinations, crop preservation, foreign-copy rejection, bounded adoption finalization, full-copy conflict refusal, first-row toolbar clearance, safe image staging before enlargement, saved preparation status, immutable child installation and uncertain-creation crash recovery. Fixtures use synthetic material; copied-lecture observations are separately described above. The production dependency audit reported zero known vulnerabilities at validation time; this is not a comprehensive security certification.

Syntax checks cover 107 modules. Package, lockfile and server agree on 0.21.0. Full discovery exposes 107 actions (109,441 bytes); compact discovery exposes three entry tools (1,998 bytes). The public source allowlist excludes profiles, account configuration, private PDFs, lecture images, local plans and runtime evidence. Live account testing remains Windows/Chrome; cross-platform synthetic checks are a separate claim.

## Version 0.20.0 - November 10, 2026

The new scope is selective revision of managed boards and flexible one-to-three-column layouts. Existing 0.19 frozen plans/checkpoints remain usable. Tests and live development used the dedicated headless profile and separate native board copies, without desktop control.

### Automated checks

- 123 core/protocol tests and 62 Chromium fixture tests passed (185 total). New cases cover selective updates, retained unselected entries, every column/packing mode, spans, page bounds, native backup/copy identity, interrupted/rejected writes, explicit no-write recovery, changed targets, tiny handwriting on a dot grid, image aspect/size/position, exact decoded image pixels/crops, and separately inspected repair evidence/history.
- Three new browser fixtures exercise late-loading virtualized library rows, remounts immediately after readiness and ambiguous native IDs. Existing browser fixtures cover the shared object/text/navigation controls; synthetic fixtures do not substitute for real Goodnotes validation.
- Syntax checks passed for 104 modules; package, lockfile and server agree on 0.20.0. Full discovery exposes 98 actions (98,861 bytes); compact discovery exposes three tools (1,998 bytes). Formatting checks passed. Compact protocol tests include revision schema discovery, read/write routes and strict invalid-input rejection.

### Completed native result

The revised Oligopol copy completed with 19 managed objects and five original figures. Its native export was visually inspected: all planned sections, figures, captions and exercises were present without overlaps. A new browser process recalled the personal note using its saved appearance fingerprint and read its exact 126-character text unchanged. A fresh export of the original learning board matched the pre-revision baseline in the native recovery comparison. The original board remained unchanged.

A second native copy was prepared from the completed revision, exercising chained revision preparation and a full-copy PDF comparison. One managed summary card was deliberately changed through the guarded text editor, after which a new revision attempted to update that same card. The live run stopped before any revision write with a rejected receipt and `mayHaveWritten: false`. A new process read the deliberate manual text unchanged. This negative-test revision intentionally remains `needs-review`; it is not an incomplete positive result.

A separate fresh real compact-mode stdio connection reported server version 0.20.0, three entry tools, completed revision status, all 19 managed objects and all five source figures. The old in-chat connection still returned `Transport closed`; that connection needs restarting, while fresh connections use the installed source successfully.

### Live development findings

A native copy of the completed Oligopol learning board received a separate personal test note outside its managed blocks. The saved revision selects two text cards, moves one existing original figure and appends a section containing three more original slide crops, captions and transfer exercises. A wide original figure spans two columns; this is not a new claim that all column modes were tested live.

Development exposed late library virtualization (including a row detaching between readiness and its uniqueness check) and a blank-space guard that initially mistook native light-gray dots for notes. These attempts stopped before writing. The corrected guard recognizes only the exact repeated native dot pixels, supported by multiple matching rows/columns; tiny extra gray or black marks remain rejected.

The first broad blue lecture graphic exposed a second issue: artwork could be mistaken for a selection frame when the baseline preceded insertion. The surroundings check stopped that attempt after the image was inserted at the wrong position. A deliberate, separately journaled move corrected that image on the test copy. The original uncertain receipt, original evidence and repair history were retained. Fresh selections, aspect/size/position guards and exact decoded source-pixel/crop checks now prevent treating part of an image as the full figure. Persisted unselected image screenshots are retained separately from pre-reload screenshots because Goodnotes uses different image rasterization during selection. A fresh process independently verified the repaired image, exact source pixels and unchanged surroundings.

This is development validation, with an explicitly inspected repair, not a clean controlled speed benchmark. The historical 0.19 seven-minute build measurements below must not be transferred to this larger revision workload. Source impact remains a text/page-position aid; arbitrary historical boards, invisible objects, concurrent remote edits, automatic multi-board splitting and iPad synchronization are not certified.

## Version 0.19.0 - November 10, 2026

Five complete lecture-to-board workflows ran through fresh real stdio MCP connections on Windows and installed Chrome, using a dedicated headless profile. Each source was duplicated and exported; the original lecture and existing finished boards were not edited. Each new output has nine native objects: one title, two original slide images, two captions and four editable learning cards (summary, concepts, questions, answers). Content and crops were reviewed locally before native execution. All five final native exports were also visually inspected.

### Complete-board measurements

| Lecture | Source pages | Native build | Through MCP completion | Including final visual review |
| --- | ---: | ---: | ---: | ---: |
| Oligopol | 11 | 7:10 | 9:47 | 10:36 |
| Monopol | 19 | 7:32 | 10:17 | 11:45 |
| Vollkommene Konkurrenz | 30 | 6:47 | 11:03 | 11:28 |
| Kostentheorie | 44 | 7:13 | 10:55 | 11:26 |
| Produktionstheorie | 37 | 7:38 | 14:08 | 14:43 |

Native build is the sum of the eleven run calls: new board creation, nine blocks and the final audit/export. Its median was **7:13**, range **6:47–7:38**. The complete process includes source copying/export, assistant reading, selecting original figures, checking calculations, planning, between-call work and final visual inspection: median **11:28**, range **10:36–14:43**. The latter ends at the timestamp of the saved visual-review record, not at the last write. The production example also includes additional formula inspection and assistant context/preparation delay; no pauses were subtracted.

All five native execution runs completed with **zero manual write repairs**, all steps verified and no independent reconciliation needed. Competition had one crop-width adjustment in the local preview before any board write. This is a preflight revision, not an invisible successful first attempt. Oligopol reused previously reviewed materials; the other four lectures were read and prepared for these runs. Automatic bounded read-only UI reacquisition is not a manual repair. Five different lectures with one run each do not establish a reliable percentile, universal seven-minute promise or maximum-document performance.

The earlier 0.18 comparison below measured changes to four cards on an existing board. These 0.19 runs create nine objects and include board creation/audit, so no direct percentage speedup against that earlier workload is claimed. Native writing code was frozen for all five runs. The subsequent response-only change adds compact progress and the actual final preview path; fresh stdio status calls separately verified it without opening a browser.

### Verification and development findings

- 101 core/protocol tests and 59 Chromium fixture tests passed (160 total). New workflow cases cover source-page/layout validation, stable request IDs, source-title conflicts, uncertain partial writes, verified-receipt crash recovery, frozen-plan integrity and compact/detailed status. Fixtures use synthetic content; live evidence comes from the five copied lectures above.
- Syntax checks passed for 100 modules; package, lockfile and server agree on 0.19.0. Full discovery exposes 93 actions (90,574 bytes), compact discovery three entry tools (1,998 bytes). Formatting checks passed before packaging.
- A fresh real stdio read of the completed Oligopol workflow measured 4,919 compact versus 13,522 detailed JSON payload bytes (63.6% smaller). Both retained matching completion/step status and the actual exported preview. A separate fresh compact-mode connection discovered all five new action schemas with correct read/write routing and read the completed result through the compact entry tool. This is payload size, not measured total token consumption.
- Separate development pilots exposed hidden resize handles while editing text, extra native selection-frame padding and insufficient image-caption clearance. The writer now leaves the text editor before resizing, reserves native frame space and uses greater caption clearance. Original uncertain receipts remain intact; one proven pilot block was independently reconciled. A pilot with insufficient final geometry stayed unconfirmed. These pilots are excluded from stable-run statistics.
- Source references and original diagram crops were checked. Exercises were independently calculated and labeled as assistant-created answers, not official solutions. An incorrect second derivative on a source production slide was not copied into the learning text.

### Remaining limits

The workflow still uses native Goodnotes Web controls, not a supported document-editing API. It requires the tested viewport and 100% zoom, uses a fixed two-column layout, and cannot certify facts or arbitrary diagram readability automatically. The fixed image row can leave extra whitespace for wide diagrams. Source reading and final visual QA remain assistant work; uncertain partial writes without a sufficient checkpoint still require inspection. Concurrent human edits are not transactional, and reload/export checks do not acknowledge iPad synchronization.

The installed configuration already points to the local source server. Fresh connections tested version 0.19; the existing chat transport reported `Transport closed` and needs reconnection/restart to load the new actions. Packaging excludes private lecture copies, source images, runtime evidence and browser profiles. No GitHub publication or hosted CI run is claimed.

## Version 0.18.0 - November 10, 2026

Windows and the installed Chrome were used. The original lecture and finished learning board were preserved. Live changes were confined to separate benchmark/development copies in an isolated headless profile. The pre-edit plan fixed four cards' exact text, heading ranges, body sizes, backgrounds and corner radii before either measured run.

Automated validation covers 90 core/protocol tests and 59 Chromium fixture tests. New regressions cover combined body/heading formatting in one reload, literal bullet/number prefixes, UTF-16/overlap validation before writing, readiness invalidation after same-URL reloads, wheel-versus-trackpad gain, overlapping/nested dismissal menus, custom swatch application, delayed native format rendering without repeated writes, and retained text-box kinds. Recovery tests accept changed selection handles but reject changed box appearance with zero style writes. Syntax checks cover 96 modules; package/server/lockfile versions agree at 0.18.0. The protocol still exposes 88 actions (84,757 discovery bytes), or three compact entry tools (1,998 bytes).

Development failures remain recorded separately: two early copy runs stopped on a read-only recovery check that included changing native selection handles; a third stopped while dismissing a menu on the right-hand card. Completed text writes were independently read back, and no uncertain write was replayed. The final comparison starts from a fresh duplicate to avoid benefiting from partially completed development edits.

### Controlled copy comparison

One complete successful run per version used the real stdio MCP transport and the same four-card result. Version 0.17 used separate body/heading edits and the necessary fresh-navigation/right-card menu workaround. Version 0.18 used the precomputed `formatRanges`, returned view handles and guarded native menu recovery. Both performed exact text/format reload checks and separate background/style reload checks. No content mutation was retried inside either successful run.

| Measurement | 0.17 legacy workflow | 0.18 planned workflow |
| --- | ---: | ---: |
| Four cards, including navigation and persistence checks | 836.584 s (13:56.584) | 467.321 s (7:47.321) |
| Entire run, including startup and PDF export | 847.022 s | 472.224 s |
| MCP calls, including final export | 73 | 39 |
| Text edit calls | 8 | 4 |
| Time inside text edit calls | 290.310 s | 90.688 s |
| Time inside box style writes | 353.440 s | 194.742 s |

The four-card elapsed time fell by 44.14% (1.79x speedup), and MCP call count by 46.58%. Summary/math/questions/answers took 110.668/112.917/120.912/122.820 seconds in the new run. Text edits and style writes all returned verified receipts. The final export was a one-page flattened PDF; its native text layer was empty, so exact native-field reads, rather than OCR, are the authoritative content checks. The separately rendered 2,094 x 2,800 PNGs from both results were visually inspected and had identical SHA-256 hashes.

This measures the code plus the planned workflow, not an isolated instruction microbenchmark. It is one local comparison, with natural network/server variance; it is not a promise that a complete board can be designed from lecture files in 7:47. Copy creation, development debugging, content planning and additional regression tests are excluded from the timed edit run. The two original lecture diagrams were retained, not regenerated. Separate browser fixture tests were stopped during the successful new timed run.

Later combined literal-prefix/custom-color regressions reported `FORMAT_UNVERIFIED`; their receipts remain uncertain. Independent reloads distinguished unchanged text from persisted diagnostic edits before intentional restoration. Separate newly added and existing swatch tests, and a whole-field color operation after committing the new text, passed after reload. Waiting alone did not fix the combined case. The final fix commits/reacquires fresh native text before color, applies color before other style popovers, and reacquires the selection afterward. Bounded read-only format settling is also covered; no color/toggle command is replayed by it. The final combined live test passed literal bullet/number prefixes, a newly created custom heading color, body/heading formatting and restoration of an odd board offset after reload. The above timing is not a new full benchmark of these final color-path fixes; the timed four-card plan did not request text-color changes.

The same final live run restored the intended summary, prepared its native box style, remembered the resulting selection, navigated to another document, recalled the text box at the odd camera offset, and read its style directly without another manual selection. Every check passed. Its final board export rendered to exactly the same PNG hash as both benchmark outputs, confirming the temporary text/color diagnostics were removed and the original diagrams/layout preserved. The complete final-code suite passed 90 core tests and 59 browser tests; syntax/version/protocol and formatting checks also passed. The source archive excludes private copies, receipts, profiles and test plans.

The installed Codex configuration points to this source server. Tests used fresh real stdio connections; the old in-chat MCP transport had been closed to release the dedicated profile and still reported `Transport closed`. The new code is tested and installed locally, but that existing client connection needs reconnection/restart before using its tools directly again.

These checks do not prove all Goodnotes menus, every account or iPad synchronization. The detailed prior validation below remains historical evidence.

## Previous validation: 0.17.0

Checked on Windows with installed Chrome, November 9–10, 2026. Live writes used dedicated synthetic MCP test documents and, for 0.17, a separate duplicate of a learning board. No original study document or final learning board was edited. The dedicated headless browser was closed between live test processes; no desktop capture or personal browser control was used.

## Automated checks

- 89 core/protocol/PDF/OCR/workflow tests passed.
- 53 Chromium fixture tests passed (142 tests including core). These use local synthetic pages and no Goodnotes account. New cases include camera restoration, camera-preserving backup exports, unavailable whiteboard styles and guarded pale text-frame selection. Pale PDF text recovery and a new controller reading its persisted OCR cache are also covered.
- Syntax checks passed for all 92 source, script and test modules.
- Package/server/lockfile versions agree at 0.17.0; formatting is checked before packaging.
- The real MCP protocol advertises 88 distinct actions, all documented in the README. Full-mode tool-discovery JSON measured 83,850 bytes; compact mode exposes three entry tools measuring 1,998 bytes, a 97.6% smaller initial response. This is not an end-to-end token-usage measurement.
- The production-dependency audit reported zero known vulnerabilities at check time. Hosted GitHub CI has not run; the project has not been published.

Regression cases include Unicode/multiline rich text, flat lists, delayed/virtualized rows, restored scroll position, hidden BODY scroll, readonly sticky text, UI shadows excluded from note comparisons, moved/resized notebook page coordinates, duplicate template IDs, unauthorized writes, changed content, stale page orders, incomplete catalogs, interrupted batches, typed references, safe-retry restrictions and preservation of uncertain receipts.

## Live controller checks

Version 0.17 was additionally exercised through MCP on a newly duplicated learning board, preserving the original lecture, original learning board and its existing study copy. At 51% zoom and four downward pans, new multiline text near the viewport bottom passed exact native text verification after reload. Bold/custom-color formatting and a move passed independent reload checks, followed by an exact native text read. A three-step batch then replaced/formatted that text, created a second field and replaced/formatted the second field; all three receipts verified, with two default PDF backups and the board camera preserved throughout. A native text-box background color, corner radius and padding were applied and reread after reload with unchanged character formatting and zero visual mismatches.

The first live small-zoom selection exposed a pale frame that pixel detection missed. It made no document change. The corrected selection uses one exposed native border, two aligned handles and a contained editor; the subsequent native selection and move succeeded. Text-box style availability was true on the tested fresh selection; absent menus are covered separately by synthetic tests and are not claimed universally unsupported.

A flattened board PDF contained zero native text characters. The original threshold-only OCR missed the board title. A bounded higher-resolution adaptive pass found the title and test markers, and a later read reused its cached text. Reported confidence remained low (48): small body text and formulas still contain recognition errors. This is a search/reading fallback, not authoritative transcription or a guarantee of iPad synchronization. Early read-only failures and earlier uncertain development receipts were not relabeled or replayed.

A fresh real stdio MCP process identified itself as 0.17.0, advertised the three compact entry tools, reread all four standalone verified receipts, confirmed the completed three-step batch and two backups, found the board title from the persisted OCR cache without another OCR pass, and reopened the correct test copy in a fresh headless browser. Private account URLs, exports, screenshots and test receipts remain outside the release allowlist. An already-running MCP process must be restarted to load changed source files.

- A six-viewport board scan completed, resumed from disk and reacquired an exact editable text match. A saved visual location survived pan/zoom and a new process.
- A native page was copied between notebooks. Source identity/order, destination page addition and exported page appearance were checked.
- A native text box and a sticky note were copied to a separate clean target. Editable text, formatting, object kind and mapped appearance after reload passed.
- Native snapshot creation passed page/text/render checks. Restore produced an independent copy; a subsequent read-only audit verified a restore whose initial development receipt remained uncertain. The source snapshot was preserved.
- Board background changed to grid/yellow and survived reload. A paper template and a cover template each passed picker-selection, page-identity and before/after-reload PDF comparison; existing exported text was retained.
- A test document was moved to Trash and restored to its original folder with the same identity and PDF content baseline.
- Custom blue text with italic/strike formatting, sticky author visibility, front/back commands, collapse/expansion and lock/unlock passed their documented reload checks.
- A custom green 0.7 mm ball-pen line and yellow 3 mm highlighter line passed. One ball-pen arrowhead was rounded by Goodnotes and failed strict path coverage; that operation remains uncertain.
- A page bookmark and native numbered-list formatting passed.

## Real stdio MCP connection

Version 0.16 extends native shape creation to triangles, diamonds and rounded rectangles. Chromium fixtures select distinct native toolbar choices and render distinct shapes, while checking delayed persistence and one drawing gesture per creation; unsupported batch kinds are rejected. All three new shape kinds were created through real compact MCP in a dedicated board and passed appearance checks after reload. The resulting triangle, diamond and rounded rectangle were also visually inspected together. Selection-frame padding is not the actual shape contour: a first read-only probe above the triangle apex found no selection. The corrected probe uses the actual creation border point. Shape locking now retains a verified border point from point selection or creation and refuses a lock without one before sending input. Fresh MCP processes then selected all three shapes successfully at actual border points and verified a native triangle lock/unlock cycle with unchanged appearance.


Version 0.15 allows exact empty-string replacement only for an explicitly read native shape label. Blank ordinary text fields, blank stickies and whitespace-only replacements remain rejected. Batch planning requires expectedKind shape for a clear operation. Chromium fixtures cover clearing, an already-empty no-op, reusing the native shape for a new label and rejecting a same-text sticky that replaced a previously read text box before replacement or formatting input. Through real compact MCP, a new native rectangle was labeled, then its label was cleared with exact native-kind and empty-text verification after reload. A two-step batch refilled and cleared the same label in separate MCP processes, with a PDF before each step; both steps completed with reload verification. A final independent MCP process confirmed the shape still existed with an empty native label.


Version 0.14 extends native position/size locks to shapes. The native Lock Shape command and the post-reload unlock control passed a real MCP write. A separate fresh MCP process then prepared and unlocked the same native shape, checking unchanged appearance and the restored Lock Shape control. A two-step lock/unlock batch also completed across separate processes with a PDF before each step. A final fresh MCP process confirmed that the shape was unlocked. Fixtures check border targeting for unfilled shapes, unchanged appearance, wrong-content rejection before input, lost persistence and blocked uncertain replay. The existing bounded appearance reader can now capture through a UI-filtered screenshot function; lock/unlock checks use this to avoid independently fading zoom controls.


Version 0.13 adds explicit native shape label targets to the existing read, replacement and rich-text tools. A new board rectangle was given an initially empty native label; exact replacement and bold formatting both passed fresh editor reads after reload. Fixtures verify the native kind guard, rejection when a sticky replaces a shape, and preservation of the existing sticky path. Batch schema/dispatch tests check kind-bound coordinates, exact preceding text and incompatible targets. A two-step live batch then replaced the native label and added italic formatting, one step per fresh MCP process; both steps saved PDFs beforehand and completed with exact reload verification. Exact label replacement also passed on a notebook page. The initial notebook rectangle creation returned uncertainty while the saved page was still blank during reload; independent inspection found the native rectangle and its later label edit succeeded, without replaying creation or changing its receipt. Creation checks now make bounded read-only appearance attempts. A Chromium fixture covers delayed paint, genuinely missing saves, one native drawing gesture and blocked uncertain replay. A missing native selection menu is also classified for bounded selection-only reacquisition; page-closed and other errors are not retried. A separate new ellipse on the notebook page subsequently passed the revised creation-and-reload check. Independent new MCP processes read the final board and notebook labels, including the board italic setting, and rechecked earlier text-box, sticky and image-copy checkpoints successfully.


Version 0.12 copied two native shapes together through a rectangular lasso, then copied a native fountain-pen stroke as a saved batch step. Both operations matched the captured source and the saved destination appearance. An initial off-center development paste could not be verified; its receipt remains uncertain. The implementation now rejects estimated offscreen destinations before paste. Two earlier ink selections stopped before paste because the selection frame was ambiguous; fresh selection-only attempts now handle late content with a bounded new baseline. Tests cover source-selection conflicts, uncertain replay, altered source checkpoints, changed destination artwork, central placement, page boundaries and numeric zoom. Fresh MCP processes subsequently audited both the shape selection and the fountain-pen copy successfully. Older text-box, sticky and image-copy checkpoints also passed regression audits with their original type-specific checks. These checks do not certify arbitrary backgrounds, all pen textures or every native property.

Version 0.11 shape fixtures cover exact fill/stroke values, the fill-switch palette closing, native opacity thumbs that are siblings of their tracks, unrelated covering overlays, changed selection-handle padding, stale state, missing permission, no-ops and lost saves. Slider adjustment is bounded and checks every measured click target. Native fill enable/disable passed state and appearance checks after reload; earlier development receipts with unconfirmed geometry remain uncertain and were not replayed. The displayed shape style was independently read after those writes. A native 25-percent request could not reach an exact value; the public schema now accepts conservative 10-percent steps before any write. A final two-step shape-style batch ran one step per fresh MCP process, saved a PDF before each step, and verified both 20-percent/1.1-mm and 80-percent/1.4-mm native settings and appearance after reload. Selection frames are compared by each edge, allowing up to three pixels per edge after native handle padding changes; rendered shape appearance remains separately checked.

Version 0.10 listed, renamed and deleted a synthetic native outline entry through compact stdio. Native entry identity, title, page binding and page order were verified after reload. A separate outline creation started in explicitly enabled Reading mode, entered native editing and passed verification; the remembered Outline sidebar tab was then normalized for page listing. Tests reject missing permission, stale hashes, hierarchy controls and lost saves, and preserve uncertain receipts. A native thumbnail-loading placeholder initially caused a no-write conflict; conflict hashes now cover stable entry/page metadata only. A three-step list/rename/delete job resumed one step per new MCP process, used typed verified hashes, saved PDFs before both changes and completed with every step verified.

Version 0.9 fixed native sticky commits to click inside the notebook page and added bounded selection-only attempts and screenshot rechecks for bookmarks, copied-object checks and move audits for delayed object loading. Explicit `expectedKind` can select a native sticky directly. The initial sticky creation left a blank note and an uncertain receipt; a separate read verified the blank note, and an exact fill then passed reload verification. No creation was replayed.

Version 0.9 recalled a saved text object on notebook page two after a zoom change and a new server process, then moved it to another notebook page. A native image and a sticky note also moved between notebook pages with exact source-content rechecks and independent checks of both ends. A new MCP process independently audited all three notebook moves. Existing board text/sticky copy checkpoints also passed again after the notebook editor changes. Source text, native kind and formatting were rechecked immediately before deletion. Notebook bookmarks retain private PNG checkpoints with integrity checks and bounded rendering tolerance. Fixtures reject cross-page selection, changed page dimensions, rotated surfaces, missing content and changed checkpoint files. Move tests reject changed text, kind, formatting, image pixels, dimensions or crop after copying.

Version 0.8 moved a native image, a typed text box and a sticky note from one synthetic whiteboard to another through compact stdio. Each saved a source PDF and visual bookmark, verified the destination copy before deletion, reacquired the unchanged source, deleted it and checked both the source removal and native destination content. Unit tests reject missing source permission, incomplete copies, changed sources, incomplete child receipts and later changes to the deleted region. A fresh MCP process independently verified all three moves. Audits and journal replay never repeat Copy/Delete. Saved scan/object target tests use public inspect results without a page URL and reject another page; visual bookmark tests reject a different selection even when the original region's pixels are unchanged.

Version 0.7 copied a native cropped image to a new synthetic board. The real compact stdio result verified identical source pixels, dimensions, crop and appearance after reload. A second server process independently verified the saved paste and read the source image again, confirming it remained unchanged. The earlier native text-box and sticky paste checkpoints also passed the expanded verifier in a new process. Automated checks reject stale source pixels/crops and malformed batch inputs before clipboard/paste input.

A new three-page notebook contained exact text on its middle page. Deletion saved its complete PDF and original page order, removed that page with native identity checks, and recovery restored the same page identity/order and complete PDF content. A second MCP process independently verified the restored page. Unit tests cover uncertain deletion checkpoints, absent authorization, changed page order, incomplete/wrong-document backups, no-op recovery of an already restored page, cancellation and remaining-page mapping. A changed drawing with unchanged extracted text is rejected.

Object deletion passed through compact stdio with unselected before/after content and reload comparison. Its Chromium fixture rejects both a no-op Delete click and a deletion lost on reload, retaining uncertain receipts. No selected-versus-unselected frame difference is accepted as evidence of content removal.

Version 0.6 completed document favorite changes and a folder favorite change through compact-mode routing. Discovery, on-demand schemas, strict parameter validation, incorrect read/write route rejection and original journal replay protections also passed protocol tests.

A native rectangle image crop passed source-pixel dimensions/content and mapped canvas appearance after reload. The live app replaced the underlying source with cropped pixels; original source PNGs and metadata were saved privately before applying. Earlier development crops remained rejected or uncertain, and were not replayed. A separate read-only pixel audit was used to understand that behavior. Fixtures cover native handle-center offsets, scaled preview mapping, cancellation and invalid/too-small rectangles; pixel tests reject a missing thin stroke.

Native text-box styling passed through the real compact stdio connection, preserving exact text and character formatting. One check changed padding; a subsequent check changed all six settings: background color, border color, corner radius, border width, padding and shadow. Native settings and appearance matched after reload. Goodnotes sometimes exposed a reduced toolbar for the whole first reload; a second read-only reload restored the style controls. The implementation repeats identity, text, formatting and appearance checks, without replaying style inputs. A fixture verifies that this recovery sends no additional writes. Earlier uncertain style receipts remain unchanged.

Native text-box and image locks and unlocks passed full cycles through compact stdio, checking the kind-specific native lock/unlock control and unchanged appearance after reload. Both synthetic objects were left unlocked. Batch fixtures additionally cover new crop/style/unlock dispatch, PDF backup ordering, exact-text conflicts, typed favorite references and stopping before later writes.

Version 0.5 additionally completed a three-step folder move/rename/move job, running each step in a new MCP server process. The direct child folder stayed present; each step verified the native parent/title/identity and updated the authorized descendant paths. New folder color/icon/favorite tools expose exact current states and native choices. Favorite changes, color restoration and icon removal passed native state checks after reload. An investigative icon change confirmed that closing the native symbol menu is necessary before navigation; this behavior is now covered by the local fixture. Early color/icon development receipts remain uncertain; later checks do not rewrite them.

Native front/back commands passed for a lasso multi-selection, preserving the lasso region for the subsequent selection. Whole-field highlight removal and a custom color passed exact text and formatting checks after reload. The initial yellow-highlight development receipt remains uncertain because the first reader omitted the native `data-highlight` attribute; a separate read confirmed it had persisted, and the reader now includes it.

Pencil (0.5 mm), fountain pen (1 mm) and brush pen (1 mm) each drew a distinct custom-colored line that passed path coverage and appearance checks after reload through the real stdio connection.

A diagonal green ball-pen arrow passed full shaft/head path coverage and appearance after reload. Its implementation uses separate straight head strokes, denser pointer samples and repeated final points to let Goodnotes finish its stroke smoothing. The earlier horizontal development arrow remains uncertain because one short head segment lost its tail; that write was not replayed.

The 0.4 client discovered all 69 tools and completed a two-step sticky collapse/expansion job across two separately started server processes. The second step resolved its collapse operation ID from the first step's persisted verified result. Both steps completed with verified receipts, and the first step's PDF backup remained available.

The same stdio connection also read a native numbered list, removed its list style, applied bullets and restored numbering. All three edits preserved exact text and passed formatting checks after reload.

Text creation passed through stdio both on a notebook page and a whiteboard. Notebook verification maps a point inside actual text glyphs to the same native page after reload, and retries only blank reads while content is loading. Creation keystrokes are never replayed by that check. An earlier development write remained uncertain; a separate read-only OCR/native-field audit subsequently found its exact text without reinserting it.

Final stdio read checks passed for board settings, independent verification of both native pasted objects, detailed batch help, saved batch status and the verified Trash recovery receipt.

## Evidence limits

Live results cover these synthetic cases, not every account, paid plan, document size or operating system. Maximum-size live libraries/notebooks were not tested. Native UI actions are not a supported Goodnotes API. PDF checks cannot prove every native editable property, collaboration metadata or lossless backup fidelity. Reload verification can read a local cache and does not acknowledge delivery to an iPad.

The actual private operation receipts, images, PDFs, scan checkpoints and test document URLs remain outside the release archive. Failed/uncertain development receipts have not been overwritten or relabeled. See [LIMITATIONS.md](LIMITATIONS.md) for unimplemented operations and restrictions.

The hosted CI configuration targets Windows and Ubuntu with Node 22 and 24. This matrix has not run on GitHub because the repository has not been uploaded; local results above apply to the tested Windows/Node 24 host.
