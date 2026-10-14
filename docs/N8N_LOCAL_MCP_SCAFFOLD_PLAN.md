# Guided local MCP mocks from n8n workflow tools

**Status:** proposed design for review; documentation only. The user requested
this plan, not implementation. Recommendations below are not yet approved.
**Baseline:** `main` at `5235047`, inspected October 13, 2026.
**Working feature name:** Create local MCP mock.

## 1. Outcome and product boundary

Help someone who uses n8n at work turn an exported workflow-tool interface into
a small, understandable Python MCP server that returns chosen test responses.
They start that server themselves, connect Inference Lens through its existing
MCP integration, and investigate the model's behavior without reaching the
underlying business services.

The primary acceptance story is:

> I export the workflow containing my agent's customer-lookup tool, select that
> tool, review its arguments, and paste a synthetic customer response. Inference
> Lens gives me a runnable folder. I start its Python server, follow the catalog
> setup instructions, discover and attach the tool, approve a model call, and
> see the exact chosen response reach the model. I can edit the response file
> and restart the server to test a different customer situation.

Inference Lens owns extraction, review, artifact generation, and connection
guidance. The downloaded Python process owns mock execution. Existing MCP
discovery, permission, execution, and trace paths remain the integration seam.
There is no new in-app tool runtime, process launcher, package installer,
server supervisor, or embedded Python interpreter.

This is a mock scaffold, not a general n8n-to-Python translator. It does not
execute the child workflow, translate Code nodes, reproduce arbitrary n8n
expressions, contact n8n, or copy workflow credentials. Authenticated and remote
MCP execution remain deferred.

## 2. Existing foundations and constraints

| Existing owner or evidence | Reuse and limitation |
| --- | --- |
| `packages/n8n/src/expression-regions.ts` | Scans expressions without evaluating JavaScript. Useful lexical support, not a complete `$fromAI()` parser or evaluator. |
| `services/api/src/n8n-prompt-extractors.ts` and `app/n8n-import*` | Existing prompt-import conventions. A tool mock is a different artifact and should have its own extraction and UI owners. |
| `scripts/local-mcp-server.py`, `scripts/requirements-mcp.txt` | Working Python SDK example; current repository pins are `mcp==2.1.1`, `pydantic==2.13.5`. Reverify pins and APIs during implementation. |
| `scripts/n1-string-input-mcp.py`, `scripts/n1-matrix-mcp.py` | Real SDK execution and explicit text-response examples; they do not establish general n8n parity. |
| `app/tools/mcp-discovery-panel.client.tsx` | Existing discovery, snapshot attachment, and permission workflow. Reuse rather than duplicate it. |
| `services/api/src/mcp-server-catalog.ts` | Operator-owned catalog. The browser cannot register arbitrary executable endpoints. |
| `services/api/src/mcp-execution.ts` | Existing result projection and invocation path. No new executor kind is needed. |
| `tests/fixtures/n8n/` and N1 comparisons | Versioned source evidence and known schema/result differences. Use for bounded extraction support and end-to-end assertions. |

The currently supported execution target is unauthenticated Streamable HTTP at
a literal loopback address. The service-hosted web app supports this path;
Tauri MCP execution remains outside it. Catalog contents are read on API
requests, but changing the environment variable that names the catalog requires
restarting the app process.

The [N1 string-input comparison](N1_STRING_INPUT_COMPARISON.md) found that
Python function-derived schemas changed titles and omitted
`additionalProperties: false`, among other differences. The generator must not
silently replace a reviewed JSON Schema with one inferred from Python type
hints. Matching a descriptor and response does not establish whole-request
parity with n8n: continuation formatting and provider options also differ.

## 3. Recommended first release

Include:

- File upload or pasted JSON for a parent workflow containing a Call n8n
  Workflow Tool node; optional child workflow export for declared input context.
- Selection of one tool from that parent, including selection of its agent
  context when more than one context could affect interpretation.
- Bounded automatic extraction of supported node versions and literal argument
  declarations; visible unresolved fields for everything else.
- Review of the model-facing name, description, object input schema, and fixed
  or unresolved child-input mappings.
