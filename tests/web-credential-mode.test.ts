import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveWebCredentialSelection,
  serverConnectionIdOfCredentialRef,
  serverCredentialRef,
  webCredentialIsAvailable,
  webCredentialModeFromStorage,
  webCredentialModeToStorage,
} from "../app/web-credential-mode.ts";

test("no authentication never sends a retained session key", () => {
  assert.deepEqual(
    resolveWebCredentialSelection("none", "retained-secret"),
    { kind: "none" },
  );
  assert.equal(webCredentialIsAvailable("none", "retained-secret"), false);
});

test("a session key is sent only while session authentication is selected", () => {
  assert.deepEqual(
    resolveWebCredentialSelection("session", " session-secret "),
    { kind: "provided", apiKey: " session-secret " },
  );
  assert.equal(webCredentialIsAvailable("session", " session-secret "), true);
  assert.deepEqual(resolveWebCredentialSelection("session", "   "), {
    kind: "none",
  });
  assert.equal(webCredentialIsAvailable("session", "   "), false);
});

test("the server-default selection remains opaque to the browser", () => {
  assert.deepEqual(
    resolveWebCredentialSelection({ server: "default" }, "retained-secret"),
    { kind: "environment-default" },
  );
  assert.equal(
    webCredentialIsAvailable({ server: "default" }, "retained-secret"),
    true,
  );
});

test("a catalog connection's key is selected by its id", () => {
  assert.deepEqual(
    resolveWebCredentialSelection({ server: "decide" }, "retained-secret"),
    { kind: "environment-default", connectionId: "decide" },
  );
  assert.equal(webCredentialIsAvailable({ server: "decide" }, ""), true);
  // `default` stays the request shape every older client sends.
  assert.deepEqual(
    resolveWebCredentialSelection({ server: "default" }, ""),
    { kind: "environment-default" },
  );
});

test("stored modes keep the string form, so existing preferences need no migration", () => {
  assert.equal(webCredentialModeToStorage({ server: "default" }), "environment-default");
  assert.equal(webCredentialModeToStorage({ server: "decide" }), "environment-default:decide");
  assert.equal(webCredentialModeToStorage("session"), "session");
  assert.deepEqual(webCredentialModeFromStorage("environment-default"), { server: "default" });
  assert.deepEqual(webCredentialModeFromStorage("environment-default:decide"), { server: "decide" });
  assert.equal(webCredentialModeFromStorage("none"), "none");
  // An id the catalog could never declare is no preference at all.
  assert.equal(webCredentialModeFromStorage("environment-default:Not Valid"), undefined);
  assert.equal(webCredentialModeFromStorage("environment-default:default"), undefined);
  assert.equal(webCredentialModeFromStorage(7), undefined);
});

test("a credentialRef names its server connection in the same form", () => {
  assert.equal(serverConnectionIdOfCredentialRef("environment-default"), "default");
  assert.equal(serverConnectionIdOfCredentialRef("environment-default:decide"), "decide");
  assert.equal(serverConnectionIdOfCredentialRef(undefined), undefined);
  assert.equal(serverConnectionIdOfCredentialRef("keychain"), undefined);
  assert.equal(serverCredentialRef("default"), "environment-default");
  assert.equal(serverCredentialRef("decide"), "environment-default:decide");
});
