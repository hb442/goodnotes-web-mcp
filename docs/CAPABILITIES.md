# Capabilities

[Project home](../README.md) · [Setup](SETUP.md) · [Action reference](TOOLS.md) · [Deutsch](DE.md)

## What it does

- Plan [native learning boards from lecture copies](STUDY-BOARDS.md), including original slide crops, source references, summaries, exercises, layout checks and resumable execution with recorded timings.
- Revise selected cards on [existing managed learning boards](STUDY-REVISIONS.md), preserve unrelated personal additions, move verified objects and append new sections. Default to a verified native copy; in-place revisions retain a native backup.
- Adopt selected native text boxes/images from older board copies and split large lectures into [linked learning-board collections](STUDY-COLLECTIONS.md), with a navigable overview and independently revisable parts.
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
