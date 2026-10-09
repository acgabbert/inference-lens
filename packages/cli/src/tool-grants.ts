import type { ToolBindingCheckItem } from "../../contracts/src/tool-binding-check.ts";
import type { ProjectFile } from "../../core/src/project.ts";
import type { ToolDefinition, ToolId } from "../../core/src/run-kernel/types.ts";
import type { ToolBinding } from "../../core/src/tool-execution.ts";
import {
  COMMAND_TOOLS_VARIABLE,
  readCommandToolCatalog,
} from "../../../services/api/src/command-tool-catalog-source.ts";
import { discoverMcpServer } from "../../../services/api/src/mcp-discovery.ts";
import {
  MCP_SERVERS_VARIABLE,
  readMcpServerCatalog,
} from "../../../services/api/src/mcp-server-catalog.ts";
import { checkToolBindings } from "../../../services/api/src/tool-binding-check.ts";

/**
 * `--allow-tool`: decision 3B of the headless CLI design, with the target named
 * explicitly. A project never records which command or MCP server serves a
 * tool — in the app that is the device-local grant — so the operator names it
 * here, for this invocation only. The operator catalogs remain the ceiling.
 */
export type HeadlessToolGrantTarget =
  | { kind: "command"; commandId: string }
  | { kind: "mcp"; serverId: string };

export interface HeadlessToolGrant {
  toolName: string;
  target: HeadlessToolGrantTarget;
}

type Environment = Readonly<Record<string, string | undefined>>;

const GRANT_SYNTAX = "--allow-tool takes <tool-name>=command:<command-id> or <tool-name>=mcp:<server-id>";

export function parseToolGrants(entries: readonly string[]): HeadlessToolGrant[] {
  const grants: HeadlessToolGrant[] = [];
  for (const entry of entries) {
    const match = /^([^=]+)=(command|mcp):(.+)$/.exec(entry);
    if (!match) throw new Error(`${GRANT_SYNTAX}, not "${entry}".`);
    const [, toolName, kind, id] = match;
    if (grants.some((grant) => grant.toolName === toolName)) {
      // One answer per tool call, as in the app: a second grant would leave the run to choose.
      throw new Error(`--allow-tool names ${toolName} more than once.`);
    }
    grants.push({
      toolName,
      target: kind === "command" ? { kind: "command", commandId: id } : { kind: "mcp", serverId: id },
    });
  }
  return grants;
}

/**
 * The binding each grant stands for, by tool ID, for the tools this suite
 * exposes. A grant naming a tool the project does not define is refused; one
 * the suite does not expose is ignored, as an unused credential is. Whether
 * the operator's catalogs can serve a binding is checked later, by
 * `verifyHeadlessToolBindings`, before any plan is saved.
 */
export function resolveToolGrants(
  project: ProjectFile,
  exposed: readonly ToolDefinition[],
  grants: readonly HeadlessToolGrant[],
  environment: Environment,
): Map<ToolId, ToolBinding> {
  const unknown = grants.filter(({ toolName }) => !project.tools.some(({ name }) => name === toolName));
  if (unknown.length > 0) {
    throw new Error(`--allow-tool names ${unknown.map(({ toolName }) => toolName).join(", ")}, which this project does not define.`);
  }
  const bindings = new Map<ToolId, ToolBinding>();
  for (const { toolName, target } of grants) {
    const tool = exposed.find(({ name }) => name === toolName);
    if (!tool) continue;
    if (target.kind === "command") {
      const declaration = readCommandToolCatalog({ ...environment }).commands
        .find(({ id }) => id === target.commandId);
      bindings.set(tool.id, {
        toolId: tool.id,
        kind: "command",
        executorId: target.commandId,
        ...(declaration ? { label: declaration.label } : {}),
        grantedAt: new Date().toISOString(),
      });
      continue;
    }
    if (tool.source?.kind !== "mcp") {
      throw new Error(`${tool.name} was not attached from an MCP server, so --allow-tool cannot grant it mcp:${target.serverId}.`);
    }
    const server = readMcpServerCatalog({ ...environment }).servers.find(({ id }) => id === target.serverId);
    bindings.set(tool.id, {
      toolId: tool.id,
      kind: "mcp",
      // The executor identity the app derives for the same grant, so a trace
      // names an MCP answer the same way whichever host ran it.
      executorId: `${tool.source.remoteToolName}@${tool.source.discoveryFingerprint.slice(0, 12)}`,
      label: server?.label ?? target.serverId,
      serverId: target.serverId,
      remoteToolName: tool.source.remoteToolName,
      discoveryFingerprint: tool.source.discoveryFingerprint,
    });
  }
  return bindings;
}

function checkItem(binding: ToolBinding): ToolBindingCheckItem | undefined {
  switch (binding.kind) {
    case "mock":
      return undefined;
    case "command":
      return { toolId: binding.toolId, kind: "command", commandId: binding.executorId };
    case "mcp":
      return {
        toolId: binding.toolId,
        kind: "mcp",
        serverId: binding.serverId,
        remoteToolName: binding.remoteToolName,
        discoveryFingerprint: binding.discoveryFingerprint,
      };
  }
}

/**
 * The batch preflight the app runs against its service, run in process: every
 * granted command must be declared, and every granted MCP tool must still be
 * offered by an executable server with the fingerprint it was attached at.
 * Rejects naming each tool that cannot run, in terms of the variable that
 * would fix it.
 */
export async function verifyHeadlessToolBindings(
  bindings: readonly ToolBinding[],
  nameFor: (toolId: ToolId) => string,
  environment: Environment,
): Promise<void> {
  const items = bindings.flatMap((binding) => {
    const item = checkItem(binding);
    return item ? [item] : [];
  });
  if (items.length === 0) return;
  const commands = readCommandToolCatalog({ ...environment });
  const mcp = readMcpServerCatalog({ ...environment });
  const results = await checkToolBindings(items, {
    mcpServers: mcp.servers,
    commandIds: commands.commands.map(({ id }) => id),
    discover: (declaration) => discoverMcpServer(declaration, { ...environment }),
  });
  const problems = results.flatMap((result) => {
    if (result.status !== "unavailable") return [];
    const item = items.find(({ toolId }) => toolId === result.toolId)!;
    let message = result.message ?? "unavailable";
    if (result.reason === "declaration_missing") {
      if (item.kind === "command") {
        message = commands.available
          ? `${COMMAND_TOOLS_VARIABLE} declares no command "${item.commandId}".`
          : commands.problem ?? `no command catalog is declared; set ${COMMAND_TOOLS_VARIABLE} to one.`;
      } else {
        message = mcp.available
          ? `${MCP_SERVERS_VARIABLE} declares no server "${item.serverId}".`
          : mcp.problem ?? `no MCP server catalog is declared; set ${MCP_SERVERS_VARIABLE} to one.`;
      }
    }
    return [`${nameFor(result.toolId as ToolId)} cannot run: ${message}`];
  });
  if (problems.length > 0) throw new Error(`Nothing was sent. ${problems.join(" ")}`);
}
