# Shared assets: migration journal and restart review

**Archive note (October 27, 2026):** Completed implementation or investigation
record. The dated decisions and verification below are historical; see the
[archive index](README.md) for scope, superseding contracts and follow-up work.

**Status:** Recommended staging slice approved and implemented October 26, 2026,
after the [protected recovery store](SHARED_ASSETS_RECOVERY_STORE_SLICE.md).
Approval covers opt-in journal preparation, staging on both hosts and read-only
restart classification, including the recommendations below. App and CLI remain
on v15; application migration and manifest replacement remain deferred.

The next [completion proposal](../SHARED_ASSETS_MIGRATION_COMPLETION_DESIGN.md)
defines opt-in manifest commit and active-candidate recovery for review. It is
not part of this approval or the implemented staging API.

This contract defines the implemented persistence slice. It does not approve
application migration, ordinary draft publication, request/scratch record arms,
or launch-default actions. Those remain separate integration decisions in the
[Level 2 design](../SHARED_ASSETS_LEVEL_TWO_DESIGN.md).

## Approved staging decisions

| Decision | Recommendation | Alternative and tradeoff |
| --- | --- | --- |
| Next implementation boundary | Add opt-in core migration preparation/journal codecs, protected staging on both hosts, and read-only restart classification. No manifest replacement or automatic application caller yet. | Build the complete app migration now: exposes recovery before request ownership, publication and compatibility contracts are settled. |
| Interrupted migration | Opening only inspects. Show a recovery preview; explicit Resume rechecks all inputs before continuing. | Automatically continue a verified journal: fewer clicks, but opening a folder can replace its shared manifest. |
| Migration draft identities | Preparation assigns bounded `draft_migrated-<64 lowercase hex>` IDs, derived from each template ID as specified below. Keep the existing workbench record-to-filename contract. | Hash every physical filename: retains planner IDs, but changes all store readers/writers and requires dual-layout support. Truncate IDs: loses identity and creates avoidable collisions. |
| Integrity comparisons | SHA-256 plus byte length over exact stored bytes; verify schemas, project identity and reconstructed outputs separately. Never sort authored JSON to compare it. | Hash parsed JSON: tolerates formatting differences, but risks conflating ordered decision/schema content and cannot verify untouched backups. |
| Existing personal state | Stage every migration candidate independently. Keep existing records and selections; defer collisions to explicit reconciliation. | Merge or replace during migration: less staging, but can overwrite personal edits or invent merge rules. |
| Retention and limits | Keep source, journal and candidate snapshots until an explicit future cleanup action. Add no new project-size rejection in this slice; report quota/path/I/O failures and stop staging. | Automatic expiry or a new hard size cap: bounds storage, but can remove the only preserved work or reject a previously supported project. |

The recommendation deliberately retains the existing best-effort detection
contract. Checks and read-back do not establish cross-host atomicity, exclusive
creation or power-loss durability.

## Ownership and API boundary

Core owns [migration-journal.ts](../../packages/core/src/migration-journal.ts). The existing
`planSharedProjectMigration(Uint8Array)` stays synchronous and unchanged; its
results remain logical candidates, not file-write instructions. The
`prepareSharedProjectMigration(sourceBytes)` async API invokes it, allocates
compact persistence IDs, serializes the shared candidate and workbench records,
and computes byte descriptors. Web Crypto supplies SHA-256, following core's
existing external-import hashing approach. Provider representations do not
change.

Preparation returns a frozen-by-copy intent and byte payloads. It performs no
filesystem access. A strict journal parser validates versions, safe path shapes,
unique candidate identities, project association and descriptors; it does not
interpret a parseable journal as permission to migrate.

`stageSharedProjectMigration` owns staging order and
`inspectSharedProjectMigration` provides read-only restart classification.
It accepts the prepared payloads and a separate migration storage capability.
It must not widen `WorkbenchStorage.mutate` into an arbitrary path writer or
pass journals to `parseWorkbenchRecord`. The existing store remains responsible
for active records only. No route component gains migration state or effects.

Browser/native adapters own byte reads, protected writes, safe enumeration and
same-host coordination. Use the existing per-project Web Lock/realm queue and
native workspace mutex, shared with ordinary workbench mutations. Acquire once
for a coordinated staging operation; do not nest a second acquisition of the
same lock. Recheck protection and foreign identity before each mutation.
Native migration staging is a dedicated command holding the mutex through
checks, writes and read-back. Core computes payloads; Rust does not independently
regenerate migration outputs.

