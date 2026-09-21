# UI/UX review: everyday prompt, request, and project workflows

**Reviewed September 21, 2026 · `main` at `d41eae2` after `git pull --ff-only`.**

This is a fresh task-based expert review of the running UI, with emphasis on using saved prompts, running requests, and saving/reopening work. It is not a measured user study. Product behavior was not changed. The report, screenshots, and five reproducible browser characterization scenarios are the review deliverables. The existing untracked September 20 re-audit was preserved.

## Assessment

The lingering unfriendliness is real. Several reliability fixes have landed, but the ordinary workflow still requires knowing the application's internal distinctions: a prompt definition versus its use in a conversation, a revision versus a saved project, a selected profile versus a project mapping, and a result versus a saved trace.

Those distinctions should remain in the data model. The UI should do more of the coordination. Currently, the most obvious action or destination often belongs to a different object than the one the user has in mind:

- **Run request** beside the prompt editor runs the conversation hidden under Messages.
- Reusing a prompt starts in its authoring screen, with the use action below optional metadata.
- **Save** can open a **New project** dialog; **Open project** and **Import project** load different storage forms without explaining the difference in the menu.
- **Runs** can be empty immediately after a successful run, even when that run is saved and available elsewhere.

My recommendation is to make the standard path coherent before adding more controls: **insert a saved prompt → fill its values → confirm the run target → run → find the result → save/reopen the project**. The largest improvement will come from clearer ownership and handoffs, not visual restyling alone.

There are also two current P1 issues: unsaved work can be silently replaced by importing another project, and first-use prompt creation still fails without a configured endpoint/model.

## What has improved since the previous review

| Earlier finding | Current assessment |
| --- | --- |
| F01: prompt edits disappear across tabs; Save misses the visible draft | The merged regressions pass for exact draft retention across modes/tabs and Cmd/Ctrl+S creating the visible revision. The new review also verifies JSON export/import retaining a draft and folder autosave retaining it across reopening. Project replacement remains a separate loss path below. |
| F02: historical prompt insertion uses the latest revision | The current implementation explicitly pins the selected revision; the historical-revision and draft-insertion browser tests cover this. Preserve that contract. |
| F03: failed runtime-status probe duplicates the managed profile | The merged outage/recovery regression passes, preserving identity and mappings. Confirmed configuration removal still deliberately releases the credential. The prior remove-then-restore/old-duplicate cleanup concern should be assessed separately; this review does not claim it is fixed or reproduce it anew. |
| F04: background shortcuts run through authoring modals | Modal command-scope coverage is present in the full browser run. Initial focus, menu dismissal, and focus containment remain separate usability concerns. |
| F05: fresh-session New prompt fails | Still reproduced on current `main`. |
| F06–F14: reuse, target choice, history, durability, layout, keyboard behavior | Much of this friction remains. The findings below distinguish fresh evidence from carried-forward observations. |
| F15: evaluation hierarchy | Desktop readiness, Setup, Configurations, Dataset, and Evidence form a much clearer sequence. Keep this improvement; prioritize narrow-screen disclosure rather than another complete evaluation redesign. |

## Findings and priorities

P1 means an ordinary path loses work or fails. P2 means repeated confusion or unnecessary navigation in a core task. P3 means polish or a concern that needs a larger-scale check. These priorities describe the current UI, not an incident severity scale.

### U01 · P1 · Importing a project silently discards the current unsaved draft

**Reproduced, newly demonstrated directly.** Import Daily triage, edit its prompt to `UNSAVED WORK: do not discard silently.`, and observe **Unsaved** in the header. Import Other project. The new project replaces the old one without a native or application confirmation. Reimport the original project: the prompt contains its original saved content, not the unsaved edit.

The browser-close warning does not protect this in-app transition. This is separate from the fixed tab-navigation problem.

**Recommendation:** make project replacement one guarded operation shared by Open, Import, and New. Retain/recover dirty work or offer **Save and switch / Discard and switch / Cancel** when work cannot safely survive the transition. Ordinary navigation within a project should remain frictionless. For folder autosave, wait for the pending write and keep the old project active if it fails.

**Acceptance:** cancel preserves every dirty owner; save completes before replacement; discard is explicit; a cancelled picker or failed write cannot discard the current project. The browser proof here covers JSON import; Open/New and pending-autosave races need their own regressions before implementation is declared complete.

