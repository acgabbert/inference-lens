import assert from "node:assert/strict";
import test from "node:test";

import {
  type MarkdownBlock,
  type MarkdownInline,
  parseInline,
  parseMarkdown,
  safeLinkHref,
} from "../packages/core/src/markdown.ts";

/** Flattens an inline tree to its literal characters for readable assertions. */
function plain(nodes: MarkdownInline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
          return node.text;
        case "code":
          return node.text;
        default:
          return plain(node.children);
      }
    })
    .join("");
}

function blockText(block: MarkdownBlock): string {
  if (block.kind === "paragraph" || block.kind === "heading") {
    return plain(block.content);
  }
  if (block.kind === "code") return block.text;
  return "";
}

test("parses headings, paragraphs, and thematic breaks", () => {
  const blocks = parseMarkdown("# Title\n\nBody text.\n\n---\n\n### Deep");

  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["heading", "paragraph", "thematicBreak", "heading"],
  );
  assert.equal((blocks[0] as { level: number }).level, 1);
  assert.equal(blockText(blocks[0]), "Title");
  assert.equal(blockText(blocks[1]), "Body text.");
  assert.equal((blocks[3] as { level: number }).level, 3);
});

test("parses fenced code with a language and leaves its content literal", () => {
  const [block] = parseMarkdown("```ts\nconst x = **not bold**;\n```");

  assert.equal(block.kind, "code");
  assert.equal((block as { language?: string }).language, "ts");
  assert.equal((block as { open: boolean }).open, false);
  assert.equal(blockText(block), "const x = **not bold**;");
});

test("treats an unterminated fence as an open code block while streaming", () => {
  const [block] = parseMarkdown("```py\nprint(1)\nprint(2");

  assert.equal(block.kind, "code");
  assert.equal((block as { open: boolean }).open, true);
  assert.equal(blockText(block), "print(1)\nprint(2");
});

test("keeps unmatched inline delimiters literal until the closer arrives", () => {
  assert.equal(parseInline("a **bold").length, 1);
  assert.equal(plain(parseInline("a **bold")), "a **bold");

  const closed = parseInline("a **bold**");
  assert.equal(closed.at(-1)?.kind, "strong");
  assert.equal(plain(closed), "a bold");
});

test("does not emphasize underscores inside a word", () => {
  const nodes = parseInline("call snake_case_name now");

  assert.deepEqual(nodes, [{ kind: "text", text: "call snake_case_name now" }]);
  assert.equal(parseInline("an _emphatic_ word").at(1)?.kind, "emphasis");
});

test("distinguishes emphasis from strong and nests inline content", () => {
  const nodes = parseInline("*em* and **strong with `code`**");

  assert.equal(nodes[0].kind, "emphasis");
  const strong = nodes.at(-1);
  assert.equal(strong?.kind, "strong");
  assert.equal(
    (strong as { children: MarkdownInline[] }).children.at(-1)?.kind,
    "code",
  );
});

test("parses code spans, including backtick runs and escapes", () => {
  assert.deepEqual(parseInline("`a * b`"), [{ kind: "code", text: "a * b" }]);
  assert.deepEqual(parseInline("`` a`b ``"), [{ kind: "code", text: "a`b" }]);
  assert.deepEqual(parseInline("\\*literal\\*"), [
    { kind: "text", text: "*literal*" },
  ]);
});

test("parses inline links and rejects unsupported link forms", () => {
  const [link] = parseInline("[docs](https://example.com/a)");
  assert.equal(link.kind, "link");
  assert.equal((link as { href: string }).href, "https://example.com/a");

  // Reference links are not supported, so they stay literal.
  assert.equal(plain(parseInline("[docs][ref]")), "[docs][ref]");
});

test("rejects link targets outside the allowed schemes", () => {
  assert.equal(safeLinkHref("https://example.com"), "https://example.com");
  assert.equal(safeLinkHref("mailto:a@example.com"), "mailto:a@example.com");
  assert.equal(safeLinkHref("./relative.md"), "./relative.md");
  assert.equal(safeLinkHref("javascript:alert(1)"), null);
  assert.equal(safeLinkHref("data:text/html,<script>"), null);
  assert.equal(safeLinkHref("  "), null);
});

