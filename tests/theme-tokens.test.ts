import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cssPath = fileURLToPath(new URL("../app/globals.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");

/** Isolates the :root token block, where color literals are expected to live. */
function rootBlock(source: string): string {
  const start = source.indexOf(":root {");
  const end = source.indexOf("\n}\n", start);
  assert.ok(start !== -1 && end !== -1, "expected a :root block in globals.css");
  return source.slice(start, end);
}

test("no color literals outside the :root token block", () => {
  const root = rootBlock(css);
  const body = css.slice(0, css.indexOf(root)) + css.slice(css.indexOf(root) + root.length);

  const hexMatches = body.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hexMatches, [], "hardcoded hex color(s) found outside :root");

  const rgbMatches = body.match(/rgba?\(/g) ?? [];
  assert.deepEqual(rgbMatches, [], "hardcoded rgb()/rgba() color(s) found outside :root");

  const whiteMatches = body.match(/:\s*white\s*;/g) ?? [];
  assert.deepEqual(whiteMatches, [], "bare 'white' keyword used as a color outside :root");
});

test("every var() reference resolves to a declared custom property", () => {
  const declared = new Set(
    [...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]),
  );
  // Provided by next/font or set inline by workbench-shell.client.tsx, not declared in globals.css.
  const externallyProvided = new Set([
    "--font-geist-sans",
    "--font-geist-mono",
    "--request-pane-width",
    "--trace-panel-height",
  ]);

  const used = new Set(
    [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]),
  );

  const undeclared = [...used].filter(
    (name) => !declared.has(name) && !externallyProvided.has(name),
  );
  assert.deepEqual(undeclared, [], "var() reference(s) with no matching declaration");
});

test("no @media (prefers-color-scheme) blocks — would desync from a future manual toggle", () => {
  assert.ok(
    !/@media\s*\(\s*prefers-color-scheme/.test(css),
    "prefers-color-scheme media query found; theming should live entirely in light-dark() tokens",
  );
});

test("the product type scale is semantic, consolidated, and has an 11px floor", () => {
  const requiredRoles = {
    "--type-body": 14,
    "--type-compact": 13,
    "--type-control": 12,
    "--type-metadata": 11,
    "--type-section-heading": 16,
    "--type-page-heading": 18,
  };

  for (const [role, value] of Object.entries(requiredRoles)) {
    assert.match(css, new RegExp(`${role}: ${value}px;`), `expected ${role}`);
  }

  const fontSizeDeclarations = [...css.matchAll(/font-size:\s*([^;]+);/g)];
  assert.ok(
    fontSizeDeclarations.length <= 8,
    `semantic role grouping regressed: found ${fontSizeDeclarations.length} font-size declarations`,
  );

  // This allowlist is deliberately selector-scoped. Only non-text geometry
  // belongs here; adding a text selector to make the floor pass is not valid.
  const nonTextFontSizeExceptions = {
    "run-history-empty-illustration": {
      selector: ".run-history-empty > span",
      value: "28px",
    },
  } as const;

  const literalDeclarations = [
    ...css.matchAll(
      /font-size:\s*([0-9.]+(?:px|rem))\s*;\s*(?:\/\* type-size-exception: ([a-z0-9-]+) \*\/)?/g,
    ),
  ];
  const observedExceptionIds = new Set<string>();

  for (const match of literalDeclarations) {
    const [, value, exceptionId] = match;
    assert.ok(
      exceptionId,
      `literal font-size ${value} is not assigned to a semantic role or documented exception`,
    );
    const exception =
      nonTextFontSizeExceptions[
        exceptionId as keyof typeof nonTextFontSizeExceptions
      ];
    assert.ok(exception, `unknown type-size exception: ${exceptionId}`);
    assert.equal(value, exception.value, `wrong size for ${exceptionId}`);
    observedExceptionIds.add(exceptionId);
  }

  assert.deepEqual(
    observedExceptionIds,
    new Set(Object.keys(nonTextFontSizeExceptions)),
    "every documented non-text exception must be present exactly as audited",
  );

  for (const [exceptionId, exception] of Object.entries(
    nonTextFontSizeExceptions,
  )) {
    const escapedSelector = exception.selector.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    assert.match(
      css,
      new RegExp(
        `${escapedSelector}\\s*\\{[^}]*font-size:\\s*${exception.value.replace(".", "\\.")};\\s*/\\* type-size-exception: ${exceptionId} \\*/`,
      ),
      `type-size exception ${exceptionId} moved to an unaudited selector`,
    );
  }

  const directSizes = fontSizeDeclarations
    .map((match) => match[1].trim())
    .filter((value) => !value.startsWith("var("));
  assert.deepEqual(
    directSizes,
    Object.values(nonTextFontSizeExceptions).map(({ value }) => value),
    "meaningful text must use a semantic type role",
  );
});
