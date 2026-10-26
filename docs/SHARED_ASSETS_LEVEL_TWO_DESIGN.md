# Shared assets Level 2: ownership and migration review

**Status:** Slice 2a proposal, October 26, 2026. This document applies the
[approved Level 2 direction](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md#confirmed-design-choices-october-25-2026)
to Project v15 at `214bf7e`. It does not approve new contracts or implement
persistence. Assume the System One prompts/evaluations branch lands unchanged.
The next step is review of the decisions below, followed by final codecs and
recovery contracts before slice 2b starts.

## Review recommendations

| Decision | Recommendation | Alternative and tradeoff |
| --- | --- | --- |
| Shared format | Propose v16: remove both template kinds' `draft`; retain the other v15 fields and treat `defaults` as authored launch defaults. | Rename/restructure defaults now: clearer naming, but more migration and CLI churn without changing ownership. |
| Legacy defaults | Copy existing selections/settings into personal state; retain all legacy defaults in shared definitions. Migration preview does **not** offer demotion in this slice. | Offer selective demotion: needs optional-default semantics and a policy for a clone with no launch request/target. Design separately. |
| Local data | Typed asset drafts, scratch requests, selections and execution overrides; never a second complete project. Propose workbench schema v1. | A whole-project shadow is simpler initially but creates competing definitions and ambiguous publication. |
| Recovery granularity | One record per draft/scratch request plus a selections record; protect the directory before writing any content. | One state file gives simpler writes but unrelated drafts conflict and one invalid file blocks all recovery. |
| Incomplete editors | Recover typed editor buffers, including invalid decision JSON, independently of executable content. | Recover only valid content: cheaper, but loses precisely the unfinished work recovery is intended to protect. |
| Conflict recovery | Retain both sides, stop automatic writes to the affected record, and require explicit reconciliation; keep source snapshots for comparisons. | Automatic merge/rebase introduces new semantics, especially for ordered decision input. |
| Personal backup | Separate versioned backup of personal records and required local dependencies; preview restore, never overwrite automatically. Evidence remains a separate export. | Full-folder archive carries evidence too, but obscures what is portable and greatly increases scope. |

These are proposals for review, including the version numbers. The concurrent
write guarantee also has an implementation feasibility question described below;
it cannot be resolved merely by approving a filename layout.

## Inventory rules and sources

**Keep** means preserve legacy saved content in the shared document. **Move**
means copy to verified local recovery before removing from the new shared
document. **Copy** means keep the shared value and seed personal state with it.
**Local** means personal state only; **device** means existing host stores, not
portable recovery. No classification infers privacy from a value's contents.

Inventory sources are the actual [v15 contract](../packages/core/src/project.ts),
[suite types](../packages/core/src/evaluation-suites.ts),
[checks](../packages/core/src/checks.ts),
[import receipt types](../packages/core/src/external-prompt-import.ts), and
[decision editor model](../app/decisions/decision-draft.ts). Grouped paths below
enumerate fields with identical treatment; a JSON payload stays intact unless
an explicit rule says otherwise. This is a semantic migration, not a promise
that reserialization preserves whitespace. The untouched source preserves bytes.

### Project identity, connections and launch defaults

| v15 path | Migration | Future writer/meaning |
| --- | --- | --- |
| `schemaVersion` | 15 → proposed 16 | Core versioned codec; old v15 writer rejects v16. |
| `projectId`, `name` | Keep | Explicit project metadata edit; identity validates local association. |
| `connectionRequirements[].id`, `.name`, `.provider`, `.endpoint` | Keep | Explicit portable declaration edits; no local profile IDs or credentials. |
| `connectionRequirements[].capabilityOverrides` | Keep all keys | `chatCompletions`, `responsesApi`, `anthropicMessages`, `streaming`, `modelDiscovery`, `tools`, `parallelToolCalls`, `structuredOutput`, `vision`, `embeddings`. Actual capabilities/resolution remain device concerns. |
| `defaults.conversationRevisionId` | Copy | Authored launch pin stays shared; currently selected request/revision becomes local. |
| `defaults.decisionRequestRevisionId` | Copy if present | Same; absence stays absence. Do not select a request just because a suite uses it. |
| `defaults.target.connectionRequirementId`, `.model`, `.protocol` | Copy | Shared launch target; trying another target only changes personal execution state. |
| `defaults.options.temperature`, `.maxOutputTokens`, `.seed`, `.stop`, `.providerOptions` | Copy | Shared launch options; trial overrides are local. Keep provider option payloads, including ordering where meaningful, opaque to ownership classification. |
| `defaults.enabledToolIds` | Copy | Shared launch tool selection; changing the active selection is local. |

Decision Compose's selected target is personal. A decision suite's System One
target remains its own authored execution target. Do not manufacture a shared
decision launch target from the chat target or a template recommendation.
Migration has no serialized legacy decision-target selection to recover.

### Prompts: both kinds, every saved revision

| v15 path under `promptTemplates[]` | Migration | Future writer/meaning |
| --- | --- | --- |
| `id`, `kind`, `name`, `archivedAt` | Keep | Explicit metadata actions; kind remains fixed. |
| `currentRevisionId` | Keep | Explicit revision publication/current-pointer choice, never editor navigation. |
| `recommendedTarget.connectionRequirementId`, `.model` | Keep | Explicit recommendation edit; trying a model does not change it. |
| `revisions[].id`, `.createdAt`, `.name` | Keep | Immutable checkpoint identity/metadata. |
| `revisions[].variableDefaults` | Keep | Deliberately saved defaults; preserve missing keys versus `""`. |
| Chat `revisions[].messages[].role`, `.content` | Keep | Ordered authored messages, including native variable tokens. |
| Chat `revisions[].externalImportId` | Keep | Pin to durable import provenance, not to a run artifact. |
| Decision `revisions[].decision.state`, `.questions` | Keep | Entire ordered authored input; question/choice order must not be canonicalized away. |
| `draft.sourceRevisionId`, `.revisionName`, `.variableDefaults` | Move | Local draft names its template, kind and source revision, preserving all edited values. |
| Chat `draft.messages` / decision `draft.decision` | Move | Same local draft envelope, separate content arms. Do not publish the draft as a new revision during migration. |

Within every decision input, preserve `state` (text/object/array), ordered
question IDs, each question's `type` and `instructions`, and `criteria`: ordered
choice label/value entries, ordered score levels, or optional noul `true`/`false`
values. No variables are rendered during migration. Editor-selected template,
revision and return target are local; search text, focus and open dialogs are
transient UI state and need no recovery promise.

### Chat requests and branches

| v15 path | Migration | Future writer/meaning |
| --- | --- | --- |
| `conversations[].id`, `.name` | Keep | Explicit saved request identity/name. |
| `conversationRevisions[].id`, `.conversationId`, `.parentRevisionId`, `.createdAt` | Keep | Keep every branch, including branches that look experimental. |
| `conversationRevisions[].items` order and `.kind` | Keep | Authored structure; do not flatten pinned uses to rendered messages. |
| Literal `.message.id`, `.role`, `.content[].type`, `.content[].text` | Keep | Authored content, even if originally copied from evidence. |
| Assistant `.message.toolCalls[].id`, `.providerCallId`, `.name`, `.arguments.text`, `.arguments.parsed` | Keep | Saved tool-call content and IDs, not live executor state. |
| Tool `.message.toolCallId`, `.name` | Keep | Preserve call/result association. |
| Literal item `.externalImportId` | Keep | Preserve its receipt. |
| Template `.use.id`, `.templateId`, `.templateRevisionId`, `.values`, `.outputMessageIds` | Keep | Exact pin, saved assignments and emitted message identities. |

Existing conversation revisions are not labeled drafts in v15. Do not move or
delete any on a guess. After migration, edits create a local draft against the
saved revision, and experimental branches stay local until explicitly saved.
Running must no longer materialize a shared request merely to obtain an ID.
Keep atomic multi-message uses and the existing detach-before-branching-inside-a-use
rule. Local branch parents may be local snapshots or saved revision pins; their
distinction must be represented, not encoded as a fake shared ID.

### Decision requests

| v15 path | Migration | Future writer/meaning |
| --- | --- | --- |
| `decisionRequests[].id`, `.name` | Keep | Saved asset identity/name. |
| `decisionRequestRevisions[].id`, `.decisionRequestId`, `.parentRevisionId`, `.createdAt`, `.kind` | Keep | Every existing inline and template-backed branch, including suite-only requests. |
| Inline `.decision`, `.values` | Keep | Authored tokens and saved assignments; no normalization to an empty assignment. |
| Template-use `.templateId`, `.templateRevisionId`, `.overrides` | Keep | Sparse overrides stay sparse; do not replace them with resolved defaults plus overrides. |

Template defaults → saved request overrides → trial overrides → case assignments
(for a suite execution) remain explicit layers, with the applicable later layer
winning by key presence. Do not change existing suite resolution precedence.
The latest branch's evaluation creation/retarget commands deliberately use
`activate: false`: suite-only request creation must not move personal Compose
selection or the shared launch pin. Saved prompt edits do not move request or
suite pins. Local update/detach must preserve the same inheritance and ordering
rules before intentional publication.

### Tools, mock fixtures and imports

| v15 path | Migration | Future writer/meaning |
| --- | --- | --- |
| `tools[].id`, `.name`, `.description`, `.inputSchema`, `.providerOptions` | Keep | Portable descriptor; deliberate edits are shared contributions. |
| `tools[].source.kind`, `.remoteToolName`, `.discoveryFingerprint` | Keep | MCP descriptor provenance; actual binding stays on the device. |
| `toolMocks[].id`, `.toolId`, `.name`, `.enabled`, `.match.kind` | Keep | Existing fixture and its authored activation default. Trial activation is a local override. |
| `toolMocks[].result.content[].type`, `.text`, `.isError` | Keep | Existing saved mock response content, even if sensitive-looking. |
| `externalImports[].id`, `.importedAt`, `.importerVersion`, `.sourceDigest`, `.fidelity` | Keep | Durable provenance, not temporary import staging. |
| `.source.adapter`, `.resource.{kind,id,name}`, `.execution.{id,executedAt}`, `.version` | Keep | Secret-free external identity. |
| `.invocation.{id,name,type,version,runIndex,itemIndex}` | Keep | Selected external invocation identity. |
| `.authored[].{path,role,syntax,text,contentSpan}` | Keep | Includes span `startOffset`/`endOffset`. |
| `.bindings[].{authoredPath,expression,source,resolvedValue,status,valueEvidence}` | Keep | Includes source `kind`/span offsets and evidence `kind`/`path`; resolved values are part of saved provenance. |
| `.warnings[].{code,severity,message}` | Keep | Preserve import limitations. |
| `.projection.kind`, template projection `.templateId`, `.templateRevisionId`, `.variables[].{bindingIndex,authoredPath,expression,variableName}` | Keep | Preserve original projection and its pins. |

New temporary tools/fixtures and import staging belong to local dependency
records, not the shared arrays. Persist only the approved secret-free projection
of staging content, never raw external executions or credential-bearing payloads.
Saving an asset previews and copies required definitions/receipts, without copying
unrelated scratch work. Existing import receipts cannot be pruned merely because
the current local editor detached or removed a use.

### Evaluation suites, cases and checks

| v15 path under `evaluationSuites[]` | Migration | Future writer/meaning |
| --- | --- | --- |
| `id`, `name`, `input.kind`, `.conversationRevisionId` or `.decisionRequestRevisionId` | Keep | Authored suite pin; retain even if not selected in the UI. |
| `execution.target.{connectionRequirementId,model,protocol}`, `.repetitions` | Keep | Both suite kinds declare execution intent. Never replace with personal settings on load. |
| Chat `execution.responseMode`, `.options`, `.toolIds`, `.turnCeiling` | Keep | Same option leaves as project defaults. Decision suites gain none of these fields. |
| `variants[].id`, `.name`, `.overrides.target` | Keep | Sparse target fields remain sparse. |
| Chat variant `.overrides.responseMode`, `.options` | Keep | Preserve absent/inherited versus `null`/removed option; `providerOptions` replaces the base object as today. |
| `inputBindings[].id`, `.name`, `.target.kind`, `.variableName`, chat `.templateUseId` | Keep | Case inputs target exact use/variable or decision variable. |
| `cases[].id`, `.name`, `.values`, `.referenceAnswer` | Keep | Reusable case inputs and authored reference text, including copied evidence. |
| `cases[].checks[]` | Keep all fields | Check vocabulary remains 5; no new check schema implied by Project v16. |

Check inventory: common `checkId`, optional `label`, and `kind`; text checks
`value`, `negate`, `caseSensitive`, `trimWhitespace`; regex `syntax`, `pattern`,
`flags`, `negate`; valid JSON `topLevel`, `inputPolicy`, `negate`; JSON Schema
`dialect`, `schema`, `inputPolicy`; maximum checks `limit`; tool checks `toolName`,
`count`, `comparator`, `argumentsSubset` as applicable; decision checks
`questionId`, `option`, `negate`, `comparator`, `value`, `min`, `max`, `atLeast`
as applicable. Preserve the current discriminated check arms and strict parser.

Editing suite definitions/cases is intentional authoring, but unfinished edits
should recover locally and publish through an explicit suite save. Selected
suite/cases/configurations, focused case, evidence comparison and temporary run
controls are personal. Execution resolves a snapshot and records overrides in
evidence; it does not rewrite the suite. Promoting a trace to a case copies the
reviewed authored values/checks into shared content; the source link stays local.

### Data already outside the manifest

| Data | Classification and migration |
| --- | --- |
| `traces/`, `experiments/` (plans/results/reassessments) | Local evidence; retain paths and historical codecs. No migration rewrites. |
| `evaluation-baselines.json`: `schemaVersion`, `baselines[].baselineId`, `.suiteId`, `.experimentId`, `.variantId`, `.name`, `.pinnedAt` | Local annotations; retain file and version 2. Missing evidence is nonfatal. |
| `evaluation-case-sources.json`: `schemaVersion`, `sources[].suiteId`, `.caseId`, `.runId`, `.capturedAt`, `.experimentCellId` | Local annotations; retain file and version 1. Missing source does not invalidate the case. |
| Profile mappings, credentials, provider declarations, executor bindings/grants | Device stores; neither shared definitions nor personal backup. Their existing lookup identities are not a workbench identity. |
| Browser folder handles/native workspace IDs and display paths | Host access metadata; exclude from portable records/backups. |
| Template run overrides, active selections, response mode, trial tool settings | Local recoverable selections/overrides after Level 2; existing unsaved session values can only be captured from the live session. |
| Decision raw JSON, incomplete rows, retained options across type changes, state mode, assignments | Local editor buffer; no on-disk legacy value exists to migrate. Recovery and execution validation are distinct. |
| Session templates, pending chat branches, scratch requests | Local typed records; stable local IDs, explicit promotion to shared assets. |
| Dialog/focus/loading/errors and active network sessions | Transient; reconstruct diagnostics, never resume a provider call from a recovery file. |

## Concrete migration examples

The three linked JSON files form one coherent example, covering both prompt
kinds, chat and decision branches, both suite kinds, a saved mock, import
provenance, saved empty values and absent assignments:

- [Before: valid Project v15](examples/shared-assets-level-two/project-v15.json)
- [After: proposed shared Project v16](examples/shared-assets-level-two/project-v16.proposed.json)
- [After: proposed local records](examples/shared-assets-level-two/workbench-records.proposed.json)

The local example is a **review bundle of records**, not a proposed single-file
store or personal-backup codec. Its `records` keys illustrate relative filenames.
Sample IDs and contents are illustrative. The shared after-file differs only by
version and removal of the two explicit template drafts. Every other field is
preserved, including arrays and authored decision key order.

| Example | Before → after | First experiment after migration |
| --- | --- | --- |
| Prompt | `template_chat` keeps revision 1 and its import receipt; draft text/defaults/name move to its local record. `template_decision` does the same with ordered decision input. Neither current pointer moves. | Editing the prompt updates only its local draft. Saving revision 2 preserves revision 1 and all existing uses. |
| Chat request | Both parent and child revisions remain; the child's saved `topic: "migration safety"`, template pin and message IDs remain. `defaults.conversationRevisionId` remains the child and is copied to local selection. | Trying `topic: "latency"` and another model changes local overrides. Save-as-asset previews these assignments; merely running does not save them. |
| Decision request | Inline parent and template-use child remain. Child has `ticket: ""` as an intentional override and no `region` override, so `region: "global"` still inherits. Its shared/default and local-selected revision IDs match initially. | Trying another ticket stays local. Updating the template pin remains explicit and retains only overrides for surviving variables. A suite-only retarget does not activate this request. |
| Evaluation suite | Chat suite still pins the parent chat revision; decision suite pins the decision child. Both retain cases, checks, variants and execution targets. Suite selection is absent because v15 stores none. | Selecting one case or a comparison is local. Editing a case creates a local suite draft. Explicit save publishes that case; running it produces evidence with the effective settings. |

The preview must say: **“Move 2 prompt drafts into this folder's personal
workbench. Keep all saved requests, branches, values, fixtures, imports and
suites shared. Keep existing launch defaults shared and copy them into your
personal selections. This migration does not make previously saved content
private.”** It must also explain that original bytes are preserved under the
ignored recovery directory. There is no heuristic demotion option here.

No legacy temporary fixture can be identified from `toolMocks`: every existing
entry stays shared. The sample's `enabled: true` stays an authored default;
turning it off for a trial should create a local activation override. Likewise,
old baseline/source annotations are untouched beside the manifest; a clone
without those files still opens both suites.

## Proposed contracts and owners

### Types and execution boundary

Core should own `SharedProjectFileV16` and discriminated recovery DTOs in a
separate module, rather than putting mutable workbench fields back on
`ProjectFile`. The proposed draft envelope has `schemaVersion`, `projectId`,
`draftId`, `asset` (kind and ID), `base` (revision ID where applicable and a
source-content snapshot), and `edited` (typed editable fields). Revisionless
assets such as suites/tools use an exact base snapshot/digest, not an invented
revision. Source snapshots are bounded to the edited asset; they are not a
duplicate project. Retain required pinned dependency snapshots when local work
needs to survive deletion of its source. Do not silently substitute them into a
shared dependency graph with a conflicting ID.

Use separate arms for chat prompt, decision prompt, chat request, inline decision
request, template-use decision request, suite, tool, mock and import staging.
Scratch records have a local identity and optional parent reference, not a
claimed persisted asset ID. Drafts carry edited fields or complete editable
content arrays; arbitrary JSON Patch paths would couple recovery to shared
serialization and make order-sensitive edits harder to validate.

Editor-buffer DTOs must capture invalid/incomplete text without claiming to be
`DecisionInput`. Propose a versioned representation of the existing form/JSON
model, preserving row IDs and inactive values but recomputing errors. A strict
recovery codec validates the buffer's shape; executable-content validation
still blocks a run or publication. The same principle applies to unfinished
checks and tool schemas. Exact arms and limits need contract review before code.

Personal selections name saved revisions or local records via a discriminated
reference. Execution settings have chat/decision arms. Proposed override
semantics: absent field inherits; explicit empty strings/arrays are values;
nullable optional inference-option fields clear the inherited value; a present
provider-options object replaces it. Reuse the suite override convention rather
than inventing deep merging. Do not copy credentials into these records.

Resolved runs receive one validated snapshot built from shared assets plus the
selected local input and explicit overrides. Existing provider adapters keep
wire serialization. No run writes its input into shared definitions as a
side effect. Historical traces/plans keep their formats and IDs; audit existing
run identity requirements before selecting how new local runs record provenance.
If those codecs require an asset pin for scratch input, an explicit evidence
format decision is required rather than emitting a false shared reference.

| Owner | Proposed responsibility/contract |
| --- | --- |
| Core project/recovery modules | Strict independent codecs, migration planning, reference validation, publication operations and resolution from typed inputs. Parsing alone never writes files or drops legacy drafts. |
| New `usePersonalWorkbench` | Checkout lifecycle, record load/save queue, recovery status, selections, conflict association and project replacement guards. Expose typed `readDraft`, `updateDraft`, `saveRecovery`, `publishDraft` operations with explicit outcomes. |
| `useProjectWorkspace` | Loaded shared definitions, expected manifest state, explicit shared publication and folder lifecycle. Stop folding personal edits into `currentProjectDocument()`/auto-save. |
| `useProjectTemplates` and chat/decision editors | Per-template draft content, source revision, metadata save intent and selected revision. Route draft persistence through personal owner. |
| Chat composer/branch owner; `useDecisionProject` / `useDecisionCompose` | Local request/branch lifecycle and explicit promotion. Replace run-time folding/freezing into shared arrays with local snapshots. |
| `useEvaluationSuiteAuthoring` | Local suite draft and explicit suite publication; retain case data during pin repair and preserve `activate: false`. |
| Tool/import feature owners | Temporary definitions and staging versus intentional publication; preview required dependency copies. |
| `WorkspaceStorage`, browser directory adapter, Rust filesystem commands | Protected recovery directory, read/write results, expected-content checks and recoverable I/O. No duplicate policy generator in Rust. |
| CLI `openNodeProjectFolder` | Read shared definitions and resolve suites without opening `.workbench/`; legacy read compatibility remains read-only. |
| `app/page.tsx` | Compose these handles and genuine cross-feature adapters. No draft queues, serialization or migration workflow in the route. |

### Layout, identity and concurrent writes

Proposed layout (filenames and record codec remain subject to approval):

```text
.workbench/
  .gitignore                 # exact bytes "*\n", confirmed before content
  selections.json            # v1, projectId, typed selection/override fields
  drafts/<draft-id>.json      # v1, projectId, typed base and edited fields
  scratch/<local-id>.json     # v1, projectId, local request/dependencies
  operations/<operation-id>.json
  migrations/<operation-id>/source.project.json
```

Each record validates `projectId`. A mismatch disables restore and writes to the
existing store, leaves files intact, and offers inspection/backup or explicit
creation of a separate store after preserving the old one. Do not reassign its
project ID. Missing/deleted bases remain recoverable orphaned drafts; offer a
comparison and save-as-new action, not automatic rebase. An unknown or corrupt
record must not prevent shared assets from opening, nor be overwritten by an
empty record. Surface unavailable recovery per record.

Use the existing expected-contents mechanism at the adapter boundary and update
its expected value only after successful write confirmation. On a detected
conflict, preserve in-memory edits and the disk record, stop retrying that record,
and offer comparison plus explicit adoption/save-as-new. Unaffected records can
continue recovering. Reloading must never discard unpersisted work implicitly.

**Feasibility issue to resolve before persistence implementation:** today's
browser `browserStorage.save` and native `save_project` compare then write. That
detects stale loaded state but is not an atomic compare-and-swap across hosts.
Two writers can both read the same bytes before either writes. Per-record files
reduce conflict frequency; they do not prove the approved “no silent overwrite”
guarantee. A post-write reread alone cannot close that race either.

Retain expected-content checks, but first establish a cross-host strategy that
preserves both candidate writes (for example immutable candidate generations
with parent tokens and explicit detection of competing heads) or a demonstrated
cross-host exclusion primitive. Candidate generations add journal/cleanup and
publication semantics; browser-only locks cannot coordinate native writers.
Recommend a focused feasibility investigation before approving the final record
layout. Weakening the guarantee to best-effort detection requires an explicit
product decision, not an undocumented implementation shortcut. The illustrative
mutable record paths above may become logical record names over generations.

### Publication and migration recovery

Ordinary publication needs its own durable operation, not only migration:

1. Confirm local protection/recovery, freeze the specific draft version and
   dependencies, allocate intended revision IDs once, and record publication
   intent with the expected shared source and intended output.
2. Validate and write shared definitions with external-change detection. Preserve
   the draft if the write fails or conflicts. Do not advance the in-memory saved
   indicator until the shared write is confirmed.
3. Confirm the resulting shared content, then mark that draft version published
   and clear/archive only that version. Edits made while saving remain a newer
   local draft, never something the older completion callback can clear.
4. On restart, compare the operation's intended IDs and content with the shared
   document. An exact match recognizes published-but-not-cleared work without
   appending another revision. Conflicting/missing content requires review;
   matching only an ID is insufficient. No-op content saves need the same
   confirmation before clearing a draft.

Migration must preserve the original **raw bytes**, before the existing v10→v15
parse chain normalizes them. Proposed sequence:

1. Read and validate supported source; compute the v15-normalized inventory and
   proposed v16/local outputs in memory. Show preview; opening alone does not
   approve an on-disk migration. Keep no-folder inputs session-only.
2. Confirm `.workbench/.gitignore`, then write/read back the untouched source and
   migration intent. Do not put legacy backups beside `project.json`.
3. Write and verify all extracted drafts and selection seeds. If personal state
   already exists, retain it and stage migration candidates for reconciliation;
   do not overwrite it or seed over existing personal selections.
4. Recheck the original manifest and confirm all local outputs before writing
   v16. A failure through this step leaves the original or its verified untouched
   backup plus verified recovery candidates. Never remove the only draft copy.
5. Confirm v16, mark completion, and keep the source backup. Interrupted runs
   compare source/output digests and record identities; they neither duplicate
   drafts nor overwrite an independently edited manifest. Truncated/unrecognized
   outputs require explicit recovery from preserved candidates.

Exact journal fields, generation/write atomicity, hashing rules (including
ordered decision subtrees), retention, size limits and failure outcomes are
still design work. An implementation cannot claim this sequence safe until it
has concrete restart cases for every write boundary on both hosts.

### JSON, CLI and backup compatibility

Recommend separate APIs for legacy decoding/migration planning and for strict
v16 shared decoding. Returning only v16 from today's `parseProjectJson` would
silently lose extracted drafts for callers that know nothing about recovery.
A migration result must carry source version, preserved source bytes, shared
candidate, extracted personal records and preview diagnostics.

Existing v10–v15 JSON remains importable through the strict one-version chain;
older unsupported formats stay unsupported. JSON imports have session-only
recovery until a folder is chosen. Default export is v16 shared definitions;
personal backup is explicitly selected. Do not silently down-export v15 by
reintroducing personal drafts. An old build must reject v16, not open it as an
editable empty project. No-folder export wording must state that unsaved drafts
are excluded and offer personal backup before replacement/closing.

The CLI may read legacy definitions in memory without writing a migration or
using explicit template drafts. v16 execution uses only saved request/suite pins
and authored launch defaults. Audit commands using `project.defaults` and retain
documented shared-default behavior or require explicit input; never consult the
operator's selections. App/CLI immutable evidence coexistence remains unchanged.

Propose a personal-backup v1 envelope with project identity, logical local
records, necessary source/dependency snapshots and publication/migration status.
It excludes credentials, profiles, handles, grants and raw evidence. Restore
previews matching project identity, collisions, missing bases and stale pins;
preserves existing records; and creates candidates rather than overwriting or
publishing. Cross-project restore requires an explicit copy/remapping design,
so initially reject it with a useful explanation. Backups must remain usable
without absolute paths. Exact backup codec is pending review.

## Review and verification handoff

Approve or revise the field classification and four migration examples first.
Then settle the proposed versions/default policy, incomplete-editor coverage,
record layout/concurrency strategy, publication/migration journal, backup codec
and compatibility APIs. The parent plan's contract checklist stays unchecked
until those decisions are accepted; this proposal does not start slice 2b.

For implementation, start with failing assertions on actual shared bytes and
recovered values, plus a real Git fixture with no bundle-level ignore rule.
Cover both template kinds, legacy branches, sparse/empty decision assignments,
suite-only retargeting, invalid buffers, orphaned bases, two concurrent writers,
each interrupted write boundary, no-folder imports and shared-only CLI runs.
Keep the existing provider fixtures; assert the trial values reached the provider
while the shared bytes did not change. Run the affected browser specs then the
full suite as required by [AGENTS.md](../AGENTS.md).

This slice changes documentation/examples only. Verification should parse the
v15 example with the current codec, check exact migration preservation and local
draft extraction, validate links/JSON, and run `git diff --check`. Proposed v16
and recovery examples have no production codec yet; those checks cannot prove
their future parser or filesystem recovery behavior. No browser run is needed.

### Checks performed October 26, 2026

- An inline `node --experimental-strip-types --input-type=module` check loaded
  the before-example through `parseProjectJson`, then used strict assertions to
  verify the complete after-document, ordered JSON content, both extracted drafts
  and base snapshots, and copied selections. It also confirmed the current
  reader rejects proposed v16. All assertions passed. The initial example used
  the wrong decision protocol spelling, `system-one`; the current parser caught
  it, and the example was corrected to `systemone` before these checks passed.
- Python parsed all three JSON examples and checked 19 relative link targets
  across this document and the parent plan; all passed.
- `git diff --check` passed for the tracked plan change; the new document and
  examples were checked separately for trailing whitespace and final newlines.
- No runtime, browser, CLI execution or Rust suite was run: no behavior changed.
  The JSON preservation assertions are example checks, not a migration test or
  a red regression run. No migration, workbench codec or recovery writer exists
  yet. Review should focus on ownership, the migration preview's sharing boundary,
  incomplete-editor recovery and the concurrent-write design gap.
