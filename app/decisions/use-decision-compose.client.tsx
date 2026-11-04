"use client";

import { useRef } from "react";

import { usePromptModelWarnings } from "../templates/use-prompt-model-warnings.client";
import { sameProviderTarget } from "../../packages/core/src/provider-protocols";
import { isTerminalRunState } from "../run/run-session-state.client";
import type { DecisionInput } from "../../packages/core/src/decision";
import { discoverDecisionVariables } from "../../packages/core/src/decision-variables";
import type { ConfirmationDialogRequest } from "../confirmation-dialog.client";
import { DecisionTemplateUse } from "./decision-template-use.client";
import { decisionTemplateUseOverrides } from "./decision-template-use-overrides";
import type { PromptTemplateId, PromptTemplateRevisionId } from "../../packages/core/src/run-kernel";
import {
  detachDecisionRequestTemplate,
  updateDecisionRequestTemplateRevision,
  useDecisionPromptTemplateRevision as createDecisionTemplateUse,
} from "../../packages/core/src/decision-request";
import type { CredentialSelection, DecisionTransport, ProviderTurnTransport } from "../../packages/contracts/src";
import {
  activeDecisionRequestRevision,
  prepareDecisionRequestRun,
  resolveProjectDecisionRequestRevision,
} from "../../packages/core/src/decision-request";
import type { DecisionRunTrace } from "../../packages/core/src/decision-trace";
import type { DecisionPromptTemplate, ProjectFile } from "../../packages/core/src/project";
import type { DecisionRequestRevisionId } from "../../packages/core/src/run-kernel/types";
import type { ComposeKindHandle } from "../compose/use-compose.client";
import type { ProjectWorkspaceHandle } from "../project-workspace.client";
import type { StoredInferenceProfile, StoredInferenceProfilePatch } from "../profile-store.client";
import type { TraceOrigin } from "../run/use-run-session.client";
import { DECISION_READINESS_SUMMARY_ID, DecisionComposer } from "./decision-composer.client";
import type { DecisionDraftProblem } from "./decision-draft";
import { DecisionInspect } from "./decision-inspect.client";
import { decisionDisplayStatus } from "./decision-result-view";
import { CopyRunLink } from "../run/copy-run-link.client";
import { DecisionResponse } from "./decision-response.client";
import { useDecisionDraft } from "./use-decision-draft.client";
import type { DecisionDraftHandle } from "./use-decision-draft.client";
import { DECISION_EXAMPLE } from "./decision-example";
import { decisionContentAfterMutation, resolveDecisionContent } from "./local-decision-request";
import type { DecisionRequestRecordHandle } from "./use-decision-request-record.client";
import { useDecisionRecordSync } from "./use-decision-record-sync.client";
import type { LocalRequestState } from "../request/local-request-notice.client";
import { useDecisionProject } from "./use-decision-project.client";
import type { DecisionProjectHandle } from "./use-decision-project.client";
import { useDecisionSession } from "./use-decision-session.client";
import { useDecisionTarget } from "./use-decision-target.client";
import type { DecisionTargetHandle } from "./use-decision-target.client";

