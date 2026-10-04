import { useEffect, useMemo, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  ProjectRecord,
  SessionListItem,
  TaskSummary,
  WorkflowRunCard,
  WorkflowRunSummary,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import { SessionInbox } from "../../src/components/SessionInbox.tsx";
import { NAV_CARD_INSET } from "../../src/components/shell/PrimaryNav.tsx";
import type { RowDensity } from "../../src/lib/rowDensity.ts";

export interface SessionInboxStoryProps {
  frameWidth: number;
  density: RowDensity;
  scenario:
    "attention" | "quiet-list" | "all-states" | "sessions" | "workflow-runs";
}

/** A fixture override; `undefined` removes a default field. */
type SessionOverrides = {
  [K in keyof SessionListItem]?: SessionListItem[K] | undefined;
};

/** Drops the keys a fixture set to `undefined`, as the wire omits them. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
}

function session(
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

interface SessionInboxFixture {
  sessions: SessionListItem[];
  projects: ProjectRecord[];
  worktrees: WorktreeRecord[];
  tasks: TaskSummary[];
  worktreeStatuses: Record<string, WorktreeGitStatus>;
  workflowRuns?: WorkflowRunSummary[];
  workflowCards?: Record<string, WorkflowRunCard>;
  archivedSessionCount: number;
}

function attentionFixture(now: number): SessionInboxFixture {
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

/**
 * One card per state the inbox can show: every status, background work, a
 * cluster, Workflow Runs, each pull-request delivery rung and the quiet-card
 * variants. A catalog for design iteration, not a realistic list.
 */
const RUN_ROLE_IDS = [
  "run-coord",
  "run-impl",
  "run-rev",
  "paused-coord",
  "paused-fix",
];

function allStatesFixture(
  now: number,
  { withRuns, runsOnly = false }: { withRuns: boolean; runsOnly?: boolean },
): SessionInboxFixture {
  const min = 60_000;
  const quiet = (id: string, title: string, extra: SessionOverrides) =>
    session(now, id, title, { agentType: "developer", ...extra });
  const pr = (
    status: NonNullable<SessionListItem["pullRequest"]>["status"],
    extra: Partial<NonNullable<SessionListItem["pullRequest"]>> = {},
  ): SessionListItem["pullRequest"] => ({ status, ...extra });
  const sessions: SessionListItem[] = [
    // Needs you
    session(now, "question", "Question: which rail width?", {
      updatedAt: now - 1 * min,
      awaitingInput: true,
      attention: "question",
    }),
    session(now, "question-pr", "Question + PR, CI red", {
      updatedAt: now - 1 * min,
      awaitingInput: true,
      attention: "question",
      pullRequest: pr("open", {
        number: 331,
        ci: { state: "failure", total: 8 },
      }),
    }),
    session(now, "approval", "Approval: create Jira ticket", {
      updatedAt: now - 2 * min,
      awaitingInput: true,
      attention: "approval",
      projectId: "acme-portal",
      worktreeId: undefined,
    }),
    session(now, "task-choice", "Task choice for /pr", {
      updatedAt: now - 3 * min,
      awaitingInput: true,
      attention: "task-choice",
      pullRequest: pr("choosing-task"),
    }),
    // Attention
    session(now, "failed", "Failed with lastError", {
      updatedAt: now - 4 * min,
      lastError: {
        at: now - 4 * min,
        message: "Provider returned 529 overloaded after 3 retries",
      },
    }),
    session(now, "failed-pr", "Failed + PR with conflicts", {
      updatedAt: now - 4 * min,
      lastError: { at: now - 4 * min, message: "Rebase failed" },
      pullRequest: pr("open", {
        number: 332,
        ci: { state: "success", total: 8 },
        conflicts: true,
      }),
    }),
    session(now, "failed-outcome", "Failed outcome, unsettled", {
      updatedAt: now - 5 * min,
      unread: true,
      outcomeAttention: {
        revision: 2,
        settledRevision: 1,
        kind: "failed",
        at: now - 5 * min,
      },
    }),
    session(now, "interrupted", "Interrupted by restart", {
      updatedAt: now - 6 * min,
      interruptedRun: { at: now - 6 * min },
    }),
    session(now, "interrupted-pr", "Interrupted + draft PR", {
      updatedAt: now - 6 * min,
      interruptedRun: { at: now - 6 * min },
      pullRequest: pr("open", { number: 333, draft: true }),
    }),
    session(now, "unread", "Unread response (Done)", {
      updatedAt: now - 7 * min,
      unread: true,
      outcomeAttention: {
        revision: 1,
        settledRevision: 0,
        kind: "completed",
        at: now - 7 * min,
      },
    }),
    session(now, "unread-pr", "Done + PR merged", {
      updatedAt: now - 7 * min,
      unread: true,
      outcomeAttention: {
        revision: 1,
        settledRevision: 0,
        kind: "completed",
        at: now - 7 * min,
      },
      pullRequest: pr("merged", { number: 334 }),
    }),
    session(now, "unread-pr-review", "Done + PR changes requested", {
      updatedAt: now - 8 * min,
      unread: true,
      pullRequest: pr("open", {
        number: 335,
        ci: { state: "success", total: 8 },
        review: { changesRequested: true, unresolvedThreads: 2 },
      }),
    }),
    // Working
    session(now, "running", "Running with task progress", {
      agentType: "developer",
      updatedAt: now - 20_000,
      isStreaming: true,
      runStartedAt: now - 95_000,
      taskProgress: { todo: 2, doing: 1, done: 3 },
    }),
    session(now, "running-pr", "Working + PR, CI pending", {
      agentType: "developer",
      updatedAt: now - 20_000,
      isStreaming: true,
      runStartedAt: now - 3 * min,
      pullRequest: pr("open", {
        number: 336,
        ci: { state: "pending", total: 8 },
      }),
    }),
    session(now, "delegating", "Running with subagents", {
      agentType: "developer",
      updatedAt: now - 30_000,
      isStreaming: true,
      runStartedAt: now - 4 * min,
      delegation: {
        activeCount: 3,
        startingCount: 1,
        workingCount: 2,
        awaitingParentCount: 0,
      },
    }),
    quiet("background", "Idle, background shell running", {
      updatedAt: now - 2 * min,
      backgroundActivity: {
        activeCount: 2,
        shellCount: 1,
        monitorCommandCount: 1,
        monitorWebsocketCount: 0,
        startingCount: 0,
        stoppingCount: 0,
        oldestStartedAt: now - 12 * min,
      },
    }),
    // Cluster: coordinator with peers
    session(now, "coordinator", "Coordinator with peers", {
      agentType: "developer",
      updatedAt: now - 1 * min,
    }),
    session(now, "peer-working", "Peer: implementer", {
      agentType: "workshop",
      isStreaming: true,
      runStartedAt: now - 2 * min,
      spawnedBySessionId: "coordinator",
      spawnOwnership: "coordinator",
    }),
    session(now, "peer-waiting", "Peer: reviewer asks", {
      agentType: "developer",
      awaitingInput: true,
      attention: "question",
      spawnedBySessionId: "coordinator",
      spawnOwnership: "coordinator",
    }),
    session(now, "peer-done", "Peer: docs pass done", {
      agentType: "developer",
      unread: true,
      spawnedBySessionId: "coordinator",
      spawnOwnership: "coordinator",
    }),
    session(now, "peer-quiet", "Peer: idle helper", {
      agentType: "workshop",
      updatedAt: now - 20 * min,
      spawnedBySessionId: "coordinator",
      spawnOwnership: "coordinator",
    }),
    session(now, "peer-interrupted", "Peer: cut off by restart", {
      agentType: "developer",
      interruptedRun: { at: now - 4 * min },
      spawnedBySessionId: "coordinator",
      spawnOwnership: "coordinator",
    }),
    session(now, "peer-failed", "Peer: verifier failed", {
      agentType: "developer",
      lastError: { at: now - 3 * min, message: "Typecheck failed" },
      spawnedBySessionId: "coordinator",
      spawnOwnership: "coordinator",
    }),
    // A peer the implementer spawned in turn, waiting on its own test run.
    session(now, "peer-nested", "Peer: implementer's reviewer", {
      agentType: "developer",
      updatedAt: now - 5 * min,
      spawnedBySessionId: "peer-working",
      spawnOwnership: "coordinator",
      backgroundActivity: {
        activeCount: 1,
        shellCount: 1,
        monitorCommandCount: 0,
        monitorWebsocketCount: 0,
        startingCount: 0,
        stoppingCount: 0,
        oldestStartedAt: now - 4 * min,
      },
    }),
    // Settled history: out of the counts, listed only on request.
    session(now, "peer-settled", "Peer: earlier review, settled", {
      agentType: "developer",
      updatedAt: now - 90 * min,
      settledAt: now - 80 * min,
      spawnedBySessionId: "coordinator",
      spawnOwnership: "coordinator",
    }),
    // A quiet coordinator whose tree stopped while a reply is still owed.
    session(now, "stalled-coordinator", "Coordinator, stalled", {
      agentType: "developer",
      updatedAt: now - 25 * min,
      awaitingRepliesFrom: ["stalled-reviewer"],
    }),
    session(now, "stalled-reviewer", "Reviewer: DynamoDB service backend", {
      agentType: "developer",
      updatedAt: now - 30 * min,
      spawnedBySessionId: "stalled-coordinator",
      spawnOwnership: "coordinator",
    }),
    // Workflow Run roles (only with runs)
    ...(withRuns ? runRoleSessions() : []),
  ];
  function runRoleSessions(): SessionListItem[] {
    return [
      session(now, "run-coord", "Coordination", {
        agentType: "workflow-coordinator",
        updatedAt: now - 1 * min,
      }),
      session(now, "run-impl", "Implementation", {
        agentType: "developer",
        isStreaming: true,
        runStartedAt: now - 6 * min,
        pullRequest: pr("open", {
          number: 340,
          ci: { state: "pending", total: 8 },
        }),
      }),
      session(now, "run-rev", "First review pass", {
        agentType: "developer",
        updatedAt: now - 9 * min,
      }),
      session(now, "paused-coord", "Coordination", {
        agentType: "workflow-coordinator",
        updatedAt: now - 15 * min,
      }),
      session(now, "paused-fix", "Fix pass", {
        agentType: "developer",
        updatedAt: now - 16 * min,
        lastError: { at: now - 16 * min, message: "CI check lint failed" },
      }),
    ];
  }
  sessions.push(
    // Quiet: pull-request delivery rungs
    quiet("pr-creating", "PR creating", {
      updatedAt: now - 10 * min,
      pullRequest: pr("creating"),
    }),
    quiet("pr-failed", "PR drafting failed", {
      updatedAt: now - 11 * min,
      pullRequest: pr("failed"),
    }),
    quiet("pr-ci-failed", "PR with red CI", {
      updatedAt: now - 12 * min,
      pullRequest: pr("open", {
        number: 318,
        ci: { state: "failure", total: 8 },
      }),
    }),
    quiet("pr-conflicts", "PR with base conflicts", {
      updatedAt: now - 13 * min,
      pullRequest: pr("open", {
        number: 319,
        ci: { state: "success", total: 8 },
        conflicts: true,
      }),
    }),
    quiet("pr-review", "PR with changes requested", {
      updatedAt: now - 14 * min,
      pullRequest: pr("open", {
        number: 320,
        ci: { state: "success", total: 8 },
        review: { changesRequested: true, unresolvedThreads: 3 },
      }),
    }),
    quiet("pr-ci-pending", "PR with CI pending", {
      updatedAt: now - 15 * min,
      pullRequest: pr("open", {
        number: 321,
        ci: { state: "pending", total: 8 },
      }),
    }),
    quiet("pr-open", "PR open, CI green", {
      updatedAt: now - 16 * min,
      pullRequest: pr("open", {
        number: 322,
        ci: { state: "success", total: 8 },
      }),
    }),
    quiet("pr-draft", "PR draft", {
      updatedAt: now - 17 * min,
      pullRequest: pr("open", { number: 323, draft: true }),
    }),
    quiet("pr-merged", "PR merged", {
      updatedAt: now - 18 * min,
      pullRequest: pr("merged", { number: 311 }),
    }),
    quiet("pr-closed", "PR closed", {
      updatedAt: now - 19 * min,
      pullRequest: pr("closed", { number: 309 }),
    }),
    // Quiet variants
    quiet("quiet", "Quiet, clean worktree", {
      updatedAt: now - 25 * min,
      worktreeId: "pa-clean",
    }),
    quiet("queued", "Quiet with queued work", {
      updatedAt: now - 26 * min,
      worktreeId: "pa-pushed",
      queuedWork: true,
    }),
    quiet("forked", "Forked session", {
      updatedAt: now - 27 * min,
      forkOrigin: { parentSessionId: "quiet", position: "at" },
    }),
    quiet("naming", "New session", {
      updatedAt: now - 28 * min,
      titleGenerationPending: true,
      projectId: undefined,
      worktreeId: undefined,
    }),
    quiet("missing-worktree", "Worktree removed", {
      updatedAt: now - 29 * min,
      worktreeMissing: true,
    }),
    quiet("no-context", "No project or worktree", {
      agentType: "assistant",
      updatedAt: now - 3 * 3_600_000,
      projectId: undefined,
      worktreeId: undefined,
    }),
    // Settled shelf
    quiet("settled-1", "Settled session", {
      updatedAt: now - 5 * 3_600_000,
      settledAt: now - 4 * 3_600_000,
    }),
    quiet("settled-2", "Another settled session", {
      updatedAt: now - 26 * 3_600_000,
      settledAt: now - 25 * 3_600_000,
    }),
  );
  const projects: ProjectRecord[] = [
    {
      id: "personal-assistant",
      name: "Pandeck",
      key: "PA",
      color: "#5b62e6",
    },
    {
      id: "acme-portal",
      name: "Acme Portal",
      key: "CLP",
      color: "#e0672c",
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
      sessionIds: sessions
        .filter((item) => item.worktreeId === "pa-attention-rows")
        .map((item) => item.id),
      taskIds: ["714"],
      createdAt: now - 3_600_000,
      updatedAt: now - 60_000,
    },
    ...(["pa-clean", "pa-pushed"] as const).map((id) => ({
      id,
      projectId: "personal-assistant",
      mainRepoRoot: "/work/personal-assistant",
      path: `/work/${id}`,
      branch: id,
      baseBranch: "main",
      baseCommit: "0123456789abcdef",
      status: "active" as const,
      sessionIds: sessions
        .filter((item) => item.worktreeId === id)
        .map((item) => item.id),
      taskIds: [],
      createdAt: now - 3_600_000,
      updatedAt: now - 60_000,
    })),
  ];
  const extraRuns: {
    id: string;
    title: string;
    lifecycle: WorkflowRunSummary["lifecycle"];
    kind?: "paused" | "completed" | "cancelled";
    card?: Partial<WorkflowRunCard>;
  }[] = [
    {
      id: "run-waiting",
      title: "Run active, step waiting",
      lifecycle: "active",
      card: { phase: "ci", activity: "waiting" },
    },
    {
      id: "run-decide",
      title: "Run at a ceiling (Decide)",
      lifecycle: "paused",
      kind: "paused",
      card: {
        phase: "ceiling-decision",
        ceilingDecision: {
          blocked: "review-passes",
          wanted: "A third review pass",
          allowedChoices: ["raise", "deliver", "cancel"],
          ceilings: { maxIterations: 3, maxReviewPasses: 2 },
          spent: { iterations: 2, reviewPasses: 2, sessions: 5 },
          headCarriesDiscoveryReview: true,
          suggestedRaise: 1,
        },
      },
    },
    {
      id: "run-merge",
      title: "Run ready to merge (Merge?)",
      lifecycle: "paused",
      kind: "paused",
      card: { phase: "delivery", mergeDecisionReady: true },
    },
    {
      id: "run-cancelling",
      title: "Run cancelling",
      lifecycle: "active",
      card: { phase: "review", activity: "running", cancelRequested: true },
    },
    {
      id: "run-merged",
      title: "Run merged",
      lifecycle: "completed",
      kind: "completed",
      card: {
        phase: "observe",
        pullRequest: {
          cardId: "c1",
          sessionId: "run-coord",
          number: 330,
          url: "https://example.invalid/pr/330",
        },
      },
    },
    {
      id: "run-completed",
      title: "Run completed",
      lifecycle: "completed",
      kind: "completed",
      card: { phase: "observe" },
    },
    {
      id: "run-cancelled",
      title: "Run cancelled",
      lifecycle: "cancelled",
      kind: "cancelled",
      card: { phase: "review" },
    },
  ];
  const tasks: TaskSummary[] = [
    ...extraRuns.map(({ title }, index) => ({
      id: `9${index}`,
      title,
      status: "doing" as const,
      projectId: "personal-assistant",
      source: { createdBy: "user" as const },
      createdAt: now - 86_400_000,
      updatedAt: now - 60_000,
    })),
    {
      id: "714",
      title: "Fine-tune attention rows",
      status: "doing",
      projectId: "personal-assistant",
      sessionRefs: [{ sessionId: "running" }, { sessionId: "question" }],
      source: { createdBy: "user" },
      createdAt: now - 86_400_000,
      updatedAt: now - 60_000,
    },
    {
      id: "676",
      title: "Surface live Workflow Runs",
      status: "doing",
      projectId: "personal-assistant",
      source: { createdBy: "user" },
      createdAt: now - 86_400_000,
      updatedAt: now - 60_000,
    },
    {
      id: "690",
      title: "Paused delivery run",
      status: "doing",
      projectId: "personal-assistant",
      source: { createdBy: "user" },
      createdAt: now - 86_400_000,
      updatedAt: now - 60_000,
    },
  ];
  const workflowRuns: WorkflowRunSummary[] = [
    ...extraRuns.map(({ id, lifecycle, kind }, index) =>
      defined({
        id,
        taskId: `9${index}`,
        projectId: "personal-assistant",
        recipeId: "code-delivery",
        recipeVersion: 1,
        lifecycle,
        lifecycleReason: lifecycle === "active" ? undefined : "Reason",
        limits: { maxIterations: 3, maxReviewPasses: 2 },
        createdAt: now - 3 * 3_600_000,
        updatedAt: now - (20 + index) * min,
        endedAt:
          lifecycle === "completed" || lifecycle === "cancelled"
            ? now - (20 + index) * min
            : undefined,
        attention: kind
          ? {
              revision: 1,
              settledRevision: 0,
              kind,
              at: now - (20 + index) * min,
            }
          : undefined,
      } as WorkflowRunSummary),
    ),
    {
      id: "run-active",
      taskId: "676",
      projectId: "personal-assistant",
      recipeId: "code-delivery",
      recipeVersion: 1,
      worktreeId: "pa-attention-rows",
      branch: "pa-attention-rows",
      lifecycle: "active",
      limits: { maxIterations: 3, maxReviewPasses: 2 },
      createdAt: now - 3_600_000,
      updatedAt: now - 30_000,
    },
    {
      id: "run-paused",
      taskId: "690",
      projectId: "personal-assistant",
      recipeId: "code-delivery",
      recipeVersion: 1,
      lifecycle: "paused",
      lifecycleReason: "CI failed twice on the same check",
      limits: { maxIterations: 3, maxReviewPasses: 2 },
      createdAt: now - 2 * 3_600_000,
      updatedAt: now - 15 * min,
      attention: {
        revision: 1,
        settledRevision: 0,
        kind: "paused",
        at: now - 15 * min,
      },
    },
  ];
  const workflowCards: Record<string, WorkflowRunCard> = {
    "run-active": {
      runId: "run-active",
      phase: "implement",
      activity: "running",
      iterationsUsed: 1,
      nextAction: "Wait for the implementer to submit.",
      mergeDecisionReady: false,
      canRebaseAndReview: false,
      canRetry: false,
      canResume: false,
      coordinatorSessionId: "run-coord",
      implementerSessionId: "run-impl",
      pullRequest: {
        cardId: "pr-340",
        sessionId: "run-impl",
        number: 340,
        url: "https://example.invalid/pr/340",
      },
      reviewerSessions: [{ pass: 1, sessionId: "run-rev" }],
    },
    "run-paused": {
      runId: "run-paused",
      phase: "ci",
      activity: "waiting",
      iterationsUsed: 2,
      nextAction: "Decide whether to retry CI.",
      mergeDecisionReady: false,
      canRebaseAndReview: false,
      canRetry: true,
      canResume: true,
      coordinatorSessionId: "paused-coord",
      fixerSessionId: "paused-fix",
    },
    ...Object.fromEntries(
      extraRuns.map(({ id, card }) => [
        id,
        {
          runId: id,
          phase: "delivery",
          iterationsUsed: 1,
          nextAction: "",
          mergeDecisionReady: false,
          canRebaseAndReview: false,
          canRetry: false,
          canResume: false,
          ...card,
        } satisfies WorkflowRunCard,
      ]),
    ),
  };
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
    "pa-clean": {
      worktreeId: "pa-clean",
      branch: "pa-clean",
      head: "0123456",
      dirty: false,
      filesChanged: 0,
      untracked: 0,
      additions: 0,
      deletions: 0,
      ahead: 0,
      behind: 0,
      merged: false,
      updatedAt: now - 10_000,
    },
    "pa-pushed": {
      worktreeId: "pa-pushed",
      branch: "pa-pushed",
      head: "0123456",
      dirty: false,
      filesChanged: 0,
      untracked: 0,
      additions: 0,
      deletions: 0,
      ahead: 3,
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
    ...(runsOnly
      ? {
          sessions: sessions.filter((item) => RUN_ROLE_IDS.includes(item.id)),
        }
      : {}),
    workflowRuns: withRuns ? workflowRuns : [],
    workflowCards: withRuns ? workflowCards : {},
    archivedSessionCount: 4,
  };
}

function quietListFixture(now: number): SessionInboxFixture {
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
 * The production Sessions browser inside the same aside and scroll wrapper its
 * real host uses. Fixtures enter as wire-level rows; SessionInbox owns every
 * status, relation, cluster and ordering decision shown here.
 */
export function SessionInboxStory({
  frameWidth,
  density,
  scenario,
}: SessionInboxStoryProps) {
  const [now] = useState(() => Date.now());
  const initial = useMemo(
    () =>
      scenario === "quiet-list"
        ? quietListFixture(now)
        : scenario === "workflow-runs"
          ? allStatesFixture(now, { withRuns: true, runsOnly: true })
          : scenario === "all-states" || scenario === "sessions"
            ? allStatesFixture(now, { withRuns: scenario === "all-states" })
            : attentionFixture(now),
    [now, scenario],
  );
  const initialCurrentId =
    scenario === "quiet-list"
      ? "preview"
      : scenario === "all-states" ||
          scenario === "sessions" ||
          scenario === "workflow-runs"
        ? undefined
        : "coordinator";
  const [sessions, setSessions] = useState(initial.sessions);
  const [currentId, setCurrentId] = useState<string | undefined>(
    initialCurrentId,
  );

  useEffect(() => {
    setSessions(initial.sessions);
    setCurrentId(initialCurrentId);
  }, [initial, initialCurrentId]);

  const patchSession = (
    id: string,
    patch: (item: SessionListItem) => SessionListItem,
  ) =>
    setSessions((items) =>
      items.map((item) => (item.id === id ? patch(item) : item)),
    );

  // The cluster disclosure is SessionInbox's own state; the preview opens it
  // once on mount so the sibling rows are visible without a click.
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scenario === "attention" || scenario === "quiet-list") return;
    hostRef.current
      ?.querySelectorAll<HTMLButtonElement>(
        'button[aria-expanded="false"][aria-label^="Show the"]',
      )
      .forEach((button) => button.click());
  }, [scenario]);

  return (
    <div ref={hostRef} className="flex h-full bg-surface">
      <aside
        className="relative flex h-full shrink-0 flex-col overflow-hidden border-line bg-panel sm:border-r"
        style={{ width: frameWidth }}
      >
        <div
          className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 sm:px-2"
          style={
            density === "comfortable"
              ? { paddingBottom: NAV_CARD_INSET }
              : undefined
          }
        >
          <SessionInbox
            sessions={sessions}
            archivedSessionCount={initial.archivedSessionCount}
            archivedSessionsLoaded
            currentId={currentId}
            readCurrentId={currentId}
            projects={initial.projects}
            worktrees={initial.worktrees}
            tasks={initial.tasks}
            workflowRuns={initial.workflowRuns ?? []}
            workflowCards={initial.workflowCards ?? {}}
            worktreeStatuses={initial.worktreeStatuses}
            animateListChanges={false}
            density={density}
            onSelect={setCurrentId}
            onSettle={(id, settled) =>
              patchSession(id, (item) => {
                if (settled) return { ...item, settledAt: Date.now() };
                const { settledAt: _settledAt, ...unsettled } = item;
                return unsettled;
              })
            }
            onArchive={(id, archived) =>
              patchSession(id, (item) => ({ ...item, archived }))
            }
            onDeleteSession={(id) =>
              setSessions((items) => items.filter((item) => item.id !== id))
            }
            onRenameSession={(id) =>
              patchSession(id, (item) => ({
                ...item,
                title: `${item.title} (renamed)`,
              }))
            }
            onLoadArchivedSessions={() => {}}
            onOpenBackgroundTasks={() => {}}
            onOpenProject={() => {}}
            onOpenTask={() => {}}
            onOpenWorkflowRun={() => {}}
            onSettleWorkflowRun={() => {}}
            onOpenWorktree={() => {}}
          />
        </div>
      </aside>
    </div>
  );
}

