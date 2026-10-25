import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultProfile,
  nextCapabilityOverrides,
  withServerProtocols,
  profileDeletionRefusal,
  readProfiles,
  removeProfile,
  servesSystemOne,
  toggleFavoriteModel,
  withSystemOne,
  writeProfiles,
} from "../app/profile-store.client.ts";
import type { StoredInferenceProfile } from "../app/profile-store.client.ts";
import {
  defaultWebCredentialMode,
  parseRuntimeStatus,
  reconcileServerProfiles,
  reconcileWebCredentialModes,
} from "../app/server-connection-profiles.ts";
import type { ServerConnection } from "../app/server-connection-profiles.ts";
import type { WebCredentialMode } from "../app/web-credential-mode.ts";
import { resolveProviderCapabilities } from "../packages/core/src/types.ts";

// The openai-compatible baseline enables modelDiscovery and disables tools.
function profile(
  overrides?: StoredInferenceProfile["capabilityOverrides"],
): StoredInferenceProfile {
  return { ...createDefaultProfile(), capabilityOverrides: overrides };
}

test("the starting profile carries no endpoint or model", () => {
  const starter = createDefaultProfile();
  assert.equal(starter.endpoint, "");
  assert.equal(starter.model, "");
  assert.equal(starter.temperature, undefined);
});

test("fixed profile ids still receive non-reused instance identities", () => {
  const first = createDefaultProfile();
  const second = createDefaultProfile();

  assert.equal(first.id, second.id);
  assert.notEqual(first.instanceId, second.instanceId);
});

test("legacy stored profiles gain an instance identity that is persisted", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let stored = JSON.stringify({
    profiles: [
      {
        id: "openai-compatible",
        name: "Legacy profile",
        provider: "openai-compatible",
        endpoint: "https://api.example.com/v1",
        model: "example-model",
        temperature: 0.7,
      },
    ],
    activeProfileId: "openai-compatible",
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: () => stored,
        setItem: (_key: string, value: string) => {
          stored = value;
        },
      },
    },
  });

  try {
    const snapshot = readProfiles();
    assert.equal(snapshot.restored, true);
    assert.match(snapshot.profiles[0]!.instanceId, /^profile-instance-/);
    assert.equal(snapshot.profiles[0]!.temperature, 0.7);

    writeProfiles(snapshot);
    assert.equal(
      JSON.parse(stored).profiles[0].instanceId,
      snapshot.profiles[0]!.instanceId,
    );
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
});

test("records only capabilities that differ from the provider baseline", () => {
  assert.deepEqual(nextCapabilityOverrides(profile(), "tools", true), {
    tools: true,
  });
  assert.deepEqual(
    nextCapabilityOverrides(profile(), "modelDiscovery", false),
    { modelDiscovery: false },
  );
});

test("drops an override that returns to the provider baseline", () => {
  assert.equal(
    nextCapabilityOverrides(profile({ tools: true }), "tools", false),
    undefined,
  );
  assert.equal(
    nextCapabilityOverrides(
      profile({ modelDiscovery: false }),
      "modelDiscovery",
      true,
    ),
    undefined,
  );
});

test("keeps unrelated overrides when one returns to the baseline", () => {
  assert.deepEqual(
    nextCapabilityOverrides(
      profile({ tools: true, modelDiscovery: false }),
      "tools",
      false,
    ),
    { modelDiscovery: false },
  );
});

test("re-setting a capability to its current override is a no-op", () => {
  assert.deepEqual(
    nextCapabilityOverrides(profile({ tools: true }), "tools", true),
    { tools: true },
  );
});

test("does not mutate the profile it is given", () => {
  const existing = profile({ tools: true });

  nextCapabilityOverrides(existing, "modelDiscovery", false);

  assert.deepEqual(existing.capabilityOverrides, { tools: true });
});

function named(id: string): StoredInferenceProfile {
  return { ...createDefaultProfile(), id, name: id };
}

function snapshot(activeProfileId: string, ...ids: string[]) {
  return { profiles: ids.map(named), activeProfileId };
}

test("removing a profile that is not active leaves the selection alone", () => {
  const result = removeProfile(snapshot("a", "a", "b", "c"), "b");

  assert.deepEqual(
    result?.profiles.map(({ id }) => id),
    ["a", "c"],
  );
  assert.equal(result?.activeProfileId, "a");
});

