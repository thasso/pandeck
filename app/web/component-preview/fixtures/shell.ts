import type {
  ProjectRecord,
  SessionListItem,
  TaskSummary,
  WorkflowRunCard,
  WorkflowRunSummary,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import {
  createInitialState,
  type AssistantActions,
} from "../../src/hooks/useAssistant.ts";
import type { BacklogState } from "../../src/hooks/useBacklog.ts";
import type { Prefs } from "../../src/hooks/usePrefs.ts";
import { DEFAULT_NAV_SLOTS } from "../../src/hooks/useSidebarSection.ts";
import { ALL_PROJECT_FILTER } from "../../src/lib/backlogTreeModel.ts";

/** A fixture override; `undefined` removes a default field. */
export type SessionOverrides = {
  [K in keyof SessionListItem]?: SessionListItem[K] | undefined;
};

/** Drops the keys a fixture set to `undefined`, as the wire omits them. */
export function defined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
}

export function session(
  now: number,
  id: string,
  title: string,
  extra: SessionOverrides = {},
): SessionListItem {
  return defined({
    id,
    harness: "pi",
    agentType: "assistant",
    title,
    createdAt: now - 3_600_000,
    updatedAt: now - 60_000,
    messageCount: 4,
    projectId: "personal-assistant",
    worktreeId: "pa-attention-rows",
    ...extra,
  } as SessionListItem);
}

export interface SessionInboxFixture {
  sessions: SessionListItem[];
  projects: ProjectRecord[];
  worktrees: WorktreeRecord[];
  tasks: TaskSummary[];
  worktreeStatuses: Record<string, WorktreeGitStatus>;
  workflowRuns?: WorkflowRunSummary[];
  workflowCards?: Record<string, WorkflowRunCard>;
  archivedSessionCount: number;
}

export function attentionFixture(now: number): SessionInboxFixture {
  const sessions = [
    session(now, "coordinator", "Refine attention list rows", {
      agentType: "workflow-coordinator",
      updatedAt: now - 25_000,
    }),
    session(now, "reviewer", "Review the attention list changes", {
      agentType: "developer",
      updatedAt: now - 2 * 60_000,
      awaitingInput: true,
      attention: "question",
      spawnedBySessionId: "coordinator",
      spawnOwnership: "coordinator",
    }),
    session(now, "implementer", "Tighten the session row spacing", {
      agentType: "workshop",
      updatedAt: now - 18_000,
      isStreaming: true,
      runStartedAt: now - 18_000,
      spawnedBySessionId: "coordinator",
      spawnOwnership: "coordinator",
      backgroundActivity: {
        activeCount: 1,
        shellCount: 1,
        monitorCommandCount: 0,
        monitorWebsocketCount: 0,
        startingCount: 0,
        stoppingCount: 0,
        oldestStartedAt: now - 43_000,
      },
    }),
    session(now, "failed", "Verify narrow-screen behavior", {
      updatedAt: now - 7 * 60_000,
      lastError: {
        at: now - 7 * 60_000,
        message: "The 220px row clips the Task jump button",
      },
    }),
    session(now, "delivered", "Ship the row density update", {
      updatedAt: now - 34 * 60_000,
      pullRequest: {
        status: "open",
        number: 314,
        ci: { state: "success", total: 8 },
      },
    }),
    session(now, "quiet", "Plan the next attention-list pass", {
      agentType: "developer",
      updatedAt: now - 2 * 3_600_000,
    }),
  ];
  const projects: ProjectRecord[] = [
    {
      id: "personal-assistant",
      name: "Pandeck",
      key: "PA",
      color: "#5b62e6",
    },
  ];
  const worktrees: WorktreeRecord[] = [
    {
      id: "pa-attention-rows",
      projectId: "personal-assistant",
      mainRepoRoot: "/work/personal-assistant",
      path: "/work/pa-attention-rows",
      branch: "pa-attention-rows",
      baseBranch: "main",
      baseCommit: "0123456789abcdef",
      status: "active",
      sessionIds: sessions.map((item) => item.id),
      taskIds: ["714"],
      createdAt: now - 3_600_000,
      updatedAt: now - 60_000,
    },
  ];
  const tasks: TaskSummary[] = [
    {
      id: "714",
      title: "Fine-tune attention rows",
      status: "doing",
      projectId: "personal-assistant",
      sessionRefs: sessions.map((item) => ({ sessionId: item.id })),
      source: { createdBy: "user" },
      createdAt: now - 86_400_000,
      updatedAt: now - 60_000,
    },
  ];
  const worktreeStatuses: Record<string, WorktreeGitStatus> = {
    "pa-attention-rows": {
      worktreeId: "pa-attention-rows",
      branch: "pa-attention-rows",
      head: "0123456",
      dirty: true,
      filesChanged: 4,
      untracked: 1,
      additions: 128,
      deletions: 35,
      ahead: 2,
      behind: 0,
      merged: false,
      updatedAt: now - 10_000,
    },
  };
  return {
    sessions,
    projects,
    worktrees,
    tasks,
    worktreeStatuses,
    archivedSessionCount: 2,
  };
}

