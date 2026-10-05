import { useMemo, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  ArchiveX,
  BookOpen,
  Check,
  CheckCircle2,
  Circle,
  ClipboardList,
  ExternalLink,
  Eye,
  FolderKanban,
  GitBranch,
  GitBranchPlus,
  GitFork,
  GitMerge,
  IdCard,
  ListChecks,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  RotateCcw,
  SearchCheck,
  SendHorizontal,
  SlidersHorizontal,
  Trash2,
  Undo2,
  UserCheck,
  Workflow,
} from "lucide-react";
import {
  providerLabel,
  type ProjectRecord,
  type ProjectStatus,
  type PullRequestInventoryItem,
  type SessionForkOrigin,
  type SessionListItem,
  type SettableSpawnOwnership,
  type TaskBackRef,
  type TaskStatus,
  type TaskSummary,
  type ThinkingLevel,
  type WorktreeComment,
  type WorktreeGitStatus,
  type WorktreeRecord,
  type WorktreeReviewSet,
} from "@assistant/shared";
import { useCommentActuation } from "./review/CommentActuation.tsx";
import type { Task } from "../lib/backlogTree.ts";
import {
  Inspector,
  InspectorFacts,
  InspectorSection,
  type InspectorAction,
  type InspectorFact,
  type InspectorRelationGroup,
} from "./shell/Inspector.tsx";
import { TranscriptViewRows, type ChatViewPrefs } from "./ChatHeaderMenu.tsx";
import { THINKING_LABELS } from "./ui/ModelThinkingSelect.tsx";
import { EmptyBox, ErrorNote, Spinner } from "./ui/load.tsx";
import {
  dataOf,
  errorOf,
  isPending,
  type LoadState,
} from "../lib/loadState.ts";
// Free of the `diff/` stack on purpose (see worktree/CLAUDE.md), so the review
// roster can live in this main-bundle module.
import { worktreeReviewThreads } from "./worktree/worktreeReview.tsx";
import { ReviewCommentList } from "./review/ReviewCommentList.tsx";
import { ProjectSettingsFields } from "./ProjectSettingsFields.tsx";
import { ProjectLocalPathsSection } from "./ProjectLocalPaths.tsx";
import {
  WorktreeDeliverySection,
  useWorktreeDelivery,
} from "./worktree/WorktreeDelivery.tsx";
import { useWorktreeRetire } from "./worktree/useWorktreeRetire.tsx";
import { usePullRequestMergeCleanup } from "./pullRequest/usePullRequestMergeCleanup.tsx";
import {
  usePullRequestReview,
  usePullRequestWorktree,
  type PullRequestReviewHandoff,
} from "./pullRequest/usePullRequestCheckout.tsx";
import {
  hostingProviderLabel,
  pullRequestMergeBlockedReason,
  pullRequestRowId,
  resolveJoinRows,
  type JoinSource,
  type PullRequestJoinSources,
} from "../lib/pullRequestInbox.ts";

/** A resolved reference to another work-graph object. */
export interface ObjectRef {
  kind: "task" | "project" | "session" | "worktree" | "knowledge";
  id: string;
  title: string;
  subtitle?: string;
  counters?: { additions: number; deletions: number };
  /** Task status shown as the relation icon when kind is task. */
  taskStatus?: TaskStatus;
  /** True when a linked session is currently running. */
  running?: boolean;
  children?: ObjectRef[];
}

export type WorktreeRelationSource = Pick<WorktreeRecord, "id" | "branch"> &
  Partial<Pick<WorktreeRecord, "projectId" | "path" | "isMain">>;

