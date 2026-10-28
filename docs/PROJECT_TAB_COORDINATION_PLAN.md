# One editor per project across browser tabs

Status: decisions approved as recommended and implemented on October 28, 2026
(see [Implementation notes](#implementation-notes)). Originally inspected
`main` at `406cb03`, together with the shared-assets documents listed below. It is a prerequisite for the browser-first
[durable run links](RUN_DEEP_LINKS_PLAN.md) and should land separately, before
them. Reconcile with the [migration-completion proposal](SHARED_ASSETS_MIGRATION_COMPLETION_DESIGN.md)
if either is approved first; both change how browser manifest saves are
coordinated.

## Outcome

Several browser tabs can work on one project at once. For example, one tab
emulates a router that calls a tool while another runs the specialist prompt
whose output is pasted back into the router. Every tab composes, runs, inspects
and copies evidence. Exactly one tab per project autosaves `project.json`. The
others say plainly that their edits to the project are not being saved and
offer to make themselves the editor. Neither tab ever shows a misleading
"changed outside Inference Lens" error.

Desktop is out of scope: the Tauri app has a single window, and its process
mutex already serializes its saves.

## What exists today

| Existing boundary | Implication |
| --- | --- |
| [`browserStorage.save`](../app/project-workspace.client.ts) re-reads `project.json` and refuses to write when it differs from the tab's `lastContents`. The native `save_project` in [`lib.rs`](../src-tauri/src/lib.rs) does the same under a process mutex. | A second tab cannot silently overwrite the first except within a check-then-write window. Once one tab has saved, the other tab's every autosave fails. |
| That error says `project.json changed outside Inference Lens. Reopen the project before saving.` | In the multi-tab case the wording is wrong (the change came from Inference Lens), and the only recovery offered discards that tab's edits. |
| [`use-project-workspace.client.ts`](../app/use-project-workspace.client.ts) autosaves the whole manifest after an 800 ms debounce (5 s maximum wait) and retries failures with backoff. | Autosave is the integration point. A tab that may not write should not schedule writes and retries that are certain to fail. |
| `project.json` contains everything shared, including persisted compose drafts ([project format](PROJECT_FORMAT.md)). | Two tabs with different drafts cannot both persist them under v15. A lock does not change that, because the limit comes from how the file is organized. |
| Each run writes its own `traces/<runId>.json`, and traces carry self-contained template resolutions ([trace format](RUN_TRACE_FORMAT.md)). | Running in several tabs at once is already safe and needs no coordination. |
| [`workbench-directory.client.ts`](../app/workbench-directory.client.ts) serializes workbench writes per project with the Web Lock `inference-lens:workbench:<projectId>` plus an in-realm queue. Manifest saves do not take it. | A per-project same-host coordination scope already exists and should be reused rather than duplicated. |

## Relationship to the shared-assets plans

The [personal-workbench plan](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md) and its
[Level 2 design](SHARED_ASSETS_LEVEL_TWO_DESIGN.md) are the long-term answer to
the underlying problem. They move drafts, scratch requests and selections out of
`project.json` into per-record files under `.workbench/`, and they state that
"trial edits, scratch runs, and personal settings changes leave shared files
byte-identical." Once that ships, two tabs can each persist their own draft as a
separate record, protected by per-record Web Locks, expected-content checks and
read-back.

These documents shape this plan in four ways:

1. **No per-tab draft store here.** Building one would duplicate Level 2 and
   create a second migration source. Until Level 2 lands, a secondary tab's
   edits remain in memory only, and closing that tab is protected by the
   existing unload warning.
2. **Reuse the existing coordination scope.** Level 2 write safety coordinates
   workbench records through the native mutex and per-project Web Locks.
   The [migration-completion proposal](SHARED_ASSETS_MIGRATION_COMPLETION_DESIGN.md)
   notes that browser manifest saves do not take that lock, so another tab's
   v15 save could land between completion's check and its write. It proposes
   moving browser `save` onto the same per-project scope. This plan needs the
   same change, so it should be implemented once, in the shape that proposal
   describes: inside the workspace storage factory, beside `workbench` and
   `migration`, so a later completion capability can share the scope without
   reacquiring it through public workbench methods. Whichever change lands
   first owns it; the other reuses it.
3. **Gate only the manifest, not the tab.** Level 2 assumes one operator per
   checkout, not one session. The editor role therefore restricts ordinary
   writes to `project.json` and nothing else. Under Level 2, routine work
   stops writing the manifest, and shared writes become explicit
   publication with their own expected-content checks. The role can then
   shrink to coordinating publication, or disappear, without removing any
   tab-wide mode the UI depends on.
4. **Keep the approved write-safety limits.** Level 2 records that browsers
   offer no atomic compare-and-swap on folder files, so cross-host races
   (browser and desktop, or different origins) remain best-effort detection.
   It also leaves the `project.json` check "unchanged", meaning Level 2 itself
   does not strengthen it. This plan does strengthen it, but only for tabs of
   one origin. Its status wording must claim no more than that.

Migration completion also invalidates a workspace's save handle after an
attempted manifest write. Role transfer must not revive a handle that
completion invalidated: becoming editor always reopens through the project
owner, as described below.

## Decisions to review before implementation

| Decision | Options and tradeoff | Recommendation |
| --- | --- | --- |
| What a second tab may do | Read-only (simplest, breaks parallel-prompt workflows); full editing with conflict prompts on every save (noisy and lossy); full editing with manifest writes restricted to one editor tab. | Every tab fully usable; only the editor tab writes `project.json`. |
| Becoming editor | Carry the secondary tab's in-memory edits over the editor's saved changes; reload from disk; attempt a merge. | Reload from disk. The editor autosaves continuously, so a secondary tab's base is almost always stale, and carrying its edits forward would discard the editor's work. Merging per item is Level 2 territory. Offer it immediately when the secondary tab has no unsaved edits; otherwise confirm that its edits will be discarded, with Copy/Export available first. |
| Handing over | Web Locks `steal` alone; ask the editor to release first; ask, then steal on timeout. | Ask over `BroadcastChannel`. The editor flushes its pending autosave, releases its lock and becomes secondary. Steal only if no reply arrives within a short timeout, because a background tab can be frozen. |
| When the editor tab closes | Secondary tabs stay secondary until asked; the next one silently becomes editor and reloads; it becomes editor without reloading. | Web Locks grant a queued request when the holder closes or crashes. An unedited secondary tab reloads and becomes editor. An edited one shows "the editing tab closed" and the same reload/discard choice. Never adopt a stale in-memory manifest as the base for writing. |
| Lock key | Project ID; directory identity. | Project ID, like the existing workbench lock. Directory handles cannot become lock names. Two folder copies sharing an ID cannot both be edited on one origin at once; that over-blocks a rare case safely. |
| Unsupported Web Locks | Refuse to open; behave as today. | Behave as today. Every Chromium build with folder access also has Web Locks, so this is a defensive fallback. |

## Contracts and ownership

| Owner | Responsibility |
| --- | --- |
| New `app/project-tab-coordination.client.ts` | Browser host adapter around Web Locks and `BroadcastChannel`. Acquire, release and hand off the editor lock `inference-lens:project-editor:<projectId>`; report role changes; publish and receive validated messages. No React, no project document, no filesystem. |
| `project-workspace.client.ts` storage factory | Run every browser manifest `save` inside the per-project write scope shared with workbench writes (the scope the migration-completion proposal also needs). The expected-content check is unchanged. Distinguish a conflict caused by another tab of this app from any other external change in the error it reports. |
| `use-project-workspace.client.ts` | Remains the sole project-lifecycle owner. Expose a role (`editor`, `secondary` or `uncoordinated`); schedule autosave and retries only as `editor`; release the role on project replacement and close; implement becoming editor as a guarded reopen through the existing adoption path. |
| Project status UI | Show the secondary state and its one action. The route only composes this region; no lock or channel logic belongs in `page.tsx`. |

Channel messages are same-origin, but validate their shape anyway and ignore
anything unrecognized. The initial vocabulary is: an editor announcing it
saved, which lets secondary tabs show that they are behind; a request to
release; and an acknowledgement of release. Run links will add one more
message (see the [run-links plan](RUN_DEEP_LINKS_PLAN.md#browser-tabs-and-link-handoff)).
Messages carry project IDs and opaque tab tokens, never paths or contents.

A JSON-only imported project has no folder and does no folder saves, so it
takes no lock.

## Known limits

- Tabs on different origins (`localhost` and `127.0.0.1`, or another port), the
  desktop app beside a browser, and two machines on a synced folder do not
  coordinate. The existing expected-content check still detects their conflicts.
- A secondary tab's edits are not persisted until Level 2. Closing that tab
  triggers the existing unload warning.
- An editor frozen in the background can lose its lock to a steal before it
  flushes. Its unsaved edits remain in its memory, and it must report that they
  were not saved.

## Verification

Write the regression first and run it red: two pages in one Playwright browser
context on the stubbed project directory, both editing, with the second
autosave asserted to fail today with the "changed outside" message.

Then cover:

- Every tab composes and runs, and every tab's traces persist.
- Only the editor writes `project.json`, proven through the stub directory's
  write log.
- Takeover flushes the editor's pending change before reload.
- The steal fallback works when the editor does not reply.
- Closing the editor promotes an unedited secondary tab, and an edited one is asked first.
- Project replacement releases the role.
- Unit tests cover the coordinator's message validation and role transitions.

Run `project-replacement-guard.spec.ts`, `project-storage-clarity.spec.ts` and
the suite once before handoff. Stubs cannot prove real tab freezing or
cross-origin behavior; report those as unverified.

## Implementation notes

This change owns the shared write scope: `coordinateProjectWrites` in
[`workbench-directory.client.ts`](../app/workbench-directory.client.ts) keeps
the `inference-lens:workbench:<projectId>` lock name, and browser manifest saves
now run inside it. Migration completion should reuse it rather than add another.

Implementation added three things the plan did not spell out:

- **A write fence.** A tab thawed after its lock was stolen can run its pending
  autosave before it processes the steal. Every coordinated manifest write
  therefore asks the lock manager, inside the write scope, whether this tab
  still holds the editor lock (`navigator.locks.query` client IDs), and refuses
  the write if not.
- **A handover that always steals.** After the editor replies, the requester
  takes the lock with `steal` rather than waiting for a release, so a tab
  queued behind the editor cannot slip in between.
- **An adoption key.** Reloading the same project from disk did not remount the
  Prompts surface, whose key was the project ID, so a discarded draft stayed on
  screen. `projectAdoption` advances on every adoption, and the surface keys on
  it.

Wording: a secondary tab's status reads "Not saved — another tab is editing this
project", and its banner offers **Edit here**. With unsaved edits, Edit here
asks before discarding them and offers Export JSON copy first.

Verification: `tests/e2e/project-tab-coordination.spec.ts` (two- and three-tab
cases over `stubSharedProjectDirectory`) and
`tests/project-tab-coordination.test.ts` (message validation, role transitions,
steal and fence against a fake lock manager). Not verified: real background
freezing (Chromium declines a CDP freeze of a visible page, so the spec mutes
the editor's channel instead), cross-origin tabs, and the desktop app.
