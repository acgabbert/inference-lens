import assert from "node:assert/strict";
import test from "node:test";

import {
  branchFromSavedTrace,
  branchFromTranscript,
  nonBranchableMessageIds,
} from "../app/run/pending-branch.ts";
import { prepareWorkbenchRun } from "../app/run/prepare-workbench-run.client.ts";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  projectDraft,
} from "../packages/core/src/project.ts";
import { RunCoordinator } from "../packages/core/src/run-kernel/coordinator.ts";
import { transcriptFromRunState } from "../packages/core/src/run-kernel/transcript.ts";
import type {
  MessageId,
  ResolvedRunInput,
  RunState,
} from "../packages/core/src/run-kernel/types.ts";
import { createRunTrace } from "../packages/core/src/run-kernel/index.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

const request = {
  provider: "openai-compatible" as const,
  endpoint: "https://provider.example.test/v1",
  model: "example-model",
  messages: [{ role: "system" as const, content: "System context" }],
  responseMode: "buffered" as const,
  capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
};

/** A project whose conversation is a system message and a two-message template. */
function messageSetInput(): ResolvedRunInput {
  let project = createProjectFile({ name: "Branching", request, idSuffix: "branching" });
  project = createPromptTemplate(project, {
    name: "Exchange",
    messages: [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
    ],
    idSuffix: "exchange",
    revisionIdSuffix: "exchange-1",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_exchange",
    itemIndex: 1,
    idSuffix: "exchange",
    outputMessageIdSuffixes: ["exchange-user", "exchange-assistant"],
  });
  const prepared = prepareWorkbenchRun({
    request: { ...request, messages: projectDraft(project).messages },
    project,
    projectTools: [],
    requestTools: [],
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    profileName: "Example profile",
    templateRunOverrides: {},
  });
  if (!prepared.ok) throw new Error(prepared.message);
  return prepared.input;
}

function completed(input: ResolvedRunInput): RunState {
  const coordinator = new RunCoordinator(input);
  const { execution } = coordinator.start();
  coordinator.accept({ type: "text_delta", text: "Final answer", source: { exchangeId: execution.exchangeId } });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "stop" },
    source: { exchangeId: execution.exchangeId },
  });
  coordinator.finishTurnStream();
  return coordinator.state;
}

test("a message-set template's output is atomic except for its final message", () => {
  const state = completed(messageSetInput());
  assert.deepEqual(
    [...nonBranchableMessageIds(state)],
    ["message_exchange-user"],
  );
  assert.equal(nonBranchableMessageIds(null).size, 0);
});

test("editing from a live message drafts the transcript through it", () => {
  const state = completed(messageSetInput());
  const transcript = transcriptFromRunState(state);
  const messageId = "message_exchange-assistant" as MessageId;
  const start = branchFromTranscript({
    runState: state,
    transcript,
    traceStorage: { kind: "saved" },
    messageId,
  });
  assert.ok(start);
  assert.deepEqual(
    start.messages.map(({ id }) => id),
    transcript.slice(0, 3).map(({ message }) => message.id),
  );
  assert.deepEqual(start.branch, {
    parentRunId: state.runId,
    parentConversationRevisionId: state.input?.conversationRevisionId,
    branchMessageId: messageId,
    parentTraceNeedsSaving: false,
  });
  // A clone: editing the draft cannot reach the run's transcript.
  start.messages[0]!.content[0]!.text = "edited";
  assert.equal(transcript[0]!.message.content[0]!.text, "System context");
});

test("an unsaved or failed-to-save parent trace is flagged for saving", () => {
  const state = completed(messageSetInput());
  const transcript = transcriptFromRunState(state);
  const messageId = transcript[0]!.message.id;
  for (const kind of ["unsaved", "error"] as const) {
    const start = branchFromTranscript({ runState: state, transcript, traceStorage: { kind }, messageId });
    assert.equal(start?.branch.parentTraceNeedsSaving, true, kind);
  }
  for (const traceStorage of [{ kind: "downloaded" as const }, undefined]) {
    const start = branchFromTranscript({ runState: state, transcript, traceStorage, messageId });
    assert.equal(start?.branch.parentTraceNeedsSaving, false);
  }
});

test("a run still in progress, or an unknown message, cannot be branched", () => {
  const input = messageSetInput();
  const running = new RunCoordinator(input);
  running.start();
  const transcript = transcriptFromRunState(running.state);
  const messageId = transcript[0]!.message.id;
  assert.equal(
    branchFromTranscript({ runState: running.state, transcript, traceStorage: undefined, messageId }),
    undefined,
  );
  assert.equal(
    branchFromTranscript({ runState: null, transcript, traceStorage: undefined, messageId }),
    undefined,
  );
  const state = completed(input);
  assert.equal(
    branchFromTranscript({
      runState: state,
      transcript: transcriptFromRunState(state),
      traceStorage: undefined,
      messageId: "message_missing" as MessageId,
    }),
    undefined,
  );
});

test("a saved trace branches after its last message and never needs saving", () => {
  const state = completed(messageSetInput());
  const trace = createRunTrace(state);
  const start = branchFromSavedTrace(trace);
  assert.ok(start);
  const transcript = transcriptFromRunState(state);
  assert.deepEqual(start.messages, transcript.map(({ message }) => message));
  assert.equal(start.messages.at(-1)?.content[0]?.text, "Final answer");
  assert.deepEqual(start.branch, {
    parentRunId: trace.runId,
    parentConversationRevisionId: trace.input.conversationRevisionId,
    branchMessageId: transcript.at(-1)!.message.id,
    parentTraceNeedsSaving: false,
  });
});
