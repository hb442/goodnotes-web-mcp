# Setup and first edit

[Project home](../README.md) · [Setup](SETUP.md) · [Action reference](TOOLS.md) · [Deutsch](DE.md)

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

Client configuration formats differ. See [example configuration](../examples/mcp-client.json) and [Codex configuration](../examples/codex.toml). A remote/cloud-only MCP client cannot launch this local program directly. Do not expose its stdio transport through an unauthenticated network bridge.

## A typical edit

1. Call `goodnotes_inspect` with the copied document's Web URL, or use `goodnotes_list` and `goodnotes_open`.
2. Call `goodnotes_preview` once to see the visible canvas.
3. Choose a point **inside the intended text field**, relative to the canvas rectangle returned by the preview. Use `x = (pixelX - canvas.x) / canvas.width` and the equivalent calculation for `y`.
4. Call `goodnotes_read_text`. Check that the returned text is the intended text. A blank result can mean an empty position; never infer that handwriting or an image has been read.
5. Call `goodnotes_write_text` with the returned `targetId`, complete replacement text, and a unique `operationId` such as `edit-20261109-001`.
6. If the call times out, use `goodnotes_operation_status` with the same ID. For `pending` or `uncertain`, inspect the document again. Do not retry with a new ID merely to bypass the block.

The next action receives structured results instead of screenshots of every click. [Compact mode](COMPACT.md) reduces initial tool discovery; total model usage has not been measured.

For a complete new study board, use the [lecture-to-board workflow](STUDY-BOARDS.md): review a local plan first, then build each native card with text, formatting and background together before its reload check. For individual edits to existing cards, use `goodnotes_edit_text` with a body `format` and heading `formatRanges`, then reuse its returned `viewId` for the next selection. See [a planned card](../examples/planned-card.json) and [the planning workflow](DEVELOPMENT.md#plan-edits-before-sending-them). Standalone background edits remain a separate verified operation. Measured copy comparisons and complete-board timings are documented in [validation](VALIDATION.md).

## Local data

- Windows: `%LOCALAPPDATA%/goodnotes-web-mcp`
- Other platforms: `~/.local/share/goodnotes-web-mcp`
- Override: `GOODNOTES_MCP_HOME`

The folder contains the browser profile, permissions, lock, receipts, PDF snapshots/text indices, OCR language models, object-edit evidence, image crop checkpoints and original PNG pixels, catalog, batch plans and generated learning materials. Exports, plans and evidence contain private content in plaintext. **Do not share or commit this folder.** Ordinary operation receipts use hashes rather than note text; batch inputs deliberately retain the instructions needed to resume. Tool results still reach your MCP client and its model provider. Local OCR does not upload images. Explicit PDF/image import uploads the supplied file to Goodnotes. Export snapshots stay unchanged until explicitly refreshed.