test("removing the active profile selects the one that takes its place", () => {
  const result = removeProfile(snapshot("b", "a", "b", "c"), "b");

  assert.equal(result?.activeProfileId, "c");
});

test("removing the last profile in the list selects the new last one", () => {
  const result = removeProfile(snapshot("c", "a", "b", "c"), "c");

  assert.equal(result?.activeProfileId, "b");
});

test("refuses to remove the only profile, or one that is not there", () => {
  assert.equal(removeProfile(snapshot("a", "a"), "a"), undefined);
  assert.equal(removeProfile(snapshot("a", "a", "b"), "gone"), undefined);
});

test("does not mutate the snapshot it is given", () => {
  const existing = snapshot("b", "a", "b");

  removeProfile(existing, "b");

  assert.deepEqual(
    existing.profiles.map(({ id }) => id),
    ["a", "b"],
  );
  assert.equal(existing.activeProfileId, "b");
});

test("deletion is refused while a profile is the only one left", () => {
  const only = named("a");

  assert.match(
    profileDeletionRefusal([only], only, undefined) ?? "",
    /At least one connection profile/,
  );
  assert.equal(profileDeletionRefusal([only, named("b")], only, undefined), undefined);
});

test("toggling a model favorites it, and again unfavorites it", () => {
  const once = toggleFavoriteModel(undefined, "gpt-4o");
  assert.deepEqual(once, ["gpt-4o"]);

  const twice = toggleFavoriteModel(once, "gpt-4o");
  assert.equal(twice, undefined);
});

test("favoriting a second model appends to the existing list", () => {
  const first = toggleFavoriteModel(undefined, "gpt-4o");
  const second = toggleFavoriteModel(first, "claude-opus");

  assert.deepEqual(second, ["gpt-4o", "claude-opus"]);
});

test("does not mutate the favorites array it is given", () => {
  const existing = ["gpt-4o"];

  toggleFavoriteModel(existing, "claude-opus");

  assert.deepEqual(existing, ["gpt-4o"]);
});

test("toggling a blank model id is a no-op", () => {
  assert.deepEqual(toggleFavoriteModel(["gpt-4o"], "   "), ["gpt-4o"]);
});

test("legacy stored profiles without favorites default to none, and persist favorites once set", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let stored = JSON.stringify({
    profiles: [
      {
        id: "openai-compatible",
        name: "Legacy profile",
        provider: "openai-compatible",
        endpoint: "https://api.example.com/v1",
        model: "example-model",
      },
    ],
    activeProfileId: "openai-compatible",
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: () => stored,
        setItem: (_key: string, value: string) => {
          stored = value;
        },
      },
    },
  });

  try {
    const snapshot = readProfiles();
    assert.equal(snapshot.profiles[0]!.favoriteModels, undefined);

    const withFavorite = {
      ...snapshot,
      profiles: [
        {
          ...snapshot.profiles[0]!,
          favoriteModels: toggleFavoriteModel(
            snapshot.profiles[0]!.favoriteModels,
            "gpt-4o",
          ),
        },
      ],
    };
    writeProfiles(withFavorite);

    const restored = readProfiles();
    assert.deepEqual(restored.profiles[0]!.favoriteModels, ["gpt-4o"]);
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
});

test("a server-provisioned profile is deletable only once unconfigured", () => {
  const provisioned: StoredInferenceProfile = {
    ...named("server-default"),
    credentialRef: "environment-default",
  };
  const profiles = [provisioned, named("b")];

  assert.match(
    profileDeletionRefusal(profiles, provisioned, { id: "default", credentialConfigured: true }) ?? "",
    /INFERENCE_LENS_API_KEY/,
  );
  // Released by the reconcile once the server stops declaring a credential,
  // and from then on it is an ordinary profile.
  assert.equal(
    profileDeletionRefusal(profiles, provisioned, { id: "default", credentialConfigured: false }),
    undefined,
  );
  assert.equal(profileDeletionRefusal(profiles, provisioned, undefined), undefined);
});

test("a catalog profile's deletion refusal names the catalog, not the legacy variables", () => {
  const provisioned: StoredInferenceProfile = {
    ...named("server-decide"),
    credentialRef: "environment-default:decide",
  };
  const refusal =
    profileDeletionRefusal([provisioned, named("b")], provisioned, {
      id: "decide",
      credentialConfigured: true,
    }) ?? "";
  assert.match(refusal, /INFERENCE_LENS_CONNECTIONS/);
  assert.match(refusal, /"decide"/);
  assert.doesNotMatch(refusal, /INFERENCE_LENS_API_KEY/);
});

