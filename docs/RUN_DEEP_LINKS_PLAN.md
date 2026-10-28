# Durable links to saved runs

Status: browser implementation; contracts approved October 28, 2026. Originally inspected
`main` at `406cb03` on October 27, 2026. Revised October 28, 2026: the browser
ships first, and the [one-editor-per-project tab coordination](PROJECT_TAB_COORDINATION_PLAN.md)
lands separately beforehand. Both decisions came from the user in review; the
remaining proposed defaults were accepted by the user on October 28, 2026.
Integration uses the current project-replacement and pending-branch owners.
Future shared-assets Level 2 changes should preserve these adapter boundaries.

## Outcome and recommended scope

A person copies a link beside a saved run, puts it in their notes, and later
clicks it to inspect that same trace in Inference Lens. The correct project need
not already be open. If the app cannot find or access it, the link remains
pending while the person locates the folder; they do not need to search for the
run again.

Ship the browser first, because that is where the app is used today. Browser
links open the current deployment and resolve the reference there. A later
desktop adapter can launch the installed app without depending on a local web
server's port. Everything except host ingress and registry storage is shared,
so the desktop slice adds an adapter rather than a second implementation (see
[deferred desktop work](#deferred-desktop-work)).

Browser links require folder access, which only Chromium-based browsers
(Chrome, Edge) provide. In Firefox and Safari a link explains that opening it
needs Chrome or Edge; it does not offer a JSON import, which cannot resolve a
run.

The first complete release covers saved chat and decision runs, including an
individual saved run produced by an evaluation or repeated experiment. It opens
read-only evidence in Runs, with diagnostics available, without running a
provider request or adopting the trace into Compose. A link identifies local
evidence; it does not upload that evidence, grant access to it, or guarantee
that another device has it.

Excluded initially: public trace hosting, account sync, automatic filesystem
search, links to live/paused runs or loose trace exports, whole-experiment or
comparison links, and anchors into a particular turn/exchange. Those can extend
the contract later without changing the meaning of a v1 run reference.

## Pre-implementation boundaries

| Existing boundary | Implication |
| --- | --- |
| [`project.ts`](../packages/core/src/project.ts) persists `projectId`; [`run-kernel/types.ts`](../packages/core/src/run-kernel/types.ts) defines `ProjectId` and `RunId`. | Use durable identities, not project names, row numbers, model IDs, or dates. |
| [`run-trace.ts`](../packages/core/src/run-trace.ts) validates both trace kinds through `parseSavedRunTraceJson` and writes `traces/<runId>.json`. | No new trace format is needed. Retain existing compatibility and validation. |
| [`run-history.ts`](../packages/core/src/run-history.ts) permits renamed trace files and duplicate run IDs in the listing. | A canonical filename is a fast path, not a complete lookup policy. |
| [`project-workspace.client.ts`](../app/project-workspace.client.ts) exposes opaque workspace handles; `displayPath` is presentation only. | Links must not turn display paths into filesystem authority. |
| [`workspace-handle-store.client.ts`](../app/workspace-handle-store.client.ts) stores one browser `last-project` record; it has no `projectId`. | Reopening an arbitrary linked project needs a new local registry or a folder picker. |
| [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) registers native workspace IDs in a process-local map. Browser restoration explicitly skips Tauri. | Native workspace IDs cannot be saved in links; desktop needs persistent local discovery. |
| [`use-project-workspace.client.ts`](../app/use-project-workspace.client.ts) owns startup restore, autosave, and Save/Discard/Cancel replacement. | Link resolution must join this lifecycle, including invalid drafts, rather than bypass it. |
| [`use-runs-navigation.client.ts`](../app/run/use-runs-navigation.client.ts) owns saved chat inspection separately from execution. [`page.tsx`](../app/page.tsx) currently opens saved decision traces in Compose. | Generalize saved inspection to `SavedRunTrace`; do not reuse the decision adoption path, which can stop active work. |
| [`tauri.conf.json`](../src-tauri/tauri.conf.json) and [`Cargo.toml`](../src-tauri/Cargo.toml) have no deep-link integration; bundle targets are `app` and `dmg`. | External desktop entry needs explicit native work and packaged macOS verification; deferred. |
| [`project-workspace.client.ts`](../app/project-workspace.client.ts) gates folder access on `showDirectoryPicker`. | Browser links resolve only in Chromium-based browsers. |
| Clicking a link from notes opens a new browser tab. When this plan was written, projects had no cross-tab coordination and a second tab's autosaves failed the manifest's expected-content check. | Depends on the [tab coordination plan](PROJECT_TAB_COORDINATION_PLAN.md), now implemented: one editor tab per project, every other tab secondary. |
| The [shared-assets Level 2 design](SHARED_ASSETS_LEVEL_TWO_DESIGN.md) moves drafts and selections out of `project.json` into `.workbench/`; app and CLI remain on v15. | Links must not depend on manifest drafts or revisions; see [below](#relationship-to-the-shared-assets-plans). |

See also the current [project format](PROJECT_FORMAT.md),
[trace format](RUN_TRACE_FORMAT.md), and [architecture](ARCHITECTURE.md).

## Approved decisions

| Decision | Options and tradeoff | Recommendation |
| --- | --- | --- |
| External entry | HTTP links depend on a reachable app origin; a custom scheme needs an installed application; a hosted redirect adds infrastructure and privacy considerations. | **Decided October 28: browser first.** HTTP fragment links now. A desktop `inference-lens://` scheme comes later; confirm it before publishing it. No hosted redirect. |
| Browser support | Support folder-less browsers through import, or require folder access. | **Decided:** require Chrome or Edge and say so in the link dialog. |
| Link opened while another tab owns the project | Open independently, refuse, or hand off to the owning tab. | Hand off to the editor tab when one answers; otherwise inspect in the new tab as a secondary tab. See [browser tabs](#browser-tabs-and-link-handoff). |
| Link spelling across hosts | Each host accepts only its own outer URL, or accepts either one's payload. | Separate the inner payload from the outer URL so links copied from the browser remain usable when desktop arrives. |
| Project discovery | Put an absolute path in the link (simple but exposes local structure and breaks on moves), always ask for a folder (smallest change), or remember project locations locally (more lifecycle work). | IDs in the link plus a local registry and Locate folder fallback. |
| Inspection destination | Reuse Compose adoption (less UI work, but replaces session state), add a separate viewer, or extend the existing Runs inspector. | Extend Runs to inspect both trace kinds; preserve Compose and live execution. |
| Switching projects | Automatically replace any project, always ask, or switch only when safe. | Auto-open a unique accessible match when no work is at risk; use existing unsaved-work protection, and defer while active/paused execution or a pending branch blocks replacement. |
| Copies with the same project ID | Choose the newest path, assign new IDs to every clone, or ask which local copy to use. | Keep portable IDs unchanged; use the current matching workspace, otherwise ask when multiple registered copies match. |
| Link eligibility | Allow session links that may break on restart, automatically save when copying, or require durable evidence. | Enable Copy link only for a verified trace in a project folder; saving remains explicit. |
| Run-file duplicates | Trust directory order, require content hashes in every URL, or use canonical-name precedence and surface ambiguous renamed copies. | Prefer a valid canonical file; otherwise require one matching file. No new content-addressed identity in v1. |

The user approved the proposed defaults on October 28, 2026, including the browser URL, local registry, replacement protection, tab handoff and read-only decision inspector. These are the browser implementation contracts.

## Reference and URL contract

Core value, owned by `packages/core/src/run-reference.ts`:

```ts
interface RunReferenceV1 {
  version: 1;
  projectId: ProjectId;
  runId: RunId;
}
```

Public spellings (IDs below are illustrative):

```text
inference-lens://run/v1?project=project_example&run=run_example
http://localhost:3000/#/run/v1?project=project_example&run=run_example
```

The browser formatter uses the current application's root URL, retaining its
supported deployment base path; `localhost:3000` is not hardcoded. The fragment
keeps the run reference out of the HTTP request and avoids adding a server
route/static-host rewrite. It still appears in notes, browser history, and the
page's JavaScript. The desktop formatter never copies a Tauri webview origin.

The core module owns the reference validator, versioned payload codec, and
parse results (`valid`, `invalid`, `unsupported-version`). The payload is the
part shared by both spellings, `run/v1?project=…&run=…`. Core parses it
independently of any outer URL. Host adapters own outer URL validation and
formatting: exact native scheme/authority/path, or HTTP(S) app location and
the recognized fragment. Each host should also accept the other host's
spelling through an explicit "Open link…" paste action. That keeps links saved
in notes during the browser-only period usable once desktop exists, and vice
versa. The OS will not route an HTTP link to the desktop app, so this is the
cross-host path. No provider fields belong in
this contract. Trace kind comes from validated evidence, not from the link.

Use `URL`/`URLSearchParams` for construction and one decoding pass. Reject
missing or duplicate required parameters, malformed encoding, unsupported
versions, unexpected v1 parameters, and native credentials/ports/fragments.
Validate project IDs against the existing project-ID semantics without
narrowing them to UUIDs; validate run IDs with the existing safe-filename rule.
Add a documented input-length bound, with fixtures proving supported existing
IDs round-trip. Neither an ID nor a query parameter is accepted as a path,
command, provider endpoint, or filename override.

Keep the v1 decoder when future link versions arrive. This is a separate
version boundary from project v15 and trace v8: no manifest/trace schema bump,
new provenance field, or rewriting old evidence is required. Project-folder
identity plus parsed run identity establishes the reference; do not require a
new `projectId` field inside old traces.

A copied project retaining its `projectId` is another local location for the
same logical project. A deliberately new project with a new ID does not inherit
old links. This is a logical reference, not a cryptographic guarantee against
someone replacing evidence on disk with another valid trace using the same ID.

## Local discovery and persistence

Introduce a host-local `ProjectLocationRegistry` indexed by project ID, allowing
multiple locations per ID. The shared metadata contains a version, opaque
location ID, project ID, display name, and last successful access time. Browser
records additionally own directory handles in IndexedDB; native records own
canonical paths in an app-data file controlled by Rust. Neither location type
belongs in `project.json`, trace JSON, URLs, or shared project assets.

Required operations: list candidates for a project, inspect a candidate,
remember an accepted workspace, and forget a location without deleting files.
Native reopen accepts an opaque registry location ID, resolves its path inside
Rust, and returns a new process-local workspace capability. It does not accept
an arbitrary path supplied by the link. Deduplicate the same directory using
host-appropriate directory identity; different clones remain separate entries.

Persist only after successfully parsing a selected manifest, verifying its ID,
and accepting the workspace. Candidate inspection must not adopt a project,
change last-project state, or write files. In particular, the current browser
picker remembers a folder before returning it: split selection/inspection from
remembering so an incorrect Locate folder choice has no such side effect.

Migration is local and additive. Keep the legacy `last-project` record readable
and separate from the new registry. Once its handle is accessible and its
manifest parsed, register its project ID; never infer it from a name or invent
one. Do not request permissions in an IndexedDB upgrade transaction. Preserve
ordinary no-link startup behavior. Failed/blocked registry writes leave the
current workspace usable and make future resolution fall back to Locate
folder. Native writes should be versioned and atomic; corrupt local metadata
must not prevent manual opening. Do not serialize run contents in this store.

A remembered location is a hint. Re-read `project.json` before using it. If it
now has another ID, report the mismatch and do not adopt it. If a folder moved,
Locate folder validates the same project ID and registers its new location;
old links remain unchanged. Offer removal of stale entries. Clearing browser
site data, changing origin/port, or moving to another machine loses local
discovery, not the reference itself. The browser registry belongs to one
origin, so `localhost:3000`, `127.0.0.1:3000` and another port each start
empty and fall back to Locate folder. The link also embeds its origin, so
document opening the app on one consistent address.

The registry must stay host-local and must not live in the project's
`.workbench/` directory. Its job is to find that folder in the first place.
Level 2 workbench records are scoped to one checkout, and clones stay
separate, so they cannot serve as a cross-folder index.

Chromium persists handles but usually asks again for readwrite permission
after a browser restart, and the request needs a user action. Clicking a link
from notes therefore normally means one Reconnect click before resolution,
unless the user chose "allow on every visit." Wording should present
Reconnect as the normal path, not as an error.

## Resolution and UI flow

A new `useRunDeepLink` owner retains the parsed intent and drives explicit
states: waiting for startup, resolving project, needing location/permission,
choosing a copy, waiting for safe replacement, reading trace, ready, and error.
Each intent has a generation token; stale async reads cannot select a run or
adopt a workspace after a newer intent, manual navigation, or cancellation.

1. Receive and validate the link. Invalid links show an actionable explanation
   without touching project or execution state. On startup, arbitrate with
   ordinary last-project restoration before either can adopt a workspace.
   A valid explicit link takes precedence; no-link startup works as today.
2. If the current folder's parsed project ID matches, use it. An imported
   manifest with no attached folder is insufficient. Otherwise query the
   registry; one accessible match can proceed, several require a copy choice,
   and none offers Locate project folder. Always retain the requested IDs.
3. Permission requests and folder pickers require an explicit user action.
   Cancel leaves the current project intact and the link available to retry or
   dismiss. An incorrectly selected folder explains the ID mismatch and does
   not replace the current project. A browser without folder access explains
   the limitation; importing only `project.json` cannot resolve the link.
4. Preflight the target manifest and trace before replacement where possible.
   A missing trace should not needlessly displace the user's project. When
   replacement is necessary, go through the project owner's existing
   Save/Discard/Cancel flow, including autosave-in-flight and invalid drafts.
   Save failure cannot advance navigation. Block replacement during active or
   paused chat/decision runs, executing batches, and unresolved pending branches;
   offer retry after the person resolves that work. Never stop it implicitly.
   Same-workspace read-only inspection can coexist with that activity.
5. Resolve the exact run as described below. After replacement, recheck the
   workspace generation and selected identities before committing the result.
   Show Runs and focus the selected evidence heading. Reveal the linked run
   even if a history filter hides it; an experiment member need not appear as
   an ordinary ungrouped history row. Open diagnostics by default for a linked
   trace. No model connection, credential, retry, tool call, branch, or provider
   discovery is required to inspect the saved result.

Use a pending-link region/dialog with the target project/run IDs, local display
names when known, and concrete actions (Locate folder, Reconnect, Retry,
Dismiss). Never label a not-yet-loaded history list as “run not found.” Distinguish
missing folder, permission needed/denied, wrong project, missing trace,
unreadable/invalid trace, unsupported trace version, and ambiguous copies.

A missing trace message should explain that Git's definitions-only policy may
exclude run history. Recovery is to restore/copy the evidence into the matching
project folder and retry; the app should never rerun the model as a substitute.
A stopped browser server cannot render this recovery UI at all: browser users
must start/reach that deployment. Desktop links need the installed scheme
handler. Neither limitation should be described as a broken run identity.

### Exact run lookup

First read `traceFileName(reference.runId)` through the workspace adapter and
parse it with `parseSavedRunTraceJson`. Require the parsed run ID to match. A
present but corrupt/mismatched canonical file is an integrity error, not an
excuse to open another run. Only when that file is absent, enumerate the
project's trace files and match validated contents by run ID, retaining their
actual safe filenames. One match opens; multiple renamed matches report
ambiguity and ask the person to repair/select evidence explicitly. Do not
choose the first entry. Unrelated invalid files must not hide a valid match;
if no match exists, mention unreadable files rather than claiming complete
absence.

Canonical lookup should not require parsing every trace or loading experiment
plans first. The existing fallback listing reads all trace contents, so it can
be slow for a large folder; make progress/cancellation explicit and do not add
a persistent trace index in this slice. Re-read and validate the chosen file if
it came from a stale listing. Apply identical policy to both trace kinds and
individual experiment members. No experiment result/plan is required to inspect
an otherwise valid standalone member trace.

### Copy link and navigation behavior

Add Copy link beside saved evidence and in saved-run actions, including a saved
experiment member. The action uses the workspace that actually owns the trace,
not whichever project is currently selected in the editor. Enable it after a
successful project trace write/read, including terminal failures and cancelled
runs. An in-flight write, failed save, live/paused run, session-only result,
JSON-only imported project, or loose downloaded/exported file is not proof of a
reopenable project trace. State the reason and point to the existing save/open
workflow; copying itself must not save or relocate evidence.

In desktop mode copy the custom URI; in browser mode copy the HTTP fragment
URL. Report success only after clipboard success and expose a selectable URL
if clipboard access fails. Reopening a link still revalidates disk state.

For browsers, listen to initial location and subsequent history/fragment
navigation. A successful explicit saved-run selection can push one canonical
URL; resolving an existing URL must not push again. Filter changes and Copy
link do not add history entries. Keep an unresolved incoming URL so reload can
retry it. Dismissing it or leaving saved-run inspection clears only the app's
run fragment; Back/Forward re-enters the same resolver and protection flow.
Do not attempt to encode every UI state or scroll position in v1.

## Browser tabs and link handoff

A link clicked in a notes app opens a new tab, often while another tab already
has the target project open. This plan relies on the
[tab coordination plan](PROJECT_TAB_COORDINATION_PLAN.md). There, every tab
can work, and exactly one editor tab per project writes `project.json`. That
plan lands first, as its own change.

On resolving a valid reference, the new tab first checks for an editor of the
target project. It uses `navigator.locks.query` for the editor lock name, then
posts an `open-run` message with the reference on the coordination channel.

- **The editor acknowledges.** It runs the reference through its own
  `useRunDeepLink` flow, including its replacement protection. The new tab says
  "Opened in your other tab" and offers to open it here instead. Browsers do
  not let one tab focus another, so the wording must tell the person where to
  look.
- **No editor answers within a short timeout** (no editor, a frozen tab, or an
  older build). The new tab resolves the link itself. If an editor exists, the
  new tab is secondary, which is enough because linked inspection is read-only.
- **The link never transfers the editor role.** Only the person moves it.

Treat `open-run` payloads as untrusted input and validate them with the core
codec, as for URLs. Whether a folder permission granted in one tab applies
immediately in another tab of the same origin must be verified in Chromium,
not assumed.

## Relationship to the shared-assets plans

The [personal-workbench plan](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md),
[Level 2 design](SHARED_ASSETS_LEVEL_TWO_DESIGN.md) and
[migration-completion proposal](SHARED_ASSETS_MIGRATION_COMPLETION_DESIGN.md)
were reviewed on October 28 for effects on this plan.

- **The reference survives v15 to v16.** Level 2 keeps traces outside both
  `project.json` and `.workbench/`, and links identify only project ID and run
  ID. Never add a revision, draft, selection or workbench record ID to
  `RunReferenceV1`. Those become personal or change location under Level 2.
- **Read-only inspection matches Level 2's goal.** "Scratch runs leave shared
  files byte-identical." Opening a linked run must write nothing to the
  manifest or to workbench records.
- **Replacement protection changes later.** Under v15, the Save/Discard/Cancel
  flow guards drafts that live in the manifest. Under Level 2, those drafts
  become recoverable personal records, so switching projects for a link puts
  less at risk. Implement against v15 now, and leave the guard behind the
  project owner's adoption contract so Level 2 can relax it there.
- **Stale handles.** Migration completion invalidates a workspace's save
  handle after an attempted manifest write. A link that targets the current
  workspace after a migration must reopen through the project owner, not reuse
  that handle.
- **Locks.** The tab plan reuses the per-project write scope that workbench
  writes and the migration-completion proposal already rely on. Run links add
  only a message on its channel, not another lock.
- **Missing traces.** The Level 1 Git policy excludes traces, as noted under
  missing-trace recovery.

## Ownership and host integration

| Owner | Proposed responsibility/contract |
| --- | --- |
| `packages/core/src/run-reference.ts` | Pure reference type, versioned codec, validation results; no React, filesystem, provider, or Tauri dependencies. |
| Workspace adapters and local registry | Candidate discovery/access, typed missing/access/read failures, manifest inspection and safe trace reads. Extend existing adapters rather than issuing direct filesystem calls from components. |
| `use-project-workspace.client.ts` | Startup arbitration and guarded adoption of a prevalidated candidate, returning `adopted`, `cancelled`, `blocked`, or `failed`; remains the sole project lifecycle owner. |
| `app/run/use-run-deep-link.client.ts` (new) | Pending intent, resolver state, async cancellation and recovery commands; consumes host ingress and workspace/inspection contracts. |
| `use-runs-navigation.client.ts` | Generalize inspection from `RunTrace` to the discriminated `SavedRunTrace`; accept a resolved reference, actual filename, opaque workspace and generation. Invalidate on workspace changes even when project IDs match. |
| Saved evidence components | Reuse `RunEvidenceDetail` for chat; add a read-only decision evidence composition using existing result/diagnostic renderers, without `adoptTrace`. Copy actions consume verified location context. |
| Host link adapters | Browser location/history, clipboard and tab handoff now. Native URL ingress and clipboard later. All feed the same reference resolver. |
| `app/page.tsx` | Compose owners and supply genuine cross-feature adapters, such as replacement blockers and mode selection. Do not add the parser, registry, resolver effects or filesystem mutation workflow here. |

The existing decision Compose/import workflow can remain a separate explicit
action. Read-only decision inspection is a prerequisite for advertising support
for decision deep links, not a reason to silently substitute Compose adoption.

### Deferred desktop work

Reused unchanged from the browser release: the core codec and payload parser,
exact run lookup, the read-only inspector for both trace kinds,
`useRunDeepLink` and its recovery UI, guarded adoption in the project owner,
the registry interface and shared metadata, Copy link eligibility, and most of
the e2e spec. Desktop adds a Rust-backed registry storage, native ingress and
focus, scheme registration, and packaged-app verification, as described below.

For desktop, add the Tauri deep-link plugin and static scheme registration,
with the required capability configuration. Handle both startup URLs and URLs
delivered to an already running app; subscribe early, buffer until hydration,
and deduplicate startup/event delivery for the same pending intent. Focus the
existing main window. Do not deduplicate a later intentional click forever.
Tauri documents `getCurrent`/`onOpenUrl` and the single-instance integration
needed for warm delivery on Windows/Linux; register that plugin first where
used. See the [official Tauri v2 guide](https://v2.tauri.app/plugin/deep-linking/)
and [JavaScript API](https://v2.tauri.app/reference/javascript/deep-link/).

Validate event payloads as untrusted input even when the OS delivered them.
For multiple distinct URLs, present a choice rather than racing project
adoptions. A newer single intent supersedes an earlier unresolved one, including
its pending replacement callback; generations prevent the old callback from
switching projects later. Runtime event handling is not proof that the packaged
app has registered its URI scheme successfully.

## Delivery slices and verification

1. **Review contracts and capture regression.** Resolve the decision table;
   re-read current owners after concurrent feature work lands. Before adding
   behavior, write the saved-chat cold-entry Playwright regression against two
   distinguishable projects/runs. Open the proposed URL and assert the exact
   requested evidence; record a red run showing the wrong/missing evidence,
   not a selector, hydration, or fixture failure.
2. **Shared reference and read-only inspector.** Add codec tests, exact run
   resolution, and both-kind Runs inspection with cancellation/generation
   tests. Route only the resolved value into the inspector. Add a second red
   regression proving decision inspection preserves Compose and execution.
3. **Project discovery and safe replacement.** Implement the local registry,
   additive migration, candidate inspection, wrong-folder recovery, startup
   arbitration and guarded adoption. Verify each replacement/cancellation path
   before wiring native external entry.
4. **Complete the browser notes workflow.** Add HTTP fragment ingress and
   history, Copy link, the Chrome/Edge requirement, and tab handoff. Test a
   copied link pasted into a notes app, both with no tab open and with an
   editor tab open. Document browser-server availability, the single-origin
   advice, Reconnect, and local-evidence requirements. This completes the
   browser-first release; a parser or same-project demo alone does not.
5. **Desktop adapter (deferred).** Add native URI ingress, packaged scheme
   registration, focus behavior, the Rust registry storage, native Copy link,
   and "Open link…" for browser-era links. Test with Inference Lens closed and
   already running. Preserve v1 link examples in both spellings as
   compatibility fixtures.

Prerequisite, delivered separately: the
[tab coordination plan](PROJECT_TAB_COORDINATION_PLAN.md).

Required coverage for the implementation:

| Layer | Cases and observable evidence |
| --- | --- |
| Pure/core tests | Both URL spellings round-trip; non-UUID IDs; escaping; duplicate/missing fields; malformed encoding; unsupported versions; traversal attempts; canonical/renamed/mismatched/corrupt/ambiguous files; legacy trace versions and both kinds. |
| Registry/owner tests | Legacy browser record migration with permission already granted or still needed; failed persistence; stale/moved folders; duplicate project IDs; same-ID workspace replacement; save failure; superseded requests; Strict Mode duplicate effects; cancelled pickers; restore-versus-link race. |
| New committed `tests/e2e/run-deep-links.spec.ts` | Handoff to an editor tab and fallback when none answers (two pages in one context); paste of the other host's spelling; Firefox/Safari message where a runner allows. Saved chat and decision evidence on cold load; refresh and same-tab navigation; wrong current project; locate correct/incorrect folder; permission retry; missing trace; filtered/grouped member; clipboard content and failure; no usable profile/credential; Back/Forward; unsaved/invalid draft and pending-branch cancellation; active execution preserved; rapid links cannot show stale evidence. |
| Existing browser regression specs | `runs-result-discovery.spec.ts`, `project-replacement-guard.spec.ts`, `pending-branch.spec.ts`, `project-storage-clarity.spec.ts`, and relevant decision/experiment-history specs. Check exact trace IDs/output and preserved drafts; instrument execution requests to prove inspection sends none. |
| Native tests and packaged smoke checks (desktop slice only) | Rust registry/URL boundary tests, then installed macOS cold/warm entry, focus, two different links, moved project, cancellation, and no-server operation. Test actual copy/paste/click in the intended notes app. Windows/Linux behavior remains unclaimed until packaging and delivery are exercised there. |

Use the committed [browser runner and shared drivers](../tests/e2e/README.md),
including `stubProjectDirectory` and `waitForHydration`; extend their directory
fixture for multiple folders/reloads rather than bypassing the project owner.
Fixtures must contain distinct real, parser-valid artifacts. For save-to-copy
coverage, generate/persist a trace through the UI and assert its recorded ID and
known output before copying. Use existing captured decision fixtures and follow
[the provider fixture guide](PROVIDER_FIXTURES.md); deep-link tests need not make
new live-provider calls just to inspect evidence.

During implementation, run the affected spec first:

```sh
npm run test:e2e -- tests/e2e/run-deep-links.spec.ts
```

Run relevant core/owner tests and typecheck, required Rust checks for native
changes, then the relevant existing browser regression specs before handoff.
The full sharded browser suite runs in CI; report that it has not run locally. Browser stubs cannot
prove real permission prompts, persisted browser handles, OS scheme dispatch,
or notes-app URL handling; report native/manual checks separately with exact
build/platform and unverified cases.

## Implementation and verification

The browser implementation follows the approved defaults. The pure reference
codec lives in `packages/core/src/run-reference.ts`, exact evidence lookup in
`run-reference-resolution.ts`, local browser discovery in
`app/project-location-registry.client.ts`, and pending intents in
`app/run/use-run-deep-link.client.ts`. Project adoption remains in the project
owner. Saved decision history now inspects evidence in Runs; explicit import
and experiment adoption remain separate actions. Browser storage upgrades from
version 1 to 2 additively; the legacy last-project record remains readable.
Project v15 and trace v8 are unchanged. The encoded link limit is 16,384 UTF-16
code units. Native scheme ingress and registry storage remain deferred.

The first pre-fix link regression showed same-tab navigation retaining the wrong
project and missing the requested output. Its initial hash-only `page.goto`
was later recognized as same-document navigation, so the final cold-entry test
forces a document navigation with a changed query. The cold-document variant
was added after implementation and was not separately demonstrated red. The
decision regression ran red with Chat's `aria-checked` incorrectly `false` after
browsing a saved decision. Visual review then found diagnostics hiding the
answer: a viewport assertion ran red with ratio 0 before the saved-evidence
scroll layout was fixed. A target-folder-change regression was also written
before its final-adoption fix.

See [Using saved run links](RUN_LINKS.md) for the browser/Docker workflow.
Automated verification uses the committed Playwright runner and distinct,
parser-valid artifacts. Persistent-directory fixtures use real origin-private
handles and IndexedDB cloning; permission denial/retry is overridden at the
handle boundary. Those fixtures do not prove real host-folder permission
prompts or permission sharing across tabs. Clipboard success/failure is
simulated. Notes-app click handling, a Docker container smoke run and installed
desktop entry were not exercised. No native code changed, so Rust/package
checks are not required for this browser slice. The full sharded browser suite
has not run locally or in CI for these uncommitted changes.

Before release, manually check the intended notes app, real folder Reconnect,
the wrong-project/Locate folder flow, and the read-only decision layout. Record
exact platform/build for those checks; automated coverage complements them.

Verified October 28, 2026:

- `npm run build` (includes typecheck) and `npm run lint -- --quiet` passed.
- 76 Node tests passed across `run-reference.test.ts`,
  `run-reference-resolution.test.ts`, `project-directory.test.ts`,
  `project-tab-coordination.test.ts`, `workspace-resume.test.ts`,
  `run-trace.test.ts` and `decision-trace.test.ts`.
- `npm run test:e2e -- tests/e2e/run-deep-links.spec.ts` passed all 20 cases
  using the runner's pinned Chromium. The spec includes actual document cold
  entry, saved decision inspection, wrong-folder and missing-evidence recovery,
  handoff, history/refresh/paste, clipboard fallback, unsupported folder access,
  superseded links and replacement cancellation, pending branches, permission
  retry, duplicate copies, delayed reads, an active chat request, UI-generated
  save/copy/reopen, legacy IndexedDB upgrade, picker cancellation, target
  revalidation, failed-save recovery and an experiment member opened without
  its experiment artifacts. Inspection checks count both real application
  execution endpoints and check the linked manifest remains byte-identical.
- A scoped 72-case browser run passed the then-current 19 link cases and 53
  related cases in `runs-result-discovery.spec.ts`,
  `project-replacement-guard.spec.ts`, `pending-branch.spec.ts`,
  `project-storage-clarity.spec.ts`, `project-tab-coordination.spec.ts`,
  `system-one-decision-suites.spec.ts`, `experiment-history.spec.ts`,
  `evaluation-suite-history.spec.ts` and `decision-compose-scroll.spec.ts`.
  The final member-link case and URL-bound edge guard were added afterward;
  the full link spec and relevant core tests were rerun.
- Screenshot review of the generated saved-run link confirmed the answer is
  visible with diagnostics open. The suite also asserts viewport visibility.
  Some existing browser drivers emitted React hydration warnings about an
  opened Project menu; all scoped assertions passed. The standalone build
  retains the existing large-chunk warning.

The broader required-coverage table remains a target, not a claim that every
permutation was exercised. In particular, the new link spec does not directly
exercise a paused decision replacement, a frozen editor's handoff timeout,
an invalid decision draft, every registry persistence failure, or real
Firefox/Safari engines. Existing replacement and tab specs cover parts of those
owners; they do not substitute for those exact link scenarios.
