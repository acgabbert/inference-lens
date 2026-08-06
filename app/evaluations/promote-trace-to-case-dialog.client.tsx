"use client";

import { useMemo, useState } from "react";
import { evaluationCasePromotionCompatibility } from "../../packages/core/src/evaluation-case-promotion.ts";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import type { EvaluationSuiteId, RunTrace } from "../../packages/core/src/run-kernel/index.ts";

export function PromoteTraceToCaseDialog({
  project,
  trace,
  onCancel,
  onPromote,
}: {
  project: ProjectFile;
  trace: RunTrace;
  onCancel(): void;
  onPromote(suiteId: EvaluationSuiteId, name: string): void;
}) {
  const compatible = useMemo(() => project.evaluationSuites.flatMap((suite) => {
    const result = evaluationCasePromotionCompatibility(suite, trace);
    return result.ok ? [{ suite, values: result.values }] : [];
  }), [project, trace]);
  const [suiteId, setSuiteId] = useState<EvaluationSuiteId | undefined>(compatible[0]?.suite.id);
  const [name, setName] = useState("Promoted incident");
  const selected = compatible.find(({ suite }) => suite.id === suiteId) ?? compatible[0];
  return <div className="confirmation-backdrop" role="presentation">
    <section aria-labelledby="promote-trace-title" aria-modal="true" className="confirmation-dialog" role="dialog">
      <span className="eyebrow">Evaluation case</span>
      <h2 id="promote-trace-title">Promote to case</h2>
      {compatible.length === 0 ? <p>No evaluation suite uses this trace’s exact input revision and template bindings. Create or retarget a compatible suite before promoting it.</p> : <>
        <p>This creates a normal portable case with exact captured input values. Checks and reference answers are intentionally left empty.</p>
        <label>Suite <select value={suiteId} onChange={(event) => setSuiteId(event.target.value as EvaluationSuiteId)}>{compatible.map(({ suite }) => <option key={suite.id} value={suite.id}>{suite.name}</option>)}</select></label>
        <label>Case name <input value={name} onChange={(event) => setName(event.target.value)} /></label>
        {selected && <dl className="confirmation-details">{selected.suite.inputBindings.map((binding) => <div key={binding.id}><dt>{binding.name}</dt><dd>{selected.values[binding.id]}</dd></div>)}</dl>}
      </>}
      <div className="confirmation-actions"><button className="button secondary" type="button" onClick={onCancel}>{compatible.length === 0 ? "Close" : "Cancel"}</button>{selected && <button className="button primary" disabled={!name.trim()} type="button" onClick={() => onPromote(selected.suite.id, name)}>Promote case</button>}</div>
    </section>
  </div>;
}