function basename(path: string | undefined): string | undefined {
  const cleaned = path?.replace(/[\\/]+$/, "");
  if (!cleaned) return undefined;
  return cleaned.split(/[\\/]/).pop() || undefined;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function worktreeStatusSummary(
  status: WorktreeGitStatus | undefined,
): string[] {
  if (!status) return [];
  return [
    ...(status.filesChanged > 0 ? [plural(status.filesChanged, "file")] : []),
    ...(status.untracked > 0 ? [plural(status.untracked, "untracked")] : []),
  ];
}

function worktreeCounters(
  status: WorktreeGitStatus | undefined,
): ObjectRef["counters"] {
  if (
    !status ||
    (status.filesChanged === 0 &&
      status.untracked === 0 &&
      status.additions === 0 &&
      status.deletions === 0)
  )
    return undefined;
  return { additions: status.additions, deletions: status.deletions };
}

function worktreeDisplayName(
  worktree: WorktreeRelationSource,
  status?: WorktreeGitStatus,
): string {
  if (worktree.isMain) return status?.branch ?? worktree.branch;
  return basename(worktree.path) ?? status?.branch ?? worktree.branch;
}

function worktreeObjectRef(
  worktree: WorktreeRelationSource,
  _projects: ProjectRecord[],
  status?: WorktreeGitStatus,
): ObjectRef {
  const branch = status?.branch ?? worktree.branch;
  const subtitle = [`branch ${branch}`, ...worktreeStatusSummary(status)].join(
    " · ",
  );
  const countersValue = worktreeCounters(status);
  return {
    kind: "worktree",
    id: worktree.id,
    title: worktreeDisplayName(worktree, status),
    subtitle,
    ...(countersValue !== undefined ? { counters: countersValue } : {}),
  };
}

export function worktreeObjectTreeRefs(
  worktree: WorktreeRelationSource,
  projects: ProjectRecord[],
  status?: WorktreeGitStatus,
): ObjectRef[] {
  const worktreeRef = worktreeObjectRef(worktree, projects, status);
  const project = worktree.projectId
    ? projects.find((candidate) => candidate.id === worktree.projectId)
    : undefined;
  if (!project) return [worktreeRef];
  return [
    {
      kind: "project",
      id: project.id,
      title: `${project.key} · ${project.name}`,
      children: [worktreeRef],
    },
  ];
}

export interface ObjectRefGroup {
  id?: string;
  label: string;
  icon?: ReactNode;
  summary?: string;
  /** Top-level rows shown before a "Show more" (see InspectorRelationGroup). */
  maxVisibleItems?: number;
  refs: ObjectRef[];
}

function sessionTitle(sessions: SessionListItem[], sessionId: string): string {
  return (
    sessions.find((session) => session.id === sessionId)?.title ?? "Session"
  );
}

function sessionRuntimeSubtitle(session: SessionListItem): string | undefined {
  const model = session.model;
  const parts = [
    session.isStreaming ? "Running" : undefined,
    model
      ? `${providerLabel(model.provider)} · ${model.name ?? model.id}`
      : undefined,
    session.thinkingLevel ? `thinking ${session.thinkingLevel}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function sessionObjectRef(
  id: string,
  session: SessionListItem | undefined,
  fallbackTitle: string,
  /**
   * Ownership qualifier shown ahead of the runtime detail. Read from the wire
   * field, never from a title or a role word in the transcript.
   */
  marker?: string,
): ObjectRef {
  const runtime = session ? sessionRuntimeSubtitle(session) : undefined;
  const subtitle = [marker, runtime].filter(Boolean).join(" · ") || undefined;
  return {
    kind: "session",
    id,
    title: session?.title ?? fallbackTitle,
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(session?.isStreaming ? { running: true } : {}),
  };
}

function taskStatusSummary(
  tasks: Array<Pick<TaskSummary, "status">>,
): string | undefined {
  if (tasks.length === 0) return undefined;
  const counts = tasks.reduce(
    (acc, task) => ({ ...acc, [task.status]: acc[task.status] + 1 }),
    { todo: 0, doing: 0, done: 0 } as Record<TaskStatus, number>,
  );
  return `${counts.doing} doing · ${counts.todo} task · ${counts.done} done`;
}

function taskStatusIcon(status: TaskStatus): ReactNode {
  if (status === "done")
    return <CheckCircle2 size={16} className="text-emerald-500" />;
  if (status === "doing")
    return <Circle size={16} className="fill-accent text-accent" />;
  return <Circle size={16} className="text-faint" />;
}

function taskObjectRef(
  task: Pick<
    TaskSummary,
    "id" | "title" | "status" | "parentId" | "sortOrder" | "createdAt"
  >,
  subtitle?: string,
): ObjectRef {
  return {
    kind: "task",
    id: task.id,
    title: task.title,
    ...(subtitle !== undefined ? { subtitle } : {}),
    taskStatus: task.status,
  };
}

function orderTaskRefs<
  T extends Pick<TaskSummary, "title" | "status" | "sortOrder" | "createdAt">,
>(tasks: T[]): T[] {
  const statusRank: Record<TaskStatus, number> = { doing: 0, todo: 1, done: 2 };
  return [...tasks].sort(
    (a, b) =>
      statusRank[a.status] - statusRank[b.status] ||
      (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
        (b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
      a.createdAt - b.createdAt ||
      a.title.localeCompare(b.title),
  );
}

function taskTreeRefs(tasks: TaskSummary[]): ObjectRef[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const childrenByParent = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    if (!task.parentId || !tasksById.has(task.parentId)) continue;
    childrenByParent.set(task.parentId, [
      ...(childrenByParent.get(task.parentId) ?? []),
      task,
    ]);
  }
  const build = (task: TaskSummary): ObjectRef => {
    const children = orderTaskRefs(childrenByParent.get(task.id) ?? []).map(
      build,
    );
    return {
      ...taskObjectRef(task),
      ...(children.length > 0 ? { children } : {}),
    };
  };
  return orderTaskRefs(
    tasks.filter((task) => !task.parentId || !tasksById.has(task.parentId)),
  ).map(build);
}

function mergeSessionTasks(
  originTask: TaskBackRef | undefined,
  relatedTasks: TaskSummary[],
  sessionTasks: TaskSummary[] = [],
): TaskSummary[] {
  const byId = new Map<string, TaskSummary>();
  for (const task of [...sessionTasks, ...relatedTasks])
    byId.set(task.id, task);
  if (originTask && !byId.has(originTask.id)) {
    byId.set(originTask.id, {
      id: originTask.id,
      title: originTask.title,
      status: originTask.status,
      source: { createdBy: "user" },
      createdAt: 0,
      updatedAt: 0,
    });
  }
  return [...byId.values()];
}

/**
 * Resolve a Task's references into inspector groups: parent task and subtasks,
 * and the sessions linked to it.
 * The project is NOT a relation row here — the task inspector's
 * TaskContextSections owns project display and assignment.
 * Pure so the shape is unit-testable.
 */
export function taskRelationGroups(
  task: Task,
  allTasks: Task[],
  sessions: SessionListItem[],
): ObjectRefGroup[] {
  const parent = task.parentId
    ? allTasks.find((candidate) => candidate.id === task.parentId)
    : undefined;
  const subtasks = allTasks.filter(
    (candidate) => candidate.parentId === task.id,
  );

  const sessionRefs = new Map<string, ObjectRef>();
  for (const ref of task.sessionRefs ?? []) {
    sessionRefs.set(ref.sessionId, {
      kind: "session",
      id: ref.sessionId,
      title: sessionTitle(sessions, ref.sessionId),
      subtitle:
        ref.origin === "task-start" ? "Started from this task" : "Referenced",
    });
  }
  const summaryValue = taskStatusSummary([
    ...(parent ? [parent] : []),
    ...subtasks,
  ]);
  return [
    {
      id: "related-tasks",
      label: "Related tasks",
      icon: <ListChecks size={13} />,
      ...(summaryValue !== undefined ? { summary: summaryValue } : {}),
      refs: [
        ...(parent ? [taskObjectRef(parent, "Parent task")] : []),
        ...subtasks.map((subtask) => taskObjectRef(subtask, "Subtask")),
      ],
    },
    {
      id: "sessions",
      label: "Sessions",
      icon: <MessageSquare size={13} />,
      refs: [...sessionRefs.values()],
    },
  ];
}

/**
 * Resolve a Project's references into inspector groups: project hierarchy and
 * the sessions attached to its tasks. Neither its TASKS nor its WORKTREES appear
 * here — both are sections of the Project page itself, and the panel does not
 * repeat what the surface beside it already lists. What is left is what the page
 * cannot show: the projects around this one, and the sessions its tasks pulled
 * in. Pure so the shape is unit-testable.
 */
export function projectRelationGroups(
  project: ProjectRecord,
  projects: ProjectRecord[],
  tasks: Task[],
  sessions: SessionListItem[],
): ObjectRefGroup[] {
  const parent = project.parentId
    ? projects.find((candidate) => candidate.id === project.parentId)
    : undefined;
  const subprojects = projects.filter(
    (candidate) => candidate.parentId === project.id,
  );
  const projectTasks = tasks.filter((task) => task.projectId === project.id);

  const sessionRefs = new Map<string, ObjectRef>();
  for (const task of projectTasks) {
    for (const ref of task.sessionRefs ?? []) {
      if (sessionRefs.has(ref.sessionId)) continue;
      sessionRefs.set(ref.sessionId, {
        kind: "session",
        id: ref.sessionId,
        title: sessionTitle(sessions, ref.sessionId),
        subtitle: `Via task: ${task.title}`,
      });
    }
  }

  return [
    {
      id: "related-projects",
      label: "Related projects",
      icon: <FolderKanban size={13} />,
      refs: [
        ...(parent
          ? [
              {
                kind: "project" as const,
                id: parent.id,
                title: `${parent.key} · ${parent.name}`,
                subtitle: "Parent project",
              },
            ]
          : []),
        ...subprojects.map((sub) => ({
          kind: "project" as const,
          id: sub.id,
          title: `${sub.key} · ${sub.name}`,
          subtitle: "Subproject",
        })),
      ],
    },
    {
      id: "sessions",
      label: "Sessions",
      icon: <MessageSquare size={13} />,
      ...(sessionRefs.size ? { summary: `${sessionRefs.size}` } : {}),
      refs: [...sessionRefs.values()],
    },
  ];
}

/** Task rows the session inspector shows before its "Show more". */
const SESSION_TASKS_PREVIEW = 5;

/**
 * Resolve a Session's references into inspector groups: the Task it works on,
 * explicitly linked tasks, durable spawn parentage, and its fork lineage. Pure
 * so the shape is unit-testable.
 */
export function sessionRelationGroups(args: {
  sessionId: string | undefined;
  originTask?: TaskBackRef;
  relatedTasks: TaskSummary[];
  /** Session-scoped task progress for this session, merged into the single Tasks section. */
  sessionTasks?: TaskSummary[];
  forkOrigin?: SessionForkOrigin;
  sessions: SessionListItem[];
  /** The worktree this session executes in, if any. */
  worktree?: WorktreeRelationSource;
  /** Project records used to render worktree ownership. */
  projects?: ProjectRecord[];
  /** Live git status for the session worktree, when subscribed. */
  worktreeStatus?: WorktreeGitStatus;
}): ObjectRefGroup[] {
  const {
    sessionId,
    originTask,
    relatedTasks,
    sessionTasks = [],
    forkOrigin,
    sessions,
    worktree,
    projects = [],
    worktreeStatus,
  } = args;
  const current = sessionId
    ? sessions.find((session) => session.id === sessionId)
    : undefined;
  const spawnedById = current?.spawnedBySessionId;
  const spawnedBy = spawnedById
    ? sessions.find((session) => session.id === spawnedById)
    : undefined;
  const spawnedSessions = sessionId
    ? sessions.filter((session) => session.spawnedBySessionId === sessionId)
    : [];
  const parentId = forkOrigin?.parentSessionId;
  const parent = parentId
    ? sessions.find((session) => session.id === parentId)
    : undefined;
  const forks = sessionId
    ? sessions.filter(
        (session) => session.forkOrigin?.parentSessionId === sessionId,
      )
    : [];
  const tasks = mergeSessionTasks(originTask, relatedTasks, sessionTasks);
  const summaryValue = taskStatusSummary(tasks);
  return [
    {
      id: "workspace",
      label: "Workspace",
      icon: <FolderKanban size={13} />,
      refs: worktree
        ? worktreeObjectTreeRefs(worktree, projects, worktreeStatus)
        : [],
    },
    {
      id: "tasks",
      label: "Tasks",
      icon: <ListChecks size={13} />,
      ...(summaryValue !== undefined ? { summary: summaryValue } : {}),
      // A long-running session accumulates tasks; the sections under this one
      // (context, memory, tools) must stay reachable without a long scroll.
      maxVisibleItems: SESSION_TASKS_PREVIEW,
      refs: taskTreeRefs(tasks),
    },
    {
      id: "spawned-by",
      label: "Spawned by",
      icon: <MessageSquare size={13} />,
      refs: spawnedById
        ? [sessionObjectRef(spawnedById, spawnedBy, "Coordinator session")]
        : [],
    },
    {
      id: "spawned-sessions",
      label: "Spawned sessions",
      icon: <MessageSquare size={13} />,
      ...(spawnedSessions.length > 0
        ? { summary: `${spawnedSessions.length}` }
        : {}),
      // "Taken over" marks a child the user has explicitly taken over, so a
      // coordinator's delegates stay distinguishable from the ones the user now
      // drives. Only that state is labelled: an untracked (`unknown`) edge is
      // not evidence of anything.
      refs: spawnedSessions.map((session) =>
        sessionObjectRef(
          session.id,
          session,
          "Spawned session",
          session.spawnOwnership === "taken-over" ? "Taken over" : undefined,
        ),
      ),
    },
    {
      id: "fork-lineage",
      label: "Fork lineage",
      icon: <GitFork size={13} />,
      refs: [
        ...(parentId
          ? [
              {
                kind: "session" as const,
                id: parentId,
                title: parent?.title ?? "Parent session",
                subtitle: "Forked from",
              },
            ]
          : []),
        ...forks.map((fork) => ({
          kind: "session" as const,
          id: fork.id,
          title: fork.title,
          subtitle: "Fork of this session",
        })),
      ],
    },
  ];
}

const REF_ICONS: Record<ObjectRef["kind"], ReactNode> = {
  task: <ClipboardList size={14} />,
  project: <FolderKanban size={14} />,
  session: <MessageSquare size={14} />,
  worktree: <GitBranch size={14} />,
  knowledge: <BookOpen size={14} />,
};

/** Callbacks that open an object in the main pane (sidebar state untouched). */
export interface ObjectOpeners {
  onOpenTask: (id: string) => void;
  onOpenProject: (id: string) => void;
  onOpenSession: (id: string) => void;
  onOpenWorktree: (id: string) => void;
  onOpenKnowledge: (id: string) => void;
}

function toInspectorGroups(
  groups: ObjectRefGroup[],
  open: ObjectOpeners,
): InspectorRelationGroup[] {
  const opener = (ref: ObjectRef) =>
    ref.kind === "task"
      ? () => open.onOpenTask(ref.id)
      : ref.kind === "project"
        ? () => open.onOpenProject(ref.id)
        : ref.kind === "worktree"
          ? () => open.onOpenWorktree(ref.id)
          : ref.kind === "knowledge"
            ? () => open.onOpenKnowledge(ref.id)
            : () => open.onOpenSession(ref.id);
  const toRelation = (
    ref: ObjectRef,
  ): InspectorRelationGroup["items"][number] => {
    const childrenValue = ref.children?.map(toRelation);
    return {
      key: `${ref.kind}:${ref.id}`,
      icon:
        ref.kind === "session" && ref.running ? (
          <Spinner size="sm" />
        ) : ref.kind === "task" && ref.taskStatus ? (
          taskStatusIcon(ref.taskStatus)
        ) : (
          REF_ICONS[ref.kind]
        ),
      title: ref.title,
      ...(ref.subtitle !== undefined ? { subtitle: ref.subtitle } : {}),
      ...(ref.counters !== undefined ? { counters: ref.counters } : {}),
      onOpen: opener(ref),
      ...(childrenValue !== undefined ? { children: childrenValue } : {}),
    };
  };
  return groups.map((group) => ({
    ...(group.id !== undefined ? { id: group.id } : {}),
    label: group.label,
    icon: group.icon,
    ...(group.summary !== undefined ? { summary: group.summary } : {}),
    ...(group.maxVisibleItems !== undefined
      ? { maxVisibleItems: group.maxVisibleItems }
      : {}),
    items: group.refs.map(toRelation),
  }));
}

/**
 * @component TaskInspector
 * @purpose Right-sidebar inspector for the Task open in the main pane: related
 * tasks/sessions, editable context via children (TaskContextSections), task
 * actions, and the quick composer.
 * @useWhen The main pane shows a Task detail route.
 * @related Inspector, TaskContextSections, ProjectInspector, SessionInspector.
 */
export function TaskInspector({
  task,
  tasks,
  sessions,
  openers,
  onStartSession,
  onRunWorkflow,
  onArchive,
  onDelete,
  children,
}: {
  task: Task | undefined;
  tasks: Task[];
  sessions: SessionListItem[];
  openers: ObjectOpeners;
  onStartSession: (taskId: string, title: string) => void;
  /**
   * Open the Run-workflow start sheet for this Task. Passed only when the Task
   * has a Project a run's worktree could be provisioned from.
   */
  onRunWorkflow?: ((taskId: string) => void) | undefined;
  onArchive?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
  children?: ReactNode;
}) {
  const actions: InspectorAction[] = task
    ? [
        {
          key: "start-session",
          primary: true,
          icon: <MessageSquarePlus size={14} />,
          label: "Start session for this task",
          onRun: () => onStartSession(task.id, task.title),
        },
        ...(onRunWorkflow
          ? [
              {
                key: "run-workflow",
                icon: <Workflow size={14} />,
                label: "Run workflow…",
                onRun: () => onRunWorkflow(task.id),
              },
            ]
          : []),
        ...(onArchive
          ? [
              {
                key: "archive",
                icon: <Archive size={14} />,
                label: "Archive task",
                onRun: () => onArchive(task.id),
              },
            ]
          : []),
        ...(onDelete
          ? [
              {
                key: "delete",
                icon: <Trash2 size={14} />,
                label: "Delete task",
                onRun: () => onDelete(task.id),
              },
            ]
          : []),
      ]
    : [];
  return (
    <Inspector
      loading={!task}
      relations={
        task
          ? toInspectorGroups(
              taskRelationGroups(task, tasks, sessions),
              openers,
            )
          : []
      }
      actions={actions}
      sectionStorageScope={`task:${task?.id ?? "loading"}`}
    >
      {children}
    </Inspector>
  );
}

/**
 * The Take over / Hand back action for a spawned session, or nothing for a
 * session no other session spawned. A session the user took over offers to
 * hand it back to its coordinator — only while that coordinator is in the
 * list, since handing a peer to a session that is gone would leave nobody to
 * run it; any other spawned session (coordinator-run, or an `unknown` edge)
 * offers to take it over.
 */
function spawnOwnershipAction(
  sessionId: string | undefined,
  sessions: SessionListItem[],
  onSet: ((ownership: SettableSpawnOwnership) => void) | undefined,
): InspectorAction[] | undefined {
  if (!onSet || !sessionId) return undefined;
  const session = sessions.find((item) => item.id === sessionId);
  if (!session?.spawnedBySessionId) return undefined;
  const coordinator = sessions.find(
    (item) => item.id === session.spawnedBySessionId,
  );
  const coordinatorTitle = coordinator?.title.trim() || undefined;
  if (session.spawnOwnership === "taken-over" && !coordinator) return undefined;
  return session.spawnOwnership === "taken-over"
    ? [
        {
          key: "hand-back",
          icon: <Undo2 size={14} />,
          // The coordinator's title is part of the label, not a hint: a hint
          // does not shrink, and a long title would crush "Hand back" itself.
          label: coordinatorTitle
            ? `Hand back to ${coordinatorTitle}`
            : "Hand back",
          onRun: () => onSet("coordinator"),
        },
      ]
    : [
        {
          key: "take-over",
          icon: <UserCheck size={14} />,
          label: "Take over",
          onRun: () => onSet("taken-over"),
        },
      ];
}

/**
 * @component SessionInspector
 * @purpose Right-sidebar inspector for the Session open in the main pane:
 * summary, related objects (workspace, a unified task tree, durable spawn and
 * fork lineage, staged draft context), session actions, and feature content via children
 * (SessionContextSections).
 * @useWhen The main pane shows a session or the new-session landing.
 * @related Inspector, SessionContextSections, TaskInspector, ProjectInspector.
 */
export function SessionInspector({
  sessionId,
  originTask,
  relatedTasks,
  sessionTasks,
  forkOrigin,
  credentialProfile,
  model,
  thinkingLevel,
  sessions,
  projects,
  worktree,
  worktreeStatus,
  stagedRefs = [],
  openers,
  onSettle,
  settled = false,
  settleBlockedReason,
  onRename,
  onArchive,
  onDelete,
  onOpenWorktreeChanges,
  onReviewWork,
  onSetSpawnOwnership,
  view,
  children,
}: {
  sessionId: string | undefined;
  originTask?: TaskBackRef | undefined;
  relatedTasks: TaskSummary[];
  /** Session-scoped task progress merged into the inspector's single Tasks section. */
  sessionTasks?: TaskSummary[];
  forkOrigin?: SessionForkOrigin | undefined;
  /** Immutable credential profile selected before the first prompt. */
  credentialProfile?:
    { name: string; provider: "openai-codex" | "claude" } | undefined;
  /** The model this session runs on (staged selection while it is still a draft). */
  model?: { id: string; name?: string; provider: string } | undefined;
  /** The session's thinking level, alongside the model it applies to. */
  thinkingLevel?: ThinkingLevel | undefined;
  sessions: SessionListItem[];
  /** Projects used to render worktree ownership hierarchy. */
  projects: ProjectRecord[];
  /** The worktree this session executes in, if any. */
  worktree?: WorktreeRelationSource | undefined;
  /** Live git status for the session worktree, when subscribed. */
  worktreeStatus?: WorktreeGitStatus | undefined;
  /** Draft-session staged context (task/project/worktree refs before the first send). */
  stagedRefs?: ObjectRef[];
  openers: ObjectOpeners;
  /**
   * Settle this session out of the Sessions inbox working set, or bring it
   * back. The panel's lead action: it is what you do with a session you are
   * finished reading.
   */
  onSettle?: (() => void) | undefined;
  /** This session is already out of the working set, so the action brings it back. */
  settled?: boolean;
  /**
   * Why settling is refused right now (`settleBlockedReason` from the shared
   * protocol). Disables the action with the same wording the inbox card uses.
   */
  settleBlockedReason?: string;
  onRename?: (() => void) | undefined;
  onArchive?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  /**
   * Open the session worktree's changes. Passed where the object dock is the
   * session's action home (mobile); the desktop chat header keeps its own button,
   * which carries a dirty-worktree indicator worth seeing without opening
   * anything.
   */
  onOpenWorktreeChanges?: (() => void) | undefined;
  /**
   * Start a NEW session staged to code-review this session's work (the
   * /review handoff). The host passes it only when there is work to review
   * and the session is not streaming — this must not be the one unguarded
   * way to put a second agent on a live working tree.
   */
  onReviewWork?: (() => void) | undefined;
  /**
   * Take this spawned session over, or hand it back to the coordinator that
   * spawned it. Offered only for a session with a spawn edge; messaging a
   * peer never moves ownership, so this is the one way it changes.
   */
  onSetSpawnOwnership?:
    ((ownership: SettableSpawnOwnership) => void) | undefined;
  /**
   * Transcript view toggles, rendered as a **View** section. Passed only where
   * this inspector is the session's control centre (the mobile object dock);
   * on desktop they live in the chat header's `⋯` menu.
   */
  view?:
    | (ChatViewPrefs & { onChange: (patch: Partial<ChatViewPrefs>) => void })
    | undefined;
  children?: ReactNode;
}) {
  const groups: ObjectRefGroup[] = [
    {
      id: "staged-context",
      label: "Staged context",
      icon: <ClipboardList size={13} />,
      ...(stagedRefs.length > 0 ? { summary: `${stagedRefs.length}` } : {}),
      refs: stagedRefs,
    },
    ...sessionRelationGroups({
      sessionId,
      ...(originTask !== undefined ? { originTask } : {}),
      relatedTasks,
      ...(sessionTasks !== undefined ? { sessionTasks } : {}),
      ...(forkOrigin !== undefined ? { forkOrigin } : {}),
      sessions,
      projects,
      ...(worktree !== undefined ? { worktree } : {}),
      ...(worktreeStatus !== undefined ? { worktreeStatus } : {}),
    }),
  ];
  // Every label is the bare verb: the panel already says which session this is,
  // so "Archive session" only repeated its own heading.
  const actions: InspectorAction[] = [
    // Settling is what you do with the session you just finished reading, so it
    // leads; reviewing its work is the next thing you reach for.
    ...(onSettle
      ? [
          {
            key: "settle",
            icon: settled ? <RotateCcw size={14} /> : <Check size={14} />,
            label: settled ? "Bring back" : "Settle",
            onRun: onSettle,
            // Unsettling is never blocked — it only adds work back.
            disabled: !settled && Boolean(settleBlockedReason),
            ...(!settled && settleBlockedReason
              ? { disabledReason: `Cannot settle: ${settleBlockedReason}` }
              : {}),
          },
        ]
      : []),
    ...(onReviewWork
      ? [
          {
            key: "review-work",
            icon: <SearchCheck size={14} />,
            label: "Review",
            onRun: onReviewWork,
          },
        ]
      : []),
    // Who runs a spawned session is the user's explicit decision: a message
    // is a poke, and the coordinator stays in charge until the user takes over.
    ...(spawnOwnershipAction(sessionId, sessions, onSetSpawnOwnership) ?? []),
    // The worktree glyph, not a diff one: this leaves the session for that
    // worktree's screen, and an action's icon should say where it lands.
    ...(onOpenWorktreeChanges
      ? [
          {
            key: "worktree-changes",
            icon: <GitBranch size={14} />,
            label: "View worktree changes",
            onRun: onOpenWorktreeChanges,
          },
        ]
      : []),
    ...(onRename
      ? [
          {
            key: "rename",
            icon: <Pencil size={14} />,
            label: "Rename",
            onRun: onRename,
          },
        ]
      : []),
    ...(onArchive
      ? [
          {
            key: "archive",
            icon: <Archive size={14} />,
            label: "Archive",
            onRun: onArchive,
          },
        ]
      : []),
    ...(onDelete
      ? [
          {
            key: "delete",
            icon: <Trash2 size={14} />,
            label: "Delete",
            onRun: onDelete,
          },
        ]
      : []),
  ];
  // Who runs this session, on what: the account is fixed at the first prompt,
  // the model and thinking level are what it runs on right now.
  // Only the account NAME: the provider is already implied by the model beside
  // it, and it was the half of the value that pushed the row into truncation.
  const profileFacts: InspectorFact[] = [
    ...(credentialProfile
      ? [{ label: "Account", value: credentialProfile.name }]
      : []),
    ...(model ? [{ label: "Model", value: model.name ?? model.id }] : []),
    ...(thinkingLevel
      ? [{ label: "Thinking", value: THINKING_LABELS[thinkingLevel] }]
      : []),
  ];
  // The section is collapsed by default, so its summary carries the same three
  // facts on one line — the panel still answers "who, on what" at a glance.
  const profileSummary = [
    credentialProfile?.name,
    model?.name ?? model?.id,
    thinkingLevel ? THINKING_LABELS[thinkingLevel] : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Inspector
      relations={toInspectorGroups(groups, openers)}
      actions={actions}
      sectionStorageScope={`session:${sessionId ?? "draft"}`}
    >
      {profileFacts.length > 0 ? (
        <InspectorSection
          id="credential-profile"
          storageScope={`session:${sessionId ?? "draft"}`}
          title="Profile"
          icon={<IdCard size={13} />}
          summary={profileSummary}
          defaultOpen={false}
        >
          <InspectorFacts facts={profileFacts} />
        </InspectorSection>
      ) : null}
      {children}
      {view ? (
        <InspectorSection
          id="view"
          storageScope={`session:${sessionId ?? "draft"}`}
          title="View"
          icon={<Eye size={13} />}
          defaultOpen={false}
        >
          <TranscriptViewRows view={view} />
        </InspectorSection>
      ) : null}
    </Inspector>
  );
}

/**
 * @component ProjectInspector
 * @purpose Right-sidebar inspector for the Project open in the main pane:
 * everything the page beside it does NOT show — the projects around this one,
 * the sessions its tasks pulled in, its local-path mappings, its settings and
 * its lifecycle actions.
 * @useWhen The main pane shows a Project detail route.
 * @avoidWhen Listing the project's tasks or worktrees: both are sections of the
 *   Project page, and the panel used to repeat them beside it.
 * @related Inspector, TaskInspector, ProjectDetailPage.
 */
export function ProjectInspector({
  project,
  projects,
  tasks,
  sessions,
  worktrees = [],
  worktreeState,
  onReloadWorktrees,
  openers,
  onStartSession,
  onSave,
  mutationStates = {},
  onArchive,
  onDelete,
  children,
}: {
  project: ProjectRecord | undefined;
  projects: ProjectRecord[];
  tasks: Task[];
  sessions: SessionListItem[];
  worktrees?: WorktreeRecord[];
  worktreeState?: LoadState<WorktreeRecord[]>;
  onReloadWorktrees?: () => void;
  openers: ObjectOpeners;
  onStartSession: (projectId: string) => void;
  /** Key/color edits and the archived↔active flip; the panel owns both. */
  onSave?: (patch: Partial<ProjectRecord>) => void;
  mutationStates?: Record<string, LoadState<true>>;
  onArchive?: () => void;
  onDelete?: () => void;
  children?: ReactNode;
}) {
  const archived = project?.status === "archived";
  const worktreeRows = worktreeState
    ? (dataOf(worktreeState) ?? [])
    : worktrees;
  const worktreeError = worktreeState ? errorOf(worktreeState) : undefined;
  const worktreesPending = worktreeState ? isPending(worktreeState) : false;
  const mutation = (operation: string) =>
    project ? mutationStates[`${project.id}:${operation}`] : undefined;
  const restoreMutation = mutation("field:status");
  const archiveMutation = mutation("archive");
  const deleteMutation = mutation("delete");
  const restoreError = restoreMutation ? errorOf(restoreMutation) : undefined;
  const archiveError = archiveMutation ? errorOf(archiveMutation) : undefined;
  const deleteError = deleteMutation ? errorOf(deleteMutation) : undefined;
  // The managed clone states itself in the page's Repository section, so the
  // panel's Local paths list holds only manually mapped extras.
  const mainCheckoutPath = worktreeRows.find(
    (worktree) => worktree.isMain && worktree.projectId === project?.id,
  )?.mainRepoRoot;
  const actions: InspectorAction[] = project
    ? [
        {
          key: "start-session",
          primary: true,
          icon: <MessageSquarePlus size={14} />,
          label: "Start session in this project",
          onRun: () => onStartSession(project.id),
        },
        // Archiving replaced a status dropdown on the page, so restoring has to
        // be here too: the Projects browser hides archived projects, making the
        // panel of a directly-opened project the only way back to active.
        ...(archived
          ? onSave
            ? [
                {
                  key: "unarchive",
                  icon: <ArchiveRestore size={14} />,
                  label: "Restore to active",
                  onRun: () => onSave({ status: "active" as ProjectStatus }),
                  keepOpen: true,
                  busy: mutation("field:status")
                    ? isPending(mutation("field:status")!)
                    : false,
                },
              ]
            : []
          : onArchive
            ? [
                {
                  key: "archive",
                  icon: <Archive size={14} />,
                  label: "Archive project",
                  onRun: onArchive,
                  busy: archiveMutation ? isPending(archiveMutation) : false,
                },
              ]
            : []),
        ...(onDelete
          ? [
              {
                key: "delete",
                icon: <Trash2 size={14} />,
                label: "Delete project",
                onRun: onDelete,
                busy: deleteMutation ? isPending(deleteMutation) : false,
              },
            ]
          : []),
      ]
    : [];
  return (
    <Inspector
      loading={!project}
      relations={
        project
          ? toInspectorGroups(
              projectRelationGroups(project, projects, tasks, sessions),
              openers,
            )
          : []
      }
      actions={actions}
      sectionStorageScope={`project:${project?.id ?? "loading"}`}
    >
      {children}
      {worktreeError ? (
        <ErrorNote message={worktreeError} onRetry={onReloadWorktrees} />
      ) : worktreesPending ? (
        <div
          role="status"
          className="flex items-center gap-2 text-caption text-faint"
        >
          <Spinner size="sm" /> Refreshing Project worktrees…
        </div>
      ) : null}
      {restoreError ? (
        <ErrorNote
          message={restoreError}
          onRetry={() => onSave?.({ status: "active" })}
        />
      ) : null}
      {archiveError ? (
        <ErrorNote message={archiveError} onRetry={onArchive} />
      ) : null}
      {deleteError ? (
        <ErrorNote message={deleteError} onRetry={onDelete} />
      ) : null}
      {project && onSave ? (
        <>
          {/* Everything the Project page used to carry as config: the key/color
              chips row, the worktree-root override under the worktree list, and
              the local-paths card. All rare, all edited here now. */}
          <ProjectLocalPathsSection
            project={project}
            hidePath={mainCheckoutPath}
            onSave={(localPaths) => onSave({ localPaths })}
            mutationState={mutation("field:localPaths")}
          />
          <InspectorSection
            id="project-settings"
            storageScope={`project:${project.id}`}
            title="Settings"
            icon={<SlidersHorizontal size={13} />}
            defaultOpen={false}
          >
            <ProjectSettingsFields
              project={project}
              onSave={onSave}
              mutationStates={mutationStates}
            />
          </InspectorSection>
        </>
      ) : null}
    </Inspector>
  );
}

/**
 * Resolve a worktree's references into inspector groups: the owning project
 * and the sessions executing in it. Pure so the shape is unit-testable.
 */
export function worktreeRelationGroups(
  worktree: WorktreeRecord,
  projects: ProjectRecord[],
  sessions: SessionListItem[],
): ObjectRefGroup[] {
  const project = projects.find(
    (candidate) => candidate.id === worktree.projectId,
  );
  const sessionsById = new Map(
    sessions.map((session) => [session.id, session]),
  );
  const relatedSessionIds = new Set<string>(worktree.sessionIds);
  for (const session of sessions) {
    if (session.worktreeId === worktree.id) relatedSessionIds.add(session.id);
  }
  const sessionRefs = [...relatedSessionIds]
    .map((sessionId) => sessionsById.get(sessionId))
    .filter((session): session is SessionListItem => Boolean(session))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((session): ObjectRef => {
      const subtitleValue = sessionRuntimeSubtitle(session);
      return {
        kind: "session",
        id: session.id,
        title: session.title,
        ...(subtitleValue !== undefined ? { subtitle: subtitleValue } : {}),
        running: Boolean(session.isStreaming),
      };
    });
  return [
    {
      id: "project",
      label: "Project",
      icon: <FolderKanban size={13} />,
      refs: project
        ? [
            {
              kind: "project" as const,
              id: project.id,
              title: `${project.key} · ${project.name}`,
            },
          ]
        : [],
    },
    {
      id: "sessions",
      label: "Sessions",
      icon: <MessageSquare size={13} />,
      ...(sessionRefs.length ? { summary: `${sessionRefs.length}` } : {}),
      refs: sessionRefs,
    },
  ];
}

/**
 * Inspector actions for a worktree. The main checkout (`isMain`) is read +
 * session only — it omits the destructive Merge-back and Remove actions.
 *
 * Ordering is the panel's, not each caller's: what you do to the WORK
 * (delivery: commit, push, sync, PR) sits between starting a session and the
 * irreversible lifecycle acts, because delivery no longer owns an actions list
 * of its own.
 */
export function worktreeInspectorActions(
  worktree: WorktreeRecord,
  handlers: {
    onStartSession: (id: string) => void;
    onMerge: (id: string) => void;
    onRemove: (id: string) => void;
    onRetire: () => void;
    /** A retirement is running; only its own action busies (R5). */
    retireBusy?: boolean;
    onSubmitReview?: () => void;
    pendingReviewCount?: number;
    /** The delivery actions from `useWorktreeDelivery`, already state-filtered. */
    deliveryActions?: InspectorAction[];
  },
): InspectorAction[] {
  const pendingReviewCount = Math.max(0, handlers.pendingReviewCount ?? 0);
  return [
    {
      key: "start-session",
      primary: true,
      icon: <MessageSquarePlus size={14} />,
      // The object the panel is about is the worktree: the label says the ACT,
      // not where it lands.
      label: "Start session",
      onRun: () => handlers.onStartSession(worktree.id),
    },
    ...(handlers.deliveryActions ?? []),
    ...(worktree.isMain
      ? []
      : [
          {
            key: "merge",
            icon: <GitMerge size={14} />,
            label: "Merge back…",
            onRun: () => handlers.onMerge(worktree.id),
          },
          {
            key: "remove",
            icon: <Trash2 size={14} />,
            label: "Remove worktree…",
            onRun: () => handlers.onRemove(worktree.id),
          },
          {
            // Retire is the END of a branch's life, and a different act from
            // Remove: it refreshes the merge target, VERIFIES this branch is
            // delivered into it, settles the sessions working here and only
            // then deletes the checkout and the branch. Remove does none of
            // that verification — it never fetches — so the two are not one
            // action with a flag, and neither replaces the other.
            key: "retire",
            icon: <ArchiveX size={14} />,
            label: "Retire worktree…",
            busy: handlers.retireBusy ?? false,
            onRun: () => handlers.onRetire(),
          },
        ]),
    // Only while there is something unsent: the batch is DERIVED from the
    // comments no session has been handed, so with nothing pending this action
    // would send nothing at all.
    ...(handlers.onSubmitReview && pendingReviewCount > 0
      ? [
          {
            key: "submit-review",
            icon: <SendHorizontal size={14} />,
            label: "Submit review",
            onRun: handlers.onSubmitReview,
            hint: `${pendingReviewCount} comment${pendingReviewCount === 1 ? "" : "s"}`,
            commentActuation: true,
          },
        ]
      : []),
  ];
}

/**
 * The worktree's review roster, as an INDEX — the same section a Knowledge
 * entry's panel carries, over the same list component in the same link mode. It
 * is the ONE place a worktree's comments are listed: a diff comment is read and
 * answered on the LINE it annotates, while the route-level CommentBar owns the
 * pending review action.
 */
function WorktreeReviewSection({
  comments,
  reviewSets,
  storageScope,
  onOpenComment,
}: {
  comments: WorktreeComment[];
  reviewSets: WorktreeReviewSet[];
  storageScope: string;
  onOpenComment?: ((commentId: string) => void) | undefined;
}) {
  const rows = useMemo(() => worktreeReviewThreads(comments), [comments]);
  const open = rows.filter((row) => row.state === "open").length;
  return (
    <InspectorSection
      id="comments"
      storageScope={storageScope}
      title="Comments"
      icon={<MessageSquare size={13} />}
      summary={rows.length ? `${open}/${rows.length}` : undefined}
    >
      {reviewSets.length ? (
        <div className="mb-2 space-y-1.5">
          {reviewSets.map((set) => (
            <div
              key={set.id}
              className="rounded-md border border-line px-2 py-1.5"
            >
              <div className="flex items-center gap-1.5 text-caption">
                <span className="rounded bg-accent-soft px-1 py-0.5 text-micro font-medium text-accent">
                  {set.authorModel ?? "agent"} ·{" "}
                  {set.authorSessionId.slice(0, 8)}
                </span>
                <span className="font-medium text-fg">
                  {set.verdict ?? "review in progress"}
                </span>
                <span className="ml-auto text-micro text-muted">
                  {set.openCount} open · {set.addressedCount} addressed
                </span>
              </div>
              {set.summary ? (
                <p className="mt-1 text-caption text-muted">{set.summary}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <ReviewCommentList
        threads={rows}
        emptyLabel="No review comments in this worktree yet."
        onOpen={(commentId) => onOpenComment?.(commentId)}
      />
    </InspectorSection>
  );
}

/**
 * @component WorktreeInspector
 * @purpose Right-sidebar inspector for the worktree open in the main pane:
 * status summary, owning project + sessions, and every action on the worktree
 * (lifecycle and delivery) in ONE Actions section. The changed files are NOT
 * here: the main pane already lists them.
 * @useWhen The main pane shows a worktree detail route.
 * @related Inspector, WorktreeDetailPage, TaskInspector, ProjectInspector.
 */
export function WorktreeInspector({
  worktree,
  status,
  projects,
  sessions,
  sessionsFresh,
  openers,
  onStartSession,
  onMerge,
  onRemove,
  comments = [],
  reviewSets = [],
  onOpenComment,
}: {
  worktree: WorktreeRecord | undefined;
  status?: WorktreeGitStatus | undefined;
  projects: ProjectRecord[];
  sessions: SessionListItem[];
  /**
   * That list answered in the CURRENT socket episode. Retire states a session
   * COUNT in its consent text, and a count off a stale list is a promise the
   * run contradicts (`worktree/useWorktreeRetire.tsx`).
   */
  sessionsFresh: boolean;
  openers: ObjectOpeners;
  onStartSession: (worktreeId: string) => void;
  onMerge: (worktreeId: string) => void;
  onRemove: (worktreeId: string) => void;
  /** This worktree's review comments (server-synced, loaded by the page). */
  comments?: WorktreeComment[];
  reviewSets?: WorktreeReviewSet[];
  /** Cross-pane: land on a comment's thread in the diff the main pane shows. */
  onOpenComment?: (commentId: string) => void;
}) {
  const commentActuation = useCommentActuation();
  const delivery = useWorktreeDelivery({
    worktree,
    ...(status !== undefined ? { status } : {}),
  });
  // Retire lives WITH the worktree it ends, beside Remove. Its `merged` fact is
  // read from this panel's own hosting answer rather than from the app-wide
  // projection: absent stays unknown there, and an unknown must not be allowed
  // to read as "delivered".
  const retire = useWorktreeRetire({
    worktree,
    ...(delivery.status !== undefined ? { status: delivery.status } : {}),
    sessions,
    sessionsFresh,
    merged: delivery.hosting?.pr?.state === "merged",
  });
  const actions: InspectorAction[] = worktree
    ? worktreeInspectorActions(worktree, {
        onStartSession,
        onMerge,
        onRemove,
        onRetire: retire.open,
        retireBusy: retire.busy,
        ...(commentActuation?.onSubmitReview !== undefined
          ? { onSubmitReview: commentActuation?.onSubmitReview }
          : {}),
        ...(commentActuation?.pendingCount !== undefined
          ? { pendingReviewCount: commentActuation?.pendingCount }
          : {}),
        deliveryActions: delivery.actions,
      })
    : [];
  const liveBranch = status?.branch ?? worktree?.branch;
  return (
    <Inspector
      loading={!worktree && !liveBranch}
      relations={
        worktree
          ? toInspectorGroups(
              worktreeRelationGroups(worktree, projects, sessions),
              openers,
            )
          : []
      }
      actions={actions}
      sectionStorageScope={`worktree:${worktree?.id ?? "loading"}`}
    >
      {worktree ? (
        <div className="space-y-4 text-caption">
          <InspectorSection
            id="checkout"
            storageScope={`worktree:${worktree.id}`}
            title="Checkout"
            icon={<GitBranch size={13} />}
            summary={liveBranch}
            // Where the checkout LIVES is reference material: the branch is
            // already in the panel's title and this section's summary, so it
            // opens closed and the sections that change stay in view.
            defaultOpen={false}
          >
            <InspectorFacts
              facts={[
                {
                  label: "Branch",
                  value: liveBranch,
                  mono: true,
                  ...(liveBranch !== undefined ? { title: liveBranch } : {}),
                },
                {
                  label: "Path",
                  value: worktree.path,
                  mono: true,
                  title: worktree.path,
                  // Every worktree of a project shares the prefix; the tail is
                  // the one that names THIS checkout.
                  truncate: "start" as const,
                },
                ...(worktree.isMain
                  ? []
                  : [
                      {
                        label: "Base",
                        value: worktree.baseBranch,
                        mono: true,
                        title: worktree.baseBranch,
                      },
                    ]),
              ]}
            />
          </InspectorSection>
          {/* Delivery: where the work stands. Its ACTS are up in the panel's
              one Actions section — a second list of actions under the facts
              gave the same reader two places to look. */}
          <WorktreeDeliverySection
            worktree={worktree}
            delivery={delivery}
            storageScope={`worktree:${worktree.id}`}
          />
          <WorktreeReviewSection
            comments={comments}
            reviewSets={reviewSets}
            storageScope={`worktree:${worktree.id}`}
            onOpenComment={onOpenComment}
          />
          {delivery.dialogs}
          {retire.dialog}
        </div>
      ) : null}
    </Inspector>
  );
}

/* ------------------------------- pull request ------------------------------ */

/** The rows a join's ids resolve to; a pending or absent id contributes none. */
function resolvedJoinRows<T>(
  ids: readonly string[],
  source: JoinSource<T>,
  identify: (row: T) => string,
): T[] {
  return resolveJoinRows(ids, source, identify).flatMap((row) =>
    row.kind === "resolved" ? [row.row] : [],
  );
}

/**
 * What a pull request is joined to on this machine, as links. Only what the
 * lists RESOLVE is listed: the page states the four answers a join can have
 * (`pullRequest/PullRequestDetailPage.tsx`), and a group with nothing resolved
 * is simply not drawn — this panel never claims an id is absent.
 */
export function pullRequestRelationGroups(
  item: PullRequestInventoryItem,
  projects: ProjectRecord[],
  joins: PullRequestJoinSources,
): ObjectRefGroup[] {
  const project = projects.find((candidate) => candidate.id === item.projectId);
  const worktrees = resolvedJoinRows(
    item.worktreeId ? [item.worktreeId] : [],
    joins.worktrees,
    (row) => row.id,
  );
  const sessions = resolvedJoinRows(
    item.sessionIds,
    joins.sessions,
    (row) => row.id,
  );
  const tasks = resolvedJoinRows(item.taskIds, joins.tasks, (row) => row.id);
  return [
    {
      id: "project",
      label: "Project",
      icon: <FolderKanban size={13} />,
      refs: project
        ? [
            {
              kind: "project" as const,
              id: project.id,
              title: `${project.key} · ${project.name}`,
            },
          ]
        : [],
    },
    {
      id: "worktree",
      label: "Worktree",
      icon: <GitBranch size={13} />,
      refs: worktrees.map((worktree) => worktreeObjectRef(worktree, projects)),
    },
    {
      id: "sessions",
      label: "Sessions",
      icon: <MessageSquare size={13} />,
      ...(sessions.length ? { summary: `${sessions.length}` } : {}),
      refs: sessions
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((session) => sessionObjectRef(session.id, session, session.id)),
    },
    {
      id: "tasks",
      label: "Tasks",
      icon: <ClipboardList size={13} />,
      ...(tasks.length ? { summary: `${tasks.length}` } : {}),
      refs: tasks.map((task) => taskObjectRef(task)),
    },
  ];
}

/**
 * Inspector actions for a pull request: what you do WITH it, in the order the
 * other panels use — the session first, then the work, then the act that ends
 * it, then the link out.
 *
 * Nothing that cannot do what it says is offered. A terminal pull request has
 * normally had its head branch deleted, so Review and Create worktree exist
 * only while it is OPEN — a control whose only possible answer is "that branch
 * is gone" is not an offer — and a terminal one with no checkout left has
 * nothing to clean up either. Start session is the one action listed
 * DISABLED: it is the reason to create the worktree, and hiding it would hide
 * the reason. A merge the pull request itself blocks (draft, a KNOWN
 * conflict, unreadable capabilities) is disabled with the same sentence the
 * page's Status block states as text (`pullRequestMergeBlockedReason`).
 */
export function pullRequestInspectorActions(
  item: PullRequestInventoryItem,
  handlers: {
    onStartSession: (worktreeId: string) => void;
    onReview: () => void;
    reviewBusy?: boolean;
    onCheckout: () => void;
    checkoutBusy?: boolean;
    onMerge: () => void;
    mergeBusy?: boolean;
    /**
     * The last merge attempt's outcome is unknown, so the act is not on offer:
     * the row asks what happened instead (`usePullRequestMergeCleanup`).
     */
    mergeSuspended?: boolean;
    onOpenExternal: () => void;
  },
): InspectorAction[] {
  const open = item.state === "open";
  const worktreeId = item.worktreeId;
  const blocked = pullRequestMergeBlockedReason(item);
  return [
    {
      key: "start-session",
      primary: true,
      icon: <MessageSquarePlus size={14} />,
      label: "Start session in worktree",
      ...(worktreeId
        ? { onRun: () => handlers.onStartSession(worktreeId) }
        : {
            onRun: () => {},
            disabled: true,
            disabledReason: "Create a worktree for this pull request first.",
            // The reason as VISIBLE row text too: a disabled row's tooltip
            // reaches neither a keyboard nor a phone.
            hint: "needs a worktree",
          }),
    },
    ...(open
      ? [
          {
            key: "review",
            icon: <Eye size={14} />,
            label: "Review in a session",
            busy: handlers.reviewBusy ?? false,
            // Its outcome is a NAVIGATION, which closes the dock itself; a
            // collapse on act would unmount the hook mid-flight and turn the
            // hand-off into a toast for a surface that is still there.
            keepOpen: true,
            onRun: handlers.onReview,
          },
          {
            key: "checkout",
            icon: <GitBranchPlus size={14} />,
            // The same convergent act either way: the label says which of
            // the two this click is.
            label: worktreeId ? "Update worktree" : "Create worktree",
            hint: item.headBranch,
            busy: handlers.checkoutBusy ?? false,
            // The row's busy state is its only progress report until the
            // toast; a collapse would drop it.
            keepOpen: true,
            onRun: handlers.onCheckout,
          },
        ]
      : []),
    ...(open || worktreeId
      ? [
          {
            key: "merge",
            icon: <GitMerge size={14} />,
            label: handlers.mergeSuspended
              ? "Check again"
              : open
                ? "Merge & clean up…"
                : "Clean up…",
            busy: handlers.mergeBusy ?? false,
            // Opens a DIALOG that lives in this panel's body; collapsing on
            // act would destroy the very dialog the act just opened.
            keepOpen: true,
            // While the last attempt's outcome is unknown the row stops
            // offering the act and offers the only thing that can answer it.
            // It stays ENABLED even where the pull request itself blocks a
            // merge: asking what happened is never the blocked thing.
            ...(blocked && !handlers.mergeSuspended
              ? { disabled: true, disabledReason: blocked }
              : {}),
            onRun: handlers.onMerge,
          },
        ]
      : []),
    {
      key: "open-external",
      icon: <ExternalLink size={14} />,
      label: `Open on ${hostingProviderLabel(item.provider)}`,
      hint: `#${item.number}`,
      // Changes nothing on the surface underneath.
      keepOpen: true,
      onRun: handlers.onOpenExternal,
    },
  ];
}

