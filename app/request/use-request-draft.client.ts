"use client";

import { useCallback, useEffect, useState } from "react";
import type { ToolMock } from "../../packages/core/src/project.ts";
import { createEntityId } from "../../packages/core/src/run-kernel/types.ts";
import type {
  JsonObject,
  ConversationMessage,
  MessageContentPart,
  ToolDefinition,
  ToolId,
} from "../../packages/core/src/run-kernel/types.ts";
import { snapshotRegistryTool } from "../../packages/core/src/tool-registry.ts";
import type { RegistryTool } from "../../packages/core/src/tool-registry.ts";
import { randomUUID } from "../../packages/core/src/random-id.ts";
import type { McpDiscoveredTool } from "../../packages/contracts/src/mcp-discovery.ts";
import { snapshotMcpTool } from "../tools/mcp-tool-snapshot.ts";
import { chooseDefaultUserPrompt, createInitialMessages } from "./default-messages.ts";

/**
 * Where an attached tool lives. "request" is kept in this tab only and is
 * cleared on reload; "project" is saved with the project and attached through
 * its defaults, so every run in the project picks it up.
 */
export type ToolAttachmentDestination = "request" | "project";

/** What is being attached. Every route into a request is one of these. */
export type ToolAttachmentSource =
  | { kind: "new" }
  | { kind: "registry"; tool: RegistryTool }
  | { kind: "mcp"; tool: McpDiscoveredTool; name: string };

export interface RequestDraftSnapshot {
  messages: ConversationMessage[];
  tools: ToolDefinition[];
  toolMocks: ToolMock[];
  enabledToolIds: ToolId[];
}

export interface RequestDraftHandle extends RequestDraftSnapshot {
  requestTools: ToolDefinition[];
  serializedTools(): ToolDefinition[];
  resolvedTools(): ToolDefinition[];
  resetMessages(messages: ConversationMessage[]): void;
  addMessage(): void;
  removeMessage(id: ConversationMessage["id"]): void;
  updateMessage(
    id: ConversationMessage["id"],
    patch: { content?: MessageContentPart[]; role?: ConversationMessage["role"] },
  ): void;
  /** Returns the attached snapshot, or why it could not be attached. */
  attachTool(source: ToolAttachmentSource, destination: ToolAttachmentDestination): ToolDefinition | string;
  updateTool(id: ToolId, patch: Partial<ToolDefinition>): void;
  removeTool(id: ToolId): void;
  moveTool(id: ToolId, offset: number): void;
  setToolEnabled(id: ToolId, enabled: boolean): void;
  mockForTool(toolId: ToolId): ToolMock | undefined;
  updateToolMock(toolId: ToolId, text: string, enabled: boolean): void;
  saveRequestToolToProject(id: ToolId): void;
  updateRequestTool(id: ToolId, patch: Partial<ToolDefinition>): void;
  moveRequestTool(id: ToolId, offset: number): void;
  removeRequestTool(id: ToolId): void;
  clearRequestTools(): void;
  replaceProjectDraft(snapshot: RequestDraftSnapshot): void;
}

/** Editing a discovered descriptor makes its fingerprint stale. */
function patchTool(
  tools: ToolDefinition[],
  id: ToolId,
  patch: Partial<ToolDefinition>,
): ToolDefinition[] {
  return tools.map((tool) => {
    if (tool.id !== id) return tool;
    const editable = { ...tool };
    const changes = { ...patch };
    delete editable.source;
    delete changes.source;
    return { ...editable, ...changes };
  });
}

/** Removes a message without leaving a tool-result/call link dangling. */
export function removeDraftMessage(
  messages: ConversationMessage[],
  id: ConversationMessage["id"],
): ConversationMessage[] {
  const removed = messages.find((message) => message.id === id);
  if (!removed) return messages;
  if (removed.role === "assistant" && removed.toolCalls?.length) {
    const toolCallIds = new Set(removed.toolCalls.map((call) => call.id));
    return messages.filter(
      (message) =>
        message.id !== id &&
        !(message.role === "tool" && toolCallIds.has(message.toolCallId)),
    );
  }
  if (removed.role === "tool") {
    return messages
      .filter((message) => message.id !== id)
      .map((message) => {
        if (
          message.role !== "assistant" ||
          !message.toolCalls?.some((call) => call.id === removed.toolCallId)
        ) {
          return message;
        }
        const toolCalls = message.toolCalls.filter(
          (call) => call.id !== removed.toolCallId,
        );
        return toolCalls.length
          ? { ...message, toolCalls }
          : { id: message.id, role: "assistant", content: message.content };
      });
  }
  return messages.filter((message) => message.id !== id);
}

