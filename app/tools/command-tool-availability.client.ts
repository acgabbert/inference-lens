import type { CommandToolsHandle } from "./use-command-tools.client.ts";

/**
 * Why this device cannot run command tools, in one sentence, or nothing when it
 * can.
 *
 * Shared rather than restated per surface. T1b settled the three-shell matrix —
 * a bare browser and the desktop build cannot spawn — and every later surface
 * that depends on it inherits the statement instead of re-deciding it. A batch
 * that exposes a command-bound tool is refused with the same words the tools
 * pane uses, so the reason a tool cannot be bound and the reason a batch cannot
 * start never drift apart.
 */
export function commandToolUnavailableMessage(
  commandTools: CommandToolsHandle,
): string | undefined {
  const { availability } = commandTools;
  switch (availability.kind) {
    case "loading":
      return "Checking what this device can run…";
    case "unsupported-shell":
      return "The desktop app cannot run command tools yet. They are spawned by the local Inference Lens service, which the desktop build does not have.";
    case "unconfigured":
      return `This service runs no command tools. Set ${availability.variable} to a command catalog to declare some.`;
    case "invalid":
      return availability.problem;
    case "unreachable":
      return `The local service could not be asked what it can run: ${availability.message}`;
    case "ready":
      return undefined;
  }
}
