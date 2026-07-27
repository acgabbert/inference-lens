"use client";

import { useEffect, useState } from "react";
import { insecureOriginNotice } from "./insecure-origin-notice.client.ts";
import type { InsecureOriginNotice } from "./insecure-origin-notice.client.ts";

const DISMISSED_ORIGINS_STORAGE_KEY =
  "inference-lens:insecure-origin-dismissed:v1";

function dismissedOrigins(): string[] {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(DISMISSED_ORIGINS_STORAGE_KEY) ?? "[]",
    ) as unknown;
    return Array.isArray(stored)
      ? stored.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

export interface InsecureOriginHandle {
  notice?: InsecureOriginNotice;
  dismiss(): void;
}

/**
 * Advises — never blocks — when the workbench is open on an origin browsers do
 * not trust. Dismissal is remembered per origin, so acknowledging it on a LAN
 * address does not silence it on the `0.0.0.0` one that is worth catching.
 *
 * The location is read after mount because the first browser render must match
 * the server's, which has no location at all.
 */
export function useInsecureOriginNotice(
  containerized: boolean,
): InsecureOriginHandle {
  const [dismissed, setDismissed] = useState(true);
  const [notice, setNotice] = useState<InsecureOriginNotice>();

  useEffect(() => {
    const readId = window.setTimeout(() => {
      setNotice(
        insecureOriginNotice({
          isSecureContext: window.isSecureContext,
          hostname: window.location.hostname,
          port: window.location.port,
          containerized,
        }),
      );
      setDismissed(dismissedOrigins().includes(window.location.origin));
    }, 0);
    return () => window.clearTimeout(readId);
  }, [containerized]);

  return {
    ...(notice && !dismissed ? { notice } : {}),
    dismiss: () => {
      setDismissed(true);
      const origins = new Set(dismissedOrigins());
      origins.add(window.location.origin);
      window.localStorage.setItem(
        DISMISSED_ORIGINS_STORAGE_KEY,
        JSON.stringify([...origins]),
      );
    },
  };
}
