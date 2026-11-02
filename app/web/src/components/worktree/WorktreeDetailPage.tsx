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
  BookOpen,
  Check,
  Columns2,
  Files,
  Rows2,
  Space,
  UnfoldVertical,
  WholeWord,
  WrapText,
  ChevronLeft,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  File,
  FileText,
  FolderTree,
  GitBranch,
  GitCompareArrows,
  History,
  List,
  MessageSquareQuote,
  SendHorizontal,
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
  SessionListItem,
  ProjectRecord,
} from "@assistant/shared";
import { WorktreeOverview } from "./WorktreeOverview.tsx";
import { WORKTREE_VIEWS } from "./worktreeViews.tsx";
import { PageHeader, type PageHeaderBack } from "../PageHeader.tsx";
import {
  DocumentNavigationActions,
  DocumentNavigationMarker,
  useDocumentScrollRestoration,
} from "../DocumentNavigationShell.tsx";
import { Button } from "../ui/button.tsx";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../ui/dropdown-menu.tsx";
import { Badge } from "../ui/badge.tsx";
import { useCommentActuation } from "../review/CommentActuation.tsx";
import type { InspectorAction } from "../shell/Inspector.tsx";
import { useWorktreeDelivery } from "./WorktreeDelivery.tsx";
import { useWorktreeRetire } from "./useWorktreeRetire.tsx";
import { worktreeInspectorActions } from "../objectInspectors.tsx";
import { useIgnoredFilesShown } from "../../lib/worktreeIgnoredFiles.ts";
import { Field, FieldLabel } from "../ui/field.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { Separator } from "../ui/separator.tsx";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.tsx";
import { useMobileLayout } from "../shell/useMobileLayout.ts";
import {
  DIFF_VIEW_SWITCHES,
  DiffModeToolbar,
} from "../diff/DiffModeToolbar.tsx";
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
import { EdgeSheet } from "../common/EdgeSheet.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "../ui/item.tsx";
import { IconButton } from "../common/IconButton.tsx";
import { OverflowMenu } from "../common/OverflowMenu.tsx";
import { ErrorNote, PaneLoading, RefreshIndicator } from "../common/load.tsx";
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
} from "../common/ResizableSeparator.tsx";
import {
  WorktreeFileNavigator,
  buildChangeNavigatorEntries,
  directoryPathsFromNavigatorEntries,
  type WorktreeNavigatorViewMode,
} from "./WorktreeFileNavigator.tsx";
import {
  WorktreeFileTree,
  splitWorktreePath,
  useWorktreeFileChanges,
  useWorktreeFileTree,
} from "./WorktreeFileTree.tsx";

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
   * The checkout is read as a folder of documents, not reviewed as a worktree
   * (the Knowledge Base): the header names the open FILE, the Files view drops
   * the worktree chrome (view tabs, hidden-files toggle, diff options, path
   * bar), and on desktop it draws no tree rail, because the sidebar beside the
   * page already browses this checkout.
   */
  browseAsDocuments?: boolean;
  /**
   * Comment on files the way any document is commented on — a passage or the
   * whole file, collected in its browser-local tray and sent to a session
   * (`docs/comments.md`) — naming each file by the document this returns. For
   * a checkout without review comments (the Knowledge Base). A file's text
   * then renders as the shared document text body, which a passage can be
   * selected in. Keep the function's identity stable.
   */
  documentComments?: ((path: string) => CommentDocument) | undefined;
  /**
   * The sidebar's Projects tree browses this worktree's files and change sets,
   * so the page draws no rail of its own and Review is one scroll.
   */
  sidebarNavigation?: boolean;
  /** For the Overview's sessions working here. */
  sessions?: readonly SessionListItem[] | undefined;
  /** `sessions` answered in this socket episode: Retire may count them. */
  sessionsFresh?: boolean;
  /** Opens the app's Remove dialog for this worktree. */
  onRemoveWorktree?: ((id: string) => void) | undefined;
  /** Opens the app's Merge back dialog for this worktree. */
  onMergeWorktree?: ((id: string) => void) | undefined;
  onStartSessionInWorktree?: ((id: string) => void) | undefined;
  /** The worktree's Project, named in the Overview's facts. */
  project?: ProjectRecord | undefined;
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
    <ToggleGroup
      variant="outline"
      size="sm"
      spacing={0}
      aria-label="Navigator view"
      value={[mode]}
      onValueChange={(next) => {
        if (next[0]) onChange(next[0] as WorktreeNavigatorViewMode);
      }}
    >
      <ToggleGroupItem value="list" aria-label="Folder list">
        <List />
      </ToggleGroupItem>
      <ToggleGroupItem value="tree" aria-label="Tree">
        <FolderTree />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

