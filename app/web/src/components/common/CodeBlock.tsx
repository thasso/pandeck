import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type HTMLAttributes,
} from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";

import type { DocumentLineAnchor } from "@assistant/shared/documentTargets";
import { shownAnchorRange } from "../../lib/documentRange.ts";

import { CollapsibleOutput } from "./CollapsibleOutput";
import { InlineCopyButton } from "./CopyButton";
import {
  hasCachedHighlight,
  highlightToHast,
  languageFromFilename,
  resolveHighlighterLanguage,
} from "./highlighter";
import { useHighlighterLanguage } from "./useHighlighterLanguage";

export interface CodeBlockProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  /** The source code to render. */
  code: string;
  /** Explicit Shiki language id. Takes precedence over `filename`. */
  language?: string | undefined;
  /** File name; its extension infers the language when `language` is unset. */
  filename?: string | undefined;
  /** Show a left line-number gutter. Defaults to `false`. */
  showLineNumbers?: boolean;
  /**
   * File line number of the first rendered row, so an excerpt's gutter shows the
   * REAL lines it came from rather than restarting at 1. Defaults to `1`.
   */
  startLine?: number;
  /** Wrap long lines instead of scrolling horizontally. Defaults to `false`. */
  wrap?: boolean;
  /**
   * 1-based, inclusive FILE line range addressed from outside the block (a
   * `#L12-L20` document link). Its lines are named with
   * `data-source-line-start`/`-end` so a `DocumentAnchorRegion` around the
   * block can scroll to them, and marked `cb-anchored` so the mark survives
   * this block's own re-renders. The collapsed body opens as a bounded window
   * around them rather than growing to reach them, and the MARK covers the
   * bounded range only — never more lines than a renderer may draw, and never a
   * line past the end of `code`.
   */
  lineAnchor?: DocumentLineAnchor | undefined;
  /** Preview length before truncating (see `CollapsibleOutput`). */
  collapsedLines?: number;
  /** Lines revealed per "Show more" (see `CollapsibleOutput`). */
  chunkLines?: number;
  /**
   * Show a small ghost copy button under the block. It always copies the WHOLE
   * `code`, including lines still hidden behind "Show more". Defaults to
   * `false`.
   */
  copyable?: boolean;
  /** Extra classes on the outer container. */
  className?: string;
}

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Run `task` when the browser is idle; `setTimeout` where idle callbacks are unsupported (Safari). */
function scheduleIdle(task: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(task, { timeout: 500 });
    return () => cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, 0);
  return () => window.clearTimeout(handle);
}

/** Line count without materialising the lines: `code` may be a whole file. */
function countLines(text: string): number {
  let lines = 1;
  for (
    let index = text.indexOf("\n");
    index !== -1;
    index = text.indexOf("\n", index + 1)
  )
    lines += 1;
  return lines;
}

type HighlightRoot = ReturnType<typeof highlightToHast>;

interface HastNodeLike {
  type: string;
  properties?: Record<string, unknown> | undefined;
  children?: unknown[] | undefined;
}

function hastClasses(
  properties: Record<string, unknown> | undefined,
): string[] {
  const value = properties?.["class"] ?? properties?.["className"];
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
}

/**
 * Copy the highlighted tree with the lines in `[from, to]` named. Shiki already
 * emits one `.line` span per rendered line, so this only labels rows that
 * exist — no per-line element is created for the rest of the file — and it
 * leaves the memoized tree in `highlighter.ts` untouched.
 */
function markAnchoredLines(
  root: HighlightRoot,
  startLine: number,
  from: number,
  to: number,
): HighlightRoot {
  let line = startLine;
  const mark = (node: unknown): unknown => {
    if (typeof node !== "object" || node === null) return node;
    const element = node as HastNodeLike;
    const classes = hastClasses(element.properties);
    if (element.type === "element" && classes.includes("line")) {
      const number = line++;
      if (number < from || number > to) return node;
      return {
        ...element,
        properties: {
          ...element.properties,
          // The range is ONE marked region: only its ends are rounded, so the
          // rows in between read as a continuous band (`index.css`).
          class: [
            ...classes,
            "cb-anchored",
            ...(number === from ? ["cb-anchored-start"] : []),
            ...(number === to ? ["cb-anchored-end"] : []),
          ].join(" "),
          "data-source-line-start": number,
          "data-source-line-end": number,
        },
      };
    }
    const children = element.children;
    if (!Array.isArray(children)) return node;
    return { ...element, children: children.map(mark) };
  };
  return mark(root) as HighlightRoot;
}

