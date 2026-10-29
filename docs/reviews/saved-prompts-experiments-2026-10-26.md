# Saved prompts and experiment UX review — October 26, 2026

Reviewed checkout: `309f180`. This is an assessment with browser evidence; no application behavior changed. The committed artifacts are this review and the composite-workflow browser test; screenshots remain generated test artifacts.

## Answer to the requested setup

Yes, an evaluation suite can save a request containing multiple pinned saved-prompt revisions and multiple named combinations of template values. A suite has one conversation revision; that conversation can contain several prompt uses, each pinned to its own exact prompt revision. Cases supply different values for variables in those uses.

That is different from selecting several alternative prompt revisions and automatically comparing all of them against the same cases. The current execution grid is **cases × execution configurations × repetitions**. Configurations vary connection, model, protocol, delivery, and inference options; they do not vary prompt revisions. A prompt-revision comparison currently means running the suite, changing its pinned input, and running it again. Saved executions and baselines support comparing those separate runs.

| Requested capability | Current support | Practical qualification |
| --- | --- | --- |
| One specific saved prompt revision | Yes | Prompts → choose revision → Evaluate in a suite. |
| Several saved prompts in one request | Yes | Compose them in Messages, then create/select a suite using that conversation revision. |
| Several named variable combinations | Yes | Each combination is a case. Inputs must first be mapped to individual prompt-use variables. |
| Reuse those combinations with a newer revision | Yes | Retarget the existing suite through the prompt library or its “Use current … revision” action. Unchanged variable names retain their mappings. |
| Run revision A and B as alternatives in one batch | No | There is no prompt-revision dimension in configurations. |
| Generate every combination from lists of possible values | No authoring control found | Cases are entered individually; there is no combination generator. |
| Run combinations without automated scoring | No | Each selected case requires at least one deterministic check. |
| Persist the reusable setup | Yes | Suites, pins, cases, checks, and settings are project data. Save to a project folder for autosave, or export a JSON copy for later import. |
| Persist execution evidence | Yes, with a project folder | Plans, traces, and results are separate folder artifacts. Session evaluations are explicitly temporary. Exporting project JSON is not an execution archive. |

The new browser characterization test authors two cases across a system prompt and an older user-prompt revision, exports/reimports the project, and retargets the user prompt to its newer revision. The system prompt and both combinations remain intact. It checks the serialized pins and case values and the resolved messages on screen. It does not execute that composite suite against a provider.

## How to do it now

For a single prompt, open **Prompts**, choose the exact revision, and use **Evaluate in a suite…**. Create a new suite the first time; choose the existing suite when testing a different revision with the same cases. If the editor contains a changed draft, create its revision first (see finding 1).

For a composed request, insert the desired saved prompts and revisions in **Compose**, in the intended order. Create a chat suite in **Evaluations** from that saved conversation, or select the intended conversation under **Existing project revision**. A suite pins its own input; subsequent Compose changes do not automatically update it.

Under **Prompt variables**, add each variable that should vary as a case input. Under **Cases**, add and name each combination, fill its values, and add the required checks. Use **Provider input** to inspect the exact messages and each value's source. Save the project to a folder before running if execution history should survive the session.

To compare revisions, retain the same suite and case/check identities. Run the first revision, pin an execution configuration as a baseline under **Past executions**, retarget the suite, then run and compare. Creating an unrelated new suite recreates case identities and is a poor substitute for this workflow.

## Findings, ordered by priority

### 1. Evaluating an edited draft uses the saved revision without explaining that choice

**Browser reproduced.** I edited Question to `DRAFT CHANGE: contrast {{topic}}.`, clicked **Evaluate in a suite…**, and created a suite. Its resolved input was `Explain networks with examples.`—the previously saved content. The dialog did not mention the draft. The handler explicitly selects `viewedRevision.id` even while the editable draft differs.

This is the most consequential issue: someone can believe they are testing their edit while testing the old prompt. “Draft autosaved” and “Create revision” are defensible distinct states, but the evaluation handoff must make that distinction visible.

Recommendation: when the draft differs, offer **Create revision and evaluate** and **Evaluate saved Revision N** with the actual revision name. Always identify the selected prompt and revision in the dialog, including when no compatible suites exist.