function NavigatorVisibilityToggle({
  collapsed,
  onChange,
}: {
  collapsed: boolean;
  onChange: (collapsed: boolean) => void;
}) {
  return (
    <IconButton
      label={collapsed ? "Show navigator" : "Collapse navigator"}
      onClick={() => onChange(!collapsed)}
    >
      {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
    </IconButton>
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
  narrowDetailBar = true,
  railHidden = false,
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
  /** Narrow detail screen: draw the back/title/controls bar above it. */
  narrowDetailBar?: boolean;
  /** Desktop: no rail at all, as if collapsed (another tree browses this). */
  railHidden?: boolean;
  /** Narrow: a detail is selected, so the content pane replaces the list. */
  detailActive?: boolean;
  /** Narrow: return from the detail pane to the list. */
  onBack?: () => void;
}) {
  const railCollapsed = railHidden || prefs.worktreeChangesRailCollapsed;
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

  const railHeading = (
    <div className="min-w-0 border-b border-border px-2 py-1.5">
      <div className="truncate text-sm font-medium text-muted-foreground">
        {title}
      </div>
      {subtitle ? (
        <div className="truncate font-mono text-xs text-muted-foreground">
          {subtitle}
        </div>
      ) : null}
    </div>
  );

  // Mobile is list→detail: the navigator IS the screen until a detail is
  // selected, then the content pane replaces it behind a back bar. The rail
  // collapse/width prefs are desktop concepts and don't apply.
  if (narrow) {
    if (!detailActive) {
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-background/40">
          {narrowListHeader ? railHeading : null}
          <div
            data-dock-scroll
            className="min-h-0 flex-1 overflow-y-auto p-1.5"
          >
            {rail}
          </div>
        </div>
      );
    }
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-card">
        {narrowDetailBar ? (
          <div className="flex items-center gap-2 border-b border-border bg-background/40 py-1.5 pl-1 pr-3 text-sm text-muted-foreground">
            {onBack ? (
              <IconButton
                label={`Back to ${title.toLowerCase()}`}
                size="icon"
                onClick={onBack}
              >
                <ChevronLeft />
              </IconButton>
            ) : null}
            {collapsedSummary ?? (
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {title}
              </span>
            )}
            {detailControls ? (
              <div className="shrink-0">{detailControls}</div>
            ) : null}
          </div>
        ) : null}
        {children}
      </div>
    );
  }

  return (
    <div ref={paneRef} className="flex min-h-0 flex-1">
      {!railCollapsed ? (
        <div
          className="relative flex shrink-0 flex-col border-r border-border bg-background/40"
          style={{ width: railWidth }}
        >
          {railHeading}
          <div
            data-dock-scroll
            className="min-h-0 flex-1 overflow-y-auto p-1.5"
          >
            {rail}
          </div>
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
        {railCollapsed && collapsedSummary ? (
          <div className="flex items-center gap-2 border-b border-border bg-background/40 px-3 py-2 text-sm text-muted-foreground">
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
  sidebarNavigation = false,
  jumpOpen,
  onJumpOpenChange,
}: {
  sidebarNavigation?: boolean;
  /** Jump to file, opened from the page header (the phone's sheet). */
  jumpOpen: boolean;
  onJumpOpenChange: (open: boolean) => void;
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
  // With the sidebar listing the changed files, Review is the one scroll they
  // jump into.
  const reviewMode: ReviewMode = sidebarNavigation
    ? "changeset"
    : (prefs.worktreeReviewMode ?? (narrow ? "changeset" : "by-file"));
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
  const jumpSheetOpen = jumpOpen;
  const setJumpSheetOpen = onJumpOpenChange;
  // A file picked in the sidebar arrives as the route's path: scroll the
  // changeset to it, retrying while its lazily mounted section appears.
  const changesLoaded = changes !== undefined;
  useEffect(() => {
    if (reviewMode !== "changeset" || !filePath || !changesLoaded) return;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const section = sectionsRef.current.get(filePath);
      if (section) section.scrollIntoView({ block: "start" });
      else if (tries++ < 30) frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [reviewMode, filePath, changesLoaded]);
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
      <span className="text-success">+{changes.totals.additions}</span>{" "}
      <span className="text-destructive">−{changes.totals.deletions}</span>
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
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
      {navigationControls ? (
        <>
          {navigationControls}
          <Separator orientation="vertical" className="mx-1 h-4" />
        </>
      ) : null}
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
        {narrow &&
        !sidebarNavigation &&
        reviewMode === "changeset" &&
        changeFiles.length > 0 ? (
          phone ? (
            <IconButton
              label="Jump to file"
              onClick={() => setJumpSheetOpen(true)}
            >
              <FolderTree />
            </IconButton>
          ) : (
            <Popover open={jumpSheetOpen} onOpenChange={setJumpSheetOpen}>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Jump to file"
                  />
                }
              >
                <FolderTree />
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="max-h-96 w-80 overflow-y-auto"
              >
                {jumpNavigator(() => setJumpSheetOpen(false))}
              </PopoverContent>
            </Popover>
          )
        ) : null}
        {NAVIGATOR_VIEW_SWITCH_ENABLED && !sidebarNavigation ? (
          <NavigatorViewToggle
            mode={navigatorMode}
            onChange={setNavigatorMode}
          />
        ) : null}
        {!narrow && !sidebarNavigation ? (
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
      <div data-dock-scroll className="min-h-0 min-w-0 flex-1 overflow-auto">
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
        {narrow || sidebarNavigation ? (
          changesetContent
        ) : (
          <WorktreeRailLayout
            title="Changed files"
            subtitle={totalsSummary}
            collapsedSummary={
              <span className="font-medium text-foreground">All files</span>
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
        {phone || (sidebarNavigation && narrow) ? (
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
              <span className="font-medium text-foreground">
                {selectedParts.name}
              </span>
              {selectedParts.dir ? (
                <span className="min-w-0 truncate font-mono text-sm text-muted-foreground">
                  {selectedParts.dir}
                </span>
              ) : null}
              <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
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
          data-dock-scroll
          className="min-h-0 min-w-0 flex-1 overflow-auto"
        >
          {fileDiff ? (
            fileDiff.binary ? (
              <div className="p-6 text-sm text-muted-foreground">
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
              <div className="p-6 text-sm text-muted-foreground">
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
            <div className="p-6 text-sm text-muted-foreground">
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
        className="document-visual-content h-full min-h-96 w-full"
      />
    );
  }
  return (
    <div className="document-visual-content flex justify-center p-4">
      <img src={rawUrl} alt={path} className="max-w-full rounded-lg" />
    </div>
  );
}

type FilePivotOption = { id: FilePivot; label: string; icon: ReactNode };

// A raster image has no "Preview" (its File already is the image), and the
// main checkout has no fork point, so the "vs base" pivot is dropped.
function filePivotsFor(
  filePath: string | undefined,
  isMain: boolean | undefined,
): FilePivotOption[] {
  const previewKind = filePath ? previewKindForPath(filePath) : undefined;
  return [
    { id: "file", label: "File", icon: <File /> },
    ...(previewKind && previewKind !== "raster"
      ? [{ id: "preview", label: "Preview", icon: <Eye /> } as const]
      : []),
    ...(isMain
      ? []
      : [
          {
            id: "vs-base",
            label: "Changes vs base",
            icon: <GitCompareArrows />,
          } as const,
        ]),
    { id: "history", label: "History", icon: <History /> },
  ];
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
  browseAsDocuments,
  documentComments,
  commentsConfigFor,
  sidebarNavigation = false,
}: {
  sidebarNavigation?: boolean;
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
  browseAsDocuments: boolean;
  documentComments: ((path: string) => CommentDocument) | undefined;
  commentsConfigFor: (
    path: string,
    current: boolean,
    refOid?: string,
  ) => LineCommentsConfig | undefined;
}) {
  const tree = useWorktreeFileTree({
    worktreeId: worktree.id,
    filePath,
    refreshToken,
  });
  const fileChanges = useWorktreeFileChanges(worktree, refreshToken);

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
  const pivots = filePivotsFor(filePath, worktree.isMain);
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
      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={0}
        aria-label="File view"
        value={[pivot]}
        onValueChange={(next) => {
          if (next[0]) onPivotChange(next[0] as FilePivot);
        }}
      >
        {pivots.map(({ id, label, icon }) => (
          <ToggleGroupItem key={id} value={id} aria-label={label}>
            {narrow ? icon : label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    ) : null;

  return (
    <>
      {browseAsDocuments ? (
        // Only the file's own pivots (Preview / File / History) remain; with
        // no file open there is nothing to switch, so no toolbar at all. A
        // phone has none either: the page header's `…` holds the pivots.
        filePath && !narrow && (pivotControls || shownRefresh !== null) ? (
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-1.5">
            {shownRefresh !== null ? (
              <RefreshIndicator label={shownRefresh} />
            ) : null}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {pivotControls}
            </div>
          </div>
        ) : null
      ) : // With the sidebar navigating, a phone's toolbar would be empty: the
      // pivots sit in the file bar and the options in the header's menu.
      sidebarNavigation && (!filePath || narrow) ? null : (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-1.5">
          {navigationControls}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {!narrow ? pivotControls : null}
            {NAVIGATOR_VIEW_SWITCH_ENABLED && !sidebarNavigation ? (
              <NavigatorViewToggle
                mode={navigatorMode}
                onChange={setNavigatorMode}
              />
            ) : null}
            {!narrow && !sidebarNavigation ? (
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
      )}
      <WorktreeRailLayout
        title="Files"
        subtitle={worktree.branch}
        collapsedSummary={
          selectedParts && !(browseAsDocuments && !narrow) ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 max-w-1/2 truncate font-medium text-foreground">
                {selectedParts.name}
              </span>
              {selectedParts.dir ? (
                // Cut from the LEFT: the nearest folders tell two files apart,
                // not the shared root.
                <span
                  className="min-w-0 flex-1 truncate text-left font-mono text-sm text-muted-foreground"
                  dir="rtl"
                  title={selectedParts.dir}
                >
                  <span dir="ltr">{selectedParts.dir}</span>
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
        // The document header already names the file and holds its pivots.
        narrowDetailBar={!browseAsDocuments}
        railHidden={browseAsDocuments || sidebarNavigation}
        detailActive={Boolean(filePath)}
        {...(!filePath
          ? { onBack: () => navigate(worktreePath(worktree.id, "files")) }
          : {})}
        rail={
          <WorktreeFileTree
            tree={tree}
            changes={fileChanges}
            selectedPath={filePath}
            onSelectFile={(entry) =>
              navigate(worktreePath(worktree.id, "files", { path: entry.path }))
            }
            ariaLabel="Worktree file tree"
            viewMode={navigatorMode}
          />
        }
      >
        {filePath ? (
          <>
            {narrow && browseAsDocuments && shownRefresh !== null ? (
              // No bar to carry R2's marker here, so it floats over the pane.
              <RefreshIndicator
                className="absolute right-3 top-2 z-10"
                label={shownRefresh}
              />
            ) : null}
            {!narrow && !browseAsDocuments ? (
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-muted-foreground">
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
              data-dock-scroll
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
                  <div className="p-6 text-sm text-muted-foreground">
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
                  <div className="p-6 text-sm text-muted-foreground">
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
        ) : sidebarNavigation && !narrow ? (
          // No file yet: the worktree's top folder, to start from.
          <div data-dock-scroll className="min-h-0 flex-1 overflow-y-auto p-2">
            <WorktreeFileTree
              tree={tree}
              changes={fileChanges}
              onSelectFile={(entry) =>
                navigate(
                  worktreePath(worktree.id, "files", { path: entry.path }),
                )
              }
              ariaLabel="Worktree files"
              viewMode={navigatorMode}
            />
          </div>
        ) : (
          <div className="p-6 text-sm text-muted-foreground">
            {browseAsDocuments && !narrow
              ? "Pick a file in the sidebar to read it."
              : "Select a file to view it."}
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
function SheetGroupLabel({ children }: { children: ReactNode }) {
  return (
    // The rows' own inset, so a label lines up with the icons under it.
    <div className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * A phone's worktree header, the shape the other object pages draw: Add comment
 * (and Submit review while comments wait) beside one menu of the worktree's
 * delivery actions.
 */
const DIFF_SWITCH_ICONS: Record<
  (typeof DIFF_VIEW_SWITCHES)[number]["pref"],
  ReactNode
> = {
  diffWordLevel: <WholeWord />,
  diffIgnoreWhitespace: <Space />,
  diffWrap: <WrapText />,
  diffExpandContext: <UnfoldVertical />,
};

const DIFF_STYLES = [
  { value: "unified", label: "Unified", icon: <Rows2 /> },
  { value: "split", label: "Split", icon: <Columns2 /> },
] as const;

/** One checkable row of the phone's menu sheet. */
function SheetCheckRow({
  icon,
  label,
  checked,
  role = "menuitemcheckbox",
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  checked: boolean;
  role?: "menuitemcheckbox" | "menuitemradio";
  onSelect: () => void;
}) {
  return (
    <Item
      size="sm"
      render={<button type="button" />}
      role={role}
      aria-checked={checked}
      onClick={onSelect}
    >
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
      </ItemContent>
      <ItemActions>{checked ? <Check size={14} /> : null}</ItemActions>
    </Item>
  );
}

function WorktreeHeaderActions({
  actions,
  showComment,
  onJumpToFile,
  diffView,
  ignoredFiles,
}: {
  actions: InspectorAction[];
  showComment: boolean;
  /** Opens the Jump to file sheet: Review's changed files on a phone. */
  onJumpToFile?: (() => void) | undefined;
  /** The diff display options, where a diff can be on screen. */
  diffView?:
    | {
        prefs: Prefs;
        onUpdate: (patch: Partial<Prefs>) => void;
        /** Unified/split: a narrow screen always renders unified. */
        showStyle: boolean;
      }
    | undefined;
  /** The file trees' "show ignored and hidden files", shared per worktree. */
  ignoredFiles?:
    { shown: boolean; onChange: (shown: boolean) => void } | undefined;
}) {
  const actuation = useCommentActuation();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTop, setSheetTop] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const pendingCount = Math.max(0, actuation?.pendingCount ?? 0);
  const canComment = actuation?.canComment === true;
  const commentLabel = canComment
    ? (actuation?.commentLabel ?? "Add comment")
    : "Select text to comment";
  return (
    <div className="flex shrink-0 items-center gap-1">
      {onJumpToFile ? (
        <IconButton label="Jump to file" size="icon" onClick={onJumpToFile}>
          <Files />
        </IconButton>
      ) : null}
      {showComment && actuation?.onComment ? (
        <span title={commentLabel}>
          <Button
            variant="ghost"
            size="icon"
            data-comment-actuation
            // Keeps the text selection the comment is about.
            onPointerDown={(event) => event.preventDefault()}
            onClick={actuation.onComment}
            disabled={!canComment}
            aria-label={commentLabel}
          >
            <MessageSquareQuote />
          </Button>
        </span>
      ) : null}
      {showComment && actuation?.onSubmitReview && pendingCount > 0 ? (
        <IconButton
          label={`${actuation.submitLabel ?? "Submit review"} (${pendingCount} pending)`}
          size="icon"
          data-comment-actuation
          onPointerDown={(event) => event.preventDefault()}
          onClick={actuation.onSubmitReview}
          className="relative"
        >
          <SendHorizontal />
          <Badge className="absolute -right-1 -top-1">{pendingCount}</Badge>
        </IconButton>
      ) : null}
      {(actions.length > 0 || ignoredFiles || diffView) && showComment ? (
        // A phone's menu is the chat header's: a sheet dropping from under
        // the header, its rows a thumb's height.
        <>
          <IconButton
            ref={triggerRef}
            label="Worktree actions"
            aria-haspopup="dialog"
            onClick={() => {
              const anchor =
                triggerRef.current?.closest("header") ?? triggerRef.current;
              setSheetTop(anchor?.getBoundingClientRect().bottom ?? 0);
              setSheetOpen(true);
            }}
          >
            <Ellipsis />
          </IconButton>
          <EdgeSheet
            open={sheetOpen}
            side="top"
            offsetTop={sheetTop}
            title="Worktree actions"
            onClose={() => setSheetOpen(false)}
          >
            <div role="menu">
              {actions.length > 0 ? (
                <>
                  <SheetGroupLabel>Actions</SheetGroupLabel>
                  {actions.map((action) => (
                    <Item
                      key={action.key}
                      size="sm"
                      render={
                        <button
                          type="button"
                          disabled={action.busy || action.disabled}
                        />
                      }
                      // One line: the reason gives way (truncates), never wraps.
                      className="flex-nowrap disabled:pointer-events-none disabled:opacity-50"
                      role="menuitem"
                      title={action.disabledReason}
                      onClick={() => {
                        setSheetOpen(false);
                        action.onRun();
                      }}
                    >
                      {action.icon ? (
                        <ItemMedia variant="icon">{action.icon}</ItemMedia>
                      ) : null}
                      {/* The act keeps its full label; the reason gives way. */}
                      <ItemContent className="shrink-0">
                        <ItemTitle>
                          <span className="truncate">{action.label}</span>
                        </ItemTitle>
                      </ItemContent>
                      {/* A disabled row says why: a phone shows no tooltip. */}
                      {(action.disabled && action.disabledReason) ||
                      action.hint ? (
                        <ItemActions className="min-w-0 shrink text-xs text-muted-foreground">
                          <span className="truncate">
                            {action.disabled && action.disabledReason
                              ? action.disabledReason
                              : action.hint}
                          </span>
                        </ItemActions>
                      ) : null}
                    </Item>
                  ))}
                </>
              ) : null}
              {diffView ? (
                <>
                  {actions.length > 0 ? <Separator /> : null}
                  <SheetGroupLabel>Diff view</SheetGroupLabel>
                  {diffView.showStyle
                    ? DIFF_STYLES.map((style) => (
                        <SheetCheckRow
                          key={style.value}
                          role="menuitemradio"
                          icon={style.icon}
                          label={style.label}
                          checked={diffView.prefs.diffStyle === style.value}
                          onSelect={() =>
                            diffView.onUpdate({ diffStyle: style.value })
                          }
                        />
                      ))
                    : null}
                  {DIFF_VIEW_SWITCHES.map(({ pref, label }) => (
                    <SheetCheckRow
                      key={pref}
                      icon={DIFF_SWITCH_ICONS[pref]}
                      label={label}
                      checked={diffView.prefs[pref]}
                      onSelect={() =>
                        diffView.onUpdate({ [pref]: !diffView.prefs[pref] })
                      }
                    />
                  ))}
                </>
              ) : null}
              {ignoredFiles ? (
                <>
                  {actions.length > 0 || diffView ? <Separator /> : null}
                  <SheetGroupLabel>Files</SheetGroupLabel>
                  <Item
                    size="sm"
                    render={<button type="button" />}
                    role="menuitemcheckbox"
                    aria-checked={ignoredFiles.shown}
                    onClick={() => ignoredFiles.onChange(!ignoredFiles.shown)}
                  >
                    <ItemMedia variant="icon">
                      <Eye />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>Show ignored files</ItemTitle>
                    </ItemContent>
                    <ItemActions>
                      {ignoredFiles.shown ? <Check size={14} /> : null}
                    </ItemActions>
                  </Item>
                </>
              ) : null}
            </div>
          </EdgeSheet>
        </>
      ) : actions.length > 0 || ignoredFiles || diffView ? (
        <OverflowMenu
          label="Worktree actions"
          size="icon"
          contentClassName="min-w-56"
        >
          {actions.map((action) => (
            <DropdownMenuItem
              key={action.key}
              disabled={action.disabled || action.busy}
              title={action.disabled ? action.disabledReason : action.hint}
              onClick={action.onRun}
            >
              {action.icon}
              {action.label}
              {action.disabled && action.disabledReason ? (
                <span className="ml-auto pl-3 text-xs text-muted-foreground">
                  {action.disabledReason}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
          {diffView ? (
            <>
              {actions.length > 0 ? <DropdownMenuSeparator /> : null}
              {diffView.showStyle ? (
                <DropdownMenuRadioGroup
                  value={diffView.prefs.diffStyle}
                  onValueChange={(next) =>
                    diffView.onUpdate({ diffStyle: next as Prefs["diffStyle"] })
                  }
                >
                  {DIFF_STYLES.map((style) => (
                    <DropdownMenuRadioItem
                      key={style.value}
                      value={style.value}
                      closeOnClick={false}
                    >
                      {style.icon}
                      {style.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              ) : null}
              {DIFF_VIEW_SWITCHES.map(({ pref, label }) => (
                <DropdownMenuCheckboxItem
                  key={pref}
                  checked={diffView.prefs[pref]}
                  closeOnClick={false}
                  onCheckedChange={(checked) =>
                    diffView.onUpdate({ [pref]: checked })
                  }
                >
                  {DIFF_SWITCH_ICONS[pref]}
                  {label}
                </DropdownMenuCheckboxItem>
              ))}
            </>
          ) : null}
          {ignoredFiles ? (
            <>
              {actions.length > 0 || diffView ? (
                <DropdownMenuSeparator />
              ) : null}
              <DropdownMenuCheckboxItem
                checked={ignoredFiles.shown}
                closeOnClick={false}
                onCheckedChange={(checked) => ignoredFiles.onChange(checked)}
              >
                <Eye />
                Show ignored files
              </DropdownMenuCheckboxItem>
            </>
          ) : null}
        </OverflowMenu>
      ) : null}
    </div>
  );
}

const NO_SESSIONS: readonly SessionListItem[] = [];

const OVERVIEW_TAB: { id: WorktreeView; label: string } = {
  id: "overview",
  label: "Overview",
};

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
  browseAsDocuments = false,
  documentComments,
  sidebarNavigation = false,
  sessions,
  sessionsFresh = false,
  onRemoveWorktree,
  onMergeWorktree,
  onStartSessionInWorktree,
  project,
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
  // One delivery for the page: the Overview shows its facts, a phone's header
  // menu its actions. Not for a document folder (the Knowledge Base).
  const delivery = useWorktreeDelivery({
    worktree: browseAsDocuments ? undefined : worktree,
    ...(status !== undefined ? { status } : {}),
  });
  const retire = useWorktreeRetire({
    worktree: browseAsDocuments || worktree.isMain ? undefined : worktree,
    ...(delivery.status !== undefined ? { status: delivery.status } : {}),
    sessions: (sessions ?? NO_SESSIONS) as SessionListItem[],
    sessionsFresh,
    merged: delivery.hosting?.pr?.state === "merged",
  });
  // The worktree's ONE action list, the header menu's on every layout: the
  // object panel keeps the facts and the links.
  const menuActions = useMemo(
    () =>
      browseAsDocuments ||
      !onStartSessionInWorktree ||
      !onMergeWorktree ||
      !onRemoveWorktree
        ? []
        : worktreeInspectorActions(worktree, {
            onStartSession: onStartSessionInWorktree,
            onMerge: onMergeWorktree,
            onRemove: onRemoveWorktree,
            onRetire: retire.open,
            retireBusy: retire.busy,
            deliveryActions: delivery.actions,
          }),
    [
      browseAsDocuments,
      worktree,
      onStartSessionInWorktree,
      onMergeWorktree,
      onRemoveWorktree,
      retire.open,
      retire.busy,
      delivery.actions,
    ],
  );
  const [ignoredShown, setIgnoredShown] = useIgnoredFilesShown(worktree.id);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [filePivot, setFilePivot] = useState<FilePivot>("file");
  // Same default rule ChangesView applies, so the view-options segment and the
  // comment-following below both know what the pane is actually doing.
  const reviewLayout = sidebarNavigation
    ? "changeset"
    : (prefs.worktreeReviewMode ?? (narrow ? "changeset" : "by-file"));

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

  // The full page switches views from its header (wide) or the dock row (a
  // phone): no tab row. The session panel's Worktree tab keeps its tabs.
  const navigationControls = sidebarNavigation ? null : (
    <Tabs
      value={view}
      onValueChange={(next: WorktreeView) =>
        navigate(
          worktreePath(
            worktree.id,
            next,
            next === "changes"
              ? {
                  ...(from !== undefined ? { from } : {}),
                  ...(to !== undefined ? { to } : {}),
                }
              : {},
          ),
        )
      }
    >
      <TabsList variant="line">
        {(browseAsDocuments ? VIEW_TABS : [OVERVIEW_TAB, ...VIEW_TABS]).map(
          (tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ),
        )}
      </TabsList>
    </Tabs>
  );
  const viewOptionsControl = (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Diff view options"
          />
        }
      >
        <SlidersHorizontal />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto">
        {/* By-file vs changeset is a RENDERING choice like unified vs split, so
            it belongs in here rather than as a second segmented control in the
            toolbar competing with the tabs and the scope. */}
        {view === "changes" && !filePath && !sidebarNavigation ? (
          <Field>
            <FieldLabel>Review layout</FieldLabel>
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              className="w-full"
              value={[reviewLayout]}
              onValueChange={(next) => {
                if (next[0])
                  onUpdatePrefs({ worktreeReviewMode: next[0] as ReviewMode });
              }}
            >
              <ToggleGroupItem value="by-file" className="flex-1">
                By file
              </ToggleGroupItem>
              <ToggleGroupItem value="changeset" className="flex-1">
                All files
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
        ) : null}
        <DiffModeToolbar
          prefs={effectivePrefs}
          onUpdate={onUpdatePrefs}
          showStyleToggle={!narrow}
        />
      </PopoverContent>
    </Popover>
  );

  // The open file's folder in a document folder's header ("Knowledge Base" at
  // its root); the Changes view names the folder itself.
  const documentFolder =
    filePath && view === "files"
      ? splitWorktreePath(filePath).dir || (title ?? worktree.branch)
      : (title ?? worktree.branch);
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
        <div
          className={
            // The worktree screen runs UNDER the phone's resting dock, as the
            // list screens run under the nav card: the page takes back the
            // space the shell reserved, and each scroller pads its end by it.
            sidebarNavigation && !embedded
              ? "flex h-[calc(100%+var(--app-bottom-chrome-inset,0px))] min-h-0 shrink-0 flex-col [&_[data-dock-scroll]]:pb-[var(--app-bottom-chrome-inset,0px)] [&_[data-dock-scroll]]:overscroll-none"
              : "flex h-full min-h-0 flex-col"
          }
        >
          {/* ONE identity row, the shape every other object page uses: the branch, and
            a glyph that copies the worktree PATH — the thing you actually paste (into
            a terminal), and which used to sit in a subtitle that truncated to
            uselessness on a phone. The path is stated in full by the panel's
            Checkout facts, and the dirty counts the chips repeated are now the
            Delivery section's plus the changed-files header in the pane itself. */}
          {browseAsDocuments ? (
            // A document folder: the header is the open FILE (its name, and
            // where in the folder it sits), the way any document page reads.
            <PageHeader
              back={back}
              // The standard compact row, as a chat session's: the name, and
              // a small second line under it inside the same height.
              density="compact"
              icon={filePath ? <FileText size={16} /> : <BookOpen size={16} />}
              title={
                <div className="flex min-w-0 flex-col">
                  <h2 className="truncate text-sm font-semibold tracking-tight text-foreground">
                    {filePath && view === "files"
                      ? splitWorktreePath(filePath).name
                      : view === "changes"
                        ? "Uncommitted changes"
                        : (title ?? worktree.branch)}
                  </h2>
                  {/* The folder, cut from the LEFT: its tail (the nearest
                    folders) is what tells two files apart, not the shared
                    root. */}
                  <p
                    className="truncate text-left text-xs text-muted-foreground"
                    dir="rtl"
                    title={documentFolder}
                  >
                    <span dir="ltr">{documentFolder}</span>
                  </p>
                </div>
              }
              actions={
                <>
                  {embedded ? (
                    headerActions
                  ) : filePath ? (
                    <DocumentNavigationActions
                      className="hidden desktop:flex"
                      showClose={false}
                    />
                  ) : null}
                  {/* A phone has room for one header row, so the file's pivots
                    move off their own toolbar into its overflow. */}
                  {narrow && filePath && view === "files" ? (
                    <OverflowMenu
                      label="File view"
                      size="icon"
                      contentClassName="min-w-48"
                    >
                      <DropdownMenuRadioGroup
                        value={filePivot}
                        onValueChange={(next) =>
                          setFilePivot(next as FilePivot)
                        }
                      >
                        {filePivotsFor(filePath, worktree.isMain).map(
                          ({ id, label, icon }) => (
                            <DropdownMenuRadioItem key={id} value={id}>
                              {icon}
                              {label}
                            </DropdownMenuRadioItem>
                          ),
                        )}
                      </DropdownMenuRadioGroup>
                    </OverflowMenu>
                  ) : null}
                </>
              }
            />
          ) : (
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
              // One row of identity, as the Task page's id: the branch, muted
              // and mono. The Overview's body carries it as the title.
              // Rightmost: after the header's own comment and Start session.
              menu={
                embedded ? undefined : (
                  <WorktreeHeaderActions
                    actions={menuActions}
                    // A wide header draws Add comment itself.
                    showComment={narrow}
                    // The sidebar lists the files on a wide screen; a phone
                    // jumps through the header.
                    onJumpToFile={
                      sidebarNavigation && narrow && view === "changes"
                        ? () => setJumpOpen(true)
                        : undefined
                    }
                    diffView={
                      sidebarNavigation &&
                      (view === "changes" || (view === "files" && filePath))
                        ? {
                            prefs: effectivePrefs,
                            onUpdate: onUpdatePrefs,
                            showStyle: !narrow,
                          }
                        : undefined
                    }
                    ignoredFiles={
                      browseAsDocuments
                        ? undefined
                        : { shown: ignoredShown, onChange: setIgnoredShown }
                    }
                  />
                )
              }
              title={
                <span className="truncate font-mono text-sm text-muted-foreground">
                  {title ?? worktree.branch}
                </span>
              }
              actions={
                embedded ? (
                  headerActions
                ) : (
                  <>
                    {filePath ? (
                      <DocumentNavigationActions className="hidden desktop:flex" />
                    ) : null}
                    {sidebarNavigation && !narrow ? (
                      // The views, as the dock row draws them on a phone.
                      <ToggleGroup
                        variant="outline"
                        size="sm"
                        spacing={0}
                        aria-label="Worktree view"
                        value={[view]}
                        onValueChange={(next) => {
                          const picked = next[0] as WorktreeView | undefined;
                          if (!picked) return;
                          navigate(
                            worktreePath(
                              worktree.id,
                              picked,
                              picked === "changes"
                                ? {
                                    ...(from !== undefined ? { from } : {}),
                                    ...(to !== undefined ? { to } : {}),
                                  }
                                : {},
                            ),
                          );
                        }}
                      >
                        {WORKTREE_VIEWS.map((item) => (
                          <ToggleGroupItem
                            key={item.id}
                            value={item.id}
                            aria-label={item.label}
                            title={item.label}
                          >
                            {item.icon(14)}
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                    ) : null}
                  </>
                )
              }
            />
          )}
          {view === "overview" ? (
            <WorktreeOverview
              worktree={worktree}
              status={status}
              project={project}
              delivery={delivery}
              retire={retire}
              onRemove={onRemoveWorktree}
              sessions={sessions}
              navigate={navigate}
              toolbar={
                navigationControls ? (
                  <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-1.5">
                    {navigationControls}
                  </div>
                ) : null
              }
            />
          ) : view === "files" ? (
            <FilesView
              sidebarNavigation={sidebarNavigation}
              worktree={worktree}
              narrow={narrow}
              filePath={filePath}
              navigate={navigate}
              prefs={effectivePrefs}
              onUpdatePrefs={onUpdatePrefs}
              refreshToken={refreshToken}
              anchor={anchor}
              navigationControls={navigationControls}
              viewOptionsControl={sidebarNavigation ? null : viewOptionsControl}
              pivot={filePivot}
              onPivotChange={setFilePivot}
              markdownPreviewFirst={markdownPreviewFirst}
              browseAsDocuments={browseAsDocuments}
              documentComments={documentComments}
              commentsConfigFor={commentsConfigFor}
            />
          ) : (
            <ChangesView
              sidebarNavigation={sidebarNavigation}
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
              viewOptionsControl={sidebarNavigation ? null : viewOptionsControl}
              commentsConfigFor={commentsConfigFor}
              jumpOpen={jumpOpen}
              onJumpOpenChange={setJumpOpen}
            />
          )}
          {delivery.dialogs}
          {retire.dialog}
        </div>
      </DiffCommentBarProvider>
    </DiffWorkerProvider>
  );
}