The capability exposes only recognized migration paths. Binary IPC uses checked
byte arrays; browser writes use `Uint8Array` directly. Reading the manifest for
migration must preserve bytes before UTF-8 decoding. The current text-only
workspace open result is not a raw backup source.

## Identity, bytes and files

Implemented layout, relative to `.workbench/`:

```text
.gitignore                                  # exact "*\n" before personal writes
migrations/migration_<source-sha256>/
  source.project.json                       # untouched input bytes
  journal.json                              # immutable intent v1
  shared.project.json                       # exact proposed v16 serialization
  candidates/selections.json                # candidate only, never active state
  candidates/draft_migrated-<digest>.json     # one per extracted prompt draft
```

`source-sha256` is SHA-256 of the complete source bytes, including BOM and line
endings. The deterministic operation ID permits retrying the same source without
allocating duplicate directories. Different source formatting produces another
operation; no automatic deduplication or cleanup crosses operation directories.

The compact draft digest is SHA-256 over the ASCII domain prefix
`inference-lens:migrated-draft:v1` followed by a zero byte and the template ID's
UTF-16 code units encoded as unsigned 16-bit little-endian integers. This
preserves the distinction between unusual legacy IDs, including unpaired
surrogates, before hashing. Never pass the ID through lossy UTF-8 conversion.
The resulting `draftId` and filename are bounded, ASCII, and accepted by today's
v1 codec/store. The record still carries the original asset identity.

Compact IDs apply only to prepared migration records. Existing persisted IDs
are neither renamed nor discarded. The synchronous planner's hex IDs continue
to be valid logical output; they are not the persistence IDs returned by the new
preparation API. Tests and documentation must make this distinction explicit.
A same-ID/different-record collision stops the operation and preserves both the
attempted payload in memory and available disk content; a digest is never
permission to replace a destination.

The immutable `journal.json` v1 contains these fields:

| Field | Contract |
| --- | --- |
| `schemaVersion`, `kind` | `1`, `"shared-project-migration"`; independent of workbench record v1. |
| `operationId`, `projectId` | Deterministic directory identity and the validated source project identity. |
| `sourceVersion`, `targetVersion` | Source `10` through `15`; target exactly `16`. |
| `source` | Fixed path `source.project.json`, SHA-256 and nonnegative safe-integer byte length. |
| `shared` | Fixed path `shared.project.json`, SHA-256 and byte length. |
| `candidates` | Ordered descriptors for selections and each compact draft: fixed safe relative path, kind, draft/asset identity where applicable, SHA-256 and byte length. |

There is no arbitrary path, timestamp-based identity, credential, absolute path,
or mutable progress counter. Progress is derived from verified files. Candidate
count and identities must match a fresh preparation from preserved source;
structural parsing alone cannot establish that relationship. Source version and
project identity must also agree with that source. Unknown fields/versions or
unrecognized files inside an operation stop automatic resumption of that
operation and remain untouched.

Hash exact bytes, not parsed objects. To verify an operation, rerun preparation
from the preserved source and require exact prepared output equality with every
staged payload and journal descriptor. This preserves ordered decision subtrees,
tool schema ordering, sparse/empty values and the current serializer's field
order. A future serializer change that produces different bytes is an explicit
unsupported-plan outcome, never a silent journal rewrite.

No completion marker is needed in the staging foundation. A later manifest
commit coordinator can derive whether its exact candidate landed from the
manifest bytes. Terminal state metadata, if later needed, requires an explicit
contract rather than modifying this immutable intent in place.

## Protected staging sequence

1. Prepare and validate in memory. Read active workbench inventory and existing
   migration operations without creating anything. Preview the source version,
   draft count, shared-content boundary and any personal-state collisions.
2. On explicit staging intent, coordinate same-host writers. Recheck project
   association, inventory and exact `.workbench/.gitignore` protection using the
   recovery store's existing refusal semantics. Foreign identities in journals
   and candidate envelopes must participate in the whole-store write block;
   existing inventory scanning must be extended to recognized migration files.
3. Write source bytes only if absent, then read back and compare exact bytes.
   If already present, require exact equality; never repair or replace it.
4. Write the immutable journal only if absent, then verify exact read-back.
   Require exact equality for an existing journal. A failed or mismatched write
   stops this operation; it is not retried automatically.
5. Write and verify the shared snapshot, then selections and drafts in journal
   order. Existing equal bytes satisfy a step; existing different bytes are a
   conflict. No staged candidate is written into active `selections.json` or
   `drafts/` by this slice.
