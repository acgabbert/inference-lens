# Evaluation suite authoring

Evaluation suites are portable Project v15 content. The **Evaluations** workspace
owns suite, input, case, and deterministic-check editing. Chat suites pin a
conversation revision; System One decision suites pin a decision request
revision. See [Saved decision prompts](SYSTEM_ONE_SAVED_PROMPTS.md) for decision
suite creation, variables and retargeting. The chat-specific input and tool
details below describe conversation suites.

A suite owns its input: the selected conversation revision is persisted as the
suite's `input`, so Messages and the evaluation can point at different revisions
and neither one moves the other. Input columns bind stable template-use IDs to
variable names, and preflight reports when the suite's revision no longer
contains a bound use or variable. Empty suites remain valid authored state but
cannot execute.

A suite owns one base execution configuration and one or more named,
portable **Configurations**. A configuration stores only sparse overrides for
connection requirement, model, protocol, delivery mode, and inference options; absent
fields inherit from the base, while `null` explicitly clears an optional
inference option to use the provider default. A configuration's
`providerOptions` replaces the base object rather than deep-merging it.
Repetitions, exposed tools, and turn ceiling remain shared across every
configuration. Changing the evaluation's model, protocol or temperature therefore
never edits the composer's — nor does changing the composer's edit a suite's —
and a suite reproduces the same batch wherever the project is opened. Only the
device-local runtime target (profile, endpoint, capabilities) is supplied from
outside; see
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
calls. A suite that exposes tools shows a range instead: one provider call per
repetition, up to its turn ceiling if every repetition keeps calling tools. The
25 / 100 / 1,000-call thresholds are applied to that worst case, because it is
the number a confirmed batch may actually bill. Case values, reference answers, and execution settings are stored in
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

The focused case shows the exact provider input an execution would snapshot.
The **Evaluations** workspace keeps the editor beside an optional **Provider
input** preview that follows the focused case. **Hide provider input** releases
space to the editor; **Show provider input** restores it without discarding
edits. Preview starts hidden at widths up to 1100px unless the user has chosen
otherwise. Layout state belongs to the evaluation workspace and survives mode
changes; it is not portable project content.

Live and reopened results are inspected in **Runs**. Browsing that evidence
does not replace the Compose draft or change the suite's authored input.

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
   mode, every populated inference option, and the tools the suite exposes
   (`None` when it exposes none; a tool selected in Messages neither travels
   with the plan nor blocks the run either way).

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

## Exposing tools

A suite's **Tools** block lists every tool the project defines and checks the
ones this suite exposes. Exposure is portable: it names project tool IDs, so a
teammate who opens the project sees the same suite exposing the same tools. What
*serves* each one is device-local — an enabled project mock or a command-tool
grant on this machine — and the block shows that join beside each checked tool
(`get_weather → mock "sunny default"`), without ever storing it.

An evaluation answers its own tool calls, exactly as a repeated experiment does:
nobody is watching a batch call by call, so a repetition never pauses for a
person. Two consequences follow, and both are stated before anything is spent:

- A tool nothing on this device can serve is a **setup issue**, counted in
  preflight and repeated on the Start button. The suite is authored correctly;
  this machine cannot run it. Command tools do not exist in a bare browser or in
  the desktop build, and the same sentence the tools pane uses is appended here.
- A repetition may spend more than one provider call. The **turn ceiling**
  bounds it: a repetition still holding tool calls at the ceiling is failed with
  a `tool_error`, which fails only that repetition, and the cost thresholds are
  applied to `cases × repetitions × ceiling`.

The start confirmation lists each exposed tool and what will serve it. That
listing is the last point at which a stale grant can be noticed, because a
granted command executes without asking again once a batch is running.

## Reviewing past executions

A finished evaluation is written to the project folder as an immutable plan, a
result, and one trace per repetition. Those artifacts stay readable after the
session ends, and there are two ways back to them.

**Past executions**, in the suite editor, lists the saved executions of the
suite being authored. It is collapsed until asked for: building the listing
costs a full parse of every artifact in the project folder, so opening a project
does not pay for a list nobody has opened. Expanding it loads the listing once
and caches it; **Refresh** re-reads the folder.

Membership is by suite identity, not by input revision. An execution recorded
against an older revision of the suite's input is still that suite's evidence
and stays listed, marked *Ran against a different input revision*. This is
deliberate: a pass rate that moved because the prompt changed is a different
finding from one that moved on its own, and hiding the older run would hide the
comparison.

**Runs** is the whole-project view: ordinary runs, repeated experiments, and
evaluations across every suite, newest first, filterable by kind. **Run data →
Run history** opens the same workspace rather than a separate history drawer.

Both surfaces summarize an evaluation by its strict pass rate — `1/2 cases
passed` — rather than by run status. The distinction matters: a repetition that
completed and then failed its checks is a completed *run* and a failed *case*.
Run-status counts (`4 completed · 1 failed`) stay with repeated experiments,
where they are the outcome rather than a step on the way to one. An execution
that decided nothing, because it was interrupted before its cases could be
scored, is reported neutrally rather than as a failure.

Opening an execution from either surface reaches the same **As run** results
workspace, scored by the same aggregate. A suite edited since a run does not
change that run's saved outcome.