test("parses tight and loose lists with nesting", () => {
  const [tight] = parseMarkdown("- one\n- two\n  - nested\n");
  assert.equal(tight.kind, "list");
  const list = tight as Extract<MarkdownBlock, { kind: "list" }>;
  assert.equal(list.ordered, false);
  assert.equal(list.tight, true);
  assert.equal(list.items.length, 2);
  assert.equal(list.items[1].blocks.at(-1)?.kind, "list");

  const [loose] = parseMarkdown("1. one\n\n2. two\n");
  const ordered = loose as Extract<MarkdownBlock, { kind: "list" }>;
  assert.equal(ordered.ordered, true);
  assert.equal(ordered.start, 1);
  assert.equal(ordered.tight, false);
  assert.equal(ordered.items.length, 2);
});

test("carries a non-default ordered list start", () => {
  const [block] = parseMarkdown("3. three\n4. four");
  assert.equal((block as { start: number }).start, 3);
});

test("parses blockquotes recursively", () => {
  const [block] = parseMarkdown("> quoted **text**\n> - item");

  assert.equal(block.kind, "blockquote");
  const quote = block as Extract<MarkdownBlock, { kind: "blockquote" }>;
  assert.deepEqual(
    quote.blocks.map((child) => child.kind),
    ["paragraph", "list"],
  );
});

test("parses GFM tables with alignment and escaped pipes", () => {
  const [block] = parseMarkdown(
    "| a | b | c |\n| :- | :-: | -: |\n| 1 | 2 \\| 3 | 4 |",
  );

  assert.equal(block.kind, "table");
  const table = block as Extract<MarkdownBlock, { kind: "table" }>;
  assert.deepEqual(table.alignments, ["left", "center", "right"]);
  assert.deepEqual(table.header.map(plain), ["a", "b", "c"]);
  assert.deepEqual(table.rows.map((row) => row.map(plain)), [
    ["1", "2 | 3", "4"],
  ]);
});

test("does not treat a pipe-bearing paragraph as a table", () => {
  const blocks = parseMarkdown("a | b\nstill prose");

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "paragraph");
});

test("pads short table rows to the header width", () => {
  const [block] = parseMarkdown("| a | b |\n| - | - |\n| 1 |");
  const table = block as Extract<MarkdownBlock, { kind: "table" }>;

  assert.deepEqual(table.rows.map((row) => row.map(plain)), [["1", ""]]);
});

test("parses indented code blocks", () => {
  const blocks = parseMarkdown("text\n\n    indented();\n\nafter");

  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["paragraph", "code", "paragraph"],
  );
  assert.equal(blockText(blocks[1]), "indented();");
});

test("ends a paragraph when a new block starts without a blank line", () => {
  const blocks = parseMarkdown("prose\n# heading\nmore prose");

  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["paragraph", "heading", "paragraph"],
  );
});

test("leaves unsupported syntax as literal text", () => {
  const blocks = parseMarkdown("<div>raw</div>\n\n![alt](img.png)");

  assert.equal(blockText(blocks[0]), "<div>raw</div>");
  assert.equal(blockText(blocks[1]), "!alt");
});

test("produces stable output across every prefix of a streamed response", () => {
  const response = [
    "# Result",
    "",
    "Here is a **summary** with `code`.",
    "",
    "- first",
    "- second",
    "",
    "```json",
    '{ "ok": true }',
    "```",
    "",
    "| key | value |",
    "| --- | ----- |",
    "| a   | 1     |",
  ].join("\n");

  for (let length = 0; length <= response.length; length += 1) {
    assert.doesNotThrow(() => parseMarkdown(response.slice(0, length)));
  }

  const blocks = parseMarkdown(response);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["heading", "paragraph", "list", "code", "table"],
  );
});

test("terminates on pathological nesting", () => {
  const deep = `${">".repeat(64)} quoted`;
  assert.doesNotThrow(() => parseMarkdown(deep));
  assert.doesNotThrow(() => parseMarkdown(`${"- ".repeat(64)}item`));
});
