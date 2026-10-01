import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { Minus, Plus, RotateCcw, Search } from "lucide-react";
import {
  DOCUMENT_ZOOM_BOUNDS,
  DOCUMENT_ZOOM_DEFAULT,
  clampDocumentZoom,
  steppedDocumentZoom,
  type DocumentZoomMode,
} from "../lib/documentZoom.ts";
import { GhostIconButton } from "./ui/GhostIconButton.tsx";
import { InspectorSection } from "./shell/Inspector.tsx";

export interface DocumentZoomRegistration {
  mode: DocumentZoomMode;
  scale: number;
  canDecrease: boolean;
  canIncrease: boolean;
  decrease: () => void;
  increase: () => void;
  reset: () => void;
  setScale: (scale: number) => void;
}

/** Resettable zoom state keyed by document identity. */
export function useDocumentZoomRegistration(
  id: string,
  mode: DocumentZoomMode | null,
): DocumentZoomRegistration | undefined {
  const [state, setState] = useState({ id, scale: DOCUMENT_ZOOM_DEFAULT });
  const remembered = state.id === id ? state.scale : DOCUMENT_ZOOM_DEFAULT;
  const scale =
    mode === null ? remembered : clampDocumentZoom(mode, remembered);
  useEffect(() => {
    if (mode !== null && (state.id !== id || state.scale !== scale))
      setState({ id, scale });
  }, [id, mode, scale, state.id, state.scale]);
  const setScale = useCallback(
    (next: number) => {
      if (mode !== null) setState({ id, scale: clampDocumentZoom(mode, next) });
    },
    [id, mode],
  );
  return useMemo(() => {
    if (mode === null) return undefined;
    const bounds = DOCUMENT_ZOOM_BOUNDS[mode];
    return {
      mode,
      scale,
      canDecrease: scale > bounds.min,
      canIncrease: scale < bounds.max,
      decrease: () => setScale(steppedDocumentZoom(mode, scale, -1)),
      increase: () => setScale(steppedDocumentZoom(mode, scale, 1)),
      reset: () => setScale(DOCUMENT_ZOOM_DEFAULT),
      setScale,
    };
  }, [mode, scale, setScale]);
}

export function DocumentZoomActions({
  zoom,
}: {
  zoom: DocumentZoomRegistration;
}) {
  return (
    <>
      <GhostIconButton
        label="Zoom out"
        onClick={zoom.decrease}
        disabled={!zoom.canDecrease}
        icon={<Minus size={16} />}
      />
      <GhostIconButton
        label={`Reset zoom (${Math.round(zoom.scale * 100)}%)`}
        onClick={zoom.reset}
        disabled={zoom.scale === DOCUMENT_ZOOM_DEFAULT}
        icon={<RotateCcw size={16} />}
      />
      <GhostIconButton
        label="Zoom in"
        onClick={zoom.increase}
        disabled={!zoom.canIncrease}
        icon={<Plus size={16} />}
      />
    </>
  );
}

/**
 * Zoom on a phone: a disclosed section of the dock's expanded sheet, not three
 * more controls in its resting row. A worktree document's row already carries
 * Back, Forward, Close, its source actions and its review actions, and at 360px
 * the three that scroll out of reach should not be the way back out of the
 * document. The browser's own pinch stays the fast path; this is the one that
 * works for a keyboard, a switch, or a reader who wants an exact number
 * (`app/web/docs/ui-shell.md`, Small Screens).
 */
export function DocumentZoomSection({
  zoom,
}: {
  zoom: DocumentZoomRegistration;
}) {
  const percent = Math.round(zoom.scale * 100);
  return (
    <InspectorSection
      id="document-zoom"
      title="Zoom"
      icon={<Search size={13} />}
      summary={`${percent}%`}
    >
      <div className="flex items-center gap-2">
        <GhostIconButton
          label="Zoom out"
          onClick={zoom.decrease}
          disabled={!zoom.canDecrease}
          icon={<Minus size={16} />}
        />
        {/* The number is the state these controls change, so it is announced. */}
        <span
          aria-live="polite"
          className="min-w-12 text-center text-caption tabular-nums text-fg"
        >
          {percent}%
        </span>
        <GhostIconButton
          label="Zoom in"
          onClick={zoom.increase}
          disabled={!zoom.canIncrease}
          icon={<Plus size={16} />}
        />
        <button
          type="button"
          onClick={zoom.reset}
          disabled={zoom.scale === DOCUMENT_ZOOM_DEFAULT}
          aria-label="Reset zoom to 100%"
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-caption text-muted transition-colors hover:bg-panel hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RotateCcw size={13} /> Reset
        </button>
      </div>
    </InspectorSection>
  );
}

function findDocumentScroller(id: string): HTMLElement | null {
  const escaped = CSS.escape(id);
  return document.querySelector<HTMLElement>(
    `[data-document-scroll="${escaped}"], [data-document-scroll-root="${escaped}"] [data-document-scroll]`,
  );
}

/** Scope the zoom variables to the document scroller. */
export function useDocumentZoomBehavior(
  id: string,
  zoom: DocumentZoomRegistration | undefined,
): void {
  useLayoutEffect(() => {
    if (!zoom) return;
    let scroller: HTMLElement | null = null;
    let observer: MutationObserver | undefined;
    const apply = () => {
      const found = findDocumentScroller(id);
      if (!found) return false;
      scroller = found;
      found.dataset.documentZoomMode = zoom.mode;
      found.style.setProperty("--document-zoom", String(zoom.scale));
      return true;
    };
    if (!apply()) {
      observer = new MutationObserver(() => {
        if (apply()) observer?.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    return () => {
      observer?.disconnect();
      if (scroller) {
        delete scroller.dataset.documentZoomMode;
        scroller.style.removeProperty("--document-zoom");
      }
    };
  }, [id, zoom]);
}
