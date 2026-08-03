# Evaluation suite authoring

Evaluation suites are portable Project v8 content. The **Evaluations** tab in
the Request pane owns suite, input, case, and deterministic-check editing. Its
focus-mode control expands the same live editor to the full application surface.

A suite owns its input: the selected conversation revision is persisted as the
suite's `input`, so Messages and the evaluation can point at different revisions
and neither one moves the other. Input columns bind stable template-use IDs to
variable names, and preflight reports when the suite's revision no longer
contains a bound use or variable. Empty suites remain valid authored state but
cannot execute.

A suite also owns its execution settings — connection requirement, model,
delivery mode, inference options, and repetitions — and they are saved with the
suite. Changing the evaluation's model or temperature therefore never edits the
composer's, and a suite reproduces the same batch wherever the project is
opened. Only the device-local runtime target (profile, endpoint, protocol,
capabilities) is supplied from outside; see
[the project format](PROJECT_FORMAT.md#suite-owned-input-and-execution).

Preflight covers the selected cases, not only the bindings. It reports a case
value that is empty or whitespace, and a `contains` or `exact-match` check whose
expected text is still empty — the state `+ Add check` leaves behind, where
`contains ""` would pass against every possible answer. Unselected cases are not
this run's problem and are not reported.

Case selection defaults to the whole suite. It narrows to an explicit set the
first time a row checkbox is touched, so reopening a saved project previews the
run the author described rather than an empty selection they must repair. The
selection is session state and is not written to `project.json`.

The case grid previews `selected cases × repetitions` without making provider
calls. Case values, reference answers, and execution settings are stored in
`project.json`; the UI warns authors not to put credentials or secrets into this
portable data.

Every check kind in `CHECK_KINDS` must have a default definition the project
parser accepts, because adding a check revalidates the whole project: a default
the parser rejects makes that kind unreachable from the editor rather than
merely unfinished.

Unfinished checks are authored state, not rejected edits. Authored projects
validate through `authoredCheckDefinitionSchema`, which additionally permits an
empty regex pattern, so `+ Add check` with **Regex** selected produces an empty
Regex card the author then fills in. Preflight — not the add action — reports
the empty pattern and blocks the run, exactly as it already did for an empty
`contains` or `exact-match` value. Executable experiment plans still validate
through the strict `checkDefinitionSchema`, so an incomplete check can never
reach a provider call.

Suite, binding, case, and check additions always mint new identities. Check IDs
are unique across the entire project, including when future duplicate actions
copy authored checks.

## Choosing the input

Revision choices are described rather than timestamped. A choice leads with the
names of the prompts the revision pins, then a short summary of its first
meaningful message, and puts the time last as disambiguation; the stable ID
stays in adjacent details rather than becoming the label. A revision with no
pinned prompts leads with its first message instead.

When the suite has bindings, choices are grouped as **Compatible revisions** and
**Other revisions**. Incompatible revisions are never hidden or disabled —
selecting one is how an author sees and repairs a historical incompatibility.
Compatibility is decided by exact template-use ID and variable name, because two
uses of one template are different authored inputs.

Historical revisions live behind a secondary **Use a project revision…**
disclosure. The suite's current input is the headline; browsing project history
is the deliberate, secondary act.

**Start from saved prompt…** authors a prompt-only revision from an active saved
prompt and points the suite at it, so an evaluation can start from a template no
conversation uses yet. It does not move or modify the Messages editor, and the
resulting notice says so. Archived templates are excluded, since project policy
already forbids adding them to a conversation. The portable shape this writes is
documented in [the project format](PROJECT_FORMAT.md#starting-an-evaluation-from-a-saved-prompt).

## Exact focused-case preflight

The focused case shows the exact provider input an execution would snapshot. It
renders in the **response pane**, titled "Provider input", whenever the
Evaluations tab is the active request context and no execution is on screen —
the same pane the results workspace claims the moment a run starts. The editor
on the left keeps the controls; the pane on the right shows what they resolve
to, and follows the focused case as it changes. A live or reopened execution
always wins the pane. On a narrow viewport the panes are tabs, and the response
tab names itself "Preview" while an evaluation is being authored.

A **finished** execution gives the pane back in either of two ways: its "Back to
editing" action, or pointing the editor at a different suite, revision, or case,
which makes the results describe something other than what is being authored.
Editing a field of the suite that was run is not a re-target and keeps the
results on screen. Both routes are the same release: a durable evaluation is
already written to the project folder and reopens from grouped run history, so
dismissing it is navigation; an unsaved session evaluation is the last copy of
its runs, so clearing one is confirmed first. A running batch keeps the pane
either way. Repeated experiments release the pane on the same rule, through
"Close results".

All four regions are open by default; only the stable IDs inside revision
provenance stay behind a disclosure:

1. **Revision provenance** — the same projected description the selector and the
   start confirmation use, which prompts are pinned and at which immutable
   template revision, and the stable IDs behind a details disclosure.
2. **Resolved values** — one row per template variable with its effective value
   and its source: case value, authored use value, or template default. A
   variable no level supplies stays visible as a setup error rather than a blank,
   and a case input the revision cannot satisfy gets its own row instead of
   being silently dropped.
3. **Resolved conversation** — the exact ordered roles and rendered text.
4. **Execution settings** — connection, endpoint, protocol, model, delivery
   mode, every populated inference option, and tools (`None`: evaluations send
   no tools, so a tool selected in Messages neither travels with the plan nor
   blocks the run).

Preflight, this preview, and `createEvaluationExperimentPlan` all resolve
through one projection, `resolveEvaluationCase`, so the preview cannot drift
from the plan. Precedence is applied exactly once, as template revision default,
then authored template-use value, then the selected case's value for a bound
variable. That projection accepts no run-override parameter at all, which makes
the exclusion of transient composer values structural rather than a convention
each caller has to remember.

A prompt's recommended target is advisory. It records what a template was
authored against and is reported when it disagrees with the evaluation's model,
or when two pinned prompts recommend different models — a disagreement no single
target can settle, since a provider call carries one model. It never selects or
overrides the target.
