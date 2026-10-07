import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  FolderKanban,
  GitBranch,
  House,
  Link2,
  MessageSquarePlus,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type {
  ProjectRecord,
  ProjectSummary,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import {
  AxesSummary,
  WorktreeLineDelta,
  WorktreeMergedBadge,
} from "./worktreeRowParts.tsx";
import { PageHeader, type PageHeaderBack } from "./PageHeader.tsx";
import { Markdown, type MarkdownPaObjectReference } from "./Markdown.tsx";
import { InlineEdit } from "./InlineEdit.tsx";
import { CollapsibleSection } from "./CollapsibleSection.tsx";
import { GhostIconButton } from "./common/GhostIconButton.tsx";
import { useDialogs } from "./common/dialogs.tsx";
import {
  EmptyBox,
  ErrorNote,
  PaneLoading,
  RefreshIndicator,
  Skeleton,
  Spinner,
} from "./common/load.tsx";
import {
  dataOf,
  errorOf,
  isPending,
  type LoadState,
} from "../lib/loadState.ts";
import { copyWithToast } from "../lib/clipboard.ts";
import { useListScroll } from "../hooks/useListScroll.ts";
import { worktreeAxes } from "../lib/worktreeAxes.ts";
import { usePerfRenderCount } from "../lib/perfStats.ts";

/**
 * @component ProjectDetailPage
 * @purpose Project detail page: Task-detail-style editor for one selected Project's core details, description, local paths, and repo-backed worktrees.
 * @useWhen A Project detail route such as /projects/:id is opened from the sidebar Projects tab.
 * @avoidWhen Browsing the registry list; the sidebar Projects tab owns list navigation/reordering.
 * @intent Detail-only page with PageHeader, foldable sections, structured add/remove controls, minimal empty states, and optimistic websocket saves. Worktree controls appear only once a repo/workspace local path is configured. The managed main checkout (the folder Clone provisions and auto-registers as a local path) is shown read-only in the Repository section and hidden from the editable Local paths list, so that list holds only ADDITIONAL manual mappings.
 */
function ProjectDetailPageView({
  back,
  projects,
  loaded,
  listError = null,
  failure,
  onDismissFailure,
  selectedId,
  onLoad,
  detailState,
  onLoadDetail,
  onOpenProjection,
  mutationStates = {},
  onBackToList,
  onSave,
  onCloneRepo,
  onRemoveClone,
  worktreeState,
  worktrees = null,
  onLoadWorktrees,
  worktreeStatuses = {},
  onOpenWorktree,
  onCreateWorktree,
  onStartSessionInWorktree,
  paObjectReferences = [],
  onOpenPaObject,
  renderTasks,
}: {
  /** Mobile screen back control (ui-shell.md, Small Screens). */
  back?: PageHeaderBack | undefined;
  projects: ProjectSummary[];
  loaded: boolean;
  listError?: string | null;
  /**
   * The failure this project is CARRYING (`docs/messaging.md`) — a write about
   * the project itself that no control on this page tracks. It stays until the
   * dismiss below or this project's own next write, on screen or not, which is
   * what makes it findable by coming back here.
   */
  failure?: string | undefined;
  onDismissFailure?: () => void;
  selectedId: string | null;
  /** Legacy explicit list read; subscribe is authoritative and this is unused. */
  onLoad?: () => void;
  detailState?: LoadState<ProjectRecord | null> | undefined;
  onLoadDetail?: (id: string) => void;
  onOpenProjection?: (id: string | null) => void;
  mutationStates?: Record<string, LoadState<true>>;
  onBackToList: () => void;
  onSave: (id: string, patch: Partial<ProjectRecord>) => void;
  /** Clone the project's `repoUrl` into its managed checkout. */
  onCloneRepo: (id: string) => void;
  /** Delete that managed clone. Refused server-side while worktrees remain. */
  onRemoveClone: (id: string) => void;
  /** Current-episode Worktree dependency state; retained rows are data, not freshness. */
  worktreeState?: LoadState<WorktreeRecord[]> | undefined;
  /** Legacy/static rendering input; live App surfaces pass worktreeState. */
  worktrees?: WorktreeRecord[] | null;
  onLoadWorktrees?: () => void;
  worktreeStatuses?: Record<string, WorktreeGitStatus>;
  onOpenWorktree?: (id: string) => void;
  onCreateWorktree?: (projectId: string) => void;
  onStartSessionInWorktree?: (id: string) => void;
  paObjectReferences?: MarkdownPaObjectReference[];
  onOpenPaObject?: (link: MarkdownPaObjectReference) => void;
  /**
   * The project's Task list. A render prop because the list is `BacklogList`,
   * which needs App's socket state/actions and is lazily loaded; the page just
   * decides where it sits among the project's other content.
   */
  renderTasks?: (projectId: string) => ReactNode;
}) {
  useEffect(() => {
    onOpenProjection?.(selectedId);
    return () => onOpenProjection?.(null);
  }, [onOpenProjection, selectedId]);

  useEffect(() => {
    if (!selectedId || !onLoadDetail) return;
    if (
      !detailState ||
      detailState.status === "idle" ||
      detailState.status === "loading" ||
      detailState.status === "refreshing"
    )
      onLoadDetail(selectedId);
  }, [detailState, onLoadDetail, selectedId]);

  // The page scrolls as one column (the project's Tasks, worktrees and sessions
  // are sections of it), and it is unmounted whenever one of those objects is
  // opened — so where the reader was is remembered per project.
  const scrollRef = useListScroll({
    listKey: selectedId ? `project:${selectedId}` : null,
  });

  const selected = selectedId
    ? (projects.find((project) => project.id === selectedId) ?? null)
    : null;
  const selectedDocument = detailState ? dataOf(detailState) : undefined;
  const beginRename = useRef<(() => void) | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const copyKey = selected?.key
    ? () => {
        const key = selected.key;
        void copyWithToast(key, { successMessage: `${key} copied` }).then(
          (ok) => {
            if (!ok) return;
            setKeyCopied(true);
            window.setTimeout(() => setKeyCopied(false), 1200);
          },
        );
      }
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* One row of IDENTITY, at every width: the glyph (which copies the key —
          the thing you type into a prompt or a branch name) and `KEY - Name`.
          The key prefix is what makes this row worth its height; the name alone
          is already the sidebar row you tapped to get here. Renaming is the
          row's one action, since the name lives nowhere else on the page; every
          other project action (archive, restore, delete, start a session) and
          the key/color settings belong to the object panel, at both widths.
          "archived" appears here only when it is true — a state you need to see
          even with the panel closed, never a control. */}
      <PageHeader
        back={back}
        density={selected ? "compact" : "default"}
        icon={
          keyCopied ? (
            <Check size={16} strokeWidth={2.5} />
          ) : (
            <FolderKanban size={16} />
          )
        }
        onIconClick={copyKey}
        iconLabel={
          selected?.key
            ? keyCopied
              ? "Copied!"
              : `Copy ${selected.key}`
            : undefined
        }
        title={
          selected ? (
            <InlineEdit
              value={selected.name}
              submitState={mutationStates[`${selected.id}:name`]}
              onSubmit={(name) => onSave(selected.id, { name: name.trim() })}
              ariaLabel="Project name"
              editorClassName="w-full rounded-md border border-border bg-background px-2 py-1 text-sm font-semibold text-foreground outline-none focus:border-primary"
              renderDisplay={(begin) => {
                beginRename.current = begin;
                return (
                  <h2 className="truncate text-sm">
                    {selected.key ? (
                      <>
                        <span className="select-all font-mono text-muted-foreground">
                          {selected.key}
                        </span>
                        <span className="text-muted-foreground"> - </span>
                      </>
                    ) : null}
                    <span className="font-semibold text-foreground">
                      {selected.name}
                    </span>
                  </h2>
                );
              }}
            />
          ) : (
            "Projects"
          )
        }
        subtitle={
          selected
            ? undefined
            : loaded
              ? `${projects.length} registered`
              : "Loading registry…"
        }
        actions={
          selected ? (
            <div className="flex items-center gap-1">
              {selected.status === "archived" ? (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-sm text-muted-foreground">
                  archived
                </span>
              ) : null}
              <GhostIconButton
                icon={<Pencil size={13} />}
                label="Rename Project"
                onClick={() => beginRename.current?.()}
              />
            </div>
          ) : null
        }
      />

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6"
      >
        {loaded && listError ? (
          <ErrorNote message={listError} onRetry={onLoad} />
        ) : null}
        {failure ? (
          <ErrorNote
            message={failure}
            onRetry={onDismissFailure}
            retryLabel="Dismiss"
            className="mb-3"
          />
        ) : null}
        {!loaded ? (
          listError ? (
            <ErrorNote message={listError} onRetry={onLoad} />
          ) : (
            <PaneLoading label="Loading projects…" className="h-full" />
          )
        ) : selected ? (
          selectedDocument ? (
            <>
              {detailState?.status === "refreshing" ? (
                <RefreshIndicator label="Refreshing Project…" />
              ) : detailState?.status === "error" ? (
                <ErrorNote
                  message={detailState.error}
                  onRetry={() => onLoadDetail?.(selected.id)}
                />
              ) : null}
              <ProjectDetail
                key={selected.id}
                project={selectedDocument}
                onSave={(patch) => onSave(selected.id, patch)}
                onClone={() => onCloneRepo(selected.id)}
                onRemoveClone={() => onRemoveClone(selected.id)}
                worktrees={
                  (worktreeState ? dataOf(worktreeState) : worktrees)?.filter(
                    (worktree) => worktree.projectId === selected.id,
                  ) ?? null
                }
                worktreesReady={
                  worktreeState
                    ? worktreeState.status === "ready"
                    : worktrees !== null
                }
                worktreeError={
                  worktreeState ? errorOf(worktreeState) : undefined
                }
                onLoadWorktrees={onLoadWorktrees}
                worktreeStatuses={worktreeStatuses}
                onOpenWorktree={onOpenWorktree}
                onCreateWorktree={onCreateWorktree}
                onStartSessionInWorktree={onStartSessionInWorktree}
                paObjectReferences={paObjectReferences}
                onOpenPaObject={onOpenPaObject}
                renderTasks={renderTasks}
                mutationStates={mutationStates}
              />
            </>
          ) : detailState?.status === "error" ? (
            <ErrorNote
              message={detailState.error}
              onRetry={() => onLoadDetail?.(selected.id)}
            />
          ) : (
            <ProjectDetailSkeleton />
          )
        ) : selectedId ? (
          <EmptyProjectsMessage
            title="Project not found"
            body="The selected project is not in the current registry list."
          />
        ) : projects.length === 0 ? (
          <EmptyProjectsMessage
            title="No projects yet"
            body="The project registry is empty."
          />
        ) : (
          <EmptyProjectsMessage
            title="Select a project"
            body="Open the Projects tab in the list view to choose a project."
            actionLabel="Open Projects list"
            onAction={onBackToList}
          />
        )}
      </div>
    </div>
  );
}

