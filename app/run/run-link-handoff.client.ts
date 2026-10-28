"use client";
import { validateRunReference, type RunReferenceV1 } from "../../packages/core/src/run-reference.ts";
import { projectEditorLockName } from "../project-tab-coordination.client.ts";
const CHANNEL = "inference-lens:project-tabs";
export interface RunLinkMessage { type: "open-run"; projectId: string; tab: string; requestId: string; reference: RunReferenceV1 }
export function parseRunLinkMessage(value: unknown): RunLinkMessage | undefined {
  if (!value || typeof value !== "object") return;
  const r = value as Record<string, unknown>;
  if (r.type !== "open-run" || typeof r.tab !== "string" || typeof r.requestId !== "string" || !r.tab || !r.requestId) return;
  const parsed = validateRunReference(r.reference);
  if (parsed.kind !== "valid" || r.projectId !== parsed.reference.projectId) return;
  return { type: "open-run", projectId: parsed.reference.projectId, tab: r.tab, requestId: r.requestId, reference: parsed.reference };
}
export function receiveRunLinkHandoff(canReceive: (projectId: string) => Promise<boolean>, receive: (ref: RunReferenceV1) => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(CHANNEL); let closed = false;
  channel.onmessage = event => {
    const message = parseRunLinkMessage(event.data); if (!message) return;
    void canReceive(message.projectId).then(allowed => {
      if (!allowed || closed) return;
      receive(message.reference);
      channel.postMessage({ type: "run-accepted", requestId: message.requestId, tab: message.tab, projectId: message.projectId });
    }).catch(() => undefined);
  };
  return () => { closed = true; channel.close(); };
}
export async function handoffRunLink(reference: RunReferenceV1): Promise<boolean> {
  if (!navigator.locks || typeof BroadcastChannel === "undefined") return false;
  try {
    const locks = await navigator.locks.query();
    if (!locks.held?.some(lock => lock.name === projectEditorLockName(reference.projectId))) return false;
  } catch { return false; }
  return new Promise(resolve => {
    const channel = new BroadcastChannel(CHANNEL);
    const requestId = crypto.randomUUID(), tab = crypto.randomUUID();
    const finish = (accepted: boolean) => { clearTimeout(timer); channel.close(); resolve(accepted); };
    const timer = setTimeout(() => finish(false), 700);
    channel.onmessage = event => {
      const r = event.data;
      if (r && r.type === "run-accepted" && r.requestId === requestId && r.tab === tab && r.projectId === reference.projectId) finish(true);
    };
    channel.postMessage({ type: "open-run", projectId: reference.projectId, tab, requestId, reference });
  });
}
