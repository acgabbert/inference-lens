import { MAX_RUN_LINK_LENGTH, formatRunReference, parseRunReference, type RunReferenceResult, type RunReferenceV1 } from "../../packages/core/src/run-reference.ts";

export function parseRunLinkUrl(text: string): RunReferenceResult {
  const invalid = (): RunReferenceResult => ({ kind: "invalid", message: "Paste an HTTP(S) saved run link or an inference-lens://run link." });
  if (text.length > MAX_RUN_LINK_LENGTH) return invalid();
  try {
    const url = new URL(text);
    if (url.username || url.password) return invalid();
    if (url.protocol === "inference-lens:" && url.hostname === "run" && !url.port && !url.hash) return parseRunReference(`run${url.pathname}${url.search}`);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hash.startsWith("#/run/")) return parseRunReference(url.hash.slice(2));
  } catch { /* invalid outer URL */ }
  return invalid();
}
export function browserRunLink(ref: RunReferenceV1, appUrl: string): string {
  const url = new URL(appUrl);
  url.hash = `/${formatRunReference(ref)}`;
  if (url.href.length > MAX_RUN_LINK_LENGTH) throw new Error("The run link is too long for this app address.");
  return url.href;
}
export function hasRunLinkFragment(): boolean {
  return typeof window !== "undefined" && window.location.hash.startsWith("#/run/");
}
export function clearRunLinkFragment(): void {
  if (!hasRunLinkFragment()) return;
  const url = new URL(window.location.href); url.hash = "";
  window.history.pushState(null, "", url);
}
