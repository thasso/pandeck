import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Maximize2, Minimize2, X } from "lucide-react";
import { wrapTabWithin } from "./focusTrap.ts";

/** The viewer's own controls, in DOM order, for wrapping Tab inside it. */
const FOCUSABLE = "button, a[href]";

/**
 * @component ImageLightbox
 * @purpose Full-screen viewer for one image the app already serves — the enlarge
 * step behind an inline chat artifact or an artifact thumbnail.
 * @useWhen A reader needs to see an image at a size the inline surface cannot
 * give it, without leaving the page.
 * @avoidWhen The image is decorative or already legible in place; a card that
 * needs its own actions belongs in a dialog instead.
 * @intent A portaled full-screen takeover (ui-shell.md band 100) with Escape and
 * backdrop dismissal. It has two sizes and no zoom UI beyond them: FIT, which
 * bounds the image to the viewport, and ACTUAL, which shows it at natural
 * resolution inside a scroll container — the two answers a screenshot question
 * actually needs. `src` is used as given, so the caller owns origin and token.
 *
 * It takes focus and keeps it, exactly like `common/dialogs.tsx`, and for the same
 * two reasons. Keyboard: a viewer nobody can reach by Tab has no Fit, Open or
 * Close. Dismissal: Escape is READ INSIDE the surface and stopped there, so it
 * cannot also reach the document listener of whatever raised it — the mobile
 * `BottomCard` holds one while expanded, and a shared document listener here
 * would collapse that card on the way to closing this.
 */
export function ImageLightbox({
  src,
  alt,
  caption,
  onClose,
}: {
  src: string;
  alt: string;
  /** Shown in the title bar; falls back to `alt`. */
  caption?: string;
  onClose: () => void;
}) {
  const [actualSize, setActualSize] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);

  // Open with the viewer under the reader's hands — on the surface itself, not
  // on a control, since neither size nor close is the answer it is waiting for
  // — and hand focus back to whatever raised it when it closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // `preventScroll`: the surface is fixed and already covers the viewport, so
    // scrolling it into view could only move the transcript underneath it.
    surfaceRef.current?.focus({ preventScroll: true });
    return () => previous?.focus?.();
  }, []);

  return createPortal(
    <div
      ref={surfaceRef}
      // Focusable as a surface (never in the Tab order) so it can hold focus
      // and receive the keys below.
      tabIndex={-1}
      // A phone puts a notch over the top of a `fixed inset-0` surface and its
      // browser chrome over the bottom, so the header's close button and the
      // foot of the picture would both sit where nobody can reach them: the
      // surface keeps the shell's safe-area padding and the shell's own
      // viewport height (`index.css`), never a raw `100vh`.
      className="fixed inset-0 z-[100] flex h-[var(--app-viewport-height)] flex-col bg-black/80 pt-[var(--app-safe-area-top,0px)] pb-[var(--app-safe-area-bottom,0px)] outline-none backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={caption || alt || "Image"}
      onClick={onClose}
      // Every key the open viewer sees is its own: Escape closes, Tab cycles
      // its controls, and nothing reaches the surface behind it — the app-wide
      // shortcuts on `window` or a host's own Escape listener on `document`.
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        wrapTabWithin(event, surfaceRef.current, FOCUSABLE);
      }}
    >
      <div
        className="flex items-center gap-2 border-b border-white/10 px-3 py-2"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="min-w-0 flex-1 truncate text-caption text-white/80">
          {caption || alt}
        </span>
        <button
          type="button"
          onClick={() => setActualSize((value) => !value)}
          title={actualSize ? "Fit to window" : "Show at actual size"}
          aria-label={actualSize ? "Fit to window" : "Show at actual size"}
          aria-pressed={actualSize}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          {actualSize ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <a
          href={src}
          target="_blank"
          rel="noreferrer noopener"
          title="Open image in a new window"
          aria-label="Open image in a new window"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <ExternalLink size={16} />
        </a>
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close image viewer"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X size={16} />
        </button>
      </div>
      <div
        className={`min-h-0 flex-1 p-4 ${actualSize ? "overflow-auto" : "flex items-center justify-center overflow-hidden"}`}
      >
        {/* The image swallows its own clicks: a click on the picture toggles the
            two sizes, only a click on the surrounding backdrop dismisses. */}
        <img
          src={src}
          alt={alt}
          onClick={(event) => {
            event.stopPropagation();
            setActualSize((value) => !value);
          }}
          className={
            actualSize
              ? "max-w-none cursor-zoom-out"
              : "max-h-full max-w-full cursor-zoom-in object-contain"
          }
        />
      </div>
    </div>,
    document.body,
  );
}