Owner: [project workspace](../../app/use-project-workspace.client.ts), with project transitions routed through it.

### U02 · P1 · A new user cannot start writing a saved prompt before configuring inference

**Reproduced.** In a fresh context, Prompts → New prompt raises `ProjectValidationError` for an invalid endpoint and missing model. The enabled action does not produce a usable editor or a helpful recovery path. Writing reusable text should not unexpectedly require an executable provider target.

**Recommendation:** support a retained authoring draft before a runnable project exists, then attach it to a project on an explicit save/use handoff. As an interim fix, prevent the unhandled error and give an actionable explanation. Do not relax the portable project schema merely to enable the editor.

**Acceptance:** a fresh user can start writing without credentials, endpoint, or model; retention status is explicit; executable requests still validate their target. Draft ownership is a design decision to agree before coding.

Owners: [prompt feature](../../app/templates/use-project-templates.client.ts), [workspace materialization](../../app/use-project-workspace.client.ts).

### U03 · P2, high impact · The visible prompt and the object being run differ

**Reproduced with actual request evidence.** While the editor displayed `VISIBLE DRAFT: diagnose the current incident.`, clicking Run request sent `COMPOSER REQUEST: summarize yesterday.` The request bytes shown in Events confirm it. The prompt had not been inserted, so the runtime followed its current contract; the UI nevertheless makes “run what I am editing” a reasonable interpretation.

Run request, Repeat, and the adjacent Live output pane remain present during prompt-library authoring. Recommended target adds another nearby target control that explicitly does not affect that run.

**Recommendation:** give prompt authoring a clear **Use in request** handoff. Keep request execution attached to the visible conversation. At minimum, label any retained global action **Run current conversation** and show which conversation it acts on. Prefer moving/reframing the action over adding a confirmation to every run. A future **Try this prompt** action needs an explicit contract for whether it replaces or appends to the existing conversation.

**Acceptance:** before sending, the visible request preview, model, and action agree; trying a prompt never silently runs unrelated content or replaces an existing request.

[Current prompt beside a response to the hidden conversation](ui-ux-2026-09-21-evidence/03-prompt-run-sent-conversation.png). Owners: [RequestComposer](../../app/request/request-composer.client.tsx), [Topbar](../../app/topbar.client.tsx), [prompt editor](../../app/project-templates-pane.client.tsx).

### U04 · P2 · Reuse requires going through authoring, and the return path is missing

**Reproduced/visually inspected.** Messages offers Add message and Add tools, but no Insert saved prompt. In Prompts, Add to conversation was outside the initial 1440×900 viewport for a single short prompt. Reaching it required scrolling through Recommended target, revision defaults, and the revision-diff region. Evaluate in a suite and n8n actions are more immediately visible than ordinary reuse.

After insertion, the card has revision information, Detach, Remove, and sometimes Review latest, but no Edit source link. The happy path does work: expanding the incident value, entering `database outage`, and running sent the correctly resolved prompt to the fixture provider.

**Recommendation:** add **Insert saved prompt…** next to Add message. Use a compact picker with search, selected revision, preview, and insertion position; show/focus required values after insertion. Add **Edit source** with an explicit return to the request and preserve existing pins. Add **Save as reusable prompt…** to authored-message actions. Make recommendation metadata and revision history secondary during routine use.

**Acceptance:** the insert/fill/run path does not require visiting the authoring screen; edit-source/back preserves the request, values, and pin; updating an existing pin remains deliberate. Keep exact revision insertion and atomic create-revision-and-add.

[Buried insertion action](ui-ux-2026-09-21-evidence/04-insertion-below-metadata.png) · [Inserted prompt and value scope](ui-ux-2026-09-21-evidence/05-inserted-prompt-values.png).

### U05 · P2 · “Saved” and “Open” still require knowing the storage implementation

**Reproduced and source-confirmed.** Several individually valid operations form a confusing whole:

