import type { NextConfig } from "next";

const isTauriBuild = process.env.TRACE_LENS_TARGET === "tauri";

const nextConfig: NextConfig = {
  // The web deployment keeps its self-contained Node server. The desktop
  // build has no Node sidecar: Tauri hosts provider requests natively.
  output: isTauriBuild ? "export" : "standalone",
};

export default nextConfig;
