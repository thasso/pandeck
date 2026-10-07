/**
 * @component WorktreeDetailPage
 * @purpose Detail view for a git worktree: Review (scope-picked diffs with
 * commit/range selection) and Files (gitignore-aware browser + file viewer
 * with per-file diff pivots).
 * @useWhen The route is /worktrees/:id (any view), or the right panel's
 * Worktree tab is showing the open session's worktree (`embedded`).
 * @avoidWhen Rendering worktree rows in the sidebar (WorktreeBrowser) or the
 * inspector (objectInspectors).
 * @intent Lazy route page — the only static importer of the @pierre/diffs
 * stack (components/diff/), keeping pierre out of the main chunk. Deep links
 * carry view/path/from/to; data loads via lib/worktrees.ts REST helpers and
 * refreshes when `refreshToken` (worktree status updatedAt) changes.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronLeft,
  Download,
  ExternalLink,
  Eye,
  File,
  FolderTree,
  GitBranch,
  GitCompareArrows,
  History,
  List,
  PanelLeftClose,
  PanelLeftOpen,
  SlidersHorizontal,
} from "lucide-react";
import {
  documentTargetHref,
  type DocumentLineAnchor,
} from "@assistant/shared/documentTargets";
import type {
  WorktreeChangeFile,
  WorktreeChangesResponse,
  WorktreeComment,
  WorktreeDiffScope,
  WorktreeFileDiffResponse,
  WorktreeFileResponse,
  WorktreeGitStatus,
  WorktreeRecord,
  WorktreeTreeEntry,
} from "@assistant/shared";
import { PageHeader, type PageHeaderBack } from "../PageHeader.tsx";
import {
  DocumentNavigationActions,
  DocumentNavigationMarker,
  useDocumentScrollRestoration,
} from "../DocumentNavigationShell.tsx";
import { Popover } from "../Popover.tsx";
import { useMobileLayout } from "../shell/useMobileLayout.ts";
import { DiffModeToolbar } from "../diff/DiffModeToolbar.tsx";
import { DiffSurface } from "../diff/DiffSurface.tsx";
import { DiffWorkerProvider } from "../diff/DiffWorkerProvider.tsx";
import { FileSurface } from "../diff/FileSurface.tsx";
import { SandboxedDocument } from "../SandboxedDocument.tsx";
import {
  previewKindForPath,
  worktreeZoomMode,
  type FilePivot,
  type PreviewKind,
} from "./previewZoom.ts";
import {
  DiffCommentBarProvider,
  type CommentActions,
  type LineCommentsConfig,
} from "../diff/comments.tsx";
import { WorktreeChangesetList } from "./WorktreeChangesetList.tsx";
import { pendingWorktreeReviewIds } from "./worktreeReview.tsx";
import { WorktreeScopePicker } from "./WorktreeScopePicker.tsx";
import { useViewedFiles } from "./useViewedFiles.ts";
import { EdgeSheet } from "../ui/EdgeSheet.tsx";
import { ErrorNote, PaneLoading, RefreshIndicator } from "../ui/load.tsx";
import {
  externalDocumentActionEnabled,
  runExternalDocumentAction,
} from "../../lib/documentActions.ts";
import { FileHistoryList } from "./FileHistoryList.tsx";
import { DocumentCommentLayer } from "../DocumentComments.tsx";
import { DocumentTextBody } from "../DocumentTextBody.tsx";
import type { CommentDocument } from "../../lib/chatCommentPrompt.ts";
import type { DocumentLineSource } from "../../lib/documentCommentAnchor.ts";
import { useFetchState, useReloadOnToken } from "../../hooks/useFetchState.ts";
import { dataOf, errorOf, isInitialLoad } from "../../lib/loadState.ts";
import {
  fetchWorktreeChanges,
  fetchWorktreeFile,
  fetchWorktreeFileDiff,
  fetchWorktreeStatus,
  fetchWorktreeTree,
  hashContent,
  worktreeFileRawUrl,
} from "../../lib/worktrees.ts";
import type { Prefs } from "../../hooks/usePrefs.ts";
import {
  worktreePath,
  type WorktreeView,
} from "../../hooks/useSessionRouting.ts";
import { copyWithToast } from "../../lib/clipboard.ts";
import {
  ResizableSeparator,
  useResizeDrag,
} from "../ui/ResizableSeparator.tsx";
import {
  WorktreeFileNavigator,
  ancestorDirectoryPaths,
  buildChangeNavigatorEntries,
  buildLoadedTreeNavigatorEntries,
  directoryPathsFromNavigatorEntries,
  pruneVanishedTreeDirs,
  type WorktreeNavigatorViewMode,
} from "./WorktreeFileNavigator.tsx";

export interface WorktreeDetailPageProps {
  worktree: WorktreeRecord;
  /** Mobile screen back control (ui-shell.md, Small Screens). */
  back?: PageHeaderBack | undefined;
  /** Latest pushed status, if any (the page also fetches on mount). */
  status?: WorktreeGitStatus | undefined;
  /**
   * Compact single-column layout: list→detail navigation instead of the rail,
   * unified diffs forced. True on a phone AND in the right side panel, which is
   * a column of the same order of width (shell/WorktreePanel.tsx).
   */
  narrow: boolean;
  view: WorktreeView;
  filePath?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  anchor?: DocumentLineAnchor | undefined;
  navigate: (path: string) => void;
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => void;
  /** Review comments for this worktree (server-synced). */
  comments: WorktreeComment[];
  onLoadComments: () => void;
  onUnloadComments: () => void;
  commentActions: CommentActions;
  onSubmitReview: (commentIds: string[]) => void;
  /**
   * Rendered beside the route in the right side panel instead of AS the page
   * the URL addresses (shell/WorktreePanel.tsx). The shell's document
   * navigation — the history arrows, zoom and close that act on the addressed
   * document — and its per-history-entry scroll restoration belong to that
   * page, so a panel copy neither publishes nor restores them; it brings its
   * own `headerActions` instead.
   */
  embedded?: boolean;
  /** Identity-row actions replacing the document controls (the panel's own). */
  headerActions?: ReactNode;
  /**
   * A comment the object panel's roster asked us to land on. The roster lives in
   * the panel now, so following a row crosses panes: the token arrives here,
   * where the comments (and therefore each one's current file) are known.
   */
  openComment?: { commentId: string; nonce: number } | undefined;
  /** Header title instead of the branch name (the Knowledge Base's own name). */
  title?: string | undefined;
  /**
   * Whether lines take review comments. A checkout with no comment store — the
   * Knowledge Base — reads its files without them.
   */
  lineComments?: boolean;
  /**
   * Open a Markdown file on its rendered Preview instead of its source: a
   * folder of notes (the Knowledge Base) is read more than it is reviewed. A
   * line anchor still opens the source, where the line is.
   */
  markdownPreviewFirst?: boolean;
  /**
   * Comment on files the way any document is commented on — a passage or the
   * whole file, collected in its browser-local tray and sent to a session
   * (`docs/comments.md`) — naming each file by the document this returns. For
   * a checkout without review comments (the Knowledge Base). A file's text
   * then renders as the shared document text body, which a passage can be
   * selected in. Keep the function's identity stable.
   */
  documentComments?: ((path: string) => CommentDocument) | undefined;
}

function scopeFromRoute(from?: string, to?: string): WorktreeDiffScope {
  return from
    ? { kind: "range", from, ...(to ? { to } : {}) }
    : { kind: "workingTree" };
}

function scopeCacheKey(scope: WorktreeDiffScope): string {
  return scope.kind === "workingTree"
    ? "workingTree"
    : `range:${scope.from}:${scope.to ?? ""}`;
}

/**
 * The server's answer for "this path has no diff in that scope" — an empty
 * result dressed as a failure, and the EVERYDAY case for the Files view's
 * "Changes vs base" pivot on an untouched file, or for a file that stops being
 * changed while you look at it (live edits). It reads as a fact, not as a
 * failure, so it never gets the danger-toned `ErrorNote`.
 */
function isUnchangedPathError(error: string | undefined): boolean {
  return error !== undefined && error.includes("not changed in this scope");
}

const WORKTREE_RAIL_MIN_WIDTH = 220;
const WORKTREE_RAIL_MAX_WIDTH = 460;

