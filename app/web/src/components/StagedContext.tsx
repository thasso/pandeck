import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  ClipboardList,
  FolderKanban,
  GitBranch,
  MessageSquareText,
  Plus,
  Search,
  X,
} from "lucide-react";
import type {
  ProjectRecord,
  TaskSummary,
  WorktreeRecord,
} from "@assistant/shared";
import { projectColor, projectDisplayKey } from "../lib/projectDisplay.ts";
import { Skeleton } from "./ui/load.tsx";

/**
 * The composable pre-session context staged for a new chat's first prompt.
 * Project is derivable from a chosen Worktree or Task, so the three are kept in
 * sync by the owner (App.tsx): choosing a worktree/task fills the project, and
 * changing the project drops a worktree/task that no longer belongs to it.
 */
export interface StagedContextValue {
  projectId: string | null;
  worktreeId: string | null;
  /**
   * "+ New worktree" staged instead of an existing checkout: the first send
   * creates one in `projectId`. Mutually exclusive with `worktreeId`, and
   * offered only with a project staged.
   */
  newWorktree?: boolean;
  task: { taskId: string; title: string } | null;
  review?: { commentCount: number } | null;
  /** A staged Knowledge entry (its own start path, not part of the Project/Worktree/Task picker). */
  knowledge?: { entryId: string; title: string } | null;
}

export interface StagedContextData {
  value: StagedContextValue;
  projects: ProjectRecord[];
  worktrees: WorktreeRecord[];
  tasks: TaskSummary[];
  /**
   * Whether each list's subscription has ANSWERED. The three arrays above are
   * `[]` both before the answer and when the answer is nothing, and the host
   * only asks for them when the picker opens (`App.tsx`) — so without these the
   * pickers spend their first frames telling the user they own no projects, no
   * worktrees and no Tasks (R1, `app/web/docs/loading-states.md`).
   */
  projectsLoaded: boolean;
  worktreesLoaded: boolean;
  tasksLoaded: boolean;
  onChangeProject: (projectId: string | null) => void;
  onChangeWorktree: (worktreeId: string | null) => void;
  /** Stage/unstage "+ New worktree" — the first send provisions it. */
  onChangeNewWorktree?: (staged: boolean) => void;
  onChangeTask: (task: { taskId: string; title: string } | null) => void;
  /** Reports whether the Task field is expanded, so its list subscription can be lazy. */
  onTaskPickerOpenChange?: (open: boolean) => void;
  /** Remove a staged structured review bundle without removing its worktree. */
  onChangeReview?: (review: null) => void;
  /** Remove a staged Knowledge entry. */
  onChangeKnowledge?: (knowledge: null) => void;
  /**
   * Renders the Task-field body using the shared Backlog list (filtering, status
   * chips, project scoping) so the picker matches the left panel. Called lazily
   * only while the Task field is expanded. Falls back to a plain list when absent.
   */
  renderTaskPicker?: () => ReactNode;
}

function projectLabel(
  projects: ProjectRecord[],
  id: string | null,
): string | null {
  if (!id) return null;
  const project = projects.find((p) => p.id === id);
  if (!project) return id.replace(/[-_]/g, " ");
  const key = projectDisplayKey(project);
  return key ? `${key} · ${project.name}` : project.name;
}

function worktreeLabel(
  worktrees: WorktreeRecord[],
  id: string | null,
): string | null {
  if (!id) return null;
  const worktree = worktrees.find((w) => w.id === id);
  if (!worktree) return id;
  return worktree.isMain ? "main checkout" : worktree.branch;
}

/**
 * Compact removable chip row shown in the composer. Tapping any chip (or the
 * add button) opens the docked context sheet; the X removes just that context.
 * When nothing is staged it collapses to a single "Add context" affordance.
 */
