"use client";

import { useRef, useState } from "react";
import { diffDecisionPromptTemplateRevisions } from "../../packages/core/src/decision-template-revision-diff";
import { discoverDecisionVariables } from "../../packages/core/src/decision-variables";
import type { DecisionPromptTemplate } from "../../packages/core/src/project";
import type { PromptTemplateRevisionId } from "../../packages/core/src/run-kernel";
import { DecisionRevisionDiff } from "../templates/decision-revision-diff.client";
import {
  promptRevisionLabel,
  summarizeDecisionRevisionDiff,
  summarizeRevisionVariableChanges,
} from "../templates/prompt-revision-label";
import { PromptModelRecommendation } from "../templates/prompt-model-recommendation.client";
import { PinnedRevisionSelect, RevisionSwitchReview } from "../templates/revision-switch-review.client";

export interface DecisionTemplateRecommendation {
  model: string;
  connectionName: string;
  compatibleConnectionNames: string[];
  matchesSelectedConnection: boolean;
}

function recommendationText(recommendation: DecisionTemplateRecommendation): string {
  if (recommendation.matchesSelectedConnection) return "";
  if (recommendation.compatibleConnectionNames.length === 0) {
    return `No System One connection on this device matches ${recommendation.connectionName}.`;
  }
  return `Available on ${recommendation.compatibleConnectionNames.join(", ")}. Choose it in Target to use the recommendation.`;
}

/** The pinned source of a template-backed decision request in Compose. */
export function DecisionTemplateUse({
  template,
  revisionId,
  overrideNames,
  locked,
  recommendation,
  selectedModel,
  modelWarningDismissed,
  onDismissModelWarning,
  onChooseModel,
  onEdit,
  onSelectRevision,
  onDetach,
}: {
  template: DecisionPromptTemplate;
  revisionId: PromptTemplateRevisionId;
  /** Variables Compose currently overrides; a switch clears those the target lacks. */
  overrideNames: readonly string[];
  locked: boolean;
  recommendation?: DecisionTemplateRecommendation;
  selectedModel: string;
  modelWarningDismissed: boolean;
  onDismissModelWarning(): void;
  onChooseModel(): void;
  onEdit(): void;
  /** Re-pins the request; the card has already shown the switch review. */
  onSelectRevision(revisionId: PromptTemplateRevisionId): void;
  onDetach(): void;
}) {
  const [switchTargetId, setSwitchTargetId] = useState<PromptTemplateRevisionId>();
  const revisionSelect = useRef<HTMLSelectElement>(null);
  const pinned = template.revisions.find(({ id }) => id === revisionId)!;
  const switchTarget = template.revisions.find(({ id }) => id === switchTargetId);

  function closeReview(): void {
    setSwitchTargetId(undefined);
    revisionSelect.current?.focus();
  }

  return (
    <section className="decision-template-use" aria-label="Saved decision prompt">
      <div className="decision-template-use-heading">
        <strong>{template.name}</strong>
        <PinnedRevisionSelect
          template={template}
          revisionId={revisionId}
          disabled={locked || Boolean(template.archivedAt)}
          selectRef={revisionSelect}
          onSelect={setSwitchTargetId}
        />
        {template.archivedAt && <span>Archived</span>}
      </div>
      {recommendation && <PromptModelRecommendation
        recommendedModel={recommendation.model}
        selectedModel={selectedModel}
        connectionName={recommendation.connectionName}
        connectionAdvice={recommendationText(recommendation)}
        dismissed={modelWarningDismissed}
        disabled={locked}
        onDismiss={onDismissModelWarning}
        onChooseModel={onChooseModel}
      />}
      <p>Content is pinned. Values below remain editable.</p>
      <div className="decision-row-actions">
        <button className="text-button" disabled={locked} type="button" onClick={onEdit}>
          Edit source
        </button>
        <button className="text-button" disabled={locked} type="button" onClick={onDetach}>
          Detach
        </button>
      </div>
      {switchTarget && (
        <RevisionSwitchReview
          title={`Switch "${template.name}"`}
          fromLabel={promptRevisionLabel(template, pinned.id)}
          toLabel={promptRevisionLabel(template, switchTarget.id)}
          changes={summarizeRevisionVariableChanges({
            before: { variables: discoverDecisionVariables(pinned.decision).variables, defaults: pinned.variableDefaults },
            after: { variables: discoverDecisionVariables(switchTarget.decision).variables, defaults: switchTarget.variableDefaults },
            kept: overrideNames,
          })}
          diffSummary={summarizeDecisionRevisionDiff(diffDecisionPromptTemplateRevisions(pinned, switchTarget))}
          locked={locked}
          onCancel={closeReview}
          onConfirm={() => {
            setSwitchTargetId(undefined);
            onSelectRevision(switchTarget.id);
          }}
        >
          <DecisionRevisionDiff diff={diffDecisionPromptTemplateRevisions(pinned, switchTarget)} />
        </RevisionSwitchReview>
      )}
    </section>
  );
}
