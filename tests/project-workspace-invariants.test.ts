/**
 * Mechanical checks for the project-workspace rules written at the top of
 * `app/project-workspace.client.ts` (W1–W4) and on `useProjectWorkspace`
 * (U1–U4). Each rule here was broken once and caught only in review. A new
 * caller that fails one of these is not necessarily wrong, but it has to say
 * why in the rule and widen the allowlist on purpose.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import ts from "typescript";

const WORKSPACE = "app/project-workspace.client.ts";
const USE_WORKSPACE = "app/use-project-workspace.client.ts";

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function callsTo(source: ts.SourceFile, callee: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined;
      if (name === callee) calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function enclosingFunction(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
  }
  return "<module>";
}

function insideCallTo(node: ts.Node, callee: string): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === callee) {
      return true;
    }
  }
  return false;
}

function callers(source: ts.SourceFile, callee: string): string[] {
  return callsTo(source, callee).map(enclosingFunction).sort();
}

test("W2: manifest reads outside the write scope happen only before adoption", () => {
  const source = parse(WORKSPACE);
  assert.deepEqual(callers(source, "readBrowserManifest"), [
    "inspectBrowserProjectDirectory",
    "openBrowserProjectFolder",
    "reopenProjectWorkspace",
    "resumeStoredWorkspace",
  ]);
  const reopen = callsTo(source, "readBrowserManifest").filter(
    (call) => enclosingFunction(call) === "reopenProjectWorkspace",
  );
  assert.ok(reopen.every((call) => insideCallTo(call, "coordinateProjectWrites")));
});

test("W2/W3: the manifest file is opened only by the reader, the checked save and creation", () => {
  const source = parse(WORKSPACE);
  const manifestOpens = callsTo(source, "getFileHandle").filter(
    (call) => call.arguments[0]?.getText(source) === "PROJECT_FILE_NAME",
  );
  assert.deepEqual(manifestOpens.map(enclosingFunction).sort(), [
    "browserStorage",
    "createBrowserProjectFolder",
    "readBrowserManifest",
  ]);
  const save = manifestOpens.find((call) => enclosingFunction(call) === "browserStorage")!;
  assert.ok(insideCallTo(save, "coordinateProjectWrites"), "the checked save runs in the write scope");
});

test("W4: only an accepted, non-refresh adoption writes the last-project record", () => {
  const source = parse(WORKSPACE);
  assert.deepEqual(callers(source, "writeStoredWorkspace"), ["rememberBrowserWorkspace"]);
  assert.deepEqual(callers(source, "rememberBrowserWorkspace"), ["rememberAcceptedProjectWorkspace"]);

  const hook = parse(USE_WORKSPACE);
  const remembers = callsTo(hook, "rememberAcceptedProjectWorkspace");
  assert.equal(remembers.length, 1);
  let guard: ts.Node | undefined = remembers[0];
  while (guard && !ts.isIfStatement(guard)) guard = guard.parent;
  assert.ok(guard && ts.isIfStatement(guard), "the remember call sits behind a condition");
  assert.match(guard.expression.getText(hook), /!options\?\.keepTabRole/);
});
