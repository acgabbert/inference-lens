# Completed plans and historical design records

Archived October 27, 2026 after a source and delivery-record sweep of `main`
at `eedbbb0`. These documents preserve decisions, implementation stages and
the checks reported when the work landed. No historical checks were rerun for
the sweep. Start with the [documentation guide](../README.md) for current
contracts and plans with open work.

| Record | Why archived / current reference |
| --- | --- |
| [Page composition root](PAGE_COMPOSITION_ROOT_EXECUTION_PLAN.md) | Explicitly closed October 8 by PR 5. The current ownership map is in [Architecture](../ARCHITECTURE.md). |
| [Parallel experiment cells](PARALLEL_EXPERIMENT_DESIGN.md) | All six slices implemented, including concurrency controls, rate-limit classification and retries. See [experiment artifacts](../EXPERIMENT_ARTIFACTS.md) and [CLI usage](../DOCKER.md). Earlier slice notes retain intermediate class names and pending work subsequently completed. |
| [Headless CLI](HEADLESS_CLI_DESIGN.md) | Slices 1–4, selection/repeat follow-ups 5a/5b and decision-suite CLI support implemented. [Docker and CLI usage](../DOCKER.md) is the operational guide. Optional host/npm distribution remains deferred; it is not a shipped feature. |
| [System One saved prompts](SYSTEM_ONE_SAVED_PROMPTS_PLAN.md) | All four slices implemented, including evaluation and retargeting. See the [authoring guide](../SYSTEM_ONE_SAVED_PROMPTS.md) and [contracts](../SYSTEM_ONE_SAVED_PROMPTS_CONTRACTS.md). Hosted-provider, native-app and packaged-Docker checks were not established by the final slice. |
| [Several server-held connections](SERVER_CONNECTIONS_DESIGN.md) | Server, browser, docs and templates delivered. CLI catalog support was explicitly excluded by accepted decision 9-A. See the [Docker guide](../DOCKER.md). |
| [M3 interactive MCP execution](MCP_M3_EXECUTION_DESIGN.md) | Implemented and accepted. M4 supersedes its service-session consent design with browser-local grants and per-call checks. See [tool execution](../TOOL_EXECUTION.md). |
| [M4 batch MCP execution](MCP_M4_BATCH_DESIGN.md) | Implemented, including the documented Start-time preflight deviation. Broader n8n compatibility and remote/authenticated/native execution remain outside this completed slice; see the [parent plan](../N8N_MCP_TOOL_COMPATIBILITY_PLAN.md). |
| [MCP SDK interoperability spike](MCP_SDK_INTEROPERABILITY_DECISION.md) | Completed M1 investigation used by implemented M2–M4. Its original n8n comparison gate is tracked in the [parent plan](../N8N_MCP_TOOL_COMPATIBILITY_PLAN.md). |
| [JSON Schema external-engine comparison](JSON_SCHEMA_ENGINE_SPIKE.md) | Completed investigation; the metered evaluator supersedes its worker-first recommendation. This is not the production-engine contract. |
| [Metered JSON Schema feasibility](METERED_JSON_SCHEMA_SPIKE.md) | Completed isolated prototype, followed by production integration under the [structured-output plan](../STRUCTURED_OUTPUT_CHECKS_PLAN.md). See [deterministic checks](../DETERMINISTIC_CHECKS.md), [preflight](../JSON_SCHEMA_PREFLIGHT.md) and [calibration](../JSON_SCHEMA_CALIBRATION.md) for the shipped contract. |
| [Protected recovery store](SHARED_ASSETS_RECOVERY_STORE_SLICE.md) | Approved bounded storage foundation implemented. The application does not automatically open or recover it; follow-on work belongs to the [Level 2 design](../SHARED_ASSETS_LEVEL_TWO_DESIGN.md). |
| [Migration journal and staging](SHARED_ASSETS_MIGRATION_JOURNAL_DESIGN.md) | Approved staging and read-only restart classification implemented. Manifest replacement and candidate activation remain a separate [completion proposal](../SHARED_ASSETS_MIGRATION_COMPLETION_DESIGN.md); app/CLI remain v15. |

An archived design may still explain an active API. Its original approval and
verification limits apply; moving it here does not enable deferred behavior or
make a superseded contract current again.