export function StagedContextBar({
  value,
  projects,
  worktrees,
  onOpen,
  onChangeProject,
  onChangeWorktree,
  onChangeNewWorktree,
  onChangeTask,
  onChangeReview,
  onChangeKnowledge,
}: {
  value: StagedContextValue;
  projects: ProjectRecord[];
  worktrees: WorktreeRecord[];
  onOpen: () => void;
  onChangeProject: (projectId: string | null) => void;
  onChangeWorktree: (worktreeId: string | null) => void;
  onChangeNewWorktree?: (staged: boolean) => void;
  onChangeTask: (task: { taskId: string; title: string } | null) => void;
  onChangeReview?: ((review: null) => void) | undefined;
  onChangeKnowledge?: ((knowledge: null) => void) | undefined;
}) {
  const hasAny = Boolean(
    value.review ||
    value.knowledge ||
    value.task ||
    value.worktreeId ||
    value.newWorktree ||
    value.projectId,
  );
  // The project is "implied" when a worktree or task already carries it, so we
  // render it as a non-removable derived chip instead of a duplicate control.
  // A staged NEW worktree is the reverse — it is created IN the project — so the
  // project stays removable, and removing it cancels the new worktree with it.
  const projectImplied = Boolean(value.worktreeId || value.task);

  // Nothing staged: the composer toolbar's context button is the entry point, so
  // the bar collapses away entirely rather than showing a duplicate affordance.
  if (!hasAny) return null;

  return (
    <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
      {value.review ? (
        <ContextChip
          icon={<MessageSquareText size={12} />}
          label={`${value.review.commentCount} review comment${value.review.commentCount === 1 ? "" : "s"}`}
          tone="accent"
          onRemove={onChangeReview ? () => onChangeReview(null) : undefined}
        />
      ) : null}
      {value.knowledge ? (
        <ContextChip
          icon={<BookOpen size={12} />}
          label={value.knowledge.title}
          tone="accent"
          onRemove={
            onChangeKnowledge ? () => onChangeKnowledge(null) : undefined
          }
        />
      ) : null}
      {value.task ? (
        <ContextChip
          icon={<ClipboardList size={12} />}
          label={value.task.title}
          tone="accent"
          onOpen={onOpen}
          onRemove={() => onChangeTask(null)}
        />
      ) : null}
      {value.worktreeId ? (
        <ContextChip
          icon={<GitBranch size={12} />}
          label={worktreeLabel(worktrees, value.worktreeId) ?? value.worktreeId}
          onOpen={onOpen}
          onRemove={() => onChangeWorktree(null)}
        />
      ) : null}
      {value.newWorktree ? (
        <ContextChip
          icon={<Plus size={12} />}
          label="New worktree"
          tone="accent"
          onOpen={onOpen}
          onRemove={
            onChangeNewWorktree ? () => onChangeNewWorktree(false) : undefined
          }
        />
      ) : null}
      {value.projectId ? (
        <ContextChip
          icon={<FolderKanban size={12} />}
          label={projectLabel(projects, value.projectId) ?? value.projectId}
          dimmed={projectImplied}
          onOpen={onOpen}
          onRemove={projectImplied ? undefined : () => onChangeProject(null)}
        />
      ) : null}
      <button
        type="button"
        onClick={onOpen}
        title="Edit session context"
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-fg"
      >
        <Plus size={13} />
      </button>
    </div>
  );
}

function ContextChip({
  icon,
  label,
  tone = "muted",
  dimmed = false,
  onOpen,
  onRemove,
}: {
  icon: React.ReactNode;
  label: string;
  tone?: "muted" | "accent";
  dimmed?: boolean;
  onOpen?: () => void;
  onRemove?: (() => void) | undefined;
}) {
  const toneClass =
    tone === "accent"
      ? "border-accent/30 bg-accent-soft text-accent"
      : "border-line bg-raised text-muted";
  return (
    <span
      className={`flex min-w-0 max-w-[14rem] items-center gap-1 rounded-md border px-1.5 py-0.5 text-caption font-medium ${toneClass} ${dimmed ? "opacity-70" : ""}`}
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 items-center gap-1"
          title={label}
        >
          <span className="shrink-0 opacity-80">{icon}</span>
          <span className="min-w-0 truncate">{label}</span>
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-1" title={label}>
          <span className="shrink-0 opacity-80">{icon}</span>
          <span className="min-w-0 truncate">{label}</span>
        </span>
      )}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="-mr-0.5 flex size-4 shrink-0 items-center justify-center rounded hover:bg-black/10"
          title="Remove"
          aria-label={`Remove ${label}`}
        >
          <X size={11} />
        </button>
      ) : null}
    </span>
  );
}

/** One accordion field of the staged-context picker, addressable from outside. */
export type StagedContextField = "project" | "worktree" | "task";
type Field = StagedContextField;

/**
 * Accordion of Project / Worktree / Task fields, sized for the composer's
 * docked panel (`ChatDockPanel`). Tap-first and scoped: picking a worktree or
 * task fills the project, and every list narrows to the selected project so the
 * options stay short on mobile without requiring a search.
 */
