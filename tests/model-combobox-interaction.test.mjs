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
  HTMLButtonElement: dom.window.HTMLButtonElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});

after(() => dom.window.close());

function loadedDiscovery(models) {
  return { profileKey: "fixture", status: "loaded", models };
}

async function mount(overrides = {}) {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "warn",
  });
  const [{ createElement, act }, { createRoot }, { ModelCombobox }] =
    await Promise.all([
      import("react"),
      import("react-dom/client"),
      server.ssrLoadModule("/app/model-combobox.client.tsx"),
    ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const noop = () => {};
  const props = {
    value: "",
    onChange: noop,
    discovery: loadedDiscovery(["gpt-4o", "gpt-4o-mini", "o3"]),
    onLoadModels: noop,
    favoriteModels: [],
    onToggleFavoriteModel: noop,
    ...overrides,
  };
  await act(async () => {
    root.render(createElement(ModelCombobox, props));
  });
  return {
    container,
    input: () => container.querySelector('input[role="combobox"]'),
    options: () => Array.from(container.querySelectorAll('[role="option"]')),
    favoriteToggle: (model) =>
      container.querySelector(
        `[aria-label="Favorite ${model}"], [aria-label="Unfavorite ${model}"]`,
      ),
    async click(element) {
      await act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
    },
    async mousedown(element) {
      await act(async () => {
        element.dispatchEvent(
          new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
        );
      });
    },
    async keydown(element, key) {
      await act(async () => {
        element.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }),
        );
      });
    },
    async focus() {
      await act(async () => {
        this.input().focus();
      });
    },
    async type(input, value) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        ).set;
        setter.call(input, value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    async blur(element) {
      // React 17+ implements onBlur via the bubbling "focusout" event, not the
      // native non-bubbling "blur" — dispatch the event React listens for.
      await act(async () => {
        element.dispatchEvent(
          new dom.window.FocusEvent("focusout", { bubbles: true }),
        );
      });
    },
    async close() {
      await act(async () => root.unmount());
      container.remove();
      await server.close();
    },
  };
}

test("favorited models render above the discovered list", async () => {
  const view = await mount({
    discovery: loadedDiscovery(["gpt-4o", "gpt-4o-mini", "o3"]),
    favoriteModels: ["o3"],
  });
  try {
    await view.focus();

    assert.match(view.container.textContent, /Favorites/);
    const options = view.options();
    // o3 appears once in Favorites and again in the discovered list below,
    // per spec: favoriting never hides a model from ordinary search results.
    assert.deepEqual(
      options.map((option) => option.textContent),
      ["o3", "gpt-4o", "gpt-4o-mini", "o3"],
    );
  } finally {
    await view.close();
  }
});

test("a favorite absent from discovery still renders", async () => {
  const view = await mount({
    discovery: loadedDiscovery(["gpt-4o"]),
    favoriteModels: ["retired-model"],
  });
  try {
    await view.focus();

    assert.match(view.container.textContent, /Favorites/);
    assert.match(view.container.textContent, /retired-model/);
  } finally {
    await view.close();
  }
});

test("clicking the star toggles favorite state without selecting the model or closing the menu", async () => {
  const toggled = [];
  const changed = [];
  const view = await mount({
    discovery: loadedDiscovery(["gpt-4o"]),
    onToggleFavoriteModel: (model) => toggled.push(model),
    onChange: (model) => changed.push(model),
  });
  try {
    await view.focus();
    const star = view.favoriteToggle("gpt-4o");
    assert.ok(star);
    assert.equal(star.getAttribute("aria-pressed"), "false");
    assert.equal(star.getAttribute("aria-label"), "Favorite gpt-4o");

    // The combobox input closes the menu on blur; the star must prevent that
    // blur from registering, the same way the existing Retry/Refresh buttons do.
    await view.mousedown(star);
    await view.click(star);

    assert.deepEqual(toggled, ["gpt-4o"]);
    assert.deepEqual(changed, []);
    assert.ok(view.container.querySelector('[role="listbox"]'));
  } finally {
    await view.close();
  }
});

