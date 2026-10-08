# N1: expanded MCP/n8n comparison runbook

This slice gathers evidence for a compatibility decision. It changes no
application types, serialization, grants, provider behavior, or persisted
product contracts. The string-input comparison remains the reviewed baseline;
new captures are unreviewed until their wire differences and provenance have
been inspected. A passing run does not mean identical n8n requests.

## Scope and ownership

| Scenario | Reference | Candidate operation |
| --- | --- | --- |
| String input | Reviewed September 26 | Existing `playwright.n1.config.ts` lane |
| Primitive inputs | n8n 2.39.10 capture | Python string, integer, boolean arguments; explicit JSON-array text |
| Nested inputs | n8n 2.39.10 capture | Python dictionary and string list; explicit JSON-array text |
| Multiple output items | n8n 2.39.10 capture | Two ordered objects in explicit JSON-array text |
| Workflow error | n8n 2.39.10 capture | Native `ToolError`; no fabricated n8n error envelope |
| Empty output | **Missing capture; stubs only** | Blocked on reference evidence |

`tests/fixtures/mcp-servers/n1-matrix.json` owns scenario IDs, reference paths,
tool descriptions, scripted arguments, and provider ports. The Python server
owns the business operations and their SDK-generated input schemas; it never
reads saved result messages. `tests/e2e/n1-matrix-capture.spec.ts` owns the UI
capture workflow and assertions. The existing provider owns actual HTTP request
capture; requests must never be reconstructed from previews or traces.

Fixture choices are deliberately narrow. The primitive fixture uses `int`,
where the n8n schema advertises `number`; the resulting integer restriction is
a real schema difference. The nested Python annotations also express constraints
absent from the captured n8n schema. Preserve those differences. Explicit text
arrays do not establish a general mapping from MCP structured output or empty
content to n8n results. Native MCP errors and n8n workflow error envelopes are
expected to differ. No schema normalization or presentation policy is authorized
by this runbook.

## Prepare

Run from the repository root with installed npm dependencies, Node satisfying
`package.json`, and Python 3.10+ in `.venv-mcp`. If the environment is missing:

```sh
python3.12 -m venv .venv-mcp
.venv-mcp/bin/python -m pip install -r scripts/requirements-mcp.txt
```

The server refuses versions other than `mcp==2.1.1` and `pydantic==2.13.5`.
The existing n8n captures include their exact node versions and manifests.
Do not substitute current n8n behavior for those references without a new,
separately identified capture.

Playwright owns all listeners and teardown. Do not manually start the app,
Python server, or providers. The matrix adds Python on 44030 and providers on
44026–44029 to the base suite's listeners. Run capture lanes sequentially;
they share the base app port. In a restricted sandbox request loopback
permission before starting, as described in `tests/e2e/README.md`.

## Run

```sh
# First iterate on the four new scenarios.
npm run test:e2e -- --config playwright.n1-matrix.config.ts tests/e2e/n1-matrix-capture.spec.ts

# Existing string-input evidence regression, in a separate lifecycle.
npm run test:e2e -- --config playwright.n1.config.ts tests/e2e/n1-string-input-capture.spec.ts

# Offline comparator controls, type checks, then the full browser suite once.
npm run test:n8n-contract
npm run typecheck
npm run test:e2e -- --config playwright.n1-matrix.config.ts
```

The matrix config runs the full ordinary suite plus its four scenarios when
the spec path is omitted. The ordinary config skips Python capture specs.
The separate modern-protocol/server-kill lane still uses
`playwright.python-mcp.config.ts`; the matrix does not replace it.

By default each invocation creates a fresh directory in the OS temporary
directory. Each scenario logs its path and attaches it to the Playwright report.
For a durable staging location, set `INFERENCE_LENS_N1_MATRIX_OUTPUT` to a
fresh empty directory before the run. Never point it at committed evidence.
Python receipts, provider requests, reports, and manifests use exclusive writes;
rerun failures into a new directory. Retries are disabled.

For isolated debugging, `--grep nested-inputs` runs one scenario, but the
other scenario directories then contain no complete evidence. Do not label
that run as a completed matrix.

Each complete scenario contains:

- Both actual provider request bodies and both scripted responses.
- Discovery, normalized execution, Python arguments/result or error, and SDK versions.
- A screenshot after the rendered final completion.
- `wire-differences.json` with exact paths, both values, and presence flags.
- A manifest with base commit, working-tree status, policies, and SHA-256 hashes.

The browser assertions require explicit approval, no Python execution before
approval, exactly two provider requests, exact tool/argument linkage, and the
rendered final response. Success text must byte-match the n8n result and the
Python receipt. The error case must be a completed `isError: true` result,
contain the intended error, and differ from the n8n envelope. These assertions
establish execution and bounded expectations, not general schema equivalence.

