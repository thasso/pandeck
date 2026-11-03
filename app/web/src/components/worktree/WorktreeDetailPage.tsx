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
  type ReactNode,
} from "react";
import {
  BookOpen,
  Check,
  FolderOpen,
  Columns2,
  Files,
  Rows2,
  Space,
  UnfoldVertical,
  WholeWord,
  WrapText,
  Download,
  ExternalLink,
  Eye,
  File,
  FileText,
  GitBranch,
  GitCompareArrows,
  History,
  MessageSquareQuote,
  SendHorizontal,
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
} from "@assistant/shared";
import { openedFromOutsideWorktree } from "./worktreeViews.tsx";
import { PageHeader, type PageHeaderBack } from "../PageHeader.tsx";
import {
  DocumentNavigationActions,
  useDocumentNavigationRegistration,
  DocumentNavigationMarker,
  useDocumentScrollRestoration,
} from "../DocumentNavigationShell.tsx";
import { Button } from "../ui/button.tsx";
import { Badge } from "../ui/badge.tsx";
import { useCommentActuation } from "../review/CommentActuation.tsx";
import { useWorktreeDelivery } from "./WorktreeDelivery.tsx";
import { useWorktreeRetire } from "./useWorktreeRetire.tsx";
import { worktreeInspectorActions } from "../objectInspectors.tsx";
import { useIgnoredFilesShown } from "../../lib/worktreeIgnoredFiles.ts";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.tsx";
import { zoomMenuGroup } from "../DocumentZoom.tsx";
import {
  actionMenuItems,
  type HeaderMenuGroup,
} from "../common/HeaderMenu.tsx";
import { useMobileLayout } from "../shell/useMobileLayout.ts";
import { DIFF_VIEW_SWITCHES } from "../diff/DiffModeToolbar.tsx";
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
import { IconButton } from "../common/IconButton.tsx";
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
  WorktreeFileNavigator,
  buildChangeNavigatorEntries,
  directoryPathsFromNavigatorEntries,
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
  /** For the Overview's sessions working here. */
  sessions?: readonly SessionListItem[] | undefined;
  /** `sessions` answered in this socket episode: Retire may count them. */
  sessionsFresh?: boolean;
  /** Opens the app's Remove dialog for this worktree. */
  onRemoveWorktree?: ((id: string) => void) | undefined;
  /** Opens the app's Merge back dialog for this worktree. */
  onMergeWorktree?: ((id: string) => void) | undefined;
  onStartSessionInWorktree?: ((id: string) => void) | undefined;
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

/* --------------------------------- changes --------------------------------- */

/** One identity for "no changed files yet" (see `changeFiles` below). */
const NO_CHANGE_FILES: WorktreeChangeFile[] = [];

