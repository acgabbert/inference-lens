"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  SOURCE_ROOT_FILES_API_PATH,
  SOURCE_ROOT_READ_API_PATH,
  SOURCE_ROOTS_API_PATH,
} from "../../packages/contracts/src/index.ts";
import type {
  SourceFileReadResponse,
  SourceFileReadResult,
  SourceRootCatalogResponse,
  SourceRootFileListResponse,
  SourceRootSummary,
} from "../../packages/contracts/src/index.ts";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import type { PromptTemplateId } from "../../packages/core/src/run-kernel/index.ts";
import { filePromptDrift, type FilePromptDrift } from "../../packages/core/src/source-roots.ts";
import { isTauriRuntime } from "../runtime.client.ts";

/**
 * The linked-sources owner (docs/SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md, E3):
 * which folders this server declares, which folder each project root reads
 * from this session, and what each linked prompt's file says now.
 *
 * Files are read when the owner mounts (the Prompts mode opening), when the
 * set of links changes and on refresh; nothing watches them. Drift is derived
 * from the latest project on every render, so a pull clears it without
 * another read.
 */

export type SourceRootAvailability =
  | { kind: "loading" }
  | { kind: "ready" }
  /** The desktop shell has no local service to read through — yet. */
  | { kind: "unsupported-shell" }
  | { kind: "unconfigured"; variable: string }
  | { kind: "invalid"; variable: string; problem: string }
  | { kind: "unreachable"; message: string };

export type LinkedPromptState =
  | { kind: "checking" }
  /** Folders cannot be read here, or this project's folder is not declared. */
  | { kind: "unavailable"; message: string }
  | { kind: "unreadable"; message: string }
  | { kind: "read"; text: string; drift: FilePromptDrift };

export interface LinkedPromptSourcesHandle {
  availability: SourceRootAvailability;
  /** The folders this server declares. */
  folders: SourceRootSummary[];
  /** The server folder a project root reads from this session, if any. */
  folderFor(rootName: string): string | undefined;
  /** Reads a project root from another folder for this session only. */
  mapFolder(rootName: string, folder: string): void;
  /** The project root name a link into `folder` uses. */
  rootNameFor(folder: string): string;
  /** Undefined for a prompt that is not linked. */
  stateFor(templateId: PromptTemplateId): LinkedPromptState | undefined;
  refresh(): void;
  listFiles(folder: string): Promise<SourceRootFileListResponse>;
  readFile(folder: string, path: string): Promise<SourceFileReadResult>;
}

export function sourceRootAvailabilityMessage(availability: SourceRootAvailability): string | undefined {
  switch (availability.kind) {
    case "loading":
    case "ready":
      return undefined;
    case "unsupported-shell":
      return "Linked source folders are read through the local service, which the desktop app does not have yet.";
    case "unconfigured":
      return `No source folders are configured on this server. The operator declares them with ${availability.variable}.`;
    case "invalid":
      return availability.problem;
    case "unreachable":
      return `The local service could not be reached, so linked source folders cannot be read. ${availability.message}`;
  }
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `The service answered ${response.status}.`);
  return body;
}

