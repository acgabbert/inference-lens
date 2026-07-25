/**
 * A deliberately partial markdown parser for rendering streamed model output.
 *
 * This is not a CommonMark implementation and does not aim to become one. It
 * recognizes the constructs listed below and leaves everything else as literal
 * text, so the worst failure mode is "the raw characters are shown" — which is
 * what the raw view shows anyway. Silent misrendering is the thing to avoid.
 *
 * Blocks: ATX headings, fenced code, indented code, ordered and unordered
 * lists (nested), blockquotes, GFM tables, thematic breaks, paragraphs.
 * Inline: code spans, strong, emphasis, inline links, backslash escapes.
 *
 * Not supported (rendered literally): setext headings, reference links and
 * definitions, autolinks, raw HTML, images, footnotes, task lists, lazy
 * continuation lines.
 *
 * The parser is streaming-aware: it is called repeatedly on a growing prefix of
 * a response, so a trailing construct is usually incomplete. An unterminated
 * fence becomes an open code block rather than a literal backtick run, and
 * unmatched inline delimiters stay literal until their closer arrives.
 */

export type MarkdownInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "emphasis"; children: MarkdownInline[] }
  | { kind: "strong"; children: MarkdownInline[] }
  | { kind: "link"; href: string; children: MarkdownInline[] };

export type MarkdownAlignment = "left" | "center" | "right" | null;

export interface MarkdownListItem {
  blocks: MarkdownBlock[];
}

export type MarkdownBlock =
  | { kind: "paragraph"; content: MarkdownInline[] }
  | { kind: "heading"; level: number; content: MarkdownInline[] }
  | { kind: "code"; language?: string; text: string; open: boolean }
  | {
      kind: "list";
      ordered: boolean;
      start: number;
      tight: boolean;
      items: MarkdownListItem[];
    }
  | { kind: "blockquote"; blocks: MarkdownBlock[] }
  | {
      kind: "table";
      alignments: MarkdownAlignment[];
      header: MarkdownInline[][];
      rows: MarkdownInline[][][];
    }
  | { kind: "thematicBreak" };

/** Depth cap for blockquote and list recursion; deeper content stays literal. */
const MAX_NESTING_DEPTH = 6;

const ATX_HEADING = /^ {0,3}(#{1,6})(?: +(.*?))?(?: +#+)? *$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,}) *([^`\s]*).*$/;
const BLOCKQUOTE = /^ {0,3}> ?/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const TABLE_DELIMITER = /^ {0,3}\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
const INDENTED_CODE = /^ {4}(.*)$/;

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  return parseBlocks(lines, 0);
}

function parseBlocks(lines: string[], depth: number): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      index = readFencedCode(lines, index, fence, blocks);
      continue;
    }

    const heading = ATX_HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        content: parseInline(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      blocks.push({ kind: "thematicBreak" });
      index += 1;
      continue;
    }

    if (depth < MAX_NESTING_DEPTH && BLOCKQUOTE.test(line)) {
      index = readBlockquote(lines, index, depth, blocks);
      continue;
    }

    if (depth < MAX_NESTING_DEPTH && LIST_ITEM.test(line)) {
      index = readList(lines, index, depth, blocks);
      continue;
    }

    const table = readTable(lines, index, blocks);
    if (table !== null) {
      index = table;
      continue;
    }

    if (INDENTED_CODE.test(line)) {
      index = readIndentedCode(lines, index, blocks);
      continue;
    }

    index = readParagraph(lines, index, depth, blocks);
  }

  return blocks;
}

function readFencedCode(
  lines: string[],
  start: number,
  fence: RegExpExecArray,
  blocks: MarkdownBlock[],
): number {
  const indent = fence[1].length;
  const marker = fence[2];
  const language = fence[3];
  const closer = new RegExp(`^ {0,3}${marker[0]}{${marker.length},} *$`);
  const body: string[] = [];

  let index = start + 1;
  let open = true;
  while (index < lines.length) {
    if (closer.test(lines[index])) {
      open = false;
      index += 1;
      break;
    }
    body.push(stripIndent(lines[index], indent));
    index += 1;
  }

  blocks.push({
    kind: "code",
    ...(language ? { language } : {}),
    text: body.join("\n"),
    open,
  });
  return index;
}

function readIndentedCode(
  lines: string[],
  start: number,
  blocks: MarkdownBlock[],
): number {
  const body: string[] = [];
  let index = start;
  let lastContent = start;

  while (index < lines.length) {
    const indented = INDENTED_CODE.exec(lines[index]);
    if (indented) {
      body.push(indented[1]);
      lastContent = index;
      index += 1;
      continue;
    }
    if (lines[index].trim() === "") {
      body.push("");
      index += 1;
      continue;
    }
    break;
  }

  blocks.push({
    kind: "code",
    text: body.slice(0, lastContent - start + 1).join("\n"),
    open: false,
  });
  return lastContent + 1;
}