export function StagedContextPanel({
  value,
  projects,
  worktrees,
  tasks,
  projectsLoaded,
  worktreesLoaded,
  tasksLoaded,
  onChangeProject,
  onChangeWorktree,
  onChangeNewWorktree,
  onChangeTask,
  onTaskPickerOpenChange,
  renderTaskPicker,
  initialField,
}: StagedContextData & {
  /**
   * Field to start expanded. The panel unmounts with its dock sheet, so this is
   * an initializer, not live state — set it when opening the sheet to land the
   * user on a specific picker (e.g. Worktree after selecting the Developer agent).
   */
  initialField?: Field | null;
}) {
  const [open, setOpen] = useState<Field | null>(
    () =>
      initialField ??
      (value.task || value.worktreeId || value.projectId ? null : "project"),
  );

  useEffect(() => {
    onTaskPickerOpenChange?.(open === "task");
  }, [onTaskPickerOpenChange, open]);
  useEffect(
    () => () => onTaskPickerOpenChange?.(false),
    [onTaskPickerOpenChange],
  );

  const activeWorktrees = useMemo(
    () =>
      worktrees
        .filter((w) => !w.removedAt)
        .filter((w) => !value.projectId || w.projectId === value.projectId),
    [worktrees, value.projectId],
  );
  const activeTasks = useMemo(
    () =>
      tasks
        .filter((t) => !t.archivedAt)
        .filter((t) => !value.projectId || t.projectId === value.projectId),
    [tasks, value.projectId],
  );

  const toggle = (field: Field) =>
    setOpen((cur) => (cur === field ? null : field));

  return (
    <div className="flex flex-col gap-1 text-caption">
      <FieldRow
        icon={<FolderKanban size={14} />}
        label="Project"
        value={projectLabel(projects, value.projectId)}
        expanded={open === "project"}
        onToggle={() => toggle("project")}
      >
        <OptionList
          items={projects.map((p) => ({
            id: p.id,
            label: p.name,
            hint: projectDisplayKey(p) ?? undefined,
            dot: projectColor(p).dot,
          }))}
          selectedId={value.projectId}
          loaded={projectsLoaded}
          loadingLabel="Loading projects"
          emptyLabel="No projects in the registry yet."
          clearLabel="No project"
          onSelect={(id) => {
            onChangeProject(id);
            setOpen(null);
          }}
          onClear={value.projectId ? () => onChangeProject(null) : undefined}
        />
      </FieldRow>

      <FieldRow
        icon={<GitBranch size={14} />}
        label="Worktree"
        value={
          value.newWorktree
            ? "New worktree"
            : worktreeLabel(worktrees, value.worktreeId)
        }
        expanded={open === "worktree"}
        onToggle={() => toggle("worktree")}
      >
        <OptionList
          leadingAction={
            // Creating a checkout needs to know which repository it belongs to.
            value.projectId && onChangeNewWorktree
              ? {
                  label: value.newWorktree
                    ? "New worktree (staged)"
                    : "New worktree",
                  selected: Boolean(value.newWorktree),
                  onSelect: () => {
                    onChangeNewWorktree(!value.newWorktree);
                    setOpen(null);
                  },
                }
              : undefined
          }
          items={[
            // Main checkouts pin above the rest, same as the hero row.
            ...activeWorktrees.filter((w) => w.isMain),
            ...activeWorktrees.filter((w) => !w.isMain),
          ].map((w) => ({
            id: w.id,
            label: w.isMain ? "main checkout" : w.branch,
            pinned: Boolean(w.isMain),
            ...(!value.projectId && projectLabel(projects, w.projectId)
              ? { hint: projectLabel(projects, w.projectId)! }
              : {}),
          }))}
          selectedId={value.worktreeId}
          loaded={worktreesLoaded}
          loadingLabel="Loading worktrees"
          emptyLabel={
            value.projectId
              ? "No worktrees for this project."
              : "No worktrees yet."
          }
          clearLabel="No worktree"
          onSelect={(id) => {
            onChangeWorktree(id);
            setOpen(null);
          }}
          onClear={value.worktreeId ? () => onChangeWorktree(null) : undefined}
        />
      </FieldRow>

      <FieldRow
        icon={<ClipboardList size={14} />}
        label="Task"
        value={value.task?.title ?? null}
        expanded={open === "task"}
        onToggle={() => toggle("task")}
      >
        {open !== "task" ? null : renderTaskPicker ? (
          renderTaskPicker()
        ) : (
          <OptionList
            items={activeTasks.map((t) => ({
              id: t.id,
              label: t.title,
              hint: t.status,
            }))}
            selectedId={value.task?.taskId ?? null}
            loaded={tasksLoaded}
            loadingLabel="Loading Tasks"
            emptyLabel={
              value.projectId ? "No tasks for this project." : "No tasks yet."
            }
            clearLabel="No task"
            onSelect={(id) => {
              const task = activeTasks.find((t) => t.id === id);
              if (task) onChangeTask({ taskId: task.id, title: task.title });
              setOpen(null);
            }}
            onClear={value.task ? () => onChangeTask(null) : undefined}
          />
        )}
      </FieldRow>
    </div>
  );
}

