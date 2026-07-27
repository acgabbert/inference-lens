import type { CredentialSelection } from "../packages/contracts/src/index.ts";

export type WebCredentialMode = "environment-default" | "session" | "none";

/**
 * Resolves the web authentication selector into the exact API contract.
 * Keeping this mode-driven prevents a retained session draft from leaking into
 * a request after the user explicitly selects "No authentication".
 */
export function resolveWebCredentialSelection(
  mode: WebCredentialMode,
  draft: string,
): CredentialSelection {
  if (mode === "environment-default") {
    return { kind: "environment-default" };
  }
  if (mode === "session" && draft.trim()) {
    return { kind: "provided", apiKey: draft };
  }
  return { kind: "none" };
}

export function webCredentialIsAvailable(
  mode: WebCredentialMode,
  draft: string,
): boolean {
  return (
    mode === "environment-default" ||
    (mode === "session" && draft.trim().length > 0)
  );
}