const meta = {
  id: "session-inbox",
  title: "Sessions/Attention list",
  component: SessionInboxStory,
  parameters: { layout: "fullscreen" },
  argTypes: {
    frameWidth: { control: { type: "range", min: 220, max: 480, step: 1 } },
    density: { control: "inline-radio", options: ["tight", "comfortable"] },
    scenario: {
      control: "inline-radio",
      options: [
        "attention",
        "quiet-list",
        "all-states",
        "sessions",
        "workflow-runs",
      ],
    },
  },
} satisfies Meta<typeof SessionInboxStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AttentionMix: Story = {
  args: { frameWidth: 256, density: "tight", scenario: "attention" },
  globals: { viewport: { value: "paDesktop", isRotated: false } },
};

export const MinimumRail: Story = {
  args: { frameWidth: 220, density: "tight", scenario: "attention" },
  globals: { viewport: { value: "paDesktop", isRotated: false } },
};

export const Phone: Story = {
  args: { frameWidth: 390, density: "comfortable", scenario: "attention" },
  globals: { viewport: { value: "paPhone", isRotated: false } },
};

export const DarkLargeText: Story = {
  args: { frameWidth: 256, density: "tight", scenario: "attention" },
  globals: {
    theme: "dark",
    textScale: "120",
    viewport: { value: "paDesktop", isRotated: false },
  },
};

