"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { TOOL_COMMANDS_API_PATH } from "../../packages/contracts/src/index.ts";
import type { CommandToolCatalogResponse } from "../../packages/contracts/src/index.ts";
import type { CommandToolDeclaration } from "../../packages/core/src/command-tool-catalog.ts";
import type { ToolId } from "../../packages/core/src/run-kernel/index.ts";
import type { ToolBinding } from "../../packages/core/src/tool-execution.ts";
import { isTauriRuntime } from "../runtime.client.ts";
import {
  commandToolBinding,
  findCommandToolGrant,
  readCommandToolGrants,
  withCommandToolGrant,
  withoutCommandToolGrant,
  writeCommandToolGrants,
} from "./command-tool-bindings.client.ts";
import type { CommandToolGrant } from "./command-tool-bindings.client.ts";

/**
 * The command-tool feature owner: what this device can run, and what the user
 * has allowed each tool to run.
 *
 * Availability is a state rather than a boolean because every reason a command
 * tool is unavailable needs a different sentence, and the one thing the UI may
 * never do is show an empty list. A shell that cannot spawn, a service with no
 * catalog, and a catalog with a typo are three different problems with three
 * different fixes.
 */

export type CommandToolAvailability =
  | { kind: "loading" }
  | { kind: "ready" }
  /** The desktop shell has no local service to spawn through — yet. */
  | { kind: "unsupported-shell" }
  | { kind: "unconfigured"; variable: string }
  | { kind: "invalid"; variable: string; problem: string }
  | { kind: "unreachable"; message: string };

export interface CommandToolsHandle {
  availability: CommandToolAvailability;
  commands: CommandToolDeclaration[];
  grantFor(toolId: ToolId): CommandToolGrant | undefined;
  /** The binding a granted, still-declared command stands for. */
  bindingFor(toolId: ToolId): ToolBinding | undefined;
  grant(toolId: ToolId, commandId: string): void;
  revoke(toolId: ToolId): void;
}

export interface UseCommandToolsOptions {
  /** Injected by tests; the app uses the page's own fetch. */
  fetchImpl?: typeof fetch;
}

export function useCommandTools(
  options: UseCommandToolsOptions = {},
): CommandToolsHandle {
  const { fetchImpl } = options;
  const [availability, setAvailability] = useState<CommandToolAvailability>({
    kind: "loading",
  });
  const [commands, setCommands] = useState<CommandToolDeclaration[]>([]);
  const [grants, setGrants] = useState<CommandToolGrant[]>([]);

  // Read after mount rather than during render: this is device storage, and
  // the server-rendered markup must not depend on it.
  useEffect(() => {
    const restoreId = window.setTimeout(() => {
      setGrants(readCommandToolGrants());
    });
    return () => window.clearTimeout(restoreId);
  }, []);

  useEffect(() => {
    let current = true;
    const request = fetchImpl ?? fetch;
    void (async () => {
      // Asked of the shell before the service, because the desktop build has
      // no service to ask and its unavailability is a different sentence.
      if (isTauriRuntime()) {
        if (current) setAvailability({ kind: "unsupported-shell" });
        return;
      }
      try {
        const response = await request(TOOL_COMMANDS_API_PATH, {
          headers: { accept: "application/json" },
        });
        if (!response.ok) {
          throw new Error(`The service answered ${response.status}.`);
        }
        const body = (await response.json()) as CommandToolCatalogResponse;
        if (!current) return;
        setCommands(body.commands ?? []);
        setAvailability(
          body.available
            ? { kind: "ready" }
            : body.problem
              ? {
                  kind: "invalid",
                  variable: body.configurationVariable,
                  problem: body.problem,
                }
              : { kind: "unconfigured", variable: body.configurationVariable },
        );
      } catch (error) {
        if (!current) return;
        setCommands([]);
        setAvailability({
          kind: "unreachable",
          message:
            error instanceof Error
              ? error.message
              : "The local service could not be reached.",
        });
      }
    })();
    return () => {
      current = false;
    };
  }, [fetchImpl]);

  const grant = useCallback((toolId: ToolId, commandId: string) => {
    setGrants((current) => {
      const next = withCommandToolGrant(
        current,
        toolId,
        commandId,
        new Date().toISOString(),
      );
      writeCommandToolGrants(next);
      return next;
    });
  }, []);

  const revoke = useCallback((toolId: ToolId) => {
    setGrants((current) => {
      const next = withoutCommandToolGrant(current, toolId);
      writeCommandToolGrants(next);
      return next;
    });
  }, []);

  return useMemo<CommandToolsHandle>(
    () => ({
      availability,
      commands,
      grantFor: (toolId) => findCommandToolGrant(grants, toolId),
      bindingFor: (toolId) => {
        const granted = findCommandToolGrant(grants, toolId);
        return granted ? commandToolBinding(granted, commands) : undefined;
      },
      grant,
      revoke,
    }),
    [availability, commands, grants, grant, revoke],
  );
}
