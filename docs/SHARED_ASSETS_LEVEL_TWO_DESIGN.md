# Shared assets Level 2: ownership and migration review

**Status:** Slice 2a review with an approved first core implementation slice,
October 26, 2026. This document applies the
[approved Level 2 direction](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md#confirmed-design-choices-october-25-2026)
to Project v15; the System One prompts/evaluations work has landed on main.
The user subsequently approved isolated core codecs and an in-memory migration
planner, with the application remaining on v15 until recovery storage is ready.
That [bounded slice](#first-core-slice-october-26-2026) is implemented. A subsequent
approved [recovery-store foundation](archive/SHARED_ASSETS_RECOVERY_STORE_SLICE.md)
adds opt-in browser/native filesystem adapters for those existing records.
Other recommendations below remain proposals; application recovery is not enabled.

**Renumbered 2026-10-29:** the staged shared format is now **v17**; v16 went
to the active format for [prompt environments](PROMPT_ENVIRONMENTS_PLAN.md),
which v17 will carry. Dated verification records and archived documents keep
the number that was current when they were written.
The subsequent approved [migration-journal foundation](archive/SHARED_ASSETS_MIGRATION_JOURNAL_DESIGN.md)
adds protected staging and read-only restart classification; it does not replace
the manifest or activate personal candidates.
The next [migration-completion proposal](SHARED_ASSETS_MIGRATION_COMPLETION_DESIGN.md)
defines opt-in manifest replacement and active-candidate recovery for review.
It does not approve application integration or the other proposals below.
Revised the same day after review: write safety, publication intent, launch
defaults, the v17 rationale and delivery order. The remaining integration
contracts still need review before application migration/publication starts.

## Review recommendations

| Decision | Recommendation | Alternative and tradeoff |
| --- | --- | --- |
| Shared format | Propose v17: remove both template kinds' `draft`; retain the other v15 fields and treat `defaults` as authored launch defaults. The bump exists to fence out old writers (see [why v17](#why-a-version-bump)). | Keep v15 and stop writing drafts: no migration journal, but old builds keep folding drafts and last-used selections back into the shared file. Rename/restructure defaults now: clearer naming, but more churn without changing ownership. |
| Legacy defaults | Copy existing selections/settings into personal state; retain all legacy defaults in shared definitions. Migration preview does **not** offer demotion in this slice. | Offer selective demotion: needs optional-default semantics and a policy for a clone with no launch request/target. Design separately. |
| Changing launch defaults | Only an explicit "Use as project launch default" action writes `defaults`, with a preview; branching, selecting and running never do. See [launch defaults](#changing-authored-launch-defaults). | No writer: defaults freeze at migration. Implicit writer: reintroduces the churn Level 2 removes. |
| Local data | Typed asset drafts, scratch requests, selections and execution overrides; never a second complete project. Propose workbench schema v1. | A whole-project shadow is simpler initially but creates competing definitions and ambiguous publication. |
| Delivery order | Slice 2b: template drafts (both kinds), selections/execution overrides, scratch and draft requests (both kinds), migration. Later slices: suite/tool/mock drafts, import staging, invalid-buffer recovery, personal backup. See [delivery order](#delivery-order). | All arms at once: one schema review, but the largest slice in the plan and most of it unrelated to what migration moves. |
| Recovery granularity | One record per draft/scratch request plus a selections record; protect the directory before writing any content. | One state file gives simpler writes but unrelated drafts conflict and one invalid file blocks all recovery. |
| Workbench write safety | Best-effort detection: expected-content check before each write, read-back after it, and same-host coordination where the host offers it. No cross-host atomicity claim. See [concurrent writes](#layout-identity-and-concurrent-writes). | Write-once generations with parent pointers: closes the race, but adds head resolution, cleanup and a record format no other store uses; browsers offer no exclusive create to do better. |
| Publication recovery | Record publication intent (intended revision ID and frozen content) in the draft record itself; no separate operation journal for ordinary saves. Migration keeps its journal. | A journal per publication: more general, but a second record to keep consistent with the draft it describes. |
| Incomplete editors | Slice 2b recovers valid editor content, as v15 drafts do today. A later slice recovers typed editor buffers, including invalid decision JSON. | Buffers in 2b: protects more unfinished work, but needs per-editor buffer arms before the core separation ships. |
| Conflict recovery | Retain both sides, stop automatic writes to the affected record, and require explicit reconciliation; keep source snapshots for comparisons. | Automatic merge/rebase introduces new semantics, especially for ordered decision input. |
| Personal backup | Later slice: separate versioned backup of personal records and required local dependencies; preview restore, never overwrite automatically. Evidence remains a separate export. | Full-folder archive carries evidence too, but obscures what is portable and greatly increases scope. |

The first core-slice approval accepts v17 and v1 for the bounded contracts
described below. The later recovery-store approval accepts the existing-record
layout, protection, identity blocking and write outcomes documented in its
[slice contract](archive/SHARED_ASSETS_RECOVERY_STORE_SLICE.md). The other recommendations
remain proposals for review. The write-safety
row revises the approved concurrent-writer choice; the
[parent plan](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md#confirmed-design-choices-october-25-2026)
records that revision.

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
| `schemaVersion` | 15 → proposed 17 | Core versioned codec; old v15 writer rejects v17. |
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

#### Changing authored launch defaults

Today `defaults` follows the operator: branching, choosing a request and editing
request settings rewrite it (for example `updateProjectDraft` copies the
composer's model, protocol, temperature and enabled tools into `defaults`). After v17 those
actions change personal selections only, so `defaults` needs a deliberate
writer or it freezes at its migrated value.

- **Writer.** An explicit "Use as project launch default" action in request
  settings copies the current personal selection into `defaults`: the selected
  chat request revision, target, options and enabled tools, and separately the
  selected decision request revision. The decision action never writes a chat
  target (see above). Each previews the shared fields it changes and is a shared
  save like any other, subject to the same external-change detection.
- **Selected request must be saved.** A scratch request or a local draft of a
  saved request is not a valid launch pin. Offer save-as-asset first; never
  write a reference to a local record into `defaults`.
- **Other writers.** Project creation keeps seeding `defaults`, because
  `conversationRevisionId` and `target` are required. Operations that delete,
  archive or detach a referenced entity keep their current validity rules for
  `defaults`. Nothing else writes it.
- **Status.** Show when the personal selection differs from the launch default,
  so "what a teammate or the CLI gets" stays visible without a Git diff.

The CLI is the main consumer: `repeated-run` repeats the run `defaults`
describes, and `evaluation-run` passes `defaults.conversationRevisionId` to suite
preflight. Both keep reading shared `defaults` and never personal selections.

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
choice label/value entries, ordered score levels, or optional `noul` `true`/`false`
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
| `cases[].checks[]` | Keep all fields | Check vocabulary remains 5; no new check schema implied by Project v17. |

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
- [After: proposed shared Project v17](examples/shared-assets-level-two/project-v17.proposed.json)
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

Core should own `SharedProjectFileV17` and discriminated recovery DTOs in a
separate module, rather than putting mutable workbench fields back on
`ProjectFile`. Every record carries a top-level `kind` discriminator
(`"draft"` or `"selections"` in v1; scratch records add their own arm). The
draft envelope has `schemaVersion`, `kind`, `projectId`, `draftId`, `asset`
(kind and ID), `base` (revision ID where applicable and a
source-content snapshot), and `edited` (typed editable fields). Revisionless
assets such as suites/tools use an exact base snapshot/digest, not an invented
revision. Source snapshots are bounded to the edited asset; they are not a
duplicate project. Retain required pinned dependency snapshots when local work
needs to survive deletion of its source. Do not silently substitute them into a
shared dependency graph with a conflicting ID.

Use separate arms for chat prompt, decision prompt, chat request, inline decision
request, template-use decision request, suite, tool, mock and import staging.
Slice 2b defines only the first five plus selections (see
[delivery order](#delivery-order)).
Scratch records have a local identity and optional parent reference, not a
claimed persisted asset ID. Drafts carry edited fields or complete editable
content arrays; arbitrary JSON Patch paths would couple recovery to shared
serialization and make order-sensitive edits harder to validate.

Editor buffers are slice 2d. Their DTOs must capture invalid/incomplete text
without claiming to be `DecisionInput`. Propose a versioned representation of the existing form/JSON
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
  drafts/<draft-id>.json      # v1, projectId, typed base, edited fields, publication intent
  scratch/<local-id>.json     # v1, projectId, local request/dependencies, publication intent
  migrations/<operation-id>/journal.json
  migrations/<operation-id>/source.project.json
```

Ordinary publication keeps its intent in the draft or scratch record it
publishes (see [publication](#publication-and-migration-recovery)); only
migration has a separate journal.

Each record validates `projectId`. A mismatch disables restore and writes to the
existing store, leaves files intact, and offers inspection/backup or explicit
creation of a separate store after preserving the old one. Do not reassign its
project ID. Missing/deleted bases remain recoverable orphaned drafts; offer a
comparison and save-as-new action, not automatic rebase. An unknown or corrupt
record must not prevent shared assets from opening, nor be overwritten by an
empty record. Surface unavailable recovery per record.

**Write safety is best-effort detection, not atomicity.** Today's browser
`browserStorage.save` and native `save_project` compare, then write. The native
mutex serializes writers inside one app process only. That detects stale loaded
state but is not a compare-and-swap: two writers can read the same bytes before
either writes. Browsers offer no exclusive create or atomic compare-and-swap on
folder files, so no layout built on them can close that window across hosts.
The approved choice was revised on October 26, 2026 to accept this for
workbench records (see the parent plan).

Each workbench record write therefore:

1. Coordinates writers on the same host where the host allows it: the native
   process mutex, and the Web Locks API (one lock name per record) across tabs
   and windows of the browser host.
2. Checks the record's expected contents, as `project.json` saves do today.
   A mismatch is a detected conflict.
3. Writes, then reads the record back. Only a matching read-back advances the
   expected value and the recovery status. A mismatch is a detected conflict.

On a detected conflict, preserve in-memory edits and the disk record, stop
retrying that record, and offer comparison plus explicit adoption/save-as-new.
Unaffected records continue recovering. Reloading never discards unpersisted
work implicitly.

The residual case is two processes on different hosts (browser and native app,
or two native app instances) writing the same record inside one
check-then-write window. The overwritten writer still holds its edits in memory
and detects the conflict at its next check or read-back. Edits are lost only if
that writer also closes before writing again. Status wording must not claim more
than this. The consequence is bounded to one personal record of one checkout, as
the parent plan intends one operator per checkout.

`project.json` keeps its existing expected-content check unchanged. Level 2 does
not strengthen it; it reduces how often personal activity writes it at all.

### Publication and migration recovery

Ordinary publication records its intent in the draft or scratch record being
published, not in a separate journal. The record is already the durable copy of
the work, so one file holds both the work and what was done with it:

1. Allocate the intended revision ID once. Write a `publishing` field into the
   record holding that ID, the base revision, and a frozen copy of the content
   being published. Confirm the record write (read-back) before step 2.
2. Validate and write shared definitions with external-change detection. On
   failure or conflict, remove `publishing` and keep the draft. Do not advance
   the in-memory saved indicator until the shared write is confirmed.
3. After confirming the shared write: if the record's current edits still equal
   the frozen content, delete the record. Otherwise edits were made while saving;
   keep them as a draft whose base becomes the newly published revision (whose
   content is the frozen copy, so this is not a rebase) and remove `publishing`.
4. On restart, a record with `publishing` is resolved against the shared
   document. A revision with the intended ID, the recorded parent and content
   equal to the frozen copy means it was published: finish step 3 without
   appending another revision. No such ID means the shared write never landed:
   remove `publishing` and keep the draft. The ID with different content is a
   conflict for review; matching only an ID is insufficient.

Comparing frozen content directly avoids choosing hashing rules for ordinary
publication. A no-op save (content equal to the base) clears the draft only
after the same confirmation. Revisionless assets in later slices (suites, tools)
use the same field with a base snapshot instead of a base revision.

Migration must preserve the original **raw bytes**, before the existing v10→v15
parse chain normalizes them. Proposed sequence:

1. Read and validate supported source; compute the v15-normalized inventory and
   proposed v17/local outputs in memory. Show preview; opening alone does not
   approve an on-disk migration. Keep no-folder inputs session-only.
2. Confirm `.workbench/.gitignore`, then write/read back the untouched source and
   migration intent. Do not put legacy backups beside `project.json`.
3. Write and verify all extracted drafts and selection seeds. If personal state
   already exists, retain it and stage migration candidates for reconciliation;
   do not overwrite it or seed over existing personal selections.
4. Recheck the original manifest and confirm all local outputs before writing
   v17. A failure through this step leaves the original or its verified untouched
   backup plus verified recovery candidates. Never remove the only draft copy.
5. Confirm v17, mark completion, and keep the source backup. Interrupted runs
   compare source/output digests and record identities; they neither duplicate
   drafts nor overwrite an independently edited manifest. Truncated/unrecognized
   outputs require explicit recovery from preserved candidates.

The approved [staging contract](archive/SHARED_ASSETS_MIGRATION_JOURNAL_DESIGN.md)
now settles journal fields, exact-byte hashing, retained snapshots and staging
failure outcomes. Its immutable journal has no completion marker. The next
[completion proposal](SHARED_ASSETS_MIGRATION_COMPLETION_DESIGN.md) would replace
steps 3–5 above with shared confirmation followed by absent-only activation,
derived progress and explicit pending-candidate outcomes. That ordering and
manifest replacement remain proposed until review; neither is implemented by
the staging foundation.

### Why a version bump

The shared change is small: v17 differs from v15 only by losing the two optional
template `draft` fields. A v15 document without drafts is already valid v15, so
the bump is not needed to describe the new shape. It is needed to keep old
builds from writing the old meaning back:

- A v15 build opening a draft-free file would recreate `draft` on the first
  prompt edit, putting personal work back into the shared file.
- It would also keep rewriting `defaults` on every branch, selection and
  settings change (`updateProjectDraft`), so `defaults` would stop meaning
  "authored launch default" as soon as anyone on the team used an old build.
- Because the separated drafts live in `.workbench/`, an old build would show
  none of them and could not warn that it was ignoring them.

A version an old reader rejects is the only fence the strict codec offers. The
cost is the migration machinery below: preview, preserved source bytes, journal
and restart recovery. Most of that cost comes from making the bump safe, not
from the field change itself. Keeping v15 remains a reviewable alternative if
mixed-build teams are not a concern, accepting the drift above.

### JSON, CLI and backup compatibility

Recommend separate APIs for legacy decoding/migration planning and for strict
v17 shared decoding. Returning only v17 from today's `parseProjectJson` would
silently lose extracted drafts for callers that know nothing about recovery.
A migration result must carry source version, preserved source bytes, shared
candidate, extracted personal records and preview diagnostics.

Existing v10–v15 JSON remains importable through the strict one-version chain;
older unsupported formats stay unsupported. JSON imports have session-only
recovery until a folder is chosen. Default export is v17 shared definitions;
personal backup is explicitly selected. Do not silently down-export v15 by
reintroducing personal drafts. An old build must reject v17, not open it as an
editable empty project. No-folder export wording must state that unsaved drafts
are excluded, and offer personal backup before replacement/closing once
slice 2e delivers it.

The CLI may read legacy definitions in memory without writing a migration or
using explicit template drafts. v17 execution uses only saved request/suite pins
and authored launch defaults. Audit commands using `project.defaults` and retain
documented shared-default behavior or require explicit input; never consult the
operator's selections. App/CLI immutable evidence coexistence remains unchanged.

For slice 2e, propose a personal-backup v1 envelope with project identity, logical local
records, necessary source/dependency snapshots and publication/migration status.
It excludes credentials, profiles, handles, grants and raw evidence. Restore
previews matching project identity, collisions, missing bases and stale pins;
preserves existing records; and creates candidates rather than overwriting or
publishing. Cross-project restore requires an explicit copy/remapping design,
so initially reject it with a useful explanation. Backups must remain usable
without absolute paths. Exact backup codec is pending review.

## Delivery order

Migration moves only template drafts and seeds selections, and the acceptance
criterion users feel first is that trial work leaves shared files byte-identical.
Slice 2b covers exactly that; later Level 2 slices add the rest of the arms.

| Slice | Delivers | Record arms |
| --- | --- | --- |
| 2b | v17 codec and migration; personal selections and execution overrides; "Use as project launch default"; chat and decision template drafts; scratch requests and drafts of saved requests (both kinds), so running and branching stop writing shared definitions; publication intent | chat prompt, decision prompt, chat request, inline decision request, template-use decision request, selections |
| 2c | Suite drafts and explicit suite save; tool and mock drafts, local mock activation; import staging | suite, tool, mock, import staging |
| 2d | Typed editor buffers for invalid or incomplete input (decision JSON, checks, tool schemas) | buffer arms per editor |
| 2e | Personal backup v1 and restore preview | backup envelope |

Until 2c, suite, tool and mock editors keep their current save behavior, and
the migration preview must not claim they are separated. Until 2d, recovery
covers valid editor content only, as v15 drafts do today. Until 2e, no-folder
and close/replace wording offers shared export only and says drafts are
excluded. Each later slice adds arms to the workbench v1 codec only if it can do
so without changing an existing arm; otherwise it versions the codec.

## Review and verification handoff

The first core slice implements the approved preservation/default policy and
versioned migration outputs. Before persistence, settle the launch-default action,
the 2b record arms, record layout, publication intent, migration journal and
compatibility APIs. 2c–2e contracts are reviewed with their slices. The parent
plan's contract checklist stays unchecked until those decisions are accepted;
the bounded core approval does not approve the remaining integration contracts.

For implementation, start with failing assertions on actual shared bytes and
recovered values, plus a real Git fixture with no bundle-level ignore rule.
Cover both template kinds, legacy branches, sparse/empty decision assignments,
suite-only retargeting, orphaned bases, launch-default writes, two tabs writing
one record (Web Locks), an injected stale expected value and a mismatched
read-back, a restart at each publication-intent and migration write boundary,
no-folder imports and shared-only CLI runs. Later slices add their own cases,
such as invalid buffers in 2d.
Keep the existing provider fixtures; assert the trial values reached the provider
while the shared bytes did not change. Run the affected browser specs then the
full suite as required by [AGENTS.md](../AGENTS.md).

The original slice 2a changed documentation/examples only. Its verification parsed the
v15 example with the current codec, checked exact migration preservation and local
draft extraction, validated links/JSON, and ran `git diff --check`. At that point
v17 and recovery examples had no production codec; those checks did not prove
parser or filesystem recovery behavior. Core implementation evidence follows.

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
  the 2b scope, the launch-default writer and the best-effort write-safety
  decision.

## First core slice, October 26, 2026

**Approved scope:** isolated core codecs and an in-memory migration planner.
Project v17 excludes both prompt kinds' explicit drafts. Workbench v1 receives
those drafts and copied selections; all other saved content and launch defaults
stay shared. The app stays on v15 until recovery storage is ready. This is the
first part of 2b, not completion of Level 2 or authorization to start writing v17
from existing save paths.

### Implemented contracts

- [shared-project.ts](../packages/core/src/shared-project.ts) owns
  `SharedProjectFileV17`, its draft-free `SharedPromptTemplate` union, and
  `parseSharedProjectFile`, `parseSharedProjectJson`, `serializeSharedProjectFile`.
  These APIs accept only v17. They reuse the existing saved-content/reference
  validators behind an explicit v17 gate and reject any prompt `draft` field.
  v17 also rejects known secret field names anywhere in default and tool
  provider options, including inside arrays, which the v15 check skips. The
  v15 parser keeps its existing behavior so current folders still open.
  They do not silently extract personal data during parsing. Serialization keeps
  the existing deterministic field order, decision order and tool-schema order.
- [personal-workbench.ts](../packages/core/src/personal-workbench.ts) owns
  `WorkbenchPromptDraftV1`, `WorkbenchSelectionsV1`, `WorkbenchRecordV1`,
  `parseWorkbenchRecord`, `parseWorkbenchRecordJson`, and
  `serializeWorkbenchRecord`. These implement the two prompt arms and selection
  seed shapes shown in the examples. Each record has a top-level `kind`
  (`"draft"` or `"selections"`) and parsing selects its schema from that field
  only; `asset.kind` distinguishes draft arms. Serialization puts the envelope
  first and orders nested saved content as `project.json` does. Drafts keep an asset ID/kind, source revision
  ID, source revision snapshot, and edited fields. The base ID must equal the
  snapshot ID. An optional expected project ID checks association. Structural
  parsing needs no live project and therefore permits orphaned bases for later
  recovery; it does not authorize publishing them.
- Chat execution selections permit sparse target/option overrides. Absent
  fields inherit, null clears an optional inference option, and present arrays
  and provider-option objects are replacement values. The codec preserves this
  distinction; this slice adds no execution resolver. Migration supplies the
  existing target/options/tools. Decision selection seeds contain only the saved
  request pin; no decision target is invented. Unknown fields/versions and
  unsupported record arms are rejected. Known secret field names in template
  defaults and execution provider options are rejected, including nested arrays
  in the latter; this is structural checking, not content sanitization.
- [shared-project-migration.ts](../packages/core/src/shared-project-migration.ts)
  owns `planSharedProjectMigration(Uint8Array): SharedProjectMigrationPlan`.
  It copies the original bytes before strict UTF-8 decoding, invokes the existing
  v10→v15 chain, then returns `sourceVersion`, `sourceBytes`, `shared`, `drafts`,
  `selections`, and `preview`. No files are read or written, no migration is
  committed, and no existing personal state is accepted or overwritten. The
  returned selections are reconciliation candidates, not replacement commands.
- Planning is deterministic and preserves all normalized saved data apart from
  version and explicit prompt drafts. Source bytes preserve pre-normalization
  formatting, BOM and line endings. Candidate objects do not share mutable
  content with each other or the source buffer. Draft IDs encode the source
  template ID's UTF-16 code units as hex after `draft_migrated-`, giving stable,
  distinct IDs without using untrusted legacy IDs as paths. These are logical
  record identities, not a finalized filename or migration-journal contract.
- `PROJECT_SCHEMA_VERSION`, `ProjectFile`, the current parser/serializer, app
  folder adapters, JSON import/export, and CLI paths remain v15. Existing callers
  still retain embedded drafts and reject v17. The new codecs have no runtime
  caller in those flows; switching the version constant alone is not supported.

The planner rejects invalid legacy documents before extraction, including missing
draft sources; it does not rescue an invalid manifest heuristically. Unsupported
v9 and earlier inputs and v17+ inputs are not migration sources. Invalid UTF-8
is rejected without lossy decoding. A legacy provider-options payload accepted
by the older validator but containing known secret keys inside arrays is rejected
by the v17 shared codec, so planning fails with a `ProjectValidationError` naming
the source field (for example `defaults.options.providerOptions.extra.0.api_key`)
rather than a workbench record. Nothing is silently copied or sanitized; the user
removes the secret from the project before migrating. Suite and variant provider
options are unchecked in v15 and remain so in v17; that is a separate decision.

### Remaining integration work

The later [migration-journal foundation](archive/SHARED_ASSETS_MIGRATION_JOURNAL_DESIGN.md)
now implements journal v1, raw-byte backups, compact persistence IDs, protected
staging and read-only restart classification. It leaves manifest replacement,
active-candidate reconciliation and application wiring deferred.

The later [recovery-store slice](archive/SHARED_ASSETS_RECOVERY_STORE_SLICE.md) implements
opt-in protected persistence for the existing prompt drafts and selections,
including conflict outcomes. Project opening and application save paths still
do not use it. Manifest replacement and recovery reconciliation, publication
intent, dependency snapshots, cleanup UX, conflict UX, request draft/scratch arms,
feature owners, and the
launch-default action remain to be settled or implemented. Other selection
arms, decision execution overrides, and request provenance still need their
contracts. Suite/tool/mock draft arms, invalid buffers and personal backup remain
later work. The first core codec rejects these unsupported fields instead of
pretending to preserve them. The byte buffer in the plan is not a durable backup.

### Core-slice verification

- Wrote the first migration assertions before ownership separation. A minimal
  planner scaffold delegated to the existing v15 parser, allowing a meaningful
  red run rather than a missing-module failure: actual shared version `15`
  differed from expected `16`, and extracted draft count `0` differed from `2`.
  The active-v15 compatibility assertion passed. These establish the absence of
  the new migration behavior, not a regression in an existing application path.
- `node --experimental-strip-types --test tests/shared-project-migration.test.ts
  tests/project-workspace.test.ts` passed 37 tests. Coverage includes the complete
  examples, strict validation, both draft kinds, every supported starting version,
  saved pins/defaults/content, absent/empty/null values, original bytes,
  deterministic IDs, independent candidates, and authored ordering. A fixture
  initially used an editor helper that removes an empty revision name; it was
  corrected to supply a saved empty string directly. That fixture failure is
  not claimed as implementation evidence.
- The Level 1 Git fixture now uses `.workbench/recovery.json`. A new disposable
  real repository without a bundle `.gitignore` confirms `*\n` inside
  `.workbench/.gitignore` excludes itself, selections, drafts, scratch records and
  legacy migration backups. The test writes representative files directly; it
  does not establish adapter write ordering or crash recovery.
- Full `npm run test:core` passed all 1,510 tests, including existing CLI and
  provider-fixture coverage. The initial sandboxed attempt had 52 failures
  because local fixture listeners were denied (`listen EPERM`); the rerun with
  local-server access passed. This is v15 CLI compatibility coverage, not v16
  CLI integration.
- `npm run typecheck:core`, `npm run lint`, and `npm run build` passed. The build
  includes the application type check and reports the existing large-chunk
  warning. Lint reports three pre-existing unused-variable warnings and no new
  warnings. `git diff --check`, new-file whitespace checks, and all 25 relative
  link targets in the two planning documents passed.
- Review follow-up, October 26: tests were written first and run red for the
  intended reasons: v16 accepted array-nested secrets, `kind` was an
  unrecognized key, and the zero-draft preview still listed drafts. The
  key-order assertion was confirmed red by temporarily removing the serializer's
  preferred order. Its first draft compared against an assumed order; it was
  corrected to compare against the project serializer's actual revision order.
  That fixture mistake is not claimed as implementation evidence. Afterwards
  the two affected files passed 38 tests, `npm run test:core` passed 1,511,
  and core typecheck, lint (same three existing warnings), build and
  `git diff --check` passed.
- No browser or native filesystem recovery run is required for this isolated
  core slice: it changes no user-visible behavior or provider execution. Those
  checks remain mandatory when persistence and feature owners are integrated.
  Human review should focus on API scope and candidate/backup wording; there is
  no new UI to inspect yet.
