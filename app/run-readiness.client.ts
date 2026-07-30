/**
 * Why a run cannot start, derived once so the request pane and the Run
 * button's tooltip cannot disagree about it.
 */

import { sameChatCompletionsTarget } from "../packages/core/src/openai-compatible.ts";

export type RunReadinessActionKind =
  | "map-profile"
  | "open-connections"
  | "update-project-endpoint"
  | "edit-template"
  | "review-templates"
  | "review-tools";

/** A serializable UI command; policy names a target but never drives the DOM. */
export type ReadinessDestination =
  | {
      surface: "connections";
      control:
        | "project-mapping"
        | "project-endpoint"
        | "profile"
        | "endpoint"
        | "tools-capability";
    }
  | {
      surface: "request";
      tab: "messages" | "templates" | "tools";
      control: "model" | "template-use" | "template-variable" | "tool-manifest" | "prompt-library";
      entityId?: string;
      fieldName?: string;
    };

export interface RunReadinessAction {
  kind: RunReadinessActionKind;
  label: string;
  destination: ReadinessDestination;
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

export interface RunEmptyStatePresentation {
  headline: string;
  detail: string;
  action?: RunReadinessAction;
}

/** The idle response repeats the first readiness policy, never a second guess. */
export function runEmptyStatePresentation(
  readiness: RunReadiness | undefined,
): RunEmptyStatePresentation {
  if (!readiness?.blocked) {
    return {
      headline: "Ready when you are",
      detail: "Run the request to see its response here.",
    };
  }
  const action = readiness.actions.find(({ primary }) => primary) ?? readiness.actions[0];
  const headline =
    action?.destination.surface === "connections" &&
    action.destination.control === "project-mapping"
      ? "Connect this project to a local profile"
      : action?.destination.surface === "connections" &&
          action.destination.control === "endpoint"
        ? "Enter the profile endpoint"
        : action?.destination.surface === "request" &&
            action.destination.control === "model"
          ? "Choose a model"
          : action?.destination.surface === "request" &&
              (action.destination.control === "template-use" ||
                action.destination.control === "template-variable")
            ? "Complete the named template inputs"
            : action?.destination.surface === "connections" &&
                action.destination.control === "tools-capability"
              ? "Allow tool calling or review selected tools"
              : readiness.headline;
  return { headline, detail: readiness.detail, ...(action ? { action } : {}) };
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

export interface RunReadinessTemplateTarget {
  templateName: string;
  connectionRequirementId: string;
  connectionRequirementName: string;
  model: string;
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
  activeConnectionRequirementId?: string;
  templateResolutionError?: string;
  templateIssues: RunReadinessTemplateIssue[];
  templateTargets?: RunReadinessTemplateTarget[];
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
    activeConnectionRequirementId,
    templateResolutionError,
    templateIssues,
    templateTargets = [],
  } = input;
  const profile = profileLabel(activeProfileName);

  if (projectOpen && !connectionMapped) {
    const mismatched = Boolean(
      requiredEndpoint &&
        !sameChatCompletionsTarget(requiredEndpoint, activeProfileEndpoint),
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
        {
          kind: "map-profile",
          label: `Map "${profile}"`,
          destination: { surface: "connections", control: "project-mapping" },
          primary: true,
        },
        {
          kind: "open-connections",
          label: "Choose another profile",
          destination: { surface: "connections", control: "profile" },
        },
      ],
    };
  }

  if (!activeProfileEndpoint.trim()) {
    return {
      blocked: true,
      headline: `"${profile}" has no endpoint configured`,
      detail: "Enter a base URL in Connections before running.",
      explanation:
        "A starting profile ships with no endpoint rather than a real provider's, so a run can never leave for somewhere the user never chose.",
      summary: "Enter an endpoint for this profile before running.",
      facts: [],
      actions: [
        {
          kind: "open-connections",
          label: "Enter an endpoint",
          destination: { surface: "connections", control: "endpoint" },
          primary: true,
        },
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
        {
          kind: "open-connections",
          label: "Choose a model",
          destination: { surface: "request", tab: "messages", control: "model" },
          primary: true,
        },
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
          destination: {
            surface: "request",
            tab: "messages",
            control: "template-use",
          },
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
          destination: {
            surface: "request",
            tab: "messages",
            control: templateIssues[0]?.variableName
              ? "template-variable"
              : "template-use",
            entityId: templateIssues[0]?.templateUseId,
            ...(templateIssues[0]?.variableName
              ? { fieldName: templateIssues[0].variableName }
              : {}),
          },
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
          destination: { surface: "connections", control: "tools-capability" },
          primary: true,
        },
        {
          kind: "review-tools",
          label: "Review tools",
          destination: { surface: "request", tab: "tools", control: "tool-manifest" },
        },
      ],
    };
  }

  const distinctTemplateTargets = new Map(
    templateTargets.map((target) => [
      `${target.connectionRequirementId}\u0000${target.model}`,
      target,
    ]),
  );
  if (distinctTemplateTargets.size > 1) {
    return {
      blocked: false,
      headline: "Templates recommend different run targets",
      detail:
        "This request uses the project’s selected model. Review the recommendations before relying on them.",
      explanation:
        "One provider request can use only one model.",
      summary: "Attached templates recommend different models.",
      facts: [...distinctTemplateTargets.values()].map((target) => ({
        label: target.templateName,
        value: `${target.connectionRequirementName} · ${target.model}`,
      })),
      actions: [
        {
          kind: "edit-template",
          label: "Review templates",
          destination: { surface: "request", tab: "templates", control: "prompt-library" },
          primary: true,
        },
        {
          kind: "open-connections",
          label: "Choose run model",
          destination: { surface: "request", tab: "messages", control: "model" },
        },
      ],
    };
  }

  const [templateTarget] = distinctTemplateTargets.values();
  if (
    templateTarget &&
    (templateTarget.connectionRequirementId !== activeConnectionRequirementId ||
      templateTarget.model !== activeProfileModel)
  ) {
    return {
      blocked: false,
      headline: `"${templateTarget.templateName}" recommends another model`,
      detail: `This run will use ${activeProfileModel}; the template recommends ${templateTarget.model}.`,
      explanation:
        "A recommendation records a template’s source target; it never changes the run target.",
      summary: "A template recommends a different model.",
      facts: [
        {
          label: "Template recommends",
          value: `${templateTarget.connectionRequirementName} · ${templateTarget.model}`,
        },
        { label: "Run uses", value: activeProfileModel },
      ],
      actions: [
        {
          kind: "open-connections",
          label: "Choose run model",
          destination: { surface: "request", tab: "messages", control: "model" },
          primary: true,
        },
        {
          kind: "edit-template",
          label: "Review template",
          destination: { surface: "request", tab: "templates", control: "prompt-library" },
        },
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
    !sameChatCompletionsTarget(requiredEndpoint, activeProfileEndpoint)
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
      // A detour and a move look identical from here, so both answers are
      // offered. Changing the declaration is the one that ends the notice, but
      // it edits the shared project file, so it does not lead.
      actions: [
        {
          kind: "open-connections",
          label: "Open connection settings",
          destination: { surface: "connections", control: "endpoint" },
        },
        {
          kind: "update-project-endpoint",
          label: "Update what the project expects",
          destination: { surface: "connections", control: "project-endpoint" },
        },
      ],
    };
  }

  return undefined;
}
