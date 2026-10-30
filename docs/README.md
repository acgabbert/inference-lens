# Documentation guide

Plan status reviewed October 27, 2026 against `main` at `eedbbb0`. This sweep
checked source, committed tests and delivery records; it did not rerun the
historical verification commands quoted in those records.

## Current guides and contracts

- [Architecture and ownership](ARCHITECTURE.md)
- [Project format and compatibility](PROJECT_FORMAT.md),
  [run traces](RUN_TRACE_FORMAT.md), and [experiment artifacts](EXPERIMENT_ARTIFACTS.md)
- [Saved decision prompts](SYSTEM_ONE_SAVED_PROMPTS.md) and their
  [implementation contracts](SYSTEM_ONE_SAVED_PROMPTS_CONTRACTS.md)
- [Evaluation suite authoring](EVALUATION_SUITE_AUTHORING.md) and
  [deterministic checks](DETERMINISTIC_CHECKS.md)
- [Tool registry](TOOL_REGISTRY.md), [tool execution](TOOL_EXECUTION.md),
  [command tools](COMMAND_TOOLS.md), and [MCP discovery](MCP_DISCOVERY.md)
- [Docker and CLI usage](DOCKER.md), [releasing](RELEASING.md), and
  [local MCP tryout](MCP_LOCAL_TRYOUT.md)
- [Provider fixtures](PROVIDER_FIXTURES.md) and [browser test mechanics](../tests/e2e/README.md)

## Plans with open work