- One manually supplied response, preserved as exact text. A JSON editor may
  format on explicit request; it must not silently add array wrappers or strip
  n8n item envelopes.
- A downloadable ZIP containing a standalone Python server, data files,
  dependency pins, protocol smoke-check helper, and setup instructions.
- Host-native setup first, followed by validated Docker-specific guidance.
- Reuse of existing discovery and attachment, with ask-before-running as the
  existing default.

Exclude initially:

- Automatic retrieval from a live n8n account or execution-history selection.
- Arbitrary sub-workflow conversion, generated business logic, or LLM-based
  code generation. Deterministic templates are enough for the first release.
- Multiple generated tools, argument matching, sequences, delays, intentional
  timeouts, and tool-error scenarios.
- Automatic catalog writes, automatic grants, automatic tool attachment, and
  launching or stopping the server from the app.
- New project/trace/experiment formats, persisted wizard drafts, and full n8n
  wire-emulation policies.

These limits keep the first result useful: a coworker can replace a business
tool with a separately operated, editable local mock.

## 4. User journey

### Entry and import

Add **Create local MCP mock…** beside the existing MCP setup/discovery entry in
Tools. It opens a dedicated flow owned under `app/tools/`; it does not become
another top-level mode or live under prompt authoring.

Accept one parent workflow JSON first. List recognized workflow-tool nodes by
name, description, node version, referenced child, and extraction status. A
workflow ID reference does not fetch anything. If child metadata is necessary,
ask for its export and let the user confirm the relationship when IDs are
absent from an export. Never silently select the first child or tool.

A child-only import should explain why the parent tool node is needed for
automatic extraction. Offer a deliberate **Define interface manually** path
that uses the same review and generation stages and marks its origin as manual.
It must not claim to have recovered the original model-facing contract.

### Review interface

Show two distinct views:

1. **What the model can send:** name, description, properties, required fields,
   defaults, and the full reviewed input schema.
2. **How the n8n tool maps inputs:** AI-supplied keys, fixed inputs, and
   expressions needing a decision. Fixed business inputs do not become model
   parameters just because they appear in the child workflow.

Every unresolved field points to its source node and parameter path. A user
can supply a literal reviewed value or replace the interface manually. There
is no generic “ignore warnings and assume conversion succeeded” action.
Resolved limitations remain listed in the exported README.

Changing the imported source invalidates the extracted candidate and its
review acknowledgement. Editing a descriptor after download marks the setup
as changed and requires regenerating the bundle before a match can be shown.

### Choose response

Provide a plain-text response editor with optional JSON formatting and a
preview labeled **Text returned to the model**. Start without a fabricated
success result. Empty text is allowed only after an explicit choice to use it;
blank/not-yet-configured and intentionally empty are different draft states.

The first mock returns that same response for every valid call. Say this next
to the editor: fixed mappings are explanatory context, not executed workflow
logic, and the response is not computed from the arguments.

Show a compact review of exactly what will leave the wizard. Full workflows,
credential references, unselected nodes, and execution histories are excluded.
User-chosen descriptions and sample responses can themselves contain work
data; do not promise that automatic credential omission makes them sanitized.

### Download, start, connect

Choose a server label and an explicit port, defaulting to the existing local
example's `44020`. An occupied port produces an actionable startup error; no
silent switch to a new port that disagrees with the catalog.

Download the folder as a ZIP. Display OS-appropriate virtual-environment,
dependency-installation, startup, and shutdown instructions. No administrator
access is required by the generated instructions. Python availability and
package access on work machines are reported prerequisites, not assumed.

After startup, guide the user through declaring the catalog and opening
existing MCP discovery. Generating a catalog file does not install it. Preserve
existing catalog entries through a copyable entry and merge instructions;
never instruct the user to overwrite their catalog wholesale.

Use protocol discovery to confirm identity and schema. A browser GET to `/mcp`
does not prove MCP works. A separate explicit **Test sample call** can invoke
the generated smoke-check script from the user's terminal; the app's initial
connection check should not automatically execute a tool.

Discovery success, descriptor match, attachment, and permission are separate
states. A mismatch shows the changed fields and offers regeneration or normal
discovery review; it never rewrites the existing attached snapshot.