export interface UseDecisionComposeOptions {
  profiles: StoredInferenceProfile[];
  transport: ProviderTurnTransport & DecisionTransport;
  prepareCredentialForProfile(profileId: string, endpoint: string): Promise<CredentialSelection>;
  updateProfile(profileId: string, patch: StoredInferenceProfilePatch): void;
  workspace: ProjectWorkspaceHandle | null;
  /** The open project, which owns the active decision request (D37, D42). */
  project: ProjectFile | null;
  /**
   * Which personal record Compose edits (2b step 4). Enabled only in a
   * personal session; otherwise every path is today's.
   */
  record?: DecisionRequestRecordHandle;
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
  /** Invalid request replacement is an explicit user choice. */
  requestConfirmation(request: ConfirmationDialogRequest): void;
  onCapture?(content: { decision: DecisionInput; values: Record<string, string> }): void;
  /** `requestRevisionId` is absent for a local request that has no saved revision. */
  onEditSource?(requestRevisionId: DecisionRequestRevisionId | undefined, templateId: PromptTemplateId, templateRevisionId: PromptTemplateRevisionId): void;
  onTemplateUsed?(): void;
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
  capture(): { decision: DecisionInput; values: Record<string, string> } | { problems: DecisionDraftProblem[] };
  useTemplate(project: ProjectFile, templateId: PromptTemplateId, revisionId: PromptTemplateRevisionId): void;
  /** Absent `id`: back to the local request the source was opened from. */
  returnToRevision(id: DecisionRequestRevisionId | undefined): boolean;
  /** The same chooser used by the request pane and the contextual header. */
  connection: Pick<DecisionTargetHandle, "profiles" | "profile" | "selectProfile">;
  /** For D30: open a saved or imported decision trace. */
  replacementBlockedReason?: string;
  adoptTrace(trace: DecisionRunTrace, origin: TraceOrigin): void;
  /** Where a new decision suite comes from, for the Evaluations rail too. */
  suiteSource: {
    /** Why there is no request or model to pin yet. */
    blockedReason?: string;
    take(): DecisionSuiteSource | undefined;
  };
  /** What the project workspace folds in and hands over (D42). */
  project: Pick<DecisionProjectHandle, "fold" | "saveBlockedReason"> & {
    /** A project was opened or replaced: load its request and clear the result. */
    adopt(project: ProjectFile): void;
    /** The same project was reloaded: load its request without stopping or clearing a run. */
    refresh(project: ProjectFile): void;
  };
}

/**
 * The decision feature's owner (D19, D29): its draft, target, and session, and
 * the panes and commands it hands Compose. Effects, refs, and mutation
 * workflows stay here rather than in the route.
 */
