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
