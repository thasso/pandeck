import { useState } from "react";
import { ExternalLink, Maximize2, Minimize2, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "./IconButton.tsx";
import { LinkButton } from "./LinkButton.tsx";

/**
 * @component ImageLightbox
 * @purpose Full-screen viewer for one image the app already serves — the enlarge
 * step behind an inline chat artifact or an artifact thumbnail.
 * @useWhen A reader needs to see an image at a size the inline surface cannot
 * give it, without leaving the page.
 * @avoidWhen The image is decorative or already legible in place; a card that
 * needs its own actions belongs in a dialog instead.
 * @intent A full-screen `Dialog` (ui-shell.md band 100) with Escape and
 * backdrop dismissal. It has two sizes and no zoom UI beyond them: FIT, which
 * bounds the image to the viewport, and ACTUAL, which shows it at natural
 * resolution inside a scroll container — the two answers a screenshot question
 * actually needs. `src` is used as given, so the caller owns origin and token.
 *
 * The dialog holds focus and hands it back. Escape is READ INSIDE the surface
 * and stopped there, so it cannot also reach the document listener of whatever
 * raised it — the mobile `BottomCard` holds one while expanded, and would
 * collapse on the way to closing this.
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
  const label = actualSize ? "Fit to window" : "Show at actual size";

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        showCloseButton={false}
        aria-label={caption || alt || "Image"}
        // A phone puts a notch over the top of a full-screen surface and its
        // browser chrome over the bottom, so the surface keeps the shell's
        // safe-area padding and viewport height (`index.css`), never `100vh`.
        className="inset-0 z-100 flex h-[var(--app-viewport-height)] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 pt-[var(--app-safe-area-top)] pb-[var(--app-safe-area-bottom)] sm:max-w-none"
        // Every key the open viewer sees is its own: nothing reaches the
        // app-wide shortcuts on `window` or a host's Escape on `document`.
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key !== "Escape") return;
          event.preventDefault();
          onClose();
        }}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <DialogTitle className="min-w-0 flex-1 truncate">
            {caption || alt}
          </DialogTitle>
          <IconButton
            label={label}
            size="icon"
            aria-pressed={actualSize}
            onClick={() => setActualSize((value) => !value)}
          >
            {actualSize ? <Minimize2 /> : <Maximize2 />}
          </IconButton>
          <LinkButton
            href={src}
            target="_blank"
            rel="noreferrer noopener"
            label="Open image in a new window"
            variant="ghost"
            size="icon"
          >
            <ExternalLink />
          </LinkButton>
          <IconButton label="Close image viewer" size="icon" onClick={onClose}>
            <X />
          </IconButton>
        </div>
        {/* The image swallows its own clicks: a click on the picture toggles the
            two sizes, only a click on the space around it dismisses. */}
        <div
          onClick={onClose}
          className={`min-h-0 flex-1 p-4 ${actualSize ? "overflow-auto" : "flex items-center justify-center overflow-hidden"}`}
        >
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
      </DialogContent>
    </Dialog>
  );
}
