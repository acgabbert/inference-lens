"use client";

import { useState } from "react";
import type { ConfirmationDialogRequest } from "../confirmation-dialog.client";
import { FoldedDiffCode } from "../templates/diff-code.client";
import { SideDrawer } from "../workbench-shell.client";
import type {
  MigrationBackupSummary,
  PersonalWorkbenchHandle,
  ReconcileOutcome,
  RecoveryEntry,
  WorkbenchAssetRef,
} from "./use-personal-workbench.client";
import {
  backupRemovalDetails,
  discardConfirmation,
  RECOVERY_ACTION_LABEL,
  recoveryComparisonDiff,
  recoveryKindLabel,
  recoverySubject,
  recoveryTargetKey,
} from "./recovery-view";
import type { RecoveryDiff } from "./recovery-view";
import styles from "./recovery-drawer.module.css";

interface RecoveryDrawerProps {
  open: boolean;
  onClose(): void;
  recovery: readonly RecoveryEntry[];
  backups: readonly MigrationBackupSummary[];
  reconcile: PersonalWorkbenchHandle["reconcile"];
  nameOf(asset: WorkbenchAssetRef): string | undefined;
  /** X3: only this prompt's or request's items, until "Show all". */
  focus?: string;
  onShowAll(): void;
  /** An action settled: owners whose editors hold their own copy reload it. */
  onSettled(): void;
  requestConfirmation(request: ConfirmationDialogRequest): void;
}

/**
 * The D8 Recovery drawer (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 6b-2
 * decisions"): every item with its V4 actions, then the migration backups
 * (W3). The drawer's content is its one scroll area.
 */
export function RecoveryDrawer(props: RecoveryDrawerProps) {
  const { recovery, backups, focus } = props;
  const shown = focus ? recovery.filter((item) => recoveryTargetKey(item) === focus) : recovery;
  const listedBackups = focus && shown.length > 0 ? [] : backups;
  return (
    <SideDrawer
      open={props.open}
      eyebrow="On this device"
      title="Recovery"
      description="Personal work that needs a decision. Nothing here changes project.json unless an action says it saves."
      onClose={props.onClose}
    >
      <div className={styles.content}>
        {focus && shown.length > 0 && (
          <p className={styles.focus}>
            Showing {recoverySubject(shown[0]!, props.nameOf)}.{" "}
            <button className="text-button" type="button" onClick={props.onShowAll}>Show all</button>
          </p>
        )}
        {shown.length === 0 && (recovery.length === 0 ? <p className={styles.empty}>Nothing needs recovery.</p> : (
          <p className={styles.empty}>
            Nothing else here needs a decision.{" "}
            <button className="text-button" type="button" onClick={props.onShowAll}>Show all</button>
          </p>
        ))}
        {shown.map((item) => (
          <RecoveryItemCard
            key={item.id}
            item={item}
            subject={recoverySubject(item, props.nameOf)}
            reconcile={props.reconcile}
            onSettled={props.onSettled}
            requestConfirmation={props.requestConfirmation}
          />
        ))}
        {listedBackups.length > 0 && (
          <section aria-label="Migration backups" className={styles.backups}>
            <h3>Migration backups</h3>
            {listedBackups.map((backup) => (
              <BackupRow
                key={backup.operationId}
                backup={backup}
                reconcile={props.reconcile}
                onSettled={props.onSettled}
                requestConfirmation={props.requestConfirmation}
              />
            ))}
          </section>
        )}
      </div>
    </SideDrawer>
  );
}