test("the server's protocol list becomes the profile's protocol capabilities", () => {
  const anthropicOnly = withServerProtocols(profile(), ["anthropic-messages"]);
  assert.deepEqual(anthropicOnly.capabilityOverrides, {
    chatCompletions: false,
    anthropicMessages: true,
  });
  // Unrelated overrides survive, and a list matching the baseline stores none.
  const reset = withServerProtocols(
    profile({ tools: true, responsesApi: true }),
    ["openai-compatible-chat-completions"],
  );
  assert.deepEqual(reset.capabilityOverrides, { tools: true });
  const plain = withServerProtocols(profile(), ["openai-compatible-chat-completions"]);
  assert.equal(plain.capabilityOverrides, undefined);
});

test("the server's protocol list also states whether the profile serves System One", () => {
  // Named in the list: declared, whatever the browser had.
  const declared = withServerProtocols(profile(), ["openai-compatible-chat-completions"], true);
  assert.equal(servesSystemOne(declared), true);
  // A set list that does not name it withdraws a browser-made declaration (D9a).
  const withdrawn = withServerProtocols(
    withSystemOne(profile(), true),
    ["openai-compatible-chat-completions"],
    false,
  );
  assert.equal(servesSystemOne(withdrawn), false);
  assert.equal("systemOne" in withdrawn, false);
  // A decision-only server turns every chat protocol off.
  const decisionOnly = withServerProtocols(profile(), [], true);
  assert.deepEqual(decisionOnly.capabilityOverrides, { chatCompletions: false });
  assert.equal(servesSystemOne(decisionOnly), true);
});

test("a stored protocol preference survives a reload, and an unknown one is dropped", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let stored = JSON.stringify({
    profiles: [
      {
        id: "responses",
        name: "Responses",
        provider: "openai-compatible",
        endpoint: "https://api.example.com/v1",
        model: "example-model",
        protocol: "openai-responses",
      },
      {
        id: "future",
        name: "Future",
        provider: "openai-compatible",
        endpoint: "https://api.example.com/v1",
        model: "example-model",
        protocol: "openai-assistants",
      },
    ],
    activeProfileId: "responses",
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: () => stored,
        setItem: (_key: string, value: string) => {
          stored = value;
        },
      },
    },
  });
  try {
    const snapshot = readProfiles();
    assert.equal(snapshot.profiles[0]!.protocol, "openai-responses");
    // An unrecognized preference is a missing one, not a reason to lose the
    // profile: the run falls back to a protocol the profile supports.
    assert.equal(snapshot.profiles[1]!.id, "future");
    assert.equal(snapshot.profiles[1]!.protocol, undefined);
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
});

test("System One is a device-local declaration, never part of the capability snapshot", () => {
  const base = profile({ tools: true });
  assert.equal(servesSystemOne(base), false);

  const declared = withSystemOne(base, true);
  assert.equal(servesSystemOne(declared), true);
  assert.equal(servesSystemOne(base), false, "the given profile is not mutated");
  // The portable snapshot a project or trace records is unchanged by it.
  assert.deepEqual(declared.capabilityOverrides, { tools: true });
  assert.equal(
    "systemOne" in resolveProviderCapabilities(declared.provider, declared.capabilityOverrides),
    false,
  );
  // While the server's protocol list is set, it owns this declaration too;
  // see the System One server-list test above.

  const withdrawn = withSystemOne(declared, false);
  assert.equal(servesSystemOne(withdrawn), false);
  assert.equal("systemOne" in withdrawn, false, "an undeclared profile stores nothing");
});

test("a System One declaration survives a reload, and a malformed one is dropped", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const stored = (id: string, extra: Record<string, unknown>) => ({
    id,
    name: id,
    provider: "openai-compatible",
    endpoint: "http://localhost:11434/v1",
    model: "nimble",
    ...extra,
  });
  let storage = JSON.stringify({
    profiles: [
      stored("legacy", {}),
      stored("declared", { systemOne: true }),
      stored("false", { systemOne: false }),
      stored("malformed", { systemOne: "yes" }),
    ],
    activeProfileId: "legacy",
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: () => storage,
        setItem: (_key: string, value: string) => {
          storage = value;
        },
      },
    },
  });

  try {
    const snapshot = readProfiles();
    // A malformed declaration costs the declaration, not the profile.
    assert.deepEqual(snapshot.profiles.map(({ id }) => id), ["legacy", "declared", "false", "malformed"]);
    assert.deepEqual(snapshot.profiles.map(servesSystemOne), [false, true, false, false]);
    assert.equal(snapshot.profiles.some((p) => "systemOne" in p && p.systemOne !== true), false);

    writeProfiles({
      ...snapshot,
      profiles: [withSystemOne(snapshot.profiles[0]!, true), ...snapshot.profiles.slice(1)],
    });
    assert.deepEqual(readProfiles().profiles.map(servesSystemOne), [true, true, false, false]);
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
});

