/**
 * The application's top-level destinations.
 *
 * Each mode owns its own layout and its own primary action. The boundary
 * already existed before it had a name: the evaluation surface blanked the
 * topbar's run controls, suppressed the readiness notice, and installed its
 * own start button and history while pretending to be a tab of the request
 * composer. Naming it here is what lets each pane keep one meaning.
 *
 * Mode selection is deliberately transient — it is navigation state, not
 * product data, so it is neither persisted nor written to a project.
 */
export type AppMode = "compose" | "evaluations" | "runs";

export const APP_MODES: readonly { id: AppMode; label: string }[] = [
  { id: "compose", label: "Compose" },
  { id: "evaluations", label: "Evaluations" },
  { id: "runs", label: "Runs" },
];