type ProjectDetailPageProps = Parameters<typeof ProjectDetailPageView>[0];

/** Memo boundary: an open document ignores changes to other Project rows. */
export function sameProjectDetailPageProps(
  previous: ProjectDetailPageProps,
  next: ProjectDetailPageProps,
): boolean {
  const previousRecord = previous as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  for (const key of new Set([
    ...Object.keys(previousRecord),
    ...Object.keys(nextRecord),
  ])) {
    if (key === "projects") continue;
    if (previousRecord[key] !== nextRecord[key]) return false;
  }
  if (previous.projects === next.projects) return true;
  if (!previous.selectedId) return false;
  return (
    previous.projects.find((project) => project.id === previous.selectedId) ===
    next.projects.find((project) => project.id === next.selectedId)
  );
}

export const ProjectDetailPage = memo(
  ProjectDetailPageView,
  sameProjectDetailPageProps,
);

function ProjectDetail({
  project,
  onSave,
  onClone,
  onRemoveClone,
  worktrees,
  worktreesReady,
  worktreeError,
  onLoadWorktrees,
  worktreeStatuses,
  onOpenWorktree,
  onCreateWorktree,
  onStartSessionInWorktree,
  paObjectReferences,
  onOpenPaObject,
  renderTasks,
  mutationStates,
}: {
  project: ProjectRecord;
  onSave: (patch: Partial<ProjectRecord>) => void;
  onClone: () => void;
  onRemoveClone: () => void;
  worktrees: WorktreeRecord[] | null;
  worktreesReady: boolean;
  worktreeError?: string | undefined;
  onLoadWorktrees?: (() => void) | undefined;
  worktreeStatuses: Record<string, WorktreeGitStatus>;
  onOpenWorktree?: ((id: string) => void) | undefined;
  onCreateWorktree?: ((projectId: string) => void) | undefined;
  onStartSessionInWorktree?: ((id: string) => void) | undefined;
  paObjectReferences: MarkdownPaObjectReference[];
  onOpenPaObject?: ((link: MarkdownPaObjectReference) => void) | undefined;
  renderTasks?: ((projectId: string) => ReactNode) | undefined;
  mutationStates: Record<string, LoadState<true>>;
}) {
  const beginDescriptionEdit = useRef<(() => void) | null>(null);
  const description = project.description ?? "";
  const cloneState = mutationStates[`${project.id}:clone`];
  const removeState = mutationStates[`${project.id}:remove`];
  const provisioning =
    cloneState && isPending(cloneState)
      ? "clone"
      : removeState && isPending(removeState)
        ? "remove"
        : null;
  const provisionError =
    cloneState && errorOf(cloneState)
      ? { action: "clone" as const, message: errorOf(cloneState)! }
      : removeState && errorOf(removeState)
        ? { action: "remove" as const, message: errorOf(removeState)! }
        : null;
  const showWorktrees = hasRepoLocalPath(project);
  // The project's main checkout (the folder the Clone/register action provisions
  // and auto-registers as a local path). Shown read-only in Repository so it does
  // not clutter the editable Local paths list as if it were a manual mapping.
  const mainCheckoutPath = worktrees?.find(
    (worktree) => worktree.isMain,
  )?.mainRepoRoot;
  return (
    <div className="mx-auto w-full max-w-[760px] px-1 py-2">
      <CollapsibleSection
        title="Description"
        storageKey={`project.collapse.${project.id}.description`}
        trailing={
          <GhostIconButton
            icon={<Pencil size={13} />}
            label="Edit description"
            onClick={() => beginDescriptionEdit.current?.()}
          />
        }
      >
        <InlineEdit
          value={description}
          submitState={mutationStates[`${project.id}:description`]}
          onSubmit={(next) => onSave({ description: next.trim() })}
          multiline
          allowEmpty
          ariaLabel="Project description"
          placeholder="Add a description…"
          editorClassName="min-h-[8rem] w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
          renderDisplay={(begin) => {
            // Editing is triggered only by the section's ghost edit button
            // (clicking prose selected text and entered edit mode too easily).
            beginDescriptionEdit.current = begin;
            return (
              <div className="min-h-[4rem] w-full py-1">
                {description.trim() ? (
                  <Markdown
                    text={description}
                    paObjectReferences={paObjectReferences}
                    onOpenPaObject={onOpenPaObject}
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">
                    No description yet. Use the edit button to add one.
                  </span>
                )}
              </div>
            );
          }}
        />
      </CollapsibleSection>

      {/* The project's Tasks and Worktrees are its CONTENT, so they live here
          rather than in the object panel — the panel used to list both beside a
          page that already showed the worktrees. Order follows use: what is to
          do, where the work happens, then the repository state you rarely
          touch. */}
      {renderTasks ? (
        <CollapsibleSection
          title="Tasks"
          storageKey={`project.collapse.${project.id}.tasks`}
        >
          {renderTasks(project.id)}
        </CollapsibleSection>
      ) : null}

      {showWorktrees ? (
        <CollapsibleSection
          title="Worktrees"
          storageKey={`project.collapse.${project.id}.worktrees`}
          trailing={
            onCreateWorktree ? (
              <GhostIconButton
                icon={<Plus size={13} />}
                label="New worktree"
                onClick={() => onCreateWorktree(project.id)}
              />
            ) : undefined
          }
        >
          <div className="flex flex-col gap-px px-1 pb-1">
            {worktrees === null ? (
              <div
                role="status"
                aria-label="Loading Project worktrees"
                className="flex flex-col gap-2 px-2 py-2"
              >
                <Skeleton className="h-7 w-full" />
                <Skeleton className="h-7 w-4/5" />
              </div>
            ) : worktrees.length === 0 ? (
              <p className="px-2 py-2 text-sm text-muted-foreground">
                No worktrees yet. Spawn one to let an agent work in isolation.
              </p>
            ) : (
              <ProjectWorktreeRows
                worktrees={worktrees}
                statuses={worktreeStatuses}
                onOpen={onOpenWorktree}
                onStartSession={onStartSessionInWorktree}
              />
            )}
          </div>
        </CollapsibleSection>
      ) : null}

      <RepositorySection
        project={project}
        checkoutPath={mainCheckoutPath}
        hasCheckout={showWorktrees}
        spawnedWorktrees={
          worktreesReady
            ? (worktrees?.filter((worktree) => !worktree.isMain).length ?? 0)
            : null
        }
        worktreeError={worktreeError}
        onLoadWorktrees={onLoadWorktrees}
        provisioning={provisioning}
        provisionError={provisionError}
        mutationState={mutationStates[`${project.id}:field:repoUrl`]}
        onSaveUrl={(repoUrl) =>
          onSave({ ...(repoUrl !== undefined ? { repoUrl } : {}) })
        }
        onClone={onClone}
        onRemoveClone={onRemoveClone}
      />
    </div>
  );
}

