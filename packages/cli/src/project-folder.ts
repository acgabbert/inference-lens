import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { EXPERIMENTS_DIRECTORY_NAME } from "../../../app/experiment-directory.client.ts";
import { TRACES_DIRECTORY_NAME } from "../../../app/project-directory.client.ts";
import {
  assertExperimentEntryName,
  experimentPlanFileName,
  experimentResultFileName,
} from "../../core/src/experiment.ts";
import { PROJECT_FILE_NAME, parseProjectJson } from "../../core/src/project.ts";
import type { ProjectFile } from "../../core/src/project.ts";
import { assertTraceEntryName, traceFileName } from "../../core/src/run-trace.ts";
import type { ExperimentId, RunId } from "../../core/src/run-kernel/types.ts";

export class ProjectFolderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectFolderError";
  }
}

/**
 * A project folder on the local filesystem, for a host with no browser.
 *
 * It reads `project.json` and never writes it. It writes only new artifacts,
 * with the app's names and the app's write-once rule: an identical rewrite is
 * a no-op, and a different one is refused. That is what lets a headless run
 * write into a folder the app has open — neither side ever rewrites a file the
 * other wrote.
 */
export interface NodeProjectFolder {
  readonly directory: string;
  readonly project: ProjectFile;
  /** Paths relative to the project folder, for reporting. */
  planPath(experimentId: ExperimentId): string;
  resultPath(experimentId: ExperimentId): string;
  tracePath(runId: RunId): string;
  saveExperimentArtifact(fileName: string, contents: string): Promise<void>;
  saveTrace(runId: RunId, contents: string): Promise<void>;
}

export async function openNodeProjectFolder(directoryArgument: string): Promise<NodeProjectFolder> {
  const directory = path.resolve(directoryArgument);
  let isDirectory = false;
  try {
    isDirectory = (await stat(directory)).isDirectory();
  } catch {
    throw new ProjectFolderError(`${directoryArgument} does not exist.`);
  }
  if (!isDirectory) {
    throw new ProjectFolderError(`${directoryArgument} is not a project folder. Pass the folder that contains ${PROJECT_FILE_NAME}.`);
  }
  let text: string;
  try {
    text = await readFile(path.join(directory, PROJECT_FILE_NAME), "utf8");
  } catch {
    throw new ProjectFolderError(`${directoryArgument} has no ${PROJECT_FILE_NAME}.`);
  }
  let project: ProjectFile;
  try {
    project = parseProjectJson(text);
  } catch (error) {
    throw new ProjectFolderError(
      `${PROJECT_FILE_NAME} in ${directoryArgument} is not a valid project: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const writeOnce = async (subdirectory: string, fileName: string, contents: string, noun: string) => {
    const target = path.join(directory, subdirectory);
    await mkdir(target, { recursive: true });
    const file = path.join(target, fileName);
    try {
      await writeFile(file, contents, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(file, "utf8");
      if (existing === contents) return;
      throw new ProjectFolderError(`${fileName} already exists with different contents. ${noun} are immutable.`);
    }
  };

  return {
    directory,
    project,
    planPath: (experimentId) => path.join(EXPERIMENTS_DIRECTORY_NAME, experimentPlanFileName(experimentId)),
    resultPath: (experimentId) => path.join(EXPERIMENTS_DIRECTORY_NAME, experimentResultFileName(experimentId)),
    tracePath: (runId) => path.join(TRACES_DIRECTORY_NAME, traceFileName(runId)),
    saveExperimentArtifact: (fileName, contents) =>
      writeOnce(EXPERIMENTS_DIRECTORY_NAME, assertExperimentEntryName(fileName), contents, "Experiment artifacts"),
    saveTrace: (runId, contents) =>
      writeOnce(TRACES_DIRECTORY_NAME, assertTraceEntryName(traceFileName(runId)), contents, "Run traces"),
  };
}
