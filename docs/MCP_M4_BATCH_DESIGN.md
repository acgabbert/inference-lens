# M4: MCP tools in repeated runs and evaluations

**Status:** agreed and implemented September 26. See
[Implementation notes](#implementation-notes) for one deviation.

M4 lets a repeated run or evaluation execute MCP-backed tools without a person
approving each call. It builds on the accepted
[M3 interactive slice](MCP_M3_EXECUTION_DESIGN.md) and replaces M3's
service-side session consent. Execution stays limited to M3's ceiling:
unauthenticated Streamable HTTP servers at a literal loopback address.

## Agreed decisions

1. **One local grant model for command and MCP tools.** Permission is a record
   in browser storage. The service keeps no permission state and validates
   every call against the live operator catalog and discovery.
2. **Grants last until revoked,** like command grants today. A removed
   declaration or a changed fingerprint stops a grant from resolving.
3. **Any MCP grant plus batch confirmation authorizes batch use.** `ask` and
   `automatic` govern interactive calls only.
4. **Unavailability stops the batch.** A failure meaning the binding can no
   longer serve any repetition stops the batch; other failures fail one
   repetition.
5. **`mode` leaves the core binding type.** It is interactive approval policy,
   owned by the tools feature and read by the interactive run session.
6. **A self-stopped batch is recorded as `stopped` with its reason** in a v5
   experiment result.

### Why M3's service-side consent is replaced

M3 kept consent on the service, keyed by a session cookie. That record was
never an authorization boundary: `POST /api/mcp/grants` accepts any
same-origin JSON request, so any client that can execute can first grant
itself. The operator catalog and same-origin check are the real ceiling, for
command tools as well. A service-side record added two costs without a security
gain: a service restart erased every permission, which in a batch would fail
every remaining repetition, and command and MCP tools needed separate
permission and preflight paths.

M3's statement that lasting permission requires durable per-user identity is
superseded by decision 2. Browser storage is per browser profile, the same
lifetime and scope command grants already have.

## Contracts

### Local grant record

Owned by the tools feature (`app/tools/local-tool-grants.client.ts`), replacing
`command-tool-bindings.client.ts` storage:

```ts
type LocalToolGrant =
  | { kind: "command"; toolId: ToolId; commandId: string; grantedAt: string }
  | {
      kind: "mcp";
      toolId: ToolId;
      serverId: string;
      remoteToolName: string;
      discoveryFingerprint: string;
      mode: "ask" | "automatic";
      grantedAt: string;
    };
```

- Storage key `inference-lens:tool-grants:v2`, one grant per `ToolId`.
- On first read, `inference-lens:command-tool-grants:v1` entries migrate to
  `kind: "command"` grants and the v1 key is removed after a successful write.
  Malformed entries are dropped, as today. A compatibility test proves existing
  v1 grants still resolve.
- Grants never enter a project, run input, experiment plan, or trace.
- M3's `declarationFingerprint` is not carried over. The operator owns the
  declaration; re-pointing a server ID is an operator action, and the tool
  fingerprint still has to match the live server on every call.
- M3 session consents are not migrated. They were session-scoped by design;
  users grant again once.

### Core binding

- `ToolBindingConfig`'s `mcp` member loses `mode`. It keeps `executorId`
  (`<remoteToolName>@<fingerprint prefix>`, unchanged), `label`, `serverId`,
  `remoteToolName`, and `discoveryFingerprint`.
- Binding lookup takes the tool definition everywhere:
  `bindingForTool(tool: ToolDefinition)`. The repeated-run, evaluation, and
  unbound-tool paths in `page.tsx` switch from `toolId`, and include the MCP
  binding. MCP resolution needs the definition's source receipt.
- `experimentToolBindingLabel` names MCP bindings as
  `MCP "<remote name>" on <server label>`.

### Stateless execution

`POST /api/mcp/execute` carries `{ toolCallId, serverId, remoteToolName,
discoveryFingerprint, arguments }`. The service checks that the declaration
exists and is executable, lists tools, confirms the live fingerprint, then
calls. The page still cannot supply a URL, credential, timeout, or response
limit. `/api/mcp/grants`, `mcp-consent.ts`, and the session cookie are removed.

### Binding check (preflight)

`POST /api/tool-bindings/check` takes command and MCP binding descriptors and
returns, per tool, `ready` or `unavailable` with one reason:
`declaration_missing`, `not_executable`, `tool_missing`,
`fingerprint_changed`, or `server_unreachable`. It discovers each distinct MCP
server once per check.

It is called:

- when creating an MCP grant, so a stale snapshot is refused at grant time, as
  in M3;
- immediately before a batch's first provider request, before the plan is
  saved. Any `unavailable` result blocks the start with zero provider calls.

### Failure classification

Add `"unavailable"` to `ToolExecutionFailureKind`. The rule is by phase, not
by message text:

- Failures **before** `tools/call` is sent — declaration missing or not
  executable, connection failure during validation discovery, tool missing,
  fingerprint changed — are `unavailable`. So is a command ID no longer in the
  catalog.
- Failures **after** the call is sent keep today's kinds: `timeout`,
  `cancelled`, `invalid_result`, `execution_failed`. A tool-reported error is
  still a completed outcome the model sees.
- Argument problems stay `rejected`. `rejected` no longer covers a missing
  permission or a changed server.

In interactive runs, `unavailable` behaves like any failure: the banner offers
a manual result. In the sequential controller, it fails the current repetition
and stops the batch; later cells are `not-run`. Other failures fail one
repetition and the batch continues, as today.

Trace events are parsed with `passthrough`, so the new kind should not break
readers. A test confirms that an older-shaped reader accepts a trace carrying
it.

### Batch confirmation disclosure

For each exposed MCP tool: portable tool name, server label, remote name when
different, and whether the binding check passed. For the batch: a statement
that MCP tools may have side effects and run without per-call approval, that
permission is revoked from the Tools tab, and the existing case,
configuration, repetition, provider-call floor, and turn-ceiling counts.

## Recording a batch stopped by unavailability

`ExperimentResultV4.status` is strict `"completed" | "cancelled"`. A batch that
stops itself fits neither honestly. Option A was chosen.

| Option | Effect |
| --- | --- |
| **A. v5 with `"stopped"` (recommended)** | Add `status: "stopped"` and a required `stop: { reason: "tool_unavailable"; cellId; toolId }`. v4 reads as v5 unchanged. Older app versions cannot open v5 results. Applies to command tools too, so it is not MCP-specific. |
| B. Record as `"cancelled"` | No schema change. The result claims a user stop that did not happen; the cause is only in one repetition's trace. |
| C. Record as `"completed"` | No schema change. Remaining `not-run` cells are the only signal, and the batch reads as finished. |

## Out of scope for M4

Authenticated or non-loopback execution, Tauri, parallel tool calls, caching
discovery between calls (every call still re-lists tools; measure before
optimizing), and an n8n presentation policy.

## Verification plan

Tests are written first and run red on the actual wrong value.

- Unit: v1→v2 grant migration and resolution; `mode` absent from core
  bindings; binding label; phase-based classification; controller stops on
  `unavailable` and continues on `timeout`; result artifact per decision 6.
- Service: check endpoint reasons for each case; execute refuses stale
  fingerprint and undeclared server without calling `tools/call`; no permission
  state survives or is needed across a restart.
- Browser (`tests/e2e/mcp-*.spec.ts`, repeated-run and evaluation specs):
  - an evaluation completes through the MCP fixture with no per-call approval
    after confirmation;
  - tool-call checks assert name and argument subset;
  - a stale fingerprint or removed declaration blocks start with zero provider
    requests;
  - a server stopped mid-batch stops the batch after the affected repetition;
  - a tool timeout fails one repetition and the next runs;
  - saved artifacts contain no server ID or endpoint;
  - reopening results makes no MCP request;
  - M3 interactive specs still pass on the new grant storage.
- Full Playwright suite once before handoff.

## Implementation notes

- **Deviation:** the confirmation dialog does not run the binding check when it
  opens. It lists what will serve each tool and discloses MCP behavior; the
  check runs when Start is pressed, before the plan is saved, and a failure is
  shown in the results pane as "Nothing was sent. <tool> cannot run: <reason>".
  Showing results in the dialog would add asynchronous state to both dialogs
  for information the start gate already enforces.
- MCP clients are pooled per server by `mcp-discovery.ts`, so the per-call tool
  listing reuses a connection rather than opening one.
- Timeouts are classified by the SDK's `SdkErrorCode.RequestTimeout`, not by
  message text.
- The route composes one `bindingForTool(tool)` for the interactive session,
  both batch kinds, and the start gates.