function ProjectWorktreeRows({
  worktrees,
  statuses,
  onOpen,
  onStartSession,
}: {
  worktrees: WorktreeRecord[];
  statuses: Record<string, WorktreeGitStatus>;
  onOpen?: ((id: string) => void) | undefined;
  onStartSession?: ((id: string) => void) | undefined;
}) {
  // One coarse wall clock serves every row. The row comparator folds it down
  // to the rendered stale/fresh bit, so minute ticks do not redraw siblings.
  const now = useCoarseNow(60_000);
  return worktrees.map((worktree) => (
    <ProjectWorktreeRow
      key={worktree.id}
      worktree={worktree}
      status={statuses[worktree.id]}
      now={now}
      onOpen={onOpen}
      onStartSession={onStartSession}
    />
  ));
}

interface ProjectWorktreeRowProps {
  worktree: WorktreeRecord;
  status?: WorktreeGitStatus | undefined;
  now: number;
  onOpen?: ((id: string) => void) | undefined;
  onStartSession?: ((id: string) => void) | undefined;
}

function ProjectWorktreeRowImpl({
  worktree,
  status,
  now,
  onOpen,
  onStartSession,
}: ProjectWorktreeRowProps) {
  usePerfRenderCount("ProjectWorktreeRow");
  const branch = status?.branch ?? worktree.branch;
  const axes = worktreeAxes(worktree, status, now);
  const BranchIcon = worktree.isMain ? House : GitBranch;

  return (
    <div
      data-project-worktree-row={worktree.id}
      className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-muted"
    >
      <BranchIcon size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
      <button
        type="button"
        onClick={() => onOpen?.(worktree.id)}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
        title={worktree.path}
      >
        <span
          data-worktree-primary
          className="flex min-w-0 max-w-full items-center gap-2"
        >
          <span className="truncate text-sm font-medium text-foreground">
            {branch}
          </span>
          <WorktreeLineDelta status={status} />
          <WorktreeMergedBadge status={status} />
        </span>
        <AxesSummary axes={axes} baseLabel={worktree.baseBranch} />
      </button>
      {onStartSession ? (
        <GhostIconButton
          revealOnHover
          icon={<MessageSquarePlus size={13} />}
          label="Start session in this worktree"
          onClick={() => onStartSession(worktree.id)}
        />
      ) : null}
    </div>
  );
}

