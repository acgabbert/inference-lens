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
