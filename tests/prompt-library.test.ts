import assert from "node:assert/strict";
import test from "node:test";

import {
  describeEmptyPromptLibrary,
  filterPromptLibrary,
  hasDuplicatePromptName,
  selectPromptLibraryEntry,
  type PromptLibraryFilters,
} from "../app/templates/prompt-library.ts";
import type { PromptTemplateId } from "../packages/core/src/run-kernel/types.ts";

const id = (value: string) => `template_${value}` as PromptTemplateId;
const library = [
  { id: id("chat"), kind: "chat" as const, name: "Chat helper" },
  { id: id("decision"), kind: "decision" as const, name: "Ticket decision" },
  { id: id("old"), kind: "decision" as const, name: "Old ticket", archivedAt: "2026-10-25T00:00:00.000Z" },
];
const all: PromptLibraryFilters = { status: "active", kind: "all", search: "" };

test("filters combine status, kind and a case-insensitive name search", () => {
  assert.deepEqual(filterPromptLibrary(library, all).map(({ name }) => name), ["Chat helper", "Ticket decision"]);
  assert.deepEqual(filterPromptLibrary(library, { ...all, kind: "decision" }).map(({ name }) => name), ["Ticket decision"]);
  assert.deepEqual(filterPromptLibrary(library, { ...all, search: "TICKET" }).map(({ name }) => name), ["Ticket decision"]);
  assert.deepEqual(filterPromptLibrary(library, { ...all, status: "archived", kind: "chat" }), []);
});

test("selection follows the chosen entry while visible and otherwise the first visible one", () => {
  const visible = filterPromptLibrary(library, all);
  assert.equal(selectPromptLibraryEntry(visible, id("decision"))?.name, "Ticket decision");
  const chatOnly = filterPromptLibrary(library, { ...all, kind: "chat" });
  assert.equal(selectPromptLibraryEntry(chatOnly, id("decision"))?.name, "Chat helper");
  assert.equal(selectPromptLibraryEntry([], id("decision")), undefined);
});

test("an empty list says whether the status is empty or the filters exclude everything", () => {
  assert.equal(describeEmptyPromptLibrary(library, { ...all, search: "missing" }).heading, "No matching prompts");
  assert.equal(describeEmptyPromptLibrary(library, { ...all, status: "archived", kind: "chat" }).heading, "No matching prompts");
  assert.equal(describeEmptyPromptLibrary([], all).heading, "No active project prompts");
  assert.equal(describeEmptyPromptLibrary(library.slice(0, 2), { ...all, status: "archived" }).heading, "No archived prompts");
});

test("duplicate names compare across kinds, ignore case and the entry itself", () => {
  assert.equal(hasDuplicatePromptName(library, id("chat"), " ticket DECISION "), true);
  assert.equal(hasDuplicatePromptName(library, id("chat"), "Chat helper"), false);
  assert.equal(hasDuplicatePromptName(library, id("chat"), "  "), false);
  assert.equal(hasDuplicatePromptName(library, id("chat"), "old ticket"), true);
});
