import assert from "node:assert/strict";
import test from "node:test";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";

async function render(modulePath, component, props) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    logLevel: "warn",
  });
  try {
    const [module, { renderToStaticMarkup }, { createElement }] =
      await Promise.all([
        server.ssrLoadModule(modulePath),
        import("react-dom/server"),
        import("react"),
      ]);
    return renderToStaticMarkup(createElement(module[component], props));
  } finally {
    await server.close();
  }
}

function toolsPane(overrides) {
  return {
    tools: [],
    requestTools: [],
    enabledToolIds: [],
    activeProfileName: "Local llama",
    toolsEnabled: true,
    onOpenLibrary: () => {},
    onOpenConnectionSettings: () => {},
    onAddTool: () => {},
    onRemoveTool: () => {},
    onUpdateTool: () => {},
    onSetToolEnabled: () => {},
    mockForTool: () => undefined,
    onUpdateToolMock: () => {},
    onRemoveRequestTool: () => {},
    ...overrides,
  };
}

const projectTool = {
  id: "tool_lookup",
  name: "lookup_order",
  description: "Find an order by id",
  inputSchema: { type: "object", properties: {} },
};

const oneShotTool = {
  id: "tool_scratch",
  name: "scratch_pad",
  description: "",
  inputSchema: { type: "object", properties: {} },
};

test("the tool manifest lists both routes to a request in one place", async () => {
  const html = await render("/app/tools-pane.client.tsx", "ToolsPane", toolsPane({
    tools: [projectTool],
    enabledToolIds: ["tool_lookup"],
    requestTools: [oneShotTool],
  }));

  assert.match(html, /2 tools will be sent/);
  assert.match(html, /lookup_order/);
  assert.match(html, /scratch_pad/);
  assert.match(html, /tool-origin project/);
  assert.match(html, /tool-origin once/);
});

test("an unselected project tool is counted out of the manifest", async () => {
  const html = await render("/app/tools-pane.client.tsx", "ToolsPane", toolsPane({
    tools: [projectTool],
    enabledToolIds: [],
  }));

  assert.match(html, /No tools will be sent/);
  assert.doesNotMatch(html, /tool-origin project/);
  // The definition itself is still editable below the manifest.
  assert.match(html, /Send with requests/);
});

test("a profile that cannot call tools says so where the tools are listed", async () => {
  const html = await render("/app/tools-pane.client.tsx", "ToolsPane", toolsPane({
    tools: [projectTool],
    enabledToolIds: ["tool_lookup"],
    toolsEnabled: false,
  }));

  assert.match(html, /tool-manifest blocked/);
  assert.match(html, /does not allow tool calling/);
  assert.match(html, /Allow tool calling/);
});

test("a blocked run states its reason and its fix in the request pane", async () => {
  const html = await render(
    "/app/run-readiness-notice.client.tsx",
    "RunReadinessNotice",
    {
      readiness: {
        blocked: true,
        headline: "This project is not connected to a local profile yet",
        detail: "A project never carries a credential.",
        summary: "Map this project's connection to a local profile before running.",
        facts: [
          { label: "Project expects", value: "https://api.openai.com/v1" },
          { label: 'Profile "Local llama"', value: "http://127.0.0.1:8080/v1" },
        ],
        actions: [
          { kind: "map-profile", label: 'Use "Local llama"', primary: true },
          { kind: "open-connections", label: "Choose another profile" },
        ],
      },
      onAction: () => {},
    },
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /not connected to a local profile/);
  assert.match(html, /https:\/\/api\.openai\.com\/v1/);
  assert.match(html, /http:\/\/127\.0\.0\.1:8080\/v1/);
  assert.match(html, /Use &quot;Local llama&quot;/);
});

test("nothing renders when the run is ready", async () => {
  const html = await render(
    "/app/run-readiness-notice.client.tsx",
    "RunReadinessNotice",
    { onAction: () => {} },
  );

  assert.equal(html, "");
});
