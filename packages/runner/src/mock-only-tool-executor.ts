import { createMockToolExecutor } from "../../core/src/mock-tool-executor.ts";
import type { ToolBinding, ToolExecutor } from "../../core/src/tool-execution.ts";

/**
 * The executor factory for a host that can serve project mocks and nothing
 * else. A command or MCP binding reaching it is a host bug, not a tool failure:
 * the host should have refused that binding before the plan was saved.
 */
export function createMockOnlyToolExecutor(binding: ToolBinding): ToolExecutor {
  if (binding.kind === "mock") return createMockToolExecutor(binding);
  throw new Error(`This host cannot run ${binding.kind} tools.`);
}
