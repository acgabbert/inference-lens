/**
 * The request switcher's entries (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md,
 * "Step 5 decisions", T1), for chat and decision requests alike. One entry per
 * saved request opens its draft if one exists, otherwise its newest revision;
 * its revisions are listed newest first for the per-request disclosure; local
 * scratches form their own group, labelled by their parent. Pure.
 */

/** What picking an entry selects. */
export type RequestMenuTarget =
  | { kind: "saved"; revisionId: string }
  | { kind: "draft"; draftId: string }
  | { kind: "scratch"; scratchId: string };

export interface RequestMenuInput {
  requests: readonly { id: string; name: string }[];
  /** In file order; `requestId` names the owning request. */
  revisions: readonly { id: string; requestId: string; createdAt: string }[];
  launchRevisionId: string | undefined;
  /** The request's one active draft (D6), with its base. */
  draftFor(requestId: string): { draftId: string; baseRevisionId: string } | undefined;
  scratches: readonly {
    scratchId: string;
    createdAt: string;
    branched: boolean;
    /** The nearest saved ancestor, when the parent chain reaches one. */
    savedAncestorRevisionId?: string;
  }[];
  /** What is selected now, after launch-default fallback. */
  selected: RequestMenuTarget | undefined;
}

export interface RequestMenuRevision {
  revisionId: string;
  /** 1 is the oldest. */
  ordinal: number;
  launchDefault: boolean;
}

export interface RequestMenuRequest {
  requestId: string;
  name: string;
  open: RequestMenuTarget;
  launchDefault: boolean;
  draft?: { draftId: string; baseRevisionId: string };
  /** Newest first. */
  revisions: RequestMenuRevision[];
}

export interface RequestMenuScratch {
  scratchId: string;
  label: string;
}

export interface RequestMenu {
  requests: RequestMenuRequest[];
  scratches: RequestMenuScratch[];
  /** `request:<id>`, `scratch:<id>`, or undefined when nothing is selected. */
  selectedKey: string | undefined;
  /** Within the selected request: `draft` or a revision ID. */
  selectedRevisionKey: string | undefined;
}

export function requestMenu(input: RequestMenuInput): RequestMenu {
  const ordered = input.revisions
    .map((revision, index) => ({ revision, index }))
    .sort((left, right) => left.revision.createdAt.localeCompare(right.revision.createdAt) || left.index - right.index)
    .map(({ revision }) => revision);
  const requestOfRevision = new Map(input.revisions.map(({ id, requestId }) => [id, requestId]));
  const requests: RequestMenuRequest[] = [];
  for (const request of input.requests) {
    const own = ordered.filter(({ requestId }) => requestId === request.id);
    const draft = input.draftFor(request.id);
    const newest = own.at(-1);
    if (!newest && !draft) continue;
    requests.push({
      requestId: request.id,
      name: request.name,
      open: draft ? { kind: "draft", draftId: draft.draftId } : { kind: "saved", revisionId: newest!.id },
      launchDefault: own.some(({ id }) => id === input.launchRevisionId),
      ...(draft ? { draft } : {}),
      revisions: own
        .map((revision, index) => ({ revisionId: revision.id, ordinal: index + 1, launchDefault: revision.id === input.launchRevisionId }))
        .reverse(),
    });
  }

  const nameOf = (revisionId: string | undefined) => {
    const requestId = revisionId ? requestOfRevision.get(revisionId) : undefined;
    return requestId ? input.requests.find(({ id }) => id === requestId)?.name : undefined;
  };
  const counts = new Map<string, number>();
  const scratches = [...input.scratches]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((scratch) => {
      const parentName = nameOf(scratch.savedAncestorRevisionId);
      const base = parentName
        ? `${scratch.branched ? "Branch of" : "Local copy of"} ${parentName}`
        : scratch.branched ? "Unsaved branch" : "New request";
      const count = (counts.get(base) ?? 0) + 1;
      counts.set(base, count);
      return { scratchId: scratch.scratchId, base, count };
    })
    .map(({ scratchId, base, count }) => ({
      scratchId,
      label: (counts.get(base) ?? 0) > 1 ? `${base} (${count})` : base,
    }));

  let selectedKey: string | undefined;
  let selectedRevisionKey: string | undefined;
  const selected = input.selected;
  if (selected?.kind === "scratch") {
    selectedKey = `scratch:${selected.scratchId}`;
  } else if (selected?.kind === "draft") {
    const owner = requests.find(({ draft }) => draft?.draftId === selected.draftId);
    if (owner) {
      selectedKey = `request:${owner.requestId}`;
      selectedRevisionKey = "draft";
    }
  } else if (selected?.kind === "saved") {
    const requestId = requestOfRevision.get(selected.revisionId);
    if (requestId) {
      selectedKey = `request:${requestId}`;
      selectedRevisionKey = selected.revisionId;
    }
  }
  return { requests, scratches, selectedKey, selectedRevisionKey };
}
