import assert from "node:assert/strict";
import test from "node:test";

import { ssrLoadModule } from "./support/ssr.mjs";

async function render(modulePath, component, props) {
  const [module, { renderToStaticMarkup }, { createElement }] =
    await Promise.all([
      ssrLoadModule(modulePath),
      import("react-dom/server"),
      import("react"),
    ]);
  return renderToStaticMarkup(createElement(module[component], props));
}

const capabilities = {
  chatCompletions: true,
  responsesApi: false,
  streaming: true,
  modelDiscovery: true,
  tools: false,
  parallelToolCalls: false,
  structuredOutput: false,
  vision: false,
  embeddings: false,
};

function credential(overrides) {
  return {
    draft: "",
    status: { canPersist: false, isStored: false, isApprovedForEndpoint: false },
    hasCredential: false,
    webMode: "none",
    setDraft: () => {},
    setWebMode: () => {},
    commit: () => {},
    prepare: async () => ({ kind: "none" }),
    ...overrides,
  };
}

function drawer(overrides) {
  const activeProfile = {
    id: "openai-compatible",
    name: "OpenAI compatible",
    provider: "openai-compatible",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    ...overrides.activeProfile,
  };
  return {
    open: true,
    onClose: () => {},
    profiles: [activeProfile],
    activeProfile,
    capabilities,
    isDesktopRuntime: false,
    onSelectProfile: () => {},
    onAddProfile: () => {},
    onDeleteProfile: () => {},
    onUpdateProfile: () => {},
    onCapabilityChange: () => {},
    connectionRequirements: [],
    mappedProfileIds: {},
    onMapProfile: () => {},
    onUpdateProjectEndpoint: () => {},
    ...overrides,
    activeProfile,
    credential: credential(overrides.credential),
    serverDefault: {
      loaded: true,
      containerized: true,
      configured: false,
      ...overrides.serverDefault,
    },
  };
}

const DRAWER = "/app/connection-drawer.client.tsx";

test("an unconfigured server default is offered but not selectable", async () => {
  const html = await render(DRAWER, "ConnectionDrawer", drawer({}));

  // Visible, so the feature is discoverable, and explained where it is refused.
  assert.match(
    html,
    /<option value="environment-default" disabled="">Server default \(\.env\) — not configured<\/option>/,
  );
  assert.match(html, /INFERENCE_LENS_API_KEY/);
  assert.match(html, /INFERENCE_LENS_API_ENDPOINT/);
});

test("the server-env hint stays out of a non-container deployment", async () => {
  const html = await render(
    DRAWER,
    "ConnectionDrawer",
    drawer({ serverDefault: { containerized: false } }),
  );

  assert.doesNotMatch(html, /Entering a key every session/);
});

test("nothing is claimed about the server before its status is known", async () => {
  const html = await render(
    DRAWER,
    "ConnectionDrawer",
    drawer({ serverDefault: { loaded: false } }),
  );

  assert.doesNotMatch(html, /not configured/);
  assert.doesNotMatch(html, /Entering a key every session/);
});

test("a configured server default explains what it sends and when", async () => {
  const html = await render(
    DRAWER,
    "ConnectionDrawer",
    drawer({
      credential: { webMode: "environment-default" },
      serverDefault: {
        configured: true,
        endpoint: "https://api.openai.com/v1",
      },
    }),
  );

  assert.match(html, /sends its credential only to its configured origin/);
  assert.doesNotMatch(html, /will not be sent to this endpoint/);
  assert.doesNotMatch(html, /not configured/);
});

test("selecting the server default for another provider warns before a run does", async () => {
  const html = await render(
    DRAWER,
    "ConnectionDrawer",
    drawer({
      activeProfile: { endpoint: "https://api.anthropic.com/v1" },
      credential: { webMode: "environment-default" },
      serverDefault: {
        configured: true,
        endpoint: "https://api.openai.com/v1",
      },
    }),
  );

  assert.match(html, /https:\/\/api\.openai\.com/);
  assert.match(html, /will not be sent to this endpoint/);
  assert.match(html, /credential-status-error/);
});

