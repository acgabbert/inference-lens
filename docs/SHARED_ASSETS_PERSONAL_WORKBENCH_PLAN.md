# Shared assets in a personal workbench

**Status:** Level 1 implemented October 25, 2026; verification recorded below.
Level 2 design choices were approved October 25, 2026, as recorded below.
On October 26, the user approved a bounded first implementation slice: isolated
v17/workbench v1 core codecs and an in-memory migration planner. That
[core foundation](SHARED_ASSETS_LEVEL_TWO_DESIGN.md#first-core-slice-october-26-2026)
is implemented. The subsequent approved
[recovery-store foundation](archive/SHARED_ASSETS_RECOVERY_STORE_SLICE.md) implements
opt-in browser/native storage for those existing records; app and CLI
persistence remain v15. The subsequent approved
[migration-journal foundation](archive/SHARED_ASSETS_MIGRATION_JOURNAL_DESIGN.md) adds
opt-in protected staging and read-only restart classification without replacing
the manifest or activating personal candidates. The next
[completion design](SHARED_ASSETS_MIGRATION_COMPLETION_DESIGN.md), approved
October 28, defines an opt-in shared commit, candidate activation and
stale-handle invalidation; the core module is implemented and the browser and
native adapters are in progress. Slice 2a's remaining
persistence, recovery and compatibility proposals still need review before
integration. Level 3 remains proposed. The product direction is agreed:
Inference Lens is a personal workbench for potentially shared assets. Approved
choices are distinguished from the remaining schema and recovery mechanics that
still need design review.

**Renumbered 2026-10-29:** the staged shared format is now **v17**; v16 went
to the active format for [prompt environments](PROMPT_ENVIRONMENTS_PLAN.md),
which v17 will carry. Dated verification records and archived documents keep
the number that was current when they were written.

## Intended experience

Opening a project opens assets in your own workbench. You can use a team's
prompts, try different inputs and models, inspect results, and resume your drafts
without changing the team's definitions merely by doing your work.

Saving an asset revision is an intentional contribution to the local project
files. Git commit and push remain separate actions that determine when teammates
receive it. Local recovery saves should preserve unfinished work without making
it part of the shared asset definition.

Projects need not be collaborative or live in Git. A person working alone gets
the same separation between reusable assets and experimentation, and can later
choose which assets to share. A Git checkout contains definitions; it does not
need to recreate the last operator's entire workspace.

The three delivery levels are:

1. **Share definitions, keep evidence local.** Add selective Git protection to
   today's bundle without changing `project.json`.
2. **Separate assets from personal working state.** Stop ordinary experimentation
   and draft recovery from rewriting shared definitions.
3. **Make assets independently shareable.** Introduce an asset file layout and
   dependency contract that supports selective version control and reduces
   unrelated merge conflicts.

Level 1 is useful independently, but it does not deliver the complete intended
experience. Level 2 establishes ownership; level 3 changes physical organization.

## Current behavior and constraints

The current strict Project v15 document owns conversations and their revisions,
prompt templates and their revisions and drafts, tools and mock fixtures,
external-import receipts, evaluation suites, decision requests and revisions,
connection requirements, and defaults. See [the core contract](../packages/core/src/project.ts)
and [project format](PROJECT_FORMAT.md).

Several ordinary activities therefore create shared-file churn:

- Prompt authoring persists one working draft on each project template.
- Request editing changes authored conversation state. Branching can move the
  project's default conversation revision.
- Saved request settings include the default model, protocol, inference options,
  and enabled tools.
- Saving a template revision changes its shared `currentRevisionId`; concurrent
  changes need a meaningful choice even if both revisions can be retained.
- Separate entities occupy arrays in one file, so logically independent additions
  may still produce textual Git conflicts.

Some useful boundaries already exist:

- Traces are immutable files under `traces/`, outside the project manifest.
- Experiment plans, results, and reassessments are under `experiments/`.
- Baseline pins and case-source annotations have separate files.
- Credentials, local connection mappings, and execution grants are outside the
  portable project. Per-run template overrides are already session state.
- Serialization is deterministic, identities are stable, and uses pin revisions.
- Browser and native saves detect external manifest changes and refuse to
  overwrite them. The CLI reads the manifest and writes new immutable evidence.

These boundaries should be reused. This plan does not require a redesign of
provider requests, the run kernel, or historical trace formats.

## Ownership model

The distinction is intentional reusable content versus the operator's current
work. A field is not personal just because it is editable, and a field is not
shared just because recovery needs to persist it.

| Concern | Shared asset responsibility | Personal workbench responsibility |
| --- | --- | --- |
| Prompts/templates | Saved revisions, names, archive state, explicit current revision, recommendations | Unpublished edits and draft recovery, selected editor revision |
| Conversations and decision requests | Requests explicitly saved for reuse, with stable identities and revisions | Scratch requests, current conversation, experimental branches and input values |
| Template values | Deliberately saved reusable defaults and fixture values | Values supplied for a trial run and local overrides |
| Execution settings | Reproducible suite settings, recommended targets, deliberately saved configurations | Current model/configuration selection, temporary option and tool overrides |
| Evaluations | Suites, cases, checks, references, configurations and pinned input definitions | Selected suite/cases, execution controls, evidence comparisons and baseline pins |
| Tools | Definitions and deliberately authored shared mock fixtures | Local executor bindings, permissions, temporary fixtures and tool selections |
| Connections | Portable requirements and declared expectations | Local profiles, credentials, mappings, and actual runtime resolution |
| Imports | Provenance required to explain or reproduce a saved imported definition | Import staging and edits not yet saved as assets |
| Evidence | Only separately and explicitly selected evidence, if supported | Traces, experiment plans/results, reassessments and source annotations by default |

Shared recommendations and personal selections must remain distinct. Trying a
different model must not edit a template's recommendation. A saved suite must
still declare enough execution intent to be reproducible; personal overrides
must be explicit and captured in the resulting run evidence.

Promoting evidence into a saved conversation, template, mock fixture, or evaluation
case is an intentional copy into authored content. Excluding trace files cannot
make that copied content private. Existing historical and archived revisions also
remain part of an asset unless deliberately removed through valid operations.

## Level 1: selective Git protection

**Size:** Small. No project schema change.

### Confirmed contracts (October 25, 2026)

- All three presets below are approved; private remains the default.
- Core owns a creation-only `ProjectGitPolicy` (`private`, `definitions`, or
  `unmanaged`) and resolves it to ignore-file contents or `null`. The policy is
  not serialized into `project.json` and changes no provider contract.
- `ProjectCreationDialog` owns the selection; `ProjectCreationOptions` carries
  it through the existing workspace owner. Browser creation writes the resolved
  contents; the native bridge passes the same contents to Rust, which owns I/O
  and rollback. There is no duplicate Rust policy generator.
- Policy generation happens only on bundle creation. Existing projects and
  ordinary saves keep their policies, including customized rules.
- The dialog explains that the definitions preset includes persisted drafts
  and saved values inside the unchanged manifest.

### Proposed behavior

Offer three project-creation presets:

| Preset | Effect |
| --- | --- |
| Keep the project out of Git | Preserve the existing `*` protection |
| Share definitions; keep run history local | Track the manifest and ignore policy; exclude everything else by default |
| Manage Git rules myself | Omit the generated ignore file |

Keep the current private default unless a separate product decision changes it.
Do not silently rewrite existing projects' policies. Explain that the definitions
preset shares all content in `project.json`, including persisted drafts and saved
values until level 2 is delivered.

The generated bundle-local policy for the definitions preset is:

```gitignore
*
!/.gitignore
!/project.json
```

Use an allowlist so new evidence/artifact types are excluded automatically.
The browser and Tauri adapters must generate the same policy before writing
project content, preserving creation rollback behavior. Ordinary project saves
must not regenerate or overwrite a user's customized ignore file.

For existing projects, document the exact replacement policy and how to inspect
already tracked files. Gitignore is staging policy, not access control: it does
not untrack existing commits or prevent force-adding a file. The app must not
remove files from the Git index or rewrite history as part of this feature.

### Acceptance criteria

- A fresh Git repository stages only `project.json` and `.gitignore` for the
  definitions preset, including after runs, evaluations, and baseline/source
  annotations have been saved.
- The existing private and unmanaged choices retain their behavior.
- Opening a clone without local evidence succeeds; running creates local evidence
  without dirtying shared definitions merely to register trace paths.
- Copy explicitly states the remaining single-manifest sharing boundary.

### Level 1 delivery evidence (October 25, 2026)

- Before implementation, the new workspace tests failed on `null` instead of
  the exact definitions allowlist, and on missing native policy contents.
  `npm run test:e2e -- tests/e2e/project-git-policy.spec.ts` failed on the
  creation dialog's actual text, which lacked the sharing preset.
- `node --experimental-strip-types --test tests/project-workspace.test.ts`
  passed 14 tests: creation ordering, exact policy, preservation of customized
  rules, bridge arguments, and rollback/retry for failed policy or manifest
  writes. Its disposable real Git repository stages only the manifest and
  ignore file after representative evidence, annotation, recovery, and future
  nested paths are added; it also proves force-added evidence stays tracked.
  Those path fixtures test Git policy, not evaluation execution.
- `npm run test:e2e -- tests/e2e/project-git-policy.spec.ts
  tests/e2e/project-storage-clarity.spec.ts tests/e2e/new-project-isolation.spec.ts
  tests/e2e/project-replacement-guard.spec.ts` passed 12 tests. The new spec
  covers all three presets, the sharing warning, and opening a definitions-only
  clone without evidence. An actual buffered fixture request then saves one
  trace while the manifest stays byte-identical. The folder picker is stubbed;
  the browser workspace adapter and provider transport are real.
- The final full `npm run test:e2e` passed 340 tests with seven opt-in Python
  MCP/N1 tests skipped. This includes existing evaluation, baseline, and
  case-source workflows; the new Git staging assertions use the representative
  paths described above rather than a native or CLI-created Git checkout.
- `npm run lint`, `npm run typecheck`, `npm run typecheck:core`, and `npm test`
  passed. Lint has four pre-existing unused-variable warnings. `npm test`
  includes the production build and 1,756 core, contract, version, rendered,
  interaction, and CLI tests.
- `npm run test:rust` passed 28 tests, including real native filesystem writes
  for all presets and preservation of customized rules. `npm run check:rust`
  passed formatting and Clippy. Native picker interaction and injected native
  filesystem failures were not exercised; write-failure injection is covered
  through the browser adapter. Hosted providers were not used.
- Human review should check whether the three preset descriptions make the
  remaining manifest-wide sharing boundary clear. Personal-state separation
  remains Level 2 work.

## Level 2: separate personal state from asset definitions

**Size:** Moderate. Ownership, persistence, UX, and compatibility changes.

### Confirmed design choices (October 25, 2026)

Keep the shared project format mostly intact for Level 2, retaining the monolithic
asset document while separating personal state. Defer independent asset files to
Level 3. Removing drafts and separating defaults still requires an explicit
versioned schema transition; this agreement does not change Project v14 in place.

1. **Asset versus workbench types.** Introduce separate typed models for shared
   definitions and recoverable personal state. Do not make a second complete copy
   of the project document as the local model. A draft should identify its asset,
   source revision, and edited fields; selections and overrides should have their
   own contracts. Working definitions needed only for scratch requests stay local.
2. **Personal persistence location.** Use a checkout-local `.workbench/` directory
   for folder projects. Browser and native hosts use the same store through their
   workspace adapters. Write `.workbench/.gitignore` containing `*` before any
   personal content, including migration backups containing legacy personal
   content. Do not rely on or regenerate the bundle's creation-only Git policy:
   unmanaged and older bundles may have no rule excluding the directory.
   Verify protection using a real Git repository, including a bundle with no
   bundle-level `.gitignore`. The store works with existing folder access and can
   be inspected directly, although as a dot-directory it is hidden by default in
   Finder and many file pickers. Copying the folder also copies its personal
   state. Gitignore is not access control and cannot prevent force-adding files.
3. **Workbench identity.** Use one personal workbench per checkout initially.
   The folder defines the workbench; `projectId` validates its association rather
   than acting as a device-wide lookup key. Independent clones/worktrees do not
   share drafts. Moves retain the store, and full folder copies carry its personal
   state with them. A copy is indistinguishable from a move by design: it has
   the same `projectId` and `.workbench/` contents, and browser folder access
   exposes no stable path or inode to compare. Do not attempt copy detection.
   Define mismatch handling when the project identity changes.
   One checkout used by several people is not user isolation; independent users
   should have independent checkouts. Multiple named workbenches can be a later
   extension if required.
4. **No-folder mode.** Imported JSON and scratch-only sessions remain session-only
   until a folder is chosen, with clear recovery-status wording. Do not silently
   persist prompt or input content in browser storage. Explicit recovery opt-in
   outside folder projects is deferred.
5. **Defaults.** Keep deliberately authored launch defaults/recommendations and
   reproducible suite settings shared. Last-used selections, trial values, and
   temporary execution/tool overrides are personal. Classify each existing field
   before changing writers; named reusable execution configurations are not a
   prerequisite for this separation.
6. **Scratch versus saved requests.** Scratch requests start personal by default,
   with an explicit save-as-asset action. Editing a saved asset creates a personal
   draft; it does not continuously modify the shared definition. A draft records
   its asset, base revision, and edited content.
7. **Concurrent writers.** Detect concurrent workbench writes and refuse silent
   overwrites, including across browser/native hosts and app windows. Extend the
   existing external-manifest-change detection used by browser and native saves to
   workbench records rather than introducing a separate mechanism. Full live
   coordination is deferred; the recovery path after a detected conflict remains
   to be designed.
   **Revised October 26, 2026:** browsers offer no exclusive create or atomic
   compare-and-swap on folder files, so the cross-host part of this guarantee
   cannot be met. Workbench records use best-effort detection instead:
   same-host coordination where available, an expected-content check before each
   write, and a read-back after it. A conflict between two hosts writing the
   same record inside one check-then-write window is detected by the overwritten
   writer at its next check, while its edits are still in memory. See
   [write safety](SHARED_ASSETS_LEVEL_TWO_DESIGN.md#layout-identity-and-concurrent-writes).
8. **Migration and exports.** Preserve existing saved content as shared assets;
   move only explicit drafts into personal storage and copy old selections into
   personal state. Because selections are copied rather than moved, the legacy
   values left in the shared document become authored launch defaults; the
   migration examples must show this, and the preview should state whether it
   offers to demote them. Shared definitions are the default export; personal
   backup is a separate explicit operation. Preserve untouched migration sources and keep
   failed or interrupted writes recoverable.

### Next design deliverable: slice 2a

The [slice 2a review](SHARED_ASSETS_LEVEL_TWO_DESIGN.md) inventories the v15
fields after System One saved prompts/evaluations, supplies concrete before/after
JSON, and proposes contracts for review. Review revised it on October 26, 2026:
best-effort write safety (choice 7 above), publication intent kept in the draft
record, an explicit launch-default writer, the reason for the v17 bump, and a
delivery order that limits slice 2b to the arms migration and trial runs need.
No checklist item below is approved merely by that proposal.

The subsequent core-slice approval covers the shared v17 shape, extracted prompt
draft and copied-selection v1 records, and pure migration planning while the
application stays on v15. It does not approve the full 2b persistence contracts
below. See the [implemented API boundary](SHARED_ASSETS_LEVEL_TWO_DESIGN.md#first-core-slice-october-26-2026).

The later [recovery-store approval](archive/SHARED_ASSETS_RECOVERY_STORE_SLICE.md) covers
layout for those existing arms, exact self-ignore protection, foreign-project
write blocking, expected-content checks and read-back, same-host coordination,
and per-record conflicts/failures. These are implemented as opt-in storage;
the application does not yet migrate, recover editors or publish through it.

The approved [migration-journal foundation](archive/SHARED_ASSETS_MIGRATION_JOURNAL_DESIGN.md)
implements compact migration draft identities, exact-byte backups and descriptors,
protected staging and read-only restart classification. Manifest replacement,
active-candidate reconciliation and application integration remain deferred.

Produce a field-by-field ownership inventory and concrete before/after migration
examples for a prompt, chat request, decision request, and evaluation suite.
Include saved values, defaults, branches, temporary fixtures, import receipts,
revision pins, and evidence references. Apply the approved choices above without
guessing whether legacy saved content was intended to be personal.

Review the inventory and examples before implementing persistence. The approved
direction does not yet specify these contracts; settle each during the review:

- [ ] Exact types and owner interfaces for shared definitions and workbench state
- [ ] Schema versions and codecs for the shared document and workbench store
- [ ] Workbench record layout under `.workbench/`
- [ ] Project-identity mismatch handling
- [ ] Best-effort concurrent-write detection on workbench records and the conflict
  recovery path
- [ ] Draft publication ordering: write the shared revision first, clear the draft
  only after that write is confirmed, and recognize a published-but-not-cleared
  draft on restart. This applies to every revision save, not only migration.
- [ ] Migration write ordering and restart recovery
- [ ] Personal backup representation and restore behavior
- [ ] Old-reader/writer, existing JSON, and CLI compatibility

When implementation starts, move the Level 1 Git staging fixture in
[the workspace tests](../tests/project-workspace.test.ts) from
`workbench/recovery.json` to `.workbench/`, and add a bundle without a
bundle-level `.gitignore` to prove the self-ignore alone protects it.

### Proposed workflows

- Opening a project loads shared assets and restores this checkout's personal
  state. With no personal state, explicit project recommendations may seed the
  initial view; selecting something else remains personal.
- Editing an asset updates a locally recoverable draft. Saving a revision writes
  the intended shared definition and resolves or clears that draft only after the
  shared write succeeds. Failed writes preserve recoverable edits.
- Saving an asset locally does not commit, push, or claim teammates have received
  it. UI wording distinguishes local draft recovery, asset save, and run evidence.
- Running a scratch request or using an existing prompt with temporary values,
  target, options, or tools does not mutate shared definitions. Required temporary
  definitions are resolved from the workbench without first materializing assets.
- Saving a scratch request or promoting evidence previews the authored content
  that will be copied. It must not silently include unrelated drafts or history.
- If the asset changes externally while a draft is open, retain the source
  revision and local edits, report divergence, and offer an explicit comparison
  and reconciliation path. Do not silently replace either version or rebase a
  draft onto different content. Deletion or branch switching must not discard it.
- Missing evidence remains a supported state; baseline/source references to
  unavailable evidence do not prevent shared assets from opening or running.

Keep current evidence directories initially if practical; changing their paths
is not necessary to separate ownership. Their default sharing policy stays
local. Recovery files must exclude credentials and retain explicit storage/error
status; automatic local persistence must not imply an access-control guarantee.

### Migration and compatibility

- Inventory every persisted field, including import receipts, draft values,
  request branches, and evaluation references. Classify it before changing writers.
- Use explicit versioned formats for the shared definition and workbench store.
  Do not silently change what existing schema versions mean or loosen strict
  parsers. Choose exact version numbers during slice 2a's contract review.
- [System One saved prompts](archive/SYSTEM_ONE_SAVED_PROMPTS_PLAN.md#relationship-to-shared-assets-level-2)
  owns project schema v15 (accepted October 25, 2026), now present on the base
  branch assumed to land unchanged for slice 2a; Level 2's
  shared-definition change takes a later version. Slice 2a's inventory must
  include its decision template arms, decision template drafts (same draft
  envelope as chat drafts), and template-use `overrides` on decision request
  revisions, so one migration step moves chat and decision drafts together. If
  Level 2 implementation starts before that plan's schema step, revisit the
  order with the user rather than racing for the version.
- Preview migration and preserve an untouched source. Existing conversations,
  revisions, values, and configurations may be intentional shared assets; retain
  them as definitions unless the user deliberately chooses otherwise. Copy
  recoverable template drafts into personal storage before removing them from the
  new shared representation. Copy old default selections into personal state;
  deliberate reusable execution defaults must not be discarded.
- Migration must be restartable, detect partial writes, and avoid leaving the
  only copy of a draft in an ignored file that was never successfully written.
  Any backup containing legacy personal content is local and excluded by default.
- Export shared assets without personal state by default. Provide personal backup
  as a separate explicit operation; define its exact representation and restore
  behavior during contract review. Until a new portable format is approved,
  retain a documented compatibility path for existing JSON.
- CLI evaluation must work from shared assets alone, without a personal workbench.
  Update or version any command that formerly relied on mutable workbench defaults.
  Preserve app/CLI coexistence for immutable evidence writes.

### Acceptance criteria

- Two independent checkouts of the same project keep different drafts, selected
  requests, model choices, and input values across reopen without sharing them.
- After opening an existing asset, trial edits, scratch runs, and personal settings
  changes leave shared files byte-identical. An explicit asset save changes only
  the intended definitions and required dependencies.
- A shared save failure, local recovery failure, external edit, or missing/deleted
  base revision cannot silently lose the draft or claim it was saved.
- The workbench's own ignore file protects personal content under private,
  definitions, unmanaged, and older unprotected bundle policies before the first
  recovery write. Concurrent writers on one host cannot replace each other's
  state; a cross-host race is detected while the overwritten edits remain in
  memory, and status wording claims no more than that.
- Folder moves and full copies retain recovery; independent clones stay separate;
  project-identity mismatches have explicit behavior. No-folder sessions
  clearly report session-only recovery until a folder is chosen.
- Persisted asset pins and historical evidence retain their meaning through
  migration. A fresh clone and the CLI need no other person's local state.

## Level 3: independently shareable asset files

**Size:** Larger. Bundle format, reference resolution, multi-file writes, migration,
and cross-host loader changes. Build on level 2 rather than mixing personal state
into each asset file.

### Proposed layout and representation

Keep `project.json` as a small project identity/format document and move cohesive
asset definitions into separate files. The following is illustrative, not a final
directory or extension contract:

```text
example.inference-lens/
  .gitignore
  project.json
  assets/
    prompts/<stable-id>.json
    requests/<stable-id>.json
    tools/<stable-id>.json
    mocks/<stable-id>.json
    suites/<stable-id>.json
    connections/<stable-id>.json
  .workbench/                 # personal; contains its own .gitignore
  traces/
  experiments/
  evaluation-baselines.json
  evaluation-case-sources.json
```

Recommend one file per asset with its revisions kept together initially. This
reduces conflicts between different assets and preserves cohesive review; it
still leaves conflicts over the same asset and its current revision. One file
per immutable revision reduces concurrent append conflicts further but adds
many files and more complex loading/lifecycle rules. Choose that only if the
expected collaboration pattern warrants it.

Use stable IDs for references and filenames; display-name changes should not
rename every dependent file. Define chat and decision request discriminators,
asset schema versions, duplicate-ID handling, validation limits, path safety,
and deterministic serialization before writing the format. Prefer discovering
assets in designated directories over rewriting a central inventory on every
addition, while strictly reporting invalid recognized asset files.

### Selective sharing and dependencies

File boundaries enable Git selection, but selections must form a usable set:

- A template may depend on a connection requirement and imported provenance.
- A saved request may pin template revisions and use tools or mocks.
- A suite may depend on saved inputs, tools, connection requirements, and fixtures.
- Provenance needed by an asset must travel with it or be an explicit dependency;
  private staging receipts must not become a hidden shared dependency.

Define a core dependency graph and a closure operation. Recommend a selection
preview/export that includes required definitions, preserves pinned revisions,
and explains why each dependency is included. Do not automatically include
referencing consumers: sharing a template should not pull in every conversation
or suite that uses it. Do not flatten pins or silently substitute a newer revision.

Define sharing-policy ownership too: a committed ignore policy establishes the
team's intended shareable files; personal exclusions stay local. A person must
be able to keep an experimental asset outside that set without changing the
team's policy. An ignored candidate asset must not accidentally satisfy a missing
dependency that makes an otherwise incomplete clone appear valid. Validate the
selected share/export set independently of all files present in the operator's
checkout, and make candidates that depend on private assets visibly incomplete.

Git rules can select files, not fields or historical revisions within one file.
Sharing only a current revision or sanitizing fixture values requires an explicit
export/copy operation with its own identity and provenance rules. This plan does
not promise arbitrary field-level sharing.

Initial scope is assets inside a self-contained project and deliberate copies
between projects. Live references into other repositories, package registries,
or remotely synchronized libraries require a separate dependency/version design.
[External prompt sources](#external-prompt-sources) proposes that design for
prompt files tracked from another repository.

### Writes, external changes, and compatibility

- Separate the loaded in-memory asset graph from its on-disk layout. Execution
  resolves provider-neutral input from a validated snapshot; runtime credentials
  and provider adapters do not become asset-file concerns.
- Check the expected contents of each file being replaced. Changes to a different
  asset should not block an independent save; changes to the same asset require
  explicit reconciliation. Preserve unaffected local drafts during reload.
- Saving a suite, request, or imported asset may write several dependent files.
  Specify write ordering, recoverability, and detection of incomplete writes for
  browser, native, and Node hosts; do not assume transactional directory renames
  are available everywhere. A partial save must never be reported as complete.
- Keep unsupported versions, unresolved references, duplicate IDs, and Git conflict
  markers explicit. Valid independent assets should remain inspectable where
  possible; incomplete assets must not run with guessed dependencies.
- Provide a lossless migration from supported monolithic projects with source
  preservation and a documented export/import route. Decide old-writer behavior;
  older apps must not mistake a thin manifest for a complete editable old project.
- Preserve IDs and revision pins so existing traces and experiment plans remain
  inspectable. Keep historical evidence self-contained, without requiring a
  mutable asset to reproduce its original input.
- Update browser, Tauri, and CLI loaders together. The CLI reads the asset graph
  and still never edits definitions as a side effect of a run.
- Update the definitions-only ignore preset to allow the approved shared asset
  files and their dependencies while continuing to exclude personal state,
  migration backups, and evidence by default.
- Updating the preset changes only new bundles. Level 1 never rewrites an
  existing `.gitignore`, so bundles created with the three-line definitions
  policy keep excluding every new asset file after migration. A teammate's
  clone would then lack assets the author sees locally, or appear complete only
  because ignored files exist in the author's checkout. Define how migration
  handles the existing policy: one option is to recognize the exact Level 1
  bytes and offer to replace them, while leaving customized rules untouched and
  reporting which new asset paths they would exclude.

### Acceptance criteria

- Independent edits to two assets change different files. Renaming an asset
  preserves references and does not create unrelated file changes.
- A fresh clone of a selected template and its dependency closure opens and runs;
  excluded conversations, drafts, fixtures, and evidence are absent.
- A missing required dependency produces an actionable error. Locally present
  ignored files cannot hide an incomplete selected share/export set.
- Concurrent edits to the same asset retain both sides' work for reconciliation.
  The application never guesses which revision should become current.
- Browser, native, and CLI read the same asset graph; interrupted multi-file saves
  and migrations are detectable and recoverable.

## External prompt sources

**Status:** Proposed October 30, 2026. No slice is approved.

Some teams keep n8n workflows in Git with each agent prompt extracted to its own
`.md` or `.txt` file. A sync step using the n8n API detects drift between those
files and the workflow JSON n8n stores and, when everything matches, rewrites
in either direction. The files contain n8n expressions in the form the n8n
editor shows them, without the leading `=` and without JSON escaping.

This section proposes how a project uses such files as prompt sources. It is
the separate design that Level 3 defers for live references into other
repositories, scoped to prompt text.

### User input (October 30, 2026)

- IL never writes to files outside the project bundle. Editing a template in
  IL changes the template only; the source file is unchanged.
- The browser, including the Docker deployment, is the priority host. Tauri
  follows.
- Source files may contain n8n expressions, as described above.
- The proposed order is file import with a recorded source, then linked files,
  then fitting both into Level 3. Other orders are open.

### Proposed principles

1. **Track, don't mirror.** A file is a source a template tracks, never the
   template itself. Template revisions stay immutable and pinned by uses,
   suites and traces. A changed file produces a new revision only when the user
   pulls it.
2. **Runs never read the file.** A tracked template carries the text it last
   pulled, so a clone without the source repository, the CLI and historical
   traces all work without it. The link drives drift detection and pulling
   only. For Level 3, the source file is therefore not part of an asset's
   dependency closure; a missing source means the template cannot be
   refreshed, not that it is incomplete.
3. **Provenance through existing receipts.** Each import or pull records an
   `ExternalImportReceipt` (`packages/core/src/project.ts`) with a new `file`
   adapter beside `n8n`: source identity, `sourceDigest`, authored text,
   expression bindings and the projection onto native variables.
4. **One expression projection.** File text is read as an n8n expression-mode
   field, as if it carried the leading `=`, through the projection the n8n
   importer already uses (`packages/core/src/external-prompt-project.ts`). So
   `{{ $json.chatInput }}` becomes a native variable with a recorded mapping
   rather than an invalid native token. Without an n8n execution there are no
   resolved values; bindings are `user-supplied`.
5. **Stable variables across pulls.** A pull reuses the previous receipt's
   expression-to-variable mapping, so suite input bindings and saved values
   that target those variables survive. Only new expressions allocate names.
6. **IL compares against the file only.** It reports "file changed since the
   last pull" and "template has revisions not pulled from the file"
   separately; both can hold at once. Drift between the files and n8n remains
   the sync step's job.

### Proposed sequence

| Slice | Deliverable | Depends on |
| --- | --- | --- |
| E1 | **Import from file.** Drop one or more files, or use a menu item, to create templates. The browser exposes a file's name but not its path, so the receipt records filename and digest. Each file becomes one message whose role is chosen in the import dialog. | Nothing in Levels 2–3 |
| E2 | **Update from file.** Drop or choose a file for an existing template. IL compares it with the template's receipts, shows the change in the existing revision diff, and on confirmation appends a revision with a new receipt. The user acts as the link, so no folder access is needed. | E1 |
| E3 | **Linked sources.** The project declares a portable source-root requirement (a name such as `n8n-workflows`); each tracked template records that name and a relative path. Each deployment maps the name to a real folder (an operator-mounted root first; see Decisions), the way connection requirements map to local profiles. The Prompts library shows drift, and Pull appends a revision. Needs a project format version, sequenced with the formats already queued. | E2; fields designed with Level 3's per-asset files in view |
| E4 | **CLI and CI.** The CLI takes a source root on the command line, reports drift, and can run a suite against the working-tree text as a run-only override, without writing definitions. CI in the workflow repository can then evaluate a pull request that edits a prompt file. | E3 |
| L3 | Links and receipts live in the prompt's asset file; source-root requirements become an asset kind like connection requirements. | E3 and Level 3 |

E1 and E2 deliver the sync loop by hand and need neither folder access nor a
format change if recommendation 1 below is approved. E3 does not need to wait for
Level 3, but Level 3's asset format must have room for what E3 adds.

A later possibility: an n8n execution import could be matched to a tracked
file by content (the node's authored text without its leading `=` equals the
file text), attaching real execution values to the tracked template.

### Decisions

Decided October 30, 2026:

- **One message per file.** Each file becomes exactly one template message,
  with its role chosen at import. No front matter or multi-message
  conventions.
- **Server-mounted source roots first.** The operator mounts read-only roots
  into the container and declares them; the API serves reads confined to
  those roots. This works in every browser and suits the CLI, following the
  operator-declared model of [command tools](COMMAND_TOOLS.md). A browser
  folder grant (File System Access API only, as folder projects already need)
  and Tauri's native file access are later additions, not part of E3.
- **Copy as n8n text.** Write-back stays ruled out. A template tracked from a
  file offers a read-only copy of its current text with each native variable
  turned back into the n8n expression its receipt mapped it from, for the user
  to apply to the file. A variable with no recorded expression has no n8n
  form: the copy names each such variable rather than passing it off as an
  n8n expression.

Recommended, awaiting approval:

1. **Reuse the current receipt; no format change for E1 and E2.** The
   receipt already separates the source (`source.resource`, for n8n the
   workflow) from the field within it that held the prompt (`invocation`, for
   n8n the node). A file has exactly one such field, so the fit is direct:

   | Receipt field | File import |
   | --- | --- |
   | `source.adapter` | `file` |
   | `source.resource` | `kind: "file"`; `id` and `name` are the filename (E1, E2) or the path relative to its source root (E3) |
   | `invocation` | the whole-file field: `type: "file"`, `id: "content"`, `name` the filename without its extension |
   | `authored` | one field, path `content`, with the chosen role and the file text |
   | `fidelity` | `authored-only` |

   The source-root link that E3 adds is current state, not a record of one
   import, so it belongs on the template rather than in the receipt. E3's
   format change then never touches existing receipts, and E1 and E2 ship on
   the current project format instead of joining the queued format versions.
2. **Read files as expression mode, with a plain-text override.** Expression
   mode is the right reading for any file whose `{{ }}` spans are n8n
   expressions. The import preview shows each span that becomes a variable,
   and a per-import "Treat as plain text" option covers a fixed-mode field
   that contains a literal `{{`. The receipt records which reading was used.
   Still worth checking: the rule the sync step uses to decide whether to
   restore the leading `=` when writing back to n8n. If it adds `=` whenever
   the text contains `{{`, the files are expression mode by construction and
   the override is only a safety valve.

## Implementation ownership and sequence

Before each behavior-changing slice, approve its material contracts from the
sections above. Planning recommendations are not authorization to select an
unresolved persistence, compatibility, or dependency policy during coding.

| Slice | Deliverable | Main owners and boundary |
| --- | --- | --- |
| 1 | Creation presets, exact ignore policy, documentation | Core bundle policy; creation dialog; browser/native creation adapters |
| 2a | Complete field inventory, approved ownership and migration examples | Core shared-definition and personal-state contracts |
| 2b, core foundation | Isolated v17/workbench v1 codecs and pure migration plan; app remains v15 (implemented October 26) | Core codecs; no workspace integration |
| 2b, recovery-store foundation | Protected storage for existing prompt-draft and selections records (implemented October 26); app remains v15 | Core typed store; opt-in browser/native workspace adapters |
| 2b, integration | Recovery store, migration, prompt/request drafts and scratch inputs, selections, explicit publication and launch defaults | Workspace adapters; personal-workbench, prompt, request, decision and execution-setting owners; compatible app/CLI loaders |
| 2c | Suite/tool/mock drafts and import staging; explicit saves | Evaluation, tool and import feature owners |
| 2d | Invalid or incomplete typed editor-buffer recovery | Editor owners and workbench codecs |
| 2e | Personal backup and restore preview | Core backup codec and workspace persistence |
| 3a | Approved asset format, references, dependency graph and sharing policy | Core asset model and validated graph loader |
| 3b | Cross-host file adapters, lossless migration and recoverable writes | Browser/native/Node storage owners |
| 3c | Selection preview/export, dependency explanations and conflict UX | Asset selection/export owner composed into the UI |

Design the whole level before splitting implementation into mergeable slices.
Use compatibility adapters or feature gating where needed so intermediate slices
do not create a half-migrated user experience or dual authoritative stores.

`app/page.tsx` remains a composition root. The personal-workbench owner owns
recovery lifecycle and local selections; feature owners own their drafts and
save workflows; workspace adapters own I/O. Core owns portable asset/reference
validation and codecs. Name the actual owner interfaces before expanding route
composition. Keep provider-specific serialization in the existing adapters.

## Verification and delivery evidence

Follow [AGENTS.md](../AGENTS.md), [the browser-suite mechanics](../tests/e2e/README.md),
and [the provider fixture guide](PROVIDER_FIXTURES.md).

- Write observable regression tests before each fix/behavior change and run them
  red for the actual incorrect value. For wholly new behavior, record which
  assertion demonstrates its absence; do not count a selector or fixture failure.
- Test Git policy using a disposable real repository, including existing tracked
  files and nested asset paths. Check exact stageable paths after creating
  representative evidence and recovery files.
- Cover core codecs, migration preservation, IDs/pins, dependency closure, and
  missing/cyclic/duplicate references with focused tests as applicable. Exercise
  write failures and recovery at the persistence boundary.
- Drive the committed Playwright suite through creation, clone/open, draft/edit,
  run, save revision, reload, and external-change scenarios. For workbench
  isolation, use distinct directory fixtures with the same project identity;
  inspect persisted shared bytes as well as rendered status and recovered values.
- Run an actual fixture-backed request with temporary values and model settings;
  assert the provider received them and shared definitions remained unchanged.
  Exercise both chat and decision ownership, evaluation execution, and trace-to-
  case promotion where the slice changes them.
- Exercise browser/native adapter behavior and the headless CLI. Playwright's
  browser directory fixture does not establish native filesystem or Git behavior;
  report that coverage separately and include native manual checks where needed.
- Iterate on affected specs, then run the full Playwright suite once before
  handing back each user-visible implementation change. Run the relevant core,
  build/type, CLI, and Rust checks for the code actually changed.

Record exact commands, affected specs, observed failures, unsupported migration
cases, and anything not exercised. Ask the user to inspect draft/save wording,
the migration preview, and selective-share dependency explanations as a complement
to executed checks.

This planning document itself changes no runtime behavior; it requires a document
and diff check, not a browser run.

## Remaining decisions for the design review

Level 1's presets and Level 2's choices recorded above are resolved. The next
review covers slice 2a; Level 3 decisions remain deferred.

1. Approve the field-by-field classification and migration examples for prompts,
   chat requests, decision requests, and evaluation suites, preserving legacy
   saved content while separating explicit drafts and personal selections.
2. Settle the Level 2 contracts in the slice 2a checklist above.
3. Choose Level 3 asset file granularity and discovery rules, reference/provenance closure,
   and how team sharing policy and personal asset exclusions interact.
4. Approve Level 3 format transitions and recovery for interrupted multi-file
   operations, plus old-reader/writer and export compatibility. Include how
   bundles created with the Level 1 definitions policy come to share new asset
   files.
5. Approve the two recommended [external prompt source](#external-prompt-sources)
   decisions before slice E1, and confirm that slice order.

The target is fewer incidental conflicts, explicit intentional contributions,
and selective sharing with understandable dependencies. Same-asset edits still
need reconciliation. Ignore rules still need correct Git usage. The application
should make those boundaries visible without requiring Git to understand or
merge personal workbench state.
