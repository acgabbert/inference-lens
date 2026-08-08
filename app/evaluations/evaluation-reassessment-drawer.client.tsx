"use client";

import { SAFE_REGEX_FLAGS } from "../../packages/core/src/safe-regex.ts";
import { SideDrawer } from "../workbench-shell.client.tsx";
import styles from "./evaluation-reassessment.module.css";
import type { EvaluationReassessmentHandle } from "./use-evaluation-reassessment.client.ts";

const flagLabels: Record<string, string> = {
  i: "Ignore case",
  m: "Multiline",
  s: "Dot matches newline",
};

const driftLabels: Record<string, string> = {
  replaced: "Authored checks differ from the ones this execution ran",
  identical: "Authored checks are the ones this execution ran",
  "absent-from-suite": "No longer in the authored suite; keeps the checks it ran with",
  "absent-from-execution": "Authored since this ran, so it has no evidence and is not scored",
  unusable: "Authored checks cannot be scored by this build",
};

function flip(from: string, to: string): string {
  return `${from} → ${to}`;
}

/**
 * Corrects the criteria a finished evaluation is read under.
 *
 * Regex only, deliberately. The corrections this exists for — a pattern written
 * against one sample's capitalization, an anchor that was never going to match
 * twice — are regex corrections, and every field here is one the Safe regex
 * engine already validates. Widening it to every check kind would rebuild the
 * suite editor's per-kind field logic over history, where a mistake is harder
 * to notice because there is no run to disagree with it.
 */
