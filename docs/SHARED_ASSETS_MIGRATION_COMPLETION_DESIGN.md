# Shared assets: migration completion review

**Status:** Approved October 28, 2026 after review of the three open decisions:
the candidate-disposition table (exact bytes establish `present`; existing
selections win; nothing is merged or overwritten), pending drafts not blocking the
shared write, and ordinary-save-handle invalidation on any manifest-write attempt.
Revised October 27 (browser save coordination, completion capability ownership,
`stale-plan` result, corrupt selections). Implementation proceeds in the order
under "Required implementation evidence": core, browser adapter, then native. No
application caller is approved; App/CLI remain on v15.

**Approval condition.** Pending drafts may coexist with a v19 manifest only while
completion has no application caller. Add a test or guard asserting that no
app/CLI code path imports or calls the completion capability, and require
reconciliation to ship before the integration slice enables it.

**Renumbered 2026-10-30:** the staged shared format is now **v19**. Active
v16 went to [prompt environments](PROMPT_ENVIRONMENTS_PLAN.md) on October 29,
active v17 to [external prompt file imports](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md#external-prompt-sources)
and active v18 to [linked prompt sources](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md#e3-implementation-contracts-approved-october-30-2026); v19 carries all three.
Dated verification records and archived documents keep the number that was
current when they were written.

## Decision for review

Recommend a bounded, opt-in completion capability for an already staged
migration, with browser and native adapters. It completes the filesystem
foundation before feature owners enable v19. Application migration UI, ordinary
publication, request/scratch arms and execution provenance remain subsequent
work; enabling the capability from an opening/save path is outside this slice.

| Decision | Recommendation | Alternative and tradeoff |
| --- | --- | --- |
| Next boundary | Finish explicit manifest commit and candidate activation on both hosts, keeping app/CLI callers on v15. | Integrate the whole app now: delivers separation sooner, but also requires unresolved request, publication and execution contracts. |
| Write order | Verify all staged recovery, confirm the shared write, then activate absent personal records. | Activate first: legacy and migrated draft recovery can both appear active before the version fence lands. |
| Existing personal state | Preserve existing selections; never replace existing drafts. Leave competing candidates staged and report them individually. | Merge, overwrite or automatically pick a draft: fewer pending records, but introduces unapproved content/selection rules. |
| Restart | Read-only inspection; an explicit completion/resume call may continue only from exact source or exact staged shared bytes. | Automatically resume at open: convenient, but opening becomes authorization to replace shared definitions. |
| Durable progress | Keep the immutable journal unchanged; derive progress from the manifest and verified active records. | Add a completion journal/version: records user dispositions durably, but adds another file/state machine. Defer durable candidate dismissal to reconciliation UI design. |
| Uncertain shared write | Stop before activation, retain everything, and require inspection. Never roll back the manifest automatically. | Restore source automatically: can overwrite another writer and expose the project to legacy writers again. |

These choices retain the approved best-effort write detection. Neither host
provides a transaction across the shared file and personal records. The source
backup and staged candidates are recovery copies, not a guarantee against
power loss or writes by another process in a check/write window.

## Ownership and contracts

Core owns a new `migration-completion.ts` module alongside
[migration-journal.ts](../packages/core/src/migration-journal.ts). It reuses
strict preparation, exact-byte verification and the workbench v1 codecs. It
does not change v19, workbench v1 or migration-journal v1 serialization.
Provider representations and historical evidence formats stay outside this API.

Proposed public operations:

- `inspectSharedProjectMigrationCompletion(snapshot, projectId, operationId)`
  returns a read-only manifest classification plus per-candidate dispositions.
  It reconstructs expected outputs from preserved source, rather than trusting
  journal hashes or a previous `staged` result.
- `completeSharedProjectMigration(storage, projectId, operationId)` is an
  explicit mutation. It creates no staging operation, does not repair an
  incomplete one, and accepts no arbitrary replacement manifest or caller-built
  file list. It returns separate shared-write and personal-recovery outcomes.

A distinct `MigrationCompletionStorage` capability extends the available
snapshot reads with a coordinated completion operation. Do not add a manifest
writer to `WorkbenchStorage`, or change the meaning of `MigrationStorage.stage`.
Core prepares a checked immutable write plan from a fresh snapshot. The host
operation rechecks the full expected inventory, protection and exact manifest
bytes under one same-host coordination scope before using that plan. Plan
validation binds every source/destination to the operation and candidate identity;
it never becomes an arbitrary path writer. IPC uses checked byte arrays.

For the browser, core verification can run inside the existing Web Lock/realm
queue through a host-supplied scoped capability. Do not reacquire that lock
through public workbench mutation methods. Ordinary browser manifest saves do
not take that lock today, so a v15 save from another tab or handle could land
between completion's source check and its write. This slice moves the browser
workspace `save` onto the same per-project coordination scope, so completion
excludes same-origin saves as native completion excludes native saves.
Cross-host and unsupported-browser races remain best-effort detection only. For native completion, core prepares
the checked plan before IPC; the dedicated Rust command holds the workspace
mutex through snapshot comparison, writes and read-back. Rust checks safe paths,
payload bindings and exact expected inventory; it does not regenerate core
migration outputs. A changed snapshot returns stale-plan without any content
mutation, allowing a new explicit preview.

No route gains state, effects or serialization. A later application integration
belongs to `usePersonalWorkbench` and `useProjectWorkspace`; this foundation
only exposes the opt-in workspace capability.

## Candidate dispositions

Inspect valid active records independently, using the current strict parser,
filename identity and project association checks. Preserve unavailable records.
Selections never inherit a draft's conflict policy.

| Candidate observation | Disposition and permitted action |
| --- | --- |
| Active destination contains exact candidate bytes | `present`; no write. |
| Selections destination exists with different valid selections | `existing-selections`; preserve it, never seed over it. This seed needs no further activation. |
| Selections destination exists but is corrupt, unknown or unreadable | `unavailable` (row below); never treated as `existing-selections` or overwritten. |
| Selections destination is absent | `activate`; create from verified candidate after shared confirmation. |
| Draft destination is absent and no active draft names that asset | `activate`; create at the existing compact draft path after shared confirmation. |
| Draft destination differs, or another draft names the same asset | `pending-draft`; preserve both active and staged work. Never allocate a duplicate ID, merge or replace. |
| Destination is corrupt, unknown or unreadable | `unavailable`; preserve it and candidate; require review. |
| Any unavailable active draft prevents ruling out a same-asset draft | Other absent draft candidates are `unavailable`; do not guess ownership from filenames. Independent selections can still be assessed. |

Exact bytes, rather than parsed equivalence, establish `present`. Differently
formatted valid drafts therefore remain pending for review. A foreign identity
blocks the whole operation, as in the approved store. Unavailable migration
inventory also blocks the operation. Unknown/corrupt active records without an
identifiable foreign project remain isolated unavailable records; they do not
by themselves prohibit a shared commit whose staged recovery is fully verified.

Pending/unavailable candidates do not prevent shared replacement: every extracted
draft is already preserved in the verified staging operation. Inspection must
expose their identities, reasons and paths before a future UI offers completion.
Return `recovery-pending`, never a claim that all drafts were restored. Existing
selections win, including on restart; the seed remains staged for inspection.

No persistent dismissal or cleanup is added. A competing candidate continues to
appear pending until a later explicit reconciliation action settles it. Opening
alone never activates it, even if its active competitor was subsequently removed.

## Coordinated completion sequence

1. Read without writing. Validate project identity, exact source/journal/output
   reconstruction and every staged file. Require inspection `ready` or
   `shared-written`. Incomplete staging must use the existing explicit stage
   operation first; divergence, unknown entries and damaged outputs stop here.
2. Capture an independent expected inventory and candidate dispositions. Under
   same-host coordination recheck that snapshot, the exact `*\n` protection,
   foreign identities and manifest. Never create or repair protection during
   completion; successful staging has already established it. A changed snapshot
   ends this attempt before content writes.
3. If the manifest still equals source bytes, write only the verified shared
   snapshot to `project.json`, using the expected-source check immediately before
   replacement. Read back raw bytes and require exact shared-snapshot equality.
   If already equal to that snapshot, record shared confirmation without writing.
4. Only after shared confirmation, process candidates in journal order. Before
   each activation recheck protection, foreign identities, staged integrity,
   exact shared manifest and relevant active inventory. Create only a destination
   still absent and eligible. Read it back and compare exact bytes. No activation
   edits selections or drafts already on disk.
5. Stop on a changed precondition, read-back mismatch or uncertain I/O. Keep all
   files and report the affected path and last confirmed progress. Independent
   pending candidates are reported rather than overwritten; they are not I/O
   failures. Reinspect after the batch before claiming recovery is complete.

Native paths reject symlinks at every traversed boundary, including the manifest
itself. Browser writes use granted directory handles. Reuse native temporary-file
replacement and browser writable handles, with read-back; neither implies an
atomic multi-file commit. No step deletes source, journal, shared snapshot,
candidates or existing active records. Missing current manifest is divergence,
not permission to recreate it.

## Outcomes, restart and workspace expectations

A changed snapshot detected before any content write returns a top-level
`stale-plan` result, not a shared or personal outcome: nothing was attempted,
no handle is invalidated, and the caller must request a new explicit preview.
Otherwise the result has two independent dimensions:

- Shared: `unchanged-source`, `confirmed-shared`, `diverged`, or `uncertain`.
  A write error stays `uncertain` even if a later inspection can establish exact
  bytes. Only a new explicit attempt may continue after that inspection.
- Personal: candidate dispositions plus confirmed activations, pending records,
  and an optional stopped path/reason. `complete` requires confirmed shared
  bytes, every eligible activation verified and no unresolved draft candidate.
  Existing valid selections count as satisfied without overwriting them.
  Dispositions come from reinspecting persisted bytes after execution. If that
  reinspection is itself blocked, every candidate is reported `unavailable` with
  the blocking reason, never the pre-write disposition. A host that reports
  activations after a failed shared write has broken the write order; core
  reports the batch as `stopped` at the first such path.

| Restart observation | Next explicit completion call |
| --- | --- |
| Source still present, staging fully verifies | Recheck preview/snapshot, commit once, then activate eligible records. |
| Exact shared snapshot present, no active candidates yet | Do not rewrite manifest; activate only eligible absent records. |
| Exact shared snapshot and some exact active candidates | Treat those as present; continue eligible absent candidates without duplicates. |
| Exact shared snapshot but active drafts differ or compete | Preserve them; report recovery pending. |
| Source/shared manifest with damaged staging or foreign identity | Block completion, even if active records look complete. |
| Manifest differs from both snapshots, including a later valid v19 edit | Diverged; no automatic commit or activation. Retain candidates for later explicit reconciliation. |
| Manifest missing, partial or unreadable | Diverged or unavailable; no automatic source restoration. |

Inspection reports manifest equality separately from recovery integrity. Equal
manifest bytes cannot turn damaged staging into successful recovery.

Completion invalidates the originating workspace's ordinary shared-save handle
as soon as a manifest write is attempted, or when existing shared output is
recognized. Browser saves reject through a shared handle validity flag; native
saves reject through workspace registration state. The browser flag shares the
`save` closure, so the browser completion capability is constructed inside the
workspace storage factory alongside `workbench` and `migration`, not as a
standalone factory over the directory handle. They must not adopt v19 into
the old handle's `lastContents`/`last_contents` expectation. This prevents a
stale v15 caller from saving through the handle after an uncertain attempt that
left source bytes unchanged. Evidence reads/writes remain independent. A future
v19 application owner explicitly reopens/adopts a validated v19 session; this
slice adds no such caller. Other stale handles still fail their expected-manifest
check when shared bytes changed. Cross-host races retain the approved limits.

Invalidation after an `uncertain` attempt that left source bytes unchanged is
deliberate: the v15 session cannot save until the project is reopened. That is
the safer choice and has no user impact while no caller exists, but it is a UX
constraint the later application owner must design for.

Likewise, pending or unavailable candidates not blocking the shared write means
a project can reach v19 with drafts reported as pending and no reconciliation
UI. That is acceptable only while this capability stays opt-in with no caller;
application integration must provide reconciliation before enabling completion.

## Required implementation evidence

Write tests first and run an actual incorrect outcome red before implementing
the coordinator. A no-write scaffold can establish actual unchanged v15 bytes
where exact v19 bytes are expected; a missing import is not red evidence.

- Core: both prompt kinds, no drafts, all legacy source versions, ordered JSON,
  sparse/empty values, independent plan snapshots, every disposition above,
  malformed/foreign inventory, stale plans and mutated caller buffers.
- Browser adapter: interruptions/errors before and after manifest write/read-back
  and each candidate activation/read-back; exact source/shared/active bytes;
  no rollback, no overwrite, lock scope and interleaving with ordinary workbench
  mutations and ordinary manifest saves from another handle (now coordinated).
- Native: the same write boundaries in real temporary directories, byte IPC
  round-trip, safe destination bindings and symlink refusal at every path level.
  Test shared-save handle invalidation on confirmed and uncertain attempts.
- Restart: every row above, repeated explicit completion without duplicates,
  preservation of existing selections/competing drafts and staged backups,
  manifest formatting-only divergence and later valid shared edits.
- Real Git repository without bundle ignore rules: stage actual adapter output;
  only the intended shared manifest change is tracked, never recovery content.
- Compatibility: app/CLI paths still use v15, reject v19 and never call completion
  automatically. A native/browser capability test is not application migration.

Run affected unit/adapter tests, core/app type checks, lint and Rust tests/checks.
There is no changed UI/provider behavior in this opt-in foundation, so it needs
no Playwright journey. Application integration later requires affected committed
browser specs and the full suite under [AGENTS.md](../AGENTS.md).

## Implementation progress

**Core (implemented).** [`migration-completion.ts`](../packages/core/src/migration-completion.ts)
provides inspection, the checked plan and the completion coordinator;
[`migration-completion.test.ts`](../tests/migration-completion.test.ts) covers the
disposition table (including filename-identity checks shared with the workbench
store), restart rows, stale plans, manifest and activation failures, blocked
reinspection, host write-order violations, plan independence from storage
buffers, and the approval-condition guard that no app/CLI path references the
capability. Core tests, typecheck and lint pass. Not yet covered at this layer:
completion of a draft-free source and of the other legacy source versions.
Preparation of those inputs is covered by `shared-project-migration.test.ts`
(legacy versions, no drafts) and draft-free staging by `migration-journal.test.ts`.

**Browser adapter (implemented October 30).** `browserMigrationCompletionStorage`
([workbench-directory.client.ts](../app/workbench-directory.client.ts)) is
constructed only inside the browser workspace storage factory, as
`WorkspaceStorage.migrationCompletion`. Workspace `save` already ran in the
per-project scope (`coordinateProjectWrites`, from tab coordination); it now
also rejects with `ProjectHandleInvalidatedError` once completion attempts the
manifest write or recognizes the shared snapshot already present. The handle
never adopts v19. These details were settled during implementation:

- The host refuses a plan that is not bound to the staged operation before
  queuing: another project, a source or shared snapshot other than the staged
  one, a candidate outside `candidates/`, a destination other than the
  candidate's own, bytes other than the staged candidate, or a destination
  that is not absent. It throws, so core reports `blocked`.
- Inventory checks compare the whole snapshot by path, before the first write
  and before each activation (expected snapshot, shared manifest and earlier
  activations), so staged integrity, foreign identities, competitors and later
  edits all stop the batch at `before-write`. Protection is read, never
  created. A manifest that changes between the snapshot and its replacement
  returns `stale-plan`.
- A failed browser activation write can leave an empty file at the
  destination, because `getFileHandle({ create: true })` creates it first.
  Reinspection reports it `unavailable`; its staged candidate is preserved.
- The native handle's `migrationCompletion.execute` throws until the native
  command lands.
- Core fix: a store that cannot be read after the host executed now yields
  `uncertain` with every candidate `unavailable`, rather than `blocked`,
  which hid that the manifest may have been written.
- Review fix: migration snapshots read active records as raw bytes, preserving
  BOMs and invalid UTF-8 for exact comparisons and strict validation. Ordinary
  workbench reads retain their text contract. Regression tests cover a
  BOM-prefixed draft remaining pending and invalid UTF-8 selections remaining
  unavailable; both failed on the incorrect dispositions before the fix.
- The approval-condition guard now allows the two host adapter files to import
  the module's types. It still rejects any call to completion or inspection
  and any read of `migrationCompletion` outside its declaration and
  construction.

[`migration-completion-directory.test.ts`](../tests/migration-completion-directory.test.ts)
covers exact bytes and write order, repeats, preserved selections and competing
drafts, handle invalidation on confirmed, uncertain and already-shared attempts
(not on `stale-plan`), protection, every manifest and activation write,
read-back and read failure, rechecks between activations, plan binding, one
Web Lock shared with recovery writes and another handle's saves, and a real Git
repository staging only `project.json`.

**Native command (implemented October 30).** `complete_workbench_migration`
([lib.rs](../src-tauri/src/lib.rs), host in
[workbench/completion.rs](../src-tauri/src/workbench/completion.rs)) holds the
process-wide workspace mutex through validation, snapshot comparison, writes
and read-back, so no native save, recovery write or staging from any handle can
interleave. `nativeMigrationCompletionStorage`
([migration-native.client.ts](../app/migration-native.client.ts)) is bound to
the opened project's ID and converts the plan to byte arrays before the first
await. These details were settled during implementation:

- Plan binding mirrors the browser host and is checked before any read. The
  operation must name a valid migration path. Paths are validated without
  touching the filesystem, so a traversal or foreign candidate is refused with
  nothing created.
- The manifest is replaced through the existing temporary-file replacement
  (`write_project_file`, now taking bytes). Candidates are created with
  exclusive creation (`create_new`), so an activation can never replace a file
  that appeared after the recheck. A failed write can leave a partial file,
  which is reported and never removed.
- A linked or unreadable `.workbench/.gitignore` is a `protection` refusal, as
  in native recovery writes. Links at `project.json`, `.workbench` and
  `.workbench/drafts` fail the snapshot read; a link at a destination is an
  unavailable entry that fails the recheck. Each is refused whether it is
  present before the call or appears between activations.
- Registration state gains `shared_save_invalidated`. Native `save` refuses
  with the same text as `ProjectHandleInvalidatedError`, and the TypeScript
  handle maps it to that class. Evidence and recovery commands stay registered.
- Review fix carried to native: migration snapshots now read active records as
  raw bytes, as the browser host does. `list` keeps its text contract.

[`completion.rs`](../src-tauri/src/workbench/completion.rs) tests cover exact
write order and bytes, repeats and restart after a shared write, stale plans
(including a manifest change just before replacement), protection without
repair, foreign identity, every manifest and activation boundary (before
write, write, read-back), plan binding refusals, symlinks at every level, JSON
IPC byte round-trip, and a real Git repository tracking only `project.json`.
`lib.rs` tests cover invalidation on confirmed, uncertain and already-shared
attempts and none on stale, invalid or protection-refused plans. The native
fixture uses synthetic bytes staged by the native staging command; the host
compares bytes and project identity only, so real v19 content is covered by the
core and browser tests rather than here.

**Remaining.** No application caller is approved. Enabling completion needs the
reconciliation UI and a v19 application owner, per the approval condition.