## 5. Extraction contract

Automatic support is an allowlist of tested node versions/configurations, not a
claim to accept all n8n exports. Begin with the committed string-input and
primitive-input captures, then add fixed-plus-AI mappings only after their
model-visible contract is proven against captured evidence.

| Input shape | Proposed behavior |
| --- | --- |
| Literal supported `$fromAI(key, description, type, default)` form | Parse without evaluation; retain evidence paths. Establish required/default semantics from captured behavior rather than guessing from child metadata. |
| Direct literal fixed value | Display separately; do not expose it as an AI argument. Export only reviewed contextual information. |
| Parent key differs from child-input name | Preserve both identities and the mapping; model schema uses the actual AI key. |
| Referenced child absent | Continue only when parent evidence fully determines the reviewed interface; otherwise request child data or manual definition. |
| `$json`, `$env`, upstream-node references, interpolation, computed keys | Unresolved. Do not evaluate, fetch, or infer them. |
| Multiple `$fromAI()` calls or duplicate conflicting keys | Block automatic extraction for that field; require explicit resolution. |
| Unknown node version, dynamic workflow selector, ambiguous agent context | Explain unsupported configuration and offer manual definition. |
| Object/array types with incomplete constraints | Preserve what is known; do not infer a restrictive schema from one example. Require explicit review and runtime-validator support. |
| Child code or downstream service nodes | Never execute or translate them. |

Retain schema constraints and metadata as data, including required fields,
additional-properties rules, enums, nested structure, and defaults where
supported. An unsupported validation keyword must be an explicit blocker or
reviewed removal, never an ignored constraint. External schema references are
not fetched. Define the supported dialect and local-reference behavior during
the schema spike before accepting these forms.

Source provenance is distinct from confidence: mark individual fields as
extracted or user-authored, record relevant node versions, and retain a list of
transformations. Avoid numerical confidence scores that suggest fidelity was
measured when it was not.

## 6. Ownership, types, and dependency boundaries

Proposed modules, subject to review:

| Owner | Responsibility and public contract |
| --- | --- |
| `packages/n8n/src/workflow-tool-extraction.ts` | Pure n8n parser: unknown JSON to candidate(s), source paths, unresolved issues, and supported-version evidence. No browser, network, Python, or MCP SDK dependencies. |
| `packages/mcp-scaffold/src/definition.ts` | Provider-neutral validated scaffold manifest and review result. Reuse existing JSON/tool definition primitives where compatible. |
| `packages/mcp-scaffold/src/generate.ts` | Validated manifest plus deployment choices to deterministic named files. No file writes or process execution. |
| Versioned Python template beside the generator | Runtime reads the manifest and response; speaks MCP using pinned dependencies. Does not know n8n export structure. |
| `app/tools/use-local-mcp-scaffold.client.ts` | Owns source selection, review edits, validation, download lifecycle, and setup progress. |
| `app/tools/local-mcp-scaffold-dialog.client.tsx` | Renders stages, unresolved fields, response preview, and setup guidance. Uses existing overlay conventions. |
| Existing MCP panel and host services | Catalog selection, protocol discovery, attachment, grants, calls, and trace evidence. |

The route composes the feature owner with a narrow open/close entry point and
existing MCP-navigation adapter. It does not gain parsing, ZIP assembly,
wizard state, or catalog-mutation logic.

Illustrative types, not an approved API:

```ts
type ExtractionIssue = {
  code: string;
  sourcePath: string;
  message: string;
  resolution: "required" | "informational";
};

type ScaffoldResponse = { kind: "text"; text: string };

type ReviewedScaffold = {
  schemaVersion: 1;
  tool: { name: string; description: string; inputSchema: JsonObject };
  response: ScaffoldResponse;
  provenance: {
    kind: "n8n-workflow-tool" | "manual";
    nodeType?: string;
    nodeVersion?: number;
    adjustments: string[];
  };
};
```

Use a separate draft type that can contain unresolved issues; only successful
validation produces `ReviewedScaffold`. Do not let a boolean `reviewed` bypass
validation. Raw workflows stay in transient import state and are not fields of
the validated manifest. Deployment choices (port/catalog label) remain
separate from the portable tool descriptor.

