import assert from "node:assert/strict";
import test from "node:test";

import { createEvaluationExperimentPlan } from "../packages/core/src/evaluation-execution.ts";
import {
  EXPERIMENT_SCHEMA_VERSION,
  materializeExperimentCellInput,
  parseExperimentPlanFile,
  parseExperimentPlanJson,
  serializeExperimentPlan,
  type EvaluationExperimentPlan,
} from "../packages/core/src/experiment.ts";
import { createFilePromptCandidate } from "../packages/core/src/file-prompt-import.ts";
import { applyFilePromptUpdate } from "../packages/core/src/file-prompt-update.ts";
import {
  appendPromptTemplateRevision,
  insertPromptTemplateUse,
  parseProjectFile,
  type ChatEvaluationSuite,
  type ProjectFile,
} from "../packages/core/src/project.ts";
import {
  buildPromptFileSnapshots,
  linkedPromptFiles,
  promptFileDriftEntries,
  suitePromptFiles,
} from "../packages/core/src/prompt-file-override.ts";
import { RunCoordinator } from "../packages/core/src/run-kernel/coordinator.ts";
import { createRunTrace } from "../packages/core/src/run-kernel/reducer.ts";
import type { PromptTemplateId, ResolvedRunInput, RunTrace } from "../packages/core/src/run-kernel/types.ts";
import {
  parseRunTraceFile,
  RUN_TRACE_SCHEMA_VERSION,
  serializeRunTrace,
} from "../packages/core/src/run-trace.ts";
import { LINKED_PATH, LINKED_ROOT, LINKED_TEXT, linkedPromptProject } from "./fixtures/headless/linked-prompt.ts";

const ENDPOINT = "https://example.test/v1";
const RUNTIME_TARGET = {
  profileId: "profile_ci",
  protocol: "openai-compatible-chat-completions",
  endpoint: ENDPOINT,
  capabilities: {
    chatCompletions: true, responsesApi: false, anthropicMessages: false, streaming: false, modelDiscovery: false,
    tools: false, parallelToolCalls: false, structuredOutput: false, vision: false, embeddings: false,
  },
} as const;

function suiteOf(project: ProjectFile): ChatEvaluationSuite {
  return project.evaluationSuites[0] as ChatEvaluationSuite;
}

function plan(project: ProjectFile, promptSources?: Awaited<ReturnType<typeof buildPromptFileSnapshots>>): EvaluationExperimentPlan {
  const suite = suiteOf(project);
  return createEvaluationExperimentPlan({
    project,
    suiteId: suite.id,
    selectedCaseIds: suite.cases.map(({ id }) => id),
    runtimeTargets: { [suite.variants[0]!.id]: RUNTIME_TARGET } as never,
    createdAt: "2026-10-30T12:00:00.000Z",
    ...(promptSources ? { promptSources } : {}),
  });
}

async function snapshots(project: ProjectFile, templateId: PromptTemplateId, text: string) {
  return buildPromptFileSnapshots(project, suiteOf(project), new Map([[templateId, text]]));
}

function pinnedRevisionId(project: ProjectFile): string {
  const revision = project.conversationRevisions.find(({ id }) => id === suiteOf(project).input.conversationRevisionId)!;
  const item = revision.items.find((entry) => entry.kind === "template-use");
  if (item?.kind !== "template-use") throw new Error("Expected a template use");
  return item.use.templateRevisionId;
}

function chatTrace(input: ResolvedRunInput): RunTrace {
  const coordinator = new RunCoordinator(input);
  const { execution } = coordinator.start();
  coordinator.accept({
    type: "request",
    request: { url: `${ENDPOINT}/chat/completions`, method: "POST", headers: {}, body: "{}" },
  });
  coordinator.accept({ type: "response_started", response: { status: 200, headers: {} } });
  coordinator.accept({ type: "frame", frame: { index: 0, raw: "data: {}" } });
  coordinator.accept({ type: "text_delta", text: "Hi", source: { exchangeId: execution.exchangeId, frameIndex: 0 } });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "stop", raw: "stop" },
    source: { exchangeId: execution.exchangeId, frameIndex: 0 },
  });
  coordinator.finishTurnStream();
  return createRunTrace(coordinator.state);
}

