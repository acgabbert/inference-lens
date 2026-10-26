# Saved decision prompts

Prompts holds both chat prompts and whole decision requests in the open project.
Use All, Chat, or Decision to filter the library, or search by name. Decision
entries show their question and variable counts. Opening a prompt does not
change the connection or model used by Compose.

## Author and save

Choose **New decision prompt** to author state and questions in the same Form
and JSON views as Decision Compose. Variables may appear in state string values
and question instructions. Optional defaults supply reusable values; removing a
default leaves that variable unfilled, while an explicitly empty default is a
supplied value. Secret-like names cannot receive defaults or request values.

From Decision Compose, **Save as decision prompt** captures the authored request
and its current values without substituting tokens. It opens a session draft in
Prompts. Review its variable defaults, remove values that should remain specific
to the current request, and choose **Save to project**. Capture does not change
the current decision request into a template use.

Authoring works without a System One connection. Before a project exists, a
prompt remains a session draft. Saving it uses the existing project-creation
requirements: a valid chat endpoint and model. Session drafts disappear when
the page closes unless they have been saved to a project.

Edits to a project prompt retain the last valid draft in the project. Invalid
JSON and other incomplete edits remain only in the current session and are
labeled separately. Switching prompts, revisions, or app modes retains these
edits during the session. Choose Draft in the revision menu to return to them.
**Create revision** checkpoints valid content and defaults. Revision history and
diffs include state, questions, instructions, criteria and their order, and
defaults. Historical revisions can be copied with **Edit as new revision**.

## Use a saved revision

Choose **Use Current** or a historical revision's **Use Revision …** action.
For an edited draft, **Save and use revision** checkpoints it first. Compose
preserves the preceding valid request and creates a separate request pinned to
the selected source revision. Replacing an incomplete Compose request requires
an explicit discard choice; cancelling leaves the edits available.

Pinned content is read-only. Fill variables in Compose and choose a System One
connection and decision model to run. Request values override pinned defaults;
missing assignments block execution. Recommended targets remain advisory.

**Edit source** opens the pinned revision in Prompts. **Back to request** returns
to the same request revision. Creating a newer source revision leaves existing
requests, suites, and saved runs pinned to their original content.

**Update to latest revision…** shows the decision and default changes before
committing. Surviving request overrides are retained, obsolete overrides are
removed, and newly unfilled variables block the next run. Updating appends a
child request revision.

**Detach** appends an inline child with the authored variable tokens and current
effective values. It preserves unfilled assignments and makes content editable.
It does not replace tokens permanently with rendered values.

Archiving removes a prompt from new-use choices while preserving existing
references. Archived entries can be restored from the library's Archived view.

## Evaluate a saved revision

Choose **Evaluate in a suite…** on a saved current or historical revision.
Create a revision first when the editor has unsaved content changes. Session
drafts and archived prompts cannot start new evaluations.

**Create new suite** makes a separate template-backed decision request and a
suite pinned to it. Compose keeps its active request, values, incomplete draft,
and displayed result. No provider call happens during creation. The new suite
starts with the project's default connection and model and System One protocol;
choose the decision connection and model in Setup, map that connection to a local
System One profile if needed, then add case inputs, cases and checks. A prompt's
recommended target does not change the suite target automatically.

The dialog also lists suites whose request pins the same decision prompt.
**Open** navigates to a suite already pinned to the selected revision. For a
different revision, **Review …** shows removed and added variables and questions,
changed question types, incompatible checks, and missing assignments across all
cases. Expand **Revision changes** to inspect state, instructions, criteria
ordering and defaults. Cancel leaves the suite unchanged.

**Retarget suite** creates a child request revision and moves only that suite's
pin. It keeps configurations, target, bindings, cases, values and checks for
explicit repair. Surviving request overrides remain, including empty strings;
overrides for variables removed from the prompt leave the new request revision.
Preflight blocks execution until incompatible inputs or checks are repaired.
Historical revisions can be selected deliberately in the same workflow. Existing
requests, other suites, experiment plans, results and traces keep their original
inputs.

The folder-backed CLI runs these suites with the same resolver and value
precedence: pinned defaults, request overrides, then case values. No new CLI
flags or artifact formats are required. See the [CLI guide](DOCKER.md#run-an-evaluation-suite-from-the-command-line).
