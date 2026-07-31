import assert from "node:assert/strict";
import test from "node:test";

import {
  listExperimentArtifactsFromDirectory,
  readExperimentArtifactFromDirectory,
} from "../app/experiment-directory.client.ts";
import type {
  FileSystemDirectoryHandleLike,
  FileSystemFileHandleLike,
} from "../app/project-directory.client.ts";

function file(name: string, contents: string): FileSystemFileHandleLike {
  return {
    kind: "file",
    name,
    async getFile() { return { text: async () => contents } as File; },
    async createWritable() { throw new Error("not used"); },
  };
}

function directory(
  name: string,
  entries: Array<FileSystemFileHandleLike | FileSystemDirectoryHandleLike>,
): FileSystemDirectoryHandleLike {
  return {
    kind: "directory",
    name,
    async *values() { yield* entries; },
    async getFileHandle(requested) {
      const entry = entries.find((candidate) => candidate.kind === "file" && candidate.name === requested);
      if (!entry) throw new DOMException("missing", "NotFoundError");
      return entry as FileSystemFileHandleLike;
    },
    async getDirectoryHandle(requested) {
      const entry = entries.find((candidate) => candidate.kind === "directory" && candidate.name === requested);
      if (!entry) throw new DOMException("missing", "NotFoundError");
      return entry as FileSystemDirectoryHandleLike;
    },
    async removeEntry() { throw new Error("not used"); },
  };
}

test("lists only experiment plan/result artifacts in stable order", async () => {
  const experiments = directory("experiments", [
    file("experiment_z.result.json", "z-result"),
    file("experiment_a.plan.json", "a-plan"),
    file("experiment_a.result.json", "a-result"),
    file("experiment_a.json", "ignore"),
    file("../experiment_escape.plan.json", "ignore"),
  ]);
  const project = directory("project", [experiments]);
  assert.deepEqual(await listExperimentArtifactsFromDirectory(project), [
    { fileName: "experiment_a.plan.json", contents: "a-plan" },
    { fileName: "experiment_a.result.json", contents: "a-result" },
    { fileName: "experiment_z.result.json", contents: "z-result" },
  ]);
  assert.equal(
    await readExperimentArtifactFromDirectory(project, "experiment_a.plan.json"),
    "a-plan",
  );
  await assert.rejects(
    () => readExperimentArtifactFromDirectory(project, "../experiment_a.plan.json"),
    /not an experiment artifact/,
  );
});
