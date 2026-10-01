import { describe, expect, it } from "vitest";
import type {
  ProjectRecord,
  PullRequestInventoryItem,
  SessionListItem,
  TaskSummary,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import type { KnowledgeEntryInspect } from "@assistant/shared/knowledgeBase";
import {
  knowledgeRelationGroups,
  projectRelationGroups,
  pullRequestInspectorActions,
  pullRequestRelationGroups,
  sessionRelationGroups,
  taskRelationGroups,
  worktreeInspectorActions,
  worktreeRelationGroups,
} from "./objectInspectors.tsx";

function task(
  partial: Partial<TaskSummary> & { id: string; title: string },
): TaskSummary {
  return {
    status: "todo",
    source: { createdBy: "user" },
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

function session(
  partial: Partial<SessionListItem> & { id: string; title: string },
): SessionListItem {
  return {
    harness: "pi",
    agentType: "assistant",
    createdAt: 0,
    updatedAt: 0,
    messageCount: 1,
    ...partial,
  };
}

const project: ProjectRecord = { id: "p1", name: "Assistant", key: "PA" };
const parentProject: ProjectRecord = { id: "p0", name: "Root", key: "RT" };

describe("taskRelationGroups", () => {
  const parent = task({ id: "t0", title: "Parent" });
  const child = task({ id: "t2", title: "Child", parentId: "t1" });
  const subject = task({
    id: "t1",
    title: "Subject",
    parentId: "t0",
    projectId: "p1",
    sessionRefs: [{ sessionId: "s1", origin: "task-start" }],
  });
  const sessions = [
    session({ id: "s1", title: "Working session" }),
    session({ id: "s2", title: "Unrelated" }),
  ];

  it("resolves hierarchy and sessions (project lives in TaskContextSections)", () => {
    const groups = taskRelationGroups(
      subject,
      [parent, subject, child],
      sessions,
    );
    expect(groups.find((g) => g.label === "Project")).toBeUndefined();
    expect(groups.find((g) => g.label === "Related tasks")?.refs).toEqual([
      {
        kind: "task",
        id: "t0",
        title: "Parent",
        subtitle: "Parent task",
        taskStatus: "todo",
      },
      {
        kind: "task",
        id: "t2",
        title: "Child",
        subtitle: "Subtask",
        taskStatus: "todo",
      },
    ]);
    const sessionRefs = groups.find((g) => g.label === "Sessions")?.refs ?? [];
    expect(sessionRefs.map((r) => r.id)).toEqual(["s1"]);
    expect(sessionRefs.find((r) => r.id === "s1")).toMatchObject({
      title: "Working session",
      subtitle: "Started from this task",
    });
  });

  it("returns empty groups for an unconnected task", () => {
    const lonely = task({ id: "t9", title: "Lonely" });
    const groups = taskRelationGroups(lonely, [lonely], []);
    expect(groups.every((g) => g.refs.length === 0)).toBe(true);
  });
});

describe("sessionRelationGroups", () => {
  it("resolves tasks as one status-counted section and preserves fork lineage", () => {
    const sessions = [
      session({ id: "parent", title: "Parent chat" }),
      session({ id: "self", title: "Self" }),
      session({
        id: "fork1",
        title: "Fork one",
        forkOrigin: { parentSessionId: "self", parentSessionFile: "self" },
      }),
    ];
    const groups = sessionRelationGroups({
      sessionId: "self",
      originTask: { id: "t1", title: "Origin", status: "doing" },
      relatedTasks: [
        task({ id: "t1", title: "Origin", status: "doing" }),
        task({ id: "t2", title: "Linked" }),
      ],
      forkOrigin: { parentSessionId: "parent", parentSessionFile: "parent" },
      sessions,
    });
    const taskGroup = groups.find((g) => g.label === "Tasks");
    expect(taskGroup?.summary).toBe("1 doing · 1 task · 0 done");
    expect(taskGroup?.refs).toEqual([
      { kind: "task", id: "t1", title: "Origin", taskStatus: "doing" },
      { kind: "task", id: "t2", title: "Linked", taskStatus: "todo" },
    ]);
    expect(groups.find((g) => g.label === "Fork lineage")?.refs).toEqual([
      {
        kind: "session",
        id: "parent",
        title: "Parent chat",
        subtitle: "Forked from",
      },
      {
        kind: "session",
        id: "fork1",
        title: "Fork one",
        subtitle: "Fork of this session",
      },
    ]);
  });

  it("projects durable spawn parentage in both directions with current state", () => {
    const sessions = [
      session({
        id: "coordinator",
        title: "Coordinator",
        isStreaming: true,
        model: { provider: "openai-codex", id: "gpt-5" },
      }),
      session({
        id: "child",
        title: "Implementer",
        spawnedBySessionId: "coordinator",
        spawnOwnership: "coordinator",
      }),
      session({
        id: "reviewer",
        title: "Reviewer",
        spawnedBySessionId: "coordinator",
        spawnOwnership: "taken-over",
        thinkingLevel: "high",
      }),
      session({
        id: "legacy",
        title: "Legacy child",
        spawnedBySessionId: "coordinator",
        spawnOwnership: "unknown",
      }),
    ];

    const childGroups = sessionRelationGroups({
      sessionId: "child",
      relatedTasks: [],
      sessions,
    });
    expect(
      childGroups.find((group) => group.label === "Spawned by")?.refs,
    ).toEqual([
      {
        kind: "session",
        id: "coordinator",
        title: "Coordinator",
        subtitle: "Running · openai-codex · gpt-5",
        running: true,
      },
    ]);

    const parentGroups = sessionRelationGroups({
      sessionId: "coordinator",
      relatedTasks: [],
      sessions,
    });
    expect(
      parentGroups.find((group) => group.label === "Spawned sessions"),
    ).toMatchObject({
      summary: "3",
      refs: [
        { kind: "session", id: "child", title: "Implementer" },
        {
          kind: "session",
          id: "reviewer",
          title: "Reviewer",
          // The takeover marker leads, and the runtime detail survives beside it.
          subtitle: "Taken over · thinking high",
        },
        { kind: "session", id: "legacy", title: "Legacy child" },
      ],
    });
    // Only the taken-over row is labelled: coordinator-owned and untracked
    // children carry no marker at all.
    expect(
      parentGroups
        .find((group) => group.label === "Spawned sessions")
        ?.refs.filter((ref) => ref.subtitle?.includes("Taken over"))
        .map((ref) => ref.id),
    ).toEqual(["reviewer"]);
  });

  it("keeps a spawned parent navigable when its list row is unavailable", () => {
    const groups = sessionRelationGroups({
      sessionId: "child",
      relatedTasks: [],
      sessions: [
        session({
          id: "child",
          title: "Child",
          spawnedBySessionId: "missing-parent",
        }),
      ],
    });

    expect(groups.find((group) => group.label === "Spawned by")?.refs).toEqual([
      {
        kind: "session",
        id: "missing-parent",
        title: "Coordinator session",
      },
    ]);
  });

  it("renders a session worktree as an expanded project tree with branch and change counters", () => {
    const status: WorktreeGitStatus = {
      worktreeId: "wt1",
      branch: "feature/session-inspector",
      head: "abc123",
      dirty: true,
      filesChanged: 2,
      untracked: 1,
      additions: 10,
      deletions: 3,
      ahead: 0,
      behind: 0,
      merged: false,
      updatedAt: 1,
    };
    const worktree: WorktreeRecord = {
      id: "wt1",
      projectId: "p1",
      mainRepoRoot: "/repo",
      path: "/repo/assistant-inspector",
      branch: "feature/session-inspector",
      baseBranch: "main",
      baseCommit: "abc",
      status: "active",
      sessionIds: [],
      taskIds: [],
      createdAt: 0,
      updatedAt: 0,
    };
    const groups = sessionRelationGroups({
      sessionId: "self",
      relatedTasks: [],
      sessions: [],
      projects: [project],
      worktree,
      worktreeStatus: status,
    });
    expect(groups.find((g) => g.label === "Workspace")?.refs).toEqual([
      {
        kind: "project",
        id: "p1",
        title: "PA · Assistant",
        children: [
          {
            kind: "worktree",
            id: "wt1",
            title: "assistant-inspector",
            subtitle:
              "branch feature/session-inspector · 2 files · 1 untracked",
            counters: { additions: 10, deletions: 3 },
          },
        ],
      },
    ]);
  });

  it("returns empty groups for a fresh unlinked session", () => {
    const groups = sessionRelationGroups({
      sessionId: undefined,
      relatedTasks: [],
      sessions: [],
    });
    expect(groups.every((g) => g.refs.length === 0)).toBe(true);
  });
});

describe("worktreeRelationGroups", () => {
  const worktree: WorktreeRecord = {
    id: "wt1",
    projectId: "p1",
    mainRepoRoot: "/repo",
    path: "/repo-wt",
    branch: "feature",
    baseBranch: "main",
    baseCommit: "abc",
    status: "active",
    sessionIds: ["older", "missing"],
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
  };

  it("sorts linked sessions by recency and shows runtime metadata", () => {
    const groups = worktreeRelationGroups(
      worktree,
      [project],
      [
        session({
          id: "newer",
          title: "Newer",
          worktreeId: "wt1",
          updatedAt: 20,
          isStreaming: true,
          model: { provider: "github-copilot", id: "gpt-5" },
          thinkingLevel: "high",
        }),
        session({
          id: "older",
          title: "Older",
          updatedAt: 10,
          model: {
            provider: "claude-sdk",
            id: "sonnet",
            name: "Claude Sonnet",
          },
          thinkingLevel: "medium",
        }),
        session({
          id: "other",
          title: "Other",
          worktreeId: "else",
          updatedAt: 30,
        }),
      ],
    );
    expect(groups.find((g) => g.label === "Sessions")?.refs).toEqual([
      {
        kind: "session",
        id: "newer",
        title: "Newer",
        subtitle: "Running · github-copilot · gpt-5 · thinking high",
        running: true,
      },
      {
        kind: "session",
        id: "older",
        title: "Older",
        subtitle: "Claude SDK · Claude Sonnet · thinking medium",
        running: false,
      },
    ]);
  });
});

describe("worktreeInspectorActions", () => {
  const handlers = {
    onStartSession: () => {},
    onMerge: () => {},
    onRemove: () => {},
    onRetire: () => {},
  };
  const base: WorktreeRecord = {
    id: "wt1",
    projectId: "p1",
    mainRepoRoot: "/repo",
    path: "/repo-wt",
    branch: "feature",
    baseBranch: "main",
    baseCommit: "abc",
    status: "active",
    sessionIds: [],
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
  };

  // Retire is the lifecycle action the deleted Worktrees inbox used to own: it
  // verifies delivery before ending the branch, which Remove cannot do. It has
  // to stay REACHABLE here, or the capability quietly left with that surface.
  it("offers merge-back, remove and retire for a spawned worktree", () => {
    expect(worktreeInspectorActions(base, handlers).map((a) => a.key)).toEqual([
      "start-session",
      "merge",
      "remove",
      "retire",
    ]);
  });

  it("hides the lifecycle actions for the main checkout", () => {
    const main: WorktreeRecord = {
      ...base,
      id: "main:p1",
      isMain: true,
      path: "/repo",
      branch: "main",
    };
    expect(worktreeInspectorActions(main, handlers).map((a) => a.key)).toEqual([
      "start-session",
    ]);
  });
});

describe("pullRequestInspectorActions", () => {
  const handlers = {
    onStartSession: () => {},
    onReview: () => {},
    onCheckout: () => {},
    onMerge: () => {},
    onOpenExternal: () => {},
  };
  const base: PullRequestInventoryItem = {
    projectId: "p1",
    provider: "github",
    repositoryKey: "acme/app",
    repoWebUrl: "https://github.com/acme/app",
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    title: "Feature",
    headBranch: "feature",
    baseBranch: "main",
    mine: true,
    reviewRequested: false,
    state: "open",
    mergeable: true,
    capabilities: {
      defaultBranch: "main",
      mergeMethods: ["squash"],
      canDeleteBranchOnMerge: true,
    },
    sessionIds: [],
    taskIds: [],
  };
  const keys = (item: PullRequestInventoryItem) =>
    pullRequestInspectorActions(item, handlers).map((a) => a.key);
  const action = (item: PullRequestInventoryItem, key: string) =>
    pullRequestInspectorActions(item, handlers).find((a) => a.key === key);

  it("leads with the session, then the checkout acts, the merge, the link out", () => {
    expect(keys(base)).toEqual([
      "start-session",
      "review",
      "checkout",
      "merge",
      "open-external",
    ]);
  });

  // The session is the reason to create the worktree, so it is listed disabled
  // with that reason rather than hidden; it is the primary once it can run.
  it("enables the session only once a worktree holds the head branch", () => {
    const without = action(base, "start-session");
    expect(without?.primary).toBe(true);
    expect(without?.disabled).toBe(true);
    expect(without?.disabledReason).toBe(
      "Create a worktree for this pull request first.",
    );
    const withWorktree = action(
      { ...base, worktreeId: "wt1" },
      "start-session",
    );
    expect(withWorktree?.disabled).toBeUndefined();
  });

  it("names the checkout act by what it will do", () => {
    expect(action(base, "checkout")?.label).toBe("Create worktree");
    expect(action({ ...base, worktreeId: "wt1" }, "checkout")?.label).toBe(
      "Update worktree",
    );
  });

  // A terminal pull request's head branch is normally gone, so neither a
  // review nor a checkout is an offer; a checkout it still has is cleaned up,
  // and with none left there is nothing local to do but open it.
  it("offers a terminal pull request only its cleanup and the link out", () => {
    expect(keys({ ...base, state: "merged", worktreeId: "wt1" })).toEqual([
      "start-session",
      "merge",
      "open-external",
    ]);
    expect(
      action({ ...base, state: "merged", worktreeId: "wt1" }, "merge")?.label,
    ).toBe("Clean up…");
    expect(keys({ ...base, state: "closed" })).toEqual([
      "start-session",
      "open-external",
    ]);
  });

  it("disables a blocked merge with its reason, except while asking what happened", () => {
    const draft = { ...base, draft: true };
    expect(action(draft, "merge")?.disabled).toBe(true);
    expect(action(draft, "merge")?.disabledReason).toContain("is a draft");
    const suspended = pullRequestInspectorActions(draft, {
      ...handlers,
      mergeSuspended: true,
    }).find((a) => a.key === "merge");
    expect(suspended?.label).toBe("Check again");
    expect(suspended?.disabled).toBeUndefined();
  });

  it("names the provider on the link out", () => {
    expect(action(base, "open-external")?.label).toBe("Open on GitHub");
    expect(
      action({ ...base, provider: "forgejo" }, "open-external")?.label,
    ).toBe("Open on Forgejo");
  });
});

describe("pullRequestRelationGroups", () => {
  const item: PullRequestInventoryItem = {
    projectId: "p1",
    provider: "github",
    repositoryKey: "acme/app",
    repoWebUrl: "https://github.com/acme/app",
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    title: "Feature",
    headBranch: "feature",
    baseBranch: "main",
    mine: true,
    reviewRequested: false,
    state: "open",
    worktreeId: "wt1",
    sessionIds: ["s1", "s-missing"],
    taskIds: ["t1"],
  };
  const worktree: WorktreeRecord = {
    id: "wt1",
    projectId: "p1",
    mainRepoRoot: "/repo",
    path: "/repo-wt",
    branch: "feature",
    baseBranch: "main",
    baseCommit: "abc",
    status: "active",
    sessionIds: [],
    taskIds: [],
    createdAt: 0,
    updatedAt: 0,
  };

  // The page states the four answers a join can have; the panel lists only
  // what resolves and never claims an id is absent.
  it("lists the resolved joins and nothing for the unresolved", () => {
    const groups = pullRequestRelationGroups(item, [project], {
      worktrees: { rows: [worktree], fresh: true },
      sessions: {
        rows: [session({ id: "s1", title: "Review" })],
        fresh: false,
      },
      tasks: { rows: null, fresh: false },
    });
    expect(groups.map((g) => [g.id, g.refs.map((r) => r.id)])).toEqual([
      ["project", ["p1"]],
      ["worktree", ["wt1"]],
      ["sessions", ["s1"]],
      ["tasks", []],
    ]);
  });
});

describe("knowledgeRelationGroups", () => {
  it("groups resolved pa links and skips the entry's self link", () => {
    const entry: KnowledgeEntryInspect = {
      kind: "entry",
      id: "kb-self",
      path: "self/index.md",
      folder: "self",
      slug: "self",
      uri: "pa://knowledge/kb-self",
      title: "Self",
      type: "note",
      status: "active",
      summary: null,
      tags: [],
      aliases: [],
      links: [],
      sourceRefs: [],
      assets: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      frontmatter: {
        schema: 1,
        id: "kb-self",
        type: "note",
        title: "Self",
        status: "active",
        summary: null,
        tags: [],
        aliases: [],
        links: [],
        sourceRefs: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      paObjectReferences: [
        {
          uri: "pa://task/266",
          objectType: "task",
          knownType: true,
          id: "266",
          href: "/tasks/266",
          title: "KB 11",
          typeLabel: "Task",
          existence: "exists",
        },
        {
          uri: "pa://project/time-tracking-automation",
          objectType: "project",
          knownType: true,
          id: "time-tracking-automation",
          href: "/projects/time-tracking-automation",
          title: "PA · Pandeck",
          typeLabel: "Project",
          existence: "exists",
        },
        {
          uri: "pa://knowledge/kb-self",
          objectType: "knowledge",
          knownType: true,
          id: "kb-self",
          href: "/knowledge/kb-self",
          title: "Self",
          typeLabel: "Knowledge",
          existence: "exists",
        },
        {
          uri: "pa://task/missing",
          objectType: "task",
          knownType: true,
          id: "missing",
          href: "/tasks/missing",
          title: "Task missing",
          typeLabel: "Task",
          existence: "missing",
        },
      ],
      history: [],
      latestDiff: null,
    };
    const groups = knowledgeRelationGroups(entry);
    expect(groups.find((g) => g.label === "Tasks")?.refs).toEqual([
      { kind: "task", id: "266", title: "KB 11", subtitle: "Task" },
    ]);
    expect(groups.find((g) => g.label === "Projects")?.refs).toEqual([
      {
        kind: "project",
        id: "time-tracking-automation",
        title: "PA · Pandeck",
        subtitle: "Project",
      },
    ]);
    expect(groups.find((g) => g.label === "Knowledge")?.refs).toEqual([]);
  });
});

describe("projectRelationGroups", () => {
  it("resolves hierarchy and sessions via task refs (tasks render as the embedded tree)", () => {
    const sub: ProjectRecord = {
      id: "p2",
      name: "Sub",
      key: "SB",
      parentId: "p1",
    };
    const withParent: ProjectRecord = { ...project, parentId: "p0" };
    const tasks = [
      task({
        id: "t1",
        title: "In project",
        projectId: "p1",
        sessionRefs: [{ sessionId: "s1" }],
      }),
      task({ id: "t2", title: "Elsewhere", projectId: "px" }),
    ];
    const groups = projectRelationGroups(
      withParent,
      [parentProject, withParent, sub],
      tasks,
      [session({ id: "s1", title: "Chat" })],
    );
    expect(groups.find((g) => g.label === "Related projects")?.refs).toEqual([
      {
        kind: "project",
        id: "p0",
        title: "RT · Root",
        subtitle: "Parent project",
      },
      { kind: "project", id: "p2", title: "SB · Sub", subtitle: "Subproject" },
    ]);
    expect(groups.find((g) => g.label === "Tasks")).toBeUndefined();
    expect(groups.find((g) => g.label === "Sessions")?.refs).toEqual([
      {
        kind: "session",
        id: "s1",
        title: "Chat",
        subtitle: "Via task: In project",
      },
    ]);
  });
});
