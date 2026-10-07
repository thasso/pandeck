import { useEffect, useRef, type ReactNode } from "react";
import type { DocumentLineAnchor } from "@assistant/shared/documentTargets";
import { partialRangeNotice, shownAnchorRange } from "../lib/documentRange.ts";

/**
 * What a source renderer says when the address asked for more lines than it
 * drew. Line-oriented bodies get this from their own reveal controls
 * (`CollapsibleOutput`); this is for the renderers that have none — rendered
 * Markdown, a pierre surface — so the sentence is the same everywhere.
 */
export function DocumentRangeNotice({
  anchor,
  className = "",
}: {
  anchor?: DocumentLineAnchor | undefined;
  className?: string;
}) {
  const shown = shownAnchorRange(anchor);
  const notice = shown?.truncated ? partialRangeNotice(anchor, shown) : null;
  if (!notice) return null;
  return (
    <p className={`text-sm text-muted-foreground ${className}`}>{notice}</p>
  );
}

/**
 * What an addressed node looks like where this is the ONLY pass marking it —
 * a rendered Markdown block, a pierre surface. A renderer that marks the range
 * itself draws one continuous band instead (`index.css`'s `.cb-anchored`).
 */
const ANCHOR_MARK = [
  "rounded-sm",
  "bg-accent",
  "ring-1",
  "ring-inset",
  "ring-primary/30",
];

/** Scroll a source renderer to the first block containing a 1-based line. */
export function DocumentAnchorRegion({
  anchor,
  children,
  className = "",
}: {
  anchor?: DocumentLineAnchor | undefined;
  children: ReactNode;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!anchor) return;
    const root = rootRef.current;
    if (!root) return;
    // Marking follows the bounded range, never the authored one: a
    // `#L1-L500000` address may not put a mark on half a million nodes.
    const bounded = shownAnchorRange(anchor);
    if (!bounded) return;
    let scrolled = false;
    const reveal = () => {
      const rangeEnd = bounded.end;
      const nodes = [
        ...root.querySelectorAll<HTMLElement>("[data-source-line-start]"),
      ];
      const highlighted = nodes.filter((node) => {
        const start = Number(node.dataset.sourceLineStart);
        const end = Number(node.dataset.sourceLineEnd ?? start);
        return start <= rangeEnd && end >= anchor.start;
      });
      if (highlighted.length === 0) return false;
      for (const node of highlighted) {
        node.dataset.documentAnchor = "true";
        // `CodeBlock` names every line of a block, and marks the addressed ones
        // itself as ONE region with only its ends rounded. Decorating them here
        // too would put a ring and two corners around each line of that band,
        // so a marked node keeps the look its renderer gave it.
        if (!node.classList.contains("cb-anchored"))
          node.classList.add(...ANCHOR_MARK);
      }
      if (scrolled) return true;
      const target =
        highlighted.find((node) => {
          const start = Number(node.dataset.sourceLineStart);
          const end = Number(node.dataset.sourceLineEnd ?? start);
          return start <= anchor.start && end >= anchor.start;
        }) ?? highlighted[0];
      target?.scrollIntoView({ block: "center" });
      scrolled = true;
      return true;
    };
    reveal();
    // A renderer may replace the addressed lines after the first paint — late
    // content, virtualized rows, a deferred syntax highlight — which takes this
    // mark with the nodes it was written on. Re-mark for a bounded window,
    // scrolling only the first time, then stop: a line that cannot appear must
    // not leave an observer alive forever.
    const observer = new MutationObserver(() => void reveal());
    observer.observe(root, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), 2_000);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      for (const node of root.querySelectorAll<HTMLElement>(
        "[data-document-anchor]",
      )) {
        delete node.dataset.documentAnchor;
        node.classList.remove(...ANCHOR_MARK);
      }
    };
  }, [anchor]);
  return (
    <div ref={rootRef} className={className}>
      {children}
    </div>
  );
}
