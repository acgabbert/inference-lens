# System One Saved Prompts implementation contracts

These shapes implement the [accepted plan](SYSTEM_ONE_SAVED_PROMPTS_PLAN.md).
Slices 1–4 implement the resolver boundary, explicit migration to v15, typed
content, pure lifecycle, UI owners and evaluation shortcuts below.
Shared Assets Level 2 remains unstarted;
this feature retains ownership of v15.

## Persisted types (slice 2)

`packages/core/src/project.ts` owns the project types and strict schemas. Keep
the existing entity ID types and existing metadata fields. The library's `kind`
is the discriminator; each arm owns homogeneous revisions and its own draft.
Nested content does not need another kind tag. Strict parsing rejects a chat
revision/draft containing `decision`, a decision revision/draft containing
`messages`, and either content shape mixed with the other.

```ts
interface PromptTemplateMetadata {
  id: PromptTemplateId;
  name: string;
  currentRevisionId: PromptTemplateRevisionId;
  archivedAt?: string;
  recommendedTarget?: PromptTemplateRecommendedTarget;
}

interface PromptTemplateRevisionMetadata {
  id: PromptTemplateRevisionId;
  createdAt: string;
  name?: string;
  variableDefaults: Record<string, string>;
}

interface ChatPromptTemplateRevision extends PromptTemplateRevisionMetadata {
  messages: PromptTemplateMessages;
  externalImportId?: ExternalImportId;
}

interface DecisionPromptTemplateRevision extends PromptTemplateRevisionMetadata {
  decision: DecisionInput;
}

interface PromptTemplateDraftMetadata {
  sourceRevisionId: PromptTemplateRevisionId;
  revisionName?: string;
  variableDefaults: Record<string, string>;
}

interface ChatPromptTemplateDraft extends PromptTemplateDraftMetadata {
  messages: PromptTemplateMessages;
}

interface DecisionPromptTemplateDraft extends PromptTemplateDraftMetadata {
  decision: DecisionInput;
}

type ChatPromptTemplate = PromptTemplateMetadata & {
  kind: "chat";
  revisions: ChatPromptTemplateRevision[];
  draft?: ChatPromptTemplateDraft;
};

type DecisionPromptTemplate = PromptTemplateMetadata & {
  kind: "decision";
  revisions: DecisionPromptTemplateRevision[];
  draft?: DecisionPromptTemplateDraft;
};

type PromptTemplate = ChatPromptTemplate | DecisionPromptTemplate;
type PromptTemplateRevision = ChatPromptTemplateRevision | DecisionPromptTemplateRevision;
type PromptTemplateDraft = ChatPromptTemplateDraft | DecisionPromptTemplateDraft;

interface DecisionRequestRevisionMetadata {
  id: DecisionRequestRevisionId;
  decisionRequestId: DecisionRequestId;
  parentRevisionId?: DecisionRequestRevisionId;
  createdAt: string;
}

type ProjectDecisionRequestRevision = DecisionRequestRevisionMetadata & (
  | { kind: "inline"; decision: DecisionInput; values: Record<string, string> }
  | {
      kind: "template-use";
      templateId: PromptTemplateId;
      templateRevisionId: PromptTemplateRevisionId;
      overrides: Record<string, string>;
    }
);
```

Existing chat-specific APIs take chat content types explicitly. Shared metadata
operations accept either library kind; they cannot change a template's kind.
`externalImportId` remains chat-specific, preserving the existing n8n importer
and its receipt references. No provider wire payload belongs in these types.

Inline `values`, request `overrides`, and template defaults can omit variables.
Map key presence carries meaning: `""` is a supplied value. Existing variable
discovery defines allowed locations, escaping and names. Validation rejects
decision assignments to unused or secret-like names; legacy chat default
validation remains compatible. An unassigned variable may persist
but blocks execution. Discovery and comparisons preserve authored order.

## Resolution boundary (slice 1, extended in slice 2)

`decision-request.ts` owns `resolveProjectDecisionRequestRevision(project, id)`.
Its project input includes `decisionRequestRevisions` and `promptTemplates`.
It returns `undefined` for an unknown request revision, never a fallback to the
active revision. Callers validate project files before resolving; project
validation rejects missing template pins and cross-kind references.

The result owns cloned authored `decision`, effective `values`, discovered
`variables`, authoring `diagnostics`, and `source`. Source always contains the
request and request-revision IDs. Slice 1 supplies `kind: "inline"`; slice 2
adds a `kind: "template-use"` arm with the pinned template and template-revision
IDs. Source metadata is derived, not another persisted content copy.

The resolver merges pinned defaults and request overrides only. It preserves
tokens in authored content. Missing/malformed variables appear in diagnostics;
getting a resolved source does not mean it can run. Evaluation cases apply
their values after source resolution (a decision case may leave a binding
unfilled, which blocks the case in preflight), then `prepareDecisionRequestRun` renders
and enforces execution readiness. Compose uses the same rendering boundary.
Experiment snapshots continue receiving resolved content in the existing
format. Target recommendations and credentials never enter value resolution.

Content readers use this boundary: Compose project adoption, suite binding
candidates and input creation, suite preflight (variables and token
diagnostics included), experiment construction, and the decision suite setup
band and check editor that show the pinned questions.
Identity-only readers may still inspect revision metadata directly. Schema
validation and core draft mutations retain direct access to the stored arms;
they must distinguish inline content from template-backed content in slice 2.

