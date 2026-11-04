"use client";

import { useEffect, useRef, useState } from "react";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import type { WorkbenchDecisionRequestContent } from "../../packages/core/src/personal-workbench.ts";
import { stableJsonValue } from "../../packages/core/src/stable-json.ts";
import { editedDecisionContent, resolveDecisionContent } from "./local-decision-request.ts";
import type { DecisionRequestRecordHandle } from "./use-decision-request-record.client.ts";
import type { DecisionDraftHandle } from "./use-decision-draft.client.ts";

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJsonValue(left ?? null)) === JSON.stringify(stableJsonValue(right ?? null));
}

/**
 * Keeps the decision editor and the selected personal record in step
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 4 decisions").
 *
 * - A valid edit becomes the record's content. An invalid one stays in the
 *   editor only, and the record keeps its last valid version (Q1).
 * - A record that changes outside the editor (Save, Discard, a new scratch,
 *   another selection) is loaded into the editor.
 *
 * `synced` is the content the editor last matched. An edit is written only
 * while the record still holds that content, so a stale editor never writes
 * over a record that changed under it.
 */
export function useDecisionRecordSync(input: {
  draft: DecisionDraftHandle;
  record: DecisionRequestRecordHandle | undefined;
  project: ProjectFile | null;
}): { resync(): void } {
  const { draft, project } = input;
  const record = input.record?.enabled ? input.record : undefined;
  const syncedRef = useRef<{ content: WorkbenchDecisionRequestContent | undefined; unresolved?: boolean } | undefined>(undefined);
  const [generation, setGeneration] = useState(0);
  const content = record?.record?.content;
  const contentKey = JSON.stringify(stableJsonValue(content ?? null));
  const enabled = Boolean(record && project);
  const ready = record?.ready ?? false;

  // Record → editor.
  useEffect(() => {
    if (!enabled || !project) {
      syncedRef.current = undefined;
      return;
    }
    const synced = syncedRef.current;
    if (synced && !synced.unresolved && same(synced.content, content)) return;
    if (!content) {
      draft.reset();
      syncedRef.current = { content: undefined };
      return;
    }
    const resolved = resolveDecisionContent(project, content);
    if (!resolved) {
      // A pin this project does not hold yet (a just-saved prompt) or any more.
      // Show nothing rather than stale content, and retry when the project changes.
      draft.reset();
      syncedRef.current = { content, unresolved: true };
      return;
    }
    draft.adopt(resolved.decision, resolved.values);
    syncedRef.current = { content };
    // `draft` is a new object each render; only the record and project matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, contentKey, project, generation]);

  // Editor → record.
  useEffect(() => {
    if (!enabled || !project || !record || !draft.touched || !ready) return;
    const synced = syncedRef.current;
    if (!synced || synced.unresolved || !same(synced.content, content)) return;
    const validated = draft.validated();
    if (!("input" in validated)) return;
    const next = editedDecisionContent(project, synced.content, { decision: validated.input, values: draft.values });
    if (!next || same(next, synced.content)) return;
    if (record.edit(next)) syncedRef.current = { content: next };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, draft.draft, draft.values, draft.touched, contentKey, ready]);

  return {
    resync() {
      syncedRef.current = undefined;
      setGeneration((current) => current + 1);
    },
  };
}
