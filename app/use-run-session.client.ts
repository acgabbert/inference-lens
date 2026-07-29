"use client";

import { useMemo, useRef, useState } from "react";
import type { CredentialSelection, ProviderTurnTransport } from "../packages/contracts/src";
import type { RichInferenceRequest } from "../packages/core/src/types";
import { createEntityId, createRunTrace, RunCoordinator, transcriptFromRunState } from "../packages/core/src/run-kernel";
import type { ProviderExecution, ResolvedRunInput, RunState, RunTrace, ToolDefinition, ToolResult } from "../packages/core/src/run-kernel";
import { parseRunTraceJson, runStateFromTrace, traceFileName } from "../packages/core/src/run-trace";
import { randomUUID } from "../packages/core/src/random-id";
import { InferenceTransportError } from "./http-inference-transport.client";
import { recordDiagnostic, redactDiagnosticValue, startDiagnosticCapture } from "./diagnostics.client";
import type { DiagnosticCapture } from "./diagnostics.client";
import { exportRunTraceFile, runTraceWorkspaceLocation, runTraceWorkspacePath, saveRunTraceWorkspace } from "./project-workspace.client";
import type { ProjectWorkspaceHandle } from "./project-workspace.client";
import type { TraceStorageStatus } from "./response-output.client";
import type { ParentTraceState } from "./run-trace-panel.client";
import { isTerminalRunState, toolResultDraftsForState } from "./run-session-state.client";
import type { ToolResultDraft } from "./run-session-state.client";

type TraceOrigin = { workspace: ProjectWorkspaceHandle | null; fileName: string };

export interface RunSessionStartContext {
  request: RichInferenceRequest;
  workspace: ProjectWorkspaceHandle | null;
  branchedFrom?: RunTrace["branchedFrom"];
}

export interface UseRunSessionOptions {
  transport: ProviderTurnTransport;
  prepareCredential(): Promise<CredentialSelection>;
  tools: readonly ToolDefinition[];
  mockForTool(toolId: ToolDefinition["id"]): Parameters<typeof toolResultDraftsForState>[2] extends (id: ToolDefinition["id"]) => infer T ? T : never;
  readTrace(fileName: string): Promise<RunTrace>;
  onShowResponse(): void;
  onTraceSaved(): void;
  onResetBranch(): void;
  onError(message: string): void;
  onClearError(): void;
}

