"use client";

import { Fragment, type ReactNode, useMemo } from "react";

import {
  type MarkdownBlock,
  type MarkdownInline,
  parseMarkdown,
  safeLinkHref,
} from "../packages/core/src/markdown";

/**
 * Renders parsed markdown as React elements. Nothing here reaches the DOM as
 * HTML, so unsupported syntax degrades to the literal characters the model
 * produced rather than to markup.
 */
export function MarkdownView({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="markdown-body">{renderBlocks(blocks)}</div>;
}

function renderBlocks(blocks: MarkdownBlock[]): ReactNode {
  return blocks.map((block, index) => (
    <Fragment key={index}>{renderBlock(block)}</Fragment>
  ));
}

function renderBlock(block: MarkdownBlock): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return <p>{renderInline(block.content)}</p>;

    case "heading": {
      const Heading = `h${Math.min(block.level, 6)}` as "h1";
      return <Heading>{renderInline(block.content)}</Heading>;
    }

    case "code":
      return (
        <pre
          className={block.open ? "markdown-code streaming" : "markdown-code"}
          data-language={block.language}
        >
          <code>{block.text}</code>
        </pre>
      );

    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index}>{renderItem(item.blocks, block.tight)}</li>
      ));
      return block.ordered ? (
        <ol start={block.start === 1 ? undefined : block.start}>{items}</ol>
      ) : (
        <ul>{items}</ul>
      );
    }

    case "blockquote":
      return <blockquote>{renderBlocks(block.blocks)}</blockquote>;

    case "table":
      return (
        <div className="markdown-table-scroll">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th
                    key={index}
                    style={alignmentStyle(block.alignments[index])}
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td
                      key={index}
                      style={alignmentStyle(block.alignments[index])}
                    >
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    // Presented as source, because it is source. The `math` role tells a
    // screen reader this is notation rather than prose, and the visible
    // delimiters keep it honest that nothing was laid out.
    case "math":
      return (
        <div
          className={block.open ? "markdown-math streaming" : "markdown-math"}
          role="math"
          aria-label={`Math source: ${block.text}`}
        >
          <span className="markdown-math-delimiter" aria-hidden="true">{"\\["}</span>
          <pre><code>{block.text}</code></pre>
          {!block.open && (
            <span className="markdown-math-delimiter" aria-hidden="true">{"\\]"}</span>
          )}
        </div>
      );

    case "thematicBreak":
      return <hr />;
  }
}

/** A tight list item drops the paragraph wrapper so lines stay on one row. */
function renderItem(blocks: MarkdownBlock[], tight: boolean): ReactNode {
  if (tight && blocks.length === 1 && blocks[0].kind === "paragraph") {
    return renderInline(blocks[0].content);
  }
  if (tight && blocks.length > 0 && blocks[0].kind === "paragraph") {
    const [first, ...rest] = blocks;
    return (
      <>
        {renderInline(first.content)}
        {renderBlocks(rest)}
      </>
    );
  }
  return renderBlocks(blocks);
}

function alignmentStyle(
  alignment: "left" | "center" | "right" | null | undefined,
) {
  return alignment ? { textAlign: alignment } : undefined;
}

function renderInline(nodes: MarkdownInline[]): ReactNode {
  return nodes.map((node, index) => (
    <Fragment key={index}>{renderInlineNode(node)}</Fragment>
  ));
}

function renderInlineNode(node: MarkdownInline): ReactNode {
  switch (node.kind) {
    case "text":
      return node.text;
    case "code":
      return <code className="markdown-inline-code">{node.text}</code>;
    case "math":
      return (
        <code
          className="markdown-inline-math"
          role="math"
          aria-label={`Math source: ${node.text}`}
        >
          {node.text}
        </code>
      );
    case "strong":
      return <strong>{renderInline(node.children)}</strong>;
    case "emphasis":
      return <em>{renderInline(node.children)}</em>;
    case "link": {
      const href = safeLinkHref(node.href);
      if (!href) return renderInline(node.children);
      return (
        <a href={href} rel="noreferrer noopener" target="_blank">
          {renderInline(node.children)}
        </a>
      );
    }
  }
}
