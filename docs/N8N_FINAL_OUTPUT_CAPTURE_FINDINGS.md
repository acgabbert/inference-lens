# n8n final-output capture findings

Date: 2026-10-25. Capture-only slice of
[PR185](https://github.com/acgabbert/inference-lens/pull/185). The selected
capture session is complete; no runtime, import, portable-type, or saved-artifact
contract has been implemented or approved. The LAN provider is stopped.

## Evidence boundary

- Application: n8n **2.39.10**, operator-reported. The instance build SHA was not
  independently verified.
- Execution snapshots: AI Agent **3.1**, Structured Output Parser **1.3**,
  OpenAI Chat Model **1.2**, attached Workflow Tool **2.2**.
- Provider: synthetic `template-echo-model`, OpenAI-compatible Chat Completions.
  Responses are scripted; evidence measures orchestration, not model compliance.
- Manual Trigger, one input item, manually authored object schema, no memory,
  auto-fix disabled. Child workflow published when ordinary execution is needed.
- Source-inspection reference from the plan:
  `cfbd9a56cba2e73901dc1962e47727adbea0b23e`. This is a source reference, not a
  claim about the running instance's exact build.
- All measured requests are buffered. Streaming and Open Chat were explicitly
  excluded by the operator. Agent 2.2/3 captures were deferred.

## Captured behavior

Each linked directory contains observations, redacted workflow/execution and
provider JSON, and a manifest with raw source hashes, projected-file hashes,
node versions, and capture/projection timestamps. Request counts were observed
in the provider status and corroborated by saved model sub-runs; raw status
snapshots remain in ignored staging.

| Case and evidence | Provider requests | Observed result |
| --- | --- | --- |
| [Formatter only](../tests/fixtures/n8n/captures/2.39.10/f0-agent-3-1-buffered/observations.md) | 1 | Success; optional note omitted |
| [Ordinary tool then formatter](../tests/fixtures/n8n/captures/2.39.10/f0-agent-3-1-after-tool/observations.md) | 2 | Child runs; linked result reaches model; formatter ends run |
| [Wrapped final-text JSON](../tests/fixtures/n8n/captures/2.39.10/f0-agent-3-1-text-valid/observations.md) | 1 | Successful fallback |
| [Unwrapped final-text JSON](../tests/fixtures/n8n/captures/2.39.10/f0-agent-3-1-text-unwrapped/observations.md) | 1 | n8n adds output wrapper before parser; succeeds |
| [Invalid final text](../tests/fixtures/n8n/captures/2.39.10/f0-agent-3-1-text-invalid/observations.md) | 1 | JSON syntax failure |
| [Wrong field type](../tests/fixtures/n8n/captures/2.39.10/f0-agent-3-1-schema-invalid/observations.md) | 1 | Schema mismatch |
| [Missing required count](../tests/fixtures/n8n/captures/2.39.10/f0-agent-3-1-required-missing/observations.md) | 1 | Schema mismatch |
| [Explicitly forbidden extra key](../tests/fixtures/n8n/captures/2.39.10/f0-agent-3-1-extra-properties/observations.md) | 1 | Schema mismatch |
| [Formatter-first mixed calls](../tests/fixtures/n8n/captures/2.39.10/f0-agent-3-1-mixed/observations.md) | 1 | Formatter succeeds; ordinary call not dispatched |
| [Ordinary-first mixed calls](../tests/fixtures/n8n/captures/2.39.10/f0-agent-3-1-mixed-ordinary-first/observations.md) | 1 | Formatter succeeds; ordinary call not dispatched |
| [Duplicate formatter calls](../tests/fixtures/n8n/captures/2.39.10/f0-agent-3-1-duplicate/observations.md) | 1 | First of two distinct valid payloads selected; one parser run |
| [Authored nested output](../tests/fixtures/n8n/captures/2.39.10/f0-agent-3-1-nested-output/observations.md) | 1 | Authored output field preserved inside formatter wrapper |
| [Extra nested key, unspecified extras](../tests/fixtures/n8n/captures/2.39.10/f0-agent-3-1-nested-output-extra/observations.md) | 1 | Extra nested key stripped; run succeeds |
| [Streaming option enabled, actual buffered request](../tests/fixtures/n8n/captures/2.39.10/f0-agent-3-1-streaming-enabled-buffered/observations.md) | 1 | Success with stream false; not streaming coverage |

## Material differences for the design gate

**Schema conversion and parsing are distinct.** n8n adds an output wrapper and
closes a nested object in the provider-facing schema even when that authored
object omits additionalProperties. In the latter case, its parser accepts raw
arguments with an extra nested key, removes that key, and returns a successful
normalized result. With authored additionalProperties false, the separate
closed-schema capture rejects its extra property.

A validator enforcing the wire schema against raw arguments would reject the
stripping case. Applying only the authored schema without transformation would
retain the key. Neither automatically reproduces the captured normalization.
The existing Inference Lens evaluator must not be described as n8n-equivalent
or silently taught a generic stripping policy on the strength of this capture.

**Raw text, parser input, payload, and node output can differ.** Unwrapped fallback
text becomes generated wrapped parser input; raw model text remains unwrapped.
The final Agent item retains an output property. An authored nested output field
survives inside it. A future canonical answer API needs a deliberate selection
and deterministic text projection, with raw evidence retained separately.

**Formatter selection precedes ordinary dispatch in the tested mixed turns.**
Both mixed orders suppress the ordinary call. Duplicate valid formatters select
the first. Whether Inference Lens reproduces these behaviors or rejects
ambiguous combinations must be agreed explicitly before host dispatch changes.
Invalid-first duplicate calls and invalid-formatter mixed turns were not tested.

**Fallback and failures are observable policies.** Both tested valid text shapes
succeed; invalid JSON and schema mismatch have distinct failure contexts.
None of these failures caused a repair/continuation request with auto-fix off.
Generic missing-call policy need not implicitly match the n8n profile.

## Deferred and excluded coverage

No compatibility claim covers Agent 2.2/3, older formatter names/parser wrappers,
example inference, memory, repair/fallback models, nested Agent Tool execution,
other providers, root arrays/scalars, schema defaults/coercion, or general JSON
Schema conformance. Explicitly exclude these until separately designed and
measured. Streaming/Open Chat are outside this requested scope.

## Commit boundary and next phase

Commit the capture harness, staging recipes, reviewed redacted fixtures, evidence
assertions, and documentation as one capture-only change. Keep .env and all raw
staging files out of Git. Raw files are retained locally for provenance and
possible re-projection; do not delete them merely to make the commit look clean.
The original inactive-child failure remains raw diagnostic evidence rather than
a successful ordinary-tool fixture.

No more home-instance executions are required for the selected phase. Next,
review the plan's material decisions with the user: provider-neutral execution
ownership and revision-owned configuration; designated tool identity; supported
validator/normalization subset; mixed/duplicate-call policy; fallback rules;
effective-answer projection; and project/trace/plan/assessment migrations.
Update the design plan to state the narrowed version/delivery scope and the
normalization finding before runtime implementation. This is a design gate,
not permission to implement unresolved contracts.

Browser E2E is not required for this capture-only change: no Inference Lens UI,
production provider adapter, or app execution path changed. Local capture-server
tests do not substitute for later app/CLI acceptance or native verification.

## Capture-phase verification

- `npm run test:n8n-contract`: 103 passed, none failed.
- `node --test --test-timeout=120000 tests/fixture-shutdown.test.mjs`: 14 passed.
- `npm run typecheck` and `npm run typecheck:core`: passed.
- `npx eslint . --ignore-pattern dist --ignore-pattern .next --ignore-pattern
  '.claude/**'`: no errors; four existing unused-variable warnings. The standard
  lint command previously scanned an unrelated .claude worktree's generated
  bundles and failed there; the exclusion avoids that unrelated checkout.
- `git diff --check`: passed. Local Markdown links in commit candidates resolve.
- All 14 new capture manifests and projected hashes validate. The 123 changed/new
  candidate files were scanned against configured secrets and private instance
  strings; projected JSON was additionally checked against captured instance
  identifiers. No matches remained. Environment and raw staging paths are
  ignored and absent from the candidate set.
- Provider shutdown confirmed by connection refusal on the former capture port.

No app E2E, full application build/test suite, native Tauri execution, or live
model reliability test was run for this capture-only slice. The n8n home-instance
runs described above are live orchestration evidence with scripted responses.
The capture commit excludes environment files and raw staging.