test("the star reflects favorite state with an accessible unfavorite label", async () => {
  const view = await mount({
    discovery: loadedDiscovery(["gpt-4o"]),
    favoriteModels: ["gpt-4o"],
  });
  try {
    await view.focus();
    const star = view.favoriteToggle("gpt-4o");
    assert.equal(star.getAttribute("aria-pressed"), "true");
    assert.equal(star.getAttribute("aria-label"), "Unfavorite gpt-4o");
  } finally {
    await view.close();
  }
});

test("arrow-key navigation walks the combined favorites-then-discovered order", async () => {
  const selected = [];
  const view = await mount({
    discovery: loadedDiscovery(["gpt-4o", "gpt-4o-mini"]),
    favoriteModels: ["gpt-4o-mini"],
    onChange: (model) => selected.push(model),
  });
  try {
    await view.focus();
    const input = view.input();

    // Row order is [gpt-4o-mini (favorite), gpt-4o, gpt-4o-mini]. One
    // ArrowDown press from the initial highlight (index 0) lands on the
    // discovered gpt-4o at index 1.
    await view.keydown(input, "ArrowDown");
    await view.keydown(input, "Enter");

    assert.deepEqual(selected, ["gpt-4o"]);
  } finally {
    await view.close();
  }
});

test("favorites stay reachable while the catalogue is loading", async () => {
  const view = await mount({
    discovery: { profileKey: "fixture", status: "loading", models: [] },
    favoriteModels: ["o3"],
  });
  try {
    await view.focus();

    // Favorites are stored ids, not discovered ones: waiting on a 300-model
    // catalogue is exactly when they are most useful.
    assert.match(view.container.textContent, /Favorites/);
    assert.deepEqual(
      view.options().map((option) => option.textContent),
      ["o3"],
    );
    assert.match(view.container.textContent, /Loading models…/);
  } finally {
    await view.close();
  }
});

test("favorites stay reachable when discovery fails", async () => {
  const view = await mount({
    discovery: {
      profileKey: "fixture",
      status: "failed",
      models: [],
      error: "Could not list models.",
    },
    favoriteModels: ["o3"],
  });
  try {
    await view.focus();

    assert.match(view.container.textContent, /Favorites/);
    assert.deepEqual(
      view.options().map((option) => option.textContent),
      ["o3"],
    );
    assert.match(view.container.textContent, /Could not list models\./);
  } finally {
    await view.close();
  }
});

test("selecting a favorite while discovery is unavailable still commits it", async () => {
  const selected = [];
  const view = await mount({
    discovery: { profileKey: "fixture", status: "loading", models: [] },
    favoriteModels: ["o3"],
    onChange: (model) => selected.push(model),
  });
  try {
    await view.focus();
    // `rows` must index the favorites-only list, or Enter selects nothing.
    await view.keydown(view.input(), "Enter");

    assert.deepEqual(selected, ["o3"]);
  } finally {
    await view.close();
  }
});

test("clearing the field never commits an empty model", async () => {
  const changed = [];
  const view = await mount({
    value: "gpt-4o",
    discovery: loadedDiscovery(["gpt-4o"]),
    onChange: (model) => changed.push(model),
  });
  try {
    await view.focus();
    const input = view.input();
    await view.type(input, "");

    // An open project's defaults.target.model requires a non-empty id, so an
    // empty field must stay local to the input rather than reaching the
    // project document, which would throw ProjectValidationError.
    assert.deepEqual(changed, []);
    // The field still shows empty so the user can retype.
    assert.equal(input.value, "");

    await view.type(input, "o3");
    assert.deepEqual(changed, ["o3"]);
  } finally {
    await view.close();
  }
});

test("leaving the field empty restores the model still in effect", async () => {
  const changed = [];
  const view = await mount({
    value: "gpt-4o",
    discovery: loadedDiscovery(["gpt-4o"]),
    onChange: (model) => changed.push(model),
  });
  try {
    await view.focus();
    const input = view.input();
    await view.type(input, "   ");
    assert.deepEqual(changed, []);

    await view.blur(input);

    assert.equal(input.value, "gpt-4o");
    assert.deepEqual(changed, []);
  } finally {
    await view.close();
  }
});
