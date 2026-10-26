import { discoverDecisionVariables } from "./decision-variables.ts";
import {
  decisionRequestRevisionIdFor,
  retainedDecisionOverrides,
  updateDecisionRequestTemplateRevision,
  useDecisionPromptTemplateRevision as createDecisionTemplateUse,
} from "./decision-request.ts";
import { createDecisionEvaluationSuite, updateDecisionSuiteInput } from "./evaluation-suite-authoring.ts";
import { decisionSuitePreflight, isDecisionEvaluationSuite } from "./evaluation-suites.ts";
import type { DecisionEvaluationSuite, EvaluationSuitePreflightDiagnostic } from "./evaluation-suites.ts";
import type { ProjectFile } from "./project.ts";
import { randomUUID } from "./random-id.ts";
import type { EvaluationSuiteId, PromptTemplateId, PromptTemplateRevisionId } from "./run-kernel/types.ts";

export interface DecisionTemplateEvaluationSuite {
  suite: DecisionEvaluationSuite;
  pinnedRevisionId: PromptTemplateRevisionId;
}

/** Compatibility means the same source template, not that every check already passes preflight. */
export function decisionTemplateEvaluationSuites(project: ProjectFile, templateId: PromptTemplateId): DecisionTemplateEvaluationSuite[] {
  return project.evaluationSuites.flatMap((suite) => {
    if (!isDecisionEvaluationSuite(suite)) return [];
    const revision = project.decisionRequestRevisions.find(({ id }) => id === suite.input.decisionRequestRevisionId);
    return revision?.kind === "template-use" && revision.templateId === templateId
      ? [{ suite, pinnedRevisionId: revision.templateRevisionId }] : [];
  });
}

interface TemplatePin {
  templateId: PromptTemplateId;
  templateRevisionId: PromptTemplateRevisionId;
}

/** No target recommendation is applied; the suite's ordinary Setup owns target selection. */
export function createDecisionTemplateEvaluation(project: ProjectFile, options: TemplatePin, suffix = randomUUID) {
  const idSuffix = suffix();
  const withRequest = createDecisionTemplateUse(project, { ...options, idSuffix, activate: false });
  return createDecisionEvaluationSuite(withRequest, {
    decisionRequestRevisionId: decisionRequestRevisionIdFor(idSuffix),
    model: project.defaults.target.model,
  }, suffix);
}

export interface RetargetDecisionTemplateEvaluationOptions extends TemplatePin {
  suiteId: EvaluationSuiteId;
  idSuffix?: string;
  createdAt?: string;
}

function retargetSource(project: ProjectFile, options: RetargetDecisionTemplateEvaluationOptions) {
  const template = project.promptTemplates.find(({ id }) => id === options.templateId);
  if (!template || template.kind !== "decision") throw new Error("The decision template no longer exists.");
  const target = template.revisions.find(({ id }) => id === options.templateRevisionId);
  if (!target) throw new Error("The saved decision template revision no longer exists.");
  const suite = project.evaluationSuites.find(({ id }) => id === options.suiteId);
  if (!suite || !isDecisionEvaluationSuite(suite)) throw new Error("Choose a decision suite that uses this saved prompt.");
  const parent = project.decisionRequestRevisions.find(({ id }) => id === suite.input.decisionRequestRevisionId);
  if (parent?.kind !== "template-use" || parent.templateId !== template.id) throw new Error("That suite does not use this saved decision prompt.");
  const pinned = template.revisions.find(({ id }) => id === parent.templateRevisionId);
  if (!pinned) throw new Error("The suite's pinned decision template revision no longer exists.");
  return { template, target, suite, parent, pinned };
}

export interface DecisionTemplateEvaluationRetargetPreview {
  changes: string[];
  /** Checks and inputs the retarget leaves needing repair, over all cases, including unselected ones. */
  diagnostics: EvaluationSuitePreflightDiagnostic[];
  /** Repairs the suite already needed on its current pin; the retarget neither causes nor fixes them. */
  existingDiagnostics: EvaluationSuitePreflightDiagnostic[];
}

/** Authoring gaps (no cases, no checks) are Setup's to report, not the retarget's. */
function retargetDiagnostics(project: ProjectFile, suite: DecisionEvaluationSuite) {
  return decisionSuitePreflight(project, suite).filter(({ code }) => code !== "empty-suite" && code !== "no-checks");
}

/** A read-only projection through the same resolver and preflight used when the suite runs. */
export function previewDecisionTemplateEvaluationRetarget(project: ProjectFile, options: RetargetDecisionTemplateEvaluationOptions): DecisionTemplateEvaluationRetargetPreview {
  const { suite, parent, pinned, target } = retargetSource(project, options);
  const before = discoverDecisionVariables(pinned.decision).variables;
  const after = discoverDecisionVariables(target.decision).variables;
  const changes = [
    ...before.filter((name) => !after.includes(name)).map((name) => `Removed variable "${name}". Its case data is retained; any request override is removed from the new request revision.`),
    ...after.filter((name) => !before.includes(name)).map((name) => `Added variable "${name}". Supply a default or case input if it is unfilled.`),
    ...Object.entries(pinned.decision.questions).flatMap(([id, question]) => {
      const next = Object.hasOwn(target.decision.questions, id) ? target.decision.questions[id] : undefined;
      if (!next) return [`Removed question "${id}". Checks that name it need repair.`];
      return next.type !== question.type ? [`Question "${id}" changed from ${question.type} to ${next.type}.`] : [];
    }),
    ...Object.keys(target.decision.questions).filter((id) => !Object.hasOwn(pinned.decision.questions, id)).map((id) => `Added question "${id}".`),
  ];
  // Project only the new pin, without allocating IDs or mutating the original.
  // Resolution still merges defaults/overrides and preflight still validates checks.
  const projected: ProjectFile = { ...project, decisionRequestRevisions: project.decisionRequestRevisions.map((revision) => revision.id === parent.id
    ? { ...parent, templateRevisionId: target.id, overrides: retainedDecisionOverrides(parent.overrides, target.decision) }
    : revision) };
  const existing = new Set(retargetDiagnostics(project, suite).map((diagnostic) => JSON.stringify(diagnostic)));
  const projectedDiagnostics = retargetDiagnostics(projected, suite);
  return {
    changes,
    diagnostics: projectedDiagnostics.filter((diagnostic) => !existing.has(JSON.stringify(diagnostic))),
    existingDiagnostics: projectedDiagnostics.filter((diagnostic) => existing.has(JSON.stringify(diagnostic))),
  };
}

/** Deliberate retargeting preserves case/check data for repair and never moves Compose. */
export function retargetDecisionTemplateEvaluation(project: ProjectFile, options: RetargetDecisionTemplateEvaluationOptions): ProjectFile {
  const { parent, target } = retargetSource(project, options);
  if (parent.templateRevisionId === target.id) return project;
  const idSuffix = options.idSuffix ?? randomUUID();
  const updated = updateDecisionRequestTemplateRevision(project, {
    decisionRequestRevisionId: parent.id, templateRevisionId: target.id, idSuffix,
    ...(options.createdAt ? { createdAt: options.createdAt } : {}), activate: false,
  });
  return updateDecisionSuiteInput(updated, options.suiteId, decisionRequestRevisionIdFor(idSuffix));
}
