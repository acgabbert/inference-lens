import { isChatEvaluationSuite } from "./evaluation-suites.ts";
import { isSensitiveTemplateVariableName, parseProjectFile } from "./project.ts";
import type { ProjectFile } from "./project.ts";
import type {
  EnvironmentId,
  EvaluationSuiteId,
  EvaluationVariantId,
  ResolvedRunInput,
} from "./run-kernel/types.ts";
import {
  renderTemplateText,
  TEMPLATE_VARIABLE_NAME_PATTERN,
} from "./template-engine.ts";

/**
 * Counted in UTF-16 code units, like the schema check limits. They start
 * conservative because raising a limit later is compatible and lowering one is
 * not. The two resolved limits exist because derived entries can grow
 * exponentially; reference depth needs none, since references are acyclic and
 * entries are bounded.
 */
export const ENVIRONMENT_LIMITS = {
  environmentsPerProject: 50,
  entriesPerEnvironment: 200,
  authoredEntryValueLength: 65_536,
  resolvedEntryLength: 150_000,
  resolvedEnvironmentLength: 1_000_000,
} as const;

export interface ProjectEnvironmentEntry {
  name: string;
  value: string;
}

/** Mutable authored content; runs and plans snapshot what they consume. */
export interface ProjectEnvironment {
  id: EnvironmentId;
  /** Unique within the project ignoring case and surrounding whitespace. */
  name: string;
  /** Ordered; names are unique and follow the native variable grammar. */
  entries: ProjectEnvironmentEntry[];
}

export type EnvironmentDiagnostic =
  | {
      code: "missing-environment-reference";
      entryName: string;
      reference: string;
      message: string;
    }
  | {
      code: "invalid-environment-token";
      entryName: string;
      token: string;
      message: string;
    }
  | {
      code: "environment-limit-exceeded";
      entryName?: string;
      limit: number;
      message: string;
    };

export interface ResolvedEnvironment {
  environmentId: EnvironmentId;
  name: string;
  /**
   * Every entry resolution reached, fully resolved and literal. After a limit
   * diagnostic, resolution has stopped and later entries are absent: a value
   * is never truncated.
   */
  values: Record<string, string>;
  diagnostics: EnvironmentDiagnostic[];
}

/** One validation failure, located relative to the environments array. */
export interface EnvironmentIssue {
  path: Array<string | number>;
  message: string;
}

/** Entry names a value references, deduplicated, in first-use order. */
function entryReferences(value: string): string[] {
  return [...new Set(renderTemplateText(value, {}).occurrences.map(({ name }) => name))];
}

function referenceGraph(environment: ProjectEnvironment): Map<string, string[]> {
  const names = new Set(environment.entries.map(({ name }) => name));
  return new Map(
    environment.entries.map(({ name, value }) => [
      name,
      entryReferences(value).filter((reference) => names.has(reference)),
    ]),
  );
}

/**
 * Each cycle once, as the entry where it was found and the names around it.
 * Depth-first in authored order, so the report is stable across runs.
 */
function referenceCycles(graph: Map<string, string[]>): Array<{ entryName: string; names: string[] }> {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const cycles: Array<{ entryName: string; names: string[] }> = [];
  const visit = (name: string): void => {
    state.set(name, "visiting");
    stack.push(name);
    for (const reference of graph.get(name) ?? []) {
      const referenceState = state.get(reference);
      if (referenceState === "visiting") {
        const start = stack.indexOf(reference);
        cycles.push({ entryName: reference, names: [...stack.slice(start), reference] });
      } else if (!referenceState) {
        visit(reference);
      }
    }
    stack.pop();
    state.set(name, "done");
  };
  for (const name of graph.keys()) if (!state.has(name)) visit(name);
  return cycles;
}

/**
 * Authored-content rules that make a project invalid. A cycle is one of them,
 * so resolution never sees one; a missing reference is not, because an
 * environment may be saved while it is still being filled in.
 */
