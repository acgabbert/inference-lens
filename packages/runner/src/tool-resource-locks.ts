import type { ToolBindingConfig } from "../../core/src/tool-execution.ts";

/**
 * The stateful resource a binding reaches, or none for a pure mock. Two tools
 * can reach one MCP server or one declared command, so the lock is the
 * resource's, not the binding's.
 */
export function toolResourceKey(binding: ToolBindingConfig): string | undefined {
  switch (binding.kind) {
    case "mcp":
      return `mcp:${binding.serverId}`;
    case "command":
      return `command:${binding.executorId}`;
    case "mock":
      return undefined;
  }
}

/** One holder at a time per key, served in the order they asked. */
export class ToolResourceLocks {
  private readonly tails = new Map<string, Promise<void>>();

  /** Resolves with a release function once the caller holds `key`. */
  async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => held);
    this.tails.set(key, tail);
    await previous;
    return () => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}
