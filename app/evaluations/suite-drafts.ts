import { parseProjectFile } from "../../packages/core/src/project.ts";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import type { EvaluationSuite } from "../../packages/core/src/evaluation-suites.ts";
import type { EvaluationSuiteId } from "../../packages/core/src/run-kernel/types.ts";
import { stableJsonValue } from "../../packages/core/src/stable-json.ts";

/**
 * Slice 2c-1 (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Slice 2c decisions").
 * Suite owners keep mutating a whole project, as they did before drafts: the
 * project they are shown carries the user's suite drafts, and each mutation
 * is split between those drafts and the shared document.
 */

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

/** The shared project with each suite's draft in place of the saved suite. */
export function withSuiteDrafts(
  project: ProjectFile,
  draftFor: (id: EvaluationSuiteId) => EvaluationSuite | undefined,
): ProjectFile {
  let changed = false;
  const evaluationSuites = project.evaluationSuites.map((suite) => {
    const edited = draftFor(suite.id);
    if (!edited) return suite;
    changed = true;
    return edited;
  });
  return changed ? { ...project, evaluationSuites } : project;
}

export interface SuiteMutationRoute {
  /** The direct shared write, or undefined when nothing shared changed. */
  shared?: ProjectFile;
  /** Saved suites the mutation changed: each becomes or updates its draft (C1). */
  drafts: Array<{ base: EvaluationSuite; edited: EvaluationSuite }>;
  /** Saved suites the mutation deleted; their drafts go with them (C2). */
  removed: EvaluationSuiteId[];
}

/**
 * Splits `next`, a mutation of `view`, into suite drafts and a shared write.
 * A saved suite whose content changed goes to its draft. Creating and
 * deleting suites, and everything outside suite content (such as a new input
 * revision), stay direct shared writes (C2).
 */
export function routeSuiteMutation(shared: ProjectFile, view: ProjectFile, next: ProjectFile): SuiteMutationRoute {
  const saved = new Map(shared.evaluationSuites.map((suite) => [suite.id, suite]));
  const shown = new Map(view.evaluationSuites.map((suite) => [suite.id, suite]));
  const kept = new Set(next.evaluationSuites.map(({ id }) => id));
  const drafts = next.evaluationSuites.flatMap((suite) => {
    const base = saved.get(suite.id);
    return base && !same(suite, shown.get(suite.id)) ? [{ base, edited: suite }] : [];
  });
  const removed = shared.evaluationSuites.filter(({ id }) => !kept.has(id)).map(({ id }) => id);
  const sharedNext = { ...next, evaluationSuites: next.evaluationSuites.map((suite) => saved.get(suite.id) ?? suite) };
  return {
    // Validated: the saved suites now sit beside the mutation's other changes.
    ...(same(sharedNext, shared) ? {} : { shared: parseProjectFile(sharedNext) }),
    drafts,
    removed,
  };
}
