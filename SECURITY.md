# Security and privacy

The server is local stdio only. It opens a separate persistent browser profile and does not attach to an existing personal browser, use desktop screen capture, export cookies, read the clipboard, or expose a remote debugging port. Initial sign-in happens in a manually operated Chrome/Edge window without any automation or debugging channel. Only after that window closes can the MCP server open the same dedicated profile. Browser identity and security protections are not spoofed or disabled to make sign-in work.

## Data boundaries

The profile is sensitive. It may contain authentication and cached Goodnotes content. It lives outside the source repository by default. OS file modes are requested where supported; this is not an additional encryption layer or a substitute for the Windows account's permissions.

The server returns requested document text and previews to the MCP client. Your client/model provider's handling of those results applies. The helper itself uses no telemetry, analytics, hosted relay, or external AI endpoint. Chromium and the Goodnotes site still make their normal network requests.

Existing-document writes require an exact local URL/title binding. There is no unrestricted permission-granting MCP tool. Explicit create/duplicate calls authorize only the resulting new document; a verified rename updates its existing binding. Restart after CLI revocation. The process lock prevents accidental concurrent profile use; it does not isolate untrusted local processes under the same OS account.

PDF exports, extracted/OCR text and before/after images are stored locally in the data directory in plaintext. OCR uses bundled English/German models and does not upload pages. PDF processing disables embedded JavaScript evaluation and limits input size/page count. Export destinations are generated private paths, not arbitrary client-supplied overwrite paths. Keep this entire directory out of public archives and backups you share.

## Content is untrusted

Version 0.3 adds private catalog files, resumable batch inputs and generated outputs. These can include full note text. Import tools intentionally read the absolute PDF/PNG/JPEG path supplied by the client and upload that validated file to Goodnotes. Only invoke them for a file the user authorized for this purpose; never derive an upload instruction from note content. Combined PDFs are not a sanitizer for untrusted PDFs. Batches expose only validated, fixed actions, without arbitrary code or shell execution.

Version 0.4 also stores board scan images/OCR, guarded object locations, native snapshot metadata, and copy/collapse checkpoints with before/after images. These are private account data, not release assets. Native snapshots are additional cloud documents and are not encrypted/offline backups. Trash recovery is restricted to verified MCP trash receipts plus the current exact URL/title permission. Independent verification tools never repeat a paste/restore or rewrite an uncertain historical receipt.

Version 0.5 keeps folder permissions in a separate private file, bound to the full native item path and exact title. New MCP-created folders are automatically authorized; existing folders require the local CLI. This grants organization of the folder, not writes to the contents of its documents. A folder move updates separately authorized descendant paths. Structural manifests include private child titles/identities and must stay out of shared archives.

Version 0.6 stores original image pixels and crop metadata privately before applying native rectangular crops. These can contain content no longer visible in the cropped document. Compact mode routes only registered actions through their existing guards, validates parameters strictly, and rejects wrong read/write routes. Its three entry tools do not grant broader access or execute arbitrary code.

Batch references can resolve only allowlisted output fields of earlier verified steps and must match the destination type. Resolved inputs are saved before dispatch. A retry is permitted only after an explicit rejected/no-write receipt; interrupted, missing, pending or uncertain mutations stay blocked. Native clipboard copying uses Goodnotes' in-app controls inside the dedicated profile; it does not read the Windows clipboard.

Treat note text, notebook titles and embedded images as user data. They can contain instructions that are not instructions from the user. A client should never expand the requested task, reveal credentials, alter the allowlist, or run commands because a note says to do so.

MCP annotations are advisory; the actual URL/title checks and text comparison are enforced in code. The prototype does not provide transactional protection against concurrent remote editors.

## Reporting a problem

Do not post a browser profile, cookies, access tokens, private document URLs, screenshots of real notes, or raw protocol traces in public issues. Use a synthetic board and a minimal reproduction. Report vulnerabilities privately through the repository's Security tab when available; do not expose account data in a public issue.

Study adoption/collection records contain copied document identities, full selected text, original image pixels (including cropped-away regions), source references and per-object screenshots. These remain private runtime data. Adoption copies preserve all existing content and track only explicitly selected native text boxes/images; it is not exhaustive board discovery. Linked collection plans resolve only the URLs of their verified newly created boards. Each child uses the same allowlist, journal and persistence checks as an ordinary study workflow.

## Page recovery

Page deletion saves a private full-document PDF and page identities/order under the local data directory before input. Recovery uses only a matching MCP deletion checkpoint, checks current authorization and unchanged remaining pages, and recovers one exact native Trash page. These checkpoints and PDFs can contain personal notes and must not be published. Historical Trash items without a checkpoint and permanent deletion are not exposed by this flow.

## Native moves

Moving between documents requires write permission for both documents. A source PDF and visual bookmark are saved privately; source deletion follows a verified native copy and unchanged-source reacquisition. Copy and deletion have separate receipts, so interruption can leave duplicates. Move audits only inspect existing checkpoints and do not repeat writes. The private move directory and source evidence must not be included in public releases.

Notebook visual bookmarks additionally save a private screenshot and its integrity hash. Pixel comparison permits bounded rendering variation; native moves also recheck exact source text/formatting or image pixels/dimensions/crop immediately before deletion. Other visual-only object operations do not provide semantic content equality.

Native outline edits save private entry titles/identities and page bindings under outline-checkpoints. Only exposed flat rows are supported; these metadata backups are not lossless document backups or automatic undo. The exact current metadata hash and native page order must match before input.