## 7. Downloaded artifact and Python contract

Proposed layout:

```text
customer-lookup-mock/
  README.md
  requirements.txt
  server.py
  check_server.py
  mock.json
  responses/default.txt
  mcp-catalog.example.json
  .gitignore
```

`mock.json` is a strict, versioned format containing the reviewed descriptor,
minimal provenance, and a fixed relative reference to the response file. The
example type above describes the generator input; the on-disk writer separates
response bytes from the manifest. Record generator/template version so support
can identify the runtime that produced a bundle. Unknown major schema versions
fail clearly. Editing the response does not require regenerating Python code.

All generated Python is from static, reviewed templates. Imported names,
descriptions, schemas, responses, and user labels are serialized as data, never
interpolated into executable source, shell fragments, or Python identifiers.
Archive paths are fixed/sanitized and cannot escape the bundle. Startup bounds
manifest/response sizes and restricts file references to the bundle. Set
concrete limits before implementation, aligned with current discovery caps.

Runtime rules:

- Bind to `127.0.0.1` and serve `/mcp` over Streamable HTTP; preserve SDK host
  validation protections. No automatic network exposure or credentials.
- Advertise the exact reviewed descriptor using a public SDK API proven by the
  spike. Prefer an explicit schema registration layer over function inference.
- Validate arguments against the supported reviewed schema, without implicit
  coercion or default insertion. The same schema restrictions must govern
  discovery and invocation.
- Return exactly one text content block containing the response file's UTF-8
  text, with `isError: false`. Do not add `structuredContent`, double-encode
  JSON text, trim whitespace, or append a newline.
- Missing/corrupt configuration or response files fail startup clearly; they
  never return a placeholder success. Unknown tool/invalid arguments follow
  tested SDK error behavior; do not manufacture business results.
- Load files at startup. Editing requires restart in v1, stated in the README.
  This makes concurrent calls deterministic and avoids partial-file reloads.
- Log readiness, tool name, and success/failure without logging argument or
  response bodies by default. Stop with Ctrl-C.

The schema spike must settle the public SDK registration API and Python JSON
Schema validator/dialect support. If an additional validator is necessary,
pin it explicitly and include it in dependency/license review. No private SDK
patching. A fidelity limitation sends the design back for review rather than
being hidden by modifying every discovered MCP tool inside Inference Lens.

No project schema change is expected. When attached, the existing MCP snapshot
and fingerprint receipt remain authoritative. Changing a tool schema requires
rediscovery and normal reattachment/permission behavior; changing only response
text is mock behavior, not a descriptor migration. Historical traces continue
to contain the result actually returned on that invocation.

## 8. Setup by deployment

| Installation | Guidance and support gate |
| --- | --- |
| Source/service on the same host as Python | Primary v1 path: create venv, install pins, run server, configure catalog, discover. Test on supported work-machine OSes. |
| Linux Docker with host networking | Validate current documented host-network recipe and catalog mount; use the existing explicit container-mode configuration. Do not assume the source instructions apply unchanged. |
| Docker Desktop | Host-loopback reachability depends on its networking configuration. Verify a supported recipe on the actual platform before advertising it. |
| Default bridge-network container | Explain why container `127.0.0.1` is not the host. Do not recommend `host.docker.internal` as an executable endpoint while literal-loopback policy rejects it. |
| Tauri | Generation may be portable, but connection/execution is unavailable today. Recommend the service-hosted app; no implied new desktop MCP support. |

A shared-network companion container could be explored later, but is a separate
deployment option requiring verification; do not bundle a new process manager
into the app to make Docker appear automatic. A work deployment on a different
machine from the generated server also cannot reach the user's localhost.

The setup UI should show practical states: server not declared, declaration
invalid, connection failed, tool missing, descriptor differs, ready to attach.
Only claim observations the existing APIs expose. Do not infer that a process
is down when the result only establishes a timeout.

## 9. Decisions for review before implementation

