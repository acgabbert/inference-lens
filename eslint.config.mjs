import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