| User action/state | Current presentation | Resulting uncertainty |
| --- | --- | --- |
| Save an imported JSON project | Dialog says **New project / Create an Inference Lens project** | Am I saving this work or starting over? |
| Reopen work | Open project chooses a folder; Import project reads JSON | Which entry opens the file I have? |
| Reimport an exported project containing a draft | Header has no Unsaved marker and editor says **Draft autosaved** despite no folder being attached | Will subsequent edits keep saving to the file I imported? |
| Export current work | JSON contains the draft, but header remains Unsaved | Did the operation succeed, and what does Unsaved mean now? |
| Edit a pinned prompt's Value for run | It becomes a session override; Save to project is a separate action | Will saving the whole project retain this input? |

The tested export and folder-save paths did preserve prompt text. This is primarily a state/copy problem, not evidence that all saving is broken. Session overrides intentionally differ from saved use values; project saving does not by itself change that scope.

**Recommendation:** make location and write state persistent and explicit: **Session only — Save to folder…**, **Saved to [folder]**, **Saving…**, **Save failed — Retry**. Distinguish a downloaded copy from a connected folder. Use **Open project folder…**, **Import project JSON…**, **Save project to folder…**, and **Export JSON copy…** until a single entry can handle both forms clearly. The save-location dialog should say **Save this project** and explain that it preserves current prompts/settings. Beside variable inputs, show **This run only / Saved with this request** without requiring a separate discovery step.

**Acceptance:** imported projects never imply an attached autosave destination; the header and prompt state agree; export explains that it creates a copy; users can predict which values and results survive closing. Prompt-only portability and cross-project reuse need an explicit product decision rather than quietly changing project ownership.

[Save dialog](ui-ux-2026-09-21-evidence/09-save-opens-create-dialog.png) · [Autosave claim after JSON import](ui-ux-2026-09-21-evidence/10-export-import-retained-draft.png). Owners: workspace, [creation dialog](../../app/project-creation-dialog.client.tsx), and the scope derivation currently composed in [page](../../app/page.tsx).

### U06 · P2 · Selecting a connection can contradict the project's actual target

**Reproduced.** With a project mapped to Local model A, choosing Local model B in the topbar disables Run. The page says the project is not connected, while Connections says **Project connection mapped** and shows A. The separate profile editor shows B. **Map B** navigates to another control rather than performing the operation its label suggests.

**Recommendation:** show one contextual target summary: connection, model, and scope. In a project, selecting B should explicitly offer to use B for the relevant requirement on this device, disclosing shared consumers. Editing saved connection definitions should be separate. Say **Choose project connection…** when an action opens a chooser. Fix the missing-model explanation that sends users to Connections while its action actually opens the model control in Messages.

**Acceptance:** topbar, readiness, settings, and outgoing request identify the same resolved target; mapped-to-A is distinguishable from unmapped. Keyless connections should not look unhealthy just because the credential indicator is amber.

[Contradictory target state](ui-ux-2026-09-21-evidence/05-connections-and-mappings.png). Owners: [readiness](../../app/run-readiness.client.ts), [Connections](../../app/connection-drawer.client.tsx), profile/workspace adapters.

### U07 · P2 · Runs is not where users can find their ordinary runs

**Reproduced for imported and folder-backed projects.** After a successful ordinary request, Runs says No results open and offers Go to Evaluations. With an imported JSON project, Run data → Run history is disabled. With a folder-backed project, that menu contains the completed run even while Runs is empty. Opening the ordinary history entry returns to Compose.

**Recommendation:** make Runs the common browse-and-inspect destination, including ordinary requests, repeated runs, evaluations, and comparisons. Show type and persistence status. Reuse the existing history filters and response surface. A smaller interim improvement is to add **View current response** and **Open saved run history** directly to Runs, with a save-to-folder explanation when appropriate.

**Acceptance:** every completed request is reachable through Runs; session results and folder-saved results are distinguished; no unrelated evaluation detour is needed. Decide session-history retention before implying that all prior unsaved runs are recoverable.

[Saved run visible in a drawer over an empty Runs page](ui-ux-2026-09-21-evidence/12-folder-run-history.png). Owners: [Runs mode](../../app/modes/runs-mode.client.tsx), history/response features.

### U08 · P2 · Layout still favors inspection chrome over the active editing task

**Visually reproduced at desktop and narrow widths.** Prompt authoring occupies roughly half the desktop while an idle response occupies the other half. At 390px, the persistent prompt rail consumes scarce space and revision-name controls overlap it. At 320px the editor is still more constrained. Narrow Evaluations puts the provider-input inspector before Setup/Dataset; it fills most of the first screen after readiness.

