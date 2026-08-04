"use client";

import type { EvaluationSuite } from "../../packages/core/src/project";
import styles from "./evaluation-surface.module.css";

/**
 * The Evaluations mode's suite list.
 *
 * Choosing a suite used to be a `select` in the editor's toolbar, which is what
 * a half-pane could afford. At full width the suites are a standing list, so
 * how many a project has — and which one is open — is readable without opening
 * a menu. Identity actions that act on the open suite (rename, delete) stay in
 * the suite header beside its name; only creation belongs here, because it acts
 * on the list.
 */
export function EvaluationSuiteRail({ suites, selectedId, onSelect, onCreate }: {
  suites: readonly EvaluationSuite[];
  selectedId?: EvaluationSuite["id"];
  onSelect(id: EvaluationSuite["id"]): void;
  onCreate(): void;
}) {
  return (
    <nav aria-label="Evaluation suites" className={styles.rail}>
      <div className={styles.railHeading}>
        <span className="eyebrow">Suites</span>
        <span>{suites.length}</span>
      </div>
      {suites.length === 0
        ? <p className={styles.railEmpty}>No suites yet.</p>
        : (
          <ul className={styles.railList}>
            {suites.map((suite) => (
              <li key={suite.id}>
                <button
                  aria-current={suite.id === selectedId ? "true" : undefined}
                  className={suite.id === selectedId ? styles.railItemSelected : styles.railItem}
                  type="button"
                  onClick={() => onSelect(suite.id)}
                >
                  <strong>{suite.name}</strong>
                  <span>{suite.cases.length} {suite.cases.length === 1 ? "case" : "cases"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      <button className="button secondary" type="button" onClick={onCreate}>+ New suite</button>
    </nav>
  );
}