/** Owns the one live RunCoordinator and every ref that can invalidate it. */
export function useRunSession(options: UseRunSessionOptions) {
  const [runState, setRunState] = useState<RunState | null>(null);
  const [isRequestActive, setIsRequestActive] = useState(false);
  const [toolResultDrafts, setToolResultDrafts] = useState<Record<string, ToolResultDraft>>({});
  const [traceStorage, setTraceStorage] = useState<TraceStorageStatus | null>(null);
  const [hasDiagnosticCapture, setHasDiagnosticCapture] = useState(false);
  const [visibleBranchProvenance, setVisibleBranchProvenance] = useState<RunTrace["branchedFrom"]>();
  const [parentTrace, setParentTrace] = useState<ParentTraceState>({ status: "idle" });
  const coordinatorRef = useRef<RunCoordinator | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runStateRef = useRef<RunState | null>(null);
  const requestGenerationRef = useRef(0);
  const workspaceRef = useRef<ProjectWorkspaceHandle | null>(null);
  const persistedRunIdsRef = useRef(new Set<string>());
  const diagnosticRef = useRef<DiagnosticCapture | null>(null);
  const provenanceRef = useRef(new Map<string, RunTrace["branchedFrom"]>());
  const parentGenerationRef = useRef(0);
  const requestRef = useRef<RichInferenceRequest | null>(null);

  function replaceState(next: RunState | null): void {
    runStateRef.current = next;
    setRunState(next);
    if (!next) { setTraceStorage(null); return; }
    if (!isTerminalRunState(next)) return;
    const workspace = workspaceRef.current;
    if (!workspace) { setTraceStorage({ kind: "unsaved" }); return; }
    if (persistedRunIdsRef.current.has(next.runId)) return;
    let trace: RunTrace;
    try { trace = createRunTrace(next, { branchedFrom: provenanceRef.current.get(next.runId) }); } catch { return; }
    const location = runTraceWorkspaceLocation(workspace, trace);
    setTraceStorage({ kind: "saving", location });
    persistedRunIdsRef.current.add(next.runId);
    void saveRunTraceWorkspace(workspace, trace).then(() => {
      if (runStateRef.current?.runId === next.runId) setTraceStorage({ kind: "saved", location });
      options.onTraceSaved();
    }).catch((error) => {
      persistedRunIdsRef.current.delete(next.runId);
      if (runStateRef.current?.runId === next.runId) setTraceStorage({ kind: "error", message: error instanceof Error ? error.message : "The project trace could not be saved." });
    });
  }

  async function execute(execution: ProviderExecution, controller: AbortController, generation: number, capture: DiagnosticCapture): Promise<void> {
    const coordinator = coordinatorRef.current;
    if (!coordinator) throw new Error("Run coordinator is unavailable.");
    try {
      const credential = await options.prepareCredential();
      const stream = await options.transport.executeTurn({ execution, credential }, controller.signal);
      recordDiagnostic(capture, "client.response_received", { status: stream.status, headers: Object.fromEntries(stream.headers) });
      for await (const event of stream.events) {
        recordDiagnostic(capture, "client.ndjson_record_received", { raw: JSON.stringify(redactDiagnosticValue(event)), event });
        if (requestGenerationRef.current !== generation) continue;
        coordinator.accept(event); replaceState(coordinator.state);
      }
      if (requestGenerationRef.current !== generation) return;
      coordinator.finishTurnStream(); replaceState(coordinator.state);
      setToolResultDrafts(toolResultDraftsForState(coordinator.state, options.tools, options.mockForTool));
    } catch (error) {
      if (controller.signal.aborted || requestGenerationRef.current !== generation) throw error;
      const status = error instanceof InferenceTransportError ? error.status : undefined;
      coordinator.accept({ type: "failed", error: { code: error instanceof SyntaxError ? "protocol_error" : "transport_error", message: error instanceof Error ? error.message : "Request failed.", retryable: !(error instanceof SyntaxError) && (status === undefined || status === 408 || status === 429 || (status >= 500 && status <= 599)) } });
      replaceState(coordinator.state);
    }
  }

  async function start(input: ResolvedRunInput, context: RunSessionStartContext): Promise<void> {
    abortRef.current?.abort();
    const generation = ++requestGenerationRef.current;
    const controller = new AbortController(); abortRef.current = controller;
    const coordinator = new RunCoordinator(input); coordinatorRef.current = coordinator;
    workspaceRef.current = context.workspace;
    requestRef.current = context.request;
    parentGenerationRef.current += 1; setParentTrace({ status: "idle" });
    if (context.branchedFrom) provenanceRef.current.set(input.runId, context.branchedFrom);
    setVisibleBranchProvenance(context.branchedFrom); setTraceStorage(null); setToolResultDrafts({});
    options.onShowResponse(); setIsRequestActive(true);
    const capture = startDiagnosticCapture(context.request); diagnosticRef.current = capture; setHasDiagnosticCapture(true);
    recordDiagnostic(capture, "client.request_started", { request: context.request });
    const command = coordinator.start(); replaceState(coordinator.state);
    try { await execute(command.execution, controller, generation, capture); }
    catch (error) {
      if (controller.signal.aborted || requestGenerationRef.current !== generation) { recordDiagnostic(capture, "client.request_aborted"); return; }
      recordDiagnostic(capture, "client.request_failed", { message: error instanceof Error ? error.message : "Request failed." });
      coordinator.fail({ code: "internal_error", message: error instanceof Error ? error.message : "Request failed." }); replaceState(coordinator.state);
    } finally { recordDiagnostic(capture, "client.stream_finished"); if (requestGenerationRef.current === generation) { abortRef.current = null; setIsRequestActive(false); } }
  }

  async function continueRun(): Promise<void> {
    const coordinator = coordinatorRef.current;
    if (!coordinator || coordinator.state.status.kind !== "awaiting_tool_results") return;
    const waiting = coordinator.state.status;
    const calls = coordinator.state.turns.find(({ turnId }) => turnId === waiting.turnId)?.attempts.at(-1)?.completedToolCalls ?? [];
    const byId = new Set(calls.map(({ id }) => id));
    const results: ToolResult[] = waiting.pendingToolCallIds.map((toolCallId) => {
      const draft = toolResultDrafts[toolCallId]; if (!draft) throw new Error(`Tool call ${toolCallId} has no result.`);
      return { id: createEntityId("tool-result", randomUUID()), toolCallId, content: [{ type: "text", text: draft.text }], resolution: draft.resolution, ...(byId.has(toolCallId) ? {} : { isError: true }) };
    });
    coordinator.supplyToolResults(results); const command = coordinator.continue(); replaceState(coordinator.state); setToolResultDrafts({});
    const generation = ++requestGenerationRef.current; const controller = new AbortController(); abortRef.current = controller; options.onShowResponse(); setIsRequestActive(true);
    const capture = diagnosticRef.current ?? startDiagnosticCapture(requestRef.current!); diagnosticRef.current = capture;
    try { await execute(command.execution, controller, generation, capture); }
    catch (error) { if (!controller.signal.aborted) { coordinator.fail({ code: "internal_error", message: error instanceof Error ? error.message : "Request failed." }); replaceState(coordinator.state); } }
    finally { if (requestGenerationRef.current === generation) { abortRef.current = null; setIsRequestActive(false); } }
  }

  async function retry(): Promise<void> {
    const coordinator = coordinatorRef.current;
    if (!coordinator || coordinator.state.status.kind !== "paused" || coordinator.state.status.reason !== "attempt_failed") return;
    const generation = ++requestGenerationRef.current; const controller = new AbortController(); abortRef.current = controller; options.onShowResponse(); setIsRequestActive(true); setToolResultDrafts({});
    const command = coordinator.retry(); replaceState(coordinator.state);
    const capture = diagnosticRef.current ?? startDiagnosticCapture(requestRef.current!); diagnosticRef.current = capture; setHasDiagnosticCapture(true);
    recordDiagnostic(capture, "client.retry_started", { turnId: command.execution.turnId, attempt: command.execution.attempt, exchangeId: command.execution.exchangeId });
    try { await execute(command.execution, controller, generation, capture); }
    catch (error) { if (!controller.signal.aborted) { coordinator.fail({ code: "internal_error", message: error instanceof Error ? error.message : "Request failed." }); replaceState(coordinator.state); } }
    finally { recordDiagnostic(capture, "client.stream_finished"); if (requestGenerationRef.current === generation) { abortRef.current = null; setIsRequestActive(false); } }
  }

  function stop(): void {
    const controller = abortRef.current;
    requestGenerationRef.current += 1;
    if (diagnosticRef.current) {
      recordDiagnostic(diagnosticRef.current, "client.stop_requested");
    }
    abortRef.current = null;
    controller?.abort();
    setIsRequestActive(false);
    const coordinator = coordinatorRef.current;
    if (coordinator && !isTerminalRunState(coordinator.state)) {
      const status = coordinator.state.status;
      if (status.kind === "paused" && status.reason === "attempt_failed") {
        coordinator.fail(status.error);
      } else {
        coordinator.cancel("Stopped by user.");
      }
      replaceState(coordinator.state);
    }
  }
  function updateToolResultDraft(callId: string, text: string): void { setToolResultDrafts((current) => ({ ...current, [callId]: { ...current[callId]!, text } })); }
  function reset(): void { stop(); coordinatorRef.current = null; setToolResultDrafts({}); diagnosticRef.current = null; setHasDiagnosticCapture(false); parentGenerationRef.current += 1; setParentTrace({ status: "idle" }); replaceState(null); }
  function downloadDiagnostics(): void { const capture = diagnosticRef.current; if (!capture) return; const exportedAt = new Date().toISOString(); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 1, exportedAt, privacy: { credentials: "redacted", messageBodies: "included" }, capture }, null, 2)], { type: "application/json" })); link.download = `inference-lens-diagnostics-${exportedAt.replaceAll(":", "-")}.json`; link.click(); URL.revokeObjectURL(link.href); }
  function traceForState(): RunTrace | undefined { const state = runStateRef.current; if (!state || !isTerminalRunState(state)) return; try { return createRunTrace(state, { branchedFrom: provenanceRef.current.get(state.runId) }); } catch { return; } }
  async function exportTrace(): Promise<void> { const trace = traceForState(); if (!trace) return; const previous = traceStorage; const preserve = previous?.kind === "saved" && Boolean(workspaceRef.current); setTraceStorage({ kind: "saving" }); try { const result = await exportRunTraceFile(trace); setTraceStorage(result.kind === "saved" ? (preserve ? previous! : { kind: "saved", location: result.location }) : result.kind === "downloaded" ? (preserve ? previous! : { kind: "downloaded", fileName: result.fileName }) : previous ?? { kind: "unsaved" }); } catch (error) { setTraceStorage({ kind: "error", message: error instanceof Error ? error.message : "The trace could not be saved." }); } }
  function adoptTrace(trace: RunTrace, origin: TraceOrigin): void {
    stop();
    if (trace.branchedFrom) provenanceRef.current.set(trace.runId, trace.branchedFrom);
    if (origin.workspace) persistedRunIdsRef.current.add(trace.runId);
    coordinatorRef.current = null;
    workspaceRef.current = origin.workspace;
    diagnosticRef.current = null;
    setHasDiagnosticCapture(false);
    setToolResultDrafts({});
    options.onResetBranch();
    parentGenerationRef.current += 1;
    setParentTrace({ status: "idle" });
    setVisibleBranchProvenance(trace.branchedFrom);
    options.onShowResponse();
    replaceState(runStateFromTrace(trace));
    setTraceStorage(origin.workspace
      ? { kind: "saved", location: runTraceWorkspacePath(origin.workspace, origin.fileName) }
      : { kind: "loaded", fileName: origin.fileName });
    options.onClearError();
  }
  async function importTrace(file: File): Promise<void> { try { adoptTrace(parseRunTraceJson(await file.text()), { workspace: null, fileName: file.name }); } catch (error) { options.onError(error instanceof Error ? error.message : "Could not import the run trace."); } }
  async function loadParentTrace(): Promise<void> { const provenance = visibleBranchProvenance; const generation = ++parentGenerationRef.current; if (!provenance) return; if (!workspaceRef.current) { setParentTrace({ status: "error", error: "Open the project folder that contains the parent run, then load it again. If the parent was never saved, save that run first." }); return; } setParentTrace({ status: "loading" }); try { const trace = await options.readTrace(traceFileName(provenance.runId)); if (generation !== parentGenerationRef.current) return; if (trace.runId !== provenance.runId) throw new Error("The parent trace file contains a different run."); setParentTrace({ status: "ready", trace }); } catch (error) { if (generation !== parentGenerationRef.current) return; setParentTrace({ status: "error", error: `The parent run could not be loaded. Save run ${provenance.runId} in this project folder, then try again. ${error instanceof Error ? error.message : "The trace could not be read."}` }); } }
  const transcript = useMemo(() => runState ? transcriptFromRunState(runState) : [], [runState]);
  return { runState, transcript, isRequestActive, toolResultDrafts, traceStorage, hasDiagnosticCapture, visibleBranchProvenance, parentTrace, start, retry, continueRun, stop, reset, updateToolResultDraft, downloadDiagnostics, exportTrace, adoptTrace, importTrace, loadParentTrace, terminal: isTerminalRunState(runState) };
}