| Decision | Options and tradeoff | Recommendation |
| --- | --- | --- |
| Product scope | General workflow translation versus contract-and-response scaffold. Translation brings n8n execution semantics and service integrations into scope. | Scaffold only. |
| Source requirement | Child-only convenience versus parent-aware extraction. Child-only misses agent-visible mappings. | Parent first; optional child; explicit manual fallback. |
| Generated behavior | Static text versus argument rules or editable generated functions. Rich behavior adds matching/state semantics immediately. | One static response, editable as a data file. |
| Schema fidelity | Python-inferred schema versus explicit reviewed schema. Inference is simpler but known to change constraints. | Explicit schema; prove SDK and validator support first. |
| Result presentation | Infer n8n formatting versus explicit reviewed text. Inference risks changing model-visible output. | Exact text, no whole-request parity claim. |
| Setup authority | App installs/registers/starts server versus guided user-run bundle. Automatic setup expands host privileges and lifecycle scope. | Download and guide; existing operator catalog and grants. |
| Platform gate | Delay for every Docker/Tauri topology versus a clearly bounded first release. | Host-native service first; only tested Docker recipes advertised. |
| Draft persistence | Add project-owned scaffold state versus transient wizard plus independent bundle. | Transient first; no project migration. |

These are material contract choices under `AGENTS.md`. Approve or revise them
before feature implementation. Exact file names, wording, and layout spacing
are reversible details that can be resolved during implementation.

## 10. Delivery sequence and gates

### S0 — Settle contracts and prove schema fidelity

Agree the decisions above. Build a bounded SDK experiment that advertises an
explicit descriptor with required fields and `additionalProperties: false`,
then validates valid/invalid calls and returns exact text. Use supported public
APIs; record actual discovered schema, response, package versions, and limits.
Choose validator dialect/subset and concrete size limits. Stop for design
review if fidelity cannot hold. This spike is not a shipping UI.

### S1 — Extract and review n8n tool contracts

Implement the pure parser with supported-version fixtures, unresolved diagnostics,
and manual resolution types. Start with string and primitive inputs; prove
fixed-versus-AI mapping separately. Build deterministic tests before parser
behavior, including unsupported expressions and ambiguous source relationships.
Deliverable: a validated descriptor and provenance, with no runtime generation.

### S2 — Generate a standalone bundle

Implement manifest validation, deterministic file generation, static Python
runtime, pinned dependencies, README, catalog example, and smoke checker.
Start the generated bundle from a temporary extracted directory, outside the
repository, and connect with the actual SDK client. This catches hidden imports
of repo-only helpers and working-directory assumptions.

### S3 — Guided export in Tools

Add the feature owner and import/review/response/download UI. Preserve edits
across step navigation; close/reopen resets only with clear discard behavior.
Verify exact download contents through the browser. Add host-native startup
instructions and explicit unsupported-installation guidance.

### S4 — Connect and exercise the generated tool

Connect setup guidance to existing catalog selection/discovery. Compare the
reviewed descriptor with actual discovery; attach through the normal approval
path. In a committed browser test, run the downloaded Python server and a
controlled provider, approve a call, and assert exact arguments and the result
in the provider's continuation, UI, and trace. This is the release gate for the
feature; a download alone is not completion of the user story.

### S5 — Work-machine pilot and supported Docker setup

Try a representative exported work tool using synthetic response data. Record
time and friction from export to successful continuation, whether Python/package
installation was allowed, and any manual schema edits. Verify supported Docker
recipes independently. Fix guidance where observed setup fails before widening
the advertised platform support. No arbitrary time target until this pilot
establishes a baseline.

Keep slices independently reviewable. Reuse existing contracts instead of
combining this feature with a generalized MCP settings rewrite or n8n importer
refactor.

## 11. Verification plan

Follow [the committed browser runner](../tests/e2e/README.md) and
[provider fixture rules](PROVIDER_FIXTURES.md). For regressions, write and run
the failing test before the fix; inspect that the incorrect value caused the
failure. For new behavior, distinguish an absent-feature failure from evidence
of an existing bug.