export function environmentIssues(
  environments: readonly ProjectEnvironment[],
): EnvironmentIssue[] {
  const issues: EnvironmentIssue[] = [];
  if (environments.length > ENVIRONMENT_LIMITS.environmentsPerProject) {
    issues.push({
      path: [],
      message: `A project can hold at most ${ENVIRONMENT_LIMITS.environmentsPerProject} environments.`,
    });
  }
  const environmentNames = new Set<string>();
  environments.forEach((environment, environmentIndex) => {
    const normalizedName = environment.name.trim().toLowerCase();
    if (!normalizedName) {
      issues.push({ path: [environmentIndex, "name"], message: "Environment name cannot be empty." });
    } else if (environmentNames.has(normalizedName)) {
      issues.push({
        path: [environmentIndex, "name"],
        message: `Another environment is already named "${environment.name.trim()}".`,
      });
    }
    environmentNames.add(normalizedName);

    if (environment.entries.length > ENVIRONMENT_LIMITS.entriesPerEnvironment) {
      issues.push({
        path: [environmentIndex, "entries"],
        message: `An environment can hold at most ${ENVIRONMENT_LIMITS.entriesPerEnvironment} entries.`,
      });
      return;
    }
    const entryNames = new Set<string>();
    environment.entries.forEach(({ name, value }, entryIndex) => {
      const path = [environmentIndex, "entries", entryIndex];
      if (!TEMPLATE_VARIABLE_NAME_PATTERN.test(name)) {
        issues.push({ path: [...path, "name"], message: `"${name}" is not a valid variable name.` });
      } else if (isSensitiveTemplateVariableName(name)) {
        issues.push({
          path: [...path, "name"],
          message: `"${name}" is secret-like. Environments travel with the project; credentials are supplied through the connection.`,
        });
      } else if (entryNames.has(name)) {
        issues.push({ path: [...path, "name"], message: `Entry "${name}" is defined more than once.` });
      }
      entryNames.add(name);
      if (value.length > ENVIRONMENT_LIMITS.authoredEntryValueLength) {
        issues.push({
          path: [...path, "value"],
          message: `An entry value can be at most ${ENVIRONMENT_LIMITS.authoredEntryValueLength} characters.`,
        });
      }
    });
    // A duplicate name makes the reference graph ambiguous, so cycles are
    // reported only once names are settled.
    if (entryNames.size !== environment.entries.length) return;
    const entryIndex = new Map(environment.entries.map(({ name }, index) => [name, index]));
    for (const { entryName, names } of referenceCycles(referenceGraph(environment))) {
      issues.push({
        path: [environmentIndex, "entries", entryIndex.get(entryName)!, "value"],
        message: `Entries reference each other in a cycle: ${names.join(" → ")}.`,
      });
    }
  });
  return issues;
}

/**
 * Resolves every entry once, in dependency order. The environment must
 * already be valid: a cycle here is a caller error, not a diagnostic.
 *
 * A length is computed before its value is built, so an exponential chain of
 * derived entries stops at the first entry that would cross a limit instead of
 * allocating it first.
 */
export function resolveEnvironment(environment: ProjectEnvironment): ResolvedEnvironment {
  const entries = new Map(environment.entries.map((entry) => [entry.name, entry]));
  const graph = referenceGraph(environment);
  const values: Record<string, string> = {};
  const diagnostics: EnvironmentDiagnostic[] = [];
  const visiting = new Set<string>();
  let total = 0;
  let stopped = false;

  const resolve = (name: string): void => {
    if (stopped || Object.hasOwn(values, name)) return;
    if (visiting.has(name)) {
      throw new Error(`Environment "${environment.name}" has a reference cycle through "${name}"; validate it before resolving.`);
    }
    visiting.add(name);
    for (const reference of graph.get(name)!) {
      resolve(reference);
      if (stopped) return;
    }
    visiting.delete(name);

    const { value } = entries.get(name)!;
    const unresolved = renderTemplateText(value, {});
    const length = unresolved.occurrences.reduce(
      (sum, occurrence) =>
        Object.hasOwn(values, occurrence.name)
          ? sum + values[occurrence.name]!.length - `{{${occurrence.name}}}`.length
          : sum,
      unresolved.text.length,
    );
    const limit = length > ENVIRONMENT_LIMITS.resolvedEntryLength
      ? ENVIRONMENT_LIMITS.resolvedEntryLength
      : total + length > ENVIRONMENT_LIMITS.resolvedEnvironmentLength
        ? ENVIRONMENT_LIMITS.resolvedEnvironmentLength
        : undefined;
    if (limit !== undefined) {
      diagnostics.push({
        code: "environment-limit-exceeded",
        entryName: name,
        limit,
        message: limit === ENVIRONMENT_LIMITS.resolvedEntryLength
          ? `Entry "${name}" resolves to more than ${limit} characters.`
          : `Environment "${environment.name}" resolves to more than ${limit} characters.`,
      });
      stopped = true;
      return;
    }

    const rendered = renderTemplateText(value, values);
    for (const diagnostic of rendered.diagnostics) {
      diagnostics.push(
        diagnostic.code === "invalid-template-token"
          ? {
              code: "invalid-environment-token",
              entryName: name,
              token: diagnostic.token,
              message: `Entry "${name}" has an invalid token "${diagnostic.token}".`,
            }
          : {
              code: "missing-environment-reference",
              entryName: name,
              reference: diagnostic.name,
              message: `Entry "${name}" references "${diagnostic.name}", which this environment does not define.`,
            },
      );
    }
    values[name] = rendered.text;
    total += rendered.text.length;
  };

  for (const { name } of environment.entries) {
    resolve(name);
    if (stopped) break;
  }
  // Authored order reads better than resolution order in a preview.
  const ordered: Record<string, string> = {};
  for (const { name } of environment.entries) {
    if (Object.hasOwn(values, name)) ordered[name] = values[name]!;
  }
  return { environmentId: environment.id, name: environment.name, values: ordered, diagnostics };
}

