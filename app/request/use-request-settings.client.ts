"use client";

import { useEffect, useRef, useState } from "react";

import type { ProjectFile } from "../../packages/core/src/project.ts";
import type {
  ConversationMessage,
  ProviderWireProtocol,
} from "../../packages/core/src/run-kernel/types.ts";
import type { RichInferenceRequest } from "../../packages/core/src/types.ts";
import type {
  StoredInferenceProfile,
  StoredInferenceProfilePatch,
} from "../profile-store.client.ts";
import { requestFromSettings, resolveRequestSettings } from "./resolve-request-settings.ts";
import type { ResolvedRequestSettings } from "./resolve-request-settings.ts";

const STREAMING_PREFERENCE_STORAGE_KEY =
  "inference-lens:streaming-preference:v1";

export interface UseRequestSettingsOptions {
  projectFile: ProjectFile | null;
  mappedProfileIds: Readonly<Record<string, string>>;
  profiles: readonly StoredInferenceProfile[];
  activeProfile: StoredInferenceProfile;
  /** The composer's messages, which `currentRequest` sends. */
  messages: ConversationMessage[];
  /**
   * Without a project, model, temperature and protocol edits write the active
   * profile: they are its remembered preferences.
   */
  updateActiveProfile(patch: StoredInferenceProfilePatch): void;
  /**
   * With a project, they are unsaved edits to its default target. Suites keep
   * their own target, so none of them changes what an evaluation runs.
   */
  onProjectEdited(): void;
}

/**
 * What the composer's next run is sent with.
 *
 * The page calls this hook after the project workspace, because resolving the
 * request's profile reads the project's connection mapping. The workspace's
 * callbacks read this handle in turn; they run only from project commands and
 * effects, never during render, which is what makes that order safe.
 */
export interface RequestSettingsHandle
  extends ResolvedRequestSettings<StoredInferenceProfile> {
  setModel(model: string): void;
  setTemperature(temperature: number | undefined): void;
  setStreamingPreferred(streaming: boolean): void;
  setProtocol(protocol: ProviderWireProtocol): void;
  /** Adopts a project draft's model, temperature and protocol as this session's. */
  applyDraft(draft: { model: string; temperature?: number; protocol: ProviderWireProtocol }): void;
  currentRequest(): RichInferenceRequest;
}

export function useRequestSettings(options: UseRequestSettingsOptions): RequestSettingsHandle {
  const {
    projectFile,
    mappedProfileIds,
    profiles,
    activeProfile,
    messages,
    updateActiveProfile,
    onProjectEdited,
  } = options;
  const [sessionModel, setSessionModel] = useState<string>();
  const [sessionTemperature, setSessionTemperature] = useState<number>();
  const [sessionProtocol, setSessionProtocol] = useState<ProviderWireProtocol>();
  const [streamingPreferred, setStreamingPreferredState] = useState(true);
  const [streamingPreferenceLoaded, setStreamingPreferenceLoaded] =
    useState(false);
  const streamingPreferenceChangedRef = useRef(false);

  useEffect(() => {
    const preferenceId = window.setTimeout(() => {
      const saved = window.localStorage.getItem(
        STREAMING_PREFERENCE_STORAGE_KEY,
      );
      if (!streamingPreferenceChangedRef.current && saved === "buffered") {
        setStreamingPreferredState(false);
      }
      setStreamingPreferenceLoaded(true);
    }, 0);
    return () => window.clearTimeout(preferenceId);
  }, []);

  useEffect(() => {
    if (!streamingPreferenceLoaded) return;
    window.localStorage.setItem(
      STREAMING_PREFERENCE_STORAGE_KEY,
      streamingPreferred ? "streaming" : "buffered",
    );
  }, [streamingPreferred, streamingPreferenceLoaded]);

  const resolved = resolveRequestSettings({
    projectFile,
    mappedProfileIds,
    profiles,
    activeProfile,
    sessionModel,
    sessionTemperature,
    sessionProtocol,
    streamingPreferred,
  });

  return {
    ...resolved,
    setModel(model) {
      if (projectFile) {
        setSessionModel(model);
        onProjectEdited();
      } else {
        updateActiveProfile({ model });
      }
    },
    setTemperature(temperature) {
      if (projectFile) {
        setSessionTemperature(temperature);
        onProjectEdited();
      } else {
        updateActiveProfile({ temperature });
      }
    },
    setProtocol(protocol) {
      if (projectFile) {
        setSessionProtocol(protocol);
        onProjectEdited();
      } else {
        updateActiveProfile({ protocol });
      }
    },
    setStreamingPreferred(streaming) {
      streamingPreferenceChangedRef.current = true;
      setStreamingPreferredState(streaming);
    },
    applyDraft(draft) {
      setSessionModel(draft.model);
      setSessionTemperature(draft.temperature);
      setSessionProtocol(draft.protocol);
    },
    currentRequest: () => requestFromSettings(resolved, messages),
  };
}
