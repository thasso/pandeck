import { memo, useEffect, useMemo, useState } from "react";
import {
  Archive,
  Check,
  CircleDot,
  CornerLeftUp,
  Download,
  FolderKanban,
  GitBranch,
  GitFork,
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
import { WorktreeRow, compareWorktrees } from "./worktreeRowParts.tsx";
import { Tree } from "./common/Tree.tsx";
import { PageHeader, type PageHeaderBack } from "./PageHeader.tsx";
import { Markdown, type MarkdownPaObjectReference } from "./Markdown.tsx";
import { InspectorSection } from "./shell/Inspector.tsx";
import { PROPERTY_TRIGGER, PropertyLabel } from "./TaskPlanningSection.tsx";
import { TitleDescriptionEditor } from "./common/TitleDescriptionEditor.tsx";
import { ActionRow } from "./common/ActionRow.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import { EditableText } from "./common/EditableText.tsx";
import { Button } from "./ui/button.tsx";
import { useDialogs } from "./common/dialogs.tsx";
import {
  EmptyBox,
  ErrorNote,
  PaneLoading,
  RefreshIndicator,
  Skeleton,
} from "./common/load.tsx";
import {
  dataOf,
  errorOf,
  isPending,
  type LoadState,
} from "../lib/loadState.ts";
import { copyWithToast } from "../lib/clipboard.ts";
import { projectColor } from "../lib/projectDisplay.ts";
import { projectSaveOperation } from "../hooks/useAssistant.ts";
import { useListScroll } from "../hooks/useListScroll.ts";

/**
 * @component ProjectDetailPage
 * @purpose Project detail page: Task-detail-style editor for one selected Project's core details, description, local paths, and repo-backed worktrees.
 * @useWhen A Project detail route such as /projects/:id is opened from the sidebar Projects tab.
 * @avoidWhen Browsing the registry list; the sidebar Projects tab owns list navigation/reordering.
 * @intent Detail-only page with PageHeader, the name and description as the body, inspector-style sections, structured add/remove controls, minimal empty states, and optimistic websocket saves. Worktree controls appear only once a repo/workspace local path is configured. The managed main checkout (the folder Clone provisions and auto-registers as a local path) is shown read-only in the Repository section and hidden from the editable Local paths list, so that list holds only ADDITIONAL manual mappings.
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
  onOpenProject,
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
  /** Open another Project (the parent named under the title). */
  onOpenProject?: (id: string) => void;
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
      {/* One row of IDENTITY, as on the Task page: the glyph (in the
          project's colour; it copies the key — the thing you type into a prompt
          or a branch name) and the key. The name moved into the page body,
          where it wraps in full and is edited with the description. */}
      <PageHeader
        back={back}
        density={selected ? "compact" : "default"}
        icon={
          keyCopied ? (
            <Check size={16} strokeWidth={2.5} />
          ) : (
            <FolderKanban
              size={16}
              style={
                selected ? { color: projectColor(selected).dot } : undefined
              }
            />
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
            <span className="select-all truncate font-mono text-sm text-muted-foreground">
              {selected.key || selected.name}
            </span>
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
      />

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
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
                parent={
                  selectedDocument.parentId
                    ? projects.find(
                        (project) => project.id === selectedDocument.parentId,
                      )
                    : undefined
                }
                onOpenProject={onOpenProject}
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
  const before = previous.projects.find(
    (project) => project.id === previous.selectedId,
  );
  const after = next.projects.find((project) => project.id === next.selectedId);
  if (before !== after) return false;
  // The parent is named under the title, so a rename of it redraws too.
  const parentId = after?.parentId;
  return (
    !parentId ||
    previous.projects.find((project) => project.id === parentId) ===
      next.projects.find((project) => project.id === parentId)
  );
}

export const ProjectDetailPage = memo(
  ProjectDetailPageView,
  sameProjectDetailPageProps,
);

function ProjectDetail({
  project,
  parent,
  onOpenProject,
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
  mutationStates,
}: {
  project: ProjectRecord;
  parent?: ProjectSummary | undefined;
  onOpenProject?: ((id: string) => void) | undefined;
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
  mutationStates: Record<string, LoadState<true>>;
}) {
  const description = project.description ?? "";
  const [editing, setEditing] = useState(false);
  // The editor saves name and description as one patch, whose mutation key
  // depends on which of them changed: remember it to follow that save.
  const [editOperation, setEditOperation] = useState<string | null>(null);
  const editState = editOperation
    ? mutationStates[`${project.id}:${editOperation}`]
    : undefined;
  const archived = project.status === "archived";
  const repo = repoDisplay(project.repoUrl);
  const spawnedCount = worktrees?.filter((worktree) => !worktree.isMain).length;
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
    <div className="mx-auto w-full max-w-3xl">
      <div className="mb-6 flex flex-col gap-1.5">
        {editing ? (
          <TitleDescriptionEditor
            title={project.name}
            description={description}
            titleLabel="Project name"
            descriptionLabel="Project description"
            titlePlaceholder="Name"
            submitState={editState}
            onSave={(changes) => {
              const patch: Partial<ProjectRecord> = {
                ...(changes.title !== undefined ? { name: changes.title } : {}),
                ...(changes.description !== undefined
                  ? { description: changes.description.trim() }
                  : {}),
              };
              setEditOperation(projectSaveOperation(patch));
              onSave(patch);
            }}
            onClose={() => setEditing(false)}
          />
        ) : (
          <h1
            className={`text-lg font-semibold wrap-anywhere ${archived ? "text-muted-foreground" : "text-foreground"}`}
          >
            {project.name}
          </h1>
        )}
        {/* Under the name, as on the Task page: where the project stands and
            what it is checked out from — plain muted facts, not chips. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex shrink-0 items-center gap-1.5">
            {archived ? (
              <Archive size={14} aria-hidden />
            ) : (
              <CircleDot size={14} aria-hidden className="text-primary" />
            )}
            {archived ? "Archived" : "Active"}
          </span>
          {repo ? (
            <span
              className="inline-flex min-w-0 items-center gap-1.5"
              title={project.repoUrl}
            >
              <GitFork size={14} aria-hidden className="shrink-0" />
              {repo.href ? (
                <a
                  href={repo.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="truncate font-mono text-xs text-foreground underline underline-offset-3 hover:text-primary"
                >
                  {repo.label}
                </a>
              ) : (
                <span className="truncate font-mono text-xs">{repo.label}</span>
              )}
            </span>
          ) : null}
          {showWorktrees && spawnedCount !== undefined ? (
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <GitBranch size={14} aria-hidden />
              {spawnedCount} worktree{spawnedCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        {parent ? (
          <div className="flex min-w-0 items-start gap-1.5 text-sm text-muted-foreground">
            <span className="flex h-5 shrink-0 items-center">
              <CornerLeftUp className="size-3.5" aria-hidden />
            </span>
            <span className="shrink-0 leading-5">Part of</span>
            <Button
              variant="link"
              size="xs"
              className="h-auto min-w-0 shrink items-start px-0 py-0 text-left text-sm font-normal whitespace-normal text-foreground"
              disabled={!onOpenProject}
              onClick={() => onOpenProject?.(parent.id)}
            >
              <span className="flex h-5 shrink-0 items-center">
                <FolderKanban
                  className="size-3.5"
                  style={{ color: projectColor(parent).dot }}
                  aria-hidden
                />
              </span>
              <span className="min-w-0 leading-5 wrap-anywhere">
                <span className="font-mono text-xs">{parent.key}</span>
                <span className="text-muted-foreground"> · {parent.name}</span>
              </span>
            </Button>
          </div>
        ) : null}
      </div>

      {/* The description IS the page's body, under the name: no heading and
          no fold. While editing it is part of the editor above. Under it, the
          same small action row as the Task page: Edit (name and description
          together). */}
      {editing ? null : (
        <section aria-label="Description" className="mb-8">
          <div className="min-h-16 w-full py-1">
            {description.trim() ? (
              <Markdown
                text={description}
                paObjectReferences={paObjectReferences}
                onOpenPaObject={onOpenPaObject}
              />
            ) : (
              <span className="text-sm text-muted-foreground">
                No description yet.
              </span>
            )}
          </div>
          <ActionRow>
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              busy={editState ? isPending(editState) : false}
              onClick={() => setEditing(true)}
            >
              <Pencil />
              Edit
            </Button>
          </ActionRow>
        </section>
      )}

      {/* The project's Worktrees are its CONTENT, so they live here rather
          than in the object panel. Its Tasks are the sidebar's Backlog filtered
          to it, not a section here. Headed as the inspector's sections are. */}
      {/* Spaced like the description's action row is from the first section
          (its `mb-8`), with no hairline of their own between them. */}
      <div className="flex flex-col gap-8 [&>section]:border-t-0 [&>section]:pt-0">
        {showWorktrees ? (
          <InspectorSection
            id="worktrees"
            storageScope={`project-page:${project.id}`}
            title="Worktrees"
            icon={<GitBranch />}
          >
            {worktrees === null ? (
              <div
                role="status"
                aria-label="Loading Project worktrees"
                className="flex flex-col gap-2 py-2"
              >
                <Skeleton className="h-7 w-full" />
                <Skeleton className="h-7 w-4/5" />
              </div>
            ) : worktrees.length === 0 ? (
              <p className="py-1 text-sm text-muted-foreground">
                No worktrees yet. Spawn one to let an agent work in isolation.
              </p>
            ) : (
              <div className="flex flex-col">
                <ProjectWorktreeRows
                  worktrees={worktrees}
                  statuses={worktreeStatuses}
                  onOpen={onOpenWorktree}
                  onStartSession={onStartSessionInWorktree}
                />
              </div>
            )}
            {onCreateWorktree ? (
              <ActionRow>
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  onClick={() => onCreateWorktree(project.id)}
                >
                  <Plus />
                  New worktree
                </Button>
              </ActionRow>
            ) : null}
          </InspectorSection>
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
          // "" clears: the server drops an empty `repoUrl`, while an omitted one
          // would be a no-op patch under a different mutation key.
          onSaveUrl={(repoUrl) => onSave({ repoUrl })}
          onClone={onClone}
          onRemoveClone={onRemoveClone}
        />
      </div>
    </div>
  );
}

/**
 * The project's worktrees on the same `Tree` and with the same `WorktreeRow` as
 * the sidebar's Projects browser — compact, flush, in its order — so the two
 * lists are one component, not two that look alike. A flat list: no selection
 * (a click opens the worktree), no drag.
 */
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
  // One coarse wall clock serves every row; `WorktreeRow`'s memo folds it down
  // to the rendered stale/fresh bit, so minute ticks do not redraw siblings.
  const now = useCoarseNow(60_000);
  const items = useMemo(
    () =>
      [...worktrees]
        .sort(compareWorktrees)
        .map((worktree) => ({ id: worktree.id, data: worktree })),
    [worktrees],
  );
  return (
    <Tree
      items={items}
      compact
      flush
      showGuides={false}
      aria-label="Worktrees"
      // The last row drops its hairline: the action row under the list draws
      // the one that closes it.
      className="[&>li:last-child_.border-b]:border-b-0"
      selectedIds={NO_SELECTION}
      onSelectionChange={(ids) => {
        if (ids.length === 1) onOpen?.(ids[0]!);
      }}
      renderNode={(node) => (
        <WorktreeRow
          worktree={node.data}
          status={statuses[node.id]}
          now={now}
          selected={false}
          onStartSession={onStartSession}
        />
      )}
    />
  );
}

const NO_SELECTION: string[] = [];

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
  onSaveUrl: (repoUrl: string) => void;
  onClone: () => void;
  onRemoveClone: () => void;
}) {
  const dialogs = useDialogs();
  const url = project.repoUrl?.trim() ?? "";
  const [editingUrl, setEditingUrl] = useState(false);
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
    <InspectorSection
      id="repository"
      storageScope={`project-page:${project.id}`}
      title="Repository"
      icon={<GitFork />}
    >
      {/* No gap of its own: the notes keep theirs (`mb-2`), so the action row
          sits as far under the rows as the description's does under it. */}
      <div className="flex flex-col">
        {worktreeError ? (
          <ErrorNote
            message={worktreeError}
            onRetry={onLoadWorktrees}
            className="mb-2"
          />
        ) : null}
        {dependencyPending && !worktreeError ? (
          <RefreshIndicator
            label="Checking dependent worktrees…"
            className="mb-2"
          />
        ) : null}
        {provisionError ? (
          <ErrorNote
            className="mb-2"
            message={provisionError.message}
            retryLabel={
              provisionError.action === "clone" ? "Retry clone" : "Retry remove"
            }
            onRetry={provisionError.action === "clone" ? onClone : removeClone}
          />
        ) : null}
        {hasCheckout ? (
          <>
            <div className={REPO_PROPERTY_LIST}>
              <RepoRow label="Checkout" value={checkoutPath} />
              <RepoRow
                label="Origin"
                value={url}
                href={repoDisplay(url)?.href}
                muted
              />
            </div>
            <ActionRow>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="xs"
                      // Why it cannot be pressed is its TOOLTIP, so a disabled
                      // button still takes the pointer (`aria-disabled`).
                      className="text-muted-foreground hover:text-destructive aria-disabled:opacity-50 aria-disabled:hover:text-muted-foreground"
                      busy={provisioning === "remove"}
                      disabled={blocked}
                      focusableWhenDisabled
                      onClick={removeClone}
                    />
                  }
                >
                  <Trash2 />
                  Remove clone
                </TooltipTrigger>
                <TooltipContent>
                  {dependencyPending
                    ? "Checking worktrees before clone removal"
                    : blocked
                      ? `${spawnedWorktrees} worktree${spawnedWorktrees === 1 ? " still uses" : "s still use"} this clone. Remove ${spawnedWorktrees === 1 ? "it" : "them"} first to remove the clone itself.`
                      : "Delete the checkout folder from disk"}
                </TooltipContent>
              </Tooltip>
            </ActionRow>
          </>
        ) : (
          <>
            <EditableText
              value={url}
              submitState={mutationState}
              onSubmit={onSaveUrl}
              editing={editingUrl}
              onEditingChange={setEditingUrl}
              allowEmpty
              label="Repository URL"
              placeholder="git@host:owner/repo.git"
              className="font-mono"
            >
              <div className={REPO_PROPERTY_LIST}>
                <RepoRow
                  label="Clone from"
                  value={url}
                  placeholder="Set a repository URL"
                  onClick={() => setEditingUrl(true)}
                />
              </div>
            </EditableText>
            <ActionRow>
              <Button
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                disabled={!url || busy}
                busy={provisioning === "clone"}
                onClick={onClone}
                title={
                  url
                    ? "Clone it under the Projects root and use it as this project's main checkout"
                    : "Set a repository URL first"
                }
              >
                <Download />
                {provisioning === "clone" ? "Cloning…" : "Clone"}
              </Button>
            </ActionRow>
          </>
        )}
      </div>
    </InspectorSection>
  );
}

