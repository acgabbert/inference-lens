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

**Renumbered 2026-10-30:** the staged shared format is now **v19**. Active
v16 went to [prompt environments](PROMPT_ENVIRONMENTS_PLAN.md) on October 29,
active v17 to [external prompt file imports](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md#external-prompt-sources)
and active v18 to [linked prompt sources](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md#e3-implementation-contracts-approved-october-30-2026); v19 carries all three.
Dated verification records and archived documents keep the number that was
current when they were written.
The subsequent approved [migration-journal foundation](archive/SHARED_ASSETS_MIGRATION_JOURNAL_DESIGN.md)
adds protected staging and read-only restart classification; it does not replace
the manifest or activate personal candidates.
The next [migration-completion proposal](SHARED_ASSETS_MIGRATION_COMPLETION_DESIGN.md)
defines opt-in manifest replacement and active-candidate recovery for review.
It does not approve application integration or the other proposals below.
Revised the same day after review: write safety, publication intent, launch
defaults, the v19 rationale and delivery order. The 2b
[integration decisions](#integration-decisions-approved-october-30-2026) were
approved October 30; exact owner interfaces come first in that slice.

## Review recommendations

| Decision | Recommendation | Alternative and tradeoff |
| --- | --- | --- |
| Shared format | Propose v19: remove both template kinds' `draft`; retain the other v15 fields and treat `defaults` as authored launch defaults. The bump exists to fence out old writers (see [why v19](#why-a-version-bump)). | Keep v15 and stop writing drafts: no migration journal, but old builds keep folding drafts and last-used selections back into the shared file. Rename/restructure defaults now: clearer naming, but more churn without changing ownership. |
| Legacy defaults | Copy existing selections/settings into personal state; retain all legacy defaults in shared definitions. Migration preview does **not** offer demotion in this slice. | Offer selective demotion: needs optional-default semantics and a policy for a clone with no launch request/target. Design separately. |
| Changing launch defaults | Only an explicit "Use as project launch default" action writes `defaults`, with a preview; branching, selecting and running never do. See [launch defaults](#changing-authored-launch-defaults). | No writer: defaults freeze at migration. Implicit writer: reintroduces the churn Level 2 removes. |
| Local data | Typed asset drafts, scratch requests, selections and execution overrides; never a second complete project. Propose workbench schema v1. | A whole-project shadow is simpler initially but creates competing definitions and ambiguous publication. |
| Delivery order | Slice 2b: template drafts (both kinds), selections/execution overrides, scratch and draft requests (both kinds), migration. Next: suite/tool/mock drafts. Import staging, invalid-buffer recovery and personal backup are parked (November 5). See [delivery order](#delivery-order). | All arms at once: one schema review, but the largest slice in the plan and most of it unrelated to what migration moves. |
| Recovery granularity | One record per draft/scratch request plus a selections record; protect the directory before writing any content. | One state file gives simpler writes but unrelated drafts conflict and one invalid file blocks all recovery. |
| Workbench write safety | Best-effort detection: expected-content check before each write, read-back after it, and same-host coordination where the host offers it. No cross-host atomicity claim. See [concurrent writes](#layout-identity-and-concurrent-writes). | Write-once generations with parent pointers: closes the race, but adds head resolution, cleanup and a record format no other store uses; browsers offer no exclusive create to do better. |
| Publication recovery | Record publication intent (intended revision ID and frozen content) in the draft record itself; no separate operation journal for ordinary saves. Migration keeps its journal. | A journal per publication: more general, but a second record to keep consistent with the draft it describes. |
| Incomplete editors | Slice 2b recovers valid editor content, as v15 drafts do today. Typed editor-buffer recovery, including invalid decision JSON, is parked with 2d. | Buffers in 2b: protects more unfinished work, but needs per-editor buffer arms before the core separation ships. |
| Conflict recovery | Retain both sides, stop automatic writes to the affected record, and require explicit reconciliation; keep source snapshots for comparisons. | Automatic merge/rebase introduces new semantics, especially for ordered decision input. |
| Personal backup | Parked (2e; not a Level 3 prerequisite): separate versioned backup of personal records and required local dependencies; preview restore, never overwrite automatically. Evidence remains a separate export. | Full-folder archive carries evidence too, but obscures what is portable and greatly increases scope. |

The first core-slice approval accepts v19 and v1 for the bounded contracts
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
| `schemaVersion` | 15 → proposed 19 | Core versioned codec; old v15 writer rejects v19. |
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
composer's model, protocol, temperature and enabled tools into `defaults`). After v19 those
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
| `cases[].checks[]` | Keep all fields | Check vocabulary remains 5; no new check schema implied by Project v19. |

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
- [After: proposed shared Project v19](examples/shared-assets-level-two/project-v19.proposed.json)
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

Core should own `SharedProjectFileV18` and discriminated recovery DTOs in a
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
   For a scratch, first reparent every direct child to the published saved
   revision. Persist and read back those child rewrites before replacing or
   deleting the publishing scratch; retain its intent until all are confirmed.
   After interruption, replan from the current inventory to finish only the
   remaining rewrites.
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
   proposed v19/local outputs in memory. Show preview; opening alone does not
   approve an on-disk migration. Keep no-folder inputs session-only.
2. Confirm `.workbench/.gitignore`, then write/read back the untouched source and
   migration intent. Do not put legacy backups beside `project.json`.
3. Write and verify all extracted drafts and selection seeds. If personal state
   already exists, retain it and stage migration candidates for reconciliation;
   do not overwrite it or seed over existing personal selections.
4. Recheck the original manifest and confirm all local outputs before writing
   v19. A failure through this step leaves the original or its verified untouched
   backup plus verified recovery candidates. Never remove the only draft copy.
5. Confirm v19, mark completion, and keep the source backup. Interrupted runs
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

The shared change is small: v19 differs from v15 only by losing the two optional
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
v19 shared decoding. Returning only v19 from today's `parseProjectJson` would
silently lose extracted drafts for callers that know nothing about recovery.
A migration result must carry source version, preserved source bytes, shared
candidate, extracted personal records and preview diagnostics.

Existing v10–v15 JSON remains importable through the strict one-version chain;
older unsupported formats stay unsupported. JSON imports have session-only
recovery until a folder is chosen. Default export is v19 shared definitions;
personal backup is deferred with 2e and would require explicit selection. Do not silently down-export v15 by
reintroducing personal drafts. An old build must reject v19, not open it as an
editable empty project. No-folder export wording must state that unsaved drafts
are excluded, and offer personal backup before replacement/closing once
slice 2e delivers it.

The CLI may read legacy definitions in memory without writing a migration or
using explicit template drafts. v19 execution uses only saved request/suite pins
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
| 2b | v19 codec and migration; personal selections and execution overrides; "Use as project launch default"; chat and decision template drafts; scratch requests and drafts of saved requests (both kinds), so running and branching stop writing shared definitions; publication intent | chat prompt, decision prompt, chat request, inline decision request, template-use decision request, selections |
| 2c | Suite drafts and explicit suite save; tool and mock drafts, local mock activation | suite, tool, mock |
| 2d (parked) | Typed editor buffers for invalid or incomplete input (decision JSON, checks, tool schemas) | buffer arms per editor |
| 2e (parked) | Personal backup v1 and restore preview | backup envelope |
| Import staging (parked) | Staged imports not yet saved as assets | import staging |

Until 2c, suite, tool and mock editors keep their current save behavior, and
the migration preview must not claim they are separated. Until 2d, recovery
covers valid editor content only, as v15 drafts do today. Until 2e, no-folder
and close/replace wording offers shared export only and says drafts are
excluded. Each later slice adds arms to the workbench v1 codec only if it can do
so without changing an existing arm; otherwise it versions the codec.

### Level 2 scope trimmed (November 5, 2026)

The user approved trimming the rest of Level 2. The project has a handful of
users, so effort goes to what changes shared files, then to Level 3.

- **2c is trimmed.** It keeps suite, tool and mock drafts with explicit saves.
  Import staging leaves 2c.
- **2d, 2e and import staging are parked.** They are not scheduled and are not
  prerequisites for Level 3. The interim behavior above stays: recovery covers
  valid editor content only, and no-folder and close/replace wording offers
  shared export only and explicitly excludes drafts. Picking one up again needs
  its own approval. These deferrals do not remove existing Level 2 write safety.
- **Level 3 is bounded separately.** The [approved delivery scope](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md#delivery-scope-approved-november-5-2026)
  defers 3c, uses source-preserving conversion into a new folder, and requires
  detectable incomplete saves with a documented recovery path rather than
  automatic repair. Detailed contracts and a version distinct from reserved
  Project v20 remain design work.

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
v19 and recovery examples had no production codec; those checks did not prove
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
Project v19 excludes both prompt kinds' explicit drafts. Workbench v1 receives
those drafts and copied selections; all other saved content and launch defaults
stay shared. The app stays on v15 until recovery storage is ready. This is the
first part of 2b, not completion of Level 2 or authorization to start writing v19
from existing save paths.

### Implemented contracts

- [shared-project.ts](../packages/core/src/shared-project.ts) owns
  `SharedProjectFileV18`, its draft-free `SharedPromptTemplate` union, and
  `parseSharedProjectFile`, `parseSharedProjectJson`, `serializeSharedProjectFile`.
  These APIs accept only v19. They reuse the existing saved-content/reference
  validators behind an explicit v19 gate and reject any prompt `draft` field.
  v19 also rejects known secret field names anywhere in default and tool
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
  still retain embedded drafts and reject v19. The new codecs have no runtime
  caller in those flows; switching the version constant alone is not supported.

The planner rejects invalid legacy documents before extraction, including missing
draft sources; it does not rescue an invalid manifest heuristically. Unsupported
v9 and earlier inputs and v19+ inputs are not migration sources. Invalid UTF-8
is rejected without lossy decoding. A legacy provider-options payload accepted
by the older validator but containing known secret keys inside arrays is rejected
by the v19 shared codec, so planning fails with a `ProjectValidationError` naming
the source field (for example `defaults.options.providerOptions.extra.0.api_key`)
rather than a workbench record. Nothing is silently copied or sanitized; the user
removes the secret from the project before migrating. Suite and variant provider
options are unchecked in v15 and remain so in v19; that is a separate decision.

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

## Integration decisions (approved October 30, 2026)

The user approved these decisions for the 2b integration slice, which lets
the app write v19 and enables migration completion. They settle the
[slice 2a checklist](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md#next-design-deliverable-slice-2a)
apart from exact owner interfaces and personal backup (2e). Proposals earlier
in this document that the decisions below do not change are approved as
written: the `.workbench/` layout, best-effort write detection, publication
intent in the draft record, conflict recovery, project-identity mismatch
handling, session-only no-folder mode, and a CLI that reads shared
definitions only.

Three facts about the code at `3747184` shaped them. The composer rewrites
the active saved conversation revision and `defaults` on every edit
(`updateProjectDraft`), so chat requests, not template drafts, cause most
shared-file churn. Prompt environments added `defaults.environmentId` after
selections v1 was written, and the environment selector already separates
select from set-default. Every template use in a trace pins a
`templateRevisionId`; E4's `fileSource` records a run-only override as base
revision plus text used.

### Scope and sequencing

- **D1. Whole slice behind a gate.** Design every 2b arm now. Implement them
  behind a gate, and enable v19 in the app only when all have landed.
  Enabling template drafts alone would leave running and editing a request
  rewriting `project.json`.
- **D2. Gate mechanism.** A build or environment flag, off by default, read
  when a project opens, selects today's v15 path or the new owners. Gated e2e
  specs run with it on. Removing the flag is the enabling change, and it also
  lifts the guard against application calls to completion.
- **D3. Owners.** As [proposed above](#types-and-execution-boundary): a new
  `usePersonalWorkbench` owns record load and save, recovery status,
  selections and reconciliation. `useProjectWorkspace` keeps v19 shared
  definitions, publication and the folder lifecycle, and stops folding edits
  into auto-save. Template, composer and decision owners route drafts through
  the personal owner. `app/page.tsx` only composes them. Exact interfaces are
  the first deliverable of the integration slice.

### Migration entry and reconciliation

- **D4. Opening a v15 folder.** Once the app writes v19, a v15 folder opens
  with shared saves blocked until it is upgraded. Viewing, running, evidence
  writes and session-only edits still work. "Upgrade project" opens the
  migration preview, which warns that teammates on older builds will be
  refused once the upgraded file is committed. The app keeps no v15 writer,
  and opening never migrates.
- **D5. After completion.** The completion dialog reopens the project as a
  v19 session. An `uncertain` or `diverged` outcome lands on a read-only
  inspection view rather than the editor.
- **D6. Competing drafts.** One active draft per asset. Each pending candidate
  offers Compare, "Use this one" and Discard. "Use this one" preserves the
  replaced active draft as a staged copy. Discard leaves the staged backup.
- **D7. Resolution record.** A resolutions record per migration operation,
  beside its immutable journal, records each settled candidate. An explicit
  "Remove migration backup" action is offered once nothing is pending. No
  resolution deletes a staged candidate.
- **D8. Recovery surface.** One Recovery drawer, opened from a project-level
  status chip, lists pending migration candidates, record conflicts, orphaned
  drafts, unreadable records and conflicted publication intents. The
  Templates and Request panes mark affected assets.

### Records and codecs

- **D9. Workbench v1 amended in place.** No application has written workbench
  v1, because the recovery store and completion have no caller. v1 gains the
  2b arms and an environment selection, and freezes when the gate is removed.
  The migration planner copies `defaults.environmentId` into the selections
  seed, as it does target, options and tools.
- **D10. Chat requests.** Editing a saved revision creates a local request
  draft: base revision plus edited items. New requests and branches create a
  local scratch record. Its parent is a discriminated reference to a saved
  revision or a local record, never a fake shared ID. Saving a draft appends a
  child revision under the same conversation and moves only the personal
  selection; suites and other pins stay put. Saving a scratch request creates
  a conversation. A scratch whose parent chain is local publishes as one
  revision whose parent is the nearest saved ancestor. The preview names the
  local steps it omits.
- **D11. Decision requests.** The same pattern for inline and template-use
  arms. Template-use overrides stay sparse, suite authoring keeps
  `activate: false`, and no shared decision target is invented.
- **D12. Evidence for local input.** Approved: no false shared pins, and
  repeated experiments may run local input. An audit at `3747184` narrowed
  the format change:
  - Run resolution reads saved template revisions only; core reads a template
    `draft` only to validate it. Unsaved template edits are not runnable
    today, and 2b keeps that, so no template-draft provenance is added. If
    running them is wanted later, it would follow `fileSource`'s shape under
    separate approval.
  - RunTrace and the decision trace carry no required request pin; a branch's
    `parentConversationRevisionId` is optional. Single runs of a request draft
    or scratch request need no trace version.
  - ExperimentPlan's common input requires `conversationId` and
    `conversationRevisionId` (`decisionRequestRevisionId` for decisions).
    Repeated experiments on local input take the next free ExperimentPlan
    version at merge, under the
    [allocation convention](FINAL_OUTPUT_CONTRACTS.md#d1-format-version-allocation).
    Its exact representation is a contract for review before that change.

### Shared writes

- **D13. Launch defaults.** One chat "Use as project launch default" action
  writes the selected request revision, target, options and tools, with a
  preview. A separate decision action writes only the decision request pin.
  The environment keeps its existing set-default. A status shows where the
  personal selection differs from the launch default.
- **D14. Saving drafts.** Drafts persist to `.workbench/` after a short
  debounce. A shared write happens only on an explicit per-asset Save, and an
  "Unsaved drafts" list shows what is pending. 2b has no save-all, so
  publication intent stays per record.
- **D15. Assets 2b does not separate.** Suites, tools, mocks, environments,
  connection requirements, renames and archiving keep direct shared writes
  until 2c. The migration preview and the Recovery drawer do not claim they
  are separated.

## Owner interfaces (proposed October 31, 2026)

**Status: the four forks below were approved October 31, 2026; the rest is the
proposal they were chosen from.** These are the exact owner interfaces that D3
names as the first deliverable of the 2b slice. They were read against `main`
at `6a5600b`. Where they extend workbench v1 (D9), that is an in-place
amendment: no application has written v1, and the arm shapes stay open to
amendment until the gate is removed.

Approved forks:

- **I1. In-memory type.** Owners keep `ProjectFile`. Only the persistence
  boundary converts to and from v19 (see [below](#in-memory-shared-document)).
- **I2. Migration owner.** A new `useProjectMigration` runs preview, staging,
  completion and reopen. Reconciliation stays in `usePersonalWorkbench`.
- **I3. Run identity for local input.** A request draft runs under its saved
  `conversationId` with a fresh revision ID. A scratch runs under a stable
  local conversation ID kept in its record, with a fresh revision ID per run.
- **I4. Composer record owner.** A new `useChatRequestRecord` decides which
  record the composer edits. `usePendingBranch` keeps only run provenance.

### Facts at `6a5600b` that shape them

- The active format is v18, not v15: `ProjectFile` is `ProjectFileV18`, and
  `SharedProjectFileV19` is `ProjectFileV18` without template drafts.
  Almost every core helper takes `ProjectFile`.
- `currentProjectDocument()` folds three owners into every save:
  `updateProjectDraft` (the active revision's items, `defaults.target.model`,
  `.protocol`, `.options.temperature`, `.enabledToolIds`, and also `tools` and
  `toolMocks`), and `decision.project.fold` (the active decision revision).
  `tools` and `toolMocks` are D15 assets that keep direct shared writes.
- A run commits shared state in two places: `prepareWorkbenchRun` returns a
  `projectMutation` for a branch (`createBranchRevision`), and
  `useDecisionProject.freezeForRun` folds the decision draft into the project.
  Ad hoc runs already mint a fresh `RunConversationIdentity`, which
  `ResolvedRunInput` requires.
- Selecting a chat request writes `defaults.conversationRevisionId`. The
  environment owner reads `defaults.environmentId` on adoption and keeps
  select separate from `setDefault`. Decisions use no environment. The decision
  target is session state in `useDecisionTarget`, never in the project.
- The e2e suite runs one dev server. Nothing in the app reads a
  `NEXT_PUBLIC_` variable yet.

### Gate (D2)

- `app/workbench/personal-workbench-gate.ts` exports
  `personalWorkbenchEnabled(): boolean`, reading the build-time
  `NEXT_PUBLIC_INFERENCE_LENS_PERSONAL_WORKBENCH === "1"`. It is the only reader.
- `useProjectWorkspace` samples it once per adoption into the session's
  `mode: "legacy" | "personal"`. A session never changes mode while it is open.
- With the gate off, every code path is today's, the shared format stays v18,
  and `completeSharedProjectMigration` keeps its no-application-caller guard.
- Gated e2e specs run against a second dev server started with the flag on.
  `tests/e2e/support` exposes it as a `personalWorkbench` fixture with its own
  `baseURL`. The ungated suite is unchanged.
- The CLI reads v19 shared definitions whatever the gate says (reading never
  writes a migration). It never opens `.workbench/`.

### In-memory shared document

Owners keep operating on `ProjectFile`. In a `personal` session the workspace
holds the invariant that it carries no template `draft` and that
`schemaVersion` is the active version. Only the persistence boundary converts:
reads go through `parseSharedProjectJson` and are relabeled to the active
version, and writes go through `serializeSharedProjectFile`. The v19 serializer
rejects a stray template draft. That makes a missed routing a loud save error,
not a silent leak. Threading `SharedProjectFileV19` through every owner and
helper is the alternative. It is more honest, but it means rewriting every
core helper's signature while the gate is on.

### Workbench v1 amendment (D9–D11, D7)

Arms are added beside the existing ones. Existing arms do not change.

```ts
type LocalChatInput =
  | { kind: "saved-conversation-revision"; revisionId: ConversationRevisionId }
  | { kind: "draft"; draftId: DraftId }          // a chat-request draft
  | { kind: "scratch"; scratchId: ScratchId };   // a chat scratch record
type LocalDecisionInput =
  | { kind: "saved-decision-request-revision"; revisionId: DecisionRequestRevisionId }
  | { kind: "draft"; draftId: DraftId }
  | { kind: "scratch"; scratchId: ScratchId };

// New draft arms. Envelope as today: schemaVersion, kind "draft", projectId, draftId.
| { asset: { kind: "chat-request"; id: ConversationId };
    base: { revisionId: ConversationRevisionId; snapshot: ProjectConversationRevision };
    edited: { items: ProjectConversationItem[] };
    publishing?: PublicationIntent<{ items: ProjectConversationItem[] }> }
| { asset: { kind: "decision-request"; id: DecisionRequestId };
    base: { revisionId: DecisionRequestRevisionId; snapshot: ProjectDecisionRequestRevision };
    edited: DecisionRequestContent;    // inline or template-use arm, below
    publishing?: PublicationIntent<DecisionRequestContent> }
// The two prompt arms gain the same optional `publishing` field.

type DecisionRequestContent =
  | { kind: "inline"; decision: DecisionInput; values: Record<string, string> }
  | { kind: "template-use"; templateId; templateRevisionId; overrides: Record<string, string> };

// New record kind: scratch/<scratchId>.json
{ schemaVersion: 1; kind: "scratch"; projectId; scratchId: `scratch_${string}`;
  createdAt: string;
  /** Stable for this scratch's runs, so their traces group. Never in project.json. */
  localConversationId: ConversationId;
  request:
    | { kind: "chat"; items: ProjectConversationItem[]; parent?: ChatParentRef }
    | { kind: "decision"; content: DecisionRequestContent; parent?: DecisionParentRef };
  branchedFrom?: { runId: RunId; messageId: MessageId };
  publishing?: PublicationIntent<...> & { conversationId | decisionRequestId; name: string } }
type ChatParentRef =
  | { kind: "saved-conversation-revision"; revisionId: ConversationRevisionId }
  | { kind: "scratch"; scratchId: ScratchId };
type DecisionParentRef =
  | { kind: "saved-decision-request-revision"; revisionId: DecisionRequestRevisionId }
  | { kind: "scratch"; scratchId: ScratchId };

interface PublicationIntent<C> {
  revisionId: string;          // allocated once
  parentRevisionId?: string;   // a draft's base; a scratch's nearest saved ancestor (D10)
  content: C;                  // frozen copy
}

// selections.json gains, all optional, absent inherits the launch default:
chat.selectedInput: LocalChatInput         // widened from the saved arm only
chat.execution.environmentId: EnvironmentId | null   // null = explicitly none
decision.selectedInput: LocalDecisionInput // widened likewise
```

Decision requests take one asset kind whose `edited` is a discriminated union,
not two asset kinds. A local detach can turn a template-use base into inline
content, and the asset is the same request either way. The migration planner
copies `defaults.environmentId` into `chat.execution.environmentId` when it
is present (D9).

`project.json` requires a revision's parent to be in the same conversation or
decision request. So a scratch with a saved ancestor publishes as a child
inside that ancestor's request, as a branch run does today, and its intent has
a `parentRevisionId` and no `name`. A scratch with no saved ancestor creates a
named request, and its intent has a `name` and no parent. This is how D10's
"Saving a scratch request creates a conversation" reads against that rule. The decision target stays session state as today: 2b adds no
decision execution overrides.

D7's resolutions record is `migrations/<operationId>/resolutions.json`,
beside the immutable journal:

```ts
{ schemaVersion: 1; kind: "migration-resolutions"; projectId; operationId;
  resolutions: Array<{
    candidate: string;                       // journal candidate path
    outcome: "used" | "discarded";
    settledAt: string;
    /** "Use this one": the replaced active draft's preserved copy (D6). */
    replacedCopy?: `migrations/${string}/replaced/${DraftId}.json`;
  }>;
  backupRemovedAt?: string }
```

`WorkbenchStorage.mutate` path validation widens to `scratch/` and these two
migration paths, and nothing else. Removing the migration backup deletes the
operation directory only when no candidate is pending.

### Core operations (packages/core)

Pure, and none of them writes files:

- `publishPromptDraft`, `publishChatRequestDraft`,
  `publishDecisionRequestDraft`, `publishScratch(project, record)` return
  `{ project, intent }`. The project carries the appended revision (or the new
  conversation or decision request for a scratch). They validate pins and
  refuse a local parent chain that has no saved ancestor where one is required.
- `reconcilePublication(project, record)` returns
  `"published" | "not-published" | "conflict"`, following the restart rules in
  [publication](#publication-and-migration-recovery). It compares frozen
  content, never an ID alone.
- `resolveLocalChatInput(project, records, input)` and the decision
  equivalent return the items or content to render. They also return the
  run identity: a saved revision runs as itself. A request draft runs as
  `{ conversationId: asset.id, conversationRevisionId: fresh }`. A scratch
  runs as `{ conversationId: record.localConversationId, conversationRevisionId: fresh }`.
  No local ID is ever written into `project.json`.
- `setLaunchDefaults(project, { chat: { revisionId, target, options, enabledToolIds } })`
  and `setDecisionLaunchDefault(project, revisionId)` (D13). Both refuse a
  local reference.

### `usePersonalWorkbench` (new, `app/workbench/`)

```ts
interface PersonalWorkbenchHandle {
  status:
    | { kind: "off" }                         // legacy session
    | { kind: "session" }                     // no folder: in memory only
    | { kind: "loading" }
    | { kind: "ready"; saving: boolean }
    | { kind: "blocked"; reason: "foreign-project" | "protection"; message: string };
  /** One active draft per asset (D6). Keyed `${asset.kind}:${asset.id}`. */
  draftFor(asset: WorkbenchAssetRef): WorkbenchDraftV1 | undefined;
  scratch(id: ScratchId): WorkbenchScratchV1 | undefined;
  selections: ResolvedSelections;             // read with launch-default fallback
  unsavedDrafts: UnsavedDraftSummary[];       // D14 list
  recovery: RecoveryItem[];                   // D8 drawer and pane marks
  updateDraft(asset: WorkbenchAssetRef, base: DraftBase, edited: DraftContent): void; // debounced
  discardDraft(asset: WorkbenchAssetRef): Promise<WorkbenchStoreOutcome>;
  createScratch(request: ScratchRequest, options?: { branchedFrom?: ... }): ScratchId;
  updateScratch(id: ScratchId, request: ScratchRequest): void;                  // debounced
  discardScratch(id: ScratchId): Promise<WorkbenchStoreOutcome>;
  select(input: LocalChatInput | LocalDecisionInput): void;
  setExecution(patch: ChatExecutionOverrides): void;
  /**
   * The four-step protocol: intent then read-back, then the workspace's shared
   * write, then clear or rebase the record. `write` is the workspace's
   * explicit shared write.
   */
  publish(ref: WorkbenchAssetRef | { scratchId: ScratchId }, name?: string): Promise<PublishOutcome>;
  reconcile: {
    compare(item: RecoveryItem): RecoveryComparison;
    use(candidate: string): Promise<ReconcileOutcome>;
    discard(candidate: string): Promise<ReconcileOutcome>;
    removeMigrationBackup(operationId: string): Promise<ReconcileOutcome>;
  };
  /** Before replacement or close: persist queued debounced writes. */
  flush(): Promise<void>;
}

usePersonalWorkbench(input: {
  session: { mode: "legacy" | "personal"; projectId: ProjectId; adoption: number } | null;
  storage: WorkbenchStorage | null;           // null: session-only
  shared: ProjectFile | null;
  writeShared(next: ProjectFile): Promise<SharedWriteOutcome>;
})
type PublishOutcome =
  | { kind: "published"; revisionId: string; keptEdits: boolean }
  | { kind: "conflict" | "failed" | "blocked"; message: string };  // draft kept
```

It reopens on each `adoption`, settles every `publishing` record with
`reconcilePublication` before it reports `ready`, and never adopts disk
contents over in-memory edits on a conflict.

### `useProjectWorkspace` (changed under the gate)

- `currentProjectDocument()` in a `personal` session folds only `tools`
  and `toolMocks` from the request draft. It does not fold revision items,
  `defaults` or the decision draft. Auto-save keeps writing D15 edits as today
  ("direct shared writes"), and nothing else reaches it.
- New `writeShared(next): Promise<SharedWriteOutcome>`
  (`confirmed | conflict | failed | blocked`). It shares the existing write
  queue and tab-role fence (U1). Unlike auto-save, it resolves only once the
  write is confirmed or refused.
- New `format: { kind: "legacy"; sourceVersion: 15 | 16 | 17 | 18 } | { kind: "shared" }`
  and `sharedSaveBlockedReason?: string` (D4). A legacy folder in a `personal`
  session blocks `writeShared` and auto-save. Viewing, running, evidence and
  session-only edits still work. Opening never migrates.
- `onApplyDraft` and `onApplyDecisionRequest` are replaced, in a `personal`
  session, by the personal workbench's selection. The workspace still applies
  the shared document itself.

### Migration owner (new `useProjectMigration`, `app/workbench/`)

```ts
interface ProjectMigrationHandle {
  available: boolean;                         // personal session, legacy folder
  preview(): Promise<MigrationPreview>;       // plan only, nothing written
  stage(): Promise<StageOutcome>;
  complete(): Promise<MigrationCompletionOutcome>;
  /** D5: `diverged` and `uncertain` open read-only inspection. */
  outcome?: { kind: "reopened" } | { kind: "inspection"; shared: "diverged" | "uncertain" };
}
```

It composes the existing `planSharedProjectMigration`, migration staging and
`completeSharedProjectMigration` over the browser and native adapters. On
`completed` it asks the workspace to reopen the folder. Reconciliation of
pending candidates belongs to the personal workbench (D3); this owner only
gets the folder to v19.

### Feature owners

- **`useProjectTemplates`.** `updateProjectTemplateDraft` and
  `updateDecisionTemplateDraft` call `personal.updateDraft`, and `save*`
  calls `personal.publish`. `libraryTemplates` reads each template's draft from
  `personal.draftFor`, not `template.draft`.
- **New `useChatRequestRecord` (`app/request/`).** This owns which record the
  composer edits: a clean saved revision, its request draft, or a scratch.
  It turns composer edits into `updateDraft` or `updateScratch`, and offers
  `save()`, `saveAsRequest(name)` and `useAsLaunchDefault()` (D13, with a
  preview). `usePendingBranch` keeps run provenance (`branchedFrom`). Starting
  a branch creates a scratch whose parent is the branched revision or scratch.
- **`prepareWorkbenchRun`.** In a `personal` session it takes the
  identity from `resolveLocalChatInput` and returns no `projectMutation`.
- **`useDecisionProject`.** `fold` and `freezeForRun` become no-ops in a
  `personal` session. Edits go to a decision-request draft or scratch through
  the personal owner. Suite authoring keeps `activate: false`.
- **`useProjectEnvironments`.** `select` writes
  `chat.execution.environmentId`, and `setDefault` stays a shared write.
- **`app/page.tsx`** composes the new handles and the Recovery chip and
  drawer. It holds no queue, codec or migration state.

### Delivery inside the gate

Every step lands behind the gate. Removing the gate is the last step (D1):

1. Core: v1 arms, resolutions record, publication and resolution operations,
   with planner environment seeding and tests. No app caller.
2. Gate and second e2e server; workspace `personal` mode, `writeShared`,
   `usePersonalWorkbench` with template drafts and publication.
3. Chat request drafts, scratch, branches and run identity.
4. Decision request drafts and scratch.
5. Selections, execution overrides, environment selection, launch-default
   actions and the differs-from-default status.
6. Legacy-folder blocking, `useProjectMigration`, the completion dialog and
   the Recovery drawer and reconciliation.
7. The ExperimentPlan local-input version (D12), after its own contract
   review.

### Step 1 delivered (October 31, 2026)

Core codecs, storage paths and the pure operations; no application caller,
and the gate does not exist yet. The codecs and paths landed first; the
[operations](#step-1-operations) completed the step.

- [personal-workbench.ts](../packages/core/src/personal-workbench.ts) adds the
  `chat-request` and `decision-request` draft arms, the optional `publishing`
  intent on all four draft arms, the `scratch` record, the widened
  `selectedInput` references, and `chat.execution.environmentId`. A draft's
  intent requires `parentRevisionId` equal to its base and a new revision ID.
  Inline decision values must name variables the content uses. Secret-like
  names are refused in every assignment arm. `isPromptDraft` narrows the
  draft union, which TypeScript cannot narrow on `asset.kind`.
  Chat snapshots, edits, scratch requests and publication content require
  unique template-use IDs and unique message IDs across literals and template
  outputs, matching the shared project contract. Scratch publication also
  requires a new revision ID distinct from its parent.
- [migration-journal.ts](../packages/core/src/migration-journal.ts) owns
  `parseMigrationResolutions` and `serializeMigrationResolutions`, using the
  journal's own `migration_<sha256>` operation and candidate path rules.
  Nothing writes this record yet.
- The planner seeds `chat.execution.environmentId` from
  `defaults.environmentId`.
- `scratch/scratch_<id>.json` is a valid record path in core, in the browser
  adapter and in the native adapter, with the same symlink refusal as
  `drafts/`. Migration completion still activates only `selections.json` and
  `drafts/`.

#### Step 1 operations

[workbench-publication.ts](../packages/core/src/workbench-publication.ts) and
[workbench-local-input.ts](../packages/core/src/workbench-local-input.ts)
implement the [core operations](#core-operations-packagescore). They take
`ProjectFile` (I1) and write no files. These implementation choices sit inside
the approved contracts:

- **Refusals throw `ProjectValidationError`.** Publication refuses a record
  from another project, one that still carries an intent (reconcile it first),
  a draft whose template or base revision is gone (an orphan is compared and
  saved as new, never rebased), and a scratch whose parent chain loops, names
  a missing or other-kind scratch, or ends at a deleted saved revision.
  `parseProjectFile` validates pins.
- **A no-op save writes nothing.** A draft whose content equals its base
  returns `{ kind: "unchanged" }` with no intent; the owner clears the draft
  once it has confirmed the base. Otherwise the result is
  `{ kind: "publish", project, intent }`. A scratch always publishes.
- **Prompt publication moves the template's current revision**, as saving a
  template does today. Request publication moves no `defaults`.
- **A revision name is a label.** Reconciliation and the no-op check compare a
  prompt's messages or decision and its variable defaults, not its name, so a
  later rename still reconciles as `published`. Template revisions record no
  parent, so the owning template stands in for the parent check.
- **Scratch naming.** `publishScratch` takes the other scratch records and an
  optional `name`. The name is required, trimmed, only without a saved
  ancestor, and ignored with one. A new request's ID shares the revision's
  suffix.
- **Steps 2 and 3 have helpers.** `clearPublication` drops the intent after a
  failed or refused write. `completePublication(project, record, scratches)`
  returns `{ record, scratchRewrites }`. `record` is undefined when the current
  content equals the frozen copy (delete it); otherwise it retains later edits
  without the intent, based or parented on the published revision. It refuses
  unless reconciliation reports `published`, and both recovery operations
  reject a different project ID before inspecting revisions.
- **Child cleanup contract (approved during PR #288 review).** Completion takes
  the complete current scratch inventory and returns `{ before, after }` copies
  for direct children of the publishing scratch, reparented to the saved
  revision. The owner serializes local mutations, checks each `before` against
  storage, and persists and reads back every `after` before replacing/deleting
  the parent. A failure or conflict retains the parent's intent and replans
  against fresh records; an interrupted cleanup returns only remaining child
  rewrites. No new child may appear between planning and cleanup. Descendants
  continue through their immediate parents. Foreign-project records are left
  alone, and a child of the wrong request kind refuses completion. Child edits
  and frozen publication intents remain intact; those intents describe separate
  shared writes. These operations remain pure: the future application owner
  must implement and test this write ordering before enabling the gate.
- **Local input.** `resolveLocalChatInput` and `resolveLocalDecisionInput`
  return `undefined` for a reference that resolves to nothing here: an unknown
  record or revision, a record of the other kind or project, or a local
  decision pin that no longer resolves. Decision traces carry no request pin
  (D12), so the decision result has no run identity; it returns the content,
  the authored decision, supplied values, variables and diagnostics.
- **Launch defaults.** `setLaunchDefaults` and `setDecisionLaunchDefault`
  refuse a revision ID the project does not hold, which covers every local
  and fresh run ID. `defaults.environmentId` is left to its own set-default.

### Step 2 decisions (approved October 31, 2026)

The user approved three interim behaviors for step 2, which the owner
interfaces left open. All of them apply only with the gate on.

- **S1. A pre-v19 folder blocks shared saves.** D4's blocking lands in step 2,
  without the upgrade flow that step 6 adds. A gated session opens a v15–v18
  folder for viewing, running, evidence writes and session-only edits, and a
  plain notice says shared saves need an upgrade. The app gains no interim
  legacy writer. Gated e2e specs seed v19 folders directly.
- **S2. New projects are v19; imports keep their drafts in the session.**
  Creating a folder and saving a session project to a folder write v19 and
  create `.workbench/`. A legacy JSON import (v10–v18) opens session-only: the
  existing migration planner lifts its template drafts into in-memory personal
  drafts, and saving it to a folder writes v19 and then persists them. Export
  writes v19 shared definitions only.
- **S3. Template saves return a Promise in both modes.** `saveProjectTemplate`,
  `saveDecisionTemplate` and the save-and-insert variants resolve once the
  save has landed or been refused; the legacy path resolves at once. Editors
  show a saving state, and a conflict or failure keeps the draft and reports
  the error.

Two facts changed after the interfaces were read at `6a5600b`. vinext 1.3
allows one dev server per checkout (`.vinext/dev/lock.json`), so the second,
gated e2e server sets `VINEXT_NO_DEV_LOCK=1` and its own Vite `cacheDir`; the
ungated server keeps the lock. The gate is read through vinext's
`NEXT_PUBLIC_` inlining, which still applies under Vite.

### Step 2 delivered (October 31, 2026)

The gate, the second e2e server, the workspace's `personal` mode and
`usePersonalWorkbench` with prompt drafts and publication. With the gate off,
every path is today's and the app still writes v18; migration completion keeps
its no-application-caller guard.

- **Gate.** [personal-workbench-gate.ts](../app/workbench/personal-workbench-gate.ts)
  reads `NEXT_PUBLIC_INFERENCE_LENS_PERSONAL_WORKBENCH`, which `vite.config.ts`
  always defines. A folder handle records the mode it was read in, and the
  workspace adopts it with the handle as `projectSession.mode`.
- **Manifest boundary.** [project-manifest.ts](../app/workbench/project-manifest.ts)
  is the only conversion (I1). A `personal` session reads v19 and labels it
  with the active version. It plans a legacy document in memory: the shared
  candidate becomes the document and its prompt drafts become session-only
  seeds. It writes through the v19 serializer, so a missed routing is a save
  error.
- **Workspace.** `projectSession`, `sharedSaveBlockedReason` and `writeShared`
  are new. A personal session folds only `tools` and `toolMocks` into
  auto-save, through the new core `updateProjectTools`, which also drops a
  deleted tool from suites and from the launch default's enabled tools. A
  legacy folder in a personal session never auto-saves, `save` throws
  `SharedSaveBlockedError`, and the top bar shows a new `blocked` storage state.
  Export writes v19 in a personal session.
- **Personal owner.** [personal-workbench-controller.ts](../app/workbench/personal-workbench-controller.ts)
  holds the records and protocols apart from React, and
  [use-personal-workbench.client.ts](../app/workbench/use-personal-workbench.client.ts)
  makes one controller per adoption. A legacy folder, like a session without a
  folder, gets no storage: its drafts stay in memory (S1). Saving a session
  to a folder carries its in-memory records into the new store (S2).
- **Templates.** Draft edits go to `personal.updateDraft`. `libraryTemplates`
  presents a record as `template.draft`, so the editors are unchanged apart
  from S3. The save methods return a Promise, and the editors disable Save
  and show "Saving…" while one runs.

Implementation choices inside the approved contracts:

- **`writeShared` takes a deterministic update, not a document.** A fixed
  `next` would drop direct shared edits (D15) that a queued auto-save or the
  user made while the publication waited. The workspace applies `update` to the
  latest document when the write reaches the front of the queue, and again to
  the in-memory document once confirmed. Publication makes that deterministic
  by fixing the revision suffix and timestamp once. The confirmed outcome
  returns the document as written.
- **The step 2 handle is prompt-only.** `updateDraft(asset, base, edited)` and
  `publish(asset, { extend })` take prompt assets. `extend` carries the direct
  shared edits that ride with a Save (rename and recommended model), applied
  inside the same shared write. The published outcome carries the confirmed
  project, so Save and add, and Save and use, pin the new revision without
  waiting for a render. Steps 3 and 4 widen both to request drafts and scratch.
- **A draft equal to its base is no draft,** as `updatePromptTemplateDraft`
  does today, unless it carries a revision label.
- **Settling on open.** A record with an intent is settled before `ready`: a
  publication that landed is completed, one that never landed loses its intent,
  and a conflict stays as a recovery item and blocks a new Save of that draft. A
  scratch intent is left for step 3. Orphaned drafts, unreadable records,
  competing drafts and failed writes are recovery items too; step 6 renders
  them.
- **`.workbench/` is created by the first personal write,** through the
  existing protection check, rather than when the folder is created. A
  carried session draft that meets a stored draft for the same prompt is
  reported, not written.
- **Unload.** The owner warns before unload while a draft is only in memory or
  not yet written. The replacement dialog does not count personal drafts yet;
  personal backup before replacement is slice 2e.

Not changed in step 2, and left for later steps: creating a prompt and
materializing a session prompt are still direct shared writes. Request edits,
including the use that Save and add inserts, still reach `project.json`
directly until step 3. Two tabs share `.workbench/` with best-effort conflict
detection only, and the desktop host is not exercised by the gated e2e suite.

Checks: `tests/personal-workbench-controller.test.ts` (draft debounce, the
four-step publication, in-flight edits, a refused shared write, an unrecordable
intent, settling on open, session-only and carried records, a foreign
workbench) and `tests/project-manifest.test.ts` (codec, both modes). The gated
`tests/e2e/personal-workbench-prompt-drafts.spec.ts` runs a v19 folder edit and
Save, and checks that a v18 folder is never written; run against the ungated
server, both of its tests fail.

### Step 3 decisions (approved November 4, 2026)

The user approved four interim behaviors for step 3, which the owner
interfaces left open. All of them apply only with the gate on.

- **R1. No request picker until step 5.** The selection moves only through
  existing flows: an edit makes a request draft of the selected revision, a
  branch makes a scratch, Save selects the new revision, and Discard returns to
  the scratch's parent, or to the launch default when it has none. Step 5 adds
  the switcher. Until then a replaced scratch, or the predecessor of a newly
  named request, is unreachable from the composer.
- **R2. A branch's parent is the nearest saved ancestor the app knows.** Edit
  from here on the live run of a request draft parents the scratch on the
  draft's base revision. A saved trace parents it on its revision when the
  project holds it, on the scratch whose `localConversationId` matches its
  conversation, and otherwise on nothing, so Save asks for a name and creates a
  request.
- **R3. Every run of an unsaved scratch records `branchedFrom`.** The scratch
  carries it, so it survives a reload with no extra state. Runs of the saved
  revision carry none, as today.
- **R4. Repeated experiments refuse local input until step 7.** With a request
  draft or scratch selected, a repeated experiment asks the user to save the
  request first. Single runs work.

Defaults taken with them. With the gate on, every composer edit of a saved
revision, template-use edits included, becomes a request draft: the existing
core helpers run against the base revision with the draft's items overlaid,
and executed revisions are no longer forked. Save and Discard sit in the
composer header. Save moves only the personal selection, never `defaults`, and
asks for a name only for a scratch without a saved ancestor. Branching creates
and selects a scratch at once, so the pending-branch blocker on switching
projects does not apply. An n8n import into Messages stays an explicit shared
write, since its receipt lives in `project.json`, and moves the personal
selection rather than the launch default. Model, temperature and tool-enable
edits wait for step 5's execution overrides.

### Step 3 delivered (November 4, 2026)

Chat request drafts, chat scratch, branches and the local run identity, behind
the gate. With the gate off every path is today's.

- **Personal owner.** The controller gains the chat selection
  (`selections.json`'s `chat.selectedInput`), chat-request drafts, chat
  scratch records, and Save for both. Every publication, prompt drafts
  included, now runs one protocol (`publishRecord`): intent and read-back, the
  shared write, then a scratch's children reparented and read back before the
  scratch is cleared. A failure in that last step keeps the intent, and the
  next open settles it. Opening settles an interrupted scratch publication the
  same way, and marks a request draft whose base is gone as orphaned.
- **Record owner.** [use-chat-request-record.client.ts](../app/request/use-chat-request-record.client.ts)
  (I4) decides what the composer edits, over the pure helpers in
  [local-chat-request.ts](../app/request/local-chat-request.ts): the
  selection, the overlay that runs core revision helpers on local items, the
  run identity (I3, R3) and a branch's parent (R2).
- **Composer and templates.** In a personal session, message and template-use
  edits, Save and add, and Save and use go to the record through
  `applyRevisionEdit`, and the composer renders the record's items. Its
  messages re-render when the record changes outside the composer. A notice
  among the pane's notices offers Save and Discard, and a name field for a
  scratch with no saved ancestor.
- **Runs and branches.** `prepareWorkbenchRun` takes `localInput` and returns
  no `projectMutation`. Branching creates and selects a scratch through
  `usePendingBranch`'s `branchLocally`, so no pending branch is held. Repeat is
  disabled with R4's reason while a draft or scratch is selected.

Implementation choices inside the approved contracts:

- **Published selection survives cleanup.** Save and interrupted-publication
  recovery persist the selected chat revision before deleting its draft or
  scratch. A selection-write failure retains the publishing intent for retry
  on reopen; later edits and a newer selection stay intact.
- **Live-run parents follow scratch removal.** Saving a scratch moves its
  remembered live-run parents to the published revision; discarding it moves
  them to its parent. Branch resolution ignores remembered parents that no
  longer exist, following R2's fallback instead of creating an unsavable branch.

- **A competing draft is kept as a scratch.** Editing a saved revision while
  the same request already has a draft the composer is not editing keeps that
  draft as a scratch parented on its base, rather than overwriting it (D6
  keeps one active draft per asset). It is unreachable from the composer until
  step 5 (R1).
- **Discarding a scratch** reparents its local children on its own parent
  before it is deleted.
- **Branching from a publishing scratch is refused** until its Save
  finishes, so completion reparents a fixed set of children.
- **Edits wait for the store.** While the personal workbench is still loading,
  an edit is refused with a message rather than written into records that
  `open` is about to replace.

Not changed in step 3: model, temperature and tool-enable edits still wait
for step 5 and are not persisted in a personal session. "Save trace…" on a
branch whose parent trace is unsaved is not offered, because a branch no
longer holds a pending-branch notice.

Checks: `tests/personal-workbench-requests.test.ts` (drafts, the competing-draft
rule, scratch create, edit and discard, Save of each kind, child
reparenting order, settling on open), `tests/local-chat-request.test.ts`
(selection fallback, the overlay, run identity, R2, R3) and a local-input case
in `tests/prepare-workbench-run.test.ts`. The gated
`tests/e2e/personal-workbench-request-drafts.spec.ts` edits, saves, runs,
branches and saves a branch in a v19 folder. With the record owner forced off,
both of its tests fail: no draft is written, and a run rewrites
`project.json`.

### Step 4 decisions (approved November 4, 2026)

The user approved three interim behaviors for step 4, which the owner
interfaces left open. All of them apply only with the gate on.

- **Q1. Invalid edits stay in the editor.** The decision editor can hold edits
  that do not validate: unfinished rows or JSON that does not parse. Only a
  valid edit reaches the draft or scratch record, so `.workbench/` keeps the
  last valid version and the composer says the newest edits are not saved yet.
  The record format is unchanged, and the editor's draft shape stays
  application-local (D18).
- **Q2. New decision requests are local.** Using a decision prompt in Compose
  (Use in Compose, Save and use), a first edit in a project with no decision
  request, and the worked example each create a decision scratch with no
  parent. Nothing reaches `project.json` until Save, which asks for a name
  prefilled with the prompt's name or "Decision request" (D10, D11).
- **Q3. A new suite needs a saved request.** While a decision draft or scratch
  is selected, "New suite from this request" is disabled and asks the user to
  save the request first, as R4 does for chat Repeat.

### Step 4 delivered (November 4, 2026)

Decision request drafts and decision scratch, behind the gate. With the gate
off every path is today's.

- **Personal owner.** The controller gains the decision selection
  (`selections.json`'s `decision.selectedInput`), decision-request drafts,
  decision scratch records and Save for both, through the same `publishRecord`
  protocol as chat. Opening marks a decision draft whose base is gone as
  orphaned. Selecting chat never moves the decision selection, and the reverse
  holds too.
- **Record owner.** [use-decision-request-record.client.ts](../app/decisions/use-decision-request-record.client.ts)
  decides what Decision Compose edits, over the pure helpers in
  [local-decision-request.ts](../app/decisions/local-decision-request.ts): the
  selection with launch-default fallback, the overlay that runs the core
  retarget and detach helpers on local content, the sparse overrides of a
  template-use pin, and the name Save offers.
  [use-decision-record-sync.client.ts](../app/decisions/use-decision-record-sync.client.ts)
  keeps the editor and the record in step: a valid edit becomes the record's
  content (Q1), and a record changed by Save, Discard or a new scratch is
  loaded into the editor.
- **Compose.** In a personal session `useDecisionProject` folds, freezes and
  adopts nothing, and an invalid edit never blocks a shared save. Value edits,
  retarget and Detach go to the record. Use in Compose, Save and use, and the
  worked example start a scratch with no parent (Q2). The decision pane shows
  the same local-request notice as the chat composer, with Save, Discard and a
  name field prefilled with the prompt's name. "New suite from this request"
  waits for Save (Q3). Edit source on a local request returns to it.

Implementation choices inside the approved contracts:

- **Decision scratch records keep a local conversation ID.** The scratch
  schema requires one; decision runs never use it (D12).
- **The prompt name survives a detach for this session only.** A scratch
  started from a prompt offers that prompt's name even after Detach makes it
  inline. Without a place in the record format, a reload falls back to the
  content's own suggestion.
- **A dropped record is deleted after the debounce.** Found by the gated
  decision spec: a draft dropped because an edit returned to its base stayed on
  disk until the next flush, so a reopened folder found a stale draft. This
  also affected chat-request and prompt drafts from steps 2 and 3. Every
  dropped record now schedules its deletion like any other write.

Not changed in step 4: decision runs carry no request pin, so there is no
decision branch or run identity. The decision target stays session state. A
draft or scratch replaced by a new one stays in `.workbench/` and is
unreachable until step 5's switcher (R1).

Checks: `tests/personal-workbench-decision-requests.test.ts` (drafts, the
competing-draft rule, both selections apart, scratch Save with a name, Save of a
draft, Discard of each, orphans, settling on open, and the debounced deletion,
which ran red first). `tests/local-decision-request.test.ts` covers selection
fallback, pin resolution, sparse overrides, the overlay and names. It was
written after the module, so it was never shown failing. The gated
`tests/e2e/personal-workbench-decision-drafts.spec.ts` covers a new request
through run and named Save, a draft through Save and reopen, and Use in Compose
through Detach and Save. With the record owner forced off, all three of its
tests fail because no draft or scratch is written.

### Step 5 decisions (approved November 4, 2026)

The user approved four behaviors for step 5, which the owner interfaces left
open. All of them apply only with the gate on.

- **T1. The switcher groups by request.** Chat Compose and Decision Compose
  each get a request menu with one entry per saved request. Picking a request
  opens its draft if one exists, otherwise its newest revision. Older revisions
  sit under a per-request disclosure. Local scratches form their own group,
  labelled by their parent, and the launch default is marked. This lifts R1.
- **T2. Execution overrides stay sparse.** Model, temperature, protocol and
  tool-enable choices are written to `chat.execution`, and a field set back to
  its launch-default value is cleared. Fields the user never moved away from
  follow a teammate's later change to `defaults`. The differs-from-default
  status compares values, so an override that happens to equal a changed
  default does not count as a difference.
- **T3. A local selection cannot become the launch default.** While a request
  draft or scratch is selected, "Use as launch default" is disabled and asks
  the user to save the request first, as R4 and Q3 do. Each launch action is
  one shared write.
- **T4. The status is a notice chip.** An advisory chip among the composer's
  notices, inside its scroll area, names what differs from the launch default
  (request, model, temperature, protocol, tools) and carries "Use as launch
  default…", which previews the shared fields it changes. Decision Compose
  shows the same for its request pin. Environment keeps its own set-default
  and the selector's default marker (D13), so the chip does not cover it.

### Step 5 delivered (November 4, 2026)

Selections, execution overrides, environment selection, the launch-default
actions and the differs-from-default status, behind the gate. With the gate off
every path is today's.

- **Personal owner.** The controller records `chat.execution` in
  `selections.json` beside both selections; moving either selection keeps it.
  The handle applies an update to the overrides as they are now, and offers the
  launch actions' one shared write.
- **Execution.** [chat-execution.ts](../app/request/chat-execution.ts) holds the
  pure rules: the effective execution over `defaults`, the sparse patch (T2) and
  the differences (T4). [use-chat-execution.client.ts](../app/request/use-chat-execution.client.ts)
  owns them for the composer: model, temperature and protocol edits
  (`useRequestSettings`), tool enables (`useRequestDraft`) and the environment
  choice (`useProjectEnvironments`) become overrides, and none of them marks
  the project dirty. The settings panel says "Your settings".
- **Switcher.** [request-menu.ts](../app/workbench/request-menu.ts) builds T1's
  entries for both kinds, and [request-switcher.client.tsx](../app/workbench/request-switcher.client.tsx)
  renders them at the top of the Chat and Decision Compose scroll areas. It is
  disabled while a run is executing. Leaving a decision request with invalid
  edits asks first, as Use in Compose does.
- **Launch defaults.** "Use as launch default…" previews each differing field
  and writes through `setLaunchDefaults` or `setDecisionLaunchDefault`. After
  the chat action, published overrides are cleared; edits made while the write
  is pending are rebased onto the confirmed defaults. Environment is kept as
  recorded, since it has its own action.

Implementation choices inside the approved contracts:

- **The per-request disclosure is a second list.** The selected request's
  revisions, and its unsaved changes when it has a draft, sit in a Revision
  list beside the Request list. Native selects keep the switcher keyboard- and
  screen-reader-friendly without a custom menu.
- **Revisions are named by position.** Saved chat and decision revisions carry
  no label, so the switcher and the preview name them "Revision N", oldest
  first, by creation time and then file order.
- **A local selection's status.** The local-request notice already says a
  draft or scratch is unsaved, so the chat status chip appears for one only
  when something else differs too, and then gives T3's reason instead of the
  action. Decision Compose shows the chip only for a saved revision other than
  the pin.
- **Stale overrides are ignored, not refused.** An override that names a tool
  or environment the project no longer holds falls back to the launch default.
  The tool list as recorded is not filtered, so a project tool attached a
  moment ago stays enabled before its auto-save lands; the launch action keeps
  only tools the project holds.
- **Fixed a step 4 sync loop.** Selecting another saved decision revision ran
  the editor→record effect in the same commit as the adopt, with the old editor
  content, so it wrote that content as a draft of the new record and the two
  selections alternated. The effect now skips the editor state an adopt is
  replacing. Step 4's `returnToRevision` could reach the same path.

Not changed in step 5: decisions keep no execution overrides; the decision
target stays session state. Connection, maximum tokens, seed, stop and provider
options have no personal editor, so they always follow the launch default. The
Recovery drawer and reconciliation are step 6.

Checks: `tests/chat-execution.test.ts` (effective execution, sparse patches,
differences) and `tests/request-menu.test.ts` (grouping, newest revision, draft
entry, scratch labels, decision menu) were written with their modules, so they
were never shown failing. `tests/personal-workbench-requests.test.ts` gains an
overrides case that failed first on the missing `setChatExecution`. The gated
`tests/e2e/personal-workbench-selections.spec.ts` switches a chat revision and
makes it the launch default, reads a seeded model override back and clears it,
records an environment choice, and switches and pins a decision revision. Its
decision test failed first on the sync loop (the selection never reached
disk); with the fix removed it fails again the same way.

### Step 6 decisions (approved November 4, 2026)

The user approved four behaviors for step 6, which the owner interfaces and
D4–D8 left open. All of them apply only with the gate on.

- **V1. Step 6 lands in two parts.** 6a delivers the upgrade: the Upgrade
  action on a pre-v19 folder, the preview, staging and completion through
  `useProjectMigration`, reopening as a v19 session, D5's inspection, and
  "Finish upgrade" for an operation an earlier attempt left staged or
  half-activated. 6b delivers the Recovery drawer and chip, reconciliation
  (Compare, "Use this one", Discard), the resolutions record, "Remove
  migration backup" and the pane marks. Both stay behind the gate, and 6b
  lands before the gate can be removed (the completion approval condition).
- **V2. Session edits carry over.** A pre-v19 folder keeps its personal
  records in memory (S1), and staging copies the drafts from the file on disk,
  so edits made in that session are not in the staged copy. After completion
  the reopened session writes the in-memory records into the new
  `.workbench/`. A session prompt draft replaces the draft that completion
  just activated for the same prompt: it is the newer edit of the same work,
  and the staged candidate stays in `migrations/` as the backup. Any other
  collision (an active draft that existed before the upgrade, or a candidate
  left pending) is a recovery item, and the session copy stays in memory
  rather than being dropped.
- **V3. Inspection reuses blocked saves.** An `uncertain` or `diverged`
  completion (D5) reopens the folder in the same mode as a pre-v19 folder:
  viewing, running and evidence writes work, and shared saves are refused. A
  notice says what happened and offers "Check again", which re-inspects the
  operation and reopens as v19 once the manifest is confirmed. No separate
  inspection page is added.
- **V4. Every recovery item has its actions in 6b.** Pending migration
  candidates and competing drafts: Compare, "Use this one", Discard. Orphaned
  drafts: Compare with the base snapshot, Save as new, Discard (never
  rebased). Publication conflicts: Compare, Keep as draft, Discard. Failed
  writes: Retry. Unreadable records show their path and message only; the app
  never deletes them.

Defaults taken with them, reversible and inside the approved contracts:

- **Upgrade is offered in the editing tab only.** A viewing tab shows the
  blocked notice and says the upgrade runs from the tab that edits the
  project (tab coordination's U1).
- **One confirmation stages and completes.** The preview's Upgrade runs
  staging and then completion. A `stale-plan` result returns to a fresh
  preview; nothing is written by opening or previewing.
- **The completion guard narrows instead of lifting.** The approval-condition
  test allows one caller, the migration owner in `app/workbench/`, which runs
  only in a `personal` session. The guard lifts with the gate (D2).
- **The journal records target v19.** Its `targetVersion` literal is still 16
  from before the October 30 renumbering. No application has written a
  journal, so it is amended in place, as D9 amends workbench v1.
- **The desktop host gains a reopen command.** Native open always shows a
  folder picker, and completion invalidates the native handle. A
  `reopen_project_workspace` command registers the same directory afresh from
  its current manifest, as the browser's `reopenProjectWorkspace` does.

### Step 6a delivered (November 4, 2026)

The upgrade of a pre-v19 folder, behind the gate. With the gate off every path
is today's, and nothing calls migration completion.

- **Migration owner.** [project-migration.ts](../app/workbench/project-migration.ts)
  holds the protocol apart from React: the preview, Upgrade (staging, skipped
  when an earlier attempt staged the same bytes, then completion), finding an
  upgrade that stopped after the shared write, and Finish.
  [use-project-migration.client.ts](../app/workbench/use-project-migration.client.ts)
  owns it for the page, in the tab that edits the project. It is the one
  caller of completion, and the approval-condition test now allows exactly
  that file.
- **Surfaces.** The page's banner slot carries the upgrade's conditions, after
  the project-error and tab banners: "Upgrade project…" on a pre-v19 folder,
  "Finish upgrade" when staged records still wait, V3's failure with "Check
  again", and what the upgrade could not restore.
  [project-upgrade-dialog.client.tsx](../app/workbench/project-upgrade-dialog.client.tsx)
  is the preview: the source format, the drafts that become personal, the
  backup, D4's warning about older builds and D15's wording.
- **Reopen.** The workspace's new `reopenProjectFolder` rereads the folder into
  a fresh handle and adopts it in place, keeping the tab's role. The desktop
  host gains `reopen_project_workspace`, which registers the folder afresh
  under its workspace lock; the invalidated registration stays refused, and a
  reopened handle keeps its folder identity for run navigation, as a browser
  reopen does.
- **V2 carry.** The adoption after an upgrade names the records completion
  activated and the drafts the file held. The personal controller drops a
  carried draft the session never edited (its staged candidate covers it),
  writes an edited one over the draft completion just activated for the same
  prompt, and keeps any other colliding session copy in memory on its recovery
  item, so unload still warns about it.
- **Journal.** `targetVersion` is 19 (amended in place).

Implementation choices inside the approved contracts:

- **The owner interface is the page's, not the protocol's.** The proposed
  `preview`, `stage` and `complete` handle became open, confirm and close of
  one dialog, since one confirmation stages and completes. `outcome` became
  `inspection`, and `unfinished` and `finish` were added for an upgrade that
  stopped after the shared write.
- **Unsaved shared changes are offered for export.** A pre-v19 session can
  hold shared edits it could never save. The preview says the reopen discards
  them, offers "Export JSON copy…", and labels its action "Discard changes and
  upgrade".
- **Check again carries too.** It reopens with the drafts the file held and no
  activated records, so an unedited session draft gives way to its staged
  candidate, which Finish then activates. Rechecking confirms this operation's
  exact staged shared output before reopening; the reopened manifest must
  still match that inspected output. A write that never landed, leaving exactly
  the source bytes, reopens the folder as a pre-v19 folder with the session's
  records and offers Upgrade again (V3). Divergent or unreadable files keep
  shared saves blocked. Existing personal selections win a collision with carried
  session selections; the session copy remains in memory for recovery. Only
  selections activated by this upgrade can be replaced by the session copy.
- **Finish is offered only while the manifest is exactly the upgrade's
  output.** Any later shared save diverges it; the candidates then wait for
  6b's reconciliation.

Not changed in 6a: no Recovery drawer, chip or pane marks, and pending
candidates and colliding session copies are only reported (6b). A viewing tab
gets no upgrade banner (its tab banner already says it does not save), and it
learns of the upgrade when it next reads the folder. The desktop reopen is
covered by a Rust unit test only; the gated e2e suite runs in the browser.

Checks: `tests/project-migration.test.ts` (preview, Upgrade over the browser
adapters, a stale manifest, continuing an earlier staging, a failed manifest
write as inspection, and finding and finishing an interrupted upgrade) was
written with its module, so it was never shown failing.
`tests/personal-workbench-controller.test.ts` gains three V2 cases, which
failed first: the carried draft became a competing item, and the colliding
session copy was not kept. The Rust test
`reopening_registers_the_folder_afresh_and_leaves_an_invalidated_handle_refused`
was written with the command. The gated
`tests/e2e/personal-workbench-upgrade.spec.ts` upgrades a v18 folder with a
draft edited in the session and saves it afterwards, and checks that Cancel
writes nothing. Both of its tests failed first because no Upgrade action
existed; with the V2 carry disabled, the first fails again on the draft's
content.

### Step 6b decisions (approved November 4, 2026)

The user approved four answers to questions that D6–D8, V4 and the resolutions
schema left open. All of them apply only with the gate on.

- **W1. Replacements outside a migration go to `replaced/`.** "Use this one"
  on a competing draft that is not a migration candidate (two drafts for one
  asset in `drafts/`, or a session copy V2 kept in memory) moves the active
  draft it replaces to `.workbench/replaced/<draftId>.json`. That file holds
  the same draft record, is never loaded as active, and appears in Recovery
  as a replaced draft with Compare, "Use this one" and Discard. Core, the
  browser host and the native host validate the path as they do `drafts/`.
  Workbench v1 is amended in place, as D9 amended it.
- **W2. A selections candidate offers Compare and Discard.** Selections are
  pointers and cheap to redo by hand, so "Use this one" is not offered when a
  migration's selections met existing ones. Discard records `discarded`. The
  resolutions schema's `replacedCopy` is narrowed to drafts (amended in place:
  nothing has written it).
- **W3. Removing a backup writes its intent first.** "Remove migration backup"
  writes `backupRemovedAt` into `resolutions.json`, creating it if needed.
  A host operation on both hosts then deletes the operation's source, journal,
  shared snapshot, candidates and replaced copies, then `resolutions.json`, and
  then the directory. It is limited to one `migrations/migration_<sha256>/`
  directory and refuses links. A removal that was interrupted reads as
  "Finish removing backup". The confirmation lists what is deleted, replaced
  copies included.
- **W4. 6b lands as two pull requests.** 6b-1 adds the core, both hosts and
  the personal controller's reconcile operations, with unit and Rust tests and
  no UI. 6b-2 adds the Recovery chip and drawer, the pane marks and the gated
  e2e spec. Both stay behind the gate.

Defaults taken with them, reversible and inside the approved contracts:

- **Candidates are assessed without the manifest.** Completion's inspection
  refuses once `project.json` moves past an operation's output, which the first
  shared save does. Recovery verifies each operation's journal and candidates
  against its preserved source, as completion does, then classifies every
  candidate against the active records and the resolutions record: settled,
  present (its bytes are active), absent, competing, existing selections or
  unavailable. An operation that cannot be verified is an unreadable item.
- **Recovery files are not staged outputs.** Inspection and both inventory
  listings accept `resolutions.json` and `replaced/draft_*.json` inside an
  operation, so settling a candidate never reads as a damaged staging. Finish
  skips candidates already recorded as used or discarded, even if their active
  draft has since been deleted.
- **"Use this one" writes in a crash-safe order.** The replaced copy first,
  then the candidate becomes active, then the resolution. An interruption
  leaves at worst two drafts for one asset, which Recovery lists again, or a
  replaced copy no resolution names, which removing the backup deletes.
- **Save as new never rebases.** An orphaned draft is saved as a new prompt or
  request, named by the user, with the draft's content. A publication conflict's
  "Keep as draft" clears the intent and keeps the edits over their original
  base.

### Step 6b-1 delivered (November 5, 2026)

The recovery inventory and every reconcile action, behind the gate and without
UI. With the gate off nothing calls them.

- **Core.** [migration-recovery.ts](../packages/core/src/migration-recovery.ts)
  assesses each operation against its preserved source, not the manifest, and
  holds the resolutions operations: settle a candidate, mark a backup's removal
  and decide whether a backup is removable. An operation whose manifest is
  still exactly its output keeps its absent candidates for Finish upgrade (6a),
  so Recovery cannot discard one that Finish would then activate.
  [migration-journal.ts](../packages/core/src/migration-journal.ts) exports
  `isMigrationRecoveryPath`, and inspection leaves those files out.
  [workbench-store.ts](../packages/core/src/workbench-store.ts) lists
  `replaced/` drafts apart from active records. It adds `writeRecovery` for the
  recovery paths only, `refresh` (an explicit re-read that lifts a conflict or
  failure block) and `removeMigrationOperation`.
- **Hosts.** Both listings descend an operation's `replaced/` and the top-level
  `replaced/`. Both mutations accept the recovery paths, with the native host
  refusing links at every component. The new `removeMigrationOperation` (the
  native `remove_workbench_migration_operation` command) checks the recorded
  intent, identity, protection and the operation's fixed layout before
  deleting anything. It deletes `resolutions.json` last, and any unexpected
  entry keeps the whole backup.
- **Controller.** On open, the
  [personal controller](../app/workbench/personal-workbench-controller.ts)
  reads the inventory before carried records are written. It records every
  candidate whose exact bytes are active as `used`. Migrated draft IDs come
  from the prompt ID alone, so without that record a migrated draft edited or
  saved after the upgrade would look like a pending candidate. `recovery`
  lists each item with an `id` and its V4 actions. `compareRecovery`,
  `useRecovery`, `discardRecovery`, `keepRecoveryAsDraft`, `saveRecoveryAsNew`,
  `retryRecovery` and `removeMigrationBackup` implement them, and
  `migrationBackups` summarizes each operation. `usePersonalWorkbench` exposes
  them as `reconcile` and `migrationBackups`. The page passes the folder's
  migration reader (one prop).

Implementation choices inside the approved contracts:

- **"Use this one" takes a fresh ID on a clash.** When the incoming draft has
  the active draft's own ID (migrated IDs are deterministic), the incoming one
  is activated under a new ID. A swap whose replaced copy would overwrite the
  incoming record's own file writes the incoming draft first. A selected
  request draft's selection follows the draft that replaced it. An incoming
  draft also takes a fresh ID if its destination belongs to another asset,
  preserving that asset's draft in place. An existing
  copy at the replaced path is never overwritten: Recovery asks to discard it
  first.
- **Record conflicts.** V4 named no actions for them. A store conflict on a
  draft or scratch offers Compare, "Use this one" (keep this window's copy;
  the copy on disk goes to `replaced/`, or to a new scratch) and Discard (take
  the copy on disk). Selections and V2 session copies offer Compare and
  Discard, as W2 does.
- **A publication whose children were not updated** offers Retry, which
  settles that record again, instead of Keep as draft: its save landed.
- **Save as new** creates a prompt with the draft's content, or turns a request
  draft into a parentless local request and saves it under the given name. If
  that save fails, the work stays as the local request.

Not changed in 6b-1: no drawer, chip or pane marks (6b-2), and nothing in the
app calls `reconcile` yet.

Checks: `tests/migration-recovery.test.ts` (eight cases) and
`tests/personal-workbench-recovery.test.ts` (ten cases) were written before
their code. Only the inspection case and the W2 narrowing could fail on an
assertion; the rest failed because the module or method did not exist yet.
Inspection with a resolutions record failed as `needs-review`, and the W2
schema accepted a selections copy. `tests/workbench-store.test.ts` gains four
cases over the browser host. The inventory case failed first with "Migration
inventory is unavailable". The Rust tests
`native_recovery_paths_live_beside_records_and_keep_migration_inventory_readable`
and the two backup-removal tests failed against a stub. The link-refusal test
passed against the stub as well, so it was never shown failing.

### Step 6b-2 decisions (approved November 5, 2026)

The user approved four answers about the drawer's surface, which D8, V4 and W4
left open. All of them apply only with the gate on.

- **X1. The chip sits in the topbar's header actions.** It reads
  "Recovery · N" while N items are pending, and "Migration backup" when
  nothing is pending but a backup can be removed or its removal finished. It
  is hidden otherwise. Removing a backup therefore stays reachable after the
  last item is settled.
- **X2. Compare is a JSON line diff.** Each side is stable-formatted JSON,
  shown as a line diff with the existing folded diff view. One code path
  serves every item kind: drafts, selections, scratch and saved revisions.
- **X3. Pane marks link to the drawer.** A marked prompt's row in the
  Templates list carries a "Needs recovery" line, and a marked request's entry
  in the request switcher reads "· needs recovery". The affected editor shows a
  notice at the top of its scroll area with "Open Recovery", which opens the
  drawer on that asset's items.
- **X4. Discard confirms when it deletes the only copy.** It asks first for a
  session copy held in memory, a replaced or stored competing draft, this
  window's copy in a record conflict, an orphaned draft and a publication
  conflict's edits. Discarding a migration candidate only records `discarded`,
  and the backup keeps it, so it acts at once.

### Step 6b-2 delivered (November 5, 2026)

The Recovery chip, drawer and pane marks, behind the gate. With the gate off
the personal workbench is off, so none of them renders.

- **Owner.** [use-recovery.client.tsx](../app/workbench/use-recovery.client.tsx)
  owns whether the drawer is open and on what, and builds the chip, the pane
  marks and the in-pane notice. Reconciliation stays with the personal
  workbench (6b-1). The page composes it: the topbar gets the chip, the
  Prompts mode and both composers get the marks and the notice, and the page
  renders the drawer.
  [recovery-view.ts](../app/workbench/recovery-view.ts) holds the pure parts:
  the X1 chip state, the keys the marks use, each item's subject, the X4
  confirmation rule, the X2 diff and the W3 removal details.
- **Drawer.** [recovery-drawer.client.tsx](../app/workbench/recovery-drawer.client.tsx)
  lists each item with its subject, kind, message, path and V4 actions, then
  the migration backups. Compare shows the two sides as a folded line diff;
  long lines wrap, so the drawer content stays its one scroll area. Save as
  new asks for a name inline. A backup reads "Remove migration backup…" once
  removable, "Finish removing backup" after an interrupted removal, and otherwise says
  what it waits for. An item with no action says how to clear it: fix or
  remove the file, then reopen the project. It still counts on the chip (X1).
  An open comparison reads both sides again whenever the workbench changes.
- **Marks.** The Templates list row reads "Needs recovery". The request
  switcher's entry, saved or local, reads "· needs recovery", in Chat and
  Decision Compose. The prompt editor and both composers show a "Needs
  recovery" notice among their notices, with "Open Recovery".

Implementation choices inside the approved decisions:

- **The prompt editor reloads after a Recovery action.** It holds its own
  copy of the draft, read when it mounts, so "Use this one" left it showing the
  replaced draft. The owner counts, per prompt, the settled actions that
  changed its active copy, and the Templates pane keys the editor on that
  count. Discarding the other copy, a replaced draft or a migration candidate,
  and Retry, change no active copy, so they do not remount an open editor.
  Keying on the draft's ID instead would remount the editor when a first edit
  creates a draft. The same action also drops the decision prompt editor's
  in-session memory for that prompt, which would otherwise restore the
  replaced copy over the remounted one.
- **The drawer starts over with each personal project**: its open state, its
  focus and the per-prompt counts reset when the project changes.
- **A focused drawer lists only that asset's items** and hides the backups.
  "Show all" lifts the focus. When the asset's items are all settled and others
  remain, it says so and offers "Show all".
- **The chip is a header button** with the advisory tint, before the
  connection menu.

Not changed in 6b-2: nothing outside the gate. The prompt editors still
reload by remounting rather than following their record, as the decision
request editor does with `useDecisionRecordSync`. Moving them to a sync is a
change to the editors' state ownership, left for a later step.

Checks: `tests/recovery-view.test.ts` (five cases) was run against a stub
first and failed on its assertions; a sixth case for `recoveryMenuKey` was
written with the helper, so it was never shown failing. The gated
`tests/e2e/personal-workbench-recovery.spec.ts` covers a competing prompt
draft (mark, notice, Compare, "Use this one", the replaced copy and its
confirmed Discard), an orphaned request draft (switcher mark, Save as new) and
a selections candidate after an upgrade (Discard without confirmation, then
"Remove migration backup"). All three failed first because no chip existed.
With the drawer built, the first failed again with the editor still showing
the replaced draft, which the remount key fixed.

Review fixes: a fourth gated case covers "Use this one" on a decision prompt
after an edit in the session. It was written after the fix. With the memory
reset removed it failed on its assertion: the editor showed the session's edit
instead of the chosen draft. The two `recovery-view` cases for
`changesActiveCopy` and `recoveryGuidance` failed on their assertions against
stubs first.

### Step 7 decisions (approved November 5, 2026)

Step 7 lifts R4: with the gate on, a repeated experiment may run the selected
request draft or scratch. D12 left the plan's representation for review. The
user approved the recommended answer to each decision: Y1-A, Y2-A and Y3-A.

#### What the code does at `ae0f7c4`

An audit of the plan's readers changes D12's premise.

- **The plan's identity is the run's identity, not a pin.** A repeated
  plan's `commonInput` is `ResolvedRunInput` without `runId`
  ([runner/repeated-start.ts](../packages/runner/src/repeated-start.ts)).
  `ResolvedRunInput` requires `conversationId` and `conversationRevisionId`
  in RunTrace as well. Single runs of local input already fill them with I3's
  identity: a draft runs under its saved `conversationId` with a fresh
  revision ID, and a scratch runs under its `localConversationId` with a fresh
  revision ID ([local-chat-request.ts](../app/request/local-chat-request.ts)).
  None of these revision IDs reach `project.json`.
- **Nothing resolves a repeated plan's revision against the project.**
  Materializing a cell copies `commonInput`. The controller, the history list
  (`batchTitle`, `experiment-history.ts`) and the dialogs read only its
  target, options, response mode and tools. Only the CLI's headless summary
  echoes `conversationRevisionId`, and the CLI only plans from the project's
  launch default, so it never writes a local-input plan.
- **The plan holds what was sent.** `commonInput` freezes `messages`,
  `templateResolutions` and `environment` when the batch starts. What it does
  not say is that the input was unsaved, or which draft or scratch it came from.
- **Cell traces carry no `branchedFrom`.** `ChatCellExecutor.trace` calls
  `createRunTrace(state)` with no provenance. Under R3, every single run of an
  unsaved scratch records its branch point. A batch would silently drop it.
- **The plan codec is strict.** Any new field is a new ExperimentPlan version,
  and older readers reject an unknown version outright, for every plan written
  at it, not only the local ones.
- **Scope is chat repeated experiments.** Decisions have no repeated plan
  kind, and Q3 keeps suites on saved revisions. Step 7 changes neither.
- **Repeated runs stay local by default.** The approved Git presets keep
  `experiments/` and `traces/` untracked except under "Manage Git rules
  myself".

#### Decisions

- **Y1. Whether the plan changes version.**
  - *A. No new version (recommended).* A local-input plan records I3's
    identity in `commonInput`, exactly as a single local run's trace does,
    and stays ExperimentPlan v7. Nothing claims a saved revision that was not
    run: the fresh revision ID points at no shared revision. Older builds
    still open every batch. Final output keeps v8 as allocated. Cost: a plan
    cannot say it ran unsaved input, or which draft or scratch. A reader can
    only see that the revision is not in the project, which is also true of a
    plan copied from another project. This reverses the wording of D12's "take
    the next free ExperimentPlan version", for the reason above. Its approved
    outcome stands: no false shared pins, and repeated runs of local input.
  - *B. A new version with explicit provenance.* Add an optional
    `localInput` to the repeated plan:
    `{ kind: "request-draft"; baseConversationRevisionId }` or
    `{ kind: "scratch"; parent?; branchedFrom? }`. It takes the next free
    version at merge: v8 if it lands before final output's PR 2, which then
    moves to v9 under the [allocation convention](FINAL_OUTPUT_CONTRACTS.md#d1-format-version-allocation).
    Cost: every new plan is written at that version, so older builds reject
    all new batches. A batch would also record more than its own runs, since
    single local traces carry no such field. Making traces match would be a
    RunTrace version as well.
  - *C. An optional revision ID.* Rejected: the cells' traces need one, and
    I3 already supplies it.
- **Y2. `branchedFrom` on a scratch batch's cells (R3).**
  - *A. Every cell's trace records the scratch's `branchedFrom`
    (recommended).* The app passes it to the chat controller when the batch
    starts, and `ChatCellExecutor` hands it to `createRunTrace`. This is
    trace-only provenance in an existing optional field, so no format changes.
    It needs no persistence, because a batch does not resume across a reload.
    Evaluations and the CLI pass nothing and are unchanged.
  - *B. Cells record none.* R3 then covers single runs only, and lineage
    from a scratch batch is lost once the scratch is saved or discarded.
- **Y3. Saying the input is unsaved.**
  - *A. The confirmation dialog says it (recommended).* With a draft or
    scratch selected, the repeated experiment dialog adds an "Input" line:
    "Unsaved draft of *name*" or "Unsaved request". The history title is
    unchanged, since under Y1-A nothing records it.
  - *B. The history says it too.* This works only with Y1-B, because
    deriving it later from an unresolved revision ID is unreliable.
  - *C. Neither.*

#### Taken with them

These are decided under existing decisions rather than put to review.

- **The batch freezes its input.** Editing, saving or discarding the draft
  or scratch while the batch runs changes none of its cells, because
  `createRepeatedExperimentPlan` clones the prepared input.
- **Nothing to note for R2.** The proposal said the app would note every
  cell's run ID with the record's branch parent. Implementation found no
  caller: "Edit from here" exists only on the live single run, which a batch
  resets, and the Runs evidence view offers none. No branch can start from a
  cell, so nothing is noted. If one is added later, it takes R2's parent
  rules then.
- **Nothing outside the gate changes.** With the gate off there is no draft
  or scratch, and the repeat path is today's.

#### Verification planned

- Red first: a gated case in `tests/e2e/personal-workbench-request-drafts.spec.ts`
  runs a repeated experiment on a request draft. Today it fails on the R4
  message. Once fixed, it asserts that the plan's `commonInput` carries the
  draft's `conversationId` and a revision ID absent from `project.json`, and
  that `project.json` is byte-identical.
- With Y2-A: a scratch batch case asserts each cell trace's `branchedFrom`,
  and a runner unit test asserts the executor writes it and writes nothing
  when given none.
- With Y3-A: the dialog's Input line for a draft, a scratch and a saved
  revision.

### Step 7 delivered (November 5, 2026)

Repeated experiments on local input, behind the gate. With the gate off there
is no draft or scratch, and the repeat path is unchanged.

- **R4 lifted (Y1).** With a request draft or scratch selected, Repeat… is
  enabled. The plan is created as before from the prepared input, so it stays
  ExperimentPlan v7 and records I3's identity: the draft's saved
  `conversationId` or the scratch's `localConversationId`, with a fresh
  revision ID. No format, codec or CLI code changed.
- **Branch point on every cell (Y2).** `ChatCellExecutor` and the chat
  `ExperimentController` take an optional `branchedFrom` and write it on each
  cell's trace. The page passes it only from a personal session's local input,
  so a legacy pending branch, saved as a revision before it runs, still
  records none, as before. Evaluations and the CLI pass nothing.
- **Input line (Y3).** `localInputLabel` in
  [local-chat-request.ts](../app/request/local-chat-request.ts) names the
  input "Unsaved draft of *name*", "Unsaved draft" when the request is gone
  from the project, or "Unsaved request" for a scratch. The repeated
  experiment dialog shows it as "Input" under "Frozen request". A saved
  revision shows no line.

Checks: `tests/repeated-experiment-controller.test.ts` (Y2, with and without a
branch point) and `tests/local-chat-request.test.ts` (Y3, against a stub) were
run first and failed on their assertions: `undefined` where the branch point
and the label belonged. Two gated cases in
`tests/e2e/personal-workbench-request-drafts.spec.ts` cover a draft batch (v7
plan, the draft's conversation, a revision ID absent from `project.json`, an
unchanged `project.json`, no branch point) and a scratch batch (the local
conversation ID, each cell's `branchedFrom`). Both first timed out on a
disabled button. With an explicit assertion added, both failed on the R4
title. The earlier draft case's R4 assertions were removed.

With the gate on, steps 2–7 have all landed. Per D1 and D2, removing the gate
is the enabling change. It needs its own approval, which nothing here gives.

### Step 8 decisions (approved November 5, 2026)

Step 8 removes the gate (D1, D2): the app writes v19, every session is
`personal`, and the migration completion guard lifts. The user approved the
recommended answer to each decision: Z1-A, Z2-A, Z3-A, Z4-A and Z5-A.

#### What the code does at `2ec9222`

An audit and a probe run found gaps that the enabling change has to close
first, as well as the expected test churn.

- **The CLI cannot read v19.** `openNodeProjectFolder` parses with the active
  `parseProjectJson`, which opens v10–v18 and refuses v19
  (`tests/project.test.ts` asserts the refusal). "The CLI reads v19 shared
  definitions whatever the gate says" ([Gate (D2)](#gate-d2)) was never built.
  Once a folder is upgraded, `run`, `repeat` and `drift` would all fail on it.
- **The replacement guard ignores session-only drafts.** In a no-folder
  personal session, an edited prompt becomes a session-only personal draft. The
  title bar no longer says "Unsaved", and `requestProjectReplacement` counts
  only `projectDirty` and the legacy draft reason. Importing a project or
  opening a folder then replaces the session without a dialog, and the draft
  is lost. Closing the tab still warns, through the personal owner's
  `beforeunload`. With a folder, drafts are already in `.workbench/`, so
  replacement loses nothing.
- **The export wording does not say drafts are excluded.** "Export JSON
  copy…" and "Download project JSON…" write v19 shared definitions only (S2),
  which [JSON compatibility](#json-cli-and-backup-compatibility) allows only if
  the wording says so. It does not. The creation dialog's Git preset still says
  `project.json` includes "persisted drafts".
- **The request switcher breaks the composer header budget.** With a project
  open at 1280×800, the first message sits at 366.5 px against
  `composer-header.spec.ts`'s 326.5 px budget. The switcher row (T1) adds the
  40 px.
- **A short window starves the response output.** At 1280×560, two
  `evaluation-case-promotion.spec.ts` cases fail the layout audit: the
  response pane's `.output-scroll` is 89 px tall for 160 px of content.
- **The desktop host has never run a personal session end to end.** Its
  workbench, migration, reopen and recovery commands have Rust unit tests. The
  gated e2e suite runs in the browser only, and this environment cannot run
  Tauri. Merging to `main` publishes the `:main` container image at once. The
  macOS release is manual and off by default.

Probe: the 107 ungated specs, run in Chromium light against the app with the
flag on (a scratch config, not committed). 452 passed, 63 failed in 27 files.
The same 27 files with the flag off failed 3: both `batch-live-progress.spec.ts`
cases and the gated `personal-workbench-decision-drafts.spec.ts` scratch case,
which fail in this container whatever the gate says. That leaves **61 failures
in 25 files caused by the gate**. Apart from the findings above, they assert
today's behavior, which v19 changes on purpose:

- Folder autosave and the "Unsaved" title for edits that are now drafts:
  `project-tab-coordination` (15), `run-deep-links` (6),
  `project-replacement-guard` (6), `ui-ux-workflow-review` (4) and single
  cases in eight other specs.
- Revision counts and decision requests in `project.json` after an edit:
  `system-one-decision-requests` (6), `system-one-decision-suites` (2),
  `system-one-saved-prompts` (2), `system-one-prompt-evaluations` (1).
- The legacy "Pending branch" notice, which scratch replaces:
  `run-deep-links`, `runs-result-discovery`, `workbench-composition`.
- Test helpers that parse an export with the v18 parser:
  `prompt-model-recommendations`, `saved-prompt-experiment-review`,
  `structured-output-checks`.
- Settings scope text that sparse overrides (T2) changed:
  `inference-settings-panel`, `provider-protocols`.

#### Decisions

- **Z1. How the gate goes.**
  - *A. Remove it outright, in two PRs (recommended).* 8a lands the fixes
    below with the gate still in place, each tested on the gated server. 8b
    then deletes the flag, the `legacy` session mode and its manifest path,
    the second e2e server and the `personalWorkbench` fixture, and rewrites the
    61 cases for v19 behavior. This is D1 and D2 as approved, and D4's "the app
    keeps no v15 writer". Rollback is a revert of 8b.
  - *B. Default on, with an opt-out flag for one release.* Keeps the v18
    writer and both e2e servers for a release, and deletes them later. An
    opted-out build refuses every upgraded folder, so it helps only a team
    that has not upgraded. It reverses D4 for that release.
- **Z2. The CLI and pre-v19 folders.** Either way the CLI opens v19 with the
  strict shared parser, uses saved pins and the authored launch defaults, and
  never opens `.workbench/`.
  - *A. It also keeps opening v10–v18 (recommended).* Through the existing
    chain, in memory, writing nothing and running no template draft, as
    [JSON compatibility](#json-cli-and-backup-compatibility) allows. CI keeps
    working before and after a team upgrades.
  - *B. It refuses them.* It names the folder's version and says to upgrade
    it in the app. One parser, but every CI job breaks until someone upgrades.
- **Z3. Replacing a session that holds only session drafts.** Personal backup
  is 2e, so this is the interim.
  - *A. The guard counts them (recommended).* The replacement risk includes
    the personal owner's unpersisted work, and the dialog says how many
    unsaved drafts the switch would discard. "Save and switch" stays only
    where saving keeps those drafts; otherwise the choices are Cancel and
    "Discard and switch".
  - *B. Leave it to 2e.* A no-folder session loses its drafts silently on
    import or open until then.
- **Z4. The request switcher and the header budget.**
  - *A. Fit the switcher into the budget (recommended).* Move it into the
    composer header's existing line, so the first message stays at or above
    326.5 px. The budget came from the composer header slice of the
    [UX plan](UX_DISCOVERABILITY_PLAN.md) and still holds with the gate off.
  - *B. Raise the budget by the switcher's row.* Costs 40 px of request on
    every screen.
- **Z5. The desktop host.**
  - *A. Merge on browser evidence; gate the next desktop release on a native
    check (recommended).* The plan records a manual native checklist:
    open a v18 folder, Upgrade, draft and publish a prompt, save a scratch
    request, reopen, and settle a Recovery candidate. The next macOS release
    waits for it. Merging publishes only the `:main` image, which is the
    browser.
  - *B. Block 8b on that native check.* 8b then waits for someone with the
    desktop app.

#### Taken with them

These are decided under existing decisions rather than put to review.

- **Export and creation wording (JSON compatibility).** Both export actions
  say that unsaved drafts are not included, and the Git preset text stops
  saying `project.json` holds drafts.
- **The short-window layout is fixed, not exempted.** The audit failure is a
  starved scroller, which AGENTS.md says to fix.
- **Workbench v1 freezes (D9).** After 8b, any change to an arm versions the
  codec.
- **The completion guard lifts (D2).** The migration owner is already its
  only caller, so 8b removes the guard's gate condition rather than adding a
  caller.
- **Format numbers.** v19 becomes the active Project format, and the
  `ProjectFile` label in memory moves with it. Final output takes the next
  free Project version, v20, under the
  [allocation convention](FINAL_OUTPUT_CONTRACTS.md#d1-format-version-allocation).
  `PROJECT_FORMAT.md` and the plan index say so in 8b.
- **What stays as it is.** D15's assets (suites, tools, mocks, environments)
  keep direct shared writes until 2c, and the preview and Recovery drawer
  already say so. Two tabs on one folder keep best-effort detection.

#### Verification planned

- 8a, red first on the gated server: a CLI case that opens a v19 folder
  (refused today) and, with Z2-A, a v18 one; a replacement-guard case that
  imports over a session draft (no dialog today); the export wording; the
  header budget and the short-window layout with the gate on.
- 8b: the whole suite runs on one server, sharded in CI. Each rewritten case
  asserts the v19 behavior it now covers, not only the absence of the old
  one. With Z5-A, the native checklist is recorded as open.

### Step 8a delivered (November 5, 2026)

The audit's gaps are closed, with the gate still in place. Apart from the CLI,
every change applies only with the gate on.

- **The CLI reads v19 (Z2).** `openNodeProjectFolder` reads a v19 file with
  the strict shared parser and an older one through the existing chain, in
  memory, never upgrading it. `sharedProjectAsActive` and
  `declaredProjectSchemaVersion` moved to
  [shared-project.ts](../packages/core/src/shared-project.ts), so the app's
  manifest boundary and the CLI share them. A v19 file carrying a template
  draft is refused, not read as legacy.
- **The replacement guard counts session-only work (Z3).** The controller's
  `sessionOnlyWorkCount` counts drafts and scratch requests held with no
  store, and memory-only Recovery copies. Queued writes to a folder are not
  counted, because the outgoing session flushes them. The dialog says how many
  drafts the session holds. "Save and switch" appears only when saving
  chooses a folder. Implementation found that S2's carry-over did not survive
  a switch: the replacement closed the new folder's controller before it
  wrote, so the drafts never reached the folder. Saving before a switch now
  writes the session's records into the new folder's workbench through
  `persistSessionInto` and waits for them first.
- **Export wording.** Under "Export JSON copy…" the Project menu says
  "Exports leave out unsaved drafts.", and the download toast says it too. The
  creation dialog's definitions preset says drafts stay in `.workbench/`. A
  legacy session keeps today's wording.
- **The switcher fits the header (Z4).** It now sits in the Chat and Decision
  composer header lines and takes the remaining width, moving to its own line
  only below 200px. Its labels have a class, because the global label rule
  added a 16px margin that put the label above the select.
- **The short-window layout.** The cause was the title bar, not the response
  pane. "Not saved — shared saves need this older-format folder upgraded"
  pushed the topbar's controls onto a second row at 1280px, and with the
  upgrade banner below it a 560px window left the output 89px. The status now
  reads "Not saved — folder needs upgrading", since the banner explains the
  upgrade.

Checks, red first unless noted: `tests/cli-project-folder.test.ts` (a v19
folder opens and runs an evaluation with `project.json` byte-identical,
refused before; a v15 folder still opens; a drafted v19 file is refused). The
gated `tests/e2e/personal-workbench-replacement.spec.ts`: three cases, all
failing first on a dialog that never appeared. The Save-and-switch case then
failed again on an empty `.workbench/drafts/`, which is how the carry-over gap
was found. A gated case in `composer-header.spec.ts` (366.5 px, then 330 px
from the label margin, then within budget), a gated export case in
`personal-workbench-prompt-drafts.spec.ts` (no note), a gated one-row case in
`personal-workbench-upgrade.spec.ts` (Project menu at y 65.5), and
`project-creation-render.test.mjs` for the preset text. The
`sessionOnlyWorkCount` unit case in `personal-workbench-controller.test.ts`
was written after the code and was not run red. `evaluation-case-promotion.spec.ts`,
run with the flag on through a scratch config, passes its layout audit.

Not run: the whole suite with the flag on after these changes, the dark
theme project and the desktop host. `personal-workbench-decision-drafts.spec.ts`'s
scratch case and both `batch-live-progress.spec.ts` cases fail in this
container under four workers with or without the gate, and pass alone.

#### Native checklist (Z5)

Before the next macOS release after 8b, someone with the desktop app runs
these and records the outcome here:

1. Open a v18 folder: the upgrade banner shows, and shared saves are refused.
2. Upgrade it. `project.json` is v19, the source backup and `.workbench/`
   exist, and a draft edited before the upgrade survives.
3. Draft a prompt, quit and reopen: the draft is still there. Create a
   revision: `project.json` gains it and the draft file goes.
4. Save a scratch request. Run a repeated experiment on a request draft.
5. Leave a competing draft in Recovery and settle it with "Use this one".
6. Run `inference-lens run` on the upgraded folder.

8b removes the gate.

#### Decided for 8b (November 5, 2026)

The user approved both before 8b started.

- **The in-memory label stays v18 for now.** 8b makes v19 the only format the
  app writes and says so in `PROJECT_FORMAT.md`. `PROJECT_SCHEMA_VERSION`, the
  core parser chain, the v19 shared parser and the CLI's legacy path all
  depend on the in-memory label being 18, so moving it is a follow-up slice
  with its own review. The manifest boundary keeps relabeling until then.
- **One pull request.** 8a was never opened as its own PR, so 8a and 8b land
  together, with 8b in its own commits. Reverting those commits rolls back
  8b alone, as Z1-A intended.

### Step 8b delivered (November 5, 2026)

The gate is gone. The app writes Project v19, every project session is
personal, and the migration owner is the application's caller of migration
completion.

- **Removed (Z1).** `personal-workbench-gate.ts`, its Vite define, the
  `legacy` session mode and its manifest path, the second e2e server and the
  `personalWorkbench` fixture. `readProjectManifest` and
  `serializeProjectManifest` take no mode. A pre-v19 folder still opens and
  refuses shared saves until **Upgrade project…** (S1).
- **Wording.** The export note, the download toast and the definitions preset
  now always describe drafts in `.workbench/`. The composer's "Project
  settings" label, which only a legacy session could reach, is gone.
- **Format numbers.** `PROJECT_FORMAT.md` says new saves are v19, how a v10–v18
  folder or import opens, and that the in-memory label is still v18 (decided
  above). Final output takes Project v20 in
  [FINAL_OUTPUT_CONTRACTS.md](FINAL_OUTPUT_CONTRACTS.md).

Running every spec against personal sessions found three defects in the gated
code, each fixed with a case that failed first:

- **"Discard and switch" kept the draft.** The personal owner carried a
  session's records into any adoption of the same project, so re-importing the
  file after choosing to discard brought the draft back, and personal
  overrides survived a re-import. Records now carry only when the adoption
  saved the session into a folder or reopened it in place
  (`carriesSessionWork`). Until the next controller opens, render reads also
  skip a previous session that held its records only in memory. A folder
  session's records are on disk, so it stays readable: hiding it reset the
  composer during a link handoff. New case in
  `personal-workbench-replacement.spec.ts`; `request-settings-ownership.spec.ts`
  now expects a re-import to restore the launch defaults.
- **A folder reopened while Prompts was showing lost its draft on screen.**
  The prompt editor copies its draft when it mounts, so it kept the saved text
  after the folder's records loaded. Prompts now remounts once they finish
  loading. New case in `project-replacement-guard.spec.ts`.
- **Filling a variable of a prompt inserted into a request draft crashed the
  page.** `authoredDraft` resolved the launch revision with run overrides that
  named the draft's own template uses. The launch revision now resolves
  without them. Found by `ui-ux-workflow-review.spec.ts`, which failed on the
  error overlay.

Review of the pull request found two more, each fixed with a case that failed
first:

- **The first save of a session with no project lost its decision request.**
  Removing the decision fold left nothing to hold a request authored before
  any project existed, so the save's adoption reset the editor to the empty
  starter. A document created from a session with no project now folds the
  decision draft again, as it takes the chat request; once a project is open
  the draft still reaches `project.json` only through publication. New case
  in `personal-workbench-decision-drafts.spec.ts`.
- **Importing JSON over a folder showed the folder's prompt draft.** Render
  reads keep a folder session's controller until the next one opens, so the
  prompt editor, remounted for the import, copied a draft the imported session
  does not have, and nothing remounted it once the session-only controller
  opened. The personal owner now says whether its controller is the one
  opened for the current session (`current`), and Prompts treats a stale one
  as still loading. Reads stay as they were, since hiding a folder session's
  controller from every owner is what reset the composer during a link
  handoff. New case in `personal-workbench-prompt-drafts.spec.ts`.

Rewritten cases, by the v19 behavior they now assert:

- **Folders seed v19.** A new `serializeFolderProject` / `parseFolderProject`
  pair in `tests/e2e/support`; `importProject` also takes a file's exact
  text, so a v19 export can be re-imported as it was written.
- **Prompt and request edits are personal.** Where a case needed
  `project.json` autosave or an unsaved project, it now drives a suite edit,
  which is still a direct shared write (D15): tab coordination (15 cases),
  storage clarity, the failed-save guard, and Save and switch behind a link.
- **Drafts.** The title bar says "Session only" for session drafts, the
  replacement dialog counts them, exports leave them out, a folder's draft
  survives a switch without a question, and file-prompt drafts are read from
  `.workbench/drafts/`.
- **Requests.** A branch is a Local request scratch, not the Pending branch
  notice. Decision edits and prompt uses are local until Save, and Save never
  moves the launch default (D11). Settings and protocol scope say they are
  yours.

Checks: lint, typecheck, `test:core` (1959), the render and interaction tests,
and the build with the standalone server tests. The full e2e suite ran in
Chromium light (520 passed, 7 skipped, 1 failed) and the dark project (all
passed on rerun). The one light failure, the repeat dialog's modal contract,
also fails 3 times in 8 on the 8a commit, so it predates this step.

Not run: the desktop host. The native checklist above stays open, and the next
macOS release waits for it. Moving the in-memory label to v19 is the next
format step.

## In-memory v19 label (approved November 5, 2026)

**Status: the user approved the recommended answer to each decision: L1-A,
L2-A and L3-A. Delivered November 5; see below.** Since 8b the app writes
only v19, but owners still hold `ProjectFile`, which is `ProjectFileV18`: it
says `schemaVersion: 18` and its templates may carry a `draft`. The manifest
boundary relabels on every read and write (I1). This slice makes the
in-memory document say what the app writes.

### What the code does at `10512e7`

- **One label, four dependants.** `PROJECT_SCHEMA_VERSION = 18`
  ([project.ts](../packages/core/src/project.ts)) is the literal in the v18
  schema, the end of the v10→v18 chain and the version `createProjectFile`
  stamps. `parseSharedProjectFile` and `serializeSharedProjectFile` reuse the
  v18 codec by relabeling to 18 and back. `sharedProjectAsActive` and
  `serializeProjectManifest` relabel at the app boundary, and the CLI reads
  v19 through `sharedProjectAsActive` and v10–v18 through `parseProjectJson`.
- **The boundary is tight.** Only `app/workbench/project-manifest.ts` and
  the CLI's `openNodeProjectFolder` convert. Runner, contracts and the native
  host never read the label; the Rust tests use it only as opaque bytes.
- **The in-memory type still allows a template draft.** Personal sessions
  keep drafts in `.workbench/` and the templates owner overlays them as
  `template.draft` for the editors (`withPersonalDraft`). The core draft
  writers `updatePromptTemplateDraft` and
  `updateDecisionPromptTemplateDraft` remain, called only from
  `use-project-templates.client.ts` branches taken when
  `personal.enabled` is false. Since `materializeProject` starts a session,
  those branches appear unreachable, but nothing enforces it; a draft that
  reached the document would fail at save, as I1 intended, not at compile
  time.
- **Defect: the unsupported-version message omits v19.** Opening a v20 or v9
  document in the app or the CLI says "this build opens schema v10, v11, …,
  and v18", because the message lists the v18 chain. Reproduced with
  `readProjectManifest`.
- **Likely defect: Update from file no longer reserves a draft's variable
  names.** `planFilePromptUpdate` reserves names used by `template.draft` and
  by template uses in shared conversation revisions. The app passes it the
  shared document, which since 8b holds neither prompt drafts nor request
  drafts and scratch, so names that exist only in personal work are not
  reserved. Not yet shown by a test.
- **Thirty e2e specs seed older-format folders by accident.** They write
  `project.json` with `serializeProjectFile`, which writes v18, so they open
  as legacy folders that refuse shared saves. 8b added
  `serializeFolderProject` for v19, and some specs use it. Unit tests assert
  `schemaVersion` 18 in about 25 files.

### Decisions

- **L1. What the in-memory document is.**
  - *A. The v19 shape, with no `draft` (recommended).* `ProjectFile` becomes
    the shared document: `schemaVersion: 19`, templates without `draft`.
    The core draft writers and the unreachable legacy branches go. Editors
    read drafts from a view type the templates owner builds from the
    personal record, not from `ProjectFile`. A draft reaching the shared
    document becomes a type error. This is the alternative I1 set aside only
    because it meant rewriting helpers while the gate was on.
  - *B. Relabel only.* `schemaVersion: 19` in memory, `draft?` stays on the
    type, the boundary keeps rejecting drafts at save. Smallest change; the
    invariant stays a runtime check.
- **L2. How older documents open.**
  - *A. Only through the migration plan (recommended).* `parseProjectFile`
    and `parseProjectJson` validate the active v19 document only. The
    v10→v18 chain becomes private input to `planSharedProjectMigration`,
    which already returns shared definitions plus drafts. The CLI's legacy
    path uses the plan and drops its drafts, as Z2-A says ("running no
    template draft"). No caller can open an old file and lose drafts
    without being told.
  - *B. Keep the chain public.* `parseProjectFile` keeps accepting v10–v19
    and upgrading in memory, stripping drafts silently. Fewer call-site
    changes; reverses the rule in `parseSharedProjectFile`'s comment that
    legacy input goes through the planner.
- **L3. Test fixtures.**
  - *A. Fixtures write v19 unless they mean otherwise (recommended).*
    `serializeProjectFile` writes the active format, so the thirty specs
    seed v19 folders like a current user's. Specs that test older folders
    (upgrade, recovery, CLI legacy) use a named test-support writer for v18,
    kept with the migration tests.
  - *B. Keep `serializeProjectFile` as the v18 writer.* Rename it to say
    legacy; the thirty specs keep opening legacy folders.

### Taken with them

- **The unsupported-version message lists v19** and, for a legacy version,
  says the app upgrades it. Red first in `project.test.ts`.
- **Update from file reserves personal names.** The templates owner passes
  the names in the prompt's personal draft and in request drafts and scratch
  that use it. Red first: a case where a draft-only name is reused.
- **Formats stay as they are.** No on-disk format changes: v19 files, the
  workbench v1 codec, RunTrace and ExperimentPlan are byte-identical before
  and after. `PROJECT_FORMAT.md` drops "In memory the app still labels the
  document v18".
- **One pull request,** in commits: core type and parser, app owners, test
  fixtures.

### Verification planned

`test:core`, typecheck, lint, the render and interaction tests, the CLI
folder tests, and a byte comparison of `project.json` written before and
after for a representative project. Since saving and opening are
user-visible, the e2e specs that save, import, upgrade or recover
(`personal-workbench-*`, `project-replacement-guard`,
`project-tab-coordination`, `file-prompt-*`, `linked-prompt-sources`) run locally, and CI runs the
rest. No desktop change.

### In-memory v19 label delivered (November 5, 2026)

`ProjectFile` is the shared document, in memory as on disk.

- **Core (L1-A, L2-A).** `PROJECT_SCHEMA_VERSION` is 19 and `ProjectFile` is
  `ProjectFileV19`: v18's content, with templates that have no `draft`.
  `parseProjectFile`, `parseProjectJson` and `serializeProjectFile` read and
  write v19 only. They took over v19's two checks: a named refusal of a
  template draft, and secret fields inside provider-option arrays.
  `shared-project.ts` is gone, with `sharedProjectAsActive`;
  `declaredProjectSchemaVersion` moved to `project.ts`. The v10→v18 chain is
  `parseLegacyProjectFile`, marked internal, and only
  `planSharedProjectMigration` calls it. Given a v10–v18 document,
  `parseProjectFile` refuses it and says the app upgrades it. The draft writers
  `updatePromptTemplateDraft` and `updateDecisionPromptTemplateDraft` are gone.
- **Boundary.** `readProjectManifest` and `serializeProjectManifest` no longer
  relabel. The CLI reads a legacy folder through the plan and drops its drafts
  (Z2-A).
- **App owners.** The editors read `PromptTemplateView`
  ([prompt-template-view.ts](../app/templates/prompt-template-view.ts)): the
  shared template plus the user's draft. The templates owner builds it from the
  personal record, or from a session-only prompt's own state. A draft edit to
  a project prompt always goes to the personal workbench. The two branches
  that wrote a draft into the shared document are gone. The save fallbacks
  that append a revision directly are still there, since they write no draft.
- **Version message.** The message lists v10 to v19 and says this build
  upgrades v10–v18 to v19. Its regression case is in `project-manifest.test.ts`
  rather than `project.test.ts`, because the defect was reproduced through
  `readProjectManifest`. It ran red on the v18-only list.
- **Update from file.** `planFilePromptUpdate` and `applyFilePromptUpdate`
  take `FilePromptPersonalUses`. That covers the prompt's personal draft and
  the items of every chat request draft and scratch. The templates owner fills
  it from the personal workbench. Apply takes it too, so the names it writes
  match the preview. The case in `file-prompt-update.test.ts` ran red: names
  that only a draft or a scratch used were reused.
- **Fixtures (L3-A).** `serializeProjectFile` writes v19, so the specs that
  seeded v18 by accident now seed v19 folders. `serializeFolderProject` and
  `parseFolderProject` are folded into it. The test-only legacy writers are in
  [legacy-project-helpers.ts](../tests/legacy-project-helpers.ts):
  `serializeLegacyProjectFile`, `withLegacyPromptDraft` and
  `openLegacyProject`. The upgrade, recovery, replacement and CLI legacy cases
  use them. Chain tests open their input through the plan, so they run on the
  same path as the app. Some legacy rejection cases matched only the generic
  "Invalid Inference Lens project" prefix, which the new "older format"
  refusal would also satisfy. They now open through the plan and match a
  specific message.
- **Formats.** No on-disk change. HEAD and this branch write byte-identical
  `project.json` for:
  - the v15 and v19 examples;
  - the v15 example's lifted drafts and its migration journal files;
  - the headless and linked-prompt fixtures, compared by rewriting this
    branch's bytes with HEAD.

  The one difference found is the intended one: a v7 file's refusal now
  lists v19.

Decided during implementation: the legacy writers live with the migration
test helpers, not under `tests/e2e/support`. The message wording is as above.
`applyFilePromptUpdate` takes the personal uses as an option.

Checks: lint, typecheck, `test:core` (1963), and the render and interaction
tests (226). The e2e specs ran in Chromium light, on the pinned build.

- The planned set, `personal-workbench-*`, `project-replacement-guard`,
  `project-tab-coordination`, `file-prompt-*` and `linked-prompt-sources`:
  68 passed.
- The other 34 specs that seed folders with `serializeProjectFile` or read
  an export: 175 passed and 1 failed.
- The failure, `run-deep-links.spec.ts` "a folder's branch stays in its
  workbench when a link switches projects", fails at the same line on the
  parent commit: 3 times in 6 there, 2 in 6 here. It predates this slice.

Not run: the dark project, the rest of the suite, and the desktop host.