function userText(input: { messages: ResolvedRunInput["messages"] }): string[] {
  return input.messages.flatMap((message) =>
    message.role === "user" ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []);
}

test("a plan built from file snapshots sends the file's text under the pinned revision and records where it came from", async () => {
  const { project, templateId } = await linkedPromptProject({ endpoint: ENDPOINT });
  const pinned = pinnedRevisionId(project);
  assert.deepEqual(suitePromptFiles(project, suiteOf(project)).map(({ templateId: id, sourceRootName, path }) =>
    ({ id, sourceRootName, path })), [{ id: templateId, sourceRootName: LINKED_ROOT, path: LINKED_PATH }]);

  const sources = await snapshots(project, templateId, "Describe {{ $json.topic }} in detail.\r\n");
  const built = plan(project, sources);

  assert.equal(EXPERIMENT_SCHEMA_VERSION, 7);
  assert.equal(built.schemaVersion, 7);
  const input = built.suite.cases[0]!.inputs[0]!;
  assert.deepEqual(userText(input), ["Describe addition in detail.\r\n"]);
  const resolution = input.templateResolutions[0]!;
  assert.equal(resolution.templateRevisionId, pinned, "the pinned revision is still named");
  assert.deepEqual(resolution.messages, [{ role: "user", content: "Describe {{topic}} in detail.\r\n" }]);
  assert.deepEqual(resolution.fileSource, {
    sourceRootName: LINKED_ROOT,
    path: LINKED_PATH,
    sourceDigest: sources[0]!.sourceDigest,
    baseTemplateRevisionId: pinned,
  });

  const [snapshot] = built.suite.promptSources!;
  assert.equal(snapshot!.templateId, templateId);
  assert.equal(snapshot!.baseTemplateRevisionId, pinned);
  assert.equal(snapshot!.sourceRootName, LINKED_ROOT);
  assert.equal(snapshot!.path, LINKED_PATH);
  assert.match(snapshot!.sourceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot!.authored, { role: "user", text: "Describe {{ $json.topic }} in detail.\r\n" });
  assert.equal(snapshot!.interpretation, "expression-v1");
  assert.deepEqual(snapshot!.bindings, [{ expression: "{{ $json.topic }}", variableName: "topic" }]);
  assert.deepEqual(snapshot!.messages, resolution.messages);
  assert.deepEqual(snapshot!.variableDefaults, {});
  assert.equal(snapshot!.replacedLocalRevisions, false);

  // The plan reads back whole, and each cell's run input carries the source.
  assert.deepEqual(parseExperimentPlanJson(serializeExperimentPlan(built)), built);
  const runInput = materializeExperimentCellInput(built, built.cells[0]!.cellId);
  assert.deepEqual(runInput.templateResolutions[0]!.fileSource, resolution.fileSource);

  // The project itself is untouched: no revision was written.
  assert.equal(project.promptTemplates.find(({ id }) => id === templateId)!.revisions.length, 1);
  assert.deepEqual(userText(plan(project).suite.cases[0]!.inputs[0]!), ["Tell me about addition."]);
});

test("a trace from an overridden cell is RunTrace v10 and explains itself without the file", async () => {
  const { project, templateId } = await linkedPromptProject({ endpoint: ENDPOINT });
  const built = plan(project, await snapshots(project, templateId, "Describe {{ $json.topic }}."));
  const runInput = materializeExperimentCellInput(built, built.cells[0]!.cellId);
  const trace = chatTrace({ ...runInput, target: { ...runInput.target } });

  assert.equal(RUN_TRACE_SCHEMA_VERSION, 10);
  const written = JSON.parse(serializeRunTrace(trace));
  assert.equal(written.schemaVersion, 10);
  const reread = parseRunTraceFile(written);
  assert.deepEqual(reread.input.templateResolutions[0]!.fileSource, runInput.templateResolutions[0]!.fileSource);
  assert.deepEqual(userText(reread.input), ["Describe addition."]);

  // A v9 document carrying a file source is rejected rather than misread.
  assert.throws(() => parseRunTraceFile({ ...written, schemaVersion: 9 }), /fileSource|Unrecognized key/);
  // The source must name the revision the use names.
  const mismatched = structuredClone(written);
  for (const input of [mismatched.input, mismatched.events[0].input]) {
    input.templateResolutions[0].fileSource.baseTemplateRevisionId = "template-revision_other";
  }
  assert.throws(() => parseRunTraceFile(mismatched), /file source/);
  // A trace with no file source opens and is rewritten as the current version.
  const ordinary = plan(project);
  const plain = chatTrace(materializeExperimentCellInput(ordinary, ordinary.cells[0]!.cellId));
  const plainWritten = JSON.parse(serializeRunTrace(plain));
  assert.equal(plainWritten.schemaVersion, 10);
  assert.deepEqual(parseRunTraceFile({ ...plainWritten, schemaVersion: 9 }).input, plain.input);
});

