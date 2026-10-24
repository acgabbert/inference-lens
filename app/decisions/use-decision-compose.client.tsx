"use client";

import type { CredentialSelection, DecisionTransport, ProviderTurnTransport } from "../../packages/contracts/src";
import { activeDecisionRequestRevision, prepareDecisionRequestRun } from "../../packages/core/src/decision-request";
import type { DecisionRunTrace } from "../../packages/core/src/decision-trace";
import type { ProjectFile } from "../../packages/core/src/project";
import type { DecisionRequestRevisionId } from "../../packages/core/src/run-kernel/types";
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
import { useDecisionProject } from "./use-decision-project.client";
import type { DecisionProjectHandle } from "./use-decision-project.client";
import { useDecisionSession } from "./use-decision-session.client";
import { useDecisionTarget } from "./use-decision-target.client";

export interface UseDecisionComposeOptions {
  profiles: StoredInferenceProfile[];
  transport: ProviderTurnTransport & DecisionTransport;
  prepareCredentialForProfile(profileId: string, endpoint: string): Promise<CredentialSelection>;
  updateProfile(profileId: string, patch: StoredInferenceProfilePatch): void;
  workspace: ProjectWorkspaceHandle | null;
  /** The open project, which owns the active decision request (D37, D42). */
  project: ProjectFile | null;
  adoptProjectMutation(project: ProjectFile): void;
  /** The draft changed; the project, if one is open, needs saving. */
  onProjectEdited(): void;
  /**
   * Why another foreground activity refuses a decision run now (D24): a chat
   * request or a batch. Absent when nothing else is running.
   */
  otherActivity?: string;
  onShowResponse(): void;
  onTraceSaved(): void;
  onError(message: string): void;
  onOpenConnections(): void;
  /** "New suite from this request" was chosen; the route hands it to suite authoring. */
  onNewSuite?(source: DecisionSuiteSource): void;
}

/**
 * What a new decision suite pins (D37, D51): the active revision with the
 * editor's draft already written in, and the model Compose targets. `project`
 * is that folded document, so the suite is created on it rather than on a
 * project that still lags the editor.
 */
export interface DecisionSuiteSource {
  project: ProjectFile;
  decisionRequestRevisionId: DecisionRequestRevisionId;
  model: string;
  /** The System One connection Compose targets; the suite gets a requirement at its endpoint. */
  profile: StoredInferenceProfile;
}

export interface DecisionComposeHandle {
  compose: ComposeKindHandle;
  /** For D30: open a saved or imported decision trace. */
  adoptTrace(trace: DecisionRunTrace, origin: TraceOrigin): void;
  /** Where a new decision suite comes from, for the Evaluations rail too. */
  suiteSource: {
    /** Why there is no request or model to pin yet. */
    blockedReason?: string;
    take(): DecisionSuiteSource | undefined;
  };
  /** What the project workspace folds in and hands over (D42). */
  project: Pick<DecisionProjectHandle, "fold"> & {
    /** A project was opened or replaced: load its request and clear the result. */
    adopt(project: ProjectFile): void;
  };
}

/**
 * The decision feature's owner (D19, D29): its draft, target, and session, and
 * the panes and commands it hands Compose. Effects, refs, and mutation
 * workflows stay here rather than in the route.
 */
export function useDecisionCompose(options: UseDecisionComposeOptions): DecisionComposeHandle {
  const draft = useDecisionDraft({ onEdited: options.onProjectEdited });
  const decisionProject = useDecisionProject({
    draft,
    project: options.project,
    adoptProjectMutation: options.adoptProjectMutation,
  });
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
  // Variables resolve at the run boundary (D40): nothing is sent while one is
  // unfilled or a token is malformed.
  const prepared = "input" in validated ? prepareDecisionRequestRun(validated.input, draft.values) : undefined;
  const blockers: DecisionDraftProblem[] = [
    ...(options.otherActivity ? [{ location: "Activity", message: options.otherActivity }] : []),
    ...(target.blocker
      ? [{ location: target.blocker.kind === "no-model" ? "Model" : "Connection", message: target.blocker.message }]
      : []),
    ...("problems" in validated ? validated.problems : []),
    ...(prepared && !prepared.ok ? prepared.diagnostics.map(({ location, message }) => ({ location, message })) : []),
  ];
  const run = session.run;
  const paused = run?.status.kind === "paused";
  const retryWaiting = session.retryAvailableAt !== undefined;

  function start(): void {
    if (session.executing || blockers.length > 0 || !prepared?.ok) return;
    const resolved = target.resolveRun(prepared.decision);
    if (!resolved) return;
    decisionProject.freezeForRun();
    void session.start(resolved, { workspace: options.workspace });
  }

  function retry(): void {
    if (!paused || retryWaiting || options.otherActivity) return;
    void session.retry();
  }

  const suiteBlockedReason = !options.project
    ? "Open or save a project first."
    : decisionProject.unsaved
      ? "Fix the request’s problems first."
      // A valid touched draft becomes a request when it is folded in.
      : !activeDecisionRequestRevision(options.project) && !draft.touched
        ? "Write a decision request first."
        : !target.profile
          ? "Turn on System One for a connection first."
          : target.model.trim() === ""
            ? "Choose a decision model first."
            : undefined;
  const suiteSource: DecisionComposeHandle["suiteSource"] = {
    ...(suiteBlockedReason ? { blockedReason: suiteBlockedReason } : {}),
    take() {
      if (suiteBlockedReason || !options.project) return undefined;
      const folded = decisionProject.fold(options.project);
      const active = activeDecisionRequestRevision(folded);
      return active && target.profile
        ? { project: folded, decisionRequestRevisionId: active.id, model: target.model.trim(), profile: target.profile }
        : undefined;
    },
  };

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
          unsaved={decisionProject.unsaved}
          draft={draft}
          locked={session.executing}
          target={target}
          onOpenConnections={options.onOpenConnections}
          {...(options.project && options.onNewSuite
            ? {
                newSuite: {
                  onCreate() {
                    const source = suiteSource.take();
                    if (source) options.onNewSuite!(source);
                  },
                  ...(suiteBlockedReason ? { disabledReason: suiteBlockedReason } : {}),
                },
              }
            : {})}
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
  return {
    compose,
    adoptTrace: session.adoptTrace,
    suiteSource,
    project: {
      fold: decisionProject.fold,
      adopt(project) {
        session.reset();
        decisionProject.adopt(project);
      },
    },
  };
}
