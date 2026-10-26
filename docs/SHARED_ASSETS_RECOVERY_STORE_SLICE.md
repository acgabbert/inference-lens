# Shared assets: protected recovery-store foundation

Implemented following approval October 26, 2026 as the next bounded slice after PR #198. This is
part of 2b; it does not enable the v16 application or migrate any folders.

## Scope and ownership

- Core owns a typed store for the existing workbench v1 prompt-draft and
  selections records, validation, loaded expected contents and blocked records.
- Workspace adapters own enumeration and protected filesystem mutations.
  Browser work uses directory handles and Web Locks where available; native
  commands hold the existing process-wide workspace mutex through checks,
  mutation and read-back. Neither host claims cross-host atomicity.
- The workspace handle exposes the adapter, but opening/resuming a project
  does not read, create or recover personal content automatically. Callers must
  explicitly open the typed store with the loaded project's identity.
- App/CLI remain v15. Migration journals/backups, publication intent, scratch
  and request draft arms, feature hooks and UI integration are subsequent work.

## Files and write contract

Records live at `.workbench/selections.json` and
`.workbench/drafts/<draft-id>.json`. IDs retain the v1 codec's safe alphabet;
they are not arbitrary paths. A host filename limit is a reported I/O failure,
never truncation or silent remapping of a logical ID.

Reads never create anything. The store returns valid records independently of
corrupt/unknown/unreadable records and preserves their original files. A record
must agree with its filename and expected project identity. An identifiable
foreign project anywhere in the recognized record inventory blocks all store
writes, including deletes. It is never reassigned. Unknown/corrupt records
cannot be replaced or deleted through the typed store.

Before every content mutation, including deletion:

1. Coordinate same-host writers. Browser locks may conservatively serialize
   independent folders with the same project ID; a folder name is not identity.
2. Reinspect the inventory for foreign identities. An unreadable inventory
   prevents writing; an unreadable individual record remains unavailable.
3. Create `.workbench/` if needed. Create its `.gitignore` only when absent,
   using the core constant `*\n`; read it back and require exact equality.
   Preserve an existing different policy and refuse content writes. Do not
   rewrite the bundle-level policy. A refused or unwritable policy is a
   `blocked` outcome with reason `protection`, not an uncertain I/O failure:
   nothing personal was touched, so it neither stops the record nor the store,
   and saves resume once the policy is fixed. A foreign project is `blocked`
   with reason `foreign-project` and stops the store.
4. Compare the destination's bytes with the loaded expected value (`null`
   means absent). A mismatch returns a conflict without replacing the file.
5. Write/delete, then read back. Advance expected contents only on exact
   equality (absence after delete). Return a conflict on a mismatch.

Native adapters reject symlinks in recovery paths rather than following them
outside the checkout. These checks are not protection against an adversarial
process changing paths during I/O. The browser exposes only granted handles.

Conflicts stop further automatic mutations of that record for this store
instance; other records continue. Uncertain I/O failures also stop that record.
Results retain attempted content and available disk content for a future
comparison UI. Reopening a store is an explicit new read, not automatic conflict
adoption. The caller retains unsaved edits throughout; this layer never publishes
an asset or clears an editor.

Every mutation reinspects the whole inventory, reading each record, to find
foreign identities. That is acceptable for explicit saves; before feature owners
add autosave, decide whether to bound or cache the identity scan, since its cost
grows with total recovery size while the native workspace mutex is held.

Migrated draft IDs encode the template ID in hex, so a generated template ID
already yields a filename of about 200 characters, and longer imported IDs exceed
common 255-byte limits. The migration-journal slice must settle a shorter
filename mapping before migration writes these records; Windows browser paths
were not tested.

No global recovery-size policy or cleanup is introduced. Valid orphaned bases
remain valid recovery records; publication checks belong to the later workflow.

## Verification contract

Write assertions before implementation and demonstrate absent protection or
incorrect persisted bytes on the initial run. Cover both prompt kinds and
selections; read-only open; exact protection and failed protection writes;
unknown/corrupt/foreign records; safe paths; stale writes/deletes; mismatched
read-back; failure isolation; independent checkout stores; same-host concurrent
writers; and Git staging with no bundle-level ignore policy. Native tests must
exercise real temporary directories and symlink rejection. Test the TypeScript
native bridge separately from Rust filesystem helpers.

There is no user-visible or provider change, so this foundation needs no browser
journey. Report browser/native adapter tests separately from a native app launch.

## Delivery evidence

- Core's `openWorkbenchStore` captures expected contents, loads the existing
  record arms independently and exposes `save`/`delete` with explicit outcomes.
  Returned records are initial snapshots. Future feature owners keep current
  editor content and decide when to save; opening the store never publishes.
- `WorkspaceStorage.workbench` exposes the browser directory adapter and native
  IPC bridge. The native commands hold the existing workspace mutex through
  identity scanning and mutation. Rust uses temporary replacements; browser
  writes use the directory API. Neither strengthens shared-manifest saves.
- The first targeted run of
  `node --experimental-strip-types --test --test-name-pattern='writes verified self-ignore' tests/workbench-store.test.ts`
  failed against the initial no-write API scaffold on the intended assertion:
  actual ignore contents `null`, expected `"*\n"`. A preceding run failed on
  unsupported TypeScript parameter properties in the test helper; that setup
  failure is not the red evidence. Native tests were added with the Rust port;
  they were not separately shown red before its implementation.
- `node --experimental-strip-types --test tests/workbench-store.test.ts tests/project-workspace.test.ts tests/shared-project-migration.test.ts`:
  60 passing tests, including 20 new store/browser-adapter tests and two new
  workspace/IPC bridge tests. The Git fixture stages actual browser-adapter
  output in a temporary real repository with no bundle ignore policy.
- `npm run build`: passed, including full application type checking; existing
  large-chunk warning. `npm run typecheck:core`: passed. `npm run lint`: passed
  with the same three existing unused-variable warnings.
- `npm run test:rust`: 35 passing tests, including seven recovery filesystem
  tests. `npm run check:rust`: formatting and Clippy passed.
- `npm run test:core`: all 1,533 tests passed with loopback access. Its first
  sandboxed run had 52 failures because local fixtures could not bind loopback;
  that run is not a passing-suite claim.
- No Playwright run: the adapter is opt-in and this slice changes no rendered
  content, provider behavior or application recovery flow. Browser tests use
  directory-handle doubles and a Web Locks stub; they do not establish actual
  multi-tab/browser-native race behavior. Native tests use real temporary
  directories, including Unix symlinks, plus deterministic read-back
  interference; they do not launch the Tauri UI or establish Windows behavior.
- Review follow-up, October 26: two tests were written first and run red for the
  intended reasons: a customized ignore policy produced outcome `failed`
  (expected `blocked`), and `delete("../project.json")` threw synchronously
  instead of rejecting. After the fix, the three affected TypeScript files pass
  62 tests and `npm run typecheck:core` passes. The native protection test now
  asserts `Blocked { reason: "protection" }` and a resumed write once the policy
  is fixed, and the symlinked-`.gitignore` case asserts that refusal; these Rust
  changes were not shown red first (the old enum has no reason field).
  `npm run test:rust` passes 35 tests and `npm run check:rust` passes.
- Next review: migration journal/restart contracts, publication intent,
  request/scratch arms and execution provenance, followed by feature-owner
  integration and launch-default actions. Human review should focus on this
  store API and its conflict/failure outcomes; there is no changed UI to inspect.