export function useDecisionCompose(options: UseDecisionComposeOptions): DecisionComposeHandle {
  const modelInputRef = useRef<HTMLInputElement>(null);
  // A personal session's edits reach a personal record, not the project (2b step 4).
  const record = options.record?.enabled ? options.record : undefined;
  const draft = useDecisionDraft(record ? {} : { onEdited: options.onProjectEdited });
  const decisionProject = useDecisionProject({
    draft,
    project: options.project,
    adoptProjectMutation: options.adoptProjectMutation,
    personal: Boolean(record),
  });
  const recordSync = useDecisionRecordSync({ draft, record, project: options.project });
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

  const localRecord = record?.record;
  // Q3: a suite pins a saved revision, never local input.
  const requestBlockedReason = record
    ? localRecord?.kind === "draft" || localRecord?.kind === "scratch"
      ? "Save this request to start a suite from it."
      : localRecord?.kind !== "saved" ? "Write a decision request first." : undefined
    // A valid touched draft becomes a request when it is folded in.
    : options.project && !activeDecisionRequestRevision(options.project) && !draft.touched
      ? "Write a decision request first."
      : undefined;
  const suiteBlockedReason = !options.project
    ? "Open or save a project first."
    : decisionProject.unsaved
      ? "Fix the request’s problems first."
      : requestBlockedReason
        ? requestBlockedReason
        : !target.profile
          ? "Turn on System One for a connection first."
          : target.model.trim() === ""
            ? "Choose a decision model first."
            : undefined;
  const suiteSource: DecisionComposeHandle["suiteSource"] = {
    ...(suiteBlockedReason ? { blockedReason: suiteBlockedReason } : {}),
    take() {
      if (suiteBlockedReason || !options.project) return undefined;
      if (record) {
        return localRecord?.kind === "saved" && target.profile
          ? { project: options.project, decisionRequestRevisionId: localRecord.revision.id, model: target.model.trim(), profile: target.profile }
          : undefined;
      }
      const folded = decisionProject.fold(options.project);
      const active = activeDecisionRequestRevision(folded);
      return active && target.profile
        ? { project: folded, decisionRequestRevisionId: active.id, model: target.model.trim(), profile: target.profile }
        : undefined;
    },
  };

  // The template-use pin Compose shows: the project's active revision, or
  // the personal record's content in a personal session.
  const pin = activePin(options.project, record);
  const pinned = pin
    ? options.project?.promptTemplates.find(
        (entry): entry is DecisionPromptTemplate => entry.id === pin.templateId && entry.kind === "decision",
      )
    : undefined;

  // The overrides a fold would record now, so a revision switch can say which
  // in-progress values it would clear.
  const pinnedOverrideNames =
    pin?.resolved && pinned
      ? Object.keys(
          decisionTemplateUseOverrides({
            variables: pin.resolved.variables,
            effectiveValues: pin.resolved.values,
            existingOverrides: pin.overrides,
            values: draft.values,
          }),
        )
      : [];

  // Advice only: describes how the selected target relates to the pinned
  // prompt's recommendation without ever selecting a connection or model.
  const recommendedTarget = pinned?.recommendedTarget;
  const recommendedRequirement =
    recommendedTarget &&
    options.project?.connectionRequirements.find(({ id }) => id === recommendedTarget.connectionRequirementId);
  const compatibleRecommendedProfiles = recommendedRequirement
    ? target.profiles.filter(
        (profile) =>
          profile.provider === recommendedRequirement.provider &&
          sameProviderTarget(profile.endpoint, recommendedRequirement.endpoint),
      )
    : [];
  const recommendation =
    recommendedTarget && recommendedRequirement
      ? {
          model: recommendedTarget.model,
          connectionName: recommendedRequirement.name,
          compatibleConnectionNames: compatibleRecommendedProfiles.map(({ name }) => name),
          matchesSelectedConnection: compatibleRecommendedProfiles.some(({ id }) => id === target.profile?.id),
        }
      : undefined;

  const modelWarnings = usePromptModelWarnings(options.project?.projectId ?? "session", pinned && pin ? [{
    id: pin.warningKey,
    recommendation: pinned.recommendedTarget,
    selectedModel: target.model,
  }] : []);

  function adoptMutation(project: ProjectFile): void {
    options.adoptProjectMutation(project);
    decisionProject.adopt(project);
    session.reset();
  }

  function mutatePin(change: { kind: "retarget"; templateRevisionId: PromptTemplateRevisionId } | { kind: "detach" }): void {
    if (!options.project || session.executing) return;
    if (record) {
      const content = localRecord?.content;
      if (content?.kind !== "template-use") return;
      try {
        const next = decisionContentAfterMutation(options.project, content, (project, revisionId) => change.kind === "retarget"
          ? updateDecisionRequestTemplateRevision(project, { decisionRequestRevisionId: revisionId, templateRevisionId: change.templateRevisionId })
          : detachDecisionRequestTemplate(project, { decisionRequestRevisionId: revisionId }));
        if (record.edit(next)) session.reset();
      } catch (error) {
        options.onError(error instanceof Error ? error.message : "Could not change the pinned prompt.");
      }
      return;
    }
    const folded = decisionProject.fold(options.project);
    const revision = activeDecisionRequestRevision(folded);
    if (revision?.kind !== "template-use") return;
    adoptMutation(
      change.kind === "retarget"
        ? updateDecisionRequestTemplateRevision(folded, {
            decisionRequestRevisionId: revision.id,
            templateRevisionId: change.templateRevisionId,
          })
        : detachDecisionRequestTemplate(folded, { decisionRequestRevisionId: revision.id }),
    );
  }

  function editPinnedSource(): void {
    if (!options.project) return;
    if (record) {
      // Value edits are already in the record; a draft returns to its base.
      if (pin) options.onEditSource?.(localRecord?.revision?.id, pin.templateId, pin.templateRevisionId);
      return;
    }
    // Keep value edits before leaving, so Back to request finds them.
    const folded = decisionProject.fold(options.project);
    const revision = activeDecisionRequestRevision(folded);
    if (folded !== options.project) options.adoptProjectMutation(folded);
    if (revision?.kind === "template-use") {
      options.onEditSource?.(revision.id, revision.templateId, revision.templateRevisionId);
    }
  }

  // Capture keeps authored tokens and the values of discovered variables.
  const captureDiscovery = "input" in validated ? discoverDecisionVariables(validated.input) : undefined;
  const captureBlocked = !captureDiscovery || captureDiscovery.diagnostics.length > 0;
  function capture(): ReturnType<DecisionComposeHandle["capture"]> {
    if (!("input" in validated)) return { problems: validated.problems };
    const discovery = captureDiscovery!;
    if (discovery.diagnostics.length) {
      return {
        problems: discovery.diagnostics.map(({ field, diagnostic }) => ({
          location: field.kind,
          message: diagnostic.message,
        })),
      };
    }
    return {
      decision: structuredClone(validated.input),
      values: Object.fromEntries(Object.entries(draft.values).filter(([key]) => discovery.variables.includes(key))),
    };
  }
  // Q2: in a personal session the worked example starts a new local request.
  const editorHandle: DecisionDraftHandle = record
    ? { ...draft, loadExample() { record.startNew({ kind: "inline", decision: structuredClone(DECISION_EXAMPLE), values: {} }); } }
    : draft;
  const localRequest: LocalRequestState | undefined = record && (localRecord?.kind === "draft" || localRecord?.kind === "scratch")
    ? {
        kind: localRecord.kind,
        branched: false,
        needsName: record.needsName,
        suggestedName: record.suggestedName,
        saving: record.saving,
        onSave: (name?: string) => record.save(name),
        onDiscard: () => void record.discard(),
      }
    : undefined;

  const finished = isTerminalRunState(run);
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
      request: (kindSwitch) => (
        <DecisionComposer
          kindSwitch={kindSwitch}
          blockers={blockers}
          unsaved={decisionProject.unsaved}
          {...(record ? { unsavedDetail: "Not saved until the request is valid. Your workbench keeps its last valid version." } : {})}
          draft={editorHandle}
          {...(localRequest ? { localRequest } : {})}
          locked={session.executing}
          target={target}
          modelInputRef={modelInputRef}
          onOpenConnections={options.onOpenConnections}
          capture={{
            disabled: session.executing || captureBlocked,
            onCapture() {
              const content = capture();
              if ("decision" in content) options.onCapture?.(content);
            },
          }}
          {...(pinned && pin
            ? {
                pinned: (
                  <DecisionTemplateUse
                    template={pinned}
                    revisionId={pin.templateRevisionId}
                    overrideNames={pinnedOverrideNames}
                    locked={session.executing}
                    recommendation={recommendation}
                    selectedModel={target.model}
                    modelWarningDismissed={modelWarnings.isDismissed(pin.warningKey)}
                    onDismissModelWarning={() => modelWarnings.dismiss(pin.warningKey)}
                    onChooseModel={() => {
                      if (!modelInputRef.current) { options.onOpenConnections(); return; }
                      modelInputRef.current.scrollIntoView({ block: "center" });
                      modelInputRef.current.focus();
                    }}
                    onDetach={() => mutatePin({ kind: "detach" })}
                    onSelectRevision={(templateRevisionId) => mutatePin({ kind: "retarget", templateRevisionId })}
                    onEdit={editPinnedSource}
                  />
                ),
              }
            : {})}
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
          headerLeading={run && <CopyRunLink workspace={session.traceWorkspace} runId={run.runId} saved={session.traceStorage?.kind === "saved"} />}
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
    replacementBlockedReason: run && !isTerminalRunState(run) ? "Finish or stop the current decision run before switching projects." : undefined,
    compose,
    capture,
    useTemplate(project, templateId, revisionId) {
      if (session.executing) return;
      if (record) {
        // Q2: a new local request pinned to the prompt; Save names it.
        const start = () => {
          if (!record.startNew({ kind: "template-use", templateId, templateRevisionId: revisionId, overrides: {} })) return;
          session.reset();
          options.onTemplateUsed?.();
        };
        if (draft.touched && !("input" in validated)) {
          options.requestConfirmation({
            title: "Discard incomplete decision request?",
            description: "The current request has invalid edits that cannot be saved. Discard them to use this saved revision.",
            confirmLabel: "Discard and use revision",
            destructive: true,
            onConfirm: start,
          });
        } else {
          start();
        }
        return;
      }
      const apply = (discard: boolean) => {
        const folded = discard ? project : decisionProject.fold(project);
        adoptMutation(createDecisionTemplateUse(folded, { templateId, templateRevisionId: revisionId }));
        options.onTemplateUsed?.();
      };
      if (draft.touched && !("input" in validated)) {
        options.requestConfirmation({
          title: "Discard incomplete decision request?",
          description: "The current request has invalid edits that cannot be saved. Discard them to use this saved revision.",
          confirmLabel: "Discard and use revision",
          destructive: true,
          onConfirm: () => apply(true),
        });
      } else {
        apply(false);
      }
    },
    returnToRevision(id) {
      const project = options.project;
      if (record) {
        // The source was opened from this record: a local one, or a draft of `id`.
        if (!id || localRecord?.revision?.id === id) return true;
        if (!project?.decisionRequestRevisions.some((entry) => entry.id === id)) return false;
        record.selectSaved(id);
        session.reset();
        return true;
      }
      if (!id || !project || !project.decisionRequestRevisions.some((entry) => entry.id === id)) return false;
      if (project.defaults.decisionRequestRevisionId === id) return true;
      adoptMutation({ ...project, defaults: { ...project.defaults, decisionRequestRevisionId: id } });
      return true;
    },
    connection: { profiles: target.profiles, profile: target.profile, selectProfile: target.selectProfile },
    adoptTrace: session.adoptTrace,
    suiteSource,
    project: {
      fold: decisionProject.fold,
      ...(decisionProject.saveBlockedReason ? { saveBlockedReason: decisionProject.saveBlockedReason } : {}),
      adopt(project) {
        session.reset();
        decisionProject.adopt(project);
        if (record) recordSync.resync();
      },
      // A personal session's editor follows its record, which follows the project.
      refresh: decisionProject.adopt,
    },
  };
}

