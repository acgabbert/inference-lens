"use client";

import { useEffect, useState } from "react";

import { emptyToolRegistry } from "../../packages/core/src/tool-registry.ts";
import type { ToolRegistryV1 } from "../../packages/core/src/tool-registry.ts";
import {
  readToolRegistry,
  writeToolRegistry,
} from "../tool-registry-store.client.ts";

export interface ToolRegistryHandle {
  registry: ToolRegistryV1;
  setRegistry(registry: ToolRegistryV1): void;
}

/**
 * The device-local tool library.
 *
 * It renders empty on the server and on first paint, reads the stored library
 * after hydration, and writes every later change back. Writing waits for that
 * read, or the empty starting library would replace the stored one on load.
 * Attaching a library tool copies a snapshot into the request draft, which
 * owns it from then on.
 */
export function useToolRegistry(): ToolRegistryHandle {
  const [registry, setRegistry] = useState<ToolRegistryV1>(emptyToolRegistry);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const registryId = window.setTimeout(() => {
      setRegistry(readToolRegistry());
      setLoaded(true);
    }, 0);
    return () => window.clearTimeout(registryId);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    writeToolRegistry(registry);
  }, [registry, loaded]);

  return { registry, setRegistry };
}
