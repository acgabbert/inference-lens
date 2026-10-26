import type { PromptTemplate } from "../../packages/core/src/project";
import type { PromptTemplateId } from "../../packages/core/src/run-kernel";

export type PromptLibraryStatus = "active" | "archived";
export type PromptLibraryKind = "all" | PromptTemplate["kind"];

export interface PromptLibraryFilters {
  status: PromptLibraryStatus;
  kind: PromptLibraryKind;
  search: string;
}

type LibraryEntry = Pick<PromptTemplate, "id" | "kind" | "name" | "archivedAt">;

function hasStatus(entry: LibraryEntry, status: PromptLibraryStatus): boolean {
  return status === "archived" ? Boolean(entry.archivedAt) : !entry.archivedAt;
}

/** The entries the library list shows, in project order. */
export function filterPromptLibrary<T extends LibraryEntry>(
  templates: readonly T[],
  filters: PromptLibraryFilters,
): T[] {
  const search = filters.search.toLocaleLowerCase();
  return templates.filter(
    (entry) =>
      hasStatus(entry, filters.status) &&
      (filters.kind === "all" || entry.kind === filters.kind) &&
      entry.name.toLocaleLowerCase().includes(search),
  );
}

/**
 * The entry the editor shows: the chosen one while it is visible, otherwise
 * the first visible entry, so the editor never contradicts the list.
 */
export function selectPromptLibraryEntry<T extends LibraryEntry>(
  visible: readonly T[],
  selectedId: PromptTemplateId | undefined,
): T | undefined {
  return visible.find(({ id }) => id === selectedId) ?? visible[0];
}

/**
 * Why nothing is visible: an empty status, or filters that exclude every
 * entry of that status.
 */
export function describeEmptyPromptLibrary(
  templates: readonly LibraryEntry[],
  filters: PromptLibraryFilters,
): { heading: string; list: string } {
  if (templates.some((entry) => hasStatus(entry, filters.status))) {
    return { heading: "No matching prompts", list: "No prompts match these filters." };
  }
  return filters.status === "active"
    ? { heading: "No active project prompts", list: "Create a project-owned prompt." }
    : { heading: "No archived prompts", list: "Archived prompts will appear here." };
}

/** Names are not identities, but two entries sharing one confuse the library. */
export function hasDuplicatePromptName(
  templates: readonly LibraryEntry[],
  templateId: PromptTemplateId | undefined,
  name: string,
): boolean {
  const normalized = name.trim().toLocaleLowerCase();
  return Boolean(normalized) && templates.some(
    (entry) => entry.id !== templateId && entry.name.trim().toLocaleLowerCase() === normalized,
  );
}
