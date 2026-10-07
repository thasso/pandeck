import { useCallback, useEffect, useMemo, useState } from "react";
import { SquareArrowOutUpRight } from "lucide-react";
import type { WorktreeComment, WorktreeGitStatus } from "@assistant/shared";
import WorktreeDetailPage from "../worktree/WorktreeDetailPage.tsx";
import type { CommentActions } from "../diff/comments.tsx";
import type { Prefs } from "../../hooks/usePrefs.ts";
import {
  knowledgePath,
  parseRoute,
  worktreePath,
  type WorktreeView,
} from "../../hooks/useSessionRouting.ts";
import {
  knowledgeCheckoutRecord,
  knowledgeCommentDocument,
} from "../../lib/knowledgeCheckout.ts";
import { CommentActuationProvider } from "../review/CommentActuation.tsx";
import { RoutePrimaryActionProvider } from "./RoutePrimaryAction.tsx";

/** Where inside the Knowledge Base the panel is looking (the route's coordinates, as panel state). */
interface PanelLocation {
  view: WorktreeView;
  path?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

const PANEL_HOME: PanelLocation = { view: "files" };
const NO_COMMENTS: WorktreeComment[] = [];
// Never read: the page takes no line comments for the Knowledge Base.
const NO_COMMENT_ACTIONS = {} as CommentActions;
const noop = () => {};

/**
 * @component KnowledgePanel
 * @purpose Browse and read the Knowledge Base folder in the desktop right
 * panel, beside whatever the main pane is on.
 * @useWhen Rendering the right panel's Knowledge tab (`RightPanelTabs`).
 * @avoidWhen Rendering the `/knowledge` route; that is the same page in the
 * main pane, which this panel links to rather than replaces.
 * @intent The SAME worktree file page the route draws for the checkout
 * `knowledge`, in its own navigation scope: links inside the KB move the
 * panel, never the address bar, and anything else goes to the main pane.
 */
export function KnowledgePanel({
  status,
  prefs,
  onUpdatePrefs,
  openRequest,
  onNavigate,
}: {
  status?: WorktreeGitStatus | undefined;
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => void;
  /** A file a card asked the panel to show; a new nonce asks again. */
  openRequest?: { path: string; nonce: number } | null;
  /** Take a destination the panel does not own to the main pane. */
  onNavigate: (path: string) => void;
}) {
  const [location, setLocation] = useState<PanelLocation>(PANEL_HOME);
  const worktree = useMemo(() => knowledgeCheckoutRecord(status), [status]);
  const requestedPath = openRequest?.path;
  const requestNonce = openRequest?.nonce;
  useEffect(() => {
    if (requestedPath) setLocation({ view: "files", path: requestedPath });
  }, [requestedPath, requestNonce]);

  const navigate = useCallback(
    (path: string) => {
      const route = parseRoute(path);
      if (route.name !== "knowledge") {
        onNavigate(path);
        return;
      }
      setLocation({
        view: route.view ?? "files",
        path: route.path,
        from: route.from,
        to: route.to,
      });
    },
    [onNavigate],
  );

  return (
    // Its own comment and primary-action channels, so the header and its
    // comment tray speak for the file shown HERE, not the main pane's object.
    <CommentActuationProvider>
      <RoutePrimaryActionProvider action={null}>
        <WorktreeDetailPage
          worktree={worktree}
          status={status}
          title="Knowledge Base"
          lineComments={false}
          markdownPreviewFirst
          documentComments={knowledgeCommentDocument}
          narrow
          embedded
          headerActions={
            <button
              type="button"
              onClick={() =>
                onNavigate(
                  location.path || location.view !== "files"
                    ? worktreePath(worktree.id, location.view, {
                        ...(location.path ? { path: location.path } : {}),
                        ...(location.from ? { from: location.from } : {}),
                        ...(location.to ? { to: location.to } : {}),
                      })
                    : knowledgePath(),
                )
              }
              title="Open in Knowledge"
              aria-label="Open in Knowledge"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <SquareArrowOutUpRight size={16} />
            </button>
          }
          view={location.view}
          filePath={location.path}
          from={location.from}
          to={location.to}
          navigate={navigate}
          prefs={prefs}
          onUpdatePrefs={onUpdatePrefs}
          comments={NO_COMMENTS}
          onLoadComments={noop}
          onUnloadComments={noop}
          commentActions={NO_COMMENT_ACTIONS}
          onSubmitReview={noop}
        />
      </RoutePrimaryActionProvider>
    </CommentActuationProvider>
  );
}
