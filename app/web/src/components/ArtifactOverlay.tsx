import { lazy, Suspense } from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "./common/IconButton.tsx";
import { PaneLoading } from "./common/load.tsx";

// The viewer pulls in the document renderers (Markdown, sandboxed HTML, PDF),
// so it loads with the first opening, not with the panel that lists artifacts.
const SessionArtifactViewer = lazy(() =>
  import("./SessionArtifactViewer.tsx").then((module) => ({
    default: module.SessionArtifactViewer,
  })),
);

/**
 * @component ArtifactOverlay
 * @purpose One session artifact, full screen over the app: the same
 *   `SessionArtifactViewer` the artifact route renders, in a dialog, so opening
 *   it from a list does not leave the page the list is on.
 * @useWhen A list of artifacts (the session inspector's Artifacts) opens one.
 * @intent ImageLightbox's surface (ui-shell.md band 100): Escape and the close
 *   button dismiss it, and every key it sees stays inside it.
 */
export function ArtifactOverlay({
  sessionId,
  path,
  label,
  onClose,
}: {
  sessionId: string;
  path: string;
  label: string;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        showCloseButton={false}
        aria-label={label}
        className="inset-0 z-100 flex h-[var(--app-viewport-height)] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 pt-[var(--app-safe-area-top)] pb-[var(--app-safe-area-bottom)] sm:max-w-none"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key !== "Escape") return;
          event.preventDefault();
          onClose();
        }}
      >
        <div className="flex min-h-11 items-center gap-2 border-b px-3">
          <DialogTitle className="min-w-0 flex-1 truncate">{label}</DialogTitle>
          <IconButton label="Close" size="icon" onClick={onClose}>
            <X />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1">
          <Suspense fallback={<PaneLoading label="Opening artifact…" />}>
            <SessionArtifactViewer sessionId={sessionId} path={path} />
          </Suspense>
        </div>
      </DialogContent>
    </Dialog>
  );
}
