import assert from "node:assert/strict";
import test from "node:test";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * A brand-new project has no project-owned tool definitions. That must read
 * as "nothing added yet, here's how" rather than as a blank list a user
 * cannot distinguish from a bug — see AGENTS.md's note on silence reading as
 * failure. Rendered through Vite's SSR pipeline so this proves the empty
 * state actually reaches markup, not just that some prop was computed.
 */
async function renderPane(props) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "warn",
  });
  try {
    const [{ ToolsPane }, { renderToStaticMarkup }, { createElement }] =
      await Promise.all([
        server.ssrLoadModule("/app/tools-pane.client.tsx"),
        import("react-dom/server"),
        import("react"),
      ]);
    return renderToStaticMarkup(
      createElement(ToolsPane, {
        tools: [],
        requestTools: [],
        enabledToolIds: [],
        activeProfileName: "Default",
        toolsEnabled: true,
        onOpenLibrary() {},
        onOpenConnectionSettings() {},
        onAddTool() {},
        onRemoveTool() {},
        onUpdateTool() {},
        onSetToolEnabled() {},
        mockForTool() {
          return undefined;
        },
        onUpdateToolMock() {},
        onRemoveRequestTool() {},
        commandTools: {
          availability: { kind: "unconfigured", variable: "INFERENCE_LENS_COMMAND_TOOLS" },
          commands: [],
          grantFor: () => undefined,
          bindingFor: () => undefined,
          grant() {},
          revoke() {},
        },
        ...props,
      }),
    );
  } finally {
    await server.close();
  }
}

function tool(overrides = {}) {
  return {
    id: "tool_example",
    name: "example_tool",
    description: "An example tool.",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

test("a project with no tools yet shows an empty state with an add action", async () => {
  const html = await renderPane({ tools: [] });

  assert.match(html, /No project tools yet/);
  assert.match(html, /saved with this project/);
  assert.match(html, /\+ Add project tool/);
});

test("a project with tools does not show the empty state", async () => {
  const html = await renderPane({
    tools: [tool()],
    enabledToolIds: ["tool_example"],
  });

  assert.doesNotMatch(html, /No project tools yet/);
  assert.match(html, /example_tool/);
});
