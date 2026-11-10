# Compact MCP mode

Set the server environment variable `GOODNOTES_MCP_MODE=compact` and restart its MCP connection. The default `full` mode keeps the individual tool names for existing clients. See `examples/mcp-client-compact.json` or `examples/codex-compact.toml`; replace the path for your installation. Codex supports per-server environment variables in its [official MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Compact mode exposes three entry tools:

- `goodnotes_help`: search actions by keyword, with pagination, or request complete input schemas for up to three named actions.
- `goodnotes_read`: execute an action whose original annotation is read-only.
- `goodnotes_write`: execute an action that can edit the UI or document. Some text-reading actions belong here because Goodnotes can open an empty editor at a blank point.

The same underlying actions remain available. Search help, request the chosen action's schema, then pass its exact name as `action` and its input object as `parameters` to the returned route. Only registered actions are accepted. Parameters are strictly validated; unknown keys, wrong routes and unknown actions are rejected before dispatch. Existing permissions, expected-content checks, serialized execution, cancellation, journaling and reload verification still run. Images and other MCP content pass through unchanged.

For example, search help with `{"query":"folder"}`, request `{"actions":["goodnotes_get_folder_style"]}`, then call the returned route with `{"action":"goodnotes_get_folder_style","parameters":{...}}` using actual values from the library. Action details are requested as needed rather than included in every tool discovery response.

With 88 underlying actions, the measured discovery JSON was 83,591 bytes in full mode and 1,998 bytes in compact mode (97.6% smaller). This measures only tool-discovery JSON. Help calls, returned document contents, model behavior and client caching affect total token usage; no end-to-end savings percentage has been measured. Compact mode trades an extra help lookup for smaller initial discovery.

The generic write entry is conservatively marked destructive because it can route to destructive actions. Its annotation does not authorize writes; the selected action's own guards still determine what can run. Existing clients that expect individual `goodnotes_*` tool names should keep full mode.
