import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ClipboardList,
  FolderKanban,
  GitBranch,
  Plus,
  X,
} from "lucide-react";
import type {
  ProjectRecord,
  TaskSummary,
  WorktreeRecord,
} from "@assistant/shared";
import { projectColor, projectDisplayKey } from "../lib/projectDisplay.ts";
import { Skeleton } from "./common/load.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible.tsx";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandSeparator,
} from "./ui/command.tsx";

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
  /** A staged document (its own start path, not part of the Project/Worktree/Task picker). */
  file?: { href: string; title: string } | null;
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
  /** Remove a staged document. */
  onChangeFile?: (file: null) => void;
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
    <div className="flex flex-col gap-1 text-sm">
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
    <Collapsible open={expanded} onOpenChange={onToggle}>
      <CollapsibleTrigger
        render={<Button variant="outline" className="w-full justify-start" />}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {icon}
        </span>
        <span className="w-16 shrink-0 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span
          className={`min-w-0 flex-1 truncate ${value ? "text-foreground" : "text-muted-foreground"}`}
        >
          {value ?? "None"}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>{expanded ? children : null}</CollapsibleContent>
    </Collapsible>
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
  return (
    <Command>
      {/* No autoFocus: searching must not reopen the mobile keyboard. */}
      {items.length > 8 ? (
        <CommandInput
          placeholder="Filter…"
          value={filter}
          onValueChange={setFilter}
        />
      ) : null}
      {leadingAction ? (
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={leadingAction.selected}
          onClick={leadingAction.onSelect}
        >
          <Plus />
          {leadingAction.label}
        </Button>
      ) : null}
      {onClear ? (
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X />
          {clearLabel}
        </Button>
      ) : null}
      {!loaded ? (
        <div
          role="status"
          aria-label={loadingLabel}
          className="flex flex-col gap-2"
        >
          {[0, 1, 2].map((row) => (
            <Skeleton
              key={row}
              className="h-4"
              style={{ width: `${[76, 58, 68][row]}%` }}
            />
          ))}
        </div>
      ) : (
        <CommandList className="max-h-56">
          <CommandEmpty>
            {items.length === 0 ? emptyLabel : "No matches."}
          </CommandEmpty>
          {[true, false].map((pinned) => (
            <CommandGroup key={String(pinned)}>
              {!pinned &&
              !filter.trim() &&
              items.some((item) => !item.pinned) &&
              (leadingAction || items.some((item) => item.pinned)) ? (
                <CommandSeparator asChild>
                  <hr />
                </CommandSeparator>
              ) : null}
              {items
                .filter((item) => Boolean(item.pinned) === pinned)
                .map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    keywords={[item.label, item.hint ?? ""]}
                    aria-current={selectedId === item.id ? "true" : undefined}
                    data-checked={selectedId === item.id || undefined}
                    onSelect={() => onSelect(item.id)}
                  >
                    {item.dot ? (
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: item.dot }}
                        aria-hidden
                      />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">
                      {item.label}
                    </span>
                    {item.hint ? (
                      <Badge variant="secondary">{item.hint}</Badge>
                    ) : null}
                  </CommandItem>
                ))}
            </CommandGroup>
          ))}
        </CommandList>
      )}
    </Command>
  );
}
