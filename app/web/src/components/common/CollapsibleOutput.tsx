import { useMemo, useState, type HTMLAttributes, type ReactNode } from "react";

import { partialRangeNotice } from "../../lib/documentRange.ts";

export interface CollapsibleOutputProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  /** The (potentially large) output text to render, line-oriented. */
  text: string;
  /**
   * Custom renderer for the currently-visible slice (e.g. a syntax-highlighted
   * `CodeBlock`). Receives the visible text and the 1-based number of its first
   * line within `text`, which is not 1 for a focused window;
   * `CollapsibleOutput` still owns the reveal controls and line count. Defaults
   * to a monospace `<pre>`.
   */
  renderContent?: (visibleText: string, firstLine: number) => ReactNode;
  /**
   * How many lines to show before truncating. Defaults to `12` — a compact
   * preview that keeps a long `read`/`bash` result from flooding the thread.
   */
  collapsedLines?: number | undefined;
  /**
   * How many additional lines each reveal step adds. Defaults to `100`.
   */
  chunkLines?: number | undefined;
  /**
   * 1-based inclusive lines something outside addresses (a `#L120-L124`
   * document anchor). The preview is then a WINDOW around them instead of the
   * first `collapsedLines`: addressing line 500,000 renders as many lines as
   * addressing line 5, and the reveal controls grow the window in both
   * directions. The window itself never exceeds `collapsedLines`, so a range
   * longer than that opens at its first line and says how much of it is shown
   * rather than drawing a row per addressed line.
   */
  focusLines?: { start: number; end: number } | undefined;
  /**
   * Added to every line number this component SAYS, so an excerpt reports the
   * file's own lines. It does not move the content; `focusLines` and the
   * rendered slice stay 1-based within `text`.
   */
  lineNumberOffset?: number | undefined;
  /**
   * Above this many *visible* lines the body becomes a fixed-height vertical
   * scroll region instead of growing unbounded. Defaults to `400`.
   */
  scrollCap?: number;
  /**
   * Actions rendered at the END of the footer row, after the reveal controls (a
   * copy button, say). Present or not, they share the one footer row, so an
   * action never adds a second strip under the body.
   */
  footerActions?: ReactNode;
  /** Extra classes on the outer container. */
  className?: string | undefined;
}

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const controlClasses =
  "rounded px-1 py-0.5 text-sm font-medium text-muted-foreground transition-colors " +
  "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

interface LineRange {
  /** 1-based, inclusive. */
  from: number;
  to: number;
}

/**
 * The slice a collapsed body opens on: the head, or a window around the focus.
 * Never larger than `collapsedLines`, whatever the focus asks for — the window
 * is what bounds the work, so a 500,000-line range cannot widen it.
 */
function previewWindow(
  total: number,
  collapsedLines: number,
  focusLines: { start: number; end: number } | undefined,
): LineRange {
  const size = Math.min(Math.max(collapsedLines, 1), total);
  if (!focusLines) return { from: 1, to: size };
  const start = Math.min(Math.max(focusLines.start, 1), total);
  const end = Math.min(Math.max(focusLines.end, start), total);
  // A range that fits is centred; a longer one opens at its FIRST line, which
  // is the line the reader was sent to.
  const to =
    end - start + 1 >= size
      ? Math.min(total, start + size - 1)
      : Math.min(total, Math.max(end, start + Math.floor(size / 2)));
  const from = Math.max(1, Math.min(start, to - size + 1));
  return { from, to: Math.min(total, Math.max(to, from + size - 1)) };
}

/**
 * Render line-oriented output as a bounded preview with a progressive reveal:
 * the first `collapsedLines` — or a window around `focusLines` — then "Show
 * more"/"Show earlier" (a chunk at a time) / "Show all" / "Show less", with a
 * visible/total line count. Past `scrollCap` visible lines the body scrolls
 * within a fixed height rather than growing the page.
 *
 * The reveal controls keep a stable footprint (they don't reflow the
 * surrounding chrome), and long lines scroll horizontally inside the body. This
 * is the shared substrate for the tool-call body and the per-tool renderers.
 */
