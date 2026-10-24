"use client";

import type { CredentialSelection, DecisionTransport, ProviderTurnTransport } from "../../packages/contracts/src";
import type { DecisionRunTrace } from "../../packages/core/src/decision-trace";
import type { ComposeKindHandle } from "../compose/use-compose.client";
import type { ProjectWorkspaceHandle } from "../project-workspace.client";
import type { StoredInferenceProfile, StoredInferenceProfilePatch } from "../profile-store.client";
import type { TraceOrigin } from "../run/use-run-session.client";
import { DECISION_READINESS_SUMMARY_ID, DecisionComposer } from "./decision-composer.client";
import type { DecisionDraftProblem } from "./decision-draft";
import { DecisionInspect } from "./decision-inspect.client";
import { decisionDisplayStatus } from "./decision-result-view";
import { DecisionResponse } from "./decision-response.client";
import { useDecisionDraft } from "./use-decision-draft.client";
import { useDecisionSession } from "./use-decision-session.client";
import { useDecisionTarget } from "./use-decision-target.client";

export interface UseDecisionComposeOptions {
  profiles: StoredInferenceProfile[];
  transport: ProviderTurnTransport & DecisionTransport;
  prepareCredentialForProfile(profileId: string, endpoint: string): Promise<CredentialSelection>;
  updateProfile(profileId: string, patch: StoredInferenceProfilePatch): void;
  workspace: ProjectWorkspaceHandle | null;
  /**
   * Why another foreground activity refuses a decision run now (D24): a chat
   * request or a batch. Absent when nothing else is running.
   */
  otherActivity?: string;
  onShowResponse(): void;
  onTraceSaved(): void;
  onError(message: string): void;
  onOpenConnections(): void;
}

export interface DecisionComposeHandle {
  compose: ComposeKindHandle;
  /** For D30: open a saved or imported decision trace. */
  adoptTrace(trace: DecisionRunTrace, origin: TraceOrigin): void;
}

/**
 * The decision feature's owner (D19, D29): its draft, target, and session, and
 * the panes and commands it hands Compose. Effects, refs, and mutation
 * workflows stay here rather than in the route.
 */
export function useDecisionCompose(options: UseDecisionComposeOptions): DecisionComposeHandle {
  const draft = useDecisionDraft();
  const target = useDecisionTarget({
    profiles: options.profiles,
    transport: options.transport,
    prepareCredentialForProfile: options.prepareCredentialForProfile,
    updateProfile: options.updateProfile,
  });
  const session = useDecisionSession({
    transport: options.transport,
    prepareCredential: target.prepareCredential,
    onShowResponse: options.onShowResponse,
    onTraceSaved: options.onTraceSaved,
    onError: options.onError,
  });

  const validated = draft.validated();
  const blockers: DecisionDraftProblem[] = [
    ...(options.otherActivity ? [{ location: "Activity", message: options.otherActivity }] : []),
    ...(target.blocker
      ? [{ location: target.blocker.kind === "no-model" ? "Model" : "Connection", message: target.blocker.message }]
      : []),
    ...("problems" in validated ? validated.problems : []),
  ];
  const run = session.run;
  const paused = run?.status.kind === "paused";
  const retryWaiting = session.retryAvailableAt !== undefined;

  function start(): void {
    if (session.executing || blockers.length > 0 || !("input" in validated)) return;
    const resolved = target.resolveRun(validated.input);
    if (!resolved) return;
    void session.start(resolved, { workspace: options.workspace });
  }

  function retry(): void {
    if (!paused || retryWaiting || options.otherActivity) return;
    void session.retry();
  }

  const finished = Boolean(run && ["completed", "cancelled", "failed"].includes(run.status.kind));
  const compose: ComposeKindHandle = {
    executing: session.executing,
    primary: session.executing
      ? { kind: "stop", stop: session.stop }
      : paused
        ? { kind: "none" }
        : {
            kind: "run",
            label: "Run decision",
            disabled: blockers.length > 0,
            ...(blockers.length > 0 ? { disabledReasonId: DECISION_READINESS_SUMMARY_ID } : {}),
            run: start,
          },
    shortcut: () => (paused ? retry() : start()),
    panes: {
      request: (
        <DecisionComposer
          blockers={blockers}
          draft={draft}
          locked={session.executing}
          target={target}
          onOpenConnections={options.onOpenConnections}
        />
      ),
      response: (
        <DecisionResponse
          emptyDetail={blockers[0] ? `${blockers[0].location}: ${blockers[0].message}` : "Run the decision to see each answer."}
          executing={session.executing}
          run={run}
          traceStorage={session.traceStorage}
          {...(session.retryAvailableAt !== undefined ? { retryAvailableAt: session.retryAvailableAt } : {})}
          {...(options.otherActivity ? { retryBlockedReason: options.otherActivity } : {})}
          onDiscard={session.stop}
          onRetry={retry}
          onSaveTrace={() => void session.exportTrace()}
        />
      ),
      inspect: <DecisionInspect run={run} />,
    },
    inspectAvailable: Boolean(run),
    responseStatus: decisionDisplayStatus(run, session.executing),
    trace: { available: finished, export: () => void session.exportTrace() },
    stop: session.stop,
  };
  return { compose, adoptTrace: session.adoptTrace };
}
