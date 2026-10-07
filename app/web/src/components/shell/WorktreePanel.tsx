import { useCallback, useEffect, useState } from "react";
import { SquareArrowOutUpRight } from "lucide-react";
import type {
  WorktreeComment,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import WorktreeDetailPage from "../worktree/WorktreeDetailPage.tsx";
import type { CommentActions } from "../diff/comments.tsx";
import type { CommentWatch } from "../../hooks/useCommentWatch.ts";
import { CommentActuationProvider } from "../review/CommentActuation.tsx";
import { EmptyBox, PaneLoading } from "../ui/load.tsx";
import type { Prefs } from "../../hooks/usePrefs.ts";
import {
  parseRoute,
  worktreePath,
  type WorktreeView,
} from "../../hooks/useSessionRouting.ts";
import { RoutePrimaryActionProvider } from "./RoutePrimaryAction.tsx";

/**
 * Where inside the worktree the panel is looking. The same four coordinates the
 * `/worktrees/:id` route carries in its URL, held as panel state instead: the
 * panel reads a worktree BESIDE whatever the main pane is on, so the URL keeps
 * naming the main pane's object.
 */
interface PanelLocation {
  view: WorktreeView;
  path?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

const PANEL_HOME: PanelLocation = { view: "changes" };

const NO_COMMENTS: WorktreeComment[] = [];

/**
 * @component WorktreePanel
 * @purpose Read the open session's worktree in the desktop right panel: its
 * diffs and its files, beside the chat that is writing them.
 * @useWhen Rendering the right panel's Worktree tab (`RightPanelTabs`).
 * @avoidWhen Rendering the `/worktrees/:id` route; that is the same page in the
 * main pane, which this panel links to rather than replaces.
 * @intent The SAME detail page as the route, in its own action scope and its
 * own navigation scope: links inside it move the panel, never the address bar,
 * and its comment and review controls belong to the worktree it shows and never
 * to the object the main pane is on. It follows the session rather than holding
 * a worktree of its own — the question it answers is "what has this agent
 * changed", so a different session brings a different worktree with it.
 */
export function WorktreePanel({
  worktree,
  worktreeId,
  worktreesLoaded,
  status,
  prefs,
  onUpdatePrefs,
  commentsByWorktreeId,
  commentWatch,
  commentActionsFor,
  onSubmitReview,
  onNavigate,
}: {
  /** The session's worktree, once the registry has it. */
  worktree?: WorktreeRecord | undefined;
  /** The session's `in_worktree` link: absent means this session has no worktree. */
  worktreeId?: string | undefined;
  /** The worktree registry has answered, so an unresolved id is really gone (R1). */
  worktreesLoaded: boolean;
  status?: WorktreeGitStatus | undefined;
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => void;
  commentsByWorktreeId: Record<string, WorktreeComment[]>;
  /** Refcounted with the worktree route, which may be reading the same one. */
  commentWatch: CommentWatch;
  /** Cached per worktree by the host: a literal here re-renders every diff. */
  commentActionsFor: (worktreeId: string) => CommentActions;
  /** Names the worktree: the host's sheet cannot read it off the route. */
  onSubmitReview: (worktreeId: string, commentIds: string[]) => void;
  /** Take a destination the panel does not own to the main pane. */
  onNavigate: (path: string) => void;
}) {
  const [location, setLocation] = useState<PanelLocation>(PANEL_HOME);
  // A different worktree is a different set of coordinates: a file path or a
  // commit range from the last one addresses nothing here.
  useEffect(() => setLocation(PANEL_HOME), [worktreeId]);

  /**
   * The page navigates by route path (`worktreePath`), which is how it moves
   * between its own views, files and diff scopes. Its own worktree's routes are
   * the panel's to absorb; anything else — another object, another worktree —
   * is a destination the panel does not own, so it goes to the pane that
   * addresses objects.
   */
  const navigate = useCallback(
    (path: string) => {
      const route = parseRoute(path);
      if (route.name !== "worktrees" || route.id !== worktreeId) {
        onNavigate(path);
        return;
      }
      setLocation({
        view: route.view ?? "changes",
        path: route.path,
        from: route.from,
        to: route.to,
      });
    },
    [onNavigate, worktreeId],
  );

  if (!worktreeId)
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-4">
        <EmptyBox>
          This session does not run in a worktree, so there is nothing to review
          here.
        </EmptyBox>
      </div>
    );
  if (!worktree)
    return worktreesLoaded ? (
      <div className="flex h-full min-h-0 items-center justify-center p-4">
        <EmptyBox>This session&rsquo;s worktree no longer exists.</EmptyBox>
      </div>
    ) : (
      <PaneLoading label="Opening worktree…" />
    );

  return (
    // Its own action scope, like the Knowledge panel's: the page publishes the
    // worktree's comment and review affordances into the header it draws here,
    // and the main pane's own surface keeps publishing for the page header over
    // there, so neither ends up wearing the other's controls.
    <RoutePrimaryActionProvider action={null}>
      <CommentActuationProvider>
        <WorktreeDetailPage
          // R3: the page addresses one worktree, so following the session to
          // another one mounts that worktree's own loading states rather than
          // leaving this one's diffs under a new branch name.
          key={worktree.id}
          worktree={worktree}
          status={status}
          // A right panel is a column of a phone's order of width: list→detail
          // instead of the rail, and unified diffs.
          narrow
          embedded
          headerActions={
            <button
              type="button"
              onClick={() =>
                onNavigate(
                  worktreePath(worktree.id, location.view, {
                    ...(location.path ? { path: location.path } : {}),
                    ...(location.from ? { from: location.from } : {}),
                    ...(location.to ? { to: location.to } : {}),
                  }),
                )
              }
              title="Open in Worktrees"
              aria-label="Open in Worktrees"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-panel hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
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
          comments={commentsByWorktreeId[worktree.id] ?? NO_COMMENTS}
          onLoadComments={() => commentWatch.list(worktree.id)}
          onUnloadComments={() => commentWatch.unwatch(worktree.id)}
          commentActions={commentActionsFor(worktree.id)}
          onSubmitReview={(commentIds) =>
            onSubmitReview(worktree.id, commentIds)
          }
        />
      </CommentActuationProvider>
    </RoutePrimaryActionProvider>
  );
}