export const PhoneDarkLargeText: Story = {
  args: { frameWidth: 390, density: "comfortable", scenario: "attention" },
  globals: {
    theme: "dark",
    textScale: "130",
    viewport: { value: "paPhone", isRotated: false },
  },
};

export const PhoneQuietList: Story = {
  args: { frameWidth: 390, density: "comfortable", scenario: "quiet-list" },
  globals: {
    theme: "dark",
    textScale: "130",
    viewport: { value: "paPhone", isRotated: false },
  },
};

export const AllStates: Story = {
  args: { frameWidth: 256, density: "tight", scenario: "all-states" },
  globals: { viewport: { value: "paDesktop", isRotated: false } },
};

export const AllStatesDark: Story = {
  args: { frameWidth: 256, density: "tight", scenario: "all-states" },
  globals: {
    theme: "dark",
    viewport: { value: "paDesktop", isRotated: false },
  },
};

export const AllStatesPhone: Story = {
  args: { frameWidth: 390, density: "comfortable", scenario: "all-states" },
  globals: { viewport: { value: "paPhone", isRotated: false } },
};

export const Sessions: Story = {
  args: { frameWidth: 256, density: "tight", scenario: "sessions" },
  globals: { viewport: { value: "paDesktop", isRotated: false } },
};

export const WorkflowRuns: Story = {
  args: { frameWidth: 256, density: "tight", scenario: "workflow-runs" },
  globals: { viewport: { value: "paDesktop", isRotated: false } },
};