export function quietListFixture(now: number): SessionInboxFixture {
  const roots = [
    session(now, "preview", "Plan Live UI Component Preview Iteration", {
      updatedAt: now - 7 * 60_000,
    }),
    session(
      now,
      "distribution",
      "Commit, Rebase, and Verify Bun Distribution",
      {
        updatedAt: now - 32 * 60_000,
      },
    ),
    session(now, "captures", "Decouple Boards from Captures", {
      projectId: "nebula-capture",
      worktreeId: "boards-captures",
      updatedAt: now - 2 * 86_400_000,
    }),
    session(now, "signal", "Analyze HDSDM-349 Capture for Mark", {
      projectId: "nebula-capture",
      worktreeId: "restore-signal-strength",
      updatedAt: now - 2 * 86_400_000,
    }),
    session(
      now,
      "forwarding",
      "Investigate Built-In Port Forwarding for Tauri",
      {
        updatedAt: now - 8 * 86_400_000,
      },
    ),
    session(now, "retrieval", "Investigate Portal Capture Retrieval API", {
      projectId: "nebula-portal",
      worktreeId: "portal-main",
      updatedAt: now - 9 * 86_400_000,
    }),
    session(now, "f2f", "F2F Data Download", {
      projectId: "nebula-portal",
      worktreeId: "portal-main",
      updatedAt: now - 12 * 86_400_000,
    }),
  ].map((item) => ({ ...item, agentType: "workshop" as const }));
  const children = [
    ...Array.from({ length: 3 }, (_, index) =>
      session(now, `captures-${index}`, `Capture helper ${index + 1}`, {
        projectId: "nebula-capture",
        worktreeId: "boards-captures",
        spawnedBySessionId: "captures",
        spawnOwnership: "coordinator",
      }),
    ),
    ...Array.from({ length: 8 }, (_, index) =>
      session(now, `signal-${index}`, `Signal helper ${index + 1}`, {
        projectId: "nebula-capture",
        worktreeId: "restore-signal-strength",
        spawnedBySessionId: "signal",
        spawnOwnership: "coordinator",
      }),
    ),
    ...Array.from({ length: 2 }, (_, index) =>
      session(now, `forwarding-${index}`, `Forwarding helper ${index + 1}`, {
        spawnedBySessionId: "forwarding",
        spawnOwnership: "coordinator",
      }),
    ),
  ];
  const sessions = [...roots, ...children];
  const projects: ProjectRecord[] = [
    {
      id: "personal-assistant",
      name: "Pandeck",
      key: "PA",
      color: "#78d900",
    },
    {
      id: "nebula-capture",
      name: "Nebula Capture",
      key: "SDC",
      color: "#78d900",
    },
    {
      id: "nebula-portal",
      name: "Nebula Portal",
      key: "SDP",
      color: "#5b45ff",
    },
  ];
  const makeWorktree = (
    id: string,
    projectId: string,
    branch: string,
  ): WorktreeRecord => ({
    id,
    projectId,
    mainRepoRoot: `/work/${projectId}`,
    path: `/work/${id}`,
    branch,
    baseBranch: "main",
    baseCommit: "0123456789abcdef",
    status: "active",
    sessionIds: sessions
      .filter((item) => item.worktreeId === id)
      .map((item) => item.id),
    taskIds: [],
    createdAt: now - 30 * 86_400_000,
    updatedAt: now - 60_000,
  });
  const worktrees = [
    makeWorktree("pa-attention-rows", "personal-assistant", "pa-live-preview"),
    makeWorktree("boards-captures", "nebula-capture", "nebula-labs-app"),
    makeWorktree(
      "restore-signal-strength",
      "nebula-capture",
      "restore-signal-strength",
    ),
    makeWorktree("portal-main", "nebula-portal", "main"),
  ];
  const tasks: TaskSummary[] = [
    {
      id: "678",
      title: "Restore signal strength",
      status: "doing",
      projectId: "nebula-capture",
      sessionRefs: [{ sessionId: "signal" }],
      source: { createdBy: "user" },
      createdAt: now - 10 * 86_400_000,
      updatedAt: now - 2 * 86_400_000,
    },
  ];
  const worktreeStatuses = Object.fromEntries(
    worktrees.map((worktree, index) => [
      worktree.id,
      {
        worktreeId: worktree.id,
        branch: worktree.branch,
        head: "0123456",
        dirty: index === 0 || index === 2,
        filesChanged: index === 0 || index === 2 ? 2 : 0,
        untracked: 0,
        additions: 20,
        deletions: 4,
        ahead: 1,
        behind: 0,
        merged: false,
        updatedAt: now - 60_000,
      } satisfies WorktreeGitStatus,
    ]),
  );
  return {
    sessions,
    projects,
    worktrees,
    tasks,
    worktreeStatuses,
    archivedSessionCount: 0,
  };
}

