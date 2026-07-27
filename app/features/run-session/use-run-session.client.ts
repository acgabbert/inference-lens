"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { CredentialSelection, ProviderTurnTransport } from "../../../packages/contracts/src";
import { createRunTrace, RunCoordinator } from "../../../packages/core/src/run-kernel";
import type {
  ProviderExecution,
  ResolvedRunInput,
  RunState,
  RunTrace,
  ToolCall,
} from "../../../packages/core/src/run-kernel";
import { runStateFromTrace } from "../../../packages/core/src/run-trace";
import type { RichInferenceRequest } from "../../../packages/core/src/types";
import { recordDiagnostic, redactDiagnosticValue, startDiagnosticCapture } from "../../diagnostics.client";
import type { DiagnosticCapture } from "../../diagnostics.client";
import { InferenceTransportError } from "../../http-inference-transport.client";
import { preserveRunFailure } from "./run-failure.client";
import { exportRunTraceFile, runTraceWorkspaceLocation, runTraceWorkspacePath, saveRunTraceWorkspace } from "../../project-workspace.client";
import type { ProjectWorkspaceHandle } from "../../project-workspace.client";
import type { TraceStorageStatus } from "../../response-output.client";
import type { ToolResultDraft } from "../../tool-call-list.client";
import { isRetryableTransportFailure, isTerminalRunState, pendingToolResultDrafts, toolResultsFromDrafts } from "./run-session-state.client";

type TraceOrigin =
  | { workspace: ProjectWorkspaceHandle; fileName: string }
  | { workspace: null; fileName: string };

export type RunSessionHandle = {
  runState: RunState | null;
  isRequestActive: boolean;
  toolResultDrafts: Record<string, ToolResultDraft>;
  traceStorage: TraceStorageStatus | null;
  hasDiagnosticCapture: boolean;
  branchedFrom?: RunTrace["branchedFrom"];
  start(input: ResolvedRunInput, options: { request: RichInferenceRequest; workspace: ProjectWorkspaceHandle | null; branchedFrom?: RunTrace["branchedFrom"] }): Promise<void>;
  continueRun(): Promise<void>;
  retryRun(): Promise<void>;
  stop(): void;
  reset(): void;
  updateToolResultDraft(callId: string, text: string): void;
  downloadDiagnostics(): void;
  exportRunTrace(): Promise<void>;
  importRunTrace(event: React.ChangeEvent<HTMLInputElement>): Promise<void>;
  adoptTrace(trace: RunTrace, origin: TraceOrigin): void;
};

