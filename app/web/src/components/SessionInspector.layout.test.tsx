// @vitest-environment jsdom
/**
 * What the session Details panel puts where: where it runs and the runtime
 * facts it is asked for most (account/model/thinking) in one Details section,
 * and a Tasks group that cannot grow past its first page.
 *   pnpm --filter @assistant/web test src/components/SessionInspector.layout.test.tsx
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type {
  SessionListItem,
  TaskSummary,
  WorktreeRecord,
} from "@assistant/shared";
import {
  SessionInspector,
  sessionInspectorActions,
} from "./objectInspectors.tsx";

const openers = {
  onOpenTask: () => {},
  onOpenProject: () => {},
  onOpenSession: () => {},
  onOpenWorktree: () => {},
  onOpenKnowledge: () => {},
};

const task = (n: number): TaskSummary => ({
  id: `t${n}`,
  title: `Task number ${n}`,
  status: "todo",
  source: { createdBy: "user" },
  createdAt: n,
  updatedAt: n,
  sortOrder: n,
});

const render = (over: Parameters<typeof SessionInspector>[0]) =>
  renderToStaticMarkup(<SessionInspector {...over} />);

const base = {
  sessionId: "s1",
  title: "A session",
  relatedTasks: [],
  sessions: [],
  projects: [],
  openers,
};

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { host: HTMLElement; root: Root } | undefined;

afterEach(() => {
  if (!mounted) return;
  const { host, root } = mounted;
  mounted = undefined;
  act(() => root.unmount());
  host.remove();
});

describe("SessionInspector layout", () => {
  it("shows the cap and lets the user set or reset it", async () => {
    const asked: Array<[string, number | null]> = [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    const props = {
      ...base,
      sessions: [
        { id: "s1", title: "Session", peerTurnCap: 6 } as SessionListItem,
      ],
      onSetPeerTurnCap: (id: string, cap: number | null) => {
        asked.push([id, cap]);
      },
    };
    await act(async () => root.render(<SessionInspector {...props} />));
    const trigger = () =>
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Peer turns at once"]',
      )!;
    expect(trigger().textContent).toContain("6");
    await act(async () => trigger().click());
    const option = (label: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (item) => item.textContent === label,
      )!;
    await act(async () => option("8").click());
    expect(asked).toEqual([["s1", 8]]);
    await act(async () => trigger().click());
    await act(async () => option("Default (4)").click());
    expect(asked).toEqual([
      ["s1", 8],
      ["s1", null],
    ]);
  });
  it("lists no actions: the session header's menu holds them", () => {
    const html = render({ ...base, relatedTasks: [task(1)] });
    expect(html).toContain("Tasks");
    expect(html).not.toContain("Actions");
  });

  it("leads the actions with Settle, then Review, under bare verb labels", () => {
    const labels = sessionInspectorActions({
      sessionId: "s1",
      sessions: [],
      onSettle: () => {},
      onReviewWork: () => {},
      onArchive: () => {},
      onDelete: () => {},
    }).map((action) => action.label);
    expect(labels).toEqual(["Settle", "Review", "Archive", "Delete"]);
  });

  it("offers to bring a settled session back instead of settling it", () => {
    const labels = sessionInspectorActions({
      sessionId: "s1",
      sessions: [],
      onSettle: () => {},
      settled: true,
    }).map((action) => action.label);
    expect(labels).toEqual(["Bring back"]);
  });

  it("states where it runs, the account, model and thinking level in one Details section", () => {
    const html = render({
      ...base,
      credentialProfile: { name: "Work", provider: "claude" },
      model: { id: "claude-opus-5", name: "Opus 5", provider: "claude-sdk" },
      thinkingLevel: "high",
    });
    expect(html).toContain(">Details<");
    expect(html).not.toContain("Profile");
    // One labelled row per fact; the account is its NAME only, without the
    // provider.
    const doc = new DOMParser().parseFromString(html, "text/html");
    const fact = (label: string) =>
      [...doc.querySelectorAll("span")].find(
        (span) => span.textContent === label,
      )?.nextElementSibling?.textContent;
    expect(fact("Project")).toBe("None");
    expect(fact("Worktree")).toBe("None");
    expect(fact("Account")).toBe("Work");
    expect(fact("Model")).toBe("Opus 5");
    expect(fact("Thinking")).toBe("High");
    expect(html).not.toContain("Work · Claude");
    expect(html).not.toContain("Bound when this session started");
  });

  it("shows five tasks and defers the rest to a Show more", () => {
    const html = render({
      ...base,
      relatedTasks: [1, 2, 3, 4, 5, 6, 7].map(task),
    });
    expect(html).toContain("Task number 5");
    expect(html).not.toContain("Task number 6");
    expect(html).toContain("Show 2 more");
  });

  it("opens durable spawn relations in both directions", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };
    const opened: string[] = [];
    const sessions = [
      {
        id: "coordinator",
        harness: "pi" as const,
        agentType: "assistant" as const,
        title: "Coordinator",
        createdAt: 1,
        updatedAt: 1,
        messageCount: 1,
      },
      {
        id: "child",
        harness: "pi" as const,
        agentType: "assistant" as const,
        title: "Implementer",
        createdAt: 2,
        updatedAt: 2,
        messageCount: 1,
        spawnedBySessionId: "coordinator",
        spawnOwnership: "taken-over" as const,
      },
    ];
    const props = {
      ...base,
      sessions,
      openers: { ...openers, onOpenSession: (id: string) => opened.push(id) },
    };

    const open = (title: string) =>
      host.querySelector<HTMLButtonElement>(
        `button[aria-label="Open ${title}"]`,
      );

    act(() => root.render(<SessionInspector {...props} sessionId="child" />));
    expect(open("Coordinator")).not.toBeNull();
    act(() => open("Coordinator")!.click());

    act(() =>
      root.render(<SessionInspector {...props} sessionId="coordinator" />),
    );
    const row = host.querySelector<HTMLElement>('[data-list-row-id="child"]');
    expect(row?.textContent).toContain("Implementer");
    // The coordinator's row states that the user owns this child now, in the
    // details the row unfolds, without changing what it opens.
    expect(row?.textContent).not.toContain("Taken over");
    act(() =>
      row!
        .querySelector<HTMLButtonElement>('button[title="Show details"]')!
        .click(),
    );
    expect(row?.textContent).toContain("Taken over");
    act(() => open("Implementer")!.click());
    expect(opened).toEqual(["coordinator", "child"]);
  });

  it("re-bounds the tasks of the NEXT session opened after a Show more", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { host, root };

    const panel = (sessionId: string, titlePrefix: string) => (
      <SessionInspector
        {...base}
        sessionId={sessionId}
        relatedTasks={[1, 2, 3, 4, 5, 6, 7].map((n) => ({
          ...task(n),
          title: `${titlePrefix} ${n}`,
        }))}
      />
    );

    act(() => root.render(panel("s1", "First")));
    const showMore = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Show 2 more"),
    );
    expect(showMore).toBeDefined();
    act(() => showMore!.click());
    expect(host.textContent).toContain("First 7");

    // A different session is a different object: it opens bounded, not at
    // whatever depth the previous one was unfolded to.
    act(() => root.render(panel("s2", "Second")));
    expect(host.textContent).toContain("Second 5");
    expect(host.textContent).not.toContain("Second 6");
    expect(host.textContent).toContain("Show 2 more");
  });

  // The ownership action lives in the session's actions (the header's ⋯).
  const peer = (
    id: string,
    title: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    harness: "pi" as const,
    agentType: "assistant" as const,
    title,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    ...extra,
  });

  it("offers Take over on a coordinator-run peer and Hand back once taken", () => {
    const asked: string[] = [];
    const actionsFor = (ownership: "coordinator" | "taken-over") =>
      sessionInspectorActions({
        sessionId: "child",
        sessions: [
          peer("coordinator", "Coordinator"),
          peer("child", "Implementer", {
            spawnedBySessionId: "coordinator",
            spawnOwnership: ownership,
          }),
        ],
        onSetSpawnOwnership: (value) => asked.push(value),
      });
    const find = (
      actions: ReturnType<typeof sessionInspectorActions>,
      label: string,
    ) => actions.find((action) => action.label.startsWith(label));

    // A poke never moves ownership, so taking over is offered explicitly.
    const coordinatorRun = actionsFor("coordinator");
    expect(find(coordinatorRun, "Hand back")).toBeUndefined();
    find(coordinatorRun, "Take over")!.onRun();

    // Once taken, the action hands it back and names who gets it.
    const takenOver = actionsFor("taken-over");
    expect(find(takenOver, "Take over")).toBeUndefined();
    expect(find(takenOver, "Hand back")!.label).toContain("Coordinator");
    find(takenOver, "Hand back")!.onRun();
    expect(asked).toEqual(["taken-over", "coordinator"]);
  });

  it("offers no Hand back when the coordinator is gone from the list", () => {
    const labels = sessionInspectorActions({
      sessionId: "child",
      sessions: [
        peer("child", "Implementer", {
          spawnedBySessionId: "deleted-coordinator",
          spawnOwnership: "taken-over",
        }),
      ],
      onSetSpawnOwnership: () => {},
    }).map((action) => action.label);
    expect(labels.join(" ")).not.toContain("Hand back");
    expect(labels.join(" ")).not.toContain("Take over");
  });

  it("offers no ownership action on a session nothing spawned", () => {
    const labels = sessionInspectorActions({
      sessionId: "s1",
      sessions: [peer("s1", "Alone")],
      onSetSpawnOwnership: () => {},
    }).map((action) => action.label);
    expect(labels).toEqual([]);
  });
});

describe("SessionInspector spawn-tree worktrees", () => {
  const peer: SessionListItem = {
    id: "peer",
    title: "Peer",
    harness: "pi",
    agentType: "developer",
    createdAt: 0,
    updatedAt: 0,
    messageCount: 1,
    spawnedBySessionId: "s1",
    spawnOwnership: "coordinator",
  };
  const handed: WorktreeRecord = {
    id: "wt-handed",
    projectId: "p1",
    mainRepoRoot: "/repo",
    path: "/repo-handed",
    branch: "handed-branch",
    baseBranch: "main",
    baseCommit: "abc",
    status: "active",
    sessionIds: ["peer"],
    taskIds: [],
    treeSessionIds: ["peer", "s1"],
    createdAt: 0,
    updatedAt: 0,
  };

  it("reserves the group while the list is unanswered, for a session with a peer", () => {
    const html = render({ ...base, sessions: [peer], worktrees: null });
    expect(html).toContain("Worktrees from this session");
    expect(html).toContain('aria-label="Loading worktrees"');
    // Without evidence of a tree, nothing is reserved.
    expect(render({ ...base, worktrees: null })).not.toContain(
      "Worktrees from this session",
    );
  });

  it("states a failed first read with its retry instead of a skeleton", () => {
    const html = render({
      ...base,
      sessions: [peer],
      worktrees: null,
      worktreesError: "socket closed",
      onReloadWorktrees: () => {},
    });
    expect(html).toContain("socket closed");
    expect(html).not.toContain('aria-label="Loading worktrees"');
  });

  it("marks a refresh over retained rows", () => {
    const html = render({
      ...base,
      sessions: [peer],
      worktrees: [handed],
      worktreesFresh: false,
    });
    expect(html).toContain("handed-branch");
    expect(html).toContain("Refreshing worktrees");
    expect(
      render({
        ...base,
        sessions: [peer],
        worktrees: [handed],
        worktreesFresh: true,
      }),
    ).not.toContain("Refreshing worktrees");
  });

  it("keeps retained rows and states a failed refresh beside them", () => {
    const html = render({
      ...base,
      sessions: [peer],
      worktrees: [handed],
      worktreesError: "socket closed",
      onReloadWorktrees: () => {},
    });
    expect(html).toContain("handed-branch");
    expect(html).toContain("socket closed");
  });
});
