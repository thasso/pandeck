import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { SelectorBundle } from "@assistant/shared/comments";
import { describeAnchor, offsetInRoot } from "../lib/describeAnchor.ts";

/**
 * Base name of the Custom Highlight painted while a composer owns a captured
 * anchor. Each hook instance paints under a SUFFIXED name of its own
 * ({@link useSelectionAnchor} returns it) — `CSS.highlights` is one registry
 * for the whole document, and a held anchor outlives the selection that made
 * it, so two commentable surfaces open at once (the Knowledge route beside the
 * Knowledge side panel, a transcript beside the Personal Assistant panel) would
 * otherwise overwrite and then delete one another's paint.
 */
const COMMENT_ANCHOR_HIGHLIGHT = "comment-anchor";

/** A selection snapshot that remains usable after the browser collapses it. */
export interface CapturedSelection {
  quote: string;
  bundle: SelectorBundle;
  /** A cloned range for domain-specific structural widening. */
  range: Range;
  /** Where the drag began (`Selection.anchorNode`), preserving reverse selections. */
  startContainer: Node;
  /** Raw text offset of that drag origin within the selection root. */
  startPosition: number;
}

function highlightsSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  );
}

function paint(name: string, range: Range): void {
  if (highlightsSupported())
    CSS.highlights.set(name, new Highlight(range.cloneRange()));
}

function unpaint(name: string): void {
  if (typeof CSS !== "undefined" && "highlights" in CSS)
    CSS.highlights.delete(name);
}

/**
 * Snapshot a browser selection inside `rootRef`.
 *
 * Selection reads happen only in the debounced document listener. Consumers use
 * the returned clone, never `window.getSelection()` in an action handler: iOS
 * commonly collapses the native selection before a thumb-edge action's click.
 * A live selection uses only the browser's native paint. `hold()` paints and
 * freezes the captured anchor while a composer owns it; `release()` closes that
 * lifetime, while `clear()` dismisses only the current affordance.
 */
export function useSelectionAnchor(
  rootRef: RefObject<HTMLElement | null>,
  enabled = true,
): {
  selection: CapturedSelection | null;
  hold: () => void;
  release: () => void;
  clear: () => void;
  /**
   * The Custom Highlight name THIS surface paints its held anchor under. The
   * surface's own `::highlight()` rule has to address it, or the anchor is
   * registered and never painted.
   */
  highlightName: string;
} {
  const [selection, setSelection] = useState<CapturedSelection | null>(null);
  const selectionRef = useRef<CapturedSelection | null>(null);
  const heldRef = useRef(false);
  // `useId` is unique per mounted surface; its value is not a CSS ident, so the
  // characters that are not are dropped before it names a highlight.
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const highlightName = useMemo(
    () => `${COMMENT_ANCHOR_HIGHLIGHT}-${instanceId}`,
    [instanceId],
  );

  const clear = useCallback(() => {
    unpaint(highlightName);
    selectionRef.current = null;
    setSelection(null);
  }, [highlightName]);
  const hold = useCallback(() => {
    heldRef.current = true;
    // Once the composer takes over, its anchor replaces the native selection.
    if (selectionRef.current) paint(highlightName, selectionRef.current.range);
    selectionRef.current = null;
    setSelection(null);
  }, [highlightName]);
  const release = useCallback(() => {
    heldRef.current = false;
    clear();
  }, [clear]);

  useEffect(() => {
    if (!enabled) {
      release();
      return;
    }
    let timer: number | undefined;
    const evaluate = () => {
      timer = undefined;
      if (heldRef.current) return;
      const root = rootRef.current;
      if (!root) {
        clear();
        return;
      }
      const live = window.getSelection();
      if (!live || live.rangeCount !== 1 || live.isCollapsed) {
        clear();
        return;
      }
      const range = live.getRangeAt(0);
      const bundle = describeAnchor(range, root, root.textContent ?? "");
      if (!bundle) {
        clear();
        return;
      }
      const snapshot = range.cloneRange();
      const startPosition = live.anchorNode
        ? offsetInRoot(root, live.anchorNode, live.anchorOffset)
        : null;
      const captured = {
        quote: live.toString().replace(/\s+/g, " ").trim(),
        bundle,
        range: snapshot,
        startContainer: live.anchorNode ?? snapshot.startContainer,
        startPosition: startPosition ?? bundle.position?.start ?? 0,
      };
      selectionRef.current = captured;
      setSelection(captured);
    };
    const schedule = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(evaluate, 150);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (heldRef.current || !(event.target instanceof Node)) return;
      const root = rootRef.current;
      if (!root) return;
      const element =
        event.target instanceof Element
          ? event.target
          : event.target.parentElement;
      if (
        root.contains(event.target) ||
        element?.closest("[data-comment-actuation], [data-comment-bar]")
      )
        return;
      clear();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || heldRef.current) return;
      window.getSelection()?.removeAllRanges();
      clear();
    };

    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [clear, enabled, release, rootRef]);

  // A surface that goes away takes its own paint with it, and only its own.
  useEffect(() => () => unpaint(highlightName), [highlightName]);

  return { selection, hold, release, clear, highlightName };
}