interface ActivePin {
  templateId: PromptTemplateId;
  templateRevisionId: PromptTemplateRevisionId;
  overrides: Record<string, string>;
  /** Keys a dismissed model warning: the request, or the local record. */
  warningKey: string;
  resolved?: { variables: string[]; values: Record<string, string> };
}

function activePin(project: ProjectFile | null, record: DecisionRequestRecordHandle | undefined): ActivePin | undefined {
  if (!project) return undefined;
  if (record) {
    const selected = record.record;
    const content = selected?.content;
    if (content?.kind !== "template-use") return undefined;
    const warningKey = selected?.kind === "scratch"
      ? selected.scratch.scratchId
      : selected?.kind === "draft" ? selected.draft.asset.id : selected!.revision!.decisionRequestId;
    const resolved = resolveDecisionContent(project, content);
    return {
      templateId: content.templateId as PromptTemplateId,
      templateRevisionId: content.templateRevisionId as PromptTemplateRevisionId,
      overrides: content.overrides,
      warningKey,
      ...(resolved ? { resolved } : {}),
    };
  }
  const active = activeDecisionRequestRevision(project);
  if (active?.kind !== "template-use") return undefined;
  // A pin whose prompt is gone resolves to nothing rather than throwing.
  let resolved: ReturnType<typeof resolveProjectDecisionRequestRevision>;
  try {
    resolved = resolveProjectDecisionRequestRevision(project, active.id);
  } catch {
    resolved = undefined;
  }
  return {
    templateId: active.templateId,
    templateRevisionId: active.templateRevisionId,
    overrides: active.overrides,
    warningKey: active.decisionRequestId,
    ...(resolved ? { resolved } : {}),
  };
}
