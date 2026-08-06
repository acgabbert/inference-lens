import { expect, test } from "@playwright/test";

import { serializeProjectFile } from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { createEntityId, createRunState, createRunTrace, reduceRunEvent, type RunEvent } from "../../packages/core/src/run-kernel";
import { serializeRunTrace } from "../../packages/core/src/run-trace";
import { openMode, seedProfile, stubProjectDirectory, waitForHydration } from "./support";

const ids = {
  project: createEntityId("project", "promotion-browser"),
  conversation: createEntityId("conversation", "promotion-browser"),
  revision: createEntityId("revision", "promotion-browser"),
  template: createEntityId("template", "promotion-browser"),
  templateRevision: createEntityId("template-revision", "promotion-browser"),
  use: createEntityId("template-use", "promotion-browser"),
  message: createEntityId("message", "promotion-browser"),
  connection: createEntityId("connection", "promotion-browser"),
  suite: createEntityId("evaluation-suite", "promotion-browser"),
  variant: createEntityId("evaluation-variant", "promotion-browser"),
  input: createEntityId("evaluation-input", "topic"),
  run: createEntityId("run", "promotion-browser"),
};

function fixture(): Record<string, string> {
  const project: ProjectFile = {
    schemaVersion: 10,
    projectId: ids.project,
    name: "Promotion browser fixture",
    defaults: { conversationRevisionId: ids.revision, target: { connectionRequirementId: ids.connection, model: "fixture-model" }, options: {}, enabledToolIds: [] },
    connectionRequirements: [{ id: ids.connection, name: "Fixture", provider: "openai-compatible", protocol: "openai-compatible-chat-completions", endpoint: "http://127.0.0.1:44014/v1" }],
    conversations: [{ id: ids.conversation, name: "Incident conversation" }],
    conversationRevisions: [{ id: ids.revision, conversationId: ids.conversation, createdAt: "2026-08-06T12:00:00.000Z", items: [{ kind: "template-use", use: { id: ids.use, templateId: ids.template, templateRevisionId: ids.templateRevision, values: {}, outputMessageIds: [ids.message] } }] }],
    promptTemplates: [{ id: ids.template, name: "Incident prompt", currentRevisionId: ids.templateRevision, revisions: [{ id: ids.templateRevision, createdAt: "2026-08-06T12:00:00.000Z", messages: [{ role: "user", content: "Investigate {{topic}}" }], variableDefaults: {} }] }],
    externalImports: [], tools: [], toolMocks: [],
    evaluationSuites: [{
      id: ids.suite, name: "Incidents", input: { kind: "conversation-revision", conversationRevisionId: ids.revision },
      execution: { target: { connectionRequirementId: ids.connection, model: "fixture-model" }, responseMode: "buffered", options: {}, repetitions: 1, toolIds: [] },
      variants: [{ id: ids.variant, name: "Default", overrides: {} }],
      inputBindings: [{ id: ids.input, name: "Topic", target: { kind: "template-variable", templateUseId: ids.use, variableName: "topic" } }],
      cases: [],
    }],
  };
  const input = {
    runId: ids.run, conversationId: ids.conversation, conversationRevisionId: ids.revision,
    target: { profileId: createEntityId("profile", "fixture"), protocol: "mock" as const, endpoint: "http://fixture.test", model: "fixture-model", capabilities: { chatCompletions: true, responsesApi: false, streaming: true, modelDiscovery: false, tools: false, parallelToolCalls: false, structuredOutput: false, vision: false, embeddings: false } },
    messages: [{ id: ids.message, role: "user" as const, content: [{ type: "text" as const, text: "Investigate database migration rollback" }] }], responseMode: "buffered" as const, options: {}, tools: [], resolvedAt: "2026-08-06T12:01:00.000Z",
    templateResolutions: [{ templateUseId: ids.use, templateId: ids.template, templateRevisionId: ids.templateRevision, templateName: "Incident prompt", messages: [{ role: "user" as const, content: "Investigate database migration rollback" }], variableDefaults: {}, values: { topic: "database migration rollback" }, outputMessageIds: [ids.message] }],
  };
  const event = <Value extends Omit<RunEvent, "eventId" | "runId" | "sequence" | "occurredAt" | "elapsedMs">>(sequence: number, elapsedMs: number, value: Value): RunEvent => ({ eventId: createEntityId("event", `promotion-browser-${sequence}`), runId: ids.run, sequence, occurredAt: new Date(Date.parse("2026-08-06T12:01:00.000Z") + elapsedMs).toISOString(), elapsedMs, ...value } as RunEvent);
  const turnId = createEntityId("turn", "promotion-browser");
  const exchangeId = createEntityId("exchange", "promotion-browser");
  const trace = createRunTrace([
    event(0, 0, { type: "run.started", input }),
    event(1, 0, { type: "turn.started", turnId, attempt: 1, exchangeId, input: { target: input.target, messages: input.messages, responseMode: input.responseMode, options: input.options, tools: input.tools } }),
    event(2, 2, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request: { url: "http://fixture.test/chat/completions", method: "POST", headers: {} } }),
    event(3, 4, { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, text: "The rollback failed." }),
    event(4, 6, { type: "assistant.completed", turnId, attempt: 1, exchangeId, finishReason: { normalized: "stop" } }),
    event(5, 7, { type: "run.completed" }),
  ].reduce(reduceRunEvent, createRunState(ids.run)));
  return { "project.json": serializeProjectFile(project), [`traces/${ids.run}.json`]: serializeRunTrace(trace) };
}

test("an ordinary source trace promotes exact values and remains openable from its focused case", async ({ page }) => {
  await seedProfile(page);
  await stubProjectDirectory(page, { name: "promotion-browser.inference-lens", files: fixture() });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…" }).click();
  await expect(page.locator(".brand")).toContainText("Promotion browser fixture");
  await page.getByLabel("Run data menu").click();
  await page.getByRole("button", { name: "Run history…" }).click();
  await page.locator(".run-history-item").click();
  await expect(page.getByRole("button", { name: "Promote to case…" })).toBeVisible();
  await page.getByRole("button", { name: "Promote to case…" }).click();
  const dialog = page.getByRole("dialog", { name: "Promote to case" });
  await expect(dialog).toContainText("database migration rollback");
  await dialog.getByLabel("Case name").fill("Rollback incident");
  await dialog.getByRole("button", { name: "Promote case" }).click();

  await openMode(page, "Evaluations");
  const editor = page.getByRole("region", { name: "Evaluation suites" });
  await expect(editor.getByRole("heading", { name: "Rollback incident" })).toBeVisible();
  await expect(editor.getByLabel("Rollback incident topic")).toHaveValue("database migration rollback");
  await expect(editor.getByText("No deterministic checks yet.")).toBeVisible();
  await editor.getByRole("button", { name: "Open source trace" }).click();
  await expect(page.getByRole("button", { name: "Promote to case…" })).toBeVisible();
});
