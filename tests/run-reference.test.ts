import assert from "node:assert/strict";
import test from "node:test";
import { formatRunReference, parseRunReference, validateRunReference, MAX_RUN_LINK_LENGTH } from "../packages/core/src/run-reference.ts";
import { browserRunLink, parseRunLinkUrl } from "../app/run/run-link-url.client.ts";
import { parseRunLinkMessage } from "../app/run/run-link-handoff.client.ts";

const ref = { version: 1 as const, projectId: "project_legacy name/&?%+é" as const, runId: "run_legacy.2026-10_28" as const };
test("portable references and both host spellings preserve non-UUID IDs with one decode", () => {
  assert.deepEqual(parseRunReference(formatRunReference(ref)), { kind: "valid", reference: ref });
  const browser = browserRunLink(ref, "http://localhost:8080/lens/?theme=dark#old");
  assert.equal(new URL(browser).pathname, "/lens/");
  assert.equal(new URL(browser).port, "8080");
  assert.deepEqual(parseRunLinkUrl(browser), { kind: "valid", reference: ref });
  assert.deepEqual(parseRunLinkUrl(`inference-lens://${formatRunReference(ref).replace("run/", "run/")}`), { kind: "valid", reference: ref });
});
test("malformed, duplicate, missing, traversal and unexpected values are rejected", () => {
  for (const payload of ["run/v1?project=project_a", "run/v1?project=project_a&run=run_a&run=run_b", "run/v1?project=project_a&run=run_a&x=1", "run/v1?project=project_a&run=run_%2Fetc", "run/v1?project=project_a&run=run_a..b", "run/v1?project=%C0%AF&run=run_a", "run/v1?project=project_%ZZ&run=run_a", "run/v1?project=project_a&run=run_a#ignored", "run/v1?project=project_a&project=project_b&run=run_a", "run/v1?project=&run=run_a"]) assert.equal(parseRunReference(payload).kind, "invalid", payload);
  assert.equal(parseRunReference("run/v2?project=project_a&run=run_a").kind, "unsupported-version");
  assert.equal(parseRunReference("x".repeat(MAX_RUN_LINK_LENGTH + 1)).kind, "invalid");
  assert.equal(validateRunReference({ ...ref, projectId: "project_" }).kind, "invalid");
});
test("outer URLs cannot add native authority, ports or fragments", () => {
  for (const text of ["inference-lens://user@run/v1?project=project_a&run=run_a", "inference-lens://run:55/v1?project=project_a&run=run_a", "inference-lens://run/v1?project=project_a&run=run_a#extra", "file:///tmp/#/run/v1?project=project_a&run=run_a", "javascript:alert(1)"]) assert.equal(parseRunLinkUrl(text).kind, "invalid", text);
});
test("handoff messages validate references and project identity", () => {
  const message = { type: "open-run", tab: "sender", requestId: "request", projectId: ref.projectId, reference: ref };
  assert.deepEqual(parseRunLinkMessage(message), message);
  assert.equal(parseRunLinkMessage({ ...message, projectId: "project_other" }), undefined);
  assert.equal(parseRunLinkMessage({ ...message, reference: { ...ref, runId: "../../run_a" } }), undefined);
});

test("formatters never emit a link the input bound or URL encoding cannot round-trip", () => {
  const long = { ...ref, projectId: `project_${"a".repeat(MAX_RUN_LINK_LENGTH - 80)}` as const };
  assert.throws(() => browserRunLink(long, `https://example.com/${"x".repeat(200)}/`), /too long/);
  assert.equal(validateRunReference({ ...ref, projectId: "project_\ud800" }).kind, "invalid");
});
