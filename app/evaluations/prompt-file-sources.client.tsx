import type { ExperimentPlan } from "../../packages/core/src/experiment.ts";

/**
 * Names each linked prompt an evaluation read from its file (E4), beside the
 * revision it replaced, so a CI-produced plan opened here is not mistaken for
 * a run of the saved revision. Renders nothing for an ordinary plan.
 */
export function PromptFileSources({ plan }: { plan: ExperimentPlan }) {
  if (plan.kind !== "evaluation" || !plan.suite.promptSources?.length) return null;
  const names = new Map<string, string>();
  for (const evaluationCase of plan.suite.cases) {
    for (const input of evaluationCase.inputs) {
      for (const { templateId, templateName } of input.templateResolutions) names.set(templateId, templateName);
    }
  }
  return (
    <section aria-label="Prompts read from files" className="evaluation-prompt-file-sources">
      <p>Prompts read from files for this run; their saved revisions were not sent:</p>
      <ul>
        {plan.suite.promptSources.map((source) => (
          <li key={source.templateId}>
            {names.get(source.templateId) ?? source.templateId} ← {source.sourceRootName}/{source.path} · digest{" "}
            {source.sourceDigest.slice(0, 12)} · in place of {source.baseTemplateRevisionId}
            {source.replacedLocalRevisions ? ", a revision not pulled from the file" : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
