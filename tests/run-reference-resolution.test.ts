import assert from "node:assert/strict";
import test from "node:test";
import { RunCoordinator, createRunTrace } from "../packages/core/src/run-kernel/index.ts";
import { createResolvedRunInput } from "../packages/core/src/run-kernel/run-execution.ts";
import { serializeRunTrace } from "../packages/core/src/run-trace.ts";
import { resolveRunReference } from "../packages/core/src/run-reference-resolution.ts";

function trace(suffix: string) {
  const input = createResolvedRunInput({ provider: "openai-compatible", endpoint: "https://example.com/v1", model: "fixture", messages: [{ role: "user", content: suffix }] }, { conversationId: "conversation_fixture", conversationRevisionId: "revision_fixture" }, [], [], suffix, "2026-10-28T10:00:00.000Z");
  const coordinator = new RunCoordinator(input); const { execution } = coordinator.start();
  coordinator.accept({ type: "completed", finishReason: { normalized: "stop" }, source: { exchangeId: execution.exchangeId, frameIndex: 0 } });
  coordinator.finishTurnStream(); return createRunTrace(coordinator.state);
}
const wanted = trace("wanted"), other = trace("other");
const reference = { version: 1 as const, projectId: "project_fixture" as const, runId: wanted.runId };
const canonical = `${wanted.runId}.json`;
function storage(files: Record<string, string>, listed?: Array<{ fileName: string; contents: string; readError?: string }>) {
  return {
    async readTrace(name: string) { if (name in files) return files[name]!; throw new DOMException("Not found", "NotFoundError"); },
    async listTraces() { return listed ?? Object.entries(files).map(([fileName, contents]) => ({ fileName, contents })); },
  };
}
test("valid canonical evidence wins without a full listing", async () => {
  const s = storage({ [canonical]: serializeRunTrace(wanted) });
  s.listTraces = async () => { throw new Error("must not enumerate"); };
  assert.equal((await resolveRunReference(reference, s)).saved.trace.runId, wanted.runId);
});
test("canonical corruption and mismatched IDs never fall through to renamed evidence", async () => {
  for (const contents of ["{broken", serializeRunTrace(other)]) await assert.rejects(resolveRunReference(reference, storage({ [canonical]: contents, "renamed.json": serializeRunTrace(wanted) })), /Invalid canonical trace/);
});
test("renamed lookup ignores unrelated invalid files, and re-reads the selected artifact", async () => {
  const s = storage({ "renamed.json": serializeRunTrace(wanted) }, [{ fileName: "renamed.json", contents: serializeRunTrace(wanted) }, { fileName: "broken.json", contents: "", readError: "permission" }]);
  assert.equal((await resolveRunReference(reference, s)).fileName, "renamed.json");
  s.readTrace = async () => serializeRunTrace(other);
  await assert.rejects(resolveRunReference(reference, { ...s, readTrace: async name => name === canonical ? Promise.reject(new DOMException("Missing", "NotFoundError")) : serializeRunTrace(other) }), /different run ID/);
});
test("duplicates are ambiguous and missing evidence discloses unreadable artifacts", async () => {
  await assert.rejects(resolveRunReference(reference, storage({ "first.json": serializeRunTrace(wanted), "second.json": serializeRunTrace(wanted) })), /Multiple renamed traces/);
  await assert.rejects(resolveRunReference(reference, storage({ "broken.json": "broken" })), /1 trace files could not be validated/);
});
test("permission failures remain read errors rather than missing evidence", async () => {
  const s = storage({}); s.readTrace = async () => { throw new DOMException("Denied", "NotAllowedError"); };
  await assert.rejects(resolveRunReference(reference, s), /Cannot read.*Denied/);
});

test("legacy evidence resolves through the existing trace migration without rewriting it", async () => {
  const legacy = JSON.parse(serializeRunTrace(wanted)) as Record<string, unknown>;
  legacy.schemaVersion = 1;
  function removeLaterFields(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const key of ["toolExecutions", "templateResolutions", "responseMode"]) delete (value as Record<string, unknown>)[key];
    for (const child of Object.values(value)) removeLaterFields(child);
  }
  removeLaterFields(legacy);
  const contents = JSON.stringify(legacy);
  const evidence = await resolveRunReference(reference, storage({ [canonical]: contents }));
  assert.equal(evidence.saved.trace.runId, wanted.runId);
  assert.equal(evidence.saved.trace.schemaVersion, 8);
});
