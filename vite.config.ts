import vinext from "vinext";
import { defineConfig } from "vite";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

// The shared assets 2b gate (app/workbench/personal-workbench-gate.ts). vinext
// inlines NEXT_PUBLIC_ variables only when they are set; defining it always
// keeps an unset flag from leaving a bare `process.env` read in the bundle.
const personalWorkbenchFlag = "NEXT_PUBLIC_INFERENCE_LENS_PERSONAL_WORKBENCH";

export default defineConfig({
  define: {
    [`process.env.${personalWorkbenchFlag}`]: JSON.stringify(process.env[personalWorkbenchFlag] ?? ""),
  },
  // The gated e2e server runs beside the ordinary one, from the same checkout,
  // so it keeps its own dependency cache (playwright.config.ts).
  ...(process.env.INFERENCE_LENS_VITE_CACHE_DIR
    ? { cacheDir: process.env.INFERENCE_LENS_VITE_CACHE_DIR }
    : {}),
  server: {
    // `npm run dev` is plain `vite dev`, whose default port is 5173. Keep the
    // port the docs and the production server use; `--port` still overrides
    // it (the e2e suite and `dev:tauri` both pass one). The vinext plugin
    // below is what loads .env (tests/dev-server-dotenv.test.mjs).
    port: 3000,
    ...(isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : {}),
  },
  plugins: [vinext()],
});
