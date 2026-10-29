/**
 * What the environment editor says about a draft before it is saved. The
 * project parser applies the same rules; running them here lets the editor
 * point at the field instead of refusing the save as a whole.
 */

import {
  environmentIssues,
  resolveEnvironment,
} from "../../packages/core/src/environment.ts";
import type {
  ProjectEnvironment,
  ResolvedEnvironment,
} from "../../packages/core/src/environment.ts";

export interface EnvironmentDraftIssues {
  name?: string;
  /** By entry index. */
  entries: Record<number, { name?: string; value?: string }>;
  /** Rules about the environment as a whole, such as its entry count. */
  general: string[];
  count: number;
}

/**
 * The draft's issues among the project's environments, with the draft in
 * place of its saved copy. It is checked last: a duplicate name is reported
 * on its second occurrence, and the draft is the one being renamed.
 */
export function environmentDraftIssues(
  environments: readonly ProjectEnvironment[],
  draft: ProjectEnvironment,
): EnvironmentDraftIssues {
  const others = environments.filter(({ id }) => id !== draft.id);
  const isNew = others.length === environments.length;
  const draftIndex = others.length;
  const result: EnvironmentDraftIssues = { entries: {}, general: [], count: 0 };
  for (const { path, message } of environmentIssues([...others, draft])) {
    if (path.length === 0) {
      // Only a new draft can push the project over its environment limit.
      if (!isNew) continue;
      result.general.push(message);
    } else if (path[0] !== draftIndex) {
      continue;
    } else if (path[1] === "name") {
      result.name ??= message;
    } else if (path.length === 2) {
      result.general.push(message);
    } else {
      const entryIndex = path[2] as number;
      const field = path[3] as "name" | "value";
      const entry = (result.entries[entryIndex] ??= {});
      entry[field] ??= message;
    }
    result.count += 1;
  }
  return result;
}

/** The resolved entries, once the draft has no issues that make resolving it meaningless. */
export function environmentDraftPreview(draft: ProjectEnvironment): ResolvedEnvironment | undefined {
  if (environmentIssues([draft]).length > 0) return undefined;
  return resolveEnvironment(draft);
}

export function newEnvironmentName(environments: readonly ProjectEnvironment[]): string {
  const taken = new Set(environments.map(({ name }) => name.trim().toLowerCase()));
  let number = 1;
  while (taken.has(`environment ${number}`)) number += 1;
  return `Environment ${number}`;
}