/**
 * The plaintext shell splits at most three ways around the addressed range, so
 * an anchor is findable and marked before (or without) a syntax highlight
 * without giving every line of a large file its own element.
 */
function PlainCode({
  code,
  from,
  to,
  startLine,
}: {
  code: string;
  from: number;
  to: number;
  startLine: number;
}) {
  const lines = code.split("\n");
  const first = Math.max(0, from - startLine);
  const last = Math.min(lines.length - 1, to - startLine);
  if (first > last || first > lines.length - 1) return <>{code}</>;
  const head = lines.slice(0, first);
  const tail = lines.slice(last + 1);
  return (
    <>
      {head.length > 0 ? `${head.join("\n")}\n` : null}
      <span
        // One span for the part of the region this window holds, so an end the
        // reader has not revealed yet is left open rather than rounded here.
        className={cx(
          "cb-anchored",
          startLine + first === from && "cb-anchored-start",
          startLine + last === to && "cb-anchored-end",
        )}
        data-source-line-start={startLine + first}
        data-source-line-end={startLine + last}
      >
        {lines.slice(first, last + 1).join("\n")}
      </span>
      {tail.length > 0 ? `\n${tail.join("\n")}` : null}
    </>
  );
}

function HighlightedCode({
  code,
  language,
  showLineNumbers,
  startLine,
  wrap,
  anchorFrom,
  anchorTo,
}: {
  code: string;
  language?: string | undefined;
  showLineNumbers: boolean;
  startLine: number;
  wrap: boolean;
  anchorFrom?: number | undefined;
  anchorTo?: number | undefined;
}) {
  const highlighted = useHighlighterLanguage(language);
  // First paint is un-highlighted, then the highlight lands in an idle slot: a
  // batch of blocks entering the viewport together (expand-all, a fast scroll)
  // must not spend seconds tokenizing before the browser paints anything. The
  // plaintext shell is visually identical apart from colour, so the upgrade only
  // repaints text — no layout shift. An already-memoized highlight skips the
  // deferral entirely, so re-expanding a block never flashes.
  const key = `${language ?? ""}\u0000${code}`;
  const cached = Boolean(
    highlighted && language && hasCachedHighlight(code, language),
  );
  const [readyKey, setReadyKey] = useState<string | null>(cached ? key : null);
  const ready = cached || readyKey === key;

  useEffect(() => {
    if (ready || !highlighted || !language) return;
    return scheduleIdle(() => setReadyKey(key));
  }, [ready, highlighted, language, key]);

  // Both the highlight (memoized in `highlighter.ts`) and this hast → JSX
  // conversion are pure in (code, language); keep them off every unrelated
  // re-render of a mounted block. Computed before the fallback branch so the
  // hook order stays stable while a grammar loads.
  const element = useMemo(() => {
    if (!ready || !highlighted || !language) return null;
    const tree = highlightToHast(code, language);
    const marked =
      anchorFrom !== undefined && anchorTo !== undefined
        ? markAnchoredLines(tree, startLine, anchorFrom, anchorTo)
        : tree;
    return toJsxRuntime(marked, { Fragment, jsx, jsxs });
  }, [code, language, highlighted, ready, anchorFrom, anchorTo, startLine]);
  // Plaintext fallback: render the code as-is (escaped by React) in a Shiki-
  // styled shell so the background/padding still match highlighted blocks.
  if (element === null) {
    return (
      <div className={cx(wrap && "cb-wrap")} data-code-first-line={startLine}>
        <pre
          className={cx(
            "shiki",
            wrap ? "whitespace-pre-wrap" : "overflow-x-auto whitespace-pre",
          )}
        >
          <code>
            {anchorFrom !== undefined && anchorTo !== undefined ? (
              <PlainCode
                code={code}
                from={anchorFrom}
                to={anchorTo}
                startLine={startLine}
              />
            ) : (
              code
            )}
          </code>
        </pre>
      </div>
    );
  }
  // The gutter is a CSS counter on Shiki's `.line` spans; `--cb-line-start`
  // offsets it so an excerpt keeps the file's own numbering.
  return (
    <div
      className={cx(showLineNumbers && "cb-numbered", wrap && "cb-wrap")}
      // Where this window starts in the file, so a selection inside it maps
      // back to source lines (`lib/documentCommentAnchor.ts`).
      data-code-first-line={startLine}
      style={
        showLineNumbers && startLine !== 1
          ? { ["--cb-line-start" as string]: String(startLine - 1) }
          : undefined
      }
    >
      {element}
    </div>
  );
}

