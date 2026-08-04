import assert from "node:assert/strict";
import test, { after } from "node:test";

import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});

after(() => dom.window.close());

const weather = {
  id: "weather",
  label: "Local weather script",
  description: "Answers with a fixed reading.",
  executable: "/opt/fixtures/weather.mjs",
  args: ["--json"],
  timeoutMs: 30000,
  maxOutputBytes: 1048576,
  resultFormat: "json",
};

/**
 * Drives the consent surface itself.
 *
 * The property under test is not that a select exists — it is that granting is
 * a separate act from selecting, and that the exact command line is on screen
 * before the button that allows it. A UI where picking a name is the grant
 * would pass every unit test in the tool track and still be the wrong thing.
 */
async function withEditor({ commands = [weather], availability = { kind: "ready" }, initialGrants = [] }, run) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "warn",
  });
  const [{ CommandToolBindingEditor }, { createElement, useState }, { createRoot }, { act }] =
    await Promise.all([
      server.ssrLoadModule("/app/tools/command-tool-binding-editor.client.tsx"),
      import("react"),
      import("react-dom/client"),
      import("react"),
    ]);

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const calls = { granted: [], revoked: [] };

  function Harness() {
    const [grants, setGrants] = useState(initialGrants);
    return createElement(CommandToolBindingEditor, {
      toolId: "tool_weather",
      toolLabel: "get_weather",
      commandTools: {
        availability,
        commands,
        grantFor: (toolId) => grants.find((grant) => grant.toolId === toolId),
        bindingFor: () => undefined,
        grant: (toolId, commandId) => {
          calls.granted.push([toolId, commandId]);
          setGrants([{ toolId, commandId, grantedAt: "2026-08-04T10:00:00.000Z" }]);
        },
        revoke: (toolId) => {
          calls.revoked.push(toolId);
          setGrants([]);
        },
      },
    });
  }

  try {
    await act(async () => {
      root.render(createElement(Harness));
    });
    await run({ container, act, calls });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await server.close();
  }
}

function button(container, text) {
  return [...container.querySelectorAll("button")].find((element) =>
    element.textContent.trim().startsWith(text),
  );
}

test("choosing a command shows exactly what would run, and grants nothing yet", async () => {
  await withEditor({}, async ({ container, act, calls }) => {
    assert.doesNotMatch(container.textContent, /\/opt\/fixtures\/weather\.mjs/);

    const select = container.querySelector("select");
    await act(async () => {
      select.value = "weather";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });

    assert.match(container.textContent, /\/opt\/fixtures\/weather\.mjs --json/);
    assert.match(container.textContent, /Stops after 30000ms/);
    assert.match(container.textContent, /written to its stdin/);
    assert.match(container.textContent, /without this service’s environment/);
    assert.equal(calls.granted.length, 0, "selecting must not be consenting");

    await act(async () => button(container, "Allow").click());
    assert.deepEqual(calls.granted, [["tool_weather", "weather"]]);
    assert.match(container.textContent, /answers get_weather on this device/);
    assert.match(container.textContent, /Allowed on 2026-08-04/);
  });
});

test("a granted command can be revoked from the same place", async () => {
  await withEditor(
    {
      initialGrants: [
        { toolId: "tool_weather", commandId: "weather", grantedAt: "2026-08-04T10:00:00.000Z" },
      ],
    },
    async ({ container, act, calls }) => {
      await act(async () => button(container, "Stop allowing").click());

      assert.deepEqual(calls.revoked, ["tool_weather"]);
      assert.doesNotMatch(container.textContent, /answers get_weather on this device/);
    },
  );
});

/**
 * Removing a command from the catalog is how an operator revokes it. Silently
 * falling back to "nothing selected" would read as a UI that forgot.
 */
test("a grant whose command the service no longer declares is explained", async () => {
  await withEditor(
    {
      commands: [],
      initialGrants: [
        { toolId: "tool_weather", commandId: "weather", grantedAt: "2026-08-04T10:00:00.000Z" },
      ],
    },
    async ({ container }) => {
      assert.match(container.textContent, /no longer declares/);
      assert.match(container.textContent, /will not run/);
    },
  );
});

test("each reason command tools are unavailable gets its own sentence", async () => {
  const cases = [
    [{ kind: "unconfigured", variable: "INFERENCE_LENS_COMMAND_TOOLS" }, /INFERENCE_LENS_COMMAND_TOOLS/],
    [{ kind: "unsupported-shell" }, /desktop app cannot run command tools/],
    [{ kind: "invalid", variable: "INFERENCE_LENS_COMMAND_TOOLS", problem: "catalog line 3 is wrong" }, /catalog line 3 is wrong/],
    [{ kind: "unreachable", message: "Failed to fetch" }, /Failed to fetch/],
    [{ kind: "loading" }, /Checking what this device can run/],
  ];

  for (const [availability, expected] of cases) {
    await withEditor({ availability, commands: [] }, async ({ container }) => {
      assert.match(container.textContent, expected);
      assert.equal(container.querySelector("select"), null);
    });
  }

  // Configured, reachable, and declaring nothing is its own state too: an
  // empty list with no explanation reads as a broken feature.
  await withEditor({ availability: { kind: "ready" }, commands: [] }, async ({ container }) => {
    assert.match(container.textContent, /declares no commands/);
  });
});
