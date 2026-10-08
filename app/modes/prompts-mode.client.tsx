"use client";

import type { ProjectFile } from "../../packages/core/src/project";
import type { PromptTemplateId } from "../../packages/core/src/run-kernel";
import type { EvaluationSuiteAuthoringHandle } from "../evaluations/use-evaluation-suite-authoring.client";
import { ProjectTemplatesPane } from "../project-templates-pane.client";
import type { CompatibleEvaluationSuite } from "../project-templates-pane.client";
import type { PromptNavigation } from "../templates/use-prompt-navigation.client";
import type { ProjectTemplatesHandle } from "../templates/use-project-templates.client";

interface PromptsModeProps {
  project?: ProjectFile;
  templates: ProjectTemplatesHandle;
  /** Conversation length when there is no project revision to count. */
  draftMessageCount: number;
  persistence: { autoSaveFailed: boolean; folderBacked: boolean; dirty: boolean };
  navigation: PromptNavigation;
  evaluations: Pick<
    EvaluationSuiteAuthoringHandle,
    "evaluatePromptRevision" | "selectSuite" | "savedPromptError" | "dismissPromptError"
  >;
  n8nImportDisabledReason?: string;
  focusRequested: boolean;
  onFocusHandled(): void;
  onOpenN8nImport(): void;
  /** A prompt was pinned into the conversation. */
  onInserted(): void;
  /** Back to the request use the source was opened from. */
  onReturn(): void;
  onRevisionEvaluationStarted(): void;
  onEvaluationSuiteOpened(): void;
}

function compatibleEvaluationSuitesByTemplate(
  project: ProjectFile | undefined,
): Map<PromptTemplateId, CompatibleEvaluationSuite[]> {
  const suitesByTemplate = new Map<PromptTemplateId, CompatibleEvaluationSuite[]>();
  project?.evaluationSuites.forEach((suite) => {
    const revision = project.conversationRevisions.find(
      ({ id }) => id === suite.input.conversationRevisionId,
    );
    revision?.items.forEach((item) => {
      if (item.kind !== "template-use") return;
      const current = suitesByTemplate.get(item.use.templateId) ?? [];
      suitesByTemplate.set(item.use.templateId, [
        ...current,
        { suite, pinnedRevisionId: item.use.templateRevisionId },
      ]);
    });
  });
  return suitesByTemplate;
}

export function PromptsMode({
  project,
  templates,
  draftMessageCount,
  persistence,
  navigation,
  evaluations,
  n8nImportDisabledReason,
  focusRequested,
  onFocusHandled,
  onOpenN8nImport,
  onInserted,
  onReturn,
  onRevisionEvaluationStarted,
  onEvaluationSuiteOpened,
}: PromptsModeProps) {
  const { target } = navigation;
  return (
    <section aria-label="Prompt authoring" className="prompt-mode-workspace">
      <ProjectTemplatesPane
        key={`${project?.projectId ?? "unsaved-project"}:${target?.key ?? 0}`}
        templates={templates.libraryTemplates ?? project?.promptTemplates ?? []}
        sessionTemplateIds={templates.sessionTemplateIds ?? new Set<PromptTemplateId>()}
        connectionRequirements={project?.connectionRequirements ?? []}
        defaultConnectionRequirementId={project?.defaults.target.connectionRequirementId}
        usageCounts={templates.templateUsageCounts}
        itemCount={templates.activeProjectRevision?.items.length ?? draftMessageCount}
        persistenceStatus={
          persistence.autoSaveFailed
            ? "error"
            : !persistence.folderBacked
              ? "session"
              : persistence.dirty
                ? "saving"
                : "saved"
        }
        {...(n8nImportDisabledReason ? { n8nImportDisabledReason } : {})}
        onOpenN8nImport={onOpenN8nImport}
        onCreate={templates.createProjectTemplate}
        onDraftChange={templates.updateProjectTemplateDraft}
        onRecommendedTargetChange={templates.updateProjectTemplateRecommendedTarget}
        onSave={templates.saveProjectTemplate}
        onSaveAndInsert={(...args) => {
          const revisionId = templates.saveAndInsertProjectTemplate(...args);
          if (revisionId) onInserted();
          return revisionId;
        }}
        onRename={templates.renameProjectTemplate}
        onArchive={templates.archiveProjectTemplate}
        onRestore={templates.restoreProjectTemplate}
        onInsert={(...args) => {
          templates.insertProjectTemplate(...args);
          onInserted();
        }}
        compatibleEvaluationSuitesByTemplate={compatibleEvaluationSuitesByTemplate(project)}
        onEvaluateRevision={(templateId, revisionId, suiteId) => {
          if (!evaluations.evaluatePromptRevision(templateId, revisionId, suiteId)) return false;
          onRevisionEvaluationStarted();
          return true;
        }}
        onOpenEvaluationSuite={(suiteId) => {
          evaluations.selectSuite(suiteId);
          onEvaluationSuiteOpened();
        }}
        {...(evaluations.savedPromptError
          ? { evaluateRevisionError: evaluations.savedPromptError }
          : {})}
        onDismissEvaluateRevisionError={evaluations.dismissPromptError}
        focusRequested={focusRequested}
        onFocusHandled={onFocusHandled}
        {...(target ? { navigationTarget: target } : {})}
        onSelectionChange={navigation.selectionChanged}
        {...(target?.returnTarget ? { returnLabel: "Back to request", onReturn } : {})}
      />
    </section>
  );
}