/**
 * Status maps are replaced on watcher broadcasts, while the shared wall clock
 * ticks every minute. Props stay id-based and stable; `now` invalidates a row
 * only when the stale/fresh content it renders actually changes.
 */
const ProjectWorktreeRow = memo(
  ProjectWorktreeRowImpl,
  (previous, next) =>
    previous.worktree === next.worktree &&
    previous.status === next.status &&
    previous.onOpen === next.onOpen &&
    previous.onStartSession === next.onStartSession &&
    worktreeAxes(previous.worktree, previous.status, previous.now).stale ===
      worktreeAxes(next.worktree, next.status, next.now).stale,
);

function useCoarseNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * The Repository section states WHERE this project is checked out, and offers
 * the one action that state allows — nothing else.
 *
 * Not checked out: the URL is editable and the only button clones it. Checked
 * out: both rows are read-only and the only action deletes the clone, because
 * re-pointing a checkout that worktrees hang off is how you lose work — you
 * remove it and set a new URL. There is deliberately NO update/pull here:
 * keeping a checkout current belongs to the worktree surface, where the working
 * copy, its branch and its dirty state actually live. And Remove is offered only
 * once no spawned worktrees remain; it used to force-remove them for you, which
 * made this quietly the most destructive control on the page.
 */
function RepositorySection({
  project,
  checkoutPath,
  hasCheckout,
  spawnedWorktrees,
  worktreeError,
  onLoadWorktrees,
  provisioning,
  provisionError,
  mutationState,
  onSaveUrl,
  onClone,
  onRemoveClone,
}: {
  project: ProjectRecord;
  checkoutPath?: string | undefined;
  hasCheckout: boolean;
  spawnedWorktrees: number | null;
  worktreeError?: string | undefined;
  onLoadWorktrees?: (() => void) | undefined;
  provisioning: "clone" | "remove" | null;
  provisionError: {
    action: "clone" | "remove";
    message: string;
  } | null;
  mutationState?: LoadState<true> | undefined;
  onSaveUrl: (repoUrl: string | undefined) => void;
  onClone: () => void;
  onRemoveClone: () => void;
}) {
  const dialogs = useDialogs();
  const url = project.repoUrl?.trim() ?? "";
  const busy = provisioning !== null;
  const dependencyPending = spawnedWorktrees === null;
  const blocked = dependencyPending || spawnedWorktrees > 0;
  const confirmRemoveClone = async () => {
    const confirmed = await dialogs.confirm({
      title: `Remove the clone for “${project.name}”?`,
      body: (
        <>
          {checkoutPath ? (
            <span className="mb-1 block font-mono text-foreground">
              {checkoutPath}
            </span>
          ) : null}
          The folder is deleted from disk. Uncommitted work in it will be lost.
        </>
      ),
      confirmLabel: "Remove clone",
      danger: true,
    });
    if (confirmed) onRemoveClone();
  };
  // Both call sites below are `() => void` slots, so the confirmation runs
  // detached: `dialogs.confirm` settles rather than rejecting, and the removal
  // itself reports through `provisionError`.
  const removeClone = () => void confirmRemoveClone();
  return (
    <CollapsibleSection
      title="Repository"
      storageKey={`project.collapse.${project.id}.repository`}
      trailing={
        hasCheckout ? (
          <GhostIconButton
            danger
            busy={provisioning === "remove"}
            disabled={blocked}
            icon={<Trash2 size={13} />}
            label={
              dependencyPending
                ? "Checking worktrees before clone removal"
                : blocked
                  ? "Remove worktrees before removing the clone"
                  : "Remove the clone"
            }
            onClick={removeClone}
          />
        ) : undefined
      }
    >
      <div className="flex flex-col gap-1.5">
        {worktreeError ? (
          <ErrorNote message={worktreeError} onRetry={onLoadWorktrees} />
        ) : null}
        {dependencyPending && !worktreeError ? (
          <RefreshIndicator label="Checking dependent worktrees…" />
        ) : null}
        {provisionError ? (
          <ErrorNote
            message={provisionError.message}
            retryLabel={
              provisionError.action === "clone" ? "Retry clone" : "Retry remove"
            }
            onRetry={provisionError.action === "clone" ? onClone : removeClone}
          />
        ) : null}
        {hasCheckout ? (
          <>
            <RepoRow
              label="Checkout"
              icon={<GitBranch size={13} />}
              value={checkoutPath}
            />
            <RepoRow
              label="Origin"
              icon={<Link2 size={13} />}
              value={url}
              muted
            />
            {blocked ? (
              <p className="text-sm text-muted-foreground">
                {spawnedWorktrees} worktree{spawnedWorktrees === 1 ? "" : "s"}{" "}
                still use{spawnedWorktrees === 1 ? "s" : ""} this clone. Remove{" "}
                {spawnedWorktrees === 1 ? "it" : "them"} first to remove the
                clone itself.
              </p>
            ) : null}
          </>
        ) : (
          <>
            <InlineEdit
              value={url}
              submitState={mutationState}
              onSubmit={(next) => onSaveUrl(next.trim() || undefined)}
              allowEmpty
              ariaLabel="Repository URL"
              placeholder="git@host:owner/repo.git"
              editorClassName="w-full rounded-lg border border-border bg-background px-2 py-1 font-mono text-sm text-foreground outline-none focus:border-primary"
              renderDisplay={(begin) => (
                <RepoRow
                  label="Clone from"
                  icon={<Link2 size={13} />}
                  value={url}
                  placeholder="Set a repository URL"
                  onClick={begin}
                />
              )}
            />
            <div className="pt-1">
              <button
                type="button"
                disabled={!url || busy}
                aria-busy={provisioning === "clone" || undefined}
                onClick={onClone}
                title={
                  url
                    ? "Clone it under the Projects root and use it as this project's main checkout"
                    : "Set a repository URL first"
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
              >
                {provisioning === "clone" ? <Spinner size="sm" /> : null}
                {provisioning === "clone" ? "Cloning…" : "Clone"}
              </button>
            </div>
          </>
        )}
      </div>
    </CollapsibleSection>
  );
}

/** One read-only (or click-to-edit) repository row: label, glyph, mono value. */
function RepoRow({
  label,
  icon,
  value,
  placeholder,
  muted = false,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  value?: string | undefined;
  placeholder?: string;
  muted?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="w-[4.5rem] shrink-0 text-sm text-muted-foreground">
        {label}
      </span>
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      {/* A path or remote WRAPS rather than truncates: a truncated
          `ssh://git@host:2222/owner/re…` says nothing, and this is the value you
          read or copy out on a phone. */}
      <span
        className={`min-w-0 flex-1 select-all break-all font-mono text-sm ${value ? (muted ? "text-muted-foreground" : "text-foreground") : "text-muted-foreground"}`}
      >
        {value || placeholder}
      </span>
    </>
  );
  if (!onClick)
    return <div className="flex min-h-7 items-start gap-2 py-0.5">{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-7 w-full items-start gap-2 rounded-md py-0.5 text-left hover:bg-muted"
      title={`Edit ${label.toLowerCase()}`}
    >
      {body}
    </button>
  );
}

function hasRepoLocalPath(project: ProjectRecord): boolean {
  return (project.localPaths ?? []).some(
    (item) =>
      (item.kind === "repo" || item.kind === "workspace") &&
      Boolean(item.path?.trim()),
  );
}

function ProjectDetailSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading Project details"
      className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-1 py-2"
    >
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

function EmptyProjectsMessage({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center px-4">
      <EmptyBox
        className="bg-card"
        action={
          actionLabel && onAction ? (
            <button
              type="button"
              onClick={onAction}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {actionLabel}
            </button>
          ) : undefined
        }
      >
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="mt-1">{body}</div>
      </EmptyBox>
    </div>
  );
}

/** Compare two absolute paths, tolerating a trailing separator. */
