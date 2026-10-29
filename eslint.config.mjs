import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// The terminal statuses are listed once, beside TerminalRunStatus. A copy
// drifts: review fixes have replaced some and left others behind.
const terminalStatusCopies = [
  {
    selector:
      'CallExpression:matches([arguments.0.property.name="kind"], [arguments.0.name="status"]) > MemberExpression.callee[property.name="includes"] > ArrayExpression.object:has(Literal[value="completed"]):has(Literal[value="cancelled"]):has(Literal[value="failed"])',
    message:
      "Use isTerminalRunStatus or isTerminalRunStatusKind from packages/core/src/run-kernel/types.ts instead of listing the terminal statuses.",
  },
  {
    selector:
      'LogicalExpression:not(LogicalExpression > LogicalExpression):has(BinaryExpression[left.property.name="kind"][right.value="completed"]):has(BinaryExpression[left.property.name="kind"][right.value="cancelled"]):has(BinaryExpression[left.property.name="kind"][right.value="failed"])',
    message:
      "Use isTerminalRunStatus or isTerminalRunStatusKind from packages/core/src/run-kernel/types.ts instead of comparing against each terminal status.",
  },
];

// U4 in app/use-project-workspace.client.ts: the URL's run-link fragment has
// one owner, so a pushed entry cannot replay a dismissed link on Back.
const historyOutsideRunLinks = {
  selector:
    'MemberExpression[property.name=/^(pushState|replaceState)$/]:matches([object.name="history"], [object.property.name="history"])',
  message:
    "Change the URL through app/run/run-link-url.client.ts (clearRunLinkFragment) or the run deep-link hook, which own the history entries.",
};

const runLinkModules = [
  "app/run/run-link-url.client.ts",
  "app/run/use-run-deep-link.client.ts",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Every spec takes `test` from the suite's own wrapper, which audits the
    // layout after each test (tests/e2e/support/test.ts).
    files: ["tests/e2e/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "@playwright/test", message: "Import from \"./support/test\" so the layout audit runs." }],
      }],
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,mjs}"],
    ignores: ["packages/core/src/run-kernel/types.ts", ...runLinkModules],
    rules: {
      "no-restricted-syntax": ["error", ...terminalStatusCopies, historyOutsideRunLinks],
    },
  },
  {
    files: runLinkModules,
    rules: {
      "no-restricted-syntax": ["error", ...terminalStatusCopies],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "src-tauri/target/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
