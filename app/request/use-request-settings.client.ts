"use client";

import { useEffect, useRef, useState } from "react";

import { updateConnectionRequirementProtocol } from "../../packages/core/src/project.ts";
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
  /** Without a project, model and temperature edits write the active profile. */
  updateActiveProfile(patch: StoredInferenceProfilePatch): void;
  /** With a project, model and temperature edits are unsaved project work. */
  onProjectEdited(): void;
  /**
   * With a project, the protocol is part of its connection requirement, so
   * changing it is a project mutation rather than session state.
   */
  currentProjectDocument(): ProjectFile;
  adoptProjectMutation(project: ProjectFile): void;
  onProjectError(message: string): void;
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
  /** Adopts a project draft's model and temperature as this session's. */
  applyDraft(draft: { model: string; temperature?: number }): void;
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
    currentProjectDocument,
    adoptProjectMutation,
    onProjectError,
  } = options;
  const [sessionModel, setSessionModel] = useState<string>();
  const [sessionTemperature, setSessionTemperature] = useState<number>();
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
      const requirement = resolved.connectionRequirement;
      if (!requirement) {
        updateActiveProfile({ protocol });
        return;
      }
      try {
        adoptProjectMutation(
          updateConnectionRequirementProtocol(
            currentProjectDocument(),
            requirement.id,
            protocol,
          ),
        );
      } catch (error) {
        onProjectError(
          error instanceof Error
            ? error.message
            : "Could not change the project's protocol.",
        );
      }
    },
    setStreamingPreferred(streaming) {
      streamingPreferenceChangedRef.current = true;
      setStreamingPreferredState(streaming);
    },
    applyDraft(draft) {
      setSessionModel(draft.model);
      setSessionTemperature(draft.temperature);
    },
    currentRequest: () => requestFromSettings(resolved, messages),
  };
}
