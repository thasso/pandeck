import { SquareArrowOutUpRight } from "lucide-react";
import type { PaObjectLinkResolution } from "@assistant/shared/objectLinks";
import { KnowledgeBrowser } from "../KnowledgeBrowser.tsx";
import { KnowledgePage } from "../KnowledgePage.tsx";
import { CommentActuationProvider } from "../review/CommentActuation.tsx";
import { RoutePrimaryActionProvider } from "./RoutePrimaryAction.tsx";

/**
 * @component KnowledgePanel
 * @purpose Read and review the Knowledge Base in the desktop right panel:
 * browse the compact KB tree, open an entry, and comment on it beside whatever
 * the main pane is showing.
 * @useWhen Rendering the right panel's Knowledge tab (`RightPanelTabs`).
 * @avoidWhen Rendering the Knowledge route; that is `KnowledgePage` in the main
 * pane, which this panel links to rather than replaces.
 * @intent The panel is the SAME document surface as the route — one loader, one
 * viewer, one comment tray — inside its own action scope, so its header's
 * comment controls belong to the entry it shows and never to the object the
 * main pane is on.
 */
export function KnowledgePanel({
  entryId,
  failure,
  onDismissFailure,
  onSelectEntry,
  onOpenInMain,
  onOpenFile,
  onOpenPaObject,
  changedAtByEntryId,
  changedAt,
}: {
  /** The entry the panel is reading, or null while it is browsing the tree. */
  entryId: string | null;
  /**
   * The failure the panel's entry is CARRYING (`docs/messaging.md`): a write
   * about it that no control here tracks. The panel is a reading surface for
   * the object, so it draws that note in place rather than leaving the app to
   * announce it from somewhere the entry is not.
   */
  failure?: string | undefined;
  onDismissFailure?: (() => void) | undefined;
  onSelectEntry: (entryId: string | null) => void;
  /** Hand the entry to the main pane's Knowledge route. */
  onOpenInMain: (entryId: string) => void;
  /**
   * A tree row that is not a readable entry — an asset, a loose file, an entry
   * whose frontmatter does not parse. The panel is a reading surface for
   * entries; everything else opens on its own Knowledge route in the main pane,
   * which has the width for a document viewer.
   */
  onOpenFile: (path: string) => void;
  onOpenPaObject?: ((link: PaObjectLinkResolution) => void) | undefined;
  changedAtByEntryId?: Record<string, number> | undefined;
  /** Newest committed KB change, so the tree re-reads its HTTP model. */
  changedAt?: number | undefined;
}) {
  if (!entryId) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto py-2">
        <KnowledgeBrowser
          onOpenEntry={onSelectEntry}
          onOpenInvalidEntry={onOpenFile}
          onOpenFile={onOpenFile}
          changedAt={changedAt}
        />
      </div>
    );
  }
  return (
    // Its own action scope: the viewer publishes the entry's comment
    // affordances and the route's own surface keeps publishing for the main
    // pane, so neither header ends up wearing the other's controls.
    <RoutePrimaryActionProvider action={null}>
      <CommentActuationProvider>
        <KnowledgePage
          entryId={entryId}
          failure={failure}
          onDismissFailure={onDismissFailure}
          back={{ label: "Knowledge", onClick: () => onSelectEntry(null) }}
          headerActions={
            <button
              type="button"
              onClick={() => onOpenInMain(entryId)}
              title="Open in Knowledge"
              aria-label="Open in Knowledge"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-panel hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <SquareArrowOutUpRight size={16} />
            </button>
          }
          onOpenPaObject={onOpenPaObject}
          changedAtByEntryId={changedAtByEntryId}
        />
      </CommentActuationProvider>
    </RoutePrimaryActionProvider>
  );
}