export function CollapsibleOutput({
  text,
  renderContent,
  collapsedLines = 12,
  chunkLines = 100,
  focusLines,
  lineNumberOffset = 0,
  scrollCap = 400,
  footerActions,
  className,
  ...props
}: CollapsibleOutputProps) {
  // The text can be a whole file; splitting it is the one O(size) step here and
  // must not run again for an unrelated re-render.
  const lines = useMemo(() => text.split("\n"), [text]);
  const total = lines.length;
  const base = previewWindow(total, collapsedLines, focusLines);

  const baseKey = `${total}:${base.from}:${base.to}`;
  const [shown, setShown] = useState<{ key: string; range: LineRange }>({
    key: baseKey,
    range: base,
  });
  // A different text or a different focus is a different preview, applied
  // during render so no frame shows the previous window under the new one.
  if (shown.key !== baseKey) setShown({ key: baseKey, range: base });
  const range = shown.key === baseKey ? shown.range : base;

  // The focused lines are never hidden by a "Show less" or a stale range.
  const from = Math.max(1, Math.min(range.from, base.from));
  const to = Math.min(total, Math.max(range.to, base.to));
  const hiddenBefore = from - 1;
  const hiddenAfter = total - to;
  const visibleCount = to - from + 1;
  const windowed = base.from > 1;
  const truncatable = hiddenBefore > 0 || hiddenAfter > 0;
  const collapsible = base.to - base.from + 1 < total;
  const atEnd = !truncatable;
  // An authored range longer than the window keeps its URL meaning, but only
  // the part on screen is drawn and marked — and the reader is told so, in the
  // one sentence every source uses, rather than left to believe the rest was
  // highlighted somewhere below. A range longer than the TEXT is not partial:
  // everything it names that exists is shown.
  const focusEnd = focusLines
    ? Math.max(focusLines.end, focusLines.start)
    : undefined;
  const focusPartial =
    focusLines !== undefined &&
    focusEnd !== undefined &&
    (focusLines.start < from || Math.min(focusEnd, total) > to);
  const focusNotice =
    focusPartial && focusLines && focusEnd !== undefined
      ? partialRangeNotice(
          {
            start: focusLines.start + lineNumberOffset,
            end: focusEnd + lineNumberOffset,
          },
          { start: from + lineNumberOffset, end: to + lineNumberOffset },
        )
      : null;

  const visibleText =
    atEnd && from === 1 ? text : lines.slice(from - 1, to).join("\n");

  return (
    <div className={cx("flex w-full flex-col gap-1", className)} {...props}>
      <div
        className={cx(
          visibleCount > scrollCap && "max-h-[60vh] overflow-y-auto",
        )}
      >
        {renderContent ? (
          renderContent(visibleText, from)
        ) : (
          <pre className="overflow-x-auto whitespace-pre font-mono text-sm text-muted-foreground">
            {visibleText}
          </pre>
        )}
      </div>
      {(collapsible || focusNotice || footerActions) && (
        <div className="flex flex-wrap items-center gap-2">
          {collapsible && (
            <>
              {hiddenBefore > 0 && (
                <button
                  type="button"
                  className={controlClasses}
                  onClick={() =>
                    setShown({
                      key: baseKey,
                      range: { from: Math.max(1, from - chunkLines), to },
                    })
                  }
                >
                  Show {Math.min(chunkLines, hiddenBefore)} earlier lines
                </button>
              )}
              {hiddenAfter > 0 && (
                <button
                  type="button"
                  className={controlClasses}
                  onClick={() =>
                    setShown({
                      key: baseKey,
                      range: { from, to: Math.min(total, to + chunkLines) },
                    })
                  }
                >
                  Show {Math.min(chunkLines, hiddenAfter)} more lines
                </button>
              )}
              {hiddenBefore + hiddenAfter > chunkLines && (
                <button
                  type="button"
                  className={controlClasses}
                  onClick={() =>
                    setShown({ key: baseKey, range: { from: 1, to: total } })
                  }
                >
                  Show all
                </button>
              )}
              {atEnd && (
                <button
                  type="button"
                  className={controlClasses}
                  onClick={() => setShown({ key: baseKey, range: base })}
                >
                  Show less
                </button>
              )}
              <span className="text-sm text-muted-foreground">
                {windowed || from > 1
                  ? `lines ${from + lineNumberOffset}–${to + lineNumberOffset} of ${total + lineNumberOffset}`
                  : `${visibleCount} of ${total} lines`}
              </span>
            </>
          )}
          {focusNotice ? (
            <span className="text-sm text-muted-foreground">{focusNotice}</span>
          ) : null}
          {footerActions ? (
            <div className="ml-auto flex items-center gap-1">
              {footerActions}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
