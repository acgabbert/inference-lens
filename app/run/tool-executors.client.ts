"use client";

import { createMockToolExecutor } from "../../packages/core/src/mock-tool-executor.ts";
import type {
  ToolBinding,
  ToolExecutor,
} from "../../packages/core/src/tool-execution.ts";
import { createCommandToolExecutor } from "../tools/command-tool-executor.client.ts";

/**
 * Binding kind to executor, in one place.
 *
 * The run session asks for "the executor for this binding" and learns nothing
 * else about it — which is the property that has to hold for MCP to arrive as
 * a third case here rather than as a change to the session.
 */
export function createToolExecutor(binding: ToolBinding): ToolExecutor {
  switch (binding.kind) {
    case "mock":
      return createMockToolExecutor(binding);
    case "command":
      return createCommandToolExecutor(binding);
  }
}