| Plan | Delivered | Still open or deferred |
| --- | --- | --- |
| [Tab coordination](PROJECT_TAB_COORDINATION_PLAN.md) | Implemented in the browser; desktop unaffected. | One manifest editor per project across browser tabs; prerequisite for run links. Records the approved role, takeover and shared write-scope contracts. |
| [Durable run links](RUN_DEEP_LINKS_PLAN.md) | Browser implementation; desktop adapter deferred. | Approved contracts, implementation boundaries and verification limits. See [Using saved run links](RUN_LINKS.md) for Copy link, folder recovery and tab handoff. |
| [Shared assets / personal workbench](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md) | Level 1 Git policy; isolated Level 2 codecs/planner, recovery store and migration staging. | App/CLI still use v15. Publication, application recovery, scratch/request arms, launch-default actions and later asset kinds remain. External prompts E1 implemented: reviewed file import, receipts, literal escaping and n8n copy; E2 mapping continuity designed. E1 file receipts are Project v17, and re-importing a filename warns. E2 implemented: Update from file appends a reviewed pull as current with stable variable names, keeping drafts and pins, on v17. E3 implemented: prompts link to files in operator-declared server folders (`INFERENCE_LENS_SOURCE_ROOTS`), with drift and Pull, as Project v18. E4 implemented: `run --prompts-from-files` and `--source-root` run linked prompts from their files for one run, recorded in RunTrace v10 and ExperimentPlan v7, and `drift` reports each file for CI. |
| [Level 2 ownership and migration](SHARED_ASSETS_LEVEL_TWO_DESIGN.md) | Bounded core and filesystem foundations. | Remaining integration contracts still need review. The staged format is v19 (renumbered October 30). This is not approval to enable it in the app. |
| [Migration completion](SHARED_ASSETS_MIGRATION_COMPLETION_DESIGN.md) | Approved October 28; core and browser adapter implemented. | Native command and its Git check remain. No application caller. |
| [System One protocol](SYSTEM_ONE_PROTOCOL_PLAN.md) | Phases 1–5, including decision suites and CLI execution. | Direct TypeSafe captures, additional error-body evidence and native-app verification remain open. See the phase-specific coverage limits. |
| [Structured-output checks](STRUCTURED_OUTPUT_CHECKS_PLAN.md) | Vocabulary v4, calibrated evaluator, authoring, diagnostics, scheduling and CLI/browser-history agreement. | Native Tauri interaction/evaluator execution, slower-hardware timing and broader runtime integration coverage remain unverified. Earlier progress sections describe intermediate states. |
| [n8n / MCP compatibility](N8N_MCP_TOOL_COMPATIBILITY_PLAN.md) | N0, M1–M4 and one reviewed N1 string-input comparison. | Expanded N1 comparison and a bounded compatibility decision; Phase 6 hardening, authenticated/remote MCP and Tauri execution remain deferred. |
| [Local MCP mocks from n8n tools](N8N_LOCAL_MCP_SCAFFOLD_PLAN.md) | Proposal; schema-profile and argument-rejection decisions approved October 29. | Remaining §9 decisions need approval; no implementation or SDK spike yet. |
| [Final-output tools](N8N_FINAL_OUTPUT_TOOL_PLAN.md) | Capture phase complete; twelve policy recommendations accepted; gate items and [implementation contracts](FINAL_OUTPUT_CONTRACTS.md) approved October 29. | Contracts approved (Project v19, RunTrace v11, ExperimentPlan v8, after environments took v16/v9/v6, file imports Project v17, linked prompt sources Project v18 and CLI file runs RunTrace v10/ExperimentPlan v7); one n8n capture remains open for the parity claim; no runtime implementation. PR 2 is next. |
| [Prompt environments](PROMPT_ENVIRONMENTS_PLAN.md) | Decision table, limits and format versions accepted (Project v16, RunTrace v9 and ExperimentPlan v6 when this lands; the app still uses Project v15 and RunTrace v8; staged shared format is v19 and carries environments, then becomes v20 with final output). Sequenced before sub-agent routing. | Contract slice accepted and core landed October 29 (Project v16, RunTrace v9, ExperimentPlan v6, evaluation plans per environment, CLI repeat). App slice implemented: composer selector, editor drawer, value sources on template uses, readiness, history labels. Next: evaluation suite and variant fields, and run comparison by environment. Run-time state writes are out of scope. |
| [Request-backed sub-agent routing](REQUEST_SUBAGENT_ROUTING_PLAN.md) | Code-informed effort estimate and proposed scope only. | Contract review, bounded execution spike, interactive routing and child traces; child tools and batch/CLI support are optional follow-ups. |
| [Layout and flow](UI_LAYOUT_AND_FLOW_PLAN.md) | Dedicated Prompts, Runs browsing/inspection and optional evaluation preview. | Remaining keyboard/overlay, collection-scale and usability validation; mobile redesign is deferred. |
| [UX simplification and discoverability](UX_DISCOVERABILITY_PLAN.md) | Proposal refreshed October 28. Duplicate tool controls consolidated (#224); saved-prompt picker landed. | Ranked slices A–L: composer header, transcript actions, branch notice, session run history, model picker, Run data/Repeat, prompt cards, Prompts sidebar, command search. No slice is authorized by the document. |

[The N1 matrix runbook](N1_MATRIX_RUNBOOK.md) supports the open compatibility
work. A capture or passing harness is not a reviewed comparison or a general
compatibility claim. [Final-output capture findings](N8N_FINAL_OUTPUT_CAPTURE_FINDINGS.md)
similarly record evidence rather than runtime delivery.

## Completed and historical work

Completed implementation plans and bounded investigation/design records live
in [archive/](archive/README.md). Archiving closes only their stated scope;
their limitations and deferred follow-ups remain recorded there and, where
applicable, in the active parent plan above.

[Reviews](reviews/) preserve dated findings and screenshots. They are evidence
about their recorded baselines, not an up-to-date defect backlog. In particular,
the September UI reviews predate the dedicated Prompts and Runs workspaces,
and the project-template review predates the completed composition-root work.
Use the active plans and current source to assess whether an old finding still
applies. The [October 26 saved-prompt/experiment review](reviews/saved-prompts-experiments-2026-10-26.md)
is also a dated review rather than a new implementation commitment.

Schema evaluator measurements, calibration, preflight and safe-regex records
remain beside the current guides because they document supported behavior,
limits or reproducible probes. Their dated measurements do not establish
coverage on untested runtimes.
