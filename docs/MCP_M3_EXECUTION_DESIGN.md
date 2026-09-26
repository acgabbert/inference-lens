# M3: local MCP execution contract

**Status:** accepted for session-only, local interactive execution; N1 comparison is next.

## Scope

M3 serves interactive runs in the service-hosted app. The only executable MCP
declarations are unauthenticated Streamable HTTP endpoints at a literal loopback
address (`127.0.0.1` or `[::1]`). The address is loopback on the **service
host**, which may differ from the browser's machine. Existing discovery of
other declared servers does not itself grant execution. Repeated runs and
evaluations remain an M4 concern.

## Identities and ownership

The project or request keeps its detached `ToolDefinition` and source receipt.
Neither contains a local server ID. A separate, host-owned consent record maps
one attached `ToolId` to one operator-declared server ID, remote tool name, and
discovery fingerprint. It also records the user's execution mode:

- `ask`: default; one explicit approval at each interactive tool-call pause;
- `automatic`: the user opts in for that exact tool and server; an interactive
  call proceeds without a further click.

The consent record is scoped to a browser session. It is not serialized into a
project, run input, experiment plan, or trace. The host identifies the browser
session with an opaque, HttpOnly, SameSite cookie and keeps the consent map
server-side. Permission ends when the browser session or service process ends,
or after 24 hours without use. A future persistent choice requires a durable
per-user identity and revocation design, not merely a longer-lived cookie.

The host checks the operator catalog and the current advertised tool at consent
creation and again before every call. A removed server, missing tool, changed
fingerprint, or non-loopback/authenticated declaration invalidates the consent.
The execution request names the attached tool ID, call ID, and parsed argument
object; it supplies no endpoint, authorization, alternate remote name, or
timeout. The host resolves these from its consent and operator declaration.

The same-origin JSON API is the browser trust boundary. A server cannot prove
that a physical click occurred inside its own page; the interactive `ask` mode
is enforced by the client flow while the host enforces the session consent and
catalog ceiling. Neither MCP annotations nor lack of MCP authentication are
used to infer that a remote tool is free of side effects.

## Call and result contract

The browser's existing executor factory gets one `mcp` case. The host calls
`tools/call` through the pinned official SDK, with the declaration's timeout,
response byte limit, and the caller's cancellation signal. Its response is
converted to `ToolExecutionOutcome` before crossing into the run kernel:

- MCP `isError: true` is a completed outcome with `isError: true` and visible
  content. It is supplied to the model.
- JSON-RPC errors, malformed responses, timeout, disconnect, cancellation, and
  policy refusal are classified failures. They supply no tool result and leave
  the existing manual fallback available.
- Text parts keep their order. Non-text parts use the existing explicit
  placeholders and projection notes. Structured content requires a deliberate
  text projection rule; it must not be silently dropped or duplicated when a
  server supplies both `content` and `structuredContent`.

The trace records only the existing normalized execution events, result
projection, and an explicitly constructed secret-free MCP executor identity.
It must never carry the endpoint, session cookie, authorization material, raw
transport response, or grant timestamp. Imported traces remain readable
without the server.

## Regression and acceptance

The browser regression was written before implementation and failed with the
missing consent route's actual HTTP 404. The deterministic provider and MCP
fixtures cover: no call before approval in `ask`; exactly one call after
approval; zero call on rejection; automatic mode only after explicit opt-in;
stale fingerprint refusal at consent; ordinary provider continuation after
success from project and next-request attachments, and completed tool-reported error; structured-only projection; timeout,
protocol-error, and malformed-response failure; manual fallback after timeout;
and a secret-free exported trace. The remaining M3 live checks were accepted
on September 26 as recorded below.

September 26 update: the user confirmed a successful Python-server app run
negotiating `2026-07-28`, satisfying the modern-protocol live check. The user
also confirmed cancellation during the delayed call and abrupt server loss
behaved as expected. On server loss, Inference Lens showed a red failure banner
offering a manually supplied result to continue. These are user-verified manual
passes using the [local tryout](MCP_LOCAL_TRYOUT.md#5-check-cancellation-and-connection-loss),
not automated coverage of Python-server cancellation or disconnection. Actual
continuation after entering a manual result was not separately reported in this
live check; the committed browser fixture covers manual continuation after
timeout. The user also confirmed a saved MCP trace imported and rendered
successfully with the Python server stopped. This closes the server-less trace
check and the remaining live acceptance for the local interactive M3 slice.

Verification for the local tryout changes: the Python smoke check passed for an
immediate result, a delayed call staying pending, and cancellation propagation;
all 8 tests in `tests/e2e/mcp-interactive-execution.spec.ts` and the full
212-test Playwright suite passed. These browser tests use the committed MCP
fixture, not the Python tryout server. No product behavior changed during the
subsequent acceptance-documentation updates, so the suites were not rerun for
those updates.

After the complete MCP-backed run, compare its initial and continuation
provider requests against the committed n8n captures. That comparison informs
N1; M3 does not add an n8n presentation policy on speculation.