/**
 * @component PullRequestInspector
 * @purpose Right-sidebar inspector for the pull request open in the main pane:
 * its actions (start a session in its checkout, review, create the checkout,
 * merge & clean up, open on the provider) and what it is joined to here.
 * @useWhen The main pane shows a pull request detail route.
 * @avoidWhen The route is the section's index — there is no object to inspect.
 * @intent The page states what the provider says and what the pull request is
 * joined to; the ACTS live here, in the one Actions list every object type
 * has, rather than in a bar of their own on the page. The merge dialog and the
 * checkout flows are owned here for the same reason the worktree's delivery
 * flows are owned by its panel: their state is keyed by the object, and the
 * host keys this panel by the pull request so no consent-bearing refusal can
 * survive into another one.
 * @related Inspector, PullRequestDetailPage, WorktreeInspector.
 */
export function PullRequestInspector({
  state,
  projects,
  joins,
  openers,
  onStartSession,
  onReview,
  onReload,
}: {
  /**
   * This pull request out of the app's inventory, WITH what is known about the
   * read: `ready(null)` is the authoritative "not in the inventory", `loading`
   * is the inventory not having answered, and an error with nothing retained
   * is neither — the panel renders the three apart (R1), as the page does.
   */
  state: LoadState<PullRequestInventoryItem | null>;
  projects: ProjectRecord[];
  joins: PullRequestJoinSources;
  openers: ObjectOpeners;
  onStartSession: (worktreeId: string) => void;
  /** The checkout exists — hand the review off to the staged composer. */
  onReview: PullRequestReviewHandoff;
  /** Something changed on the server — refetch the inventory that shows it. */
  onReload: () => void;
}) {
  const item = dataOf(state) ?? null;
  const error = errorOf(state);
  // R1/R4: only a read that has not answered reserves the panel. A retained
  // item stays through a refresh or a failed one (R2).
  const loading = item === null && state.status === "loading";
  const merge = usePullRequestMergeCleanup({ item, onDone: onReload });
  const review = usePullRequestReview({ item, onReady: onReview });
  const checkout = usePullRequestWorktree({
    item,
    onDone: onReload,
    onStartSession,
  });
  const actions: InspectorAction[] = item
    ? pullRequestInspectorActions(item, {
        onStartSession,
        onReview: review.start,
        reviewBusy: review.busy,
        onCheckout: checkout.start,
        checkoutBusy: checkout.busy,
        onMerge: merge.open,
        mergeBusy: merge.busy,
        mergeSuspended: merge.suspended,
        onOpenExternal: () => window.open(item.url, "_blank", "noreferrer"),
      })
    : [];
  return (
    <Inspector
      loading={loading}
      relations={
        item
          ? toInspectorGroups(
              pullRequestRelationGroups(item, projects, joins),
              openers,
            )
          : []
      }
      actions={actions}
      sectionStorageScope={`pull-request:${item ? pullRequestRowId(item) : "loading"}`}
    >
      {/* R2: a failed read is stated whether or not an item was retained —
          beside the retained content, which stays actionable, or as the
          panel's whole answer when there is nothing else. */}
      {error ? <ErrorNote message={error} onRetry={onReload} /> : null}
      {item ? (
        merge.dialog
      ) : !loading && !error ? (
        <EmptyBox>This pull request is not in your inventory.</EmptyBox>
      ) : null}
    </Inspector>
  );
}
