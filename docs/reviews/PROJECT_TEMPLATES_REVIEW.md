# Review — project templates (`claude/project-templates-review-d2fmlz`)

Reviewed at `04c58c1`, five commits over `origin/main` (`aa68c1b`), 28 files,
+4,754 / −113.

Method: read the full diff, then ran the suite, the linter, the core
typechecker, and an ad hoc Playwright driver against `npm run dev` plus
`npm run dev:echo-provider`. Everything below marked **verified** was observed
in a browser or reproduced in Node; everything marked **by inspection** was
found by reading and is not claimed to have been executed.

## Automated checks

| Check | Result |
| --- | --- |
| `npm test` (build + core + 4 render suites) | pass, 12/12 |
| `npm run lint` | clean |
| `npm run typecheck:core` | clean |

## Verdict

The core layer is the strongest work in this repository so far. The app layer
is where it slipped, and it slipped in a way the project's own conventions were
set up to prevent. Four defects reached the branch; one of them makes branching
a template-backed conversation impossible, and it would have been caught by the
first browser run.

## Status

All four defects below are **fixed** on
`claude/project-templates-review-ooe4od`, with regression tests and a second
browser pass. See [Resolution](#resolution) for what changed and what was
re-verified. The separation and testing observations stand — the hook extraction
was not done.

---

## What holds up

### Core contracts — verified

`template-engine.ts` is provider-neutral, depends on neither the project types
nor React, and makes the central call correctly: rendering always produces
text, and unresolved-versus-empty is a caller policy decision rather than an
engine one (`template-engine.ts:63-68`). The split between the tolerant
`resolveProjectRevision` and the strict `prepareProjectRevisionRun`
(`project.ts:1156-1177`) is the right shape — one resolver, two policies,
documented at the boundary.

Resolution order and value precedence were checked end to end against the echo
fixture. A revision holding a literal system message, a fragment use, and a
two-message set produced, verbatim from the provider:

```
Fixture received system="LITERAL-SYSTEM"
               | user="TOPIC=[OVERRIDE-TOPIC] AUDIENCE=[SAVED-AUDIENCE]"
               | system="PERSONA=[DEFAULT-PERSONA]"
               | user="WORD=[DEFAULT-WORD]"
```

Authored order is preserved across item kinds, and all three precedence levels
resolve correctly in one request: `OVERRIDE-TOPIC` (run-only) beat the revision
default, `SAVED-AUDIENCE` (use value) applied where no override existed, and
both `DEFAULT-*` values fell through from the pinned revision. The "Effective:"
line in the use card matched what the provider received.

### Trace provenance — verified

`parseRunTraceFile` re-renders every `templateResolutions` entry and rejects the
trace when emitted IDs, roles, or text disagree with `input.messages`
(`run-trace.ts:296-337`). Provenance is treated as evidence to be verified, not
metadata to be trusted. The v3 envelope validates shape first, so a malformed
array is an invalid trace rather than an internal error, and the tolerant
re-render means a run made with a blank variable still verifies against the
`{{name}}` token it actually sent.

A real run wrote a schema-version-3 trace carrying both resolutions with correct
values and output message IDs, and re-importing it through **Project → Run
history** restored the transcript with the resolved template text intact — which
means the verification path ran and passed on a genuine artifact. The traces
directory was listed exactly once, so on-demand history loading still holds. The
only secret-shaped string anywhere in the artifact was `"authorization": "(not
set)"` from the redacted header projection; no credential leaked.

### Atomic message-set branching — verified

`nonBranchableMessageIds` works as designed. In a five-message transcript, the
"Edit from here" control on the first message of the two-message set was the
only one disabled, carrying the correct explanation:

```
[0] disabled=false
[1] disabled=false
[2] disabled=true  "A message-set template is atomic. Branch after its final
                    message or detach it first."
[3] disabled=false
[4] disabled=false
```

### Validation breadth — by inspection

Duplicate output-message-ID detection across items, fragment/message-set role
coherence, output count matching the pinned revision's shape, and secret-like
names rejected at four independent boundaries (revision defaults, use values,
run overrides, trace provenance). `authoredBranchItems` (`project.ts:1339-1399`)
treats a message-set use as atomic with a specific error rather than silently
flattening it. `PROJECT_FORMAT.md` and `RUN_TRACE_FORMAT.md` are detailed enough
to review the code against, which is how several items below were found.

### Rendering hygiene — verified

No `NaN`, `Infinity`, or `undefined` appeared in the composer, the resolved
request preview, or the run history drawer. Dark and light both render.

---

## Defects

### 1. Branching a template-backed conversation is unconditionally broken

**Verified, reproduced in isolation.** Severity: high.

Run a project containing any template use, click **Edit from here** on the final
message — the most legitimate branch point available — and press Run. The branch
is refused:

```
This template-backed conversation differs from its generated messages.
Detach the template use before editing generated text.
```

Nothing differs. The guard at `page.tsx:1160` compares
`JSON.stringify(request.messages)` against `JSON.stringify(prepared.messages)`,
and those two strings disagree on **key order alone**. Reproduced with core
functions only:

```
JSON.stringify equal:            false
deep-equal ignoring key order:   true

[4] DIFFERS
  transcript: {"id":"…","role":"assistant","content":[…]}
  resolved  : {"id":"…","content":[…],"role":"assistant"}
  key order transcript: id,role,content
  key order resolved  : id,content,role
```

The cause is structural, not incidental: `parseProjectFile` rebuilds every
message through Zod, which emits keys in schema declaration order — `messageBase`
contributes `id, content` and the discriminated-union member appends `role` —
while messages coming off run state carry `id, role, content`. Any resolved
message that has passed through validation will mismatch a transcript message,
every time. This is not a rare edge; it is the default path.

The codebase already has the fix and uses it three lines away:
`authoredBranchItems` compares with `stableJsonValue` for exactly this purpose
(`project.ts:1381`). The two call-site guards do not:

- `page.tsx:1160` — fires on every template-backed branch, as above.
- `project.ts:1243` — same pattern in `updateProjectDraft`; it did not fire in
  testing because both sides currently originate from the same construction
  path, but it is the same latent bug.

### 2. A run-only override makes the branch fail differently

**Verified.** Severity: medium. Independent of defect 1.

With one run-only override active, the same branch attempt fails with a
different message:

```
A template use is atomic when branching and its generated text cannot be
edited. Branch after its final message or detach it first.
```

`authoredBranchItems` re-resolves the parent revision with saved values only —
`resolveProjectRevision(project, parent)` at `project.ts:1345` takes no overrides
argument — while the transcript it is matched against carries the overridden
text. `editFromHere` (`page.tsx:918-934`) does not propagate overrides either.
The user is told a message-set is atomic when the real cause is that a variable
was overridden for the run.

Isolation run, same branch point, same project:

| Condition | Result |
| --- | --- |
| No override | fails via defect 1 |
| One run-only override | fails via defect 2 |

### 3. "Edit from here" does not truncate the composer when a project is open

**Verified.** Severity: medium.

Branching at message index 1 of 4 should leave one template use in the composer.
Both remain:

```
cards before:                          2
branch banner present:                 true
cards after branching at message 1:    2   (expected 1)
```

`resetMessages` updates only the local `messages` draft, but the composer now
renders `composerItems = activeProjectRevision?.items ?? messages.map(…)`
(`page.tsx:1563-1565`), which prefers project items and ignores `messages`
entirely whenever a project is open. The banner says a branch is pending while
the list shows the untruncated parent conversation. The run path does read
`messages`, so display and behavior have silently diverged. This worked on
`origin/main`, where the list mapped `messages` directly — it is a regression.

### 4. A secret-like variable is an unescapable dead end

**Verified in Node and in the browser.** Severity: medium (usability).

A template containing `{{api_key}}` is accepted at every authoring step and
blocked at every supply point:

```
template with {{api_key}} and no default:  ACCEPTED by validation
use inserted:                              ACCEPTED
resolution diagnostics:                    ['Template variable "api_key" has no value.']
run allowed:                               false
saved use value:  REJECTED — Secret values cannot be stored on portable template uses
run override:     REJECTED — Secret values cannot be supplied as template run overrides
```

Refusing to persist the secret is correct. Leaving the author with a permanently
unrunnable project is not. The diagnostic the user actually sees says only that
the variable *has no value* — it never says the variable *name* is the problem,
and never suggests renaming it. The authoring pane gives no early warning either:
`sensitiveAssignedVariables` requires `Object.hasOwn(defaults, name)`
(`project-templates-pane.client.tsx:90-93`), so typing `{{api_key}}` into the
editor produced no message and left **Save revision** enabled.

---

## Separation

`app/page.tsx` went 1,499 → 2,052 lines. Roughly 300 of those are template
orchestration sitting directly in `HomeContent`: `ensureProjectDocument`,
`adoptAuthoredProject`, `projectForUseMutation`, `createProjectTemplate`,
`saveProjectTemplate`, `insertProjectTemplate`, `updateTemplateUseValues`,
`updateTemplateUseOverride`, `updateTemplateUseToLatestRevision`,
`detachTemplateUseFromProject`, `removeTemplateUseFromProject`,
`mutateAuthoredItems`, `addComposerMessage`, `updateComposerMessage`,
`removeComposerMessage`, `templateRequestPreview`.

The repository already answers this. `use-project-workspace.client.ts`,
`use-project-run-history.client.ts`, `use-request-draft.client.ts`,
`use-connection-profiles.client.ts`, and `use-model-discovery.client.ts` all
exist, and the run-history feature that landed immediately before this one
extracted a 120-line hook for less logic than this. Templates got a
presentational pane and no hook. There is no `use-project-templates.client.ts`,
and there should be.

This is not a style preference. All four defects live in that unextracted
region, and defects 1 and 3 are pure state-wiring bugs that a hook-level unit
test would have caught without a browser.

## Testing

The core is well tested: 22 cases across `template-engine.test.ts`,
`project.test.ts`, and `run-trace.test.ts`, asserting on interleaved authoring
order, atomic branching, secret rejection, and provenance mismatch. Those are
real tests, not happy paths.

The orchestration has no tests at all. Nothing references `page.tsx` or
`HomeContent`. Untested: the branch-on-first-edit policy
(`executedRevisionIdsRef`), the run-time template wiring, the override
lifecycle, the composer item mutations, and the request preview.
`project-templates-render.test.mjs` is 84 lines of SSR smoke tests asserting
that `Saved value` and `Run-only override` appear in markup — worth having, but
not coverage of anything that can go wrong.

The gap maps exactly onto the defect list.

## Smaller items

- **`window.confirm` ×3** for detach, remove, and update-to-latest
  (`page.tsx:658, 686, 707`). One prior use exists in
  `tool-registry-modal.client.tsx`, so this is not unprecedented, but the
  update-latest dialog interpolates raw `JSON.stringify(pinned.content)` →
  `JSON.stringify(latest.content)` into a native alert. For a message-set
  template that is an unreadable wall. It is also untestable, which is part of
  why that path is unverified.
- **Revision labels can read "Previous 0."** The dropdown reverses the array and
  labels by reversed index (`project-templates-pane.client.tsx:195-199`). Only
  reachable when the current revision is not the newest;
  `setPromptTemplateCurrentRevision` exists in core but is not wired to the UI,
  so this is latent.
- **`activeProjectResolution` is computed in the render body**
  (`page.tsx:481-490`) and `resolveProjectRevision` throws
  `ProjectValidationError` on an invalid pinned revision or an unknown override
  key. That is an uncaught throw during render into the error boundary.
  `templateRequestPreview` wraps its equivalent work in try/catch; this does not.
- **Indentation is broken** in the `TemplateUseCard` fragment block
  (`project-templates-pane.client.tsx:566-612`) — the JSX inside `<>` was never
  re-indented. Cosmetic, but it is the one place the code stops matching the
  rest of the repository.

## Retracted

I predicted during code reading that per-keystroke revalidation would degrade
the composer as a project grows, because `mutateAuthoredItems` runs a full Zod
`parseProjectFile` two or three times per character. **Measurement does not
support that.** Typing 36 characters into a message body:

| Context | Cost |
| --- | --- |
| Ad hoc, no project | 9.3 ms/char |
| Project, 1 revision, 2 templates | 13.3 ms/char |
| Project, 31 revisions, 20 templates | 12.6 ms/char |

A project costs roughly 40% more per keystroke than ad hoc, and that overhead is
flat from 1 to 31 revisions rather than growing with document size. Some of the
baseline is the driver's own typing overhead. It is worth knowing, but it is not
a scaling problem and should not gate this work.

## Resolution

Applied on `claude/project-templates-review-ooe4od`, which merges the template
branch and fixes on top of it. `npm test` (178 core + 12 render), `npm run
lint`, and `tsc -p tsconfig.json` are clean.

### Defect 1 — key-order-sensitive comparison

Added `sameConversationMessages` to `project.ts`, which compares through the
existing `stableJsonValue` normalizer, and used it at all three sites: the run
guard in `page.tsx`, the draft guard in `updateProjectDraft`, and the per-message
check inside `authoredBranchItems` (which already normalized, and now shares one
helper). The doc comment records *why* the two sides disagree, so the next
comparison written against run state does not reintroduce it.

### Defect 2 — overrides not threaded through branching

`CreateBranchRevisionOptions` gained `runOverrides`, passed down to
`authoredBranchItems` so the parent is resolved the same way the run resolved
it. `page.tsx` passes `templateRunOverrides` at the branch call site.

### Defect 3 — composer ignores a pending branch

Exported `authoredItemsForMessages`, and `composerItems` now prefers a
branch preview built from the truncated draft when a branch is pending, falling
back to literal messages if the core would refuse that branch point. Template
uses still render as use cards during a pending branch rather than flattening.

### Defect 4 — secret-like variable dead end

The authoring pane now flags a secret-like variable on discovery rather than
only when a default is assigned, disables **Save revision**, and states the
remedy. The use card carries the same remedy. `resolveProjectRevision` rewrites
the `missing-template-variable` diagnostic for secret-like names, so the message
surfaced when a run is refused explains that the name is the blocker instead of
reporting only that the variable is unfilled.

### Regression tests

Five cases added to `tests/project.test.ts`:

- `compares conversation messages by value, not by serialized key order`
- `branches a template-backed conversation whose messages came off run state`
- `branches with the run overrides the branched messages were produced with`
- `previews a pending branch as authored items`
- `explains that a secret-like variable can never be filled`

The override test asserts the old failure explicitly — branching without passing
`runOverrides` still throws `/generated text cannot be edited/` — so it fails if
the parameter is dropped again.

### Re-verified in the browser

Same fixtures, same scenarios that failed the first time:

| Scenario | Before | After |
| --- | --- | --- |
| Branch at final message, no override | refused | succeeds |
| Branch at final message, override active | refused, wrong reason | succeeds |
| Composer after branching at message 1 | 2 template cards | 1 template card |
| Branched run payload | n/a | `system="LITERAL-SYSTEM" \| user="TOPIC=[DEFAULT-TOPIC] AUDIENCE=[SAVED-AUDIENCE]"` |
| Branched run payload, override active | n/a | `… TOPIC=[OVERRIDE-TOPIC] …` |
| Branched trace | n/a | v3, one `Question` resolution, `branchedFrom` set |
| `{{api_key}}` at authoring | silent, Save enabled | warning with remedy, Save disabled |

The branched run sends exactly the truncated conversation — the `Pair` message
set is gone from both the composer and the request — and the override survives
into the branch.

### Not done

The `use-project-templates.client.ts` extraction. The orchestration in
`HomeContent` is unchanged in shape, so the testing gap described above is still
open: the four fixes are covered at the core boundary, not at the hook level
that does not yet exist.

## Remaining work

Defects 1–4 are done. What is left from the original list:

1. Extract `use-project-templates.client.ts` and unit-test the branch-on-edit
   policy, the override lifecycle, and the composer mutations. Would have caught
   defects 1 and 3 before they shipped, and is the only structural item still
   outstanding.
2. Replace the three `window.confirm` calls with the app's own modal, so the
   update-to-latest path stops rendering raw JSON in a native alert and becomes
   testable.
3. Wrap `activeProjectResolution` so a `ProjectValidationError` during render
   cannot reach the error boundary.
4. Fix the "Previous 0" revision label before
   `setPromptTemplateCurrentRevision` is wired to the UI.
5. Re-indent the `TemplateUseCard` fragment block.

## Reproduction

Fixtures and dev server were stopped after the run. To reproduce:

```sh
npm run dev                  # terminal 1
npm run dev:echo-provider    # terminal 2 — 127.0.0.1:4012
```

Open a project containing at least one fragment use and one two-message set,
map the connection to a profile pointing at the fixture, run once, then click
**Edit from here** on the final message and run again. Defect 1 appears
immediately. Add a run-only override before the first run to see defect 2
instead. Branch at an earlier message to see defect 3.