## Pure lifecycle contracts (slice 2)

`decision-template.ts` owns decision template create, append-revision and
update-draft commands. They accept
`DecisionInput` and `variableDefaults`; they do not reuse chat APIs by casting
decision content to messages. Shared rename, archive/restore, current-revision
selection and revision-removal guards continue working for both kinds.

`decision-request.ts` owns use-revision, update-overrides, update-to-revision,
and detach operations. These take IDs and authored assignments and return new
validated project documents. ID suffixes and timestamps remain injectable, as
in the existing decision draft mutation. Use-revision appends a new request
and makes it active. Update and detach always append a child revision. Override
edits retain existing draft branching rules: loaded, executed, or suite-pinned
revisions cannot be mutated in place. Pinned content cannot be changed through
the inline draft updater; detach is explicit.

Update retains only overrides for surviving variables; defaults come from the
new pin. Detach copies authored content and available effective assignments
into an inline child, retaining tokens and absent assignments. Saving a library
revision never moves an existing use. Archived entries resolve historically but
cannot be chosen for new uses. These commands never choose a provider target.

Extend usage discovery to distinguish conversation uses, decision request
revisions, and suites that transitively pin a decision template. Each reports
the exact template revision and owning entity IDs; existing chat consumers must
narrow before accessing conversation fields. Revision removal guards include
all these references. Archive does not remove any of them.

Decision diffs compare authored state, question IDs/order/types/instructions,
criteria content/order, and variable defaults. Defaults are maps; authored
`decision` subtrees preserve order. Diff and equality code must not sort that
subtree or render variable tokens before comparing it.

## UI owners (slice 3)

`useProjectTemplates` owns the mixed library's lifecycle, persistence, and
session-only templates. The library shell owns selection, search/filter,
revision navigation and shared actions. Separate chat and decision editors own
their content drafts. Extract the reusable form/JSON decision input editor
from Compose; it receives draft/validation commands, without connection,
execution or session ownership.

`useDecisionCompose` exposes a capture command returning either cloned valid
authored content/current assignments or validation problems. Capture does not
save a template, render tokens, or change the current request. The library
stages a capture as a session-only template, including in an open project. The
defaults editor lets the user choose which captured values to publish before
Save to project materializes its first persisted revision.

Compose also exposes a use command. It folds a valid draft before switching,
requests explicit discard for an invalid draft, adopts the newly pinned
request, and clears the old session/result. Values remain editable while
pinned content is read-only. Edit source and return navigation use stable
request-revision IDs alongside the existing conversation-use IDs. Replacing
the project invalidates stale return targets.

`app/page.tsx` connects these owner commands and switches modes. It does not
gain template mutations, draft validation or persistence effects. In-progress
invalid JSON stays with its editor and is labeled separately from the last
persisted valid draft. Saving and authoring require no decision provider; the
existing session-template workflow handles the absence of a project.

## Evaluation boundary (slice 4)

Evaluate-revision composes two pure mutations: create a template-backed request
without changing `defaults.decisionRequestRevisionId`, then create a suite
pinned to it. Model and connection selection stay with the existing decision
suite owner. Compatible-suite discovery follows request pins to template IDs.

Retargeting first compares variables, question IDs/types and deterministic
checks. The UI reviews diagnostics before committing a new request revision
and suite pin. It preserves case data and checks for explicit repair rather
than silently dropping them. Existing plans and results remain snapshots.
CLI and workspace execution use the same core source resolver as the browser.

`decision-template-evaluation.ts` owns creation, source-based suite discovery,
retarget preview and commit. Creation composes the existing template-use and
decision-suite commands with `activate: false`. Retargeting appends a child
request revision with `activate: false` and updates only the requested suite.
Same-pin opening is a no-op. Preview projects the target pin through the existing
resolver and all-case preflight without allocating IDs or writing a project.

`useEvaluationSuiteAuthoring.evaluatePromptRevision` dispatches by template kind,
adopts the returned project and selects the suite. It retains the chat path and
rejects missing or cross-kind suites. A new decision suite initially uses the
project's default target with System One protocol; its existing Setup owner
keeps connection/model selection. Recommendations remain advisory.

`PromptsMode` connects discovery and preview to the mixed library.
`DecisionPromptEvaluationDialog` owns the choice/review presentation, Escape,
focus containment and cancellation; the decision editor owns opening it and
restoring trigger focus. Unsaved edits must be checkpointed before evaluation.
The route gains no state or mutations. Schema v15 and experiment/trace/CLI
formats remain unchanged.

## Migration boundary

Every migration advances one version. Slice 1 changes the v13 migration to
write literal v14 and guards its dispatch explicitly. Slice 2 adds a distinct
v14-to-v15 transformation and a strict v15 parser: legacy library entries gain
`kind: "chat"`, and legacy decision revisions gain `kind: "inline"`. Preserve
all IDs, parent links, drafts, defaults, archive metadata, receipts and suite
pins. Test each supported starting version through the entire chain, including
ordered decision content and reference rejection.

Schema v15 belongs to this feature. Shared Assets Level 2 subsequently moves
both kinds' drafts and classifies decision request assignments together. If
Level 2 implementation begins before slice 2, revisit the accepted order with
the user as required by the plan.