function readBlockquote(
  lines: string[],
  start: number,
  depth: number,
  blocks: MarkdownBlock[],
): number {
  const quoted: string[] = [];
  let index = start;

  while (index < lines.length && BLOCKQUOTE.test(lines[index])) {
    quoted.push(lines[index].replace(BLOCKQUOTE, ""));
    index += 1;
  }

  blocks.push({ kind: "blockquote", blocks: parseBlocks(quoted, depth + 1) });
  return index;
}

function readList(
  lines: string[],
  start: number,
  depth: number,
  blocks: MarkdownBlock[],
): number {
  const first = LIST_ITEM.exec(lines[start]) as RegExpExecArray;
  const ordered = /\d/.test(first[2]);
  const markerIndent = first[1].length;
  const start_ = ordered ? Number.parseInt(first[2], 10) : 1;
  const items: MarkdownListItem[] = [];

  let index = start;
  let tight = true;
  let pendingBlank = false;

  while (index < lines.length) {
    const item = LIST_ITEM.exec(lines[index]);
    if (
      !item ||
      item[1].length !== markerIndent ||
      /\d/.test(item[2]) !== ordered
    ) {
      break;
    }
    if (pendingBlank) tight = false;

    // Continuation lines belong to the item when indented past its marker.
    const contentIndent = item[1].length + item[2].length + item[3].length;
    const body = [item[4]];
    index += 1;

    while (index < lines.length) {
      const line = lines[index];
      if (line.trim() === "") {
        // A blank line only stays with the item when indented content follows.
        const next = lines[index + 1];
        if (next !== undefined && next.startsWith(" ".repeat(contentIndent))) {
          body.push("");
          tight = false;
          index += 1;
          continue;
        }
        break;
      }
      if (!line.startsWith(" ".repeat(contentIndent))) break;
      body.push(stripIndent(line, contentIndent));
      index += 1;
    }

    items.push({ blocks: parseBlocks(body, depth + 1) });

    pendingBlank = false;
    while (index < lines.length && lines[index].trim() === "") {
      pendingBlank = true;
      index += 1;
    }
    if (pendingBlank && !LIST_ITEM.test(lines[index] ?? "")) break;
  }

  blocks.push({ kind: "list", ordered, start: start_, tight, items });
  return index;
}

/** Returns the next line index when a GFM table starts here, else null. */
function readTable(
  lines: string[],
  start: number,
  blocks: MarkdownBlock[],
): number | null {
  const headerLine = lines[start];
  const delimiterLine = lines[start + 1];
  if (!headerLine.includes("|")) return null;
  if (delimiterLine === undefined || !TABLE_DELIMITER.test(delimiterLine)) {
    return null;
  }

  const header = splitTableRow(headerLine);
  const delimiters = splitTableRow(delimiterLine);
  if (header.length !== delimiters.length) return null;

  const alignments = delimiters.map((cell): MarkdownAlignment => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });

  const rows: MarkdownInline[][][] = [];
  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "" || !line.includes("|")) break;
    if (THEMATIC_BREAK.test(line) || ATX_HEADING.test(line)) break;
    const cells = splitTableRow(line);
    rows.push(
      Array.from({ length: header.length }, (_unused, column) =>
        parseInline(cells[column] ?? ""),
      ),
    );
    index += 1;
  }

  blocks.push({
    kind: "table",
    alignments,
    header: header.map((cell) => parseInline(cell)),
    rows,
  });
  return index;
}

function readParagraph(
  lines: string[],
  start: number,
  depth: number,
  blocks: MarkdownBlock[],
): number {
  const body: string[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") break;
    if (index > start && startsNewBlock(lines, index, depth)) break;
    body.push(line.trim());
    index += 1;
  }

  blocks.push({ kind: "paragraph", content: parseInline(body.join("\n")) });
  return index;
}

function startsNewBlock(lines: string[], index: number, depth: number): boolean {
  const line = lines[index];
  if (FENCE_OPEN.test(line)) return true;
  if (ATX_HEADING.test(line)) return true;
  if (THEMATIC_BREAK.test(line)) return true;
  if (depth < MAX_NESTING_DEPTH && BLOCKQUOTE.test(line)) return true;
  if (depth < MAX_NESTING_DEPTH && LIST_ITEM.test(line)) return true;
  const delimiter = lines[index + 1];
  return (
    line.includes("|") &&
    delimiter !== undefined &&
    TABLE_DELIMITER.test(delimiter)
  );
}

function splitTableRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === "\\" && trimmed[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function stripIndent(line: string, width: number): string {
  let removed = 0;
  while (removed < width && line[removed] === " ") removed += 1;
  return line.slice(removed);
}

const ESCAPABLE = new Set("\\`*_{}[]()#+-.!|>~");

export function parseInline(source: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let text = "";
  let index = 0;

  function flush(): void {
    if (text) {
      nodes.push({ kind: "text", text });
      text = "";
    }
  }

  while (index < source.length) {
    const character = source[index];

    if (character === "\\" && ESCAPABLE.has(source[index + 1] ?? "")) {
      text += source[index + 1];
      index += 2;
      continue;
    }

    if (character === "`") {
      const span = readCodeSpan(source, index);
      if (span) {
        flush();
        nodes.push({ kind: "code", text: span.text });
        index = span.end;
        continue;
      }
    }

    if (character === "[") {
      const link = readLink(source, index);
      if (link) {
        flush();
        nodes.push(link.node);
        index = link.end;
        continue;
      }
    }

    if (character === "*" || character === "_") {
      const emphasis = readEmphasis(source, index, character);
      if (emphasis) {
        flush();
        nodes.push(emphasis.node);
        index = emphasis.end;
        continue;
      }
    }

    text += character;
    index += 1;
  }

  flush();
  return nodes;
}

function readCodeSpan(
  source: string,
  start: number,
): { text: string; end: number } | null {
  let openLength = 0;
  while (source[start + openLength] === "`") openLength += 1;
  const fence = "`".repeat(openLength);

  let search = start + openLength;
  while (search < source.length) {
    const found = source.indexOf(fence, search);
    if (found === -1) return null;
    if (source[found + openLength] === "`") {
      // Part of a longer run; it cannot close this span.
      let runLength = 0;
      while (source[found + runLength] === "`") runLength += 1;
      search = found + runLength;
      continue;
    }
    const raw = source.slice(start + openLength, found);
    const text =
      raw.length > 2 && raw.startsWith(" ") && raw.endsWith(" ")
        ? raw.slice(1, -1)
        : raw;
    return { text: text.replaceAll("\n", " "), end: found + openLength };
  }
  return null;
}

function readLink(
  source: string,
  start: number,
): { node: MarkdownInline; end: number } | null {
  let depth = 0;
  let labelEnd = -1;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === "[") depth += 1;
    else if (source[index] === "]") {
      depth -= 1;
      if (depth === 0) {
        labelEnd = index;
        break;
      }
    }
  }
  if (labelEnd === -1 || source[labelEnd + 1] !== "(") return null;

  let parens = 0;
  let targetEnd = -1;
  for (let index = labelEnd + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === "(") parens += 1;
    else if (source[index] === ")") {
      parens -= 1;
      if (parens === 0) {
        targetEnd = index;
        break;
      }
    }
  }
  if (targetEnd === -1) return null;

  const target = source.slice(labelEnd + 2, targetEnd).trim();
  // Titles are not supported; a target with whitespace is not a bare URL.
  if (target === "" || /\s/.test(target)) return null;

  return {
    node: {
      kind: "link",
      href: target,
      children: parseInline(source.slice(start + 1, labelEnd)),
    },
    end: targetEnd + 1,
  };
}

function readEmphasis(
  source: string,
  start: number,
  marker: string,
): { node: MarkdownInline; end: number } | null {
  let runLength = 0;
  while (source[start + runLength] === marker) runLength += 1;
  const strong = runLength >= 2;
  const delimiter = marker.repeat(strong ? 2 : 1);

  // An opener must be followed by content, not whitespace.
  const after = source[start + delimiter.length];
  if (after === undefined || /\s/.test(after)) return null;
  // Underscores never open inside a word, so snake_case_names stay literal.
  if (marker === "_" && isWordCharacter(source[start - 1])) return null;

  let search = start + delimiter.length;
  while (search < source.length) {
    const found = source.indexOf(delimiter, search);
    if (found === -1) return null;
    const before = source[found - 1];
    const closes =
      before !== undefined &&
      before !== "\\" &&
      !/\s/.test(before) &&
      (marker !== "_" || !isWordCharacter(source[found + delimiter.length]));
    if (closes) {
      return {
        node: {
          kind: strong ? "strong" : "emphasis",
          children: parseInline(source.slice(start + delimiter.length, found)),
        },
        end: found + delimiter.length,
      };
    }
    search = found + delimiter.length;
  }
  return null;
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}]/u.test(character);
}

/**
 * Link targets come from untrusted model output. Only these schemes reach the
 * DOM; anything else renders as plain text.
 */
export function safeLinkHref(href: string): string | null {
  const value = href.trim();
  if (value.startsWith("#") || value.startsWith("/")) return value;
  if (/^(?:https?|mailto):/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  return value === "" ? null : value;
}
