# MCP discovery and attachment

MCP discovery works in the service-hosted web app. It lists declared servers, connects only after a user selects one, and copies selected tool definitions into a project or the next request. An attached definition can be answered manually, by a mock, or through the M3 local execution permission described in [M3 execution](MCP_M3_EXECUTION_DESIGN.md).

## Operator catalog

Start the app with `INFERENCE_LENS_MCP_SERVERS` pointing to a JSON file:

```sh
INFERENCE_LENS_MCP_SERVERS=/path/to/mcp-servers.json npm run dev
```

```json
{
  "schemaVersion": 1,
  "servers": [
    {
      "id": "records",
      "label": "Records server",
      "transport": "streamable-http",
      "endpoint": "https://mcp.example.com/mcp",
      "authorization": {
        "kind": "bearer-env",
        "environmentVariable": "RECORDS_MCP_TOKEN"
      }
    }
  ]
}
```

Authorization can be `none`, `bearer-env`, or `header-env` with an operator-chosen header name and environment-variable reference. The server URL and authorization are never supplied by the browser. HTTP is accepted only for `localhost`, `127.0.0.1`, or `::1`; other endpoints require HTTPS. URL credentials, queries, and fragments are refused. Redirects and requests away from the declared endpoint are refused before authorization is attached.

The catalog is read on each API request. An invalid configured catalog reports a problem instead of appearing as an empty catalog. The browser receives server ID, label, and origin for selection; it receives no authorization reference or endpoint path. Discovery uses the official `@modelcontextprotocol/client` 2.1.0 Streamable HTTP client with explicit protocol negotiation and accepts only the measured `2026-07-28` or `2025-11-25` revisions.

Defaults are a 10-second connection/discovery timeout, 30-second later call timeout, and 1 MiB response limit. The SDK is capped at 64 tool pages. The host also caps the catalog at 512 tools, aggregate discovery responses at 4 MiB, and each retained schema at 64 KiB. Pooled clients close after five idle minutes or when the declaration or authorization context changes.

## Attachment contract

Discovery data is live and untrusted. Attachment copies the selected remote name (or an explicit valid alias), description, and input schema into a portable `ToolDefinition`. It also stores a secret-free source receipt containing the remote tool name and SHA-256 discovery fingerprint. The receipt contains no local server profile ID, endpoint, authorization, or protocol session value. Project export and historical run input remain readable on another device without the MCP server.

The model-visible name defaults to the remote name when valid and unique. Invalid or colliding names require an explicit alias. An attached snapshot does not change on server refresh. The browser shows changed top-level descriptor fields and missing tools after a refresh; accepting a newly discovered definition requires a new attachment. Editing an attached project definition removes its stale source receipt.

Discovery alone includes no execution permission. For local interactive debugging, a user can separately allow a specific attached tool to use a declared unauthenticated loopback server. The default asks at each call; an explicit per-tool choice runs automatically for the browser/service session. Repeated runs and evaluations do not use MCP permissions yet. The n8n provider-wire findings are in [the comparison](N8N_PROVIDER_WIRE_COMPARISON_2026-09-24.md).

## Local fixture

The Playwright configuration starts `scripts/mcp-discovery-fixture.mjs` and declares it through `tests/fixtures/mcp-servers/catalog.json`. Its two-page catalog makes pagination visible in the browser spec. The fixture also changes one description on request so the spec checks that refresh does not rewrite an existing project snapshot. The second page contains inert markup in a description to verify that remote text is rendered as text.