function connection(id: string, overrides: Partial<ServerConnection> = {}): ServerConnection {
  return {
    id,
    name: id === "default" ? "Server default" : `Connection ${id}`,
    endpoint: `https://${id}.example.test/v1`,
    credentialConfigured: true,
    ...overrides,
  };
}

function managed(id: string, connectionId: string): StoredInferenceProfile {
  return {
    ...named(id),
    endpoint: `https://${connectionId}.example.test/v1`,
    credentialRef: connectionId === "default" ? "environment-default" : `environment-default:${connectionId}`,
  };
}

test("the runtime status is read as a list, and a malformed entry is dropped alone", () => {
  const status = parseRuntimeStatus({
    containerized: true,
    connections: [
      { id: "default", name: "Server default", endpoint: "https://a.test/v1", credentialConfigured: true },
      { id: "Bad Id", name: "x", endpoint: "https://b.test/v1", credentialConfigured: true },
      { id: "decide", name: "Decide", endpoint: "https://c.test/v1", protocols: [], systemOne: true, credentialConfigured: false, problem: "Its key file could not be read." },
      { id: "chat", endpoint: "https://d.test/v1", protocols: ["bogus"], credentialConfigured: true },
    ],
    catalogProblem: "Its JSON is invalid.",
  });
  assert.equal(status.containerized, true);
  assert.equal(status.catalogProblem, "Its JSON is invalid.");
  assert.deepEqual(status.connections.map(({ id }) => id), ["default", "decide", "chat"]);
  assert.deepEqual(status.connections[1], {
    id: "decide",
    name: "Decide",
    endpoint: "https://c.test/v1",
    protocols: [],
    systemOne: true,
    credentialConfigured: false,
    problem: "Its key file could not be read.",
  });
  // A name falls back to the id, and an unrecognized protocol list is no list.
  assert.equal(status.connections[2]!.name, "chat");
  assert.equal(status.connections[2]!.protocols, undefined);
  // The flat shape slice 1 sent beside the list describes nothing on its own.
  assert.deepEqual(
    parseRuntimeStatus({ serverDefaultCredentialConfigured: true, endpoint: "https://a.test/v1" }).connections,
    [],
  );
});

test("a first run adopts every server connection and activates the first", () => {
  const result = reconcileServerProfiles({
    profiles: [createDefaultProfile()],
    connections: [connection("default"), connection("decide", { model: "local-decision", protocols: [], systemOne: true })],
    firstRun: true,
  });
  assert.ok(result);
  assert.deepEqual(result.profiles.map(({ id }) => id), ["server-default", "server-decide"]);
  assert.equal(result.activeProfileId, "server-default");
  assert.deepEqual(result.added, []);
  const decide = result.profiles[1]!;
  assert.equal(decide.name, "Connection decide");
  assert.equal(decide.credentialRef, "environment-default:decide");
  assert.equal(decide.model, "local-decision");
  assert.equal(servesSystemOne(decide), true);
  assert.deepEqual(decide.capabilityOverrides, { chatCompletions: false });
});

test("a first run with only catalog connections activates the first in catalog order", () => {
  const result = reconcileServerProfiles({
    profiles: [createDefaultProfile()],
    connections: [connection("chat"), connection("decide")],
    firstRun: true,
  });
  assert.equal(result?.activeProfileId, "server-chat");
});

test("an existing device gains new server profiles beside its own, without switching", () => {
  const own = named("mine");
  const result = reconcileServerProfiles({
    profiles: [own, managed("server-default", "default")],
    connections: [connection("default"), connection("decide"), connection("chat")],
    firstRun: false,
  });
  assert.ok(result);
  assert.deepEqual(result.profiles.map(({ id }) => id), ["mine", "server-default", "server-decide", "server-chat"]);
  assert.equal(result.activeProfileId, undefined);
  assert.deepEqual(result.added, ["server-decide", "server-chat"]);
});