6. Reread and verify the complete staged operation against preserved source.
   Return `staged` only when every descriptor, schema and identity agrees.
   Otherwise return a conflict, blocked or uncertain-I/O result with the affected
   path. Keep all files. No failure rolls back by deleting recovery content.

An unreadable migration inventory blocks mutations because identity inspection
cannot be completed. Unreadable means a read failed or an entry is unexpected,
including a nested symlink; both hosts list it as an unavailable entry rather
than failing the whole inventory. Readable bytes that are not valid UTF-8 or
JSON, such as an interrupted write, carry no identifiable `projectId`: they do
not block mutations, and inspection reports the operation `needs-review`.
An unreadable/corrupt operation is retained for inspection;
read-only shared opening remains possible. A foreign `projectId` identifiable in
any recognized journal or candidate blocks all workbench mutations, as with
active records. Do not infer identity from a path or silently reassign it.

## Restart classifications and future manifest gate

Inspection is read-only and returns explicit states. It never adopts changed
bytes as a new expected value for a queued write.

| Observed boundary/state | Required outcome |
| --- | --- |
| No operation exists | `none`; preview can prepare a new operation. |
| Only protection/directory exists | `none`; no migration approved or completed. |
| Source exists without a verified journal | `incomplete-intent`; preserve it and require a fresh preview before staging further. |
| Verified source/journal; some expected outputs absent | `incomplete`; explicit Resume may create only absent outputs after all existing bytes verify. |
| All staged files verify; current manifest equals source bytes | `ready`; this foundation stops here. Later application migration needs its own commit approval and checks. |
| All staged files verify; current manifest equals exact shared snapshot | `shared-written`; do not append revisions or rewrite the manifest. Active recovery reconciliation may still be pending. |
| Current manifest differs from both snapshots, even if parsed content is equal | `manifest-diverged`; preserve everything and require a new preview/reconciliation. |
| Truncated/unknown journal, mismatched digest, unavailable file or unexpected entry | `needs-review`; preserve files and prohibit automatic repair/resume. |
| Recognized foreign project identity | `foreign-project`; block all workbench mutations, retain read-only inspection. |

Read-only inspection still reports both facts when an operation is damaged and
the manifest equals a known snapshot; manifest equality alone cannot make
unverified recovery ready. A partially written manifest is divergence, never an
invitation to overwrite it from a backup automatically.

The later commit coordinator must recheck the original manifest, protected
inventory, all staged files and personal-state disposition immediately before
replacement, use the existing expected-manifest contract, and read back the
candidate. It must not treat a returned `staged` object as durable proof after
yielding to other activity. Source and staged candidates stay retained even
after shared write confirmation.

Existing selections always win over a migration seed. Existing drafts are never
overwritten, even when they refer to the same asset. Staged candidates remain
available for explicit comparison; no merge, rebase or silent selection occurs.
The later application must expose unresolved candidates before claiming complete
recovery. Whether to activate absent records before or after shared replacement
belongs to that commit/reconciliation design, outside this staging slice.

## Implementation verification contract

Write tests before implementation. An initial scaffold may return an unstaged
outcome so the red assertion compares actual absent backup bytes or incorrect
restart state, rather than a missing import. Record actual failure values.

- Core: both prompt kinds, all legacy source versions, exact BOM/CRLF/Unicode
  bytes, compact IDs for long and unpaired-surrogate IDs, deterministic outputs,
  independent snapshots, unknown journals and ordered JSON. Verify the v15
  app/CLI APIs still retain drafts and reject v16.
- Storage: injected failure/interruption before and after every source, journal,
  shared-snapshot and candidate write/read-back; exact expected bytes; missing
  versus corrupt files; same-host interleaving; foreign identities including
  nested candidates; preservation of existing active records and selections.
- Restart: every row above, byte-identical retry without duplicates, source-only
  intent, changed serializer outputs, and manifest divergence with semantically
  equal but differently formatted content.
- Hosts: browser directory doubles plus lock assertions; native real temporary
  directories, symlink rejection at every new path level and native IPC byte
  round-trip. Test a real Git repository with no bundle ignore policy and stage
  actual adapter output; personal snapshots must remain excluded.
- Bounded paths: verify each generated component is below 255 bytes. Long
  checkout roots and host quotas can still fail and must be reported without
  modifying the manifest or deleting preserved outputs.

There is no new UI/provider behavior in this opt-in foundation, so no
Playwright journey is required for that boundary. Application integration must
later run the affected committed browser specs and full suite. Adapter doubles
and Rust filesystem tests do not establish browser-native race safety, native
picker behavior, Windows path support or power-loss durability.