/** The Repository rows as a property list: labels in one column, values in the next. */
const REPO_PROPERTY_LIST =
  "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-0.5";

/** One read-only (or click-to-edit) repository row: label and mono value. */
function RepoRow({
  label,
  value,
  placeholder,
  href,
  muted = false,
  onClick,
}: {
  label: string;
  value?: string | undefined;
  placeholder?: string;
  /** Where the value lives on the web: the value becomes a link to it. */
  href?: string | undefined;
  muted?: boolean;
  onClick?: () => void;
}) {
  // A path or remote WRAPS rather than truncates: a truncated
  // `ssh://git@host:2222/owner/re…` says nothing, and this is the value you
  // read or copy out on a phone.
  const valueClass = `min-w-0 select-all break-all font-mono text-xs leading-5 ${value ? (muted ? "text-muted-foreground" : "text-foreground") : "text-muted-foreground"}`;
  return (
    <>
      <span className="py-1 leading-5">
        <PropertyLabel>{label}</PropertyLabel>
      </span>
      {onClick ? (
        <Button
          variant="ghost"
          size="sm"
          className={`${PROPERTY_TRIGGER} -ml-2 h-auto min-h-7 justify-start py-1 text-left whitespace-normal`}
          onClick={onClick}
          title={`Edit ${label.toLowerCase()}`}
        >
          <span className={valueClass}>{value || placeholder}</span>
        </Button>
      ) : (
        <span className={`py-1 ${valueClass}`}>
          {value && href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-foreground underline underline-offset-3 hover:text-primary"
            >
              {value}
            </a>
          ) : (
            value
          )}
        </span>
      )}
    </>
  );
}

/**
 * The repository as the facts line names it: `owner/repo`, linked to its web
 * page when the remote's host serves one at the usual address (an SSH remote
 * on a custom port may not, so that one stays plain text).
 */
function repoDisplay(
  repoUrl: string | undefined,
): { label: string; href?: string } | null {
  const url = repoUrl?.trim();
  if (!url) return null;
  const scp = /^[\w.-]+@([\w.-]+):(?!\d+\/)(.+?)(?:\.git)?\/?$/.exec(url);
  if (scp) return { label: scp[2]!, href: `https://${scp[1]}/${scp[2]}` };
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/, "");
    if (!path) return { label: url };
    const web =
      parsed.protocol === "https:" ||
      parsed.protocol === "http:" ||
      (parsed.protocol === "ssh:" && !parsed.port);
    return web
      ? { label: path, href: `https://${parsed.hostname}/${path}` }
      : { label: path };
  } catch {
    return { label: url };
  }
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
      className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-1 py-2"
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
            <Button variant="outline" onClick={onAction}>
              {actionLabel}
            </Button>
          ) : undefined
        }
      >
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="mt-1">{body}</div>
      </EmptyBox>
    </div>
  );
}
