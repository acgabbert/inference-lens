"use client";
import { useMemo } from "react";
import { decisionRunFromTrace } from "../../packages/core/src/decision-trace.ts";
import type { DecisionRunTrace } from "../../packages/core/src/decision-trace.ts";
import { DecisionResponse } from "../decisions/decision-response.client.tsx";
import { DecisionInspect } from "../decisions/decision-inspect.client.tsx";

/** The saved decision renderer has no adoption, retry, provider or mutation port. */
export function SavedDecisionEvidence({ trace, fileName }: { trace: DecisionRunTrace; fileName: string }) {
  const run = useMemo(() => decisionRunFromTrace(trace), [trace]);
  return <>
    <DecisionResponse run={run} executing={false} traceStorage={{ kind: "saved", location: fileName }} emptyDetail="This trace has no decision result." onRetry={() => {}} onDiscard={() => {}} onSaveTrace={() => {}} />
    <DecisionInspect run={run} />
  </>;
}

import type { SavedRunTrace } from "../../packages/core/src/run-trace.ts";
import type { RunTrace } from "../../packages/core/src/run-kernel";
import type { ProjectWorkspaceHandle } from "../project-workspace.client.ts";
import { CopyRunLink } from "./copy-run-link.client.tsx";
import { RunEvidenceDetail } from "./run-evidence-detail.client.tsx";
export function SavedRunEvidence({ saved, fileName, workspace, diagnosticsOpen, onBranch, readTrace, onPromoteTrace }: {
  saved: SavedRunTrace; fileName: string; workspace: ProjectWorkspaceHandle | null; diagnosticsOpen?: boolean;
  onBranch(trace: RunTrace): void; readTrace(fileName: string): Promise<RunTrace>; onPromoteTrace?(trace: RunTrace): void;
}) {
  return <div className="saved-run-evidence">
    <div className="run-evidence-actions"><code>{saved.trace.runId}</code><CopyRunLink workspace={workspace} runId={saved.trace.runId} saved /></div>
    {saved.kind === "decision" ? <SavedDecisionEvidence trace={saved.trace} fileName={fileName} /> :
      <RunEvidenceDetail trace={saved.trace} eyebrow="Saved evidence" storage={{ kind: "saved", location: fileName }} onBranch={onBranch} readTrace={readTrace} diagnosticsOpen={diagnosticsOpen} onPromoteTrace={onPromoteTrace} />}
  </div>;
}