/**
 * A standalone, syntax-highlighted code block — the same Shiki highlighter and
 * Catppuccin theme as fenced code in `Markdown`, usable outside markdown (tool
 * output, file contents, commands). Language comes from `language` or the
 * `filename` extension, falling back to un-highlighted plaintext. Optionally
 * shows a line-number gutter (CSS counters on Shiki's `.line` spans) starting at
 * `startLine` — an excerpt shows the file's real lines — and truncates large
 * input through `CollapsibleOutput`. Long lines scroll horizontally unless
 * `wrap` is set. With `copyable` a small ghost copy button sits under the block
 * and copies the whole `code`. Highlighting is memoized and, on a cache miss,
 * deferred to an idle slot behind an identical-looking plaintext first paint.
 * A `lineAnchor` names and marks the lines a document link addresses, and keeps
 * them inside the reveal window, on both of those paints.
 */
export function CodeBlock({
  code,
  language,
  filename,
  showLineNumbers = false,
  startLine = 1,
  wrap = false,
  collapsedLines,
  chunkLines,
  lineAnchor,
  copyable = false,
  className,
  ...props
}: CodeBlockProps) {
  const resolved =
    resolveHighlighterLanguage(language) ?? languageFromFilename(filename);
  // The window opens around the address AS AUTHORED, so the reader can still be
  // told which part of `L2000-L500000` is on screen (`CollapsibleOutput`).
  const focusFrom = lineAnchor
    ? Math.max(lineAnchor.start, startLine)
    : undefined;
  const focusTo = lineAnchor
    ? Math.max(lineAnchor.end ?? lineAnchor.start, focusFrom ?? 0)
    : undefined;
  // What is MARKED is the bounded range instead: at most
  // `MAX_DOCUMENT_ANCHOR_LINES` from the first addressed line
  // (`lib/documentRange.ts`, the same bound the worktree surfaces select), and
  // never past the last line this block has. Both ends are therefore file lines
  // that exist, so the region gets exactly one start and one end however the
  // reveal window happens to be split (`docs/document-presentation.md`).
  const bounded = shownAnchorRange(lineAnchor);
  // Counting is O(size) and only an anchored block needs it; a caller re-making
  // its anchor object every render must not pay it again.
  const anchorStart = lineAnchor?.start;
  const lastLine = useMemo(
    () =>
      anchorStart === undefined ? startLine : startLine + countLines(code) - 1,
    [anchorStart, code, startLine],
  );
  const anchorFrom = bounded ? Math.max(bounded.start, startLine) : undefined;
  const anchorTo =
    bounded && anchorFrom !== undefined
      ? Math.max(Math.min(bounded.end, lastLine), anchorFrom)
      : undefined;
  return (
    <CollapsibleOutput
      text={code}
      collapsedLines={collapsedLines}
      chunkLines={chunkLines}
      // The addressed lines open the body as a window around themselves, so
      // they are in the DOM whether they sit on line 12 or line 500,000.
      focusLines={
        focusFrom === undefined || focusTo === undefined
          ? undefined
          : {
              start: focusFrom - startLine + 1,
              end: focusTo - startLine + 1,
            }
      }
      // An excerpt reports the file's own line numbers, not offsets into it.
      lineNumberOffset={startLine - 1}
      className={className}
      footerActions={
        copyable ? (
          <InlineCopyButton value={code} label="Copy code" />
        ) : undefined
      }
      renderContent={(visible, firstLine) => (
        <HighlightedCode
          code={visible}
          language={resolved}
          showLineNumbers={showLineNumbers}
          // The window's own first line, so the gutter keeps the file's
          // numbering and an anchor still resolves to the row it names.
          startLine={startLine + firstLine - 1}
          wrap={wrap}
          anchorFrom={anchorFrom}
          anchorTo={anchorTo}
        />
      )}
      {...props}
    />
  );
}
