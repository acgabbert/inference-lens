import assert from "node:assert/strict";
import test from "node:test";

import {
  clearPromptReturn,
  followPromptSelection,
  openPromptSource,
} from "../app/templates/prompt-navigation.ts";
import type { PromptNavigationTarget } from "../app/templates/prompt-navigation.ts";
import type {
  PromptTemplateId,
  PromptTemplateRevisionId,
  PromptTemplateUseId,
} from "../packages/core/src/run-kernel/types.ts";

const useId = "template-use_a" as PromptTemplateUseId;
const templateId = "template_a" as PromptTemplateId;
const otherTemplateId = "template_b" as PromptTemplateId;
const revisionId = "template-revision_a1" as PromptTemplateRevisionId;
const otherRevisionId = "template-revision_b1" as PromptTemplateRevisionId;

test("opening a source bumps the key and records where to return", () => {
  assert.deepEqual(openPromptSource(undefined, useId, templateId, revisionId), {
    key: 1,
    templateId,
    revisionId,
    returnTarget: { kind: "template-use", useId },
  });
  const current: PromptNavigationTarget = { key: 4, templateId: otherTemplateId };
  assert.equal(openPromptSource(current, useId, templateId, revisionId).key, 5);
});

test("following the author's selection keeps the key and the return target", () => {
  const opened = openPromptSource(undefined, useId, templateId, revisionId);
  assert.deepEqual(followPromptSelection(opened, otherTemplateId, otherRevisionId), {
    key: 1,
    templateId: otherTemplateId,
    revisionId: otherRevisionId,
    returnTarget: { kind: "template-use", useId },
  });
  assert.deepEqual(followPromptSelection(undefined, otherTemplateId, undefined), {
    key: 0,
    templateId: otherTemplateId,
  });
});

test("clearing the return keeps the selected prompt", () => {
  assert.equal(clearPromptReturn(undefined), undefined);
  const cleared = clearPromptReturn(openPromptSource(undefined, useId, templateId, revisionId));
  assert.equal(cleared?.returnTarget, undefined);
  assert.equal(cleared?.templateId, templateId);
  assert.equal(cleared?.revisionId, revisionId);
  assert.equal(cleared?.key, 1);
});
