import vinext from "vinext";
import { defineConfig } from "vite";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig({
  server: {
    // `vinext dev` now hands its flags straight to Vite, whose default port is
    // 5173. Keep the port the docs and the production server use; `--port`
    // still overrides it (the e2e suite and `dev:tauri` both pass one).
    port: 3000,
    ...(isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : {}),
  },
  plugins: [vinext()],
});
