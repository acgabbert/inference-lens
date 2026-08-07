import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cssPath = fileURLToPath(new URL("../app/globals.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");

/** globals.css plus every CSS Module — the scales are one system, not two. */
function allStylesheets(): { name: string; source: string }[] {
  const appDir = fileURLToPath(new URL("../app", import.meta.url));
  const sheets = [{ name: "app/globals.css", source: css }];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path, `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith(".module.css")) {
        sheets.push({
          name: `app/${prefix}${entry.name}`,
          source: readFileSync(path, "utf8"),
        });
      }
    }
  };
  walk(appDir, "");
  return sheets;
}

/** Declarations of `prop: value;`, excluding the :root token block. */
function declarationsOutsideRoot(
  source: string,
  propPattern: RegExp,
): { prop: string; value: string }[] {
  const rootStart = source.indexOf(":root {");
  const rootEnd = rootStart === -1 ? -1 : source.indexOf("\n}\n", rootStart);
  const found: { prop: string; value: string }[] = [];
  for (const match of source.matchAll(/^\s*([a-z-]+):[ \t]*([^;{}]+?)\s*(?:!important)?;/gm)) {
    if (rootStart !== -1 && match.index! >= rootStart && match.index! <= rootEnd) {
      continue;
    }
    if (propPattern.test(match[1])) {
      found.push({ prop: match[1], value: match[2] });
    }
  }
  return found;
}

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

const SPACING_PROPS =
  /^(padding|margin|gap|row-gap|column-gap)(-(top|bottom|left|right|block|inline|block-start|block-end|inline-start|inline-end))?$/;

test("spacing is expressed in scale steps, not per-rule literals", () => {
  const requiredSteps = [
    "--space-3xs",
    "--space-2xs",
    "--space-xs",
    "--space-sm",
    "--space-md",
    "--space-lg",
    "--space-xl",
    "--space-2xl",
    "--space-3xl",
  ];
  for (const step of requiredSteps) {
    assert.match(css, new RegExp(`${step}: \\d+px;`), `expected ${step}`);
  }

  // The three kinds of length that are deliberately not rhythm. Anything else
  // with a literal length in a spacing property is an un-tokenized value: it
  // will not move when the scale is retuned, so the UI drifts out of step.
  const isExempt = (length: string): boolean => {
    const px = length.endsWith("rem")
      ? Number.parseFloat(length) * 16
      : Number.parseFloat(length);
    if (px < 0) return true; // pull-ups that cancel a parent's padding
    if (Math.abs(px) <= 1) return true; // hairline alignment against a 1px border
    return px > 32; // one-off layout offsets (empty-state drops), not rhythm
  };

  const offenders: string[] = [];
  for (const { name, source } of allStylesheets()) {
    for (const { prop, value } of declarationsOutsideRoot(source, SPACING_PROPS)) {
      if (value.includes("var(") || value.includes("calc(")) continue;
      for (const length of value.match(/-?[0-9.]+(px|rem)/g) ?? []) {
        if (!isExempt(length)) offenders.push(`${name}: ${prop}: ${value};`);
      }
    }
  }
  assert.deepEqual(offenders, [], "spacing literal(s) not on the scale");
});

test("corner radius and line height come from their scales too", () => {
  for (const token of [
    "--radius-xs",
    "--radius-sm",
    "--radius-md",
    "--radius-lg",
    "--radius-xl",
    "--radius-pill",
    "--leading-tight",
    "--leading-normal",
    "--leading-prose",
  ]) {
    assert.match(css, new RegExp(`${token}: `), `expected ${token}`);
  }

  const radiusOffenders: string[] = [];
  for (const { name, source } of allStylesheets()) {
    for (const { value } of declarationsOutsideRoot(source, /^border-radius$/)) {
      if (value.includes("var(")) continue;
      // 0 and 50% are shapes, not radii on the scale, and a radius at or below
      // 2px is rounding a hairline mark rather than giving a box a corner.
      if (/^(0|[0-9.]+%)$/.test(value.trim())) continue;
      for (const length of value.match(/[0-9.]+(px|rem)/g) ?? []) {
        const px = length.endsWith("rem")
          ? Number.parseFloat(length) * 16
          : Number.parseFloat(length);
        if (px > 2) radiusOffenders.push(`${name}: ${value}`);
      }
    }
  }
  assert.deepEqual(radiusOffenders, [], "border-radius literal(s) not on the scale");

  // Glyph and control geometry (0, 1, 1.1, 1.2) is centring, not prose rhythm.
  const leadingGeometry = new Set(["0", "1", "1.1", "1.2"]);
  const leadingOffenders: string[] = [];
  for (const { name, source } of allStylesheets()) {
    for (const { value } of declarationsOutsideRoot(source, /^line-height$/)) {
      if (value.includes("var(") || leadingGeometry.has(value.trim())) continue;
      leadingOffenders.push(`${name}: ${value}`);
    }
  }
  assert.deepEqual(leadingOffenders, [], "line-height literal(s) not on the scale");
});
