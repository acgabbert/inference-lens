"use client";

import {
  emptyToolRegistry,
  parseToolRegistry,
} from "../packages/core/src/tool-registry";
import type { ToolRegistryV1 } from "../packages/core/src/tool-registry";

const STORAGE_KEY = "trace-lens:tool-registry:v1";

export function readToolRegistry(): ToolRegistryV1 {
  if (typeof window === "undefined") return emptyToolRegistry();
  try {
    return parseToolRegistry(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null"),
    );
  } catch {
    return emptyToolRegistry();
  }
}

export function writeToolRegistry(registry: ToolRegistryV1): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(registry));
}