**Recommendation:** give prompt authoring full available width, with list/detail navigation below a breakpoint and a persistent Use in request action. Keep evaluation editing first; use an optional Preview tab or drawer on narrow screens. Preserve draft/selection state when changing layout.

**Acceptance:** controls do not overlap at 320/390/880px; the content editor owns usable width; setup/case editing precedes optional provider detail. Absence of page overflow is not sufficient.

[390px prompts](ui-ux-2026-09-21-evidence/09-prompts-390.png) · [390px evaluations](ui-ux-2026-09-21-evidence/09-evaluations-390.png) · [Improved desktop evaluations worth preserving](ui-ux-2026-09-21-evidence/09-evaluations-1440.png).

### U09 · P2 · Menus and dialogs remain unpredictable from the keyboard

**Reproduced.** Escape leaves Project open; opening Run data can leave both menus layered; opening the local tool library leaves focus outside the modal. The new background-command protection does not resolve these interaction issues.

**Recommendation:** use one menu-dismissal contract and one dialog-focus contract: a single header menu open, Escape/outside dismissal, deliberate initial focus, contained modal tab order, and return to the invoking control. Audit pointer-only resizing separately.

**Acceptance:** a keyboard-only user can open, operate, and dismiss each overlay without reaching the obscured page or losing their place. Keep the existing modal command suppression.

### U10 · P2, secondary to the standard path · Tool copy still has hidden effects

**Reproduced.** Copy to project also saves the edited library tool and attaches its copy to requests. With tools disabled in the profile, this immediately blocks Run. Manual/mock/command response policy is not summarized where attachment happens. A fixture tool call with a mock did successfully pause and continue.

**Recommendation:** label the exact operation (**Save, copy and attach**, or separate copy from attachment) and summarize **included / response source / approval behavior** beside each attached tool. Keep schema authoring and command grants secondary. Attaching a definition must not implicitly authorize local execution.

## Smaller follow-ups

- **Prompt-library scale (P3):** the visible library offers Active/Archived but no prompt search or sort. The variable filter inside a pinned use solves a different problem. Add library search alongside the insertion picker; validate long names and dozens of prompts before claiming scale is solved.
- **History recognition (P3):** ordinary run entries emphasize model, timestamp, metrics, and a trace filename. A prompt/request excerpt or friendly run label would make similar runs easier to recognize. Verify this with a larger history.
- **Vocabulary and visual priority (P3):** Detach could be **Convert to editable messages**; focus-mode Expand could be **Focus editor**. n8n import/paste is useful but receives more first-screen emphasis than generic saved-prompt reuse. Move specialized import choices into a secondary menu without removing them.

## Proposed usability plan

The following is a proposal, not an implementation decision already made.

| Phase | Work and outcome | Completion evidence |
| --- | --- | --- |
| 1. Protect work and unblock first use | U01–U02: guarded project replacement and a valid pre-connection authoring path. | Desired-behavior regressions written and run red first. Verify import/open/new cancellation, pending/failed saves, and a genuinely fresh session. |
| 2. Make the normal request path direct | U03–U04: Insert saved prompt in Messages, source/back links, clear use-in-request handoff, action aligned with visible content. | From Messages, pick a prompt, set values, run, inspect exact sent input, edit source, return, deliberately update the pin. Repeat with a historical revision and dirty draft. |
| 3. Make persistence and targets legible | U05–U06: persistent project status, correct save/open labels, contextual target summary and scoped remapping. | Exercise folder and imported-JSON projects, export/reimport, session versus saved values, two profiles, missing models, and shared evaluation requirements. |
| 4. Give results an expected home | U07: current result/history entry points first; unified Runs browsing after retention scope is agreed. | Ordinary, repeated, and evaluation results found from Runs; distinguish unsaved session evidence and saved files; reopening does not start a new request. |
| 5. Finish responsive and input consistency | U08–U10: prompt list/detail, optional narrow preview, shared overlay behavior, honest tool actions. Apply relevant layout/focus work during earlier phases too. | Geometry and task order at 320/390/880/1280/1440; keyboard traversal/focus restoration; explicit tool copy/attachment and continuation. |

### Consequential decisions to agree before implementation

