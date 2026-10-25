"use client";

import { useState } from "react";

import { resolveProjectDecisionRequestRevision } from "../../packages/core/src/decision-request";
import type { ResolvedProjectDecisionRequestRevision } from "../../packages/core/src/decision-request";
import {
  addDecisionEvaluationInput,
  decisionBindingCandidates,
  updateDecisionEvaluationVariant,
  updateDecisionSuiteExecution,
  updateDecisionSuiteInput,
} from "../../packages/core/src/evaluation-suite-authoring";
import { isDecisionEvaluationSuite } from "../../packages/core/src/evaluation-suites";
import type { DecisionEvaluationSuite, DecisionExecutionTarget } from "../../packages/core/src/evaluation-suites";
import { ProjectValidationError } from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import type {
  ConnectionRequirementId,
  DecisionRequestRevisionId,
  EvaluationSuiteId,
  EvaluationVariantId,
} from "../../packages/core/src/run-kernel/types";
import { revisionTime } from "./revision-choice.client";

/** One saved decision request and its revisions, newest first. */
export interface DecisionRequestChoice {
  name: string;
  revisions: { revisionId: DecisionRequestRevisionId; label: string }[];
}

export interface DecisionSuiteSettingsHandle {
  suite: DecisionEvaluationSuite;
  /** Absent when the pinned revision was removed from the project. */
  pinnedRevision?: ResolvedProjectDecisionRequestRevision;
  requests: DecisionRequestChoice[];
  /** Variables of the pinned revision that no case input fills yet. */
  candidates: string[];
  error?: string;
  selectRevision(id: DecisionRequestRevisionId): void;
  setConnection(id: ConnectionRequirementId): void;
  setModel(model: string): void;
  setRepetitions(value: number): void;
  addInput(variableName: string): void;
  /** `model: undefined` removes the configuration's override, so it inherits the suite's. */
  updateVariant(id: EvaluationVariantId, patch: { name: string; model?: string }): void;
}

function message(cause: unknown): string {
  if (cause instanceof ProjectValidationError) return cause.issues[0]?.message ?? "The decision suite change is invalid.";
  return cause instanceof Error ? cause.message : "Could not update the decision suite.";
}

function requestChoices(project: ProjectFile): DecisionRequestChoice[] {
  return project.decisionRequests.map((request) => ({
    name: request.name,
    revisions: project.decisionRequestRevisions
      .filter(({ decisionRequestId }) => decisionRequestId === request.id)
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((revision) => ({
        revisionId: revision.id,
        label: `${revision.id === project.defaults.decisionRequestRevisionId ? "Current · " : ""}${revisionTime(revision.createdAt)}`,
      })),
  }));
}

/**
 * A decision suite's setup (D51): which request revision it pins, the target
 * it runs against, its repetitions, its case inputs, and each configuration's
 * model. The editor renders it; the shared case table, checks, and
 * configuration list stay with the suite authoring owner.
 */
export function useDecisionSuiteSettings(options: {
  project: ProjectFile | null;
  suiteId?: EvaluationSuiteId;
  adoptProjectMutation(project: ProjectFile): void;
}): DecisionSuiteSettingsHandle | undefined {
  const [storedError, setStoredError] = useState<{ suiteId: EvaluationSuiteId; message: string }>();
  const { project } = options;
  const found = project?.evaluationSuites.find(({ id }) => id === options.suiteId);
  if (!project || !found || !isDecisionEvaluationSuite(found)) return undefined;
  const suite = found;

  function commit(update: (current: ProjectFile) => ProjectFile): void {
    try {
      options.adoptProjectMutation(update(project!));
      setStoredError(undefined);
    } catch (cause) {
      setStoredError({ suiteId: suite.id, message: message(cause) });
    }
  }
  const setTarget = (target: Partial<DecisionExecutionTarget>) => commit((current) =>
    updateDecisionSuiteExecution(current, suite.id, { ...suite.execution, target: { ...suite.execution.target, ...target } }));

  const pinnedRevision = resolveProjectDecisionRequestRevision(project, suite.input.decisionRequestRevisionId);
  const error = storedError?.suiteId === suite.id ? storedError.message : undefined;
  return {
    suite,
    ...(pinnedRevision ? { pinnedRevision } : {}),
    requests: requestChoices(project),
    candidates: decisionBindingCandidates(project, suite),
    ...(error ? { error } : {}),
    selectRevision(id) {
      commit((current) => updateDecisionSuiteInput(current, suite.id, id));
    },
    setConnection(connectionRequirementId) {
      setTarget({ connectionRequirementId });
    },
    setModel(model) {
      setTarget({ model });
    },
    setRepetitions(repetitions) {
      commit((current) => updateDecisionSuiteExecution(current, suite.id, { ...suite.execution, repetitions }));
    },
    addInput(variableName) {
      commit((current) => addDecisionEvaluationInput(current, suite.id, variableName).project);
    },
    updateVariant(id, { name, model }) {
      const variant = suite.variants.find((candidate) => candidate.id === id);
      if (!variant) return;
      const target = { ...variant.overrides.target };
      if (model === undefined) delete target.model;
      else target.model = model;
      commit((current) => updateDecisionEvaluationVariant(current, suite.id, id, {
        name,
        overrides: Object.keys(target).length > 0 ? { target } : {},
      }));
    },
  };
}