export function EvaluationReassessmentDrawer({
  handle,
}: {
  handle: EvaluationReassessmentHandle;
}) {
  const { preview } = handle;
  const blocked = handle.previewBlocked;
  const nothingToSave = Boolean(preview?.unchanged);

  return (
    <SideDrawer
      open={handle.editorOpen}
      eyebrow="Saved outputs"
      title="Re-evaluate saved outputs"
      description="Corrects the criteria only. No provider call is made, no saved output changes, and the As run reading stays exactly as it was."
      onClose={handle.closeEditor}
    >
      <div className={styles.drawer}>
        {handle.regexChecks.length === 0 && (
          <p className={styles.empty}>
            This execution ran no regex checks, so there is nothing this editor can correct.
          </p>
        )}

        {handle.regexChecks.map((check) => (
          <section
            aria-label={`${check.caseName} · ${check.label ?? check.checkId}`}
            className={styles.check}
            key={`${check.caseId}:${check.checkId}`}
          >
            <header>
              <strong>{check.label ?? "Regex check"}</strong>
              <small>{check.caseName}</small>
            </header>
            <label>
              Pattern
              <textarea
                rows={2}
                value={check.pattern}
                onChange={(event) => handle.setPattern(check.caseId, check.checkId, event.target.value)}
              />
            </label>
            {check.error && <p className={styles.error} role="alert">{check.error}</p>}
            <div className={styles.options}>
              {SAFE_REGEX_FLAGS.map((flag) => (
                <label key={flag}>
                  <input
                    type="checkbox"
                    checked={check.flags.includes(flag)}
                    onChange={(event) => handle.setFlag(check.caseId, check.checkId, flag, event.target.checked)}
                  />{" "}
                  {flagLabels[flag] ?? flag}
                </label>
              ))}
              <label>
                <input
                  type="checkbox"
                  checked={check.negate}
                  onChange={(event) => handle.setNegate(check.caseId, check.checkId, event.target.checked)}
                />{" "}
                Negate
              </label>
            </div>
          </section>
        ))}

        {handle.carriedChecks.length > 0 && (
          <section aria-label="Checks carried through unchanged" className={styles.carried}>
            <h3>Carried through unchanged</h3>
            <ul>
              {handle.carriedChecks.map((check) => (
                <li key={`${check.caseId}:${check.checkId}`}>
                  <strong>{check.label ?? check.kind}</strong>
                  <small>{check.caseName} · {check.kind}</small>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label="What would change" className={styles.preview}>
          <h3>What would change</h3>
          {blocked && (
            <p className={styles.error} role="alert">
              Fix the pattern above to see what it would change.
            </p>
          )}
          {!blocked && preview?.unchanged && (
            <p>Nothing. This reads the saved outputs exactly as the As run interpretation does.</p>
          )}
          {!blocked && preview && !preview.unchanged && (
            <>
              <ul className={styles.flips}>
                {preview.cases.map((item) => (
                  <li className={item.to ? "passed" : "failed"} key={`case:${item.variantId}:${item.caseId}`}>
                    <strong>{item.name}</strong>
                    <span>{flip(item.from ? "passed" : "did not pass", item.to ? "passed" : "did not pass")}</span>
                  </li>
                ))}
                {preview.checks.map((item) => (
                  <li
                    className={item.to}
                    key={`check:${item.variantId}:${item.cellId}:${item.checkId}`}
                  >
                    <strong>{item.checkId}</strong>
                    <span>repetition {item.repetition} · {flip(item.from, item.to)}</span>
                  </li>
                ))}
              </ul>
              <p className={styles.counts}>
                {preview.checks.length} check {preview.checks.length === 1 ? "outcome" : "outcomes"},{" "}
                {preview.cases.length} case {preview.cases.length === 1 ? "outcome" : "outcomes"}, and{" "}
                {preview.variants.length} configuration{" "}
                {preview.variants.length === 1 ? "outcome" : "outcomes"} would change.
              </p>
            </>
          )}
        </section>

        <section aria-label="Save this interpretation" className={styles.commit}>
          <h3>Save this interpretation</h3>
          <label>
            Name
            <input
              value={handle.draftName}
              placeholder="Corrected regex"
              onChange={(event) => handle.setDraftName(event.target.value)}
            />
          </label>
          <p className={styles.hint}>
            Saved beside this execution as an immutable reassessment. The original verdict is
            untouched and stays selectable as As run.
          </p>
          <button
            className="button primary"
            type="button"
            disabled={handle.saving || blocked || nothingToSave}
            onClick={() => { void handle.save(); }}
          >
            {handle.saving ? "Saving…" : "Save reassessment"}
          </button>
        </section>

        <section aria-label="Update the authored suite" className={styles.commit}>
          <h3>Update the authored suite</h3>
          <p className={styles.hint}>
            A separate decision: this changes what the <em>next</em> run asserts. Saving an
            interpretation of history does not.
          </p>
          {handle.adoption.adopt.length === 0 && (
            <p className={styles.hint}>
              None of the corrected cases are still in the authored suite.
            </p>
          )}
          {handle.adoption.skipped.length > 0 && (
            <p className={styles.hint}>
              {handle.adoption.skipped.map(({ name }) => `“${name}”`).join(", ")}{" "}
              {handle.adoption.skipped.length === 1 ? "is" : "are"} no longer in the suite and will
              not be recreated.
            </p>
          )}
          <button
            className="button"
            type="button"
            disabled={blocked || handle.adoption.adopt.length === 0}
            onClick={handle.adoptIntoSuite}
          >
            Update {handle.adoption.adopt.length}{" "}
            {handle.adoption.adopt.length === 1 ? "authored case" : "authored cases"}
          </button>
        </section>

        {handle.suiteDrift.some(({ status }) => status !== "identical" && status !== "replaced") && (
          <section aria-label="Suite drift" className={styles.drift}>
            <h3>Since this ran</h3>
            <ul>
              {handle.suiteDrift
                .filter(({ status }) => status !== "identical" && status !== "replaced")
                .map((item) => (
                  <li key={item.caseId}>
                    <strong>{item.name}</strong>
                    <small>{item.reason ?? driftLabels[item.status] ?? item.status}</small>
                  </li>
                ))}
            </ul>
          </section>
        )}
      </div>
    </SideDrawer>
  );
}