/**
 * The diagnostics that refuse a run which consumes `consumedNames`: those on
 * a consumed entry or on any entry it derives from, and every limit
 * diagnostic. An unfinished entry no prompt uses does not block the run.
 */
export function blockingEnvironmentDiagnostics(
  environment: ProjectEnvironment,
  resolved: ResolvedEnvironment,
  consumedNames: Iterable<string>,
): EnvironmentDiagnostic[] {
  const graph = referenceGraph(environment);
  const reached = new Set<string>();
  const pending = [...consumedNames];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (reached.has(name)) continue;
    reached.add(name);
    pending.push(...(graph.get(name) ?? []));
  }
  return resolved.diagnostics.filter(
    (diagnostic) =>
      diagnostic.code === "environment-limit-exceeded" || reached.has(diagnostic.entryName),
  );
}

/** Something that names an environment and would change if it disappeared. */
export type EnvironmentReference =
  | { kind: "project-default" }
  | { kind: "evaluation-suite"; suiteId: EvaluationSuiteId; suiteName: string }
  | {
      kind: "evaluation-variant";
      suiteId: EvaluationSuiteId;
      suiteName: string;
      variantId: EvaluationVariantId;
      variantName: string;
    };

export function environmentReferences(
  project: Pick<ProjectFile, "defaults" | "evaluationSuites">,
  environmentId: EnvironmentId,
): EnvironmentReference[] {
  const references: EnvironmentReference[] = [];
  if (project.defaults.environmentId === environmentId) references.push({ kind: "project-default" });
  for (const suite of project.evaluationSuites) {
    if (!isChatEvaluationSuite(suite)) continue;
    if (suite.execution.environmentId === environmentId) {
      references.push({ kind: "evaluation-suite", suiteId: suite.id, suiteName: suite.name });
    }
    for (const variant of suite.variants) {
      if (variant.overrides.environmentId === environmentId) {
        references.push({
          kind: "evaluation-variant",
          suiteId: suite.id,
          suiteName: suite.name,
          variantId: variant.id,
          variantName: variant.name,
        });
      }
    }
  }
  return references;
}

/** Inserts the environment, or replaces the one with its ID in place. */
export function setProjectEnvironment(
  project: ProjectFile,
  environment: ProjectEnvironment,
): ProjectFile {
  const index = project.environments.findIndex(({ id }) => id === environment.id);
  const environments = index < 0
    ? [...project.environments, structuredClone(environment)]
    : project.environments.map((existing, existingIndex) =>
        existingIndex === index ? structuredClone(environment) : existing,
      );
  return parseProjectFile({ ...project, environments });
}

/**
 * Refuses while anything still selects the environment. Clearing a selection
 * silently would change what those runs render, unlike withdrawing a tool.
 */
export function removeProjectEnvironment(
  project: ProjectFile,
  environmentId: EnvironmentId,
): { ok: true; project: ProjectFile } | { ok: false; references: EnvironmentReference[] } {
  const references = environmentReferences(project, environmentId);
  if (references.length > 0) return { ok: false, references };
  return {
    ok: true,
    project: parseProjectFile({
      ...project,
      environments: project.environments.filter(({ id }) => id !== environmentId),
    }),
  };
}

/**
 * Why recorded evidence is inconsistent, if it is: the environment snapshot
 * must hold exactly the entries some template use took from it, with the
 * values that use recorded. Traces and plans both enforce it.
 */
export function environmentProvenanceIssue(
  input: Pick<ResolvedRunInput, "templateResolutions" | "environment">,
): string | undefined {
  const supplied = new Set<string>();
  for (const resolution of input.templateResolutions) {
    for (const [name, source] of Object.entries(resolution.valueSources ?? {})) {
      if (source !== "environment") continue;
      const consumed = input.environment?.consumed;
      if (!consumed || !Object.hasOwn(consumed, name) || consumed[name] !== resolution.values[name]) {
        return `Template provenance for "${resolution.templateUseId}" takes "${name}" from an environment the run did not record.`;
      }
      supplied.add(name);
    }
  }
  const unused = Object.keys(input.environment?.consumed ?? {}).find((name) => !supplied.has(name));
  return unused === undefined
    ? undefined
    : `The recorded environment holds "${unused}", which no template use took.`;
}
