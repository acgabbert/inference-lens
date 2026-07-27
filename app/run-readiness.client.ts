/**
 * Why a run cannot start, derived once so the request pane and the Run
 * button's tooltip cannot disagree about it.
 */

export type RunReadinessActionKind =
  | "map-profile"
  | "open-connections"
  | "review-templates"
  | "review-tools";

export interface RunReadinessAction {
  kind: RunReadinessActionKind;
  label: string;
  /** The action that resolves the notice, rendered ahead of the others. */
  primary?: boolean;
}

export interface RunReadinessFact {
  label: string;
  value: string;
}

export interface RunReadiness {
  /** True when the run is refused, false for an advisory the user may ignore. */
  blocked: boolean;
  headline: string;
  /** One line, always visible: what to do about it. */
  detail: string;
  /**
   * Why the rule exists. Held behind a disclosure — it explains a design
   * decision the user meets once, and repeating it in full every time buries
   * the line that says what to do.
   */
  explanation?: string;
  /** One-line form for the Run button's tooltip. */
  summary: string;
  facts: RunReadinessFact[];
  actions: RunReadinessAction[];
}

/**
 * One unresolved template diagnostic. Resolution reports a variable once per
 * message it appears in, so counting diagnostics would tell an author there
 * are more variables to fill in than the editor actually shows.
 */
export interface RunReadinessTemplateIssue {
  templateUseId: string;
  /** Absent when the diagnostic is not about one named variable. */
  variableName?: string;
}

export interface RunReadinessInput {
  projectOpen: boolean;
  connectionMapped: boolean;
  activeProfileName: string;
  activeProfileEndpoint: string;
  activeProfileModel: string;
  selectedToolCount: number;
  toolsEnabled: boolean;
  /** Endpoint the open project declares, when it declares one. */
  requiredEndpoint?: string;
  templateResolutionError?: string;
  templateIssues: RunReadinessTemplateIssue[];
}

function profileLabel(name: string): string {
  return name.trim() || "Untitled profile";
}

/** Distinct variables per pinned use, plus every diagnostic that names none. */
function countTemplateIssues(issues: RunReadinessTemplateIssue[]): {
  total: number;
  allNamed: boolean;
} {
  const namedByUse = new Map<string, Set<string>>();
  let unnamed = 0;
  for (const issue of issues) {
    if (issue.variableName === undefined) {
      unnamed += 1;
      continue;
    }
    const names = namedByUse.get(issue.templateUseId) ?? new Set<string>();
    names.add(issue.variableName);
    namedByUse.set(issue.templateUseId, names);
  }
  const named = [...namedByUse.values()].reduce(
    (total, names) => total + names.size,
    0,
  );
  return { total: named + unnamed, allNamed: unnamed === 0 };
}

/**
 * Reduces the run-blocking conditions to the single one the user should act on
 * first. Order matters: a project that has no profile at all cannot be run
 * whatever its templates say, so unresolved templates are reported only once a
 * connection exists.
 */
export function runReadiness(
  input: RunReadinessInput,
): RunReadiness | undefined {
  const {
    projectOpen,
    connectionMapped,
    activeProfileName,
    activeProfileEndpoint,
    activeProfileModel,
    selectedToolCount,
    toolsEnabled,
    requiredEndpoint,
    templateResolutionError,
    templateIssues,
  } = input;
  const profile = profileLabel(activeProfileName);

  if (projectOpen && !connectionMapped) {
    const mismatched = Boolean(
      requiredEndpoint && requiredEndpoint !== activeProfileEndpoint,
    );
    return {
      blocked: true,
      headline: "This project is not connected to a local profile yet",
      detail: mismatched
        ? `"${profile}" calls a different endpoint than this project declares — check it is the one you meant.`
        : "Choose the local profile it should run against.",
      explanation:
        "A project never carries a credential, so it has to be pointed at one of this device's connection profiles before a run can resolve a key.",
      summary: "Map this project's connection to a local profile before running.",
      facts: [
        ...(requiredEndpoint
          ? [{ label: "Project expects", value: requiredEndpoint }]
          : []),
        { label: `Profile "${profile}"`, value: activeProfileEndpoint },
      ],
      actions: [
        { kind: "map-profile", label: `Use "${profile}"`, primary: true },
        { kind: "open-connections", label: "Choose another profile" },
      ],
    };
  }

  if (!activeProfileModel.trim()) {
    return {
      blocked: true,
      headline: `"${profile}" has no model selected`,
      detail: "Choose one in Connections — the picker lists what this provider serves.",
      explanation:
        "A profile prefilled from a server's configuration names the provider but not always a model, and guessing one would send a name the provider has probably never heard of.",
      summary: "Choose a model for this profile before running.",
      facts: [{ label: `Profile "${profile}"`, value: activeProfileEndpoint }],
      actions: [
        { kind: "open-connections", label: "Choose a model", primary: true },
      ],
    };
  }

  if (templateResolutionError) {
    return {
      blocked: true,
      headline: "This conversation's templates cannot be resolved",
      detail: templateResolutionError,
      summary: templateResolutionError,
      facts: [],
      actions: [
        {
          kind: "review-templates",
          label: "Review the conversation",
          primary: true,
        },
      ],
    };
  }

  const issues = countTemplateIssues(templateIssues);
  if (issues.total > 0) {
    const one = issues.total === 1;
    return {
      blocked: true,
      headline: issues.allNamed
        ? `${issues.total} template variable${one ? "" : "s"} still ${
            one ? "needs" : "need"
          } a value`
        : `${issues.total} template issue${one ? "" : "s"} ${
            one ? "blocks" : "block"
          } this conversation`,
      detail:
        "Give each one a saved value or a run-only override on its card in the conversation.",
      explanation:
        "A pinned template use is sent exactly as its revision resolves, so a variable with no value has nothing to send in its place.",
      summary: "Resolve every template diagnostic before running.",
      facts: [],
      actions: [
        {
          kind: "review-templates",
          label: "Review the conversation",
          primary: true,
        },
      ],
    };
  }

  if (selectedToolCount > 0 && !toolsEnabled) {
    const one = selectedToolCount === 1;
    return {
      blocked: true,
      headline: `${selectedToolCount} selected ${
        one ? "tool cannot" : "tools cannot"
      } be sent`,
      detail: `Allow tool calling for "${profile}", or stop sending ${
        one ? "the selected tool" : "the selected tools"
      }.`,
      explanation:
        "A profile that disables tool calling cannot serialize tool definitions into its provider request.",
      summary: `Allow tool calling or deselect ${
        one ? "the tool" : "the tools"
      } before running.`,
      facts: [],
      actions: [
        {
          kind: "open-connections",
          label: "Allow tool calling",
          primary: true,
        },
        { kind: "review-tools", label: "Review tools" },
      ],
    };
  }

  // Not blocking: mapping a profile whose endpoint differs from the declared
  // one is allowed, but the request then goes somewhere the project did not
  // describe, which is worth saying out loud rather than hiding in a drawer.
  if (
    projectOpen &&
    connectionMapped &&
    requiredEndpoint &&
    requiredEndpoint !== activeProfileEndpoint
  ) {
    return {
      blocked: false,
      headline: "Running against a different endpoint than this project declares",
      detail: `Requests will be sent to the endpoint of "${profile}", not the one recorded in the project.`,
      summary: "",
      facts: [
        { label: "Project expects", value: requiredEndpoint },
        { label: "Requests go to", value: activeProfileEndpoint },
      ],
      actions: [{ kind: "open-connections", label: "Open connection settings" }],
    };
  }

  return undefined;
}