test("ExperimentPlan v6 opens as v7 with no file source, and a v6 or inconsistent v7 document carrying one is rejected", async () => {
  const { project, templateId } = await linkedPromptProject({ endpoint: ENDPOINT });
  const ordinary = plan(project);
  const v6 = { ...JSON.parse(serializeExperimentPlan(ordinary)), schemaVersion: 6 };
  assert.deepEqual(parseExperimentPlanFile(v6), ordinary);

  const overridden = JSON.parse(serializeExperimentPlan(plan(project, await snapshots(project, templateId, "Describe {{ $json.topic }}."))));
  assert.throws(() => parseExperimentPlanFile({ ...overridden, schemaVersion: 6 }), /promptSources|fileSource|Unrecognized key/);
  const v6WithUseSource = structuredClone(overridden);
  v6WithUseSource.schemaVersion = 6;
  delete v6WithUseSource.suite.promptSources;
  assert.throws(() => parseExperimentPlanFile(v6WithUseSource), /Unrecognized key: "fileSource"/);
  const v6WithSnapshot = structuredClone(overridden);
  v6WithSnapshot.schemaVersion = 6;
  delete v6WithSnapshot.suite.cases[0].inputs[0].templateResolutions[0].fileSource;
  assert.throws(() => parseExperimentPlanFile(v6WithSnapshot), /Unrecognized key: "promptSources"/);

  const unsourced = structuredClone(overridden);
  delete unsourced.suite.cases[0].inputs[0].templateResolutions[0].fileSource;
  assert.throws(() => parseExperimentPlanFile(unsourced), /file source/);
  const otherText = structuredClone(overridden);
  otherText.suite.promptSources[0].messages[0].content = "Something else {{topic}}";
  assert.throws(() => parseExperimentPlanFile(otherText), /file source/);
  const otherDigest = structuredClone(overridden);
  otherDigest.suite.cases[0].inputs[0].templateResolutions[0].fileSource.sourceDigest = "0".repeat(64);
  assert.throws(() => parseExperimentPlanFile(otherDigest), /file source/);
});

test("names are reused as a pull would reuse them, and a new expression needs a value", async () => {
  const { project, templateId } = await linkedPromptProject({ endpoint: ENDPOINT });
  const [snapshot] = await snapshots(project, templateId, "In a {{ $json.tone }} voice, explain {{ $json.topic }}.");
  assert.deepEqual(snapshot!.bindings, [
    { expression: "{{ $json.tone }}", variableName: "tone" },
    { expression: "{{ $json.topic }}", variableName: "topic" },
  ]);
  assert.throws(() => plan(project, [snapshot!]), /tone/);
});

test("a pull the update dialog would block is refused, naming the prompt", async () => {
  const { project: linked, templateId } = await linkedPromptProject({ endpoint: ENDPOINT });
  const candidate = async (text: string) =>
    createFilePromptCandidate({ filename: "agent.md", path: LINKED_PATH, text, role: "user", plainText: false });
  // The file drops {{topic}}, then a local revision uses the name for something else.
  let project = (await applyFilePromptUpdate(linked, templateId, await candidate("No topic here."))).project;
  project = appendPromptTemplateRevision(project, {
    templateId,
    messages: [{ role: "user", content: "Local {{topic}}" }],
    variableDefaults: {},
  });
  await assert.rejects(
    snapshots(project, templateId, LINKED_TEXT),
    (error: Error) => /“agent”/.test(error.message) && /\{\{topic\}\}/.test(error.message),
  );
  await assert.rejects(
    snapshots(project, templateId, "Unclosed {{ $json.topic"),
    (error: Error) => /“agent”/.test(error.message),
  );
});

