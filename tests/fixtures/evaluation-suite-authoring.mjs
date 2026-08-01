export function evaluationFixture() {
  const noop = () => {};
  const project = {
    schemaVersion: 7,
    defaults: { conversationRevisionId: "revision_current" },
    conversationRevisions: [{ id: "revision_current", createdAt: "2026-08-01T12:00:00.000Z" }],
    evaluationSuites: [{
      id: "evaluation-suite_topics",
      name: "Topic quality",
      inputBindings: [{ id: "evaluation-input_topic", name: "Topic", target: { kind: "template-variable", templateUseId: "template-use_question", variableName: "topic" } }],
      cases: [{ id: "evaluation-case_migrations", name: "Migrations", values: { "evaluation-input_topic": "database migrations" }, referenceAnswer: "Explain a safe rollout.", checks: [{ checkId: "check_contains", kind: "contains", value: "rollback" }] }],
    }],
  };
  return {
    project,
    suiteId: "evaluation-suite_topics",
    revisionId: "revision_current",
    selectedCaseIds: new Set(["evaluation-case_migrations"]),
    focusedCaseId: "evaluation-case_migrations",
    repetitions: 3,
    candidates: [{ templateUseId: "template-use_question", templateName: "Question", variableName: "audience" }],
    diagnostics: [],
    selectSuite: noop, selectRevision: noop, setCaseSelected: noop, focusCase: noop,
    setRepetitions: noop, createSuite: noop, renameSuite: noop, deleteSuite: noop,
    addInput: noop, renameInput: noop, deleteInput: noop, addCase: noop,
    updateCase: noop, deleteCase: noop, addCheck: noop, updateCheck: noop, deleteCheck: noop,
  };
}

