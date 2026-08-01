# Evaluation suite authoring

Evaluation suites are portable Project v7 content. The **Evaluations** tab in
the Request pane owns suite, input, case, and deterministic-check editing. Its
focus-mode control expands the same live editor to the full application surface.

Authoring selects a conversation revision, but the suite does not persist that
selection. Input columns bind stable template-use IDs to variable names, and
preflight reports when the selected revision no longer contains a bound use or
variable. Empty suites remain valid authored state but cannot execute.

The case grid previews `selected cases × repetitions` without making provider
calls. Execution and result artifacts remain a PR10 concern. Case values and
reference answers are stored in `project.json`; the UI warns authors not to put
credentials or secrets into this portable data.

Suite, binding, case, and check additions always mint new identities. Check IDs
are unique across the entire project, including when future duplicate actions
copy authored checks.
