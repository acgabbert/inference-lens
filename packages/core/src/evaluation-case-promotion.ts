import type { EvaluationCase, EvaluationSuite } from "./evaluation-suites.ts";
import { parseProjectFile, ProjectValidationError } from "./project.ts";
import type { ProjectFile } from "./project.ts";
import { randomUUID } from "./random-id.ts";
import { createEntityId } from "./run-kernel/types.ts";
import type {
  EvaluationCaseId,
  EvaluationInputBindingId,
  EvaluationSuiteId,
  RunTrace,
} from "./run-kernel/types.ts";

export type EvaluationCasePromotionIncompatibility =
  | { kind: "revision-mismatch"; expectedRevisionId: string; traceRevisionId: string }
  | { kind: "missing-template-use"; inputBindingId: EvaluationInputBindingId; templateUseId: string }
  | { kind: "missing-template-value"; inputBindingId: EvaluationInputBindingId; templateUseId: string; variableName: string };

export type EvaluationCasePromotionCompatibility =
  | { ok: true; values: EvaluationCase["values"] }
  | { ok: false; incompatibilities: EvaluationCasePromotionIncompatibility[] };

/**
 * Projects the exact template-use values captured by a terminal trace onto a
 * suite's bindings. This intentionally never looks at rendered messages:
 * messages are lossy evidence, while template provenance identifies both the
 * use occurrence and the variable that supplied each value.
 */
export function evaluationCasePromotionCompatibility(
  suite: Pick<EvaluationSuite, "input" | "inputBindings">,
  trace: Pick<RunTrace, "input">,
): EvaluationCasePromotionCompatibility {
  if (suite.input.conversationRevisionId !== trace.input.conversationRevisionId) {
    return {
      ok: false,
      incompatibilities: [{
        kind: "revision-mismatch",
        expectedRevisionId: suite.input.conversationRevisionId,
        traceRevisionId: trace.input.conversationRevisionId,
      }],
    };
  }
  const resolutions = new Map(trace.input.templateResolutions.map((resolution) => [resolution.templateUseId, resolution]));
  const values: Record<EvaluationInputBindingId, string> = {} as Record<EvaluationInputBindingId, string>;
  const incompatibilities: EvaluationCasePromotionIncompatibility[] = [];
  suite.inputBindings.forEach((binding) => {
    const resolution = resolutions.get(binding.target.templateUseId);
    if (!resolution) {
      incompatibilities.push({
        kind: "missing-template-use",
        inputBindingId: binding.id,
        templateUseId: binding.target.templateUseId,
      });
      return;
    }
    if (!Object.hasOwn(resolution.values, binding.target.variableName)) {
      incompatibilities.push({
        kind: "missing-template-value",
        inputBindingId: binding.id,
        templateUseId: binding.target.templateUseId,
        variableName: binding.target.variableName,
      });
      return;
    }
    values[binding.id] = resolution.values[binding.target.variableName]!;
  });
  return incompatibilities.length === 0
    ? { ok: true, values }
    : { ok: false, incompatibilities };
}

function uniqueCaseName(base: string, cases: readonly EvaluationCase[]): string {
  const occupied = new Set(cases.map(({ name }) => name.trim().toLocaleLowerCase()));
  if (!occupied.has(base.trim().toLocaleLowerCase())) return base;
  for (let number = 2; ; number += 1) {
    const candidate = `${base} ${number}`;
    if (!occupied.has(candidate.trim().toLocaleLowerCase())) return candidate;
  }
}

export interface PromoteTraceToEvaluationCaseOptions {
  suiteId: EvaluationSuiteId;
  trace: Pick<RunTrace, "input">;
  name: string;
  caseIdSuffix?: string;
}

/** Creates ordinary portable suite content; source evidence is deliberately separate. */
export function promoteTraceToEvaluationCase(
  project: ProjectFile,
  { suiteId, trace, name, caseIdSuffix = randomUUID() }: PromoteTraceToEvaluationCaseOptions,
): { project: ProjectFile; caseId: EvaluationCaseId; values: EvaluationCase["values"] } {
  const suite = project.evaluationSuites.find(({ id }) => id === suiteId);
  if (!suite) throw new ProjectValidationError([{ code: "custom", path: ["evaluationSuites", suiteId], message: "The selected evaluation suite no longer exists." }]);
  const compatible = evaluationCasePromotionCompatibility(suite, trace);
  if (!compatible.ok) {
    throw new ProjectValidationError([{ code: "custom", path: ["evaluationSuites", suiteId], message: "This trace is not compatible with the selected evaluation suite." }]);
  }
  const trimmedName = name.trim();
  if (!trimmedName) throw new ProjectValidationError([{ code: "custom", path: ["evaluationSuites", suiteId, "cases"], message: "A promoted case needs a name." }]);
  const caseId = createEntityId("evaluation-case", caseIdSuffix);
  const evaluationCase: EvaluationCase = { id: caseId, name: uniqueCaseName(trimmedName, suite.cases), values: compatible.values, checks: [] };
  return {
    caseId,
    values: compatible.values,
    project: parseProjectFile({
      ...project,
      evaluationSuites: project.evaluationSuites.map((item) => item.id === suiteId
        ? { ...item, cases: [...item.cases, evaluationCase] }
        : item),
    }),
  };
}
