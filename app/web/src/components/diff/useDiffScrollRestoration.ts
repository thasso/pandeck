import { useLayoutEffect, useRef } from "react";

type ScrollAxis = "x" | "y";
type DiffPane = "unified" | "deletions" | "additions" | "file";

interface AxisPosition {
  element: HTMLElement | null;
  value: number;
}

interface ScrollPosition {
  x: AxisPosition;
  y: AxisPosition;
  paneLeft: Map<DiffPane, number>;
  latestPaneLeft: number;
}

function overflowForAxis(style: CSSStyleDeclaration, axis: ScrollAxis): string {
  return (axis === "x" ? style.overflowX : style.overflowY) || style.overflow;
}

/** Find the light-DOM viewport which owns one axis around a pierre surface. */
function findScrollViewport(root: HTMLElement, axis: ScrollAxis) {
  for (
    let element = root.parentElement;
    element;
    element = element.parentElement
  ) {
    const overflow = overflowForAxis(getComputedStyle(element), axis);
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay")
      return element;
  }
  return null;
}

function paneFor(element: HTMLElement): DiffPane {
  if (element.hasAttribute("data-unified")) return "unified";
  if (element.hasAttribute("data-deletions")) return "deletions";
  if (element.hasAttribute("data-additions")) return "additions";
  return "file";
}

function setAxis(element: HTMLElement, axis: ScrollAxis, value: number) {
  if (axis === "x") {
    if (element.scrollLeft !== value) element.scrollLeft = value;
  } else if (element.scrollTop !== value) {
    element.scrollTop = value;
  }
}

/**
 * Pierre owns horizontal scrolling inside its shadow root, while the worktree
 * pane owns vertical scrolling outside it. Pierre can replace either the host
 * (worker-completion remounts) or its code columns (render/layout changes), so
 * browser scroll state alone is not durable enough. Remember both axes without
 * React state and put them back before paint and after asynchronous DOM work.
 */
export function useDiffScrollRestoration(root: HTMLElement | null) {
  const positionRef = useRef<ScrollPosition>({
    x: { element: null, value: 0 },
    y: { element: null, value: 0 },
    paneLeft: new Map(),
    latestPaneLeft: 0,
  });

  // Deliberately run after every render: a keyed pierre host is replaced in the
  // same commit while this light-DOM root survives.
  useLayoutEffect(() => {
    if (!root) return;
    const position = positionRef.current;
    const xViewport = findScrollViewport(root, "x");
    const yViewport = findScrollViewport(root, "y");

    for (const [axis, viewport] of [
      ["x", xViewport],
      ["y", yViewport],
    ] as const) {
      const saved = position[axis];
      if (saved.element !== viewport) {
        saved.element = viewport;
        saved.value = viewport
          ? axis === "x"
            ? viewport.scrollLeft
            : viewport.scrollTop
          : 0;
      }
    }

    const viewportListeners = new Map<HTMLElement, () => void>();
    for (const viewport of new Set([xViewport, yViewport])) {
      if (!viewport) continue;
      const remember = () => {
        if (position.x.element === viewport)
          position.x.value = viewport.scrollLeft;
        if (position.y.element === viewport)
          position.y.value = viewport.scrollTop;
      };
      viewport.addEventListener("scroll", remember, { passive: true });
      viewportListeners.set(viewport, remember);
    }

    const paneListeners = new Map<HTMLElement, () => void>();
    let host: HTMLElement | null = null;
    let shadowObserver: MutationObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const restoreViewports = () => {
      if (position.x.element)
        setAxis(position.x.element, "x", position.x.value);
      if (position.y.element)
        setAxis(position.y.element, "y", position.y.value);
    };

    const syncPanes = () => {
      const panes = new Set<HTMLElement>();
      for (const pane of host?.shadowRoot?.querySelectorAll<HTMLElement>(
        "[data-code]",
      ) ?? []) {
        panes.add(pane);
        const key = paneFor(pane);
        if (!paneListeners.has(pane)) {
          const remember = () => {
            position.paneLeft.set(key, pane.scrollLeft);
            position.latestPaneLeft = pane.scrollLeft;
          };
          pane.addEventListener("scroll", remember, { passive: true });
          paneListeners.set(pane, remember);
        }
        const saved = position.paneLeft.get(key) ?? position.latestPaneLeft;
        if (pane.scrollLeft !== saved) pane.scrollLeft = saved;
      }
      for (const [pane, listener] of paneListeners) {
        if (panes.has(pane)) continue;
        pane.removeEventListener("scroll", listener);
        paneListeners.delete(pane);
      }
      restoreViewports();
    };

    const observeHost = () => {
      const nextHost = root.querySelector<HTMLElement>(".app-diff-host");
      if (nextHost === host) {
        syncPanes();
        return;
      }
      shadowObserver?.disconnect();
      resizeObserver?.disconnect();
      host = nextHost;
      if (host?.shadowRoot) {
        shadowObserver = new MutationObserver(syncPanes);
        shadowObserver.observe(host.shadowRoot, {
          childList: true,
          subtree: true,
        });
      }
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          syncPanes();
          restoreViewports();
        });
        if (host) resizeObserver.observe(host);
        if (xViewport) resizeObserver.observe(xViewport);
        if (yViewport && yViewport !== xViewport)
          resizeObserver.observe(yViewport);
      }
      syncPanes();
    };

    const lightObserver = new MutationObserver(observeHost);
    lightObserver.observe(root, { childList: true, subtree: true });
    observeHost();
    restoreViewports();

    return () => {
      lightObserver.disconnect();
      shadowObserver?.disconnect();
      resizeObserver?.disconnect();
      for (const [pane, listener] of paneListeners)
        pane.removeEventListener("scroll", listener);
      for (const [viewport, listener] of viewportListeners)
        viewport.removeEventListener("scroll", listener);
    };
  });
}