test("malformed server metadata cannot crash the connection drawer", async () => {
  const html = await render(
    DRAWER,
    "ConnectionDrawer",
    drawer({
      credential: { webMode: "environment-default" },
      serverDefault: {
        configured: true,
        endpoint: "not a url?api_key=must-not-render",
      },
    }),
  );

  assert.match(html, /holds no default credential to send/);
  assert.doesNotMatch(html, /must-not-render/);
});

test("a deletable profile offers deletion", async () => {
  const html = await render(DRAWER, "ConnectionDrawer", drawer({}));

  assert.match(html, /<button class="text-button danger" type="button">Delete<\/button>/);
});

test("a profile that cannot be deleted says so on the control itself", async () => {
  const html = await render(
    DRAWER,
    "ConnectionDrawer",
    drawer({ deleteProfileRefusal: "At least one connection profile is required." }),
  );

  assert.match(
    html,
    /<button class="text-button danger" type="button" disabled="" title="At least one connection profile is required\.">Delete<\/button>/,
  );
});

test("a server-provisioned profile locks its endpoint and says why", async () => {
  const html = await render(
    DRAWER,
    "ConnectionDrawer",
    drawer({
      activeProfile: {
        id: "server-default",
        name: "Server default",
        credentialRef: "environment-default",
      },
      serverDefault: { configured: true, endpoint: "https://api.openai.com/v1" },
    }),
  );

  assert.match(html, /Managed by server configuration/);
  assert.match(html, /Create a profile for another provider/);
});

const requirement = {
  id: "connection_local",
  name: "Default connection",
  provider: "openai-compatible",
  protocol: "openai-compatible-chat-completions",
  endpoint: "http://127.0.0.1:8080/v1",
};

test("a mapped project running elsewhere offers to move its declaration", async () => {
  const html = await render(
    DRAWER,
    "ConnectionDrawer",
    drawer({
      connectionRequirements: [requirement],
      mappedProfileIds: { connection_local: "openai-compatible" },
    }),
  );

  assert.match(html, /Mapped to a different endpoint/);
  assert.match(html, /Update “Default connection” to expect this endpoint/);
  assert.match(html, /data-readiness-control="project-endpoint"/);
});

test("an unmapped project cannot move its declaration yet", async () => {
  const html = await render(
    DRAWER,
    "ConnectionDrawer",
    drawer({ connectionRequirements: [requirement] }),
  );

  // The mismatch may simply be the wrong profile selected, so the answer
  // offered is the mapping, not a rewrite of the shared project file.
  assert.match(html, /Connection mapping required/);
  assert.match(html, /data-readiness-control="project-mapping"/);
  assert.doesNotMatch(html, /to expect this endpoint/);
});

test("a project mapping names its own profile independently of the active editor profile", async () => {
  const html = await render(
    DRAWER,
    "ConnectionDrawer",
    drawer({
      profiles: [
        drawer({}).activeProfile,
        { ...drawer({}).activeProfile, id: "profile-elsewhere", name: "Elsewhere", endpoint: requirement.endpoint },
      ],
      connectionRequirements: [requirement],
      mappedProfileIds: { connection_local: "profile-elsewhere" },
    }),
  );

  assert.match(html, /Project connection mapped/);
  assert.match(html, /data-readiness-control="project-mapping"/);
  assert.match(html, /Elsewhere/);
});

test("a mapped project already dialing its declared endpoint says nothing to fix", async () => {
  const html = await render(
    DRAWER,
    "ConnectionDrawer",
    drawer({
      connectionRequirements: [{
        ...requirement,
        endpoint: "https://api.openai.com/v1",
      }],
      mappedProfileIds: { connection_local: "openai-compatible" },
      activeProfile: { endpoint: "https://api.openai.com/v1/chat/completions" },
    }),
  );

  assert.match(html, /Project connection mapped/);
  assert.doesNotMatch(html, /Mapped to a different endpoint/);
  assert.doesNotMatch(html, /to expect this endpoint/);
});