function clampWorktreeRailWidth(width: number): number {
  return Math.min(
    WORKTREE_RAIL_MAX_WIDTH,
    Math.max(WORKTREE_RAIL_MIN_WIDTH, Math.round(width)),
  );
}

function splitWorktreePath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/");
  if (index < 0) return { dir: "", name: path };
  return { dir: path.slice(0, index), name: path.slice(index + 1) };
}

// Keep list mode wired while the product exposes one navigator shape. Flipping
// this restores the existing preference and control without rebuilding the
// browser behavior.
const NAVIGATOR_VIEW_SWITCH_ENABLED = false;

function navigatorViewMode(prefs: Prefs): WorktreeNavigatorViewMode {
  return NAVIGATOR_VIEW_SWITCH_ENABLED
    ? prefs.worktreeNavigatorViewMode
    : "tree";
}

function NavigatorViewToggle({
  mode,
  onChange,
}: {
  mode: WorktreeNavigatorViewMode;
  onChange: (mode: WorktreeNavigatorViewMode) => void;
}) {
  return (
    <div
      className="flex items-center rounded-lg border border-line bg-panel/40 p-0.5"
      aria-label="Navigator view"
    >
      {(
        [
          { id: "list", label: "Folder list", icon: <List size={13} /> },
          { id: "tree", label: "Tree", icon: <FolderTree size={13} /> },
        ] as const
      ).map((option) => (
        <button
          key={option.id}
          type="button"
          title={option.label}
          aria-label={option.label}
          aria-pressed={mode === option.id}
          onClick={() => onChange(option.id)}
          className={`rounded-md p-1 ${mode === option.id ? "bg-raised text-fg" : "text-faint hover:bg-raised hover:text-fg"}`}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}

function NavigatorVisibilityToggle({
  collapsed,
  onChange,
}: {
  collapsed: boolean;
  onChange: (collapsed: boolean) => void;
}) {
  const label = collapsed ? "Show navigator" : "Collapse navigator";
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={() => onChange(!collapsed)}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-raised hover:text-fg"
    >
      {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
    </button>
  );
}

function WorktreeRailLayout({
  title,
  subtitle,
  collapsedSummary,
  detailControls,
  prefs,
  onUpdatePrefs,
  children,
  rail,
  narrow,
  narrowListHeader = true,
  detailActive = false,
  onBack,
}: {
  title: string;
  subtitle?: ReactNode;
  collapsedSummary?: ReactNode;
  /** Narrow-layout detail-only controls sharing the compact back/title row. */
  detailControls?: ReactNode;
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => void;
  children: ReactNode;
  rail: ReactNode;
  narrow: boolean;
  /** Narrow list screen: render the navigator's own title/controls header. */
  narrowListHeader?: boolean;
  /** Narrow: a detail is selected, so the content pane replaces the list. */
  detailActive?: boolean;
  /** Narrow: return from the detail pane to the list. */
  onBack?: () => void;
}) {
  const railCollapsed = prefs.worktreeChangesRailCollapsed;
  const railWidth = clampWorktreeRailWidth(prefs.worktreeChangesRailWidth);
  const paneRef = useRef<HTMLDivElement>(null);
  const railResize = useResizeDrag({
    onResize: useCallback(
      (clientX: number) => {
        const left = paneRef.current?.getBoundingClientRect().left ?? 0;
        onUpdatePrefs({
          worktreeChangesRailWidth: clampWorktreeRailWidth(clientX - left),
        });
      },
      [onUpdatePrefs],
    ),
  });

  const resizeRailWithKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 40 : 16;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onUpdatePrefs({
          worktreeChangesRailWidth: clampWorktreeRailWidth(railWidth - step),
        });
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onUpdatePrefs({
          worktreeChangesRailWidth: clampWorktreeRailWidth(railWidth + step),
        });
      } else if (event.key === "Home") {
        event.preventDefault();
        onUpdatePrefs({ worktreeChangesRailWidth: WORKTREE_RAIL_MIN_WIDTH });
      } else if (event.key === "End") {
        event.preventDefault();
        onUpdatePrefs({ worktreeChangesRailWidth: WORKTREE_RAIL_MAX_WIDTH });
      }
    },
    [onUpdatePrefs, railWidth],
  );

  // Mobile is list→detail: the navigator IS the screen until a detail is
  // selected, then the content pane replaces it behind a back bar. The rail
  // collapse/width prefs are desktop concepts and don't apply.
  if (narrow) {
    if (!detailActive) {
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-surface/40">
          {narrowListHeader ? (
            <div className="border-b border-line p-2">
              <div className="mb-2 min-w-0">
                <div className="truncate text-caption font-semibold uppercase tracking-wide text-faint">
                  {title}
                </div>
                {subtitle ? (
                  <div className="min-w-0 truncate font-mono text-micro text-faint">
                    {subtitle}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{rail}</div>
        </div>
      );
    }
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel">
        <div className="flex items-center gap-2 border-b border-line bg-surface/40 py-1.5 pl-1 pr-3 text-caption text-muted-foreground">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              title={`Back to ${title.toLowerCase()}`}
              aria-label={`Back to ${title.toLowerCase()}`}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-faint hover:bg-raised hover:text-fg"
            >
              <ChevronLeft size={16} />
            </button>
          ) : null}
          {collapsedSummary ?? (
            <span className="min-w-0 flex-1 truncate font-medium text-fg">
              {title}
            </span>
          )}
          {detailControls ? (
            <div className="shrink-0">{detailControls}</div>
          ) : null}
        </div>
        {children}
      </div>
    );
  }

  return (
    <div ref={paneRef} className="flex min-h-0 flex-1">
      {!railCollapsed ? (
        <div
          className="relative flex shrink-0 flex-col border-r border-line bg-surface/40"
          style={{ width: railWidth }}
        >
          <div className="border-b border-line px-2 py-1.5">
            <div className="truncate text-caption font-semibold uppercase tracking-wide text-faint">
              {title}
            </div>
            {subtitle ? (
              <div className="min-w-0 truncate font-mono text-micro text-faint">
                {subtitle}
              </div>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{rail}</div>
          <ResizableSeparator
            edge="right"
            label="worktree navigator"
            min={WORKTREE_RAIL_MIN_WIDTH}
            max={WORKTREE_RAIL_MAX_WIDTH}
            value={railWidth}
            resizing={railResize.resizing}
            onPointerDown={railResize.onPointerDown}
            onKeyDown={resizeRailWithKeyboard}
          />
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel">
        {railCollapsed && collapsedSummary ? (
          <div className="flex items-center gap-2 border-b border-line bg-surface/40 px-3 py-2 text-caption text-muted-foreground">
            {collapsedSummary}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/* --------------------------------- changes --------------------------------- */

type ReviewMode = "by-file" | "changeset";

/** One identity for "no changed files yet" (see `changeFiles` below). */
const NO_CHANGE_FILES: WorktreeChangeFile[] = [];

function ChangesView({
  worktree,
  narrow,
  filePath,
  from,
  to,
  anchor,
  navigate,
  prefs,
  onUpdatePrefs,
  refreshToken,
  navigationControls,
  viewOptionsControl,
  commentsConfigFor,
}: {
  worktree: WorktreeRecord;
  narrow: boolean;
  filePath?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  anchor?: DocumentLineAnchor | undefined;
  navigate: (path: string) => void;
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => void;
  refreshToken: number;
  navigationControls: ReactNode;
  viewOptionsControl: ReactNode;
  /** Comment config for a file; `current` = the shown new side is working-tree content, else `refOid` names its commit. */
  commentsConfigFor: (
    path: string,
    current: boolean,
    refOid?: string,
  ) => LineCommentsConfig | undefined;
}) {
  const scope = useMemo(() => scopeFromRoute(from, to), [from, to]);
  const reviewMode: ReviewMode =
    prefs.worktreeReviewMode ?? (narrow ? "changeset" : "by-file");
  const [expandedChangeDirs, setExpandedChangeDirs] = useState<string[]>([]);

  // The worktree AND the scope are the fetch key, which is what makes trusting
  // `changes` structural (R3): a switch of either drops the previous answer
  // during render, so nothing can select or diff a file off a list that belongs
  // to another scope (which used to request a path this scope has no diff for —
  // a spurious 400).
  const changesKey = `${worktree.id}:${scopeCacheKey(scope)}`;
  const loadChanges = useCallback(
    () => fetchWorktreeChanges(worktree.id, scope),
    [worktree.id, scope],
  );
  const changesFetch = useFetchState<WorktreeChangesResponse>(
    changesKey,
    loadChanges,
  );
  // A watcher push is an invalidation of the SAME list, so the changed files
  // stay on screen while it refetches (R2).
  useReloadOnToken(changesKey, refreshToken, changesFetch.reload);
  const changes = dataOf(changesFetch.state);
  const changesError = errorOf(changesFetch.state);
  const changesReady = changes !== undefined;
  // A SHARED empty array while the list is unanswered: a fresh `[]` per render
  // re-derives the navigator entries, whose effect then rewrites the expanded
  // directories, which renders again — a render loop that spun for as long as
  // the fetch took.
  const changeFiles = changes?.files ?? NO_CHANGE_FILES;
  const changeEntries = useMemo(
    () => buildChangeNavigatorEntries(changeFiles),
    [changeFiles],
  );
  // A wide pane auto-shows the first changed file next to the list; a narrow
  // one shows the list alone until the user picks a file (list→detail).
  const selectedPath = filePath ?? (narrow ? undefined : changeFiles[0]?.path);
  const selectedFileKnown = Boolean(
    selectedPath &&
    changeFiles.some(
      (file) => file.path === selectedPath || file.oldPath === selectedPath,
    ),
  );
  // The selected FILE is part of the key too, so switching files shows the new
  // path's placeholder instead of the previous file's diff (R3); a null key
  // parks the fetch while the list is still arriving or the file is unknown to
  // this scope.
  const fileDiffKey =
    reviewMode === "by-file" &&
    selectedPath &&
    changesReady &&
    selectedFileKnown
      ? `${worktree.id}:${selectedPath}:${scopeCacheKey(scope)}`
      : null;
  const loadFileDiff = useCallback(
    () =>
      selectedPath
        ? fetchWorktreeFileDiff(worktree.id, selectedPath, scope)
        : Promise.reject(new Error("No file selected.")),
    [worktree.id, selectedPath, scope],
  );
  const fileDiffFetch = useFetchState<WorktreeFileDiffResponse>(
    fileDiffKey,
    loadFileDiff,
  );
  useReloadOnToken(fileDiffKey, refreshToken, fileDiffFetch.reload);
  const fileDiff = dataOf(fileDiffFetch.state);
  const fileDiffError = errorOf(fileDiffFetch.state);

  useEffect(() => {
    setExpandedChangeDirs(directoryPathsFromNavigatorEntries(changeEntries));
  }, [changeEntries]);

  // Diff-derived cache key, memoized on the patch CONTENT rather than on the
  // payload object: a refetch that answers with the same bytes hands pierre the
  // same key, so an unchanged diff is never rehashed or remounted.
  const fileDiffPath = fileDiff?.path;
  const fileDiffText = fileDiff?.diff;
  const diffCacheKey = useMemo(
    () =>
      fileDiffPath !== undefined && fileDiffText !== undefined
        ? `${worktree.id}:${fileDiffPath}:${hashContent(fileDiffText)}`
        : "",
    [worktree.id, fileDiffPath, fileDiffText],
  );
  const navigatorMode = navigatorViewMode(prefs);
  const setNavigatorMode = useCallback(
    (mode: WorktreeNavigatorViewMode) =>
      onUpdatePrefs({ worktreeNavigatorViewMode: mode }),
    [onUpdatePrefs],
  );

  // Changeset mode: viewed tracking + jump-to-file section registry.
  const { viewedPaths, toggleViewed } = useViewedFiles(
    worktree.id,
    scopeCacheKey(scope),
  );
  const sectionsRef = useRef(new Map<string, HTMLElement>());
  const registerSection = useCallback(
    (path: string, el: HTMLElement | null) => {
      if (el) sectionsRef.current.set(path, el);
      else sectionsRef.current.delete(path);
    },
    [],
  );
  const jumpToFile = useCallback((path: string) => {
    sectionsRef.current
      .get(path)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  const [jumpSheetOpen, setJumpSheetOpen] = useState(false);
  // The changeset stacks every file in one scroller, so a narrow layout needs a
  // way to jump. WHERE that list opens is a phone question, not a width one: a
  // viewport-wide sheet over the whole app is wrong from a side panel, which is
  // beside the thing the reader is comparing against.
  const phone = useMobileLayout();

  // Nothing to keep yet: a first load draws the placeholder, and only a first
  // load's failure takes the pane (a refresh keeps the list, below).
  if (changes === undefined)
    return changesError === undefined ? (
      <PaneLoading label="Loading changes…" />
    ) : (
      <ErrorNote
        className="m-4"
        message={`Could not load the changes: ${changesError}`}
        onRetry={changesFetch.reload}
      />
    );

  const selectedParts = selectedPath ? splitWorktreePath(selectedPath) : null;
  const totalsSummary = (
    <>
      {changes.totals.files} file
      {changes.totals.files === 1 ? "" : "s"} ·{" "}
      <span className="text-emerald-400">+{changes.totals.additions}</span>{" "}
      <span className="text-red-400">−{changes.totals.deletions}</span>
      {changesFetch.state.status === "refreshing" ? (
        <RefreshIndicator className="ml-1.5" label="Refreshing changed files" />
      ) : null}
    </>
  );
  // R2: a refresh that failed keeps the changed files it already has and says so
  // above them.
  const changesRefreshNote =
    changesError === undefined ? null : (
      <ErrorNote
        className="mx-3 mt-2 shrink-0"
        message={`Could not refresh the changes: ${changesError}`}
        onRetry={changesFetch.reload}
      />
    );

  /** The changeset's jump list, in whichever surface this layout opens it in. */
  const jumpNavigator = (close: () => void) => (
    <WorktreeFileNavigator
      entries={changeEntries}
      expandedDirectoryPaths={expandedChangeDirs}
      onExpandedDirectoryPathsChange={setExpandedChangeDirs}
      onSelectFile={(entry) => {
        close();
        // Let the surface unmount first, then scroll the section into view.
        requestAnimationFrame(() => jumpToFile(entry.path));
      }}
      emptyLabel="No changes in this scope."
      showChangeStats
      ariaLabel="Changed files"
      viewMode={navigatorMode}
    />
  );

  const toolbar = (
    // Two kinds of thing only: WHERE you are (the tabs) and WHAT you are looking at
    // (the scope). How it is rendered lives in the view-options popover, which is
    // why this row survives a 390px viewport with words instead of six glyphs.
    <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5">
      {navigationControls}
      <span className="mx-1 h-4 w-px shrink-0 bg-line" aria-hidden="true" />
      <WorktreeScopePicker
        worktree={worktree}
        narrow={narrow}
        refreshToken={refreshToken}
        from={from}
        to={to}
        onPick={(pickedFrom, pickedTo) =>
          navigate(
            worktreePath(worktree.id, "changes", {
              ...(pickedFrom ? { from: pickedFrom } : {}),
              ...(pickedTo ? { to: pickedTo } : {}),
              ...(filePath ? { path: filePath } : {}),
            }),
          )
        }
      />
      <div className="ml-auto flex shrink-0 items-center gap-1 pl-1">
        {/* R2: the shown diff is being refetched — on a watcher push, and above
            all on a Retry, where the error note disappears and this is the only
            sign that something is running. The rail's subtitle marks the FILE
            LIST's own refresh, which is a different request. */}
        {fileDiffFetch.state.status === "refreshing" ? (
          <RefreshIndicator label="Refreshing this diff" />
        ) : null}
        {narrow && reviewMode === "changeset" && changeFiles.length > 0 ? (
          phone ? (
            <button
              type="button"
              title="Jump to file"
              aria-label="Jump to file"
              onClick={() => setJumpSheetOpen(true)}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-fg"
            >
              <FolderTree size={14} />
            </button>
          ) : (
            <Popover
              align="right"
              placement="bottom"
              title="Jump to file"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-fg data-[open=true]:bg-raised data-[open=true]:text-fg"
              button={<FolderTree size={14} />}
            >
              {(close) => (
                <div className="max-h-[60vh] w-[19rem] max-w-[80vw] overflow-y-auto">
                  {jumpNavigator(close)}
                </div>
              )}
            </Popover>
          )
        ) : null}
        {NAVIGATOR_VIEW_SWITCH_ENABLED ? (
          <NavigatorViewToggle
            mode={navigatorMode}
            onChange={setNavigatorMode}
          />
        ) : null}
        {!narrow ? (
          <NavigatorVisibilityToggle
            collapsed={prefs.worktreeChangesRailCollapsed}
            onChange={(collapsed) =>
              onUpdatePrefs({ worktreeChangesRailCollapsed: collapsed })
            }
          />
        ) : null}
        {viewOptionsControl}
      </div>
    </div>
  );

  if (reviewMode === "changeset") {
    const changesetContent = (
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <WorktreeChangesetList
          worktreeId={worktree.id}
          scope={scope}
          files={changeFiles}
          prefs={prefs}
          refreshToken={refreshToken}
          commentsConfigFor={commentsConfigFor}
          viewedPaths={viewedPaths}
          onToggleViewed={toggleViewed}
          registerSection={registerSection}
        />
      </div>
    );
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {toolbar}
        {changesRefreshNote}
        {narrow ? (
          changesetContent
        ) : (
          <WorktreeRailLayout
            title="Changed files"
            subtitle={totalsSummary}
            collapsedSummary={
              <span className="font-medium text-fg">All files</span>
            }
            prefs={prefs}
            onUpdatePrefs={onUpdatePrefs}
            narrow={false}
            rail={
              <WorktreeFileNavigator
                entries={changeEntries}
                expandedDirectoryPaths={expandedChangeDirs}
                onExpandedDirectoryPathsChange={setExpandedChangeDirs}
                onSelectFile={(entry) => jumpToFile(entry.path)}
                emptyLabel="No changes in this scope."
                showChangeStats
                ariaLabel="Changed files"
                viewMode={navigatorMode}
              />
            }
          >
            {changesetContent}
          </WorktreeRailLayout>
        )}
        {phone ? (
          <EdgeSheet
            open={jumpSheetOpen}
            title="Jump to file"
            onClose={() => setJumpSheetOpen(false)}
          >
            {jumpNavigator(() => setJumpSheetOpen(false))}
          </EdgeSheet>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toolbar}
      {changesRefreshNote}
      <WorktreeRailLayout
        title="Changed files"
        subtitle={totalsSummary}
        collapsedSummary={
          selectedParts ? (
            <>
              <span className="font-medium text-fg">{selectedParts.name}</span>
              {selectedParts.dir ? (
                <span className="min-w-0 truncate font-mono text-caption text-faint">
                  {selectedParts.dir}
                </span>
              ) : null}
              <span className="ml-auto shrink-0 font-mono text-micro text-faint">
                {totalsSummary}
              </span>
            </>
          ) : undefined
        }
        prefs={prefs}
        onUpdatePrefs={onUpdatePrefs}
        narrow={narrow}
        detailActive={Boolean(filePath)}
        {...(!filePath
          ? { onBack: () => navigate(worktreePath(worktree.id, "changes")) }
          : {})}
        rail={
          <WorktreeFileNavigator
            entries={changeEntries}
            selectedPath={selectedPath}
            expandedDirectoryPaths={expandedChangeDirs}
            onExpandedDirectoryPathsChange={setExpandedChangeDirs}
            onSelectFile={(entry) =>
              navigate(
                worktreePath(worktree.id, "changes", {
                  path: entry.path,
                  ...(from !== undefined ? { from } : {}),
                  ...(to !== undefined ? { to } : {}),
                }),
              )
            }
            emptyLabel="No changes in this scope."
            showChangeStats
            ariaLabel="Changed files"
            viewMode={navigatorMode}
          />
        }
      >
        <div
          data-document-scroll={
            filePath
              ? documentTargetHref({
                  kind: "worktreeFile",
                  worktreeId: worktree.id,
                  path: filePath,
                  view: "diff",
                  ...(anchor ? { anchor } : {}),
                })
              : undefined
          }
          className="min-h-0 min-w-0 flex-1 overflow-auto"
        >
          {fileDiff ? (
            fileDiff.binary ? (
              <div className="p-6 text-body text-muted-foreground">
                Binary files cannot be diffed.
              </div>
            ) : (
              // The frame is UNCONDITIONAL: making it appear with the note would
              // change the element type at the surface's position and remount
              // the diff — losing the scroll position and any open draft at
              // exactly the moment R2 exists to protect them.
              <div className="flex flex-col">
                {fileDiffError !== undefined &&
                !isUnchangedPathError(fileDiffError) ? (
                  <ErrorNote
                    className="m-3"
                    message={`Could not refresh this diff: ${fileDiffError}`}
                    onRetry={fileDiffFetch.reload}
                  />
                ) : null}
                <DiffSurface
                  prefs={prefs}
                  patch={fileDiff.diff}
                  oldFile={{
                    name: fileDiff.oldPath ?? fileDiff.path,
                    contents: fileDiff.oldContent,
                  }}
                  newFile={{
                    name: fileDiff.path,
                    contents: fileDiff.newContent,
                  }}
                  cacheKey={diffCacheKey}
                  lineAnchor={anchor}
                  comments={commentsConfigFor(
                    fileDiff.path,
                    scope.kind === "workingTree" ? true : !scope.to,
                    fileDiff.newOid,
                  )}
                />
              </div>
            )
          ) : isInitialLoad(fileDiffFetch.state) ? (
            <PaneLoading label="Loading diff…" />
          ) : fileDiffError !== undefined ? (
            isUnchangedPathError(fileDiffError) ? (
              <div className="p-6 text-body text-muted-foreground">
                This file is no longer changed in this scope.
              </div>
            ) : (
              <ErrorNote
                className="m-4"
                message={`Could not load this diff: ${fileDiffError}`}
                onRetry={fileDiffFetch.reload}
              />
            )
          ) : (
            <div className="p-6 text-body text-muted-foreground">
              No changed file selected.
            </div>
          )}
        </div>
      </WorktreeRailLayout>
    </div>
  );
}

/* ---------------------------------- files ---------------------------------- */

// Markdown is its own heavy chunk; load it only when a preview is opened.
const MarkdownFileLazy = lazy(() =>
  import("../MarkdownFile.tsx").then((module) => ({
    default: module.MarkdownFile,
  })),
);

function FilePreview({
  kind,
  worktreeId,
  path,
  content,
  textRootRef,
}: {
  kind: PreviewKind;
  worktreeId: string;
  path: string;
  content?: string | undefined;
  /** The rendered Markdown a passage comment is selected in, when comments are on. */
  textRootRef?: ((node: HTMLDivElement | null) => void) | undefined;
}) {
  const rawUrl = worktreeFileRawUrl(worktreeId, path);
  if (kind === "markdown") {
    if (content === undefined) return <PaneLoading label="Loading preview…" />;
    return (
      <div className="mx-auto w-full max-w-3xl p-4">
        <Suspense fallback={<PaneLoading label="Loading preview…" />}>
          <div ref={textRootRef}>
            <MarkdownFileLazy
              text={content}
              documentTarget={{
                kind: "worktreeFile",
                worktreeId,
                path,
                view: "file",
              }}
              // What names a passage comment's source lines.
              sourcePositions={textRootRef !== undefined}
            />
          </div>
        </Suspense>
      </div>
    );
  }
  if (kind === "html") {
    return (
      <SandboxedDocument
        target={{ kind: "worktreeFile", worktreeId, path, view: "file" }}
        title={path}
        className="document-visual-content h-full min-h-[60vh] w-full"
      />
    );
  }
  return (
    <div className="document-visual-content flex justify-center p-4">
      <img src={rawUrl} alt={path} className="max-w-full rounded-lg" />
    </div>
  );
}

function FilesView({
  worktree,
  narrow,
  filePath,
  navigate,
  prefs,
  onUpdatePrefs,
  refreshToken,
  anchor,
  navigationControls,
  viewOptionsControl,
  pivot,
  onPivotChange,
  markdownPreviewFirst,
  documentComments,
  commentsConfigFor,
}: {
  worktree: WorktreeRecord;
  narrow: boolean;
  filePath?: string | undefined;
  navigate: (path: string) => void;
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => void;
  refreshToken: number;
  anchor?: DocumentLineAnchor | undefined;
  navigationControls: ReactNode;
  viewOptionsControl: ReactNode;
  pivot: FilePivot;
  onPivotChange: (pivot: FilePivot) => void;
  markdownPreviewFirst: boolean;
  documentComments: ((path: string) => CommentDocument) | undefined;
  commentsConfigFor: (
    path: string,
    current: boolean,
    refOid?: string,
  ) => LineCommentsConfig | undefined;
}) {
  const [entriesByDir, setEntriesByDir] = useState<
    Record<string, WorktreeTreeEntry[]>
  >({});
  const [loadingDirs, setLoadingDirs] = useState<string[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<string[]>(() =>
    filePath ? ancestorDirectoryPaths(filePath) : [],
  );
  const [listDirectory, setListDirectory] = useState(() =>
    filePath ? splitWorktreePath(filePath).dir : "",
  );
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const includeIgnoredRef = useRef(includeIgnored);
  includeIgnoredRef.current = includeIgnored;
  // The tree is a lazily filled CACHE of directories, not one query, so it keeps
  // its own error, against the DIRECTORY that failed: a folder that fails to
  // expand must not take the file (or the rest of the tree) down with it, and
  // the retry has to reload that folder rather than the root.
  const [treeError, setTreeError] = useState<{
    dir: string;
    message: string;
  } | null>(null);

  // Directories with a request out. Refreshing re-reads every loaded directory,
  // so without this a run of watcher pushes would pile duplicate reads of the
  // same folder onto the git queue; an answer that is one scan behind is close
  // enough, and the next push re-reads anyway.
  const inFlightDirs = useRef(new Set<string>());
  // Bumped when the worktree or visibility mode changes, so an older read
  // cannot land its listing in the current tree.
  const treeGeneration = useRef(0);

  const loadDirectory = useCallback(
    (dir: string, force = false) => {
      setEntriesByDir((current) => {
        if (!force && current[dir]) return current;
        if (inFlightDirs.current.has(dir)) return current;
        inFlightDirs.current.add(dir);
        const generation = treeGeneration.current;
        const stillThisTree = () => treeGeneration.current === generation;
        setLoadingDirs((loading) =>
          loading.includes(dir) ? loading : [...loading, dir],
        );
        fetchWorktreeTree(worktree.id, dir, includeIgnoredRef.current)
          .then((payload) => {
            if (!stillThisTree()) return;
            setTreeError((error) => (error?.dir === dir ? null : error));
            // A fresh listing can also say a subdirectory is GONE, and its own
            // cached children would otherwise keep showing under it.
            setEntriesByDir((next) =>
              pruneVanishedTreeDirs({ ...next, [dir]: payload }),
            );
          })
          .catch((err) => {
            if (!stillThisTree()) return;
            setTreeError({
              dir,
              message: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            if (!stillThisTree()) return;
            inFlightDirs.current.delete(dir);
            setLoadingDirs((loading) => loading.filter((item) => item !== dir));
          });
        return current;
      });
    },
    [worktree.id],
  );

  // A DIFFERENT worktree is a different object, so its tree starts empty (R3).
  // Keyed on `loadDirectory`, which changes with the worktree id alone.
  useEffect(() => {
    treeGeneration.current += 1;
    inFlightDirs.current.clear();
    setEntriesByDir({});
    setLoadingDirs([]);
    setListDirectory("");
    setTreeError(null);
    loadDirectory("", true);
  }, [loadDirectory]);

  // Which directories the cache holds, readable from refreshes without making
  // them re-run on every answer.
  const loadedDirsRef = useRef<string[]>([]);
  const previousTreeConfig = useRef({
    worktreeId: worktree.id,
    includeIgnored,
  });

  // A visibility change keeps the current rows and expanded directories while
  // every loaded directory is replaced with a listing in the new mode. Bumping
  // the generation prevents a slower answer from the previous mode landing.
  useEffect(() => {
    const previous = previousTreeConfig.current;
    previousTreeConfig.current = {
      worktreeId: worktree.id,
      includeIgnored,
    };
    if (previous.worktreeId !== worktree.id) return;
    if (previous.includeIgnored === includeIgnored) return;

    const dirs = [
      ...new Set([...loadedDirsRef.current, ...inFlightDirs.current]),
    ];
    treeGeneration.current += 1;
    inFlightDirs.current.clear();
    setLoadingDirs([]);
    for (const dir of dirs.length > 0 ? dirs : [""]) loadDirectory(dir, true);
  }, [includeIgnored, loadDirectory, worktree.id]);

  // A watcher push invalidates the tree IN PLACE (R2): every directory already
  // loaded is refetched and swapped in when it answers, so the rows, the
  // expansion and the folder you are standing in all survive. Clearing the
  // cache first — what this used to do — dropped `rootLoaded` to skeleton rows
  // and threw list mode back to the repo root, and since `computeWorktreeStatus`
  // stamps `updatedAt` on every scan it fired shortly after every open, not
  // just on a real change.
  const refreshTree = useCallback(() => {
    const dirs = loadedDirsRef.current;
    for (const dir of dirs.length > 0 ? dirs : [""]) loadDirectory(dir, true);
  }, [loadDirectory]);
  useReloadOnToken(worktree.id, refreshToken, refreshTree);

  useEffect(() => {
    if (!filePath) return;
    const ancestors = ancestorDirectoryPaths(filePath);
    setListDirectory(splitWorktreePath(filePath).dir);
    setExpandedDirs((current) =>
      [...new Set([...current, ...ancestors])].sort(),
    );
    for (const dir of ["", ...ancestors]) loadDirectory(dir);
  }, [filePath, loadDirectory]);

  // The file's own path is the fetch key, so opening another file shows ITS
  // placeholder instead of the previous file's source under the new path (R3);
  // a watcher push reloads the same key and keeps the source readable (R2).
  const fileKey = filePath ? `${worktree.id}:${filePath}` : null;
  const loadFile = useCallback(
    () =>
      filePath
        ? fetchWorktreeFile(worktree.id, filePath)
        : Promise.reject(new Error("No file selected.")),
    [worktree.id, filePath],
  );
  const fileFetch = useFetchState<WorktreeFileResponse>(fileKey, loadFile);
  useReloadOnToken(fileKey, refreshToken, fileFetch.reload);
  const file = dataOf(fileFetch.state);
  const fileError = errorOf(fileFetch.state);
  const fileFailed = file === undefined && fileError !== undefined;

  // The pivot belongs to the file you opened, not to the last refresh: a
  // background push must not throw you back from "Changes vs base" to source.
  const hasAnchor = anchor !== undefined;
  useEffect(() => {
    onPivotChange(
      markdownPreviewFirst &&
        !hasAnchor &&
        filePath &&
        previewKindForPath(filePath) === "markdown"
        ? "preview"
        : "file",
    );
  }, [filePath, onPivotChange, worktree.id, markdownPreviewFirst, hasAnchor]);

  // With document comments on, the rendered text a passage is selected in:
  // the Markdown preview, or the file's text body. Anything else (an image, a
  // diff, the history) takes comments on the whole file.
  const textRoot = useRef<HTMLDivElement | null>(null);
  const [textRootVersion, setTextRootVersion] = useState(0);
  const attachTextRoot = useCallback((node: HTMLDivElement | null) => {
    textRoot.current = node;
    if (node) setTextRootVersion((version) => version + 1);
  }, []);
  const commentDocument = useMemo(
    () => (filePath && documentComments ? documentComments(filePath) : null),
    [documentComments, filePath],
  );

  const pivotKey =
    filePath && pivot === "vs-base"
      ? `${worktree.id}:${filePath}:base:${worktree.baseCommit}`
      : null;
  const loadPivotDiff = useCallback(
    () =>
      filePath
        ? fetchWorktreeFileDiff(worktree.id, filePath, {
            kind: "range",
            from: worktree.baseCommit,
          } satisfies WorktreeDiffScope)
        : Promise.reject(new Error("No file selected.")),
    [worktree.id, filePath, worktree.baseCommit],
  );
  const pivotFetch = useFetchState<WorktreeFileDiffResponse>(
    pivotKey,
    loadPivotDiff,
  );
  useReloadOnToken(pivotKey, refreshToken, pivotFetch.reload);
  const pivotDiff = dataOf(pivotFetch.state);
  const pivotError = errorOf(pivotFetch.state);

  const navigatorEntries = useMemo(
    () => buildLoadedTreeNavigatorEntries(entriesByDir),
    [entriesByDir],
  );
  const loadedDirs = useMemo(() => Object.keys(entriesByDir), [entriesByDir]);
  loadedDirsRef.current = loadedDirs;
  const rootLoaded = entriesByDir[""] !== undefined;
  // Raster images render as the image directly (source is meaningless); svg,
  // markdown, and html keep source as "File" and add a rendered "Preview".
  const previewKind = filePath ? previewKindForPath(filePath) : undefined;
  const commentLineSource: DocumentLineSource | undefined = !commentDocument
    ? undefined
    : pivot === "preview" && previewKind === "markdown"
      ? "markdown"
      : pivot === "file" && previewKind !== "raster" && file && !file.binary
        ? "code"
        : undefined;
  // The main checkout has no fork point, so the "vs base" pivot is dropped.
  const pivots: Array<{ id: FilePivot; label: string; icon: ReactNode }> = [
    { id: "file", label: "File", icon: <File size={15} /> },
    ...(previewKind && previewKind !== "raster"
      ? ([
          { id: "preview", label: "Preview", icon: <Eye size={15} /> },
        ] as Array<{ id: FilePivot; label: string; icon: ReactNode }>)
      : []),
    ...(worktree.isMain
      ? []
      : ([
          {
            id: "vs-base",
            label: "Changes vs base",
            icon: <GitCompareArrows size={15} />,
          },
        ] as Array<{ id: FilePivot; label: string; icon: ReactNode }>)),
    { id: "history", label: "History", icon: <History size={15} /> },
  ];
  // Content/diff-derived, memoized pierre cache keys (see ChangesView).
  const pivotDiffPath = pivotDiff?.path;
  const pivotDiffText = pivotDiff?.diff;
  const pivotCacheKey = useMemo(
    () =>
      pivotDiffPath !== undefined && pivotDiffText !== undefined
        ? `${worktree.id}:${pivotDiffPath}:${pivot}:${hashContent(pivotDiffText)}`
        : "",
    [worktree.id, pivot, pivotDiffPath, pivotDiffText],
  );
  const filePathForKey = file?.path;
  const fileContent = file?.content;
  const fileCacheKey = useMemo(
    () =>
      filePathForKey !== undefined && fileContent !== undefined
        ? `${worktree.id}:${filePathForKey}:${hashContent(fileContent)}`
        : "",
    [worktree.id, filePathForKey, fileContent],
  );
  const selectedParts = filePath ? splitWorktreePath(filePath) : null;
  const navigatorMode = navigatorViewMode(prefs);
  const setNavigatorMode = useCallback(
    (mode: WorktreeNavigatorViewMode) =>
      onUpdatePrefs({ worktreeNavigatorViewMode: mode }),
    [onUpdatePrefs],
  );
  // What the pane on screen is refetching, if anything (R2): the source, or the
  // "Changes vs base" diff that replaces it. One marker either way — only one of
  // the two is being looked at.
  const ignoredVisibilityLabel = includeIgnored
    ? "Hide ignored and hidden files"
    : "Show ignored and hidden files";
  const shownRefresh =
    pivot === "history"
      ? null // the history list marks its own refresh
      : pivot === "vs-base"
        ? pivotFetch.state.status === "refreshing"
          ? "Refreshing this diff"
          : null
        : fileFetch.state.status === "refreshing"
          ? "Refreshing this file"
          : null;
  const pivotControls =
    pivots.length > 1 ? (
      <div
        className="flex items-center rounded-lg border border-line p-0.5"
        aria-label="File view"
      >
        {pivots.map(({ id, label, icon }) => (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={pivot === id}
            onClick={() => onPivotChange(id)}
            className={`flex items-center justify-center rounded-md ${narrow ? "size-8" : "px-2 py-1 text-caption"} ${pivot === id ? "bg-raised font-medium text-fg" : "text-muted-foreground hover:text-fg"}`}
          >
            {narrow ? icon : label}
          </button>
        ))}
      </div>
    ) : null;

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-3 py-1.5">
        {navigationControls}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            title={ignoredVisibilityLabel}
            aria-label={ignoredVisibilityLabel}
            aria-pressed={includeIgnored}
            onClick={() => setIncludeIgnored((current) => !current)}
            className={`flex size-7 shrink-0 items-center justify-center rounded-md hover:text-fg ${includeIgnored ? "bg-raised text-fg" : "text-muted-foreground hover:bg-raised"}`}
          >
            <Eye size={14} />
          </button>
          {!narrow ? pivotControls : null}
          {NAVIGATOR_VIEW_SWITCH_ENABLED ? (
            <NavigatorViewToggle
              mode={navigatorMode}
              onChange={setNavigatorMode}
            />
          ) : null}
          {!narrow ? (
            <NavigatorVisibilityToggle
              collapsed={prefs.worktreeChangesRailCollapsed}
              onChange={(collapsed) =>
                onUpdatePrefs({ worktreeChangesRailCollapsed: collapsed })
              }
            />
          ) : null}
          {filePath ? viewOptionsControl : null}
        </div>
      </div>
      <WorktreeRailLayout
        title="Files"
        subtitle={worktree.branch}
        collapsedSummary={
          selectedParts ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 max-w-[55%] truncate font-medium text-fg">
                {selectedParts.name}
              </span>
              {selectedParts.dir ? (
                <span className="min-w-0 flex-1 truncate font-mono text-caption text-faint">
                  {selectedParts.dir}
                </span>
              ) : null}
              {/* The narrow detail bar and the rail-collapsed bar are the only
                chrome those layouts have, so R2's marker belongs here too. */}
              {shownRefresh !== null ? (
                <RefreshIndicator className="shrink-0" label={shownRefresh} />
              ) : null}
            </div>
          ) : undefined
        }
        detailControls={narrow ? pivotControls : undefined}
        prefs={prefs}
        onUpdatePrefs={onUpdatePrefs}
        narrow={narrow}
        narrowListHeader={false}
        detailActive={Boolean(filePath)}
        {...(!filePath
          ? { onBack: () => navigate(worktreePath(worktree.id, "files")) }
          : {})}
        rail={
          <div className="flex flex-col gap-2">
            {treeError !== null ? (
              <ErrorNote
                message={
                  treeError.dir === ""
                    ? `Could not load the file tree: ${treeError.message}`
                    : `Could not load “${treeError.dir}”: ${treeError.message}`
                }
                onRetry={() => loadDirectory(treeError.dir, true)}
              />
            ) : null}
            {/* An errored, never-answered root has nothing to say: the note above
              is the whole state, and "No files." would be a claim about the
              worktree (R1). */}
            {rootLoaded || treeError === null ? (
              <WorktreeFileNavigator
                entries={navigatorEntries}
                selectedPath={filePath}
                // Not "a root request is in flight": until the root has ANSWERED
                // the rail is loading, so an empty first frame can never read as
                // an empty worktree (R1).
                loading={!rootLoaded}
                expandedDirectoryPaths={expandedDirs}
                onExpandedDirectoryPathsChange={setExpandedDirs}
                loadedDirectoryPaths={loadedDirs}
                loadingDirectoryPaths={loadingDirs}
                onLoadDirectory={loadDirectory}
                listDirectoryPath={
                  navigatorMode === "list" ? listDirectory : undefined
                }
                onListDirectoryPathChange={
                  navigatorMode === "list" ? setListDirectory : undefined
                }
                onSelectFile={(entry) =>
                  navigate(
                    worktreePath(worktree.id, "files", { path: entry.path }),
                  )
                }
                emptyLabel="No files."
                ariaLabel="Worktree file tree"
                viewMode={navigatorMode}
              />
            ) : null}
          </div>
        }
      >
        {filePath ? (
          <>
            {!narrow ? (
              <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted-foreground">
                  {filePath}
                </span>
                {shownRefresh !== null ? (
                  <RefreshIndicator label={shownRefresh} />
                ) : null}
              </div>
            ) : null}
            <div
              data-document-scroll={
                filePath
                  ? documentTargetHref({
                      kind: "worktreeFile",
                      worktreeId: worktree.id,
                      path: filePath,
                      view: "file",
                      ...(anchor ? { anchor } : {}),
                    })
                  : undefined
              }
              className="min-h-0 flex-1 overflow-auto"
            >
              {pivot === "preview" && previewKind ? (
                previewKind === "markdown" && fileFailed ? (
                  <ErrorNote
                    className="m-4"
                    message={`Could not load this file: ${fileError}`}
                    onRetry={fileFetch.reload}
                  />
                ) : (
                  <FilePreview
                    kind={previewKind}
                    worktreeId={worktree.id}
                    path={filePath}
                    content={file && !file.binary ? file.content : undefined}
                    {...(commentDocument
                      ? { textRootRef: attachTextRoot }
                      : {})}
                  />
                )
              ) : pivot === "history" ? (
                <FileHistoryList
                  worktreeId={worktree.id}
                  path={filePath}
                  refreshToken={refreshToken}
                  onOpenCommit={(entry) =>
                    navigate(
                      worktreePath(worktree.id, "changes", {
                        path: entry.path,
                        from: entry.parentOid,
                        to: entry.oid,
                      }),
                    )
                  }
                />
              ) : pivot !== "file" ? (
                pivotDiff ? (
                  // Unconditional frame: see ChangesView — a note that appears
                  // above the surface must not remount it.
                  <div className="flex flex-col">
                    {pivotError !== undefined &&
                    !isUnchangedPathError(pivotError) ? (
                      <ErrorNote
                        className="m-3"
                        message={`Could not refresh this diff: ${pivotError}`}
                        onRetry={pivotFetch.reload}
                      />
                    ) : null}
                    <DiffSurface
                      prefs={prefs}
                      patch={pivotDiff.diff}
                      oldFile={{
                        name: pivotDiff.oldPath ?? pivotDiff.path,
                        contents: pivotDiff.oldContent,
                      }}
                      newFile={{
                        name: pivotDiff.path,
                        contents: pivotDiff.newContent,
                      }}
                      cacheKey={pivotCacheKey}
                    />
                  </div>
                ) : isInitialLoad(pivotFetch.state) ? (
                  <PaneLoading label="Loading diff…" />
                ) : pivotError !== undefined &&
                  !isUnchangedPathError(pivotError) ? (
                  <ErrorNote
                    className="m-4"
                    message={`Could not load this diff: ${pivotError}`}
                    onRetry={pivotFetch.reload}
                  />
                ) : (
                  <div className="p-6 text-body text-muted-foreground">
                    No changes to this file in that range.
                  </div>
                )
              ) : previewKind === "raster" ? (
                <FilePreview
                  kind="raster"
                  worktreeId={worktree.id}
                  path={filePath}
                />
              ) : file ? (
                file.binary ? (
                  <div className="p-6 text-body text-muted-foreground">
                    Binary file.
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 p-3">
                    {fileError !== undefined ? (
                      <ErrorNote
                        message={`Could not refresh this file: ${fileError}`}
                        onRetry={fileFetch.reload}
                      />
                    ) : null}
                    {commentDocument ? (
                      <div ref={attachTextRoot}>
                        <DocumentTextBody
                          text={file.content}
                          name={file.path}
                          anchor={anchor}
                        />
                      </div>
                    ) : (
                      <FileSurface
                        prefs={prefs}
                        name={file.path}
                        contents={file.content}
                        cacheKey={fileCacheKey}
                        comments={commentsConfigFor(file.path, true)}
                        lineAnchor={anchor}
                      />
                    )}
                  </div>
                )
              ) : fileFailed ? (
                <ErrorNote
                  className="m-4"
                  message={`Could not load this file: ${fileError}`}
                  onRetry={fileFetch.reload}
                />
              ) : (
                <PaneLoading label="Loading file…" />
              )}
            </div>
            {commentDocument ? (
              <DocumentCommentLayer
                document={commentDocument}
                {...(commentLineSource
                  ? {
                      rootRef: textRoot,
                      lineSource: commentLineSource,
                      rootVersion: textRootVersion,
                    }
                  : {})}
              />
            ) : null}
          </>
        ) : (
          <div className="p-6 text-body text-muted-foreground">
            Select a file to view it.
          </div>
        )}
      </WorktreeRailLayout>
    </>
  );
}

/* ---------------------------------- page ----------------------------------- */

const VIEW_TABS: Array<{ id: WorktreeView; label: string }> = [
  { id: "changes", label: "Review" },
  { id: "files", label: "Files" },
];

export default function WorktreeDetailPage({
  worktree,
  back,
  status: pushedStatus,
  narrow,
  view,
  filePath,
  from,
  to,
  anchor,
  navigate,
  prefs,
  onUpdatePrefs,
  comments,
  onLoadComments,
  onUnloadComments,
  commentActions,
  onSubmitReview,
  openComment,
  embedded = false,
  headerActions,
  title,
  lineComments = true,
  markdownPreviewFirst = false,
  documentComments,
}: WorktreeDetailPageProps) {
  const [fetchedStatus, setFetchedStatus] = useState<
    WorktreeGitStatus | undefined
  >(undefined);
  const status =
    pushedStatus &&
    (!fetchedStatus || pushedStatus.updatedAt >= fetchedStatus.updatedAt)
      ? pushedStatus
      : fetchedStatus;
  const [pathCopied, setPathCopied] = useState(false);
  const [filePivot, setFilePivot] = useState<FilePivot>("file");
  // Same default rule ChangesView applies, so the view-options segment and the
  // comment-following below both know what the pane is actually doing.
  const reviewLayout =
    prefs.worktreeReviewMode ?? (narrow ? "changeset" : "by-file");

  // Split diffs are unusable in a column this narrow: it always renders
  // unified, and the remembered split pref applies in a wide pane only (its
  // toggle is hidden here).
  const effectivePrefs = useMemo<Prefs>(
    () =>
      narrow && prefs.diffStyle === "split"
        ? { ...prefs, diffStyle: "unified" }
        : prefs,
    [narrow, prefs],
  );

  const refreshStatus = useCallback(() => {
    fetchWorktreeStatus(worktree.id)
      .then(setFetchedStatus)
      .catch(() => undefined);
  }, [worktree.id]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Load once per worktree; mutation/re-anchor pushes keep it fresh. Both
  // callbacks are fresh arrows from the host on every one of ITS renders, so
  // they are latched rather than depended on: re-running here would unwatch and
  // re-list this worktree's comments continuously.
  const commentWatchRef = useRef({ onLoadComments, onUnloadComments });
  commentWatchRef.current = { onLoadComments, onUnloadComments };
  useEffect(() => {
    if (!lineComments) return;
    commentWatchRef.current.onLoadComments();
    return () => commentWatchRef.current.onUnloadComments();
  }, [worktree.id, lineComments]);

  // Watcher pushes bump status.updatedAt → the views refetch their data.
  const refreshToken = status?.updatedAt ?? 0;

  /**
   * Comment config for a surface showing `path`. Current-content surfaces
   * anchor/display at re-anchored positions; committed surfaces (a range diff
   * with a resolved `refOid`) anchor/display at that commit's immutable
   * anchors. A committed surface without a resolved oid can't be commented on.
   */
  /**
   * The comment a roster link asked us to land on. The panel's rows are links to
   * the LINE they annotate, so navigating to the file is only half of it — the
   * surface scrolls to the thread and rings it (`useFocusComment`). The nonce lets
   * the same comment be followed twice.
   */
  const [focusComment, setFocusComment] = useState<{
    commentId: string;
    path: string;
    nonce: number;
  } | null>(null);
  // What the surfaces below actually take: the request without its path, held
  // stable until a new follow. `useFocusComment` keys on this object, and a
  // fresh literal per render would re-scroll and re-ring the same thread.
  const focusRequest = useMemo(
    () =>
      focusComment
        ? { commentId: focusComment.commentId, nonce: focusComment.nonce }
        : null,
    [focusComment],
  );
  const followComment = useCallback(
    (commentId: string, path: string) => {
      setFocusComment({ commentId, path, nonce: Date.now() });
      // By-file layouts need the file open; the changeset stacks every file already,
      // and its lazily mounted section catches up while the scroll retries.
      if (reviewLayout === "by-file" || view === "files") {
        navigate(
          worktreePath(worktree.id, view, {
            ...(view === "changes"
              ? {
                  ...(from !== undefined ? { from } : {}),
                  ...(to !== undefined ? { to } : {}),
                }
              : {}),
            path,
          }),
        );
      }
    },
    [from, navigate, reviewLayout, to, view, worktree.id],
  );

  // The panel's roster hands over a comment id; resolving WHICH file it currently
  // lives in belongs here, where the comments are. Keyed on the token alone —
  // `followComment` changes with the route it navigates through, and `comments`
  // is rebuilt by every comment broadcast, so both are read through a ref: a
  // re-run would navigate the reader back to the thread they just left.
  const followRef = useRef({ comments, followComment });
  followRef.current = { comments, followComment };
  const openCommentId = openComment?.commentId ?? null;
  const openCommentNonce = openComment?.nonce ?? null;
  useEffect(() => {
    if (openCommentId === null) return;
    const { comments: all, followComment: follow } = followRef.current;
    const root = all.find(
      (comment) => comment.id === openCommentId && !comment.parentId,
    );
    const path = root?.current?.path;
    if (path) follow(openCommentId, path);
  }, [openCommentId, openCommentNonce]);

  const commentsConfigFor = useCallback(
    (
      path: string,
      current: boolean,
      refOid?: string,
    ): LineCommentsConfig | undefined =>
      !lineComments
        ? undefined
        : current
          ? {
              comments,
              path,
              actions: commentActions,
              ...(focusComment?.path === path && focusRequest
                ? { focus: focusRequest }
                : {}),
            }
          : refOid
            ? {
                comments,
                path,
                actions: commentActions,
                refOid,
                ...(focusComment?.path === path && focusRequest
                  ? { focus: focusRequest }
                  : {}),
              }
            : undefined,
    [comments, commentActions, focusComment, focusRequest, lineComments],
  );

  const navigationControls = VIEW_TABS.map((tab) => (
    <button
      key={tab.id}
      type="button"
      onClick={() =>
        navigate(
          worktreePath(
            worktree.id,
            tab.id,
            tab.id === "changes"
              ? {
                  ...(from !== undefined ? { from } : {}),
                  ...(to !== undefined ? { to } : {}),
                }
              : {},
          ),
        )
      }
      className={`shrink-0 rounded-lg px-2.5 py-1 text-caption ${view === tab.id ? "bg-raised font-medium text-fg" : "text-muted-foreground hover:text-fg"}`}
    >
      {tab.label}
    </button>
  ));
  const viewOptionsControl = (
    <Popover
      align="right"
      placement="bottom"
      title="Diff view options"
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-raised hover:text-fg data-[open=true]:bg-raised data-[open=true]:text-fg"
      button={<SlidersHorizontal size={14} />}
    >
      {() => (
        <div className="p-1.5">
          {/* By-file vs changeset is a RENDERING choice like unified vs split, so
                it belongs in here rather than as a second segmented control in the
                toolbar competing with the tabs and the scope. */}
          {view === "changes" && !filePath ? (
            <div className="mb-1.5 border-b border-line pb-1.5">
              <p className="px-1 pb-1 text-micro font-medium uppercase tracking-wide text-faint">
                Review layout
              </p>
              <div className="flex items-center rounded-lg border border-line p-0.5">
                {(
                  [
                    { id: "by-file", label: "By file" },
                    { id: "changeset", label: "All files" },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() =>
                      onUpdatePrefs({ worktreeReviewMode: option.id })
                    }
                    aria-pressed={reviewLayout === option.id}
                    className={`flex flex-1 items-center justify-center rounded-md px-2 py-1 text-caption ${reviewLayout === option.id ? "bg-raised font-medium text-fg" : "text-muted-foreground hover:text-fg"}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <DiffModeToolbar
            prefs={effectivePrefs}
            onUpdate={onUpdatePrefs}
            stacked
            showStyleToggle={!narrow}
          />
        </div>
      )}
    </Popover>
  );

  const pendingReviewIds = pendingWorktreeReviewIds(comments);
  const documentTarget = useMemo(
    () =>
      filePath
        ? {
            kind: "worktreeFile" as const,
            worktreeId: worktree.id,
            path: filePath,
            view: view === "changes" ? ("diff" as const) : ("file" as const),
            ...(anchor ? { anchor } : {}),
          }
        : null,
    [anchor, filePath, view, worktree.id],
  );
  // This page registers as a marker and lays out its own panes, so the shared
  // restoration behaviour is attached here rather than by a second shell: the
  // Files and Changes scrollers already carry their document id.
  useDocumentScrollRestoration(
    !embedded && documentTarget ? documentTargetHref(documentTarget) : null,
    Boolean(documentTarget?.anchor),
  );
  const documentSourceActions = useMemo(() => {
    if (!documentTarget) return [];
    const enabled = externalDocumentActionEnabled(documentTarget);
    return [
      {
        id: "open",
        label: "Open raw worktree file",
        icon: <ExternalLink size={16} />,
        onRun: () => void runExternalDocumentAction(documentTarget, "open"),
        disabled: !enabled,
        disabledReason:
          "External opening is unavailable for worktree files in the native app",
      },
      {
        id: "download",
        label: "Download worktree file",
        icon: <Download size={16} />,
        onRun: () => void runExternalDocumentAction(documentTarget, "download"),
        disabled: !enabled,
        disabledReason:
          "External download is unavailable for worktree files in the native app",
      },
    ];
  }, [documentTarget]);

  return (
    <DiffWorkerProvider prefs={prefs}>
      {documentTarget && !embedded ? (
        <DocumentNavigationMarker
          target={documentTarget}
          title={filePath!}
          sourceActions={documentSourceActions}
          manageZoom
          // The renderer on screen decides, not the pivot's name: a rendered
          // Markdown preview reflows, an SVG/HTML/image preview scales.
          zoomMode={worktreeZoomMode(
            documentTarget.view,
            filePivot,
            filePath ? previewKindForPath(filePath) : undefined,
          )}
        />
      ) : null}
      <DiffCommentBarProvider
        enabled={lineComments}
        pendingCount={pendingReviewIds.length}
        // An empty batch never opens the sheet: it would offer to start a
        // session on no comments at all.
        onSubmitReview={() => {
          if (pendingReviewIds.length > 0) onSubmitReview(pendingReviewIds);
        }}
      >
        <div className="flex h-full min-h-0 flex-col">
          {/* ONE identity row, the shape every other object page uses: the branch, and
            a glyph that copies the worktree PATH — the thing you actually paste (into
            a terminal), and which used to sit in a subtitle that truncated to
            uselessness on a phone. The path is stated in full by the panel's
            Checkout facts, and the dirty counts the chips repeated are now the
            Delivery section's plus the changed-files header in the pane itself. */}
          <PageHeader
            back={back}
            density="compact"
            icon={
              pathCopied ? (
                <Check size={16} strokeWidth={2.5} />
              ) : (
                <GitBranch size={16} />
              )
            }
            onIconClick={
              worktree.path
                ? () => {
                    void copyWithToast(worktree.path, {
                      successMessage: "Copied worktree path",
                    });
                    setPathCopied(true);
                    window.setTimeout(() => setPathCopied(false), 1200);
                  }
                : undefined
            }
            iconLabel={pathCopied ? "Copied!" : "Copy worktree path"}
            title={title ?? worktree.branch}
            actions={
              embedded ? (
                headerActions
              ) : filePath ? (
                <DocumentNavigationActions className="hidden md:flex" />
              ) : undefined
            }
          />
          {view === "files" ? (
            <FilesView
              worktree={worktree}
              narrow={narrow}
              filePath={filePath}
              navigate={navigate}
              prefs={effectivePrefs}
              onUpdatePrefs={onUpdatePrefs}
              refreshToken={refreshToken}
              anchor={anchor}
              navigationControls={navigationControls}
              viewOptionsControl={viewOptionsControl}
              pivot={filePivot}
              onPivotChange={setFilePivot}
              markdownPreviewFirst={markdownPreviewFirst}
              documentComments={documentComments}
              commentsConfigFor={commentsConfigFor}
            />
          ) : (
            <ChangesView
              worktree={worktree}
              narrow={narrow}
              filePath={filePath}
              from={from}
              to={to}
              anchor={anchor}
              navigate={navigate}
              prefs={effectivePrefs}
              onUpdatePrefs={onUpdatePrefs}
              refreshToken={refreshToken}
              navigationControls={navigationControls}
              viewOptionsControl={viewOptionsControl}
              commentsConfigFor={commentsConfigFor}
            />
          )}
        </div>
      </DiffCommentBarProvider>
    </DiffWorkerProvider>
  );
}