test("a pinned revision that is not the last pull is replaced and reported, and two pinned revisions are refused", async () => {
  const { project: linked, templateId } = await linkedPromptProject({ endpoint: ENDPOINT });
  // A local revision after the pull, and the suite's use pinned to it.
  const edited = appendPromptTemplateRevision(linked, {
    templateId,
    messages: [{ role: "user", content: "Locally, {{topic}}." }],
    variableDefaults: {},
  });
  const localRevisionId = edited.promptTemplates.find(({ id }) => id === templateId)!.currentRevisionId;
  const repinned = parseProjectFile({
    ...edited,
    conversationRevisions: edited.conversationRevisions.map((revision) => ({
      ...revision,
      items: revision.items.map((item) => item.kind === "template-use" && item.use.templateId === templateId
        ? { ...item, use: { ...item.use, templateRevisionId: localRevisionId } }
        : item),
    })),
  });
  const [snapshot] = await snapshots(repinned, templateId, LINKED_TEXT);
  assert.equal(snapshot!.baseTemplateRevisionId, localRevisionId);
  assert.equal(snapshot!.replacedLocalRevisions, true);
  assert.deepEqual(userText(plan(repinned, [snapshot!]).suite.cases[0]!.inputs[0]!), ["Tell me about addition."]);

  // A second use pinned to the local revision beside the first, pinned to the pull.
  const twoPins = insertPromptTemplateUse(edited, {
    conversationRevisionId: suiteOf(edited).input.conversationRevisionId,
    templateId,
    itemIndex: 2,
    idSuffix: "agent-use-2",
    outputMessageIdSuffixes: ["agent-output-2"],
  });
  await assert.rejects(snapshots(twoPins, templateId, LINKED_TEXT), /more than one revision/);
});

test("drift reports matches, file-changed, missing and unreadable, with local revisions apart", async () => {
  const { project: linked, templateId } = await linkedPromptProject({ endpoint: ENDPOINT });
  assert.deepEqual(linkedPromptFiles(linked).map(({ templateId: id }) => id), [templateId]);
  const entry = (read: Parameters<typeof promptFileDriftEntries>[1] extends ReadonlyMap<string, infer R> ? R : never, project = linked) =>
    promptFileDriftEntries(project, new Map([[templateId, read]]))[0]!;

  assert.deepEqual(entry({ ok: true, text: LINKED_TEXT }), {
    templateId, templateName: "agent", sourceRootName: LINKED_ROOT, path: LINKED_PATH, state: "matches", localRevisions: false,
  });
  assert.equal(entry({ ok: true, text: "Tell me about {{ $json.topic }}.\r\n" }).state, "file-changed");
  assert.equal(entry({ ok: true, text: "Tell me about {{ $json.topic }}." }).state, "matches");
  assert.deepEqual(entry({ ok: false, reason: "missing", message: "prompts/flows/agent.md does not exist." }), {
    templateId, templateName: "agent", sourceRootName: LINKED_ROOT, path: LINKED_PATH,
    state: "missing", reason: "missing", message: "prompts/flows/agent.md does not exist.", localRevisions: false,
  });
  const unreadable = entry({ ok: false, reason: "not-utf8", message: "prompts/flows/agent.md is not UTF-8 text." });
  assert.equal(unreadable.state, "unreadable");
  assert.equal(unreadable.reason, "not-utf8");

  const edited = appendPromptTemplateRevision(linked, {
    templateId,
    messages: [{ role: "user", content: "Locally, {{topic}}." }],
    variableDefaults: {},
  });
  const local = entry({ ok: true, text: LINKED_TEXT }, edited);
  assert.equal(local.state, "matches");
  assert.equal(local.localRevisions, true);
});