function ChangesView({
  worktree,
  narrow,
  filePath,
  from,
  to,
  prefs,
  refreshToken,
  commentsConfigFor,
  jumpOpen,
  onJumpOpenChange,
}: {
  /** Jump to file, opened from the page header (the narrow layout's sheet). */
  jumpOpen: boolean;
  onJumpOpenChange: (open: boolean) => void;
  worktree: WorktreeRecord;
  narrow: boolean;
  filePath?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  prefs: Prefs;
  refreshToken: number;
  /** Comment config for a file; `current` = the shown new side is working-tree content, else `refOid` names its commit. */
  commentsConfigFor: (
    path: string,
    current: boolean,
    refOid?: string,
  ) => LineCommentsConfig | undefined;
}) {
  const scope = useMemo(() => scopeFromRoute(from, to), [from, to]);
  const [expandedChangeDirs, setExpandedChangeDirs] = useState<string[]>([]);

  // The worktree AND the scope are the fetch key, which is what makes trusting
  // `changes` structural (R3): a switch of either drops the previous answer
  // during render, so nothing can select or diff a file off a list that belongs
  // to another scope.
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
  // A SHARED empty array while the list is unanswered: a fresh `[]` per render
  // re-derives the navigator entries, whose effect then rewrites the expanded
  // directories, which renders again — a render loop that spun for as long as
  // the fetch took.
  const changeFiles = changes?.files ?? NO_CHANGE_FILES;
  const changeEntries = useMemo(
    () => buildChangeNavigatorEntries(changeFiles),
    [changeFiles],
  );

  useEffect(() => {
    setExpandedChangeDirs(directoryPathsFromNavigatorEntries(changeEntries));
  }, [changeEntries]);

  // Viewed tracking + jump-to-file section registry.
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
  // A file picked in the sidebar arrives as the route's path: scroll the
  // changeset to it, retrying while its lazily mounted section appears. Then
  // HOLD it there for a moment: the jump brings its neighbours near the
  // viewport, their diffs load and grow above it, and a single scroll ends up
  // with the file pushed out of view again. Any scroll of the reader's own
  // ends the hold.
  const changesLoaded = changes !== undefined;
  useEffect(() => {
    if (!filePath || !changesLoaded) return;
    let frame = 0;
    let tries = 0;
    let held = 0;
    let released = false;
    const release = () => {
      released = true;
    };
    const userInput = ["wheel", "touchstart", "pointerdown", "keydown"];
    for (const type of userInput)
      window.addEventListener(type, release, { capture: true, passive: true });
    const attempt = () => {
      if (released) return;
      const section = sectionsRef.current.get(filePath);
      if (!section) {
        if (tries++ < 30) frame = requestAnimationFrame(attempt);
        return;
      }
      const scroller = section.closest<HTMLElement>("[data-dock-scroll]");
      const offset = scroller
        ? section.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top
        : 0;
      if (held === 0 || Math.abs(offset) > 1)
        section.scrollIntoView({ block: "start" });
      // About a second and a half of frames: long enough for the diffs
      // around it to load and lay out.
      if (held++ < 90) frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => {
      cancelAnimationFrame(frame);
      for (const type of userInput)
        window.removeEventListener(type, release, { capture: true });
    };
  }, [filePath, changesLoaded]);
  // The changeset stacks every file in one scroller; a wide page lists them in
  // the sidebar, a phone or a side panel jumps through the header's sheet.
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* R2: a refresh that failed keeps the changed files it already has and
        says so above them. */}
      {changesError === undefined ? null : (
        <ErrorNote
          className="mx-3 mt-2 shrink-0"
          message={`Could not refresh the changes: ${changesError}`}
          onRetry={changesFetch.reload}
        />
      )}
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
      {phone || narrow ? (
        <EdgeSheet
          open={jumpOpen}
          title="Jump to file"
          onClose={() => onJumpOpenChange(false)}
        >
          <WorktreeFileNavigator
            entries={changeEntries}
            expandedDirectoryPaths={expandedChangeDirs}
            onExpandedDirectoryPathsChange={setExpandedChangeDirs}
            onSelectFile={(entry) => {
              onJumpOpenChange(false);
              // Let the sheet unmount first, then scroll the section into view.
              requestAnimationFrame(() => jumpToFile(entry.path));
            }}
            emptyLabel="No changes in this scope."
            showChangeStats
            ariaLabel="Changed files"
          />
        </EdgeSheet>
      ) : null}
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

const README_NAMES = ["readme.md", "readme.markdown", "readme", "readme.txt"];

/**
 * The worktree's top-level README, for the Files view to open on when no file
 * is picked (the sidebar browses; the page shows what the folder says about
 * itself). Undefined while unknown or when there is none.
 */
function useWorktreeReadme(
  worktreeId: string,
  enabled: boolean,
): string | undefined {
  const [readme, setReadme] = useState<{ id: string; path: string | null }>();
  useEffect(() => {
    if (!enabled || readme?.id === worktreeId) return;
    let cancelled = false;
    fetchWorktreeTree(worktreeId, "", false).then(
      (entries) => {
        if (cancelled) return;
        const byName = new Map(
          entries
            .filter((entry) => entry.kind === "file")
            .map((entry) => [entry.name.toLowerCase(), entry.path]),
        );
        const path =
          README_NAMES.map((name) => byName.get(name)).find(Boolean) ?? null;
        setReadme({ id: worktreeId, path });
      },
      () => {
        if (!cancelled) setReadme({ id: worktreeId, path: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, worktreeId, readme?.id]);
  return enabled && readme?.id === worktreeId
    ? (readme.path ?? undefined)
    : undefined;
}

/**
 * A phone's file browser: the worktree's tree, with its changes marked, in a
 * sheet from the page header on every view. Mounted only while open, so its
 * listings load when asked for.
 */
function WorktreeBrowseSheet({
  worktree,
  open,
  onClose,
  selectedPath,
  refreshToken,
  navigate,
}: {
  worktree: WorktreeRecord;
  open: boolean;
  onClose: () => void;
  selectedPath?: string | undefined;
  refreshToken: number;
  navigate: (path: string) => void;
}) {
  return (
    <EdgeSheet open={open} title="Files" onClose={onClose}>
      {open ? (
        <WorktreeBrowseTree
          worktree={worktree}
          selectedPath={selectedPath}
          refreshToken={refreshToken}
          onPick={(path) => {
            onClose();
            navigate(worktreePath(worktree.id, "files", { path }));
          }}
        />
      ) : null}
    </EdgeSheet>
  );
}

function WorktreeBrowseTree({
  worktree,
  selectedPath,
  refreshToken,
  onPick,
}: {
  worktree: WorktreeRecord;
  selectedPath?: string | undefined;
  refreshToken: number;
  onPick: (path: string) => void;
}) {
  const tree = useWorktreeFileTree({
    worktreeId: worktree.id,
    filePath: selectedPath,
    refreshToken,
  });
  const changes = useWorktreeFileChanges(worktree, refreshToken);
  return (
    <WorktreeFileTree
      tree={tree}
      changes={changes}
      selectedPath={selectedPath}
      onSelectFile={(entry) => onPick(entry.path)}
      ariaLabel="Worktree files"
    />
  );
}

function FilesView({
  worktree,
  narrow,
  filePath,
  navigate,
  prefs,
  refreshToken,
  anchor,
  pivot,
  onPivotChange,
  markdownPreviewFirst,
  browseAsDocuments,
  documentComments,
  commentsConfigFor,
}: {
  worktree: WorktreeRecord;
  narrow: boolean;
  filePath?: string | undefined;
  navigate: (path: string) => void;
  prefs: Prefs;
  refreshToken: number;
  anchor?: DocumentLineAnchor | undefined;
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
        // In the file bar beside the name: quiet icons, the bar's own weight.
        size="sm"
        spacing={0}
        aria-label="File view"
        value={[pivot]}
        onValueChange={(next) => {
          if (next[0]) onPivotChange(next[0] as FilePivot);
        }}
      >
        {pivots.map(({ id, label, icon }) => (
          <ToggleGroupItem key={id} value={id} aria-label={label} title={label}>
            {icon}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    ) : null;

  return (
    <>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-card">
        {/* A worktree's file bar: the name and folder, the pivots at the end
          (a document folder's header already names the file). */}
        {selectedParts && !browseAsDocuments ? (
          <div className="flex items-center gap-2 border-b border-border bg-background/40 px-3 py-1.5 text-sm text-muted-foreground">
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
              {shownRefresh !== null ? (
                <RefreshIndicator className="shrink-0" label={shownRefresh} />
              ) : null}
            </div>
            {pivotControls ? (
              <div className="ml-auto shrink-0">{pivotControls}</div>
            ) : null}
          </div>
        ) : null}
        {filePath ? (
          <>
            {browseAsDocuments && shownRefresh !== null ? (
              // No bar to carry R2's marker here, so it floats over the pane.
              <RefreshIndicator
                className="absolute right-3 top-2 z-10"
                label={shownRefresh}
              />
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
                  // Edge to edge, as Review's diffs: the pane is the frame.
                  <div className="flex flex-col">
                    {fileError !== undefined ? (
                      <ErrorNote
                        className="m-3"
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
          <div className="p-6 text-sm text-muted-foreground">
            {browseAsDocuments
              ? "Pick a file in the sidebar to read it."
              : narrow
                ? "No README here. Browse the files to open one."
                : "No README here. Pick a file in the sidebar to open it."}
          </div>
        )}
      </div>
    </>
  );
}

/* ---------------------------------- page ----------------------------------- */

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

/** The diff display options, where a diff can be on screen. */
interface DiffViewMenu {
  prefs: Prefs;
  onUpdate: (patch: Partial<Prefs>) => void;
  /** Unified/split: a narrow screen always renders unified. */
  showStyle: boolean;
}

function diffViewMenuGroups(diffView: DiffViewMenu): HeaderMenuGroup[] {
  return [
    ...(diffView.showStyle
      ? [
          {
            key: "diff-style",
            label: "Diff view",
            choice: true,
            items: DIFF_STYLES.map((style) => ({
              key: style.value,
              icon: style.icon,
              label: style.label,
              checked: diffView.prefs.diffStyle === style.value,
              keepOpen: true,
              onSelect: () => diffView.onUpdate({ diffStyle: style.value }),
            })),
          },
        ]
      : []),
    {
      key: "diff-options",
      ...(diffView.showStyle ? {} : { label: "Diff view" }),
      items: DIFF_VIEW_SWITCHES.map(({ pref, label }) => ({
        key: pref,
        icon: DIFF_SWITCH_ICONS[pref],
        label,
        checked: diffView.prefs[pref],
        onSelect: () => diffView.onUpdate({ [pref]: !diffView.prefs[pref] }),
      })),
    },
  ];
}

/**
 * A document folder's page header (the `/knowledge` route): the open file's
 * pivots as icons, then Back and Forward. A phone has room for one header row,
 * so there its pivots are rows of the header's `…` (`documentPivotMenuGroup`).
 */
function DocumentPageActions({
  narrow,
  pivots,
  pivot,
  onPivotChange,
  showHistory,
}: {
  narrow: boolean;
  /** The open file's pivots; empty with no file open. */
  pivots: readonly FilePivotOption[];
  pivot: FilePivot;
  onPivotChange: (pivot: FilePivot) => void;
  showHistory: boolean;
}) {
  return (
    <>
      {!narrow && pivots.length > 1 ? (
        <ToggleGroup
          size="sm"
          spacing={0}
          aria-label="File view"
          value={[pivot]}
          onValueChange={(next) => {
            if (next[0]) onPivotChange(next[0] as FilePivot);
          }}
        >
          {pivots.map(({ id, label, icon }) => (
            <ToggleGroupItem
              key={id}
              value={id}
              aria-label={label}
              title={label}
            >
              {icon}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}
      {showHistory ? (
        <DocumentNavigationActions
          className="hidden desktop:flex"
          showClose={false}
        />
      ) : null}
    </>
  );
}

function documentPivotMenuGroup(
  pivots: readonly FilePivotOption[],
  pivot: FilePivot,
  onPivotChange: (pivot: FilePivot) => void,
): HeaderMenuGroup {
  return {
    key: "file-view",
    label: "File view",
    choice: true,
    items:
      pivots.length > 1
        ? pivots.map(({ id, label, icon }) => ({
            key: id,
            icon,
            label,
            checked: id === pivot,
            onSelect: () => onPivotChange(id),
          }))
        : [],
  };
}

/**
 * The worktree header's own buttons, before its `…`: on a phone the browse and
 * jump sheets, and Add comment (and Submit review while comments wait), which a
 * wide header draws itself.
 */
function WorktreeHeaderButtons({
  showComment,
  onJumpToFile,
  onBrowseFiles,
}: {
  showComment: boolean;
  /** Opens the Jump to file sheet: Review's changed files on a phone. */
  onJumpToFile?: (() => void) | undefined;
  /** Opens the file tree sheet: the Files view's browser on a phone. */
  onBrowseFiles?: (() => void) | undefined;
}) {
  const actuation = useCommentActuation();
  const pendingCount = Math.max(0, actuation?.pendingCount ?? 0);
  const canComment = actuation?.canComment === true;
  const commentLabel = canComment
    ? (actuation?.commentLabel ?? "Add comment")
    : "Select text to comment";
  return (
    <div className="flex shrink-0 items-center gap-1">
      {onBrowseFiles ? (
        <IconButton label="Browse files" size="icon" onClick={onBrowseFiles}>
          <FolderOpen />
        </IconButton>
      ) : null}
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
    </div>
  );
}

const NO_SESSIONS: readonly SessionListItem[] = [];

export default function WorktreeDetailPage({
  worktree,
  back,
  status: pushedStatus,
  narrow,
  view,
  filePath: routeFilePath,
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
  sessions,
  sessionsFresh = false,
  onRemoveWorktree,
  onMergeWorktree,
  onStartSessionInWorktree,
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
  const [browseOpen, setBrowseOpen] = useState(false);
  // The sidebar browses, so the Files view opens on the README: the page
  // shows the folder's own account of itself rather than a second tree.
  const readmePath = useWorktreeReadme(
    worktree.id,
    view === "files" && !routeFilePath,
  );
  const filePath = routeFilePath ?? readmePath;
  const [filePivot, setFilePivot] = useState<FilePivot>("file");
  // The open file's pivots, for a document folder's header.
  const documentPivots =
    filePath && view === "files"
      ? filePivotsFor(filePath, worktree.isMain)
      : [];
  // Zoom is a `…` group on a wide page; a phone's is the dock's, and a side
  // panel's page is not the document the shell zooms.
  const navigation = useDocumentNavigationRegistration();
  const menuZoom = narrow ? undefined : navigation?.zoom;

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
      // Files needs the file open; Review stacks every file already, and its
      // lazily mounted section catches up while the scroll retries.
      if (view === "files")
        navigate(worktreePath(worktree.id, "files", { path }));
    },
    [navigate, view, worktree.id],
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
            !embedded
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
                        ? "Changes"
                        : (title ?? worktree.branch)}
                  </h2>
                  {view === "changes" ? (
                    // What Review is showing, and the way to change it.
                    <WorktreeScopePicker
                      trigger="subtitle"
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
                          }),
                        )
                      }
                    />
                  ) : (
                    // The folder, cut from the LEFT: its tail (the nearest
                    // folders) is what tells two files apart, not the shared
                    // root.
                    <p
                      className="truncate text-left text-xs text-muted-foreground"
                      dir="rtl"
                      title={documentFolder}
                    >
                      <span dir="ltr">{documentFolder}</span>
                    </p>
                  )}
                </div>
              }
              actions={
                <>
                  {embedded ? (
                    headerActions
                  ) : (
                    <DocumentPageActions
                      narrow={narrow}
                      pivots={documentPivots}
                      pivot={filePivot}
                      onPivotChange={setFilePivot}
                      showHistory={Boolean(filePath)}
                    />
                  )}
                </>
              }
              menu={{
                label: "Document actions",
                groups: [
                  ...(narrow
                    ? [
                        documentPivotMenuGroup(
                          documentPivots,
                          filePivot,
                          setFilePivot,
                        ),
                      ]
                    : []),
                  ...(menuZoom ? [zoomMenuGroup(menuZoom)] : []),
                ],
              }}
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
              // The header's one `…`, its rightmost control (`HeaderMenu`).
              menu={{
                label: "Worktree actions",
                groups: [
                  {
                    key: "actions",
                    label: "Actions",
                    items: actionMenuItems(menuActions),
                  },
                  ...(view === "changes" || (view === "files" && filePath)
                    ? diffViewMenuGroups({
                        prefs: effectivePrefs,
                        onUpdate: onUpdatePrefs,
                        showStyle: !narrow,
                      })
                    : []),
                  ...(menuZoom ? [zoomMenuGroup(menuZoom)] : []),
                  {
                    key: "files",
                    label: "Files",
                    items: [
                      {
                        key: "show-ignored",
                        icon: <Eye />,
                        label: "Show ignored files",
                        checked: ignoredShown,
                        onSelect: () => setIgnoredShown(!ignoredShown),
                      },
                    ],
                  },
                ],
              }}
              title={
                // `block`: an inline span's `truncate` never clips, and the
                // branch ran under the header's icons.
                <div className="flex min-w-0 flex-col">
                  <span className="block truncate font-mono text-sm text-muted-foreground">
                    {title ?? worktree.branch}
                  </span>
                  {/* What Review is showing, under the branch: the header's
                    small second line, and the way to change it. */}
                  {view === "changes" ? (
                    <WorktreeScopePicker
                      trigger="subtitle"
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
                            ...(routeFilePath ? { path: routeFilePath } : {}),
                          }),
                        )
                      }
                    />
                  ) : null}
                </div>
              }
              actions={
                <>
                  {embedded ? (
                    headerActions
                  ) : (
                    <>
                      {filePath ? (
                        <DocumentNavigationActions
                          className="hidden desktop:flex"
                          // The browser's own Back and Forward serve here, and
                          // Close only when the file came from outside the
                          // worktree (a chat): from the sidebar there is
                          // nothing to return to.
                          showHistory={false}
                          showClose={
                            Boolean(routeFilePath) &&
                            openedFromOutsideWorktree(worktree.id)
                          }
                        />
                      ) : null}
                    </>
                  )}
                  <WorktreeHeaderButtons
                    // A wide header draws Add comment itself.
                    showComment={narrow && !embedded}
                    // The sidebar lists the files on a wide screen; a phone
                    // jumps through the header.
                    onBrowseFiles={
                      narrow ? () => setBrowseOpen(true) : undefined
                    }
                    onJumpToFile={
                      narrow && view === "changes"
                        ? () => setJumpOpen(true)
                        : undefined
                    }
                  />
                </>
              }
            />
          )}
          {view === "files" ? (
            <FilesView
              worktree={worktree}
              narrow={narrow}
              filePath={filePath}
              navigate={navigate}
              prefs={effectivePrefs}
              refreshToken={refreshToken}
              anchor={anchor}
              pivot={filePivot}
              onPivotChange={setFilePivot}
              markdownPreviewFirst={
                markdownPreviewFirst || (!routeFilePath && Boolean(readmePath))
              }
              browseAsDocuments={browseAsDocuments}
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
              prefs={effectivePrefs}
              refreshToken={refreshToken}
              commentsConfigFor={commentsConfigFor}
              jumpOpen={jumpOpen}
              onJumpOpenChange={setJumpOpen}
            />
          )}
          {narrow ? (
            <WorktreeBrowseSheet
              worktree={worktree}
              open={browseOpen}
              onClose={() => setBrowseOpen(false)}
              selectedPath={routeFilePath}
              refreshToken={refreshToken}
              navigate={navigate}
            />
          ) : null}
          {delivery.dialogs}
          {retire.dialog}
        </div>
      </DiffCommentBarProvider>
    </DiffWorkerProvider>
  );
}
