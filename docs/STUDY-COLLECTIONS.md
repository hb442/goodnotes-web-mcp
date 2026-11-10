# Older boards and multi-board lectures

## Adopting an older board

1. Read its library itemPath and exact title; export/read the source lecture.
2. Call `goodnotes_prepare_board_adoption` with those identities, sourceExportId, a new copy title and a stable requestId. It makes and independently compares a native copy; the original stays untouched.
3. Inspect the copy at 100% zoom using the existing board scan, text read and object selection tools. Call `goodnotes_capture_board_adoption` for each chosen text box or image. Supply a unique key, source pages, the learning role and exact expectedText for text. Native text, formatting, box style, geometry, image source pixels and crop are captured and independently rechecked.
4. Call `goodnotes_finish_board_adoption` until completed. Each call verifies at most three objects. A final complete PDF comparison proves that adoption itself did not change the copied document. Use the returned baseId with the existing selective revision tools.

This is deliberately **selected-object adoption**, not an assertion that all objects on an infinite board were discovered. Handwriting, shapes, sticky notes, locked/overlapping objects and unseen personal notes remain unmanaged and are not removed. At most 60 selected text boxes/images are supported; each must fit a 1,288 × 620 px guarded viewport. The selected region must fit a 12,000 × 12,000 coordinate area, with at least 8 px between selected objects. Very large selections must be handled separately. The local preview approximates selected text formatting and excludes other objects; inspect the native export too. Source citations are caller assignments, not automatically inferred provenance.

Later revisions retain exact text/style/image checkpoints. Selected content that no longer matches its checkpoint stops before replacement. Text replacement normalizes character formatting as documented for revisions; native box style is retained. Unmanaged objects are protected by local appearance and empty-destination checks, not by an exhaustive object database. Do not edit the same area simultaneously from another device.

## Automatically splitting a lecture

1. `goodnotes_prepare_study_collection` creates a source copy/export with a stable requestId.
2. The assistant reads the copied source and supplies summaries/concepts, exercises, answers and original PDF crop references to `goodnotes_plan_study_collection`.
3. The planner measures text and figures, keeps figure/caption pairs together, preserves declared section order and splits into parts bounded by maxHeight and maxBlocks. Defaults: 2,800 px high and 14 native objects per part, including navigation. Up to 240 cards, 120 figures and 20 parts are accepted. A single oversized card fails before any board is written; splitting is not semantic summarization.
4. Review the local previews, then repeat `goodnotes_run_study_collection`. Each call creates one board or writes/verifies one block. It creates all board identities first, freezes the resolved link plans, builds the parts, then writes the overview. Every part links to the overview and its previous/next neighbors with short native text links. No placeholder URL is written to Goodnotes.
5. Final child workflow IDs can be used with the normal selective revision tools. Review actual exports for readability and source interpretation.

Execution is resumable but not atomic: a failed run can leave an empty/partial board collection. Saved verified receipts recover completed steps; uncertain writes are never automatically replayed. `goodnotes_review_study_collection` uses existing evidence. Missing evidence requires individual inspection. A PDF preview cannot prove that a destination is accessible to another account or that an iPad has synchronized it.

## Data and release boundary

Source PDFs, crops, account URLs, browser profiles, private journals and study manifests stay in the local runtime directory. They are not included in the source release. The public examples and tests use synthetic material. Goodnotes Web itself is still a third-party service, and the caller's AI client can receive requested document content.