test("a new server profile never takes an id a user profile already holds", () => {
  const result = reconcileServerProfiles({
    profiles: [named("server-decide")],
    connections: [connection("decide")],
    firstRun: false,
  });
  const added = result?.profiles[1];
  assert.match(added?.id ?? "", /^server-decide-./);
  assert.deepEqual(result?.added, [added?.id]);
});

test("each server profile's endpoint and declared protocols are relocked, the model filled only while empty", () => {
  const drifted: StoredInferenceProfile = {
    ...managed("server-decide", "decide"),
    name: "Renamed by me",
    endpoint: "https://elsewhere.test/v1",
    model: "my-choice",
  };
  const result = reconcileServerProfiles({
    profiles: [drifted],
    connections: [connection("decide", { name: "Decision models", model: "local-decision", protocols: ["anthropic-messages"] })],
    firstRun: false,
  });
  const next = result?.profiles[0];
  assert.equal(next?.endpoint, "https://decide.example.test/v1");
  assert.equal(next?.model, "my-choice");
  // The name is the user's once the profile exists.
  assert.equal(next?.name, "Renamed by me");
  assert.deepEqual(next?.capabilityOverrides, { chatCompletions: false, anthropicMessages: true });
  assert.deepEqual(result?.added, []);
});

test("nothing changes when the server reports what is already stored", () => {
  assert.equal(
    reconcileServerProfiles({
      profiles: [named("mine"), managed("server-decide", "decide")],
      connections: [connection("decide")],
      firstRun: false,
    }),
    undefined,
  );
});

test("a connection that is no longer reported releases its profile and keeps it", () => {
  const stale = { ...managed("server-chat", "chat"), model: "kept" };
  const result = reconcileServerProfiles({
    profiles: [managed("server-default", "default"), stale],
    connections: [connection("default")],
    firstRun: false,
  });
  assert.deepEqual(result?.profiles[1], { ...stale, credentialRef: undefined });
  assert.equal(result?.profiles[0]?.credentialRef, "environment-default");
});

test("a refused catalog is not evidence its connections were removed", () => {
  // The legacy connection is still reported, so `default` is reconciled
  // normally; the catalog's profiles wait for an answer about them.
  const catalogProfile = managed("server-decide", "decide");
  assert.equal(
    reconcileServerProfiles({
      profiles: [managed("server-default", "default"), catalogProfile],
      connections: [connection("default")],
      catalogProblem: "Its JSON is invalid.",
      firstRun: false,
    }),
    undefined,
  );
  // `default` is never the catalog's, so its absence still releases it.
  const result = reconcileServerProfiles({
    profiles: [managed("server-default", "default"), catalogProfile],
    connections: [],
    catalogProblem: "Its JSON is invalid.",
    firstRun: false,
  });
  assert.equal(result?.profiles[0]?.credentialRef, undefined);
  assert.equal(result?.profiles[1]?.credentialRef, "environment-default:decide");
});

test("a server mode whose key is gone drops to no authentication", () => {
  const modes = new Map<string, WebCredentialMode>([
    ["a", { server: "default" }],
    ["b", { server: "decide" }],
    ["c", { server: "chat" }],
    ["d", "session"],
  ]);
  const changed = reconcileWebCredentialModes(modes, {
    connections: [connection("default"), connection("decide", { credentialConfigured: false })],
  });
  assert.deepEqual(changed, ["b", "c"]);
  assert.deepEqual(Object.fromEntries(modes), {
    a: { server: "default" },
    b: "none",
    c: "none",
    d: "session",
  });
  // While the catalog is refused, its modes are left for the next answer.
  const held = new Map<string, WebCredentialMode>([["b", { server: "decide" }]]);
  assert.deepEqual(reconcileWebCredentialModes(held, { connections: [], catalogProblem: "x" }), []);
  assert.deepEqual(held.get("b"), { server: "decide" });
});

test("a server profile authenticates with its own connection's key by default", () => {
  const status = { connections: [connection("default"), connection("decide"), connection("chat", { credentialConfigured: false })] };
  assert.deepEqual(defaultWebCredentialMode(managed("server-decide", "decide"), status), { server: "decide" });
  assert.deepEqual(defaultWebCredentialMode(managed("server-default", "default"), status), { server: "default" });
  assert.equal(defaultWebCredentialMode(managed("server-chat", "chat"), status), "none");
  assert.equal(defaultWebCredentialMode(named("mine"), status), "none");
});
