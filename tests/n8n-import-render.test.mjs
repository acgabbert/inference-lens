import assert from "node:assert/strict";
import test from "node:test";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";

async function renderImportModal() {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    logLevel: "warn",
  });
  try {
    const [{ N8nImportModal }, { renderToStaticMarkup }, { createElement }] =
      await Promise.all([
        server.ssrLoadModule("/app/n8n-import-modal.client.tsx"),
        import("react-dom/server"),
        import("react"),
      ]);
    return renderToStaticMarkup(
      createElement(N8nImportModal, {
        open: true,
        onClose: () => {},
        onImport: async () => {},
      }),
    );
  } finally {
    await server.close();
  }
}

test("renders a focused and safe n8n import workspace shell", async () => {
  const html = await renderImportModal();
  assert.match(html, /role="dialog"/);
  assert.match(html, /Import from n8n/);
  assert.match(html, /Checking n8n integration/);
  assert.doesNotMatch(html, /undefined|NaN|Infinity/);
  assert.doesNotMatch(html, /api.?key.?[:=].+fixture/i);
});