## Compare and review

The spec automatically runs the comparator. To compare independently captured
requests that do not yet have a report:

```sh
node scripts/n1-compare-capture.mjs /path/to/fresh/capture primitive-inputs
```

The scenario defaults to `string-input` for older callers. Supported new IDs
are the four rows above. The command refuses unknown scenarios and an existing
report. It is a difference reporter, not a pass/fail compatibility gate: it
exits successfully even when differences exist. It neither validates capture
provenance nor approves evidence promotion by itself.

For each initial and continuation request, review:

1. Tool names/descriptions/order; schema types, required lists, restrictions,
   metadata, and explicit versus omitted `strict`.
2. Prompts, model, streaming, tool-choice/parallel settings, roles and content.
3. Assistant argument text, call IDs, tool-result IDs, and exact result text.
4. Each mismatch's meaning: contract change, presentation, metadata, ordering,
   identifier/redaction, or unsupported interpretation. Do not automatically
   call any category harmless. Object key order is ignored; array order,
   absence/null, argument strings, and result strings are preserved.

Keep observed facts separate from inferences about a hosted model. A scripted
provider cannot establish a hosted model's interpretation of schema differences.
Compare the error result explicitly: do not replace native MCP failure text
with a matching n8n string just to turn the comparison green.

Before promotion, inspect all files for secrets and accidental personal data,
verify hashes, record the exact harness revision (commit pending changes or
retain the patch), and copy the complete scenario directory into a new reviewed
evidence directory under `tests/fixtures/mcp-servers/`. Keep the original
request bytes unchanged. Set a reviewed status in the manifest and add an
observations document naming n8n/node/SDK versions, exact differences, and
limitations. Add golden comparisons and name/schema/result mutation controls
against those reviewed requests; do not silently regenerate expectations when
the wire changes. Existing N1 diff tests demonstrate the mutation-control pattern.

## Empty-output reference gate

Use the existing `empty-output.parent.json` and `empty-output.subworkflow.json`
stubs with the [n8n capture procedure](N8N_TOOL_CAPTURE_PROVIDER.md), selecting
the provider's `empty-output` scenario in a disposable workflow. The intended
sub-workflow returns no items. Observe what n8n actually sends: it may send a
result, stop, or behave differently from the provider's current `[]` expectation.
Preserve rejected requests and execution evidence if the expected continuation
does not occur. Do not edit the workflow to force an assumed result.

Only after reviewing that evidence should a baseline and corresponding Python
fixture be added to the matrix. If n8n never emits a second provider request,
record that limitation and design a distinct terminal-run comparison; do not
invent a continuation fixture. This task does not operate the user's n8n server.

## Exit and next decision

Finish this slice with reviewed captures and observations for the four runnable
scenarios, explicit empty-output status, passing mutation controls, and an
accurate verification record. Fixed-only/fixed-and-AI inputs, rejected arguments,
and multiple attached tools remain later extensions. Authenticated/remote MCP,
Tauri, streaming, arbitrary structured results, and other SDK/n8n versions are
outside this evidence set.

If measured differences warrant an opt-in presentation policy, present its
type/owner, selection and persistence, trace visibility, supported versions,
source scope, and result reversibility to the user before implementation.
Until then, describe successful equivalent operations and exact differences;
do not label the integration generally “n8n compatible.”

## Harness verification — September 26, 2026

- The new comparator regression failed before the change: selecting each new
  scenario still reported the string-input baseline. It now passes, along with
  unknown-scenario refusal and existing-report preservation checks.
- `n1-matrix-capture.spec.ts`: all four scenarios passed against the official
  pinned Python SDK. `n1-string-input-capture.spec.ts`: passed separately.
- Full suite with `playwright.n1-matrix.config.ts`: **228 passed, 3 skipped**.
  The skips are the separate string-input capture and two Python server-kill/
  protocol-lane tests; string-input was run separately, the separate Python
  lane was not rerun. The matrix itself checks modern-protocol discovery.
- `npm run test:n8n-contract`: **70 passed**. Typecheck, ESLint on changed
  JavaScript/TypeScript files, and `git diff --check` passed.

The first matrix launch stopped at a missing JSON import attribute before any
browser test ran; that harness setup issue was corrected. No application
regression was claimed from it. No application runtime changed, so build and
the broader core/unit suites were not run. Browser captures remain temporary,
unreviewed evidence; none were promoted to golden fixtures in this preparation
task. The workflow-error screenshot was visually inspected and showed both
the tool error and completed provider continuation. Human review should focus
on the full difference inventories and fixture schema choices before promotion.