/**
 * Every assistant action as a no-op: the shell stories render the sidebar and
 * inspectors, which hand these down without calling them on mount.
 */
export const noopActions = new Proxy(
  {},
  { get: () => () => undefined },
) as AssistantActions;

/** A connected client whose Backlog has answered with nothing yet. */
export function shellBacklogState(sessions: SessionListItem[]): BacklogState {
  const { taskList, taskListError, projectList, taskMutations } =
    createInitialState();
  return {
    connected: true,
    taskList,
    taskListError,
    projectList,
    taskMutations,
    taskProjectsAssignedSeq: 0,
    sessions,
    worktreeMerge: {},
  };
}

/** The shipped preferences, as a fresh profile has them. */
export const shellPrefs: Prefs = {
  theme: "light",
  textScale: 100,
  showThinking: false,
  showTools: false,
  expandThinking: false,
  expandTools: false,
  wrapToolLines: false,
  sidebarWidth: 256,
  navSlots: [...DEFAULT_NAV_SLOTS],
  taskDrawerWidth: 320,
  backlogMasterWidth: 360,
  animateLeftSidebar: false,
  animateRightDrawer: false,
  animateListChanges: false,
  backlogStatusFilter: ["todo", "doing", "done"],
  backlogView: "backlog",
  backlogViewMode: "normal",
  backlogProjectFilter: ALL_PROJECT_FILTER,
  worktreeChangesRailWidth: 300,
  worktreeChangesRailCollapsed: false,
  worktreeNavigatorViewMode: "tree",
  diffStyle: "unified",
  diffWordLevel: true,
  diffIgnoreWhitespace: true,
  diffWrap: false,
  diffExpandContext: false,
};