export function useRunSession({
  transport, prepareCredential, currentDiagnosticRequest, resolveToolResultDraft,
  onTraceSaved,
}: {
  transport: ProviderTurnTransport;
  prepareCredential(): Promise<CredentialSelection>;
  currentDiagnosticRequest(): RichInferenceRequest;
  resolveToolResultDraft(call: ToolCall): ToolResultDraft | undefined;
  onTraceSaved(): void;
}): RunSessionHandle {
  const [runState, setRunState] = useState<RunState | null>(null);
  const [isRequestActive, setIsRequestActive] = useState(false);
  const [toolResultDrafts, setToolResultDrafts] = useState<Record<string, ToolResultDraft>>({});
  const [traceStorage, setTraceStorage] = useState<TraceStorageStatus | null>(null);
  const [hasDiagnosticCapture, setHasDiagnosticCapture] = useState(false);
  const [branchedFrom, setBranchedFrom] = useState<RunTrace["branchedFrom"]>();
  const abortRef = useRef<AbortController | null>(null);
  const coordinatorRef = useRef<RunCoordinator | null>(null);
  const runStateRef = useRef<RunState | null>(null);
  const requestGenerationRef = useRef(0);
  const runTraceWorkspaceRef = useRef<ProjectWorkspaceHandle | null>(null);
  const persistedTraceRunIdsRef = useRef(new Set<string>());
  const diagnosticCaptureRef = useRef<DiagnosticCapture | null>(null);
  const provenanceRef = useRef(new Map<string, RunTrace["branchedFrom"]>());

  const replaceRunState = useCallback((next: RunState | null) => {
    runStateRef.current = next;
    setRunState(next);
    if (!next) { setTraceStorage(null); return; }
    if (!isTerminalRunState(next)) return;
    const workspace = runTraceWorkspaceRef.current;
    if (!workspace) { setTraceStorage({ kind: "unsaved" }); return; }
    if (persistedTraceRunIdsRef.current.has(next.runId)) return;
    let trace: RunTrace;
    try { trace = createRunTrace(next, { branchedFrom: provenanceRef.current.get(next.runId) }); } catch { return; }
    const location = runTraceWorkspaceLocation(workspace, trace);
    setTraceStorage({ kind: "saving", location });
    persistedTraceRunIdsRef.current.add(next.runId);
    void saveRunTraceWorkspace(workspace, trace).then(() => {
      if (runStateRef.current?.runId === next.runId) setTraceStorage({ kind: "saved", location });
      onTraceSaved();
    }).catch((error) => {
      persistedTraceRunIdsRef.current.delete(next.runId);
      if (runStateRef.current?.runId === next.runId) setTraceStorage({ kind: "error", message: error instanceof Error ? error.message : "The project trace could not be saved." });
    });
  }, [onTraceSaved]);

  const executeProviderTurn = useCallback(async (execution: ProviderExecution, credential: CredentialSelection, controller: AbortController, generation: number, capture: DiagnosticCapture) => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) throw new Error("Run coordinator is unavailable.");
    try {
      const stream = await transport.executeTurn({ execution, credential }, controller.signal);
      recordDiagnostic(capture, "client.response_received", { status: stream.status, headers: Object.fromEntries(stream.headers) });
      for await (const event of stream.events) {
        recordDiagnostic(capture, "client.ndjson_record_received", { raw: JSON.stringify(redactDiagnosticValue(event)), event });
        if (requestGenerationRef.current !== generation) continue;
        coordinator.accept(event); replaceRunState(coordinator.state);
      }
      if (requestGenerationRef.current !== generation) return;
      coordinator.finishTurnStream(); replaceRunState(coordinator.state);
      setToolResultDrafts(pendingToolResultDrafts(coordinator.state, resolveToolResultDraft));
    } catch (error) {
      if (controller.signal.aborted || requestGenerationRef.current !== generation) throw error;
      const status = error instanceof InferenceTransportError ? error.status : undefined;
      coordinator.accept({ type: "failed", error: { code: error instanceof SyntaxError ? "protocol_error" : "transport_error", message: error instanceof Error ? error.message : "Request failed.", retryable: isRetryableTransportFailure(error, status) } });
      replaceRunState(coordinator.state);
    }
  }, [replaceRunState, resolveToolResultDraft, transport]);

  const start = useCallback(async (input: ResolvedRunInput, { request, workspace, branchedFrom: provenance }: { request: RichInferenceRequest; workspace: ProjectWorkspaceHandle | null; branchedFrom?: RunTrace["branchedFrom"] }) => {
    const coordinator = new RunCoordinator(input);
    if (provenance) provenanceRef.current.set(input.runId, provenance);
    setBranchedFrom(provenance); const generation = ++requestGenerationRef.current;
    abortRef.current?.abort(); const controller = new AbortController(); abortRef.current = controller;
    setIsRequestActive(true); runTraceWorkspaceRef.current = workspace; setTraceStorage(null);
    coordinatorRef.current = coordinator; const command = coordinator.start(); replaceRunState(coordinator.state); setToolResultDrafts({});
    const capture = startDiagnosticCapture(request); diagnosticCaptureRef.current = capture; setHasDiagnosticCapture(true); recordDiagnostic(capture, "client.request_started", { request });
    try { await executeProviderTurn(command.execution, await prepareCredential(), controller, generation, capture); }
    catch (error) {
      if (controller.signal.aborted || requestGenerationRef.current !== generation) { recordDiagnostic(capture, "client.request_aborted"); return; }
      recordDiagnostic(capture, "client.request_failed", { message: error instanceof Error ? error.message : "Request failed." });
      if (!isTerminalRunState(coordinator.state)) { coordinator.fail({ code: "internal_error", message: error instanceof Error ? error.message : "Request failed." }); replaceRunState(coordinator.state); }
      else replaceRunState(preserveRunFailure(runStateRef.current, request, { conversationId: input.conversationId, conversationRevisionId: input.conversationRevisionId }, error instanceof Error ? error.message : "Request failed."));
    } finally { recordDiagnostic(capture, "client.stream_finished"); if (requestGenerationRef.current === generation) { abortRef.current = null; setIsRequestActive(false); } }
  }, [executeProviderTurn, prepareCredential, replaceRunState]);

  const continueRun = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || coordinator.state.status.kind !== "awaiting_tool_results") return;
    let controller: AbortController | undefined;
    try {
      coordinator.supplyToolResults(toolResultsFromDrafts(coordinator.state, toolResultDrafts)); const command = coordinator.continue(); replaceRunState(coordinator.state); setToolResultDrafts({});
      const generation = ++requestGenerationRef.current; controller = new AbortController(); abortRef.current = controller; setIsRequestActive(true);
      const capture = diagnosticCaptureRef.current ?? startDiagnosticCapture(currentDiagnosticRequest()); diagnosticCaptureRef.current = capture;
      await executeProviderTurn(command.execution, await prepareCredential(), controller, generation, capture);
    } catch (error) { if (!controller?.signal.aborted && coordinatorRef.current && !isTerminalRunState(coordinatorRef.current.state)) { coordinatorRef.current.fail({ code: "internal_error", message: error instanceof Error ? error.message : "Request failed." }); replaceRunState(coordinatorRef.current.state); } }
    finally { if (abortRef.current === controller) abortRef.current = null; setIsRequestActive(false); }
  }, [currentDiagnosticRequest, executeProviderTurn, prepareCredential, replaceRunState, toolResultDrafts]);

  const retryRun = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || coordinator.state.status.kind !== "paused" || coordinator.state.status.reason !== "attempt_failed") return;
    const generation = ++requestGenerationRef.current; const controller = new AbortController(); abortRef.current = controller; setIsRequestActive(true); setToolResultDrafts({});
    const command = coordinator.retry(); replaceRunState(coordinator.state); const capture = diagnosticCaptureRef.current ?? startDiagnosticCapture(currentDiagnosticRequest()); diagnosticCaptureRef.current = capture; setHasDiagnosticCapture(true);
    recordDiagnostic(capture, "client.retry_started", { turnId: command.execution.turnId, attempt: command.execution.attempt, exchangeId: command.execution.exchangeId });
    try { await executeProviderTurn(command.execution, await prepareCredential(), controller, generation, capture); }
    catch (error) { if (!controller.signal.aborted && !isTerminalRunState(coordinator.state)) { coordinator.fail({ code: "internal_error", message: error instanceof Error ? error.message : "Request failed." }); replaceRunState(coordinator.state); } }
    finally { recordDiagnostic(capture, "client.stream_finished"); if (requestGenerationRef.current === generation) { abortRef.current = null; setIsRequestActive(false); } }
  }, [currentDiagnosticRequest, executeProviderTurn, prepareCredential, replaceRunState]);

  const stop = useCallback(() => { const controller = abortRef.current; requestGenerationRef.current += 1; if (diagnosticCaptureRef.current) recordDiagnostic(diagnosticCaptureRef.current, "client.stop_requested"); abortRef.current = null; controller?.abort(); setIsRequestActive(false); const coordinator = coordinatorRef.current; if (coordinator && !isTerminalRunState(coordinator.state)) { const status = coordinator.state.status; if (status.kind === "paused" && status.reason === "attempt_failed") coordinator.fail(status.error); else coordinator.cancel("Stopped by user."); replaceRunState(coordinator.state); } }, [replaceRunState]);
  const reset = useCallback(() => { requestGenerationRef.current += 1; abortRef.current?.abort(); abortRef.current = null; coordinatorRef.current = null; diagnosticCaptureRef.current = null; setHasDiagnosticCapture(false); setIsRequestActive(false); setToolResultDrafts({}); setBranchedFrom(undefined); replaceRunState(null); }, [replaceRunState]);
  const updateToolResultDraft = useCallback((callId: string, text: string) => setToolResultDrafts((current) => ({ ...current, [callId]: { ...current[callId]!, text } })), []);
  const runTraceForState = useCallback((state: RunState | null) => { if (!state || !isTerminalRunState(state)) return undefined; try { return createRunTrace(state, { branchedFrom: provenanceRef.current.get(state.runId) }); } catch { return undefined; } }, []);
  const exportRunTrace = useCallback(async () => { const trace = runTraceForState(runStateRef.current); if (!trace) return; const previous = traceStorage; const preserve = previous?.kind === "saved" && Boolean(runTraceWorkspaceRef.current); setTraceStorage({ kind: "saving" }); try { const result = await exportRunTraceFile(trace); if (result.kind === "saved") setTraceStorage(preserve ? previous : { kind: "saved", location: result.location }); else if (result.kind === "downloaded") setTraceStorage(preserve ? previous : { kind: "downloaded", fileName: result.fileName }); else setTraceStorage(previous ?? { kind: "unsaved" }); } catch (error) { setTraceStorage({ kind: "error", message: error instanceof Error ? error.message : "The trace could not be saved." }); } }, [runTraceForState, traceStorage]);
  const adoptTrace = useCallback((trace: RunTrace, origin: TraceOrigin) => { if (trace.branchedFrom) provenanceRef.current.set(trace.runId, trace.branchedFrom); if (origin.workspace) persistedTraceRunIdsRef.current.add(trace.runId); coordinatorRef.current = null; runTraceWorkspaceRef.current = origin.workspace; diagnosticCaptureRef.current = null; setHasDiagnosticCapture(false); setToolResultDrafts({}); setBranchedFrom(trace.branchedFrom); replaceRunState(runStateFromTrace(trace)); setTraceStorage(origin.workspace ? { kind: "saved", location: runTraceWorkspacePath(origin.workspace, origin.fileName) } : { kind: "loaded", fileName: origin.fileName }); }, [replaceRunState]);
  const importRunTrace = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; try { const { parseRunTraceJson } = await import("../../../packages/core/src/run-trace"); adoptTrace(parseRunTraceJson(await file.text()), { workspace: null, fileName: file.name }); } finally { event.target.value = ""; } }, [adoptTrace]);
  const downloadDiagnostics = useCallback(() => { const capture = diagnosticCaptureRef.current; if (!capture) return; const bundle = { schemaVersion: 1, exportedAt: new Date().toISOString(), privacy: { credentials: "redacted", messageBodies: "included" }, capture }; const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `trace-lens-diagnostics-${bundle.exportedAt.replaceAll(":", "-")}.json`; link.click(); URL.revokeObjectURL(url); }, []);
  return useMemo(() => ({ runState, isRequestActive, toolResultDrafts, traceStorage, hasDiagnosticCapture, branchedFrom, start, continueRun, retryRun, stop, reset, updateToolResultDraft, downloadDiagnostics, exportRunTrace, importRunTrace, adoptTrace }), [adoptTrace, branchedFrom, continueRun, downloadDiagnostics, exportRunTrace, hasDiagnosticCapture, importRunTrace, isRequestActive, reset, retryRun, runState, start, stop, toolResultDrafts, traceStorage, updateToolResultDraft]);
}