| Decision | Options and tradeoff | Recommendation |
| --- | --- | --- |
| Prompt draft before project setup | Session-owned authoring draft preserves strict project validation; incomplete portable projects would change compatibility everywhere. | Session-owned draft with explicit retention and later attachment. Decide whether reload recovery is required before choosing storage. |
| Project switching with dirty work | Recovery drafts reduce interruption but add lifecycle/storage complexity; save/discard/cancel is smaller and explicit. | Start with guarded transitions and pending-save completion; add recovery if its retention contract is agreed. |
| Prompt authoring location | Full-width dedicated authoring reduces hidden-request confusion; retaining the nested tab is a smaller navigation change. | Make insertion contextual immediately, then use full-width authoring with explicit return-to-request. A new top-level tab is optional, not a prerequisite. |
| Prompt reuse across projects | Keep project-local prompts with explicit copy/import, or create a global library with identity/sync rules. | Preserve project ownership initially; offer explicit copy/import when needed. Do not quietly introduce a second source of truth. |
| Runs membership and retention | Unified browsing matches the label but needs a session/history contract; narrowing the label is cheaper but leaves navigation split. | Unified destination, delivered first through current-result and saved-history entry points. |
| Target selection | A global active profile and a project mapping can remain separate internally, but competing execution selectors confuse users. | Project context displays the resolved mapping; remapping is explicit and profile management is separate. |

Implementation ownership should follow these features: workspace transitions/status, prompt picker/editor/use state, contextual target/readiness, Runs/history, and shared overlay primitives. The route should compose their contracts rather than accumulate new workflow state. Most presentation work need not change the project format. Preserve immutable revisions, device-local credentials/mappings, and explicit tool grants.

## Verification and limits

This review drove the running application using the repository's Playwright runner, shared hydration/import/directory drivers, and real loopback provider responses. Screenshots were visually inspected; request evidence was checked for the actual sent content. The folder picker used the committed in-memory directory stub, so folder-save checks exercise application storage code, not native filesystem permissions or restart recovery.

Commands run:

```sh
npm run test:e2e -- tests/e2e/ui-ux-audit.spec.ts tests/e2e/prompt-draft-retention.spec.ts tests/e2e/server-default-profile-recovery.spec.ts --workers=2
npm run test:e2e -- tests/e2e/ui-ux-workflow-review.spec.ts --workers=2
npm run test:e2e -- --workers=2
```

- Focused existing audit/regressions: **10 passed**.
- New workflow characterizations: **5 passed** on the corrected run. The first run had two driver failures (Events includes a count; a defaulted variable must be expanded) and one incorrect expectation: a clean JSON import actually says Draft autosaved. The latter became evidence for U05; driver timeouts are not product failures.
- Full suite: **183 passed (1.6 minutes)**. A second full run after strengthening the folder-reopen scenario also finished **183 passed (1.6 minutes)**. The final reopen proof switches to a different project before opening the saved folder, preventing retained editor state from satisfying the assertion.
- The existing fresh-session audit intentionally expects the current validation error. Passing characterization tests establish that the problems were reproduced; they do not mean those flows are good or fixed. No product fix or red-to-green regression cycle was performed in this review.
- Existing evaluation scenarios emitted duplicate React-key warnings. They deserve a separate investigation; this review does not infer a user-visible defect from the warnings alone.

The new [workflow review spec](../../tests/e2e/ui-ux-workflow-review.spec.ts) retains the five reproductions. Selected screenshots are beside this report; additional captures, text, exported synthetic JSON, and the full-suite log are in `/tmp/inference-lens-ux-review-2026-09-21` and `/tmp/inference-lens-ux-evidence`.

Not checked directly: native Tauri UI/OS dialogs, actual folder permissions and app restart, real keychain/credentials, live hosted providers or n8n accounts, other browsers, screen readers, and large prompt/history/evaluation collections. Build, unit, and Rust suites were not run for this review-only change. Dark-mode visual inspection was limited to captured evaluation results plus the suite's theme-sensitive coverage.

For the user's own review, the most valuable next check is a short pass through the proposed insert/fill/run/save/reopen sequence using familiar projects. In particular, decide whether “try this saved prompt” should append to the existing request or create a separate request, and whether prompts are expected to travel independently between projects. Those expectations determine the next UI design more than another round of spacing changes.
