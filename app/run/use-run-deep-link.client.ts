"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProjectId } from "../../packages/core/src/run-kernel/types.ts";
import { type RunReferenceResult, type RunReferenceV1 } from "../../packages/core/src/run-reference.ts";
import { resolveRunReference, type ResolvedRunEvidence } from "../../packages/core/src/run-reference-resolution.ts";
import { browserFolderAccessAvailable, inspectBrowserProjectDirectory, isSameProjectWorkspace, locateLinkedProject, reopenProjectWorkspace, type OpenedProjectWorkspace, type ProjectWorkspaceHandle } from "../project-workspace.client.ts";
import { forgetProjectLocation, listProjectLocations, type BrowserProjectLocation } from "../project-location-registry.client.ts";
import type { ProjectWorkspaceHandleState } from "../use-project-workspace.client.ts";
import { clearStoredWorkspace, readStoredWorkspace } from "../workspace-handle-store.client.ts";
import { browserRunLink, clearRunLinkFragment, hasRunLinkFragment, parseRunLinkUrl } from "./run-link-url.client.ts";
import { handoffRunLink, receiveRunLinkHandoff } from "./run-link-handoff.client.ts";

export interface RunDeepLinkState {
  status: "resolving" | "locate" | "choose" | "waiting" | "error" | "handed-off" | "ready";
  reference?: RunReferenceV1;
  message: string;
  locations?: BrowserProjectLocation[];
}
interface Options {
  project: ProjectWorkspaceHandleState;
  ready: boolean;
  blockedReason(): string | undefined;
  showEvidence(evidence: ResolvedRunEvidence, reference: RunReferenceV1, workspace: ProjectWorkspaceHandle): void;
  clearInspection(): void;
}
/** Owns intent, recovery and async generations; project lifecycle remains in its owner. */
export function useRunDeepLink(options: Options) {
  const [state, setState] = useState<RunDeepLinkState>();
  const [pasteOpen, setPasteOpen] = useState(false);
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  const generation = useRef(0);
  const intent = useRef<RunReferenceV1 | undefined>(undefined);
  const linkedWorkspace = useRef<ProjectWorkspaceHandle | undefined>(undefined);
  const startingWorkspace = useRef<ProjectWorkspaceHandle | null>(options.project.projectWorkspace);
  const adoptingWorkspace = useRef<ProjectWorkspaceHandle | undefined>(undefined);
  const cancelPending = useRef<(() => void) | undefined>(undefined);
  function invalidate() { generation.current++; cancelPending.current?.(); cancelPending.current = undefined; }
  function cancel(clearInspection = false) {
    invalidate(); intent.current = undefined; linkedWorkspace.current = undefined;
    setState(undefined); clearRunLinkFragment();
    if (clearInspection) latest.current.clearInspection();
  }
  function commit(ref: RunReferenceV1, evidence: ResolvedRunEvidence, workspace: ProjectWorkspaceHandle) {
    linkedWorkspace.current = workspace;
    latest.current.showEvidence(evidence, ref, workspace);
    setState({ status: "ready", reference: ref, message: "Saved evidence opened." });
    requestAnimationFrame(() => document.querySelector<HTMLElement>("[aria-label='Selected run evidence']")?.focus());
  }
  async function openCandidate(opened: OpenedProjectWorkspace, ref: RunReferenceV1, token: number) {
    const isCurrent = () => generation.current === token;
    const from = latest.current.project.projectWorkspace;
    setState({ status: "resolving", reference: ref, message: "Reading saved evidence…" });
    let evidence = await resolveRunReference(ref, opened.handle.storage, isCurrent);
    if (!isCurrent()) return;
    if (from !== opened.handle) {
      if (latest.current.blockedReason()) { setState({ status: "waiting", reference: ref, message: latest.current.blockedReason()! }); return; }
      setState({ status: "waiting", reference: ref, message: "Waiting to open the linked project. Resolve any unsaved-work dialog to continue." });
      const project = latest.current.project;
      adoptingWorkspace.current = opened.handle;
      const adoption = project.adoptLinkedWorkspace(opened, isCurrent, () => latest.current.blockedReason(), async () => {
        evidence = await resolveRunReference(ref, opened.handle.storage, isCurrent);
      });
      // Invalidating this intent dismisses only its own replacement dialog.
      cancelPending.current = () => project.cancelLinkedProjectReplacement(isCurrent);
      const result = await adoption;
      if (!isCurrent()) return;
      cancelPending.current = undefined;
      if (result !== "adopted") { setState({ status: "waiting", reference: ref, message: result === "blocked" ? latest.current.blockedReason() ?? "Finish the current work and retry." : "Project switch cancelled. Retry when you are ready." }); return; }
    }
    if (isCurrent()) commit(ref, evidence, opened.handle);
  }
  async function candidates(projectId: ProjectId): Promise<BrowserProjectLocation[]> {
    const registered = await listProjectLocations(projectId);
    if (registered.length) return registered;
    // Additive legacy migration: only an accepted workspace is persisted later.
    const legacy = await readStoredWorkspace();
    if (!legacy) return [];
    const permission = await legacy.handle.queryPermission?.({ mode: "readwrite" });
    if (permission === "granted") {
      try { await inspectBrowserProjectDirectory(legacy.handle, projectId); } catch { return []; }
    }
    const name = legacy.projectName ?? legacy.displayName;
    return [{ version: 1, locationId: `legacy:${legacy.recordId}`, projectId, displayName: permission === "granted" ? name : `${name} (unverified last-project folder)`, lastAccessAt: legacy.savedAt, handle: legacy.handle }];
  }
  async function run(ref: RunReferenceV1, local = false) {
    invalidate(); const token = generation.current; intent.current = ref;
    startingWorkspace.current = latest.current.project.projectWorkspace;
    adoptingWorkspace.current = undefined;
    const isCurrent = () => token === generation.current;
    let candidateLocations: BrowserProjectLocation[] | undefined;
    setState({ status: "resolving", reference: ref, message: "Finding the linked project…" });
    try {
      if (!browserFolderAccessAvailable()) throw new Error("Opening saved run links requires Chrome or Edge with project folder access. Importing project JSON cannot open its saved traces.");
      const current = latest.current.project;
      if (current.projectFile?.projectId === ref.projectId && current.projectWorkspace) {
        await reopenProjectWorkspace(current.projectWorkspace, ref.projectId);
        if (!isCurrent()) return;
        const evidence = await resolveRunReference(ref, current.projectWorkspace.storage, isCurrent);
        const workspace = latest.current.project.projectWorkspace;
        if (isCurrent() && workspace && isSameProjectWorkspace(workspace, current.projectWorkspace)) commit(ref, evidence, workspace);
        return;
      }
      if (!local && await handoffRunLink(ref)) {
        if (isCurrent()) setState({ status: "handed-off", reference: ref, message: "Opened in your other tab. Switch to the tab editing this project, or open it here." });
        return;
      }
      const locations = await candidates(ref.projectId);
      candidateLocations = locations;
      if (!isCurrent()) return;
      if (locations.length !== 1) { setState({ status: locations.length ? "choose" : "locate", reference: ref, locations, message: locations.length ? "Choose which local copy of this project to open." : "Locate the project folder containing this saved run." }); return; }
      const location = locations[0]!;
      const permission = await location.handle.queryPermission?.({ mode: "readwrite" });
      if (!isCurrent()) return;
      if (permission !== "granted") { setState({ status: "choose", reference: ref, locations, message: "Reconnect the project folder to open this run." }); return; }
      const opened = await inspectBrowserProjectDirectory(location.handle, ref.projectId);
      if (isCurrent()) await openCandidate(opened, ref, token);
    } catch (error) { if (isCurrent()) setState({ status: "error", reference: ref, message: error instanceof Error ? error.message : "The saved run could not be opened.", locations: candidateLocations }); }
  }
  function receive(parsed: RunReferenceResult) {
    if (parsed.kind === "valid") void run(parsed.reference);
    else { invalidate(); intent.current = undefined; setState({ status: "error", message: parsed.message }); }
  }
  useEffect(() => {
    if (!options.ready) return;
    const onLocation = () => {
      if (hasRunLinkFragment()) receive(parseRunLinkUrl(window.location.href));
      else { invalidate(); intent.current = undefined; setState(undefined); latest.current.clearInspection(); }
    };
    if (hasRunLinkFragment()) onLocation();
    window.addEventListener("hashchange", onLocation);
    window.addEventListener("popstate", onLocation);
    const close = receiveRunLinkHandoff(async projectId => latest.current.project.projectFile?.projectId === projectId && await latest.current.project.holdsProjectEditorLock(), ref => {
      history.replaceState(null, "", browserRunLink(ref, location.href));
      void run(ref, true);
    });
    return () => { invalidate(); close(); window.removeEventListener("hashchange", onLocation); window.removeEventListener("popstate", onLocation); };
    // Intent handlers read the latest owners; subscription does not restart on renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.ready]);
  async function choose(location: BrowserProjectLocation) {
    const ref = intent.current; if (!ref) return;
    invalidate(); const token = generation.current;
    try {
      const permission = await (location.handle.requestPermission?.({ mode: "readwrite" }) ?? Promise.resolve("granted"));
      if (token !== generation.current) return;
      if (permission !== "granted") throw new Error("Folder permission is still needed. Reconnect or locate the folder and retry.");
      const opened = await inspectBrowserProjectDirectory(location.handle, ref.projectId);
      if (token === generation.current) await openCandidate(opened, ref, token);
    } catch (error) { if (token === generation.current) setState({ status: "error", reference: ref, message: error instanceof Error ? error.message : "Could not reconnect the folder.", locations: [location] }); }
  }
  async function locate() {
    const ref = intent.current; if (!ref) return;
    invalidate(); const token = generation.current;
    try {
      const opened = await locateLinkedProject(ref.projectId);
      if (token !== generation.current) return;
      if (opened) await openCandidate(opened, ref, token);
      else setState({ status: "locate", reference: ref, message: "Folder selection cancelled. Locate the project folder when ready." });
    } catch (error) { if (token === generation.current) setState({ status: "error", reference: ref, message: error instanceof Error ? error.message : "Could not locate the folder." }); }
  }
  function selectSaved(ref: RunReferenceV1) {
    invalidate(); intent.current = undefined; linkedWorkspace.current = undefined; setState(undefined);
    const url = browserRunLink(ref, location.href);
    if (url !== location.href) history.pushState(null, "", url);
  }
  useEffect(() => {
    const workspace = options.project.projectWorkspace;
    if (intent.current && !isSameProjectWorkspace(workspace, startingWorkspace.current) && !isSameProjectWorkspace(workspace, adoptingWorkspace.current) && !isSameProjectWorkspace(workspace, linkedWorkspace.current)) {
      invalidate(); intent.current = undefined; setState(undefined); clearRunLinkFragment();
    }
    // A refresh retains folder identity; a different copy still invalidates reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.project.projectWorkspace]);
  return { state, pasteOpen, showPaste: () => setPasteOpen(true), closePaste: () => setPasteOpen(false), locate, choose, cancel, selectSaved,
    open: (text: string) => { const parsed = parseRunLinkUrl(text.trim()); if (parsed.kind === "valid") history.pushState(null, "", browserRunLink(parsed.reference, location.href)); receive(parsed); },
    retry: () => { if (intent.current) void run(intent.current, true); },
    forget: async (id: string) => { if (id.startsWith("legacy:")) await clearStoredWorkspace(id.slice("legacy:".length)); else await forgetProjectLocation(id); if (intent.current) void run(intent.current, true); },
  };
}
