# Evaluation suite authoring

Evaluation suites are portable Project v7 content. The **Evaluations** tab in
the Request pane owns suite, input, case, and deterministic-check editing. Its
focus-mode control expands the same live editor to the full application surface.

Authoring selects a conversation revision, but the suite does not persist that
selection. Input columns bind stable template-use IDs to variable names, and
preflight reports when the selected revision no longer contains a bound use or
variable. Empty suites remain valid authored state but cannot execute.

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
calls. Repetitions is likewise session state: whether an authored suite pins its
own repetition count belongs with the execution-plan schema in PR10. Execution
and result artifacts remain a PR10 concern. Case values and reference answers
are stored in `project.json`; the UI warns authors not to put credentials or
secrets into this portable data.

Every check kind in `CHECK_KINDS` must have a default definition the project
parser accepts, because adding a check revalidates the whole project: a default
the parser rejects makes that kind unreachable from the editor rather than
merely unfinished. Empty text values are legal and preflight reports them; an
empty Safe regex pattern is not, so that default is the placeholder `.`.

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

**Start from saved prompt…** authors a prompt-only revision from an active saved
prompt and selects it, so an evaluation can start from a template that no
conversation uses yet. Archived templates are excluded, since project policy
already forbids adding them to a conversation. The portable shape this writes is
documented in [the project format](PROJECT_FORMAT.md#starting-an-evaluation-from-a-saved-prompt).

## Exact focused-case preflight

The focused case shows the exact provider input an execution would snapshot, in
four regions:

1. **Revision provenance** — the same projected description the selector and the
   start confirmation use, which prompts are pinned and at which immutable
   template revision, and the stable IDs in a details disclosure.
2. **Resolved values** — one row per template variable with its effective value
   and its source: case value, authored use value, or template default. A
   variable no level supplies stays visible as a setup error rather than a blank,
   and a case input the revision cannot satisfy gets its own row instead of
   being silently dropped.
3. **Resolved conversation** — the exact ordered roles and rendered text.
4. **Execution settings** — connection, endpoint, protocol, model, delivery
   mode, every populated inference option, and tools (`None`, since evaluations
   refuse to start while tools are selected).

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
