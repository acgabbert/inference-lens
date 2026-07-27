import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveWebCredentialSelection,
  webCredentialIsAvailable,
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
    resolveWebCredentialSelection("environment-default", "retained-secret"),
    { kind: "environment-default" },
  );
  assert.equal(
    webCredentialIsAvailable("environment-default", "retained-secret"),
    true,
  );
});