Reproduction: open a saved chat prompt, change its draft text without creating a revision, choose **Evaluate in a suite… → Create new suite**, add a case and fill its variables, then inspect **Provider input**. The resolved messages use the saved revision. Source: [evaluation handler](../../app/templates/chat-prompt-template-editor.client.tsx#L550). The temporary characterization test reproduced this during the review but was removed before committing so the suite does not require the undesirable behavior.

### 2. Similar prompt actions have materially different effects

**Browser checked and source confirmed.** Compose's **Insert saved prompt…** supports search, exact revision, position, and preview. Evaluations' **Start from prompt…** selects one active prompt's current revision and replaces the entire evaluation input. The library's **Evaluate in a suite…** can select history and retarget an existing use while retaining its surrounding conversation and dataset.

Using “Start from prompt” twice does not compose two prompts. Its warning says existing bindings may break and tells the user to “rebind”; the editor supplies remove/add controls, not a direct remapping workflow. Removing a binding deletes its values across every case, with a confirmation, so repair can require copying/re-entering data.

Recommendation: share prompt/revision selection across these entry points, while making the operation explicit: **Add prompt**, **Change pinned revision**, or **Replace evaluation input**. Provide a remapping review that preserves case values rather than requiring column deletion. A revision change should show variable/default changes before committing, as Compose already does.

Evidence: `evaluation-saved-prompt-preflight.spec.ts`; [picker](../../app/evaluations/saved-prompt-dialog.client.tsx), [mapping UI](../../app/evaluations/chat-suite-setup.client.tsx), [binding deletion](../../packages/core/src/evaluation-suite-authoring.ts).

### 3. Saved combinations exist, but authoring them is laborious

**Browser checked; missing controls confirmed in the editor.** A user must map variables in Setup before filling them in Cases. Each case then has its own form and checks. There is no duplicate-case action, spreadsheet-style case grid, case CSV import, or automatic combination generator in this authoring surface. There is trace-to-case promotion, which helps reuse existing evidence but does not replace those bulk authoring actions.

For a few cases this is workable. For a prompt with several variables and dozens of combinations it is repetitive and hard to compare. The large Setup band, case list, case form, and provider preview also divide the viewport into several scrolling regions.

Recommendation: offer discovered variables as columns, with an explicit choice between varying a value by case and retaining its default. Add duplicate case first, then a table with paste/import and optional generated combinations. Keep a full editor for long values and per-case checks.

Evidence: [composite-workflow browser test](../../tests/e2e/saved-prompt-experiment-review.spec.ts), [case editor](../../app/evaluations/evaluation-suite-editor.client.tsx). The test generates screenshots in Playwright’s output directory when run.

### 4. Exploratory experiments are forced into scored evaluations

**Browser reproduced.** After filling a valid case, the start gate says it needs at least one deterministic check. “Repeated experiment” offers a different route, but repeats one frozen request; it does not run a saved collection of different inputs.

Recommendation: consider an explicit unscored batch mode. Results should say **Unscored**, and should never imply a pass. This changes the evaluation/result contract and needs a design decision before implementation; it is not merely removing a validation message.

Reproduction: add a case, fill its mapped variables, and leave its checks empty; preflight refuses to start. Source: [preflight validation](../../packages/core/src/evaluation-suites.ts#L334).

### 5. Revision comparisons require manually coordinating separate executions

**Contract verified; existing baseline browser tests passed.** A suite owns one input revision and configurations contain execution overrides only. Historical runs and baseline comparisons already provide valuable evidence, including execution drift and missing traces, but the user must connect those steps.

Recommendation: first add a guided **Compare another revision** action that retains cases and checks and explains what changes. A later explicit revision dimension could run `prompt variants × cases × execution configurations × repetitions`; that is a substantive model extension. For composed prompts, a variant must identify the whole composition or the specific use being varied. Do not overload a list of prompt uses to mean alternative experiments.

Evidence: [suite types](../../packages/core/src/evaluation-suites.ts), [plan types](../../packages/core/src/experiment.ts), `evaluation-baseline-comparison.spec.ts`.

### 6. Revision identity and value ownership still require too much interpretation

**Observed in the running UI and confirmed in source.** A conversation can be labeled “Current” while one of its prompts is pinned to an earlier prompt revision. Evaluation provenance says “earlier prompt revision” without the same prominent named revision selector available in Compose. Users must distinguish prompt defaults, values saved on a conversation's prompt use, run-only overrides, and evaluation case values.

Compose's **Save to project** on a variable saves that use's value; it does not create a named reusable combination. A new evaluation does not inherit Compose's session-only overrides. Evaluation case values take precedence over saved use values and prompt defaults. Once a variable is mapped, empty case values are treated as unfinished; they do not mean “use the default.”

Recommendation: display exact per-prompt revision names throughout evaluation setup and history, clarify “current conversation” versus “latest prompt,” and expose value source consistently. Offer **Save these values as a case** or **Add current request as a case** as an explicit handoff, building on trace promotion where appropriate.

### 7. Saving is more explicit now, but the objects still feel disconnected

The project banner and start confirmation correctly distinguish session-only and folder-backed state. Prompt drafts, immutable revisions, suite definitions, and execution evidence still have different lifecycles. An imported project JSON can contain complete saved definitions while its current session remains non-durable. Baseline controls depend on a project folder.

Recommendation: put a concise setup/evidence storage summary near the suite identity and offer a direct save-to-folder action there. Explain JSON export as a reusable setup export, and project-folder storage as the place for execution evidence. Preserve the existing failure/status feedback rather than adding a competing save mechanism.

## What is already working well

Exact revision pinning and frozen execution plans provide a strong reproducibility foundation. Compose's revision selector and summarized change review are useful improvements. Provider input shows the resolved conversation and whether values come from a case, saved use, or prompt default. Preflight prevents missing values and incompatible mappings from silently becoming provider calls. Suite history and baseline comparison preserve old evidence after a suite's input changes.

My assessment is **capable once learned, but fragmented for someone organizing experiments**. The most useful first work is fixing the draft handoff, making add/change/replace actions explicit, and making cases easier to author. A revision matrix should follow as a separately agreed feature.

## Verification and limits

- Initial focused run: 34 passing browser tests across `evaluation-saved-prompt-preflight`, `evaluation-prompt-retarget`, `evaluation-suite-authoring`, `evaluation-multi-mapping`, `prompt-insertion-handoff`, `template-revision-switch`, `saved-prompt-revision-diff`, `evaluation-suite-history`, and `project-storage-clarity`.
- Baseline comparison: all 3 tests passed.
- During the review, both the composite-workflow test and a temporary draft-behavior characterization passed. Only the composite-workflow test is retained in `saved-prompt-experiment-review.spec.ts`. An earlier run failed because the test assumed JSON object-key order; that assertion was corrected to read values by binding identity. That was a test error, not an application regression.
- `npm run typecheck`: passed.
- Before commit cleanup, the full browser suite, `npm run test:e2e`: **360 passed, 7 skipped (1.9 minutes)**. The skipped tests are the opt-in N1 and Python MCP lanes listed by the default configuration. The runner did not report a Chromium fallback. Some existing specs emitted hydration mismatch warnings involving the Project menu's `open` attribute; all assertions passed, but the run was not console-clean.
- After removing the temporary draft-behavior test and screenshot copies, `npm run test:e2e -- tests/e2e/saved-prompt-experiment-review.spec.ts`: **1 passed**; `npm run typecheck`: passed again. All local file links in this review resolve. The full browser suite was not repeated for this documentation/test-removal cleanup.

The retained test covers the supported composite workflow. The draft mismatch remains a documented finding, not a test requirement. No fix has been implemented. Provider execution coverage comes from the existing fixture-backed specs; the new composite flow checks authoring, serialized persistence, and resolved previews. Browser storage tests use the shared in-memory folder adapter. Native OS folder permissions, real provider responses, and a large real-world library were not manually exercised. The unit/build suites were not run for this review; application source was unchanged.

For the user's own review, the most useful question is whether the intended primary workflow is composing several prompts into one request or comparing alternative revisions. Both deserve clear entry points, but they require different controls and contracts.