export function useLinkedPromptSources(
  project: ProjectFile | undefined,
  { fetchImpl }: { fetchImpl?: typeof fetch } = {},
): LinkedPromptSourcesHandle {
  const request = fetchImpl ?? (typeof fetch === "undefined" ? undefined : fetch);
  const [availability, setAvailability] = useState<SourceRootAvailability>({ kind: "loading" });
  const [folders, setFolders] = useState<SourceRootSummary[]>([]);
  // Session-only, like the connection profile mapping: never saved.
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [refreshCount, setRefreshCount] = useState(0);
  const [results, setResults] = useState<ReadonlyMap<PromptTemplateId, SourceFileReadResult & { key: string }>>(new Map());

  useEffect(() => {
    let current = true;
    void (async () => {
      if (isTauriRuntime()) {
        if (current) setAvailability({ kind: "unsupported-shell" });
        return;
      }
      try {
        if (!request) throw new Error("This page cannot make requests.");
        const body = await json<SourceRootCatalogResponse>(
          await request(SOURCE_ROOTS_API_PATH, { headers: { accept: "application/json" } }),
        );
        if (!current) return;
        setFolders(body.roots ?? []);
        setAvailability(body.available
          ? { kind: "ready" }
          : body.problem
            ? { kind: "invalid", variable: body.configurationVariable, problem: body.problem }
            : { kind: "unconfigured", variable: body.configurationVariable });
      } catch (error) {
        if (!current) return;
        setFolders([]);
        setAvailability({ kind: "unreachable", message: error instanceof Error ? error.message : "" });
      }
    })();
    return () => { current = false; };
    // Asked again on refresh, so an operator's catalog edit shows up.
  }, [request, refreshCount]);

  const folderFor = useCallback((rootName: string) =>
    mapping[rootName] ?? (folders.some(({ name }) => name === rootName) ? rootName : undefined), [folders, mapping]);

  const links = useMemo(() => (project?.promptTemplates ?? []).flatMap((template) => {
    if (template.kind !== "chat" || !template.fileSource) return [];
    const rootName = project!.sourceRoots.find(({ id }) => id === template.fileSource!.sourceRootId)?.name;
    if (!rootName) return [];
    const folder = folderFor(rootName);
    return [{ templateId: template.id, rootName, folder, path: template.fileSource.path,
      key: JSON.stringify([folder, template.fileSource.path]) }];
  }), [project, folderFor]);
  const readable = links.filter((link): link is typeof link & { folder: string } => Boolean(link.folder));
  const signature = JSON.stringify(readable.map(({ templateId, key }) => [templateId, key]));

  useEffect(() => {
    if (availability.kind !== "ready" || !request || readable.length === 0) return;
    let current = true;
    void (async () => {
      let answered: SourceFileReadResult[];
      try {
        const body = await json<SourceFileReadResponse>(await request(SOURCE_ROOT_READ_API_PATH, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ files: readable.map(({ folder, path }) => ({ root: folder, path })) }),
        }));
        answered = body.results;
      } catch (error) {
        const message = error instanceof Error ? error.message : "The source files could not be read.";
        answered = readable.map(() => ({ ok: false, reason: "unreadable", message }));
      }
      if (!current) return;
      setResults(new Map(readable.map((link, index) => [link.templateId, { ...answered[index]!, key: link.key }])));
    })();
    return () => { current = false; };
    // `signature` stands for `readable`; reading on every project edit would
    // turn typing in the editor into file reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availability.kind, request, signature, refreshCount]);

  const stateFor = useCallback((templateId: PromptTemplateId): LinkedPromptState | undefined => {
    const link = links.find((entry) => entry.templateId === templateId);
    if (!link || !project) return undefined;
    if (availability.kind === "loading") return { kind: "checking" };
    const unavailable = sourceRootAvailabilityMessage(availability);
    if (unavailable) return { kind: "unavailable", message: unavailable };
    if (!link.folder) {
      return { kind: "unavailable", message: `This server does not declare a source folder named “${link.rootName}”.` };
    }
    const result = results.get(templateId);
    if (!result || result.key !== link.key) return { kind: "checking" };
    if (!result.ok) return { kind: "unreadable", message: result.message };
    try {
      return { kind: "read", text: result.text, drift: filePromptDrift(project, templateId, result.text) };
    } catch (error) {
      return { kind: "unreadable", message: error instanceof Error ? error.message : "Could not compare this file." };
    }
  }, [availability, links, project, results]);

  const listFiles = useCallback(async (folder: string) => {
    if (!request) throw new Error("This page cannot make requests.");
    return json<SourceRootFileListResponse>(await request(
      `${SOURCE_ROOT_FILES_API_PATH}?root=${encodeURIComponent(folder)}`,
      { headers: { accept: "application/json" } },
    ));
  }, [request]);

  const readFile = useCallback(async (folder: string, path: string): Promise<SourceFileReadResult> => {
    if (!request) throw new Error("This page cannot make requests.");
    const body = await json<SourceFileReadResponse>(await request(SOURCE_ROOT_READ_API_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ files: [{ root: folder, path }] }),
    }));
    return body.results[0]!;
  }, [request]);

  return useMemo<LinkedPromptSourcesHandle>(() => ({
    availability,
    folders,
    folderFor,
    mapFolder: (rootName, folder) => setMapping((current) => ({ ...current, [rootName]: folder })),
    rootNameFor: (folder) => project?.sourceRoots.find(({ name }) => folderFor(name) === folder)?.name ?? folder,
    stateFor,
    refresh: () => setRefreshCount((count) => count + 1),
    listFiles,
    readFile,
  }), [availability, folders, folderFor, project, stateFor, listFiles, readFile]);
}