| Layer | Required assertions |
| --- | --- |
| Extraction | Exact name/description/schema; fixed inputs excluded; AI aliases preserved; missing child and unsupported version surfaced; no expression execution; no unrelated workflow/credential data exported. |
| Manifest/generator | Strict version validation; unresolved draft cannot generate; deterministic file contents; literal malicious-looking strings remain data; fixed safe paths; Unicode, empty text, and newline bytes retained. |
| Real Python runtime | Actual `tools/list` matches reviewed descriptor; valid/invalid/extra arguments behave as declared; exact single text response; invalid configuration fails; port conflict explained; clean shutdown. |
| Browser wizard | Import, select, edit, back/forward, unresolved blockers, explicit empty response, download, keyboard focus, discard behavior, setup states, and descriptor mismatch. |
| Full integration | Browser-generated ZIP → extracted Python process → real MCP discovery → normal attachment/grant → provider tool call → exact model continuation → saved trace. Do not substitute the handwritten Node MCP fixture for this lane. |
| Compatibility | Compare supported n8n captures with extraction and generated discovery at specific paths; report remaining request-level differences. Missing captures remain coverage gaps. |
| Failure paths | Undeclared server, stopped server, missing tool, invalid arguments, altered schema after download, invalid response file, permission absent. No silent fallback success. |
| Deployment | Native host plus each advertised Docker platform; verify actual mount paths, loopback reachability, user ownership, and commands with spaces in paths. |

Suggested new specs: `tests/e2e/local-mcp-scaffold.spec.ts` for the guided flow
and a generated-Python integration spec in the existing Python MCP lane. The
integration harness may prepare a temporary operator catalog and launch child
processes; these are test responsibilities, not product capabilities. Ensure
fixtures are terminated and temporary ports/files cleaned up on failure.

During implementation run scoped unit/contract tests, lint and both TypeScript
checks as applicable, then the affected browser specs. Before handing back a
user-visible slice, run the full ordinary Playwright suite once plus the
affected Python lane; the ordinary suite does not exercise that lane. Run the
repository build/test gate appropriate to the changed packages. Report exact
commands, outcomes, skipped platforms, and any fixture limitation.

Human review should complement these tests: can a coworker understand what is
mocked, edit a response without editing Python, diagnose an undeclared server,
and distinguish a working mock from a claim that their n8n workflow was ported?

## 12. Later extensions

1. **Responses from evidence:** select a captured n8n execution output or saved
   tool result. Review its exact model-facing projection and selected work data
   before exporting; raw execution items are not automatically the tool text.
2. **Argument-matched fixtures:** exact JSON matching first, with a declared
   no-match error. Avoid silent default-success behavior. Define normalization,
   precedence, and unknown-property handling before adding rules.
3. **Named error and delay scenarios:** distinguish an MCP tool-reported error
   from a transport failure or timeout. Make delay cancellable and bounded.
4. **Multiple tools in one bundle:** resolve naming collisions explicitly and
   keep each reviewed descriptor and response independently editable.
5. **Stateful sequences:** only after defining state scope/reset semantics.
   Global call counters would make concurrent evaluations nondeterministic;
   current MCP calls do not automatically identify an experiment cell.
6. **Editable business handlers:** a separately reviewed advanced scaffold for
   users who want to implement Python logic themselves. Still no in-app host.

## 13. Definition of done and current verification

The first release is done when a supported parent workflow export can produce
a reviewed one-tool bundle, that bundle runs independently of the repository,
and the actual generated tool completes the normal Inference Lens workflow
with the expected descriptor, arguments, exact response, and trace evidence.
Setup instructions must be proven for every advertised deployment path.

This document was prepared from source, existing fixtures, and the linked
designs. No new implementation, SDK spike, provider call, Python runtime test,
or browser run was performed for this planning task. The SDK registration API,
schema validator choice, expanded n8n support matrix, and Docker Desktop recipe
remain explicit implementation gates, not verified capabilities.

Related documents: [MCP local tryout](MCP_LOCAL_TRYOUT.md),
[MCP discovery](MCP_DISCOVERY.md),
[n8n/MCP compatibility plan](N8N_MCP_TOOL_COMPATIBILITY_PLAN.md),
[N1 comparison](N1_STRING_INPUT_COMPARISON.md),
[N1 matrix runbook](N1_MATRIX_RUNBOOK.md), and [Docker guide](DOCKER.md).