function FieldRow({
  icon,
  label,
  value,
  expanded,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
          {icon}
        </span>
        <span className="w-16 shrink-0 text-caption font-semibold uppercase tracking-wide text-faint">
          {label}
        </span>
        <span
          className={`min-w-0 flex-1 truncate ${value ? "text-fg" : "text-faint"}`}
        >
          {value ?? "None"}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-faint transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {expanded ? (
        <div className="border-t border-line p-1.5">{children}</div>
      ) : null}
    </div>
  );
}

interface Option {
  id: string;
  label: string;
  hint?: string;
  dot?: string;
  /** Pinned above a divider, ahead of the unpinned rest (e.g. main checkouts). */
  pinned?: boolean;
}

function OptionList({
  items,
  selectedId,
  loaded,
  loadingLabel,
  emptyLabel,
  clearLabel,
  onSelect,
  onClear,
  leadingAction,
}: {
  items: Option[];
  selectedId: string | null;
  /**
   * Whether `items` is an ANSWER. False keeps `emptyLabel` off the screen and
   * reserves the rows instead (R1/R4): the host asks for these lists only when
   * the picker opens, so an ungated empty label is what the user sees first.
   */
  loaded: boolean;
  /** Announced while the rows are reserved. */
  loadingLabel: string;
  emptyLabel: string;
  clearLabel: string;
  onSelect: (id: string) => void;
  onClear?: (() => void) | undefined;
  /** A create-style choice pinned above the list (Worktree's "+ New worktree"). */
  leadingAction?:
    { label: string; selected: boolean; onSelect: () => void } | undefined;
}) {
  const [filter, setFilter] = useState("");
  const q = filter.toLowerCase().trim();
  const filtered = q
    ? items.filter(
        (i) =>
          i.label.toLowerCase().includes(q) ||
          (i.hint?.toLowerCase().includes(q) ?? false),
      )
    : items;
  // Search only earns its keep past a screenful; keep the sheet tap-first below that.
  const showFilter = items.length > 8;
  // The divider sits right after the pinned group — the leading action counts
  // as pinned too, so it shows even with no pinned items (-1 when every item is
  // pinned, which correctly renders no divider at all).
  const hasPinnedGroup = Boolean(leadingAction) || items.some((i) => i.pinned);
  const firstUnpinnedIndex = hasPinnedGroup
    ? filtered.findIndex((i) => !i.pinned)
    : -1;

  return (
    <div className="flex flex-col gap-1">
      {showFilter ? (
        <div className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2 py-1.5">
          <Search size={13} className="shrink-0 text-faint" />
          {/* No autoFocus: the picker is tap-first, and focusing this input would
              re-open the mobile keyboard the dock sheet just dismissed. */}
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="min-w-0 flex-1 bg-transparent text-caption text-fg outline-none placeholder:text-faint"
          />
        </div>
      ) : null}
      {leadingAction ? (
        <button
          type="button"
          onClick={leadingAction.onSelect}
          aria-pressed={leadingAction.selected}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-caption transition-colors hover:bg-raised ${
            leadingAction.selected ? "text-accent" : "text-fg"
          }`}
        >
          <Plus size={13} className="shrink-0" />
          {leadingAction.label}
        </button>
      ) : null}
      {onClear ? (
        <button
          type="button"
          onClick={onClear}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-caption text-faint transition-colors hover:bg-raised hover:text-danger"
        >
          <X size={13} className="shrink-0" />
          {clearLabel}
        </button>
      ) : null}
      <div className="max-h-56 overflow-y-auto">
        {!loaded ? (
          <div
            role="status"
            aria-label={loadingLabel}
            className="flex flex-col"
          >
            {[0, 1, 2].map((row) => (
              <div key={row} className="px-2.5 py-2">
                <Skeleton
                  className="h-4"
                  style={{ width: `${[76, 58, 68][row]}%` }}
                />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-2.5 py-3 text-center text-caption text-faint">
            {items.length === 0 ? emptyLabel : "No matches."}
          </div>
        ) : (
          filtered.map((item, index) => (
            <Fragment key={item.id}>
              {
                // Unfiltered only: a search narrows the pinned/rest split away.
                // `items` puts pinned entries first, so the first unpinned one
                // marks the boundary — covers a leading action with no pinned
                // items too, and never fires when nothing unpinned follows.
                !q && index === firstUnpinnedIndex ? (
                  <hr className="my-1 border-line" />
                ) : null
              }
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-raised ${
                  selectedId === item.id ? "font-medium text-fg" : "text-muted"
                }`}
              >
                {item.dot ? (
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: item.dot }}
                    aria-hidden
                  />
                ) : null}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint ? (
                  <span className="shrink-0 rounded bg-panel px-1.5 py-0.5 text-micro font-medium tracking-wide text-faint">
                    {item.hint}
                  </span>
                ) : null}
              </button>
            </Fragment>
          ))
        )}
      </div>
    </div>
  );
}
