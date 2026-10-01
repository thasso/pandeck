import type { SelectorBundle } from "@assistant/shared/comments";
import { offsetInRoot } from "./describeAnchor.ts";
import { findQuoteOffsets } from "./quoteRangeMath.ts";
import { rangeFromOffsets } from "./textRanges.ts";

/**
 * Where a document comment sits, in the two coordinates it needs
 * (`docs/comments.md`): SOURCE lines for the agent it is sent to, and a
 * rendered-text range for the viewer that paints it. Neither is resolved
 * against edits — a pending comment lives until it is sent, so a passage that
 * has since changed simply stops being painted and is still sent by its quote.
 */

/** How a renderer names source lines in its DOM. */
export type DocumentLineSource =
  /** Markdown blocks carry `data-source-line-start`/`-end`. */
  | "markdown"
  /** A `CodeBlock` window carries `data-code-first-line`; its text IS the source. */
  | "code";

const MARKDOWN_START = "data-source-line-start";
const MARKDOWN_END = "data-source-line-end";
const CODE_FIRST_LINE = "data-code-first-line";

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

function positiveInt(value: string | null): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : null;
}

/** The innermost Markdown block around `node` and the source lines it spans. */
function markdownBlockLines(
  node: Node,
  root: HTMLElement,
): { start: number; end: number } | null {
  let element = elementOf(node);
  while (element && root.contains(element)) {
    const start = positiveInt(element.getAttribute(MARKDOWN_START));
    const end = positiveInt(element.getAttribute(MARKDOWN_END));
    if (start !== null && end !== null) return { start, end };
    if (element === root) break;
    element = element.parentElement;
  }
  return null;
}

/**
 * The exact source line of a boundary inside a `CodeBlock` window, and whether
 * the boundary sits at column 0 of that line (right after a newline).
 */
function codeLine(
  node: Node,
  offset: number,
  root: HTMLElement,
): { line: number; atLineStart: boolean } | null {
  const window = elementOf(node)?.closest<HTMLElement>(`[${CODE_FIRST_LINE}]`);
  if (!window || !root.contains(window)) return null;
  const first = positiveInt(window.getAttribute(CODE_FIRST_LINE));
  const position = offsetInRoot(window, node, offset);
  if (first === null || position === null) return null;
  const before = (window.textContent ?? "").slice(0, position);
  return {
    line: first + (before.match(/\n/g)?.length ?? 0),
    atLineStart: position > 0 && before.endsWith("\n"),
  };
}

/**
 * The 1-based source lines a rendered range covers, or undefined when the
 * renderer did not name them there. Markdown resolves to whole blocks (a
 * paragraph is one element however many source lines it spans); code resolves
 * to exact lines.
 */
export function sourceLinesForRange(
  range: Range,
  root: HTMLElement,
  source: DocumentLineSource,
): { start: number; end: number } | undefined {
  if (source === "code") {
    const start = codeLine(range.startContainer, range.startOffset, root);
    const end = codeLine(range.endContainer, range.endOffset, root);
    if (start === null || end === null) return undefined;
    // An end at column 0 of a later line selected nothing on that line —
    // decided by where the boundary IS, not by how the text happens to end.
    const last =
      end.atLineStart && end.line > start.line ? end.line - 1 : end.line;
    return { start: start.line, end: last };
  }
  const start = markdownBlockLines(range.startContainer, root);
  const end = markdownBlockLines(range.endContainer, root);
  if (!start || !end) return undefined;
  return {
    start: Math.min(start.start, end.start),
    end: Math.max(start.end, end.end),
  };
}

/**
 * Find a comment's passage in the CURRENT rendering: at its stored offsets when
 * the text there still matches, else at the first place the quote occurs.
 */
export function rangeForPendingQuote(
  root: HTMLElement,
  quote: string,
  selectors: SelectorBundle | undefined,
): Range | null {
  const position = selectors?.position;
  if (position && selectors) {
    const range = rangeFromOffsets(root, position.start, position.end);
    if (range && range.toString() === selectors.quote.exact) return range;
  }
  const offsets = findQuoteOffsets(
    root.textContent ?? "",
    selectors?.quote.exact ?? quote,
  );
  return offsets ? rangeFromOffsets(root, offsets.start, offsets.end) : null;
}