## Delivery evidence

- Core provides `prepareSharedProjectMigration`, `parseMigrationJournal`,
  `serializeMigrationJournal`, `inspectSharedProjectMigration` and
  `stageSharedProjectMigration`. Preparation leaves the synchronous logical
  planner unchanged; stage captures caller-owned buffers before yielding and
  reconstructs every output from source before invoking a host. Inspection is
  read-only; only an explicit stage call can continue an incomplete operation.
- [Browser storage](../../app/workbench-directory.client.ts) exposes
  `browserMigrationStorage`; [native IPC](../../app/migration-native.client.ts)
  transfers checked byte arrays to dedicated
  [Rust commands](../../src-tauri/src/lib.rs). The workspace handle exposes
  `storage.migration` without opening it automatically. Rust uses exclusive
  creation for immutable staging files; a partial write remains for review.
  Shared manifests and active recovery records are never stage destinations.
- Active-store identity inspection includes nested migration files on both
  hosts. Journals/candidates are excluded from active typed-record loading.
  Foreign identity blocks ordinary recovery writes too; unreadable migration
  inventory prevents mutation. Existing active selections/drafts are preserved.
- Tests were written before each host implementation. Core first failed on
  actual backup bytes `null` and restart state `none` instead of `ready`.
  Browser first failed on absent backup bytes and an ordinary save returning
  `saved` instead of `blocked` with a foreign staged candidate. Rust first
  failed on backup `None` instead of exact BOM/CRLF bytes; its foreign-candidate
  test also failed before nested inventory support. Later cases were added
  during implementation; they are not separately claimed as red evidence.
  Review found an operation-directory replacement was incorrectly classified
  `none`; a new test demonstrated that value before the fix changed it to
  `needs-review`. Another assertion showed a staging attempt after a confirmed
  shared write returned `manifest-diverged`; it now reports `shared-written`
  without rewriting anything.
  A later review found the hosts disagreed on two inventory cases. Native
  blocked ordinary writes for a migration file with invalid UTF-8 (the browser
  decodes it and saves), and a nested symlink failed the entire native listing
  instead of becoming an unavailable entry. Both new Rust tests failed first on
  those actual values: `Err("Migration inventory is unavailable; workbench
  writes are blocked.")` instead of `Ok(Written)`, and a listing `Err` naming the
  symlink. A browser test pins the same partial-write rule; it passed without a
  change because the browser already behaved that way.
- `node --experimental-strip-types --test tests/migration-*.test.ts
  tests/shared-project-migration.test.ts tests/project-workspace.test.ts
  tests/workbench-store.test.ts`: 96 passing tests, including 34 new tests.
  Cases cover all supported legacy versions, both draft kinds and no drafts,
  compact UTF-16 identities, original BOM/CRLF bytes, strict journals, exact
  reconstruction, every staged write/read-back interruption boundary, stale
  outputs, retries, manifest divergence and foreign/corrupt records.
- The browser Git test writes the adapter's actual byte output into a disposable
  real repository without a bundle ignore policy. Only `project.json` stages.
  Directory I/O and Web Locks are doubles; concurrent stage/stage and
  stage/ordinary-save calls use the shared queue. This does not establish actual
  multi-tab or browser/native race behavior.
- `npm run test:rust`: 44 passing tests before the inventory parity fix, which
  adds two. Native tests use real temporary
  directories and reject symlinks at the workbench, migrations, operation,
  candidates and file boundaries. Deterministic callbacks inject interruptions
  and read-back interference at each native payload boundary. These are
  filesystem tests, not a Tauri UI launch or a multi-process mutex test.
- Full `npm run test:core`: 1,572 passing tests with loopback fixture access.
  `npm run build`, `npm run typecheck:core`, `npm run lint` and
  `npm run check:rust` passed. Build includes application type checking and has
  the existing large-chunk warning; lint has the same three pre-existing
  unused-variable warnings. `git diff --check`, new-file whitespace checks and
  all 42 relative link targets across the four shared-assets documents passed.
- No Playwright run: the application does not yet invoke this opt-in capability,
  and no rendered content or provider behavior changes. Windows path behavior,
  actual multi-tab/native races and power-loss durability were not verified.
  Review should focus on store outcomes, preserved candidates and API boundaries;
  there is no new UI to inspect. Publication, active-candidate reconciliation and
  the application manifest-commit workflow remain subsequent work.
