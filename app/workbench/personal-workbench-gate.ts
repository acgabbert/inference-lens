/**
 * The shared assets 2b gate (D2). Off by default. Every 2b owner lands behind
 * it, and removing it is the enabling change, which also lifts the guard
 * against application calls to migration completion.
 *
 * This is the gate's only reader. The project workspace samples it once per
 * adoption into the session's mode, so an open session never changes mode.
 * `vite.config.ts` always defines the variable, so the browser bundle never
 * reads a `process` it does not have.
 */
export function personalWorkbenchEnabled(): boolean {
  return process.env.NEXT_PUBLIC_INFERENCE_LENS_PERSONAL_WORKBENCH === "1";
}