/**
 * Owns the editable request and project-tool draft. Project persistence and
 * error presentation remain with the caller; mutations notify it only when
 * they change data that belongs in a project document.
 *
 * The draft renders the first default prompt on the server and on first
 * paint, then swaps in a random one after hydration so the markup matches.
 */
export function useRequestDraft(input: {
  onProjectDirty(): void;
  onProjectError(message: string | undefined, options?: { clearKind?: boolean }): void;
}): RequestDraftHandle {
  const { onProjectDirty, onProjectError } = input;
  const [messages, setMessages] = useState<ConversationMessage[]>(createInitialMessages);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [toolMocks, setToolMocks] = useState<ToolMock[]>([]);
  const [enabledToolIds, setEnabledToolIds] = useState<ToolId[]>([]);
  const [requestTools, setRequestTools] = useState<ToolDefinition[]>([]);

  function serializedTools(): ToolDefinition[] {
    return tools.map((tool) => {
      if (!tool.name.trim()) throw new Error("Every project tool needs a name.");
      return tool;
    });
  }

  // Read on every render, so it must not throw while a name is mid-edit;
  // prepareWorkbenchRun rejects a blank name when a run is actually started.
  function resolvedTools(): ToolDefinition[] {
    const enabled = new Set(enabledToolIds);
    return tools.filter((tool) => enabled.has(tool.id));
  }

  function addMessage(): void {
    setMessages((current) => [
      ...current,
      {
        id: createEntityId("message", randomUUID()),
        role: "user",
        content: [{ type: "text", text: "" }],
      },
    ]);
    onProjectDirty();
  }

  const resetMessages = useCallback((nextMessages: ConversationMessage[]): void => {
    setMessages(nextMessages);
  }, []);

  useEffect(() => {
    const promptId = window.setTimeout(() => {
      resetMessages(createInitialMessages(chooseDefaultUserPrompt()));
    }, 0);
    return () => window.clearTimeout(promptId);
  }, [resetMessages]);

  function removeMessage(id: ConversationMessage["id"]): void {
    setMessages((current) => removeDraftMessage(current, id));
    onProjectDirty();
  }

  function updateMessage(
    id: ConversationMessage["id"],
    patch: { content?: MessageContentPart[]; role?: ConversationMessage["role"] },
  ): void {
    setMessages((current) =>
      current.map((message) => {
        if (message.id !== id) return message;
        const content = patch.content ?? message.content;
        if (message.role === "tool" || (message.role === "assistant" && message.toolCalls?.length)) {
          return { ...message, content };
        }
        return {
          id: message.id,
          role: patch.role ?? message.role,
          content,
        } as ConversationMessage;
      }),
    );
    onProjectDirty();
  }

  /** A blank definition whose name no project or tab tool already uses. */
  function newToolDefinition(): ToolDefinition {
    const taken = new Set([...tools, ...requestTools].map(({ name }) => name));
    let index = 1;
    while (taken.has(`tool_${index}`)) index += 1;
    const inputSchema: JsonObject = {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
    return { id: createEntityId("tool", randomUUID()), name: `tool_${index}`, description: "", inputSchema };
  }

  function updateTool(id: ToolId, patch: Partial<ToolDefinition>): void {
    setTools((current) => patchTool(current, id, patch));
    onProjectDirty();
  }

  function updateRequestTool(id: ToolId, patch: Partial<ToolDefinition>): void {
    setRequestTools((current) => patchTool(current, id, patch));
  }

  function removeTool(id: ToolId): void {
    setTools((current) => current.filter((tool) => tool.id !== id));
    setToolMocks((current) => current.filter((mock) => mock.toolId !== id));
    setEnabledToolIds((current) => current.filter((toolId) => toolId !== id));
    onProjectDirty();
  }

  /**
   * Selected project tools reach the provider in this array's order, so moving
   * a tool changes the `tools` list the model is given, not just the pane.
   * A move steps over detached tools: they are not in the request, so trading
   * places with one would change nothing the model sees.
   */
  function moveTool(id: ToolId, offset: number): void {
    setTools((current) => {
      const attached = current.filter((tool) => tool.id === id || enabledToolIds.includes(tool.id));
      const index = attached.findIndex((tool) => tool.id === id);
      const neighbour = attached[index + offset];
      if (index < 0 || !neighbour) return current;
      const next = current.filter((tool) => tool.id !== id);
      const at = next.findIndex((tool) => tool.id === neighbour.id);
      next.splice(offset > 0 ? at + 1 : at, 0, current.find((tool) => tool.id === id)!);
      return next;
    });
    onProjectDirty();
  }

  /** Tab tools follow every project tool, so they only reorder among themselves. */
  function moveRequestTool(id: ToolId, offset: number): void {
    setRequestTools((current) => {
      const index = current.findIndex((tool) => tool.id === id);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }

  function setToolEnabled(id: ToolId, enabled: boolean): void {
    setEnabledToolIds((current) =>
      enabled ? [...current, id] : current.filter((toolId) => toolId !== id),
    );
    onProjectDirty();
  }

  /**
   * One rule for every source. A project tool's name must be free across the
   * project and this tab, because it can be attached later; a tab tool's name
   * must be free among the tools the request already carries.
   */
  function attachTool(
    source: ToolAttachmentSource,
    destination: ToolAttachmentDestination,
  ): ToolDefinition | string {
    let snapshot: ToolDefinition;
    try {
      snapshot = source.kind === "new"
        ? newToolDefinition()
        : source.kind === "registry"
          ? snapshotRegistryTool(source.tool, createEntityId("tool", randomUUID()))
          : snapshotMcpTool(source.tool, source.name, createEntityId("tool", randomUUID()));
    } catch (error) {
      return error instanceof Error ? error.message : "This tool cannot be attached.";
    }
    const { name } = snapshot;
    const attachedProjectNames = tools
      .filter(({ id }) => enabledToolIds.includes(id))
      .map((tool) => tool.name);
    if (destination === "project" && tools.some((tool) => tool.name === name)) {
      return `A project tool named "${name}" already exists.`;
    }
    if ([...attachedProjectNames, ...requestTools.map((tool) => tool.name)].includes(name)) {
      return `A tool named "${name}" is already attached.`;
    }
    if (destination === "project") {
      setTools((current) => [...current, snapshot]);
      setEnabledToolIds((current) => [...current, snapshot.id]);
      onProjectDirty();
    } else {
      setRequestTools((current) => [...current, snapshot]);
    }
    onProjectError(undefined);
    return snapshot;
  }

  function mockForTool(toolId: ToolId): ToolMock | undefined {
    return toolMocks.find((mock) => mock.toolId === toolId);
  }

  function updateToolMock(toolId: ToolId, text: string, enabled: boolean): void {
    const existing = mockForTool(toolId);
    const next: ToolMock = {
      id: existing?.id ?? createEntityId("tool-mock", randomUUID()),
      toolId,
      name: existing?.name ?? "Static response",
      enabled,
      match: { kind: "always" },
      result: { content: [{ type: "text", text }] },
    };
    setToolMocks((current) =>
      existing
        ? current.map((mock) => (mock.id === existing.id ? next : mock))
        : [...current, next],
    );
    onProjectDirty();
  }

  function saveRequestToolToProject(id: ToolId): void {
    const tool = requestTools.find((item) => item.id === id);
    if (!tool) return;
    if (tools.some((item) => item.name === tool.name)) {
      onProjectError(`A project tool named "${tool.name}" already exists.`, { clearKind: true });
      return;
    }
    // Preserve identity so the existing temporary execution permission still resolves.
    setTools((current) => [...current, tool]);
    setEnabledToolIds((current) => [...current, id]);
    setRequestTools((current) => current.filter((item) => item.id !== id));
    onProjectDirty();
  }

  function removeRequestTool(id: ToolId): void {
    setRequestTools((current) => current.filter((tool) => tool.id !== id));
  }

  function clearRequestTools(): void {
    setRequestTools([]);
  }

  function replaceProjectDraft(snapshot: RequestDraftSnapshot): void {
    setMessages(snapshot.messages);
    setTools(snapshot.tools);
    setToolMocks(snapshot.toolMocks);
    setEnabledToolIds(snapshot.enabledToolIds);
  }

  return {
    messages,
    tools,
    toolMocks,
    enabledToolIds,
    requestTools,
    serializedTools,
    resolvedTools,
    resetMessages,
    addMessage,
    removeMessage,
    updateMessage,
    attachTool,
    updateTool,
    removeTool,
    moveTool,
    setToolEnabled,
    mockForTool,
    updateToolMock,
    saveRequestToolToProject,
    updateRequestTool,
    moveRequestTool,
    removeRequestTool,
    clearRequestTools,
    replaceProjectDraft,
  };
}
