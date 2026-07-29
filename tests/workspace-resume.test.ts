import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPickerError,
  classifyWorkspaceReadError,
  isStoredWorkspaceRecord,
  pickerNotAllowedMessage,
  resolveStoredWorkspaceAccess,
  resolveStoredWorkspaceLoad,
} from "../app/workspace-resume.client.ts";
import type { StoredWorkspaceRecord } from "../app/workspace-resume.client.ts";

function record(displayName = "Prompt Lab.inference-lens"): StoredWorkspaceRecord {
  return {
    version: 1,
    recordId: "record-a",
    kind: "browser-directory",
    displayName,
    projectName: "Prompt Lab",
    savedAt: 1,
    handle: {
      kind: "directory",
      name: displayName,
      async *values() {},
      async getFileHandle() {
        throw new Error("not used");
      },
      async getDirectoryHandle() {
        throw new Error("not used");
      },
      async removeEntry() {},
    },
  };
}

test("picker errors distinguish dismissal from denied access", () => {
  assert.equal(
    classifyPickerError(new DOMException("dismissed", "AbortError")),
    "cancelled",
  );
  assert.equal(
    classifyPickerError(new DOMException("blocked", "NotAllowedError")),
    "not-allowed",
  );
  assert.equal(
    classifyPickerError(new DOMException("insecure", "SecurityError")),
    "other",
  );
  assert.equal(classifyPickerError(new Error("failed")), "other");
  assert.equal(classifyPickerError(undefined), "other");
  assert.match(pickerNotAllowedMessage(), /permission/i);
});

test("workspace read errors preserve recovery-relevant distinctions", () => {
  assert.equal(
    classifyWorkspaceReadError(new DOMException("gone", "NotFoundError")),
    "not-found",
  );
  assert.equal(
    classifyWorkspaceReadError(
      new DOMException("revoked", "NotAllowedError"),
    ),
    "not-allowed",
  );
  assert.equal(
    classifyWorkspaceReadError(new DOMException("blocked", "SecurityError")),
    "not-allowed",
  );
  assert.equal(
    classifyWorkspaceReadError(new SyntaxError("bad project")),
    "unreadable",
  );
  assert.equal(
    classifyWorkspaceReadError(new Error("disk failed")),
    "unreadable",
  );
});

test("stored workspace access resolves silent and interactive permission policy", () => {
  const stored = record();
  assert.deepEqual(
    resolveStoredWorkspaceAccess({
      record: null,
      permission: "granted",
      mode: "silent",
    }),
    { kind: "none" },
  );
  assert.deepEqual(
    resolveStoredWorkspaceAccess({
      record: stored,
      permission: "granted",
      mode: "silent",
    }),
    { kind: "read" },
  );
  const silentPrompt = resolveStoredWorkspaceAccess({
    record: stored,
    permission: "prompt",
    mode: "silent",
  });
  assert.equal(silentPrompt.kind, "offer-reconnect");
  assert.match(
    silentPrompt.kind === "offer-reconnect" ? silentPrompt.message : "",
    /Prompt Lab\.inference-lens/,
  );
  assert.deepEqual(
    resolveStoredWorkspaceAccess({
      record: stored,
      permission: "prompt",
      mode: "interactive",
    }),
    { kind: "request-permission" },
  );
  const denied = resolveStoredWorkspaceAccess({
    record: stored,
    permission: "denied",
    mode: "interactive",
  });
  assert.equal(denied.kind, "forget");
  assert.equal(denied.kind === "forget" ? denied.reason : "", "permission-denied");
});

test("stored workspace load resolves read failures without losing useful copy", () => {
  const contents = "{\n  \"version\": 5\n}\n";
  assert.deepEqual(
    resolveStoredWorkspaceLoad({
      displayName: "Prompt Lab.inference-lens",
      mode: "silent",
      read: { kind: "ok", contents },
    }),
    { kind: "open", contents },
  );

  const missing = resolveStoredWorkspaceLoad({
    displayName: "Prompt Lab.inference-lens",
    mode: "silent",
    read: { kind: "failed", failure: "not-found" },
  });
  assert.equal(missing.kind, "forget");
  assert.equal(
    missing.kind === "forget" ? missing.reason : "",
    "project-missing",
  );
  assert.match(missing.message, /Prompt Lab\.inference-lens/);
  assert.match(missing.message, /project\.json/);

  assert.equal(
    resolveStoredWorkspaceLoad({
      displayName: "Prompt Lab.inference-lens",
      mode: "silent",
      read: { kind: "failed", failure: "not-allowed" },
    }).kind,
    "offer-reconnect",
  );
  const denied = resolveStoredWorkspaceLoad({
    displayName: "Prompt Lab.inference-lens",
    mode: "interactive",
    read: { kind: "failed", failure: "not-allowed" },
  });
  assert.equal(denied.kind, "forget");
  assert.equal(denied.kind === "forget" ? denied.reason : "", "permission-denied");

  const parserMessage = "Project version must be 5.";
  assert.deepEqual(
    resolveStoredWorkspaceLoad({
      displayName: "Prompt Lab.inference-lens",
      mode: "interactive",
      read: {
        kind: "failed",
        failure: "unreadable",
        message: parserMessage,
      },
    }),
    { kind: "offer-reconnect", message: parserMessage },
  );
});

test("stored workspace records require a usable directory capability", () => {
  const valid = record();
  assert.equal(isStoredWorkspaceRecord(valid), true);
  const invalid: unknown[] = [
    null,
    "record",
    { ...valid, version: 2 },
    { ...valid, recordId: "" },
    { ...valid, displayName: "" },
    { ...valid, handle: undefined },
    { ...valid, handle: { ...valid.handle, kind: "file" } },
    { ...valid, handle: { ...valid.handle, getFileHandle: "no" } },
    { ...valid, handle: { ...valid.handle, getDirectoryHandle: null } },
  ];
  for (const value of invalid) {
    assert.equal(isStoredWorkspaceRecord(value), false);
  }
});
