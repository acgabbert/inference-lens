import type { DecisionQuestion } from "./decision.ts";
import type { DecisionPromptTemplateRevision } from "./project.ts";
import { diffLines, type TextDiff } from "./text-diff.ts";
import type { PromptTemplateVariableDefaultDiff, RevisionDiffStatus } from "./prompt-template-revision-diff.ts";

export interface DecisionTemplateQuestionDiff {
  id: string;
  status: RevisionDiffStatus;
  beforeIndex?: number;
  afterIndex?: number;
  before?: DecisionQuestion;
  after?: DecisionQuestion;
  typeChanged: boolean;
  instructions: TextDiff;
  criteria: TextDiff;
}

export interface DecisionTemplateRevisionDiff {
  identical: boolean;
  state: TextDiff;
  questionOrderChanged: boolean;
  questions: DecisionTemplateQuestionDiff[];
  variableDefaults: PromptTemplateVariableDefaultDiff[];
}

/** Authored JSON keeps key order, including structured state, instructions, and criteria. */
function authored(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

export function diffDecisionPromptTemplateRevisions(
  before: DecisionPromptTemplateRevision,
  after: DecisionPromptTemplateRevision,
): DecisionTemplateRevisionDiff {
  const state = diffLines(authored(before.decision.state), authored(after.decision.state));
  const leftIds = Object.keys(before.decision.questions);
  const rightIds = Object.keys(after.decision.questions);
  const questionOrderChanged = JSON.stringify(leftIds) !== JSON.stringify(rightIds);
  const questions = [...new Set([...leftIds, ...rightIds])].map((id): DecisionTemplateQuestionDiff => {
    const left = before.decision.questions[id];
    const right = after.decision.questions[id];
    const beforeIndex = left ? leftIds.indexOf(id) : undefined;
    const afterIndex = right ? rightIds.indexOf(id) : undefined;
    const typeChanged = left !== undefined && right !== undefined && left.type !== right.type;
    const instructions = diffLines(authored(left?.instructions), authored(right?.instructions));
    const criteria = diffLines(authored(left?.criteria), authored(right?.criteria));
    return { id, beforeIndex, afterIndex, before: left && structuredClone(left), after: right && structuredClone(right),
      typeChanged, instructions, criteria,
      status: !left ? "added" : !right ? "removed"
        : typeChanged || beforeIndex !== afterIndex || !instructions.identical || !criteria.identical ? "changed" : "identical" };
  });
  const variableDefaults = [...new Set([...Object.keys(before.variableDefaults), ...Object.keys(after.variableDefaults)])]
    .sort().map((name): PromptTemplateVariableDefaultDiff => {
      const left = before.variableDefaults[name];
      const right = after.variableDefaults[name];
      return { name, before: left, after: right,
        status: left === right ? "identical" : left === undefined ? "added" : right === undefined ? "removed" : "changed" };
    });
  return { identical: state.identical && !questionOrderChanged && questions.every(({ status }) => status === "identical")
    && variableDefaults.every(({ status }) => status === "identical"), state, questionOrderChanged, questions, variableDefaults };
}
