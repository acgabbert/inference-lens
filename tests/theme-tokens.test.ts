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

test("the product type scale has an 11px floor", () => {
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

  const undersized = [...css.matchAll(/font-size:\s*([0-9.]+)(px|rem)\s*;/g)]
    .filter((match) => {
      const value = Number(match[1]);
      return match[2] === "px" ? value < 11 : value * 16 < 11;
    })
    .map((match) => match[0]);

  assert.deepEqual(
    undersized,
    [],
    "meaningful text must use a semantic type role at or above 11px",
  );
});