function RecoveryItemCard({
  item,
  subject,
  reconcile,
  onSettled,
  requestConfirmation,
}: {
  item: RecoveryEntry;
  subject: string;
  reconcile: PersonalWorkbenchHandle["reconcile"];
  onSettled(): void;
  requestConfirmation(request: ConfirmationDialogRequest): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [comparison, setComparison] = useState<RecoveryDiff | "none">();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  async function run(action: () => Promise<ReconcileOutcome>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const outcome = await action();
      if (outcome.kind === "settled") onSettled();
      else setError(outcome.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function compare(): Promise<void> {
    if (comparison) {
      setComparison(undefined);
      return;
    }
    const result = await reconcile.compare(item.id);
    setComparison(result ? recoveryComparisonDiff(result) : "none");
  }

  function discard(): void {
    const confirmation = discardConfirmation(item, subject);
    if (!confirmation) {
      void run(() => reconcile.discard(item.id));
      return;
    }
    requestConfirmation({ ...confirmation, destructive: true, onConfirm: () => void run(() => reconcile.discard(item.id)) });
  }

  return (
    <article aria-label={subject} className={styles.item}>
      <header>
        <strong>{subject}</strong>
        <span className={styles.kind}>{recoveryKindLabel(item.kind)}</span>
      </header>
      {item.message && <p>{item.message}</p>}
      <p className={styles.path}><code>{item.path}</code></p>
      {item.actions.length > 0 && (
        <div className={styles.actions}>
          {item.actions.map((action) => (
            <button
              className="button secondary"
              disabled={busy}
              key={action}
              type="button"
              onClick={() => {
                switch (action) {
                  case "compare": void compare(); return;
                  case "use": void run(() => reconcile.use(item.id)); return;
                  case "discard": discard(); return;
                  case "keep-as-draft": void run(() => reconcile.keepAsDraft(item.id)); return;
                  case "retry": void run(() => reconcile.retry(item.id)); return;
                  case "save-as-new": setNaming(true); return;
                }
              }}
            >
              {action === "compare" && comparison ? "Hide comparison" : RECOVERY_ACTION_LABEL[action]}
            </button>
          ))}
        </div>
      )}
      {naming && (
        <form
          className={styles.naming}
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (!trimmed) return;
            void run(() => reconcile.saveAsNew(item.id, trimmed));
          }}
        >
          <label>
            Name
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <button className="button primary" disabled={busy || !name.trim()} type="submit">Save</button>
          <button className="button secondary" disabled={busy} type="button" onClick={() => setNaming(false)}>Cancel</button>
        </form>
      )}
      {comparison && (
        <section aria-label="Comparison" className={styles.comparison}>
          {comparison === "none" ? (
            <p>There is nothing to compare this with now.</p>
          ) : (
            <>
              <p className={styles.legend}>
                {comparison.left ? `− ${comparison.left} · + ${comparison.right}` : `+ ${comparison.right}`}
              </p>
              {comparison.truncated && <p className="diff-warning">Too long to compare line by line. Showing a whole-block replacement.</p>}
              <FoldedDiffCode lines={comparison.lines} />
            </>
          )}
        </section>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </article>
  );
}

function BackupRow({
  backup,
  reconcile,
  onSettled,
  requestConfirmation,
}: {
  backup: MigrationBackupSummary;
  reconcile: PersonalWorkbenchHandle["reconcile"];
  onSettled(): void;
  requestConfirmation(request: ConfirmationDialogRequest): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function remove(): Promise<void> {
    setBusy(true);
    setError(undefined);
    const outcome = await reconcile.removeMigrationBackup(backup.operationId);
    setBusy(false);
    if (outcome.kind === "settled") onSettled();
    else setError(outcome.message);
  }
  return (
    <div className={styles.backup}>
      <p className={styles.path}><code>.workbench/migrations/{backup.operationId}/</code></p>
      {backup.removing ? (
        <>
          <p>An earlier removal of this backup stopped before it finished.</p>
          <button className="button secondary" disabled={busy} type="button" onClick={() => void remove()}>Finish removing backup</button>
        </>
      ) : backup.removable ? (
        <>
          <p>Nothing from this upgrade is pending. Its backup keeps the project file as it was before the upgrade.</p>
          <button
            className="button secondary"
            disabled={busy}
            type="button"
            onClick={() => requestConfirmation({
              title: "Remove this migration backup?",
              description: "These files are deleted from this device. The upgraded project and your active drafts are not changed.",
              details: backupRemovalDetails(backup),
              confirmLabel: "Remove backup",
              destructive: true,
              onConfirm: () => void remove(),
            })}
          >
            Remove migration backup…
          </button>
        </>
      ) : backup.unfinished ? (
        <p>Finish upgrade restores the rest of this upgrade before its backup can be removed.</p>
      ) : (
        <p>Settle this upgrade’s items above before removing its backup.</p>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}
