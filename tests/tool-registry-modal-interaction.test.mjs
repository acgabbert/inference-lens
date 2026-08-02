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

function registry() {
  return {
    schemaVersion: 1,
    tools: [
      {
        id: "registry-tool_interaction",
        name: "search",
        description: "Look things up.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        createdAt: "2026-07-31T12:00:00.000Z",
        updatedAt: "2026-07-31T12:00:00.000Z",
      },
    ],
  };
}

/**
 * Mirrors how app/page.tsx wires the shared confirmation dialog: a single
 * piece of confirmation state owned above the tool registry modal, with the
 * ConfirmationDialog rendered as a sibling overlay.
 */
async function withHarness(run) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "warn",
  });
  const [
    { ToolRegistryModal },
    { ConfirmationDialog },
    { createElement, useState },
    { createRoot },
    { act },
  ] = await Promise.all([
    server.ssrLoadModule("/app/tool-registry-modal.client.tsx"),
    server.ssrLoadModule("/app/confirmation-dialog.client.tsx"),
    import("react"),
    import("react-dom/client"),
    import("react"),
  ]);

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  const calls = { onChange: 0, modalClosed: 0, confirmations: [] };

  function Harness() {
    const [reg, setReg] = useState(registry());
    const [confirmation, setConfirmation] = useState();
    return createElement(
      "div",
      null,
      createElement(ToolRegistryModal, {
        open: true,
        registry: reg,
        onChange: (next) => {
          calls.onChange += 1;
          setReg(next);
        },
        onAttachToProject: () => undefined,
        onAttachToRequest: () => undefined,
        requestConfirmation: (request) => {
          calls.confirmations.push(request);
          setConfirmation(request);
        },
        onClose: () => {
          calls.modalClosed += 1;
        },
      }),
      confirmation &&
        createElement(ConfirmationDialog, {
          request: confirmation,
          onClose: () => setConfirmation(undefined),
        }),
    );
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

test("deleting a library tool routes through the in-app confirmation dialog, not window.confirm", async () => {
  await withHarness(async ({ container, act, calls }) => {
    const deleteButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Delete",
    );
    assert.ok(deleteButton);

    await act(async () => deleteButton.click());

    assert.equal(calls.onChange, 0, "deletion must wait for confirmation");
    assert.equal(calls.confirmations.length, 1);
    const request = calls.confirmations[0];
    assert.equal(request.destructive, true);
    assert.match(request.title, /search/);
    assert.match(request.description, /can't be undone/);
    assert.match(request.description, /keeps its own snapshot/);

    const dialog = container.querySelector(".confirmation-dialog");
    assert.ok(dialog, "confirmation dialog should be rendered above the modal");

    // Cancelling must dismiss only the confirmation, not the registry modal.
    const cancelButton = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Cancel",
    );
    await act(async () => cancelButton.click());

    assert.equal(calls.onChange, 0, "cancel must not delete the tool");
    assert.equal(calls.modalClosed, 0, "cancel must not close the tool registry modal");
    assert.ok(
      container.querySelector(".confirmation-dialog") === null,
      "confirmation dialog should be gone after cancel",
    );
    assert.ok(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent.trim() === "Delete",
      ),
      "tool registry modal should remain open after cancel",
    );
  });
});

test("confirming the dialog deletes the tool", async () => {
  await withHarness(async ({ container, act, calls }) => {
    const deleteButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Delete",
    );
    await act(async () => deleteButton.click());

    const dialog = container.querySelector(".confirmation-dialog");
    const confirmButton = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Delete tool",
    );
    assert.ok(confirmButton);

    await act(async () => confirmButton.click());

    assert.equal(calls.onChange, 1);
    assert.equal(
      container.querySelector(".registry-empty") !== null,
      true,
      "the deleted tool's editor should be replaced by the empty state",
    );
  });
});

test("pressing Escape while the delete confirmation is open closes only the confirmation", async () => {
  await withHarness(async ({ container, act, calls }) => {
    const deleteButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Delete",
    );
    await act(async () => deleteButton.click());
    assert.ok(container.querySelector(".confirmation-dialog"));

    await act(async () => {
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    assert.equal(
      container.querySelector(".confirmation-dialog"),
      null,
      "Escape should close the confirmation dialog",
    );
    assert.equal(
      calls.modalClosed,
      0,
      "Escape should not also close the underlying tool registry modal",
    );
    assert.equal(calls.onChange, 0, "dismissing via Escape must not delete the tool");
  });
});
