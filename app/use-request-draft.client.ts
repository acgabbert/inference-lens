"use client";

import { useCallback, useState } from "react";
import type { ToolMock } from "../packages/core/src/project.ts";
import { createEntityId } from "../packages/core/src/run-kernel/types.ts";
import type {
  JsonObject,
  ConversationMessage,
  MessageContentPart,
  ToolDefinition,
  ToolId,
} from "../packages/core/src/run-kernel/types.ts";
import { snapshotRegistryTool } from "../packages/core/src/tool-registry.ts";
import type { RegistryTool } from "../packages/core/src/tool-registry.ts";

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
  addTool(): void;
  updateTool(id: ToolId, patch: Partial<ToolDefinition>): void;
  removeTool(id: ToolId): void;
  setToolEnabled(id: ToolId, enabled: boolean): void;
  mockForTool(toolId: ToolId): ToolMock | undefined;
  updateToolMock(toolId: ToolId, text: string, enabled: boolean): void;
  attachRegistryToolToProject(source: RegistryTool): string | undefined;
  attachRegistryToolToRequest(source: RegistryTool): string | undefined;
  removeRequestTool(id: ToolId): void;
  clearRequestTools(): void;
  replaceProjectDraft(snapshot: RequestDraftSnapshot): void;
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
 */
export function useRequestDraft(input: {
  initialMessages: ConversationMessage[];
  onProjectDirty(): void;
  onProjectError(message: string | undefined, options?: { clearKind?: boolean }): void;
}): RequestDraftHandle {
  const { initialMessages, onProjectDirty, onProjectError } = input;
  const [messages, setMessages] = useState<ConversationMessage[]>(initialMessages);
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

  function resolvedTools(): ToolDefinition[] {
    const enabled = new Set(enabledToolIds);
    return serializedTools().filter((tool) => enabled.has(tool.id));
  }

  function addMessage(): void {
    setMessages((current) => [
      ...current,
      {
        id: createEntityId("message", crypto.randomUUID()),
        role: "user",
        content: [{ type: "text", text: "" }],
      },
    ]);
    onProjectDirty();
  }

  const resetMessages = useCallback((nextMessages: ConversationMessage[]): void => {
    setMessages(nextMessages);
  }, []);

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

  function addTool(): void {
    const id = createEntityId("tool", crypto.randomUUID());
    const inputSchema: JsonObject = {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
    setTools((current) => [
      ...current,
      { id, name: `tool_${current.length + 1}`, description: "", inputSchema },
    ]);
    setEnabledToolIds((current) => [...current, id]);
    onProjectDirty();
  }

  function updateTool(id: ToolId, patch: Partial<ToolDefinition>): void {
    setTools((current) =>
      current.map((tool) => (tool.id === id ? { ...tool, ...patch } : tool)),
    );
    onProjectDirty();
  }

  function removeTool(id: ToolId): void {
    setTools((current) => current.filter((tool) => tool.id !== id));
    setToolMocks((current) => current.filter((mock) => mock.toolId !== id));
    setEnabledToolIds((current) => current.filter((toolId) => toolId !== id));
    onProjectDirty();
  }

  function setToolEnabled(id: ToolId, enabled: boolean): void {
    setEnabledToolIds((current) =>
      enabled ? [...current, id] : current.filter((toolId) => toolId !== id),
    );
    onProjectDirty();
  }

  function toolSnapshot(source: RegistryTool): ToolDefinition {
    return snapshotRegistryTool(source, createEntityId("tool", crypto.randomUUID()));
  }

  function attachRegistryToolToProject(source: RegistryTool): string | undefined {
    if (tools.some(({ name }) => name === source.name)) {
      const message = `A project tool named "${source.name}" already exists.`;
      onProjectError(message, { clearKind: true });
      return message;
    }
    const snapshot = toolSnapshot(source);
    setTools((current) => [...current, snapshot]);
    setEnabledToolIds((current) => [...current, snapshot.id]);
    onProjectDirty();
    onProjectError(undefined);
    return undefined;
  }

  function attachRegistryToolToRequest(source: RegistryTool): string | undefined {
    const exposedProjectNames = new Set(
      tools.filter(({ id }) => enabledToolIds.includes(id)).map(({ name }) => name),
    );
    if (
      exposedProjectNames.has(source.name) ||
      requestTools.some(({ name }) => name === source.name)
    ) {
      const message = `A tool named "${source.name}" is already attached to the next request.`;
      onProjectError(message, { clearKind: true });
      return message;
    }
    setRequestTools((current) => [...current, toolSnapshot(source)]);
    onProjectError(undefined);
    return undefined;
  }

  function mockForTool(toolId: ToolId): ToolMock | undefined {
    return toolMocks.find((mock) => mock.toolId === toolId);
  }

  function updateToolMock(toolId: ToolId, text: string, enabled: boolean): void {
    const existing = mockForTool(toolId);
    const next: ToolMock = {
      id: existing?.id ?? createEntityId("tool-mock", crypto.randomUUID()),
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
    setRequestTools([]);
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
    addTool,
    updateTool,
    removeTool,
    setToolEnabled,
    mockForTool,
    updateToolMock,
    attachRegistryToolToProject,
    attachRegistryToolToRequest,
    removeRequestTool,
    clearRequestTools,
    replaceProjectDraft,
  };
}
