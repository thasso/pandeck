import { describe, expect, it } from "vitest";
import type { ClientTimelineEntry } from "@assistant/shared/runtime";
import type {
  ProjectSummary,
  PullRequestCard,
  ServerMessage,
  SessionListItem,
  TaskListResponse,
  WorkflowRunCard,
  WorkflowRunSummary,
  WorktreeGitStatus,
  WorktreeHostingStatusResponse,
} from "@assistant/shared";
import {
  createInitialState,
  reduceAssistantState,
  type UIState,
} from "./hooks/useAssistant.ts";
import {
  paObjectReferenceKey,
  sessionReferenceKey,
} from "./lib/transcriptKeys.ts";
import { dataOf } from "./lib/loadState.ts";
import { backlogSessionsKey, sameSessionRowProps } from "./lib/sessionRows.ts";
import {
  buildSessionInbox,
  inboxItemId,
  sessionCardKey,
  workflowRunItemKey,
  type SessionInboxCard,
} from "./lib/sessionInbox.ts";
import { transcriptWindowStart } from "./lib/transcriptWindow.ts";
import type { Task } from "./lib/backlogTree.ts";
import {
  buildTaskRowMeta,
  type TaskRowMetaContext,
} from "./lib/taskRowMeta.ts";
import {
  worktreeHostingKey,
  worktreeHostingMap,
} from "./lib/worktreeHosting.ts";
import { dirtyWorktreeIds, dirtyWorktreeKey } from "./lib/worktreeDirty.ts";
import { taskWorktreeIds } from "./lib/taskActivity.ts";
import { createIdleWriter, type IdleWriterEnv } from "./lib/idleWriter.ts";
import { createWorktreeWatchRegistry } from "./lib/worktreeWatchRegistry.ts";
import { sameProjectDetailPageProps } from "./components/ProjectDetailPage.tsx";
import { sidebarWorktreeWatchIds } from "./components/Sidebar.tsx";
import {
  chatToolCommentTargets,
  reuseStableChatToolTargets,
} from "./components/MessageList.tsx";

/**
 * The repeatable load scenario: ten parallel streaming sessions and a
 * 2000-entry transcript, driven through the REAL reducer and the real identity
 * keys.
 *
 * Everything asserted here is a COUNT, not a duration — how many transcript
 * rows are replaced per streamed token, how many sidebar rows a session
 * broadcast invalidates, how many rows a long transcript mounts, how many cache
 * writes a burst produces. Those are the quantities every fix in this area
 * moved, they are identical on a fast laptop and a throttled phone, and unlike
 * wall-clock budgets they do not go flaky on a loaded CI runner. A regression
 * here means work came back, not that the machine was busy.
 */

const SESSION_COUNT = 10;
/** Backlog size of the production payload audit that motivated the event model. */
const BACKLOG_TASKS = 140;
const TIMELINE_ENTRIES = 2000;

function timeline(count: number): ClientTimelineEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `e${i}`,
    seq: i + 1,
    createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    type: "message",
    role: i % 2 === 0 ? "user" : "assistant",
    ...(i % 2 === 0 ? { origin: { kind: "human" } } : {}),
    content: [
      {
        type: "text",
        text: `entry ${i} body with a little **markdown** and a \`code\` span`,
      },
    ],
  })) as unknown as ClientTimelineEntry[];
}

function sessionRows(count: number, streaming: boolean): SessionListItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    harness: "pi",
    agentType: "assistant",
    title: `Session ${i}`,
    updatedAt: 1_700_000_000_000 + i,
    messageCount: 10,
    isStreaming: streaming,
  })) as unknown as SessionListItem[];
}

function apply(state: UIState, msg: ServerMessage): UIState {
  return reduceAssistantState(state, { kind: "server", msg });
}

function loadedState(): UIState {
  let state = createInitialState();
  state = apply(state, {
    type: "snapshot",
    state: {
      sessionId: "s0",
      harness: "pi",
      agentType: "assistant",
      thinkingLevel: "off",
    },
    contextInfo: null,
    snapshot: {
      sessionId: "s0",
      runState: "running",
      timeline: timeline(TIMELINE_ENTRIES),
      streaming: [],
    },
  } as unknown as ServerMessage);
  return apply(state, {
    type: "sessions",
    sessions: sessionRows(SESSION_COUNT, true),
  });
}

const NOW = 1_800_000_000_000;

describe("UI load scenario: 10 streaming sessions, 2000-entry transcript", () => {
  it("leases zero collapsed Project worktrees and only the one rendered row", () => {
    expect(sidebarWorktreeWatchIds("projects", [], ["visible"])).toEqual([
      "visible",
    ]);
    expect(sidebarWorktreeWatchIds("projects", [], [])).toHaveLength(0);
  });

  it("keeps Sessions reconnect watches bounded by the working set", () => {
    const working = sessionRows(20, false).map((session, index) => ({
      ...session,
      worktreeId: `current-${index % 4}`,
    }));
    const settledHistory = sessionRows(576, false).map((session, index) => ({
      ...session,
      id: `settled-${index}`,
      worktreeId: `historical-${index}`,
      settledAt: NOW - index,
    }));
    // A settled session running its next turn stays on the shelf (Task-674):
    // starting work is not attention, so it adds no watch either.
    const settledAndRunning = {
      ...sessionRows(1, true)[0]!,
      id: "settled-running",
      worktreeId: "settled-running",
      settledAt: NOW,
    };
    // One whose run produced an unacknowledged OUTCOME is a working-set card
    // again — the server withholds `settledAt` for it — so its dirty status
    // must stay live.
    const woken = {
      ...sessionRows(1, false)[0]!,
      id: "woken",
      worktreeId: "woken",
      outcomeAttention: {
        revision: 1,
        settledRevision: 0,
        kind: "completed" as const,
        at: NOW,
      },
    };

    const watchIds = sidebarWorktreeWatchIds(
      "sessions",
      [...working, ...settledHistory, settledAndRunning, woken],
      [],
    );
    expect(watchIds).toEqual([
      "current-0",
      "current-1",
      "current-2",
      "current-3",
      "woken",
    ]);

    const sent: string[] = [];
    const transport = {
      watchWorktree: (id: string) => void sent.push(id),
      unwatchWorktree: () => {},
    };
    const registry = createWorktreeWatchRegistry();
    registry.lease().set(watchIds);
    registry.setConnection(true, transport);
    registry.setConnection(false, transport);
    registry.setConnection(true, transport);
    expect(sent).toEqual([...watchIds, ...watchIds]);
  });

  it("causes zero selected-Project renders for an unrelated Project event", () => {
    const selected: ProjectSummary = { id: "a", name: "Alpha", key: "AA" };
    const unrelated: ProjectSummary = { id: "b", name: "Beta", key: "BB" };
    const noop = () => {};
    const base = {
      projects: [selected, unrelated],
      loaded: true,
      selectedId: "a",
      onBackToList: noop,
      onSave: noop,
      onCloneRepo: noop,
      onRemoveClone: noop,
    };
    const next = {
      ...base,
      projects: [{ ...unrelated, name: "Beta changed" }, selected],
    };
    const replacedSelectedDocuments = sameProjectDetailPageProps(base, next)
      ? 0
      : 1;
    expect(replacedSelectedDocuments).toBe(0);
  });
  it("changes zero Task row identities when the server echoes an optimistic apply", () => {
    const taskList: TaskListResponse = {
      request: {},
      items: [
        {
          id: "task-1",
          title: "Before",
          status: "todo",
          source: { createdBy: "user" },
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "task-2",
          title: "Unrelated",
          status: "todo",
          source: { createdBy: "user" },
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      updatedAt: NOW,
    };
    const state: UIState = { ...createInitialState(), taskList };
    const optimistic = reduceAssistantState(state, {
      kind: "optimisticTaskSave",
      request: { id: "task-1", title: "After", status: "todo" },
      tempId: "",
      now: NOW + 1,
    });
    const optimisticRows = optimistic.taskList!.items;
    const echo = apply(optimistic, {
      type: "stateEvents",
      topic: "tasks",
      seq: 1,
      events: [
        {
          kind: "upsert",
          id: "task-1",
          revision: 1,
          item: { ...optimisticRows[0]! },
        },
      ],
    });

    const before = new Set(optimisticRows);
    const changedRows = echo.taskList!.items.filter(
      (task) => !before.has(task),
    ).length;
    expect(changedRows).toBe(0);
    expect(echo.taskList).toBe(optimistic.taskList);
    expect(echo.stateEventRevisions.tasks?.["task-1"]).toBe(1);
    expect(echo.taskList!.items[0]).not.toHaveProperty("revision");
  });

  it("keeps every Task row identity when a PR-card status write echoes", () => {
    const task = {
      id: "task-625",
      title: "Optimistic PR card action",
      status: "todo" as const,
      source: { createdBy: "user" as const },
      createdAt: NOW,
      updatedAt: NOW,
    };
    const card: PullRequestCard = {
      renderKind: "pullRequest",
      id: "pr-625",
      sessionId: "session-1",
      status: "merged",
      createdAt: NOW,
      updatedAt: NOW,
      title: "Optimistic PR card action",
      headBranch: "feature",
      baseBranch: "main",
      warnings: [],
      linkedTask: task,
    };
    const state: UIState = {
      ...createInitialState(),
      taskList: { request: {}, items: [task], updatedAt: NOW },
      pullRequestCards: [
        {
          id: `pull-request-card-${card.id}`,
          role: "assistant",
          blocks: [{ kind: "pullRequest", pullRequest: card }],
        },
      ],
    };
    const pending = reduceAssistantState(state, {
      kind: "optimisticPullRequestCardAction",
      cardId: card.id,
      action: "mark-task-done",
    });
    const optimistic = reduceAssistantState(pending, {
      kind: "optimisticTaskSave",
      request: { id: task.id, status: "done" },
      tempId: "",
      now: NOW + 1,
    });
    expect(optimistic.taskList!.items[0]!.status).toBe("done");
    expect(
      optimistic.pullRequestCards[0]?.blocks.find(
        (block) => block.kind === "pullRequest",
      ),
    ).toMatchObject({
      pullRequest: { optimisticLinkedTask: { status: "done" } },
    });

    const optimisticRows = optimistic.taskList!.items;
    const echo = apply(optimistic, {
      type: "stateEvents",
      topic: "tasks",
      seq: 1,
      events: [
        {
          kind: "upsert",
          id: task.id,
          revision: 1,
          item: { ...optimisticRows[0]! },
        },
      ],
    });
    const before = new Set(optimisticRows);
    expect(
      echo.taskList!.items.filter((item) => !before.has(item)).length,
    ).toBe(0);
    expect(echo.taskList).toBe(optimistic.taskList);
  });

  it("keeps every untouched Task row across a real mutation's echo", () => {
    // The Backlog the payload audit was taken on: one broadcast used to replace
    // all of these rows, whatever had actually changed.
    const items = Array.from({ length: BACKLOG_TASKS }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      status: "todo" as const,
      source: { createdBy: "user" as const },
      createdAt: NOW,
      updatedAt: NOW,
    }));
    const state: UIState = {
      ...createInitialState(),
      taskList: { request: {}, items, updatedAt: NOW },
    };

    // A status toggle, through the same action the Backlog dispatches.
    const toggled = reduceAssistantState(state, {
      kind: "optimisticTaskSave",
      request: { id: "task-7", status: "done" },
      tempId: "",
      now: NOW + 1,
    });
    expect(toggled.taskList!.items[7]!.status).toBe("done");
    const optimisticRows = toggled.taskList!.items;
    // `updatedAt` is the one field the browser cannot predict — the server
    // stamps it when the write lands — so the echo carries the server's.
    const echoed = { ...optimisticRows[7]!, updatedAt: NOW + 40 };
    const echo = apply(toggled, {
      type: "stateEvents",
      topic: "tasks",
      seq: 1,
      events: [{ kind: "upsert", id: "task-7", revision: 1, item: echoed }],
    });
    const held = new Set(optimisticRows);
    expect(
      echo.taskList!.items.filter((task) => !held.has(task)).length,
    ).toBeLessThanOrEqual(1);

    // A delete: one row leaves, the rest are the same objects.
    const removed = apply(echo, {
      type: "stateEvents",
      topic: "tasks",
      seq: 2,
      events: [{ kind: "delete", id: "task-3", revision: 2 }],
    });
    const survivors = new Set(echo.taskList!.items);
    expect(removed.taskList!.items.length).toBe(BACKLOG_TASKS - 1);
    expect(
      removed.taskList!.items.filter((task) => !survivors.has(task)).length,
    ).toBe(0);

    // A drag: only the placements move, and their echo settles them exactly.
    const dragged = reduceAssistantState(removed, {
      kind: "optimisticTaskReorder",
      placements: [
        { id: "task-1", parentId: null },
        { id: "task-2", parentId: "task-1" },
      ],
    });
    const draggedRows = dragged.taskList!.items;
    const movedIds = new Set(["task-1", "task-2"]);
    expect(
      draggedRows.filter(
        (task) => !movedIds.has(task.id) && !survivors.has(task),
      ).length,
    ).toBe(0);
    const reorderEcho = apply(dragged, {
      type: "stateEvents",
      topic: "tasks",
      seq: 3,
      events: draggedRows
        .filter((task) => movedIds.has(task.id))
        .map((task, index) => ({
          kind: "upsert" as const,
          id: task.id,
          revision: 3 + index,
          item: { ...task },
        })),
    });
    const beforeEcho = new Set(draggedRows);
    expect(
      reorderEcho.taskList!.items.filter((task) => !beforeEcho.has(task))
        .length,
    ).toBe(0);
    expect(reorderEcho.taskList).toBe(dragged.taskList);
  });

  it("settles an optimistic create against the mutator's reply", () => {
    const state: UIState = {
      ...createInitialState(),
      taskList: { request: {}, items: [], updatedAt: NOW },
    };
    const optimistic = reduceAssistantState(state, {
      kind: "optimisticTaskSave",
      request: { title: "Typed here", status: "todo" },
      tempId: "optimistic-1",
      now: NOW,
    });
    expect(optimistic.taskList!.items.map((task) => task.id)).toEqual([
      "optimistic-1",
    ]);

    const item = {
      id: "412",
      title: "Typed here",
      status: "todo" as const,
      description: "",
      descriptionPreview: "",
      jiraIssueKeys: [],
      externalLinks: [],
      sessionRefs: [],
      priority: "normal" as const,
      source: { createdBy: "user" as const },
      createdAt: NOW,
      updatedAt: NOW,
      triagedAt: NOW,
    };
    const settled = reduceAssistantState(optimistic, {
      kind: "taskSaved",
      item,
      tempId: "optimistic-1",
    });
    // The temp row is GONE — an upsert event alone could never remove it, since
    // the server has never heard of that id — and the body is adopted.
    expect(settled.taskList!.items.map((task) => task.id)).toEqual(["412"]);
    expect(dataOf(settled.taskDetails["412"]!)).toBe(item);
    expect(settled.taskList!.items[0]).not.toHaveProperty("description");

    // The authoritative echo of the settled row changes nothing.
    const echo = apply(settled, {
      type: "stateEvents",
      topic: "tasks",
      seq: 1,
      events: [
        {
          kind: "upsert",
          id: "412",
          revision: 1,
          item: { ...settled.taskList!.items[0]! },
        },
      ],
    });
    expect(echo.taskList).toBe(settled.taskList);
  });

  it("replaces at most the streaming row per token", () => {
    const state = loadedState();
    expect(state.messages.length).toBeGreaterThan(900);

    const next = apply(state, {
      type: "event",
      sessionId: "s0",
      event: { type: "messageStarted", streamId: "live-1" },
    });
    const streamed = apply(next, {
      type: "event",
      sessionId: "s0",
      event: {
        type: "messageDelta",
        streamId: "live-1",
        delta: { kind: "text", text: "token " },
      },
    });

    const before = new Set(state.messages);
    const replaced = streamed.messages.filter(
      (message) => !before.has(message),
    ).length;
    // Only the live row is new; every durable row keeps its identity, which is
    // what lets the memoized transcript rows hold DURING a turn.
    expect(replaced).toBeLessThanOrEqual(2);
  });

  it("keeps transcript comment target props stable when an unrelated entry arrives", () => {
    const withTool = [
      {
        id: "assistant-tool",
        seq: 1,
        createdAt: "2026-08-20T14:31:00.000Z",
        type: "message",
        role: "assistant",
        content: [
          { type: "toolCall", toolCallId: "tc1", name: "read", input: {} },
        ],
      },
      {
        id: "tool-result",
        seq: 2,
        createdAt: "2026-08-20T14:32:00.000Z",
        type: "message",
        role: "toolResult",
        toolCallId: "tc1",
        content: [{ type: "text", text: "body" }],
      },
    ] as ClientTimelineEntry[];
    const before = chatToolCommentTargets(withTool);
    const after = reuseStableChatToolTargets(
      chatToolCommentTargets([
        ...withTool,
        {
          id: "later-user",
          seq: 3,
          createdAt: "2026-08-20T14:33:00.000Z",
          type: "message",
          role: "user",
          origin: { kind: "human" },
          content: [{ type: "text", text: "next" }],
        } as ClientTimelineEntry,
      ]),
      before,
    );

    // The old tool row receives the narrow per-message map, not the whole
    // timeline projection, and therefore keeps the exact same prop object.
    expect(after.targetsByMessage.get("assistant-tool")).toBe(
      before.targetsByMessage.get("assistant-tool"),
    );
  });

  it("keeps the transcript's derived props stable across a session broadcast", () => {
    const state = loadedState();
    // A rebroadcast while ten agents stream: brand-new row objects, same content.
    const next = apply(state, {
      type: "sessions",
      sessions: sessionRows(SESSION_COUNT, true),
    });

    expect(next.sessions).not.toBe(state.sessions);
    expect(backlogSessionsKey(next.sessions)).toBe(
      backlogSessionsKey(state.sessions),
    );
    // The gate absorbs that churn, but it may not hide a session LEAVING or
    // being put away: a Backlog row offers to open the session its work started
    // in, and a stale copy is a row action pointing at a route that is gone.
    const rows = sessionRows(SESSION_COUNT, true);
    const idle = rows.map((row, i) =>
      i === 3 ? { ...row, isStreaming: false } : row,
    );
    const quiet = apply(state, { type: "sessions", sessions: idle });
    expect(
      backlogSessionsKey(
        apply(quiet, { type: "sessions", sessions: idle.slice(1) }).sessions,
      ),
    ).not.toBe(backlogSessionsKey(quiet.sessions));
    expect(
      backlogSessionsKey(
        apply(quiet, {
          type: "sessions",
          sessions: idle.map((row, i) =>
            i === 3 ? { ...row, archived: true } : row,
          ),
        }).sessions,
      ),
    ).not.toBe(backlogSessionsKey(quiet.sessions));
    const references = (sessions: SessionListItem[]) =>
      sessions.map((session) => ({
        uri: `pa://session/${session.id}`,
        objectType: "session",
        knownType: true,
        typeLabel: "Session",
        id: session.id,
        existence: "exists",
        title: session.title,
        href: `/sessions/${session.id}`,
      })) as unknown as Parameters<typeof paObjectReferenceKey>[0];
    expect(paObjectReferenceKey(references(next.sessions))).toBe(
      paObjectReferenceKey(references(state.sessions)),
    );
  });

  it("absorbs the re-SORT a broadcast performs, not just its new row objects", () => {
    const state = loadedState();
    // The reducer sorts by `updatedAt`, so a turn finishing anywhere moves a row
    // to the front — several times a second while anything runs. The Backlog
    // reads these as a `sessionById` lookup and the transcript as a link lookup,
    // so a re-sort is not a content change for either, and treating it as one
    // re-rendered every Task row and every message.
    const bumped = sessionRows(SESSION_COUNT, true).map((row, i) =>
      i === 3 ? { ...row, updatedAt: row.updatedAt + 10_000 } : row,
    );
    const next = apply(state, { type: "sessions", sessions: bumped });

    expect(next.sessions.map((session) => session.id)).not.toEqual(
      state.sessions.map((session) => session.id),
    );
    expect(backlogSessionsKey(next.sessions)).toBe(
      backlogSessionsKey(state.sessions),
    );
    expect(sessionReferenceKey(next.sessions)).toBe(
      sessionReferenceKey(state.sessions),
    );
  });

  it("re-renders one sidebar row when one session changes", () => {
    const state = loadedState();
    const moved = sessionRows(SESSION_COUNT, true);
    moved[3] = { ...moved[3]!, title: "Renamed while streaming" };
    const next = apply(state, { type: "sessions", sessions: moved });

    const changed = state.sessions.filter(
      (row, index) =>
        !sameSessionRowProps(
          { session: row },
          { session: next.sessions[index]! },
        ),
    ).length;
    expect(changed).toBe(1);
  });

  // The Sessions inbox reads the same hot list, and it is the surface being
  // SCROLLED while all of this arrives (Task 338). Two counts matter: how many
  // cards a broadcast re-renders, and how many commits reach the reorder pass —
  // the pass runs on changes to this digest, and a card that has not repainted
  // cannot have moved.
  const inboxCards = (sessions: SessionListItem[]): SessionInboxCard[] => {
    const view = buildSessionInbox(sessions);
    return [...view.needsYou, ...view.active].flatMap((item) =>
      item.kind === "session" ? [item.card] : [],
    );
  };
  const inboxLayoutKey = (sessions: SessionListItem[], now: number): string =>
    inboxCards(sessions)
      .map((card) => sessionCardKey(card, now))
      .join("\n");

  it("re-renders one inbox card when one session changes", () => {
    const state = loadedState();
    const moved = sessionRows(SESSION_COUNT, true);
    moved[3] = { ...moved[3]!, title: "Renamed while streaming" };
    const next = apply(state, { type: "sessions", sessions: moved });

    const before = inboxCards(state.sessions);
    const after = inboxCards(next.sessions);
    const invalidated = before.filter(
      (card, index) =>
        sessionCardKey(card, NOW) !== sessionCardKey(after[index]!, NOW),
    ).length;
    // One: the other nine rows are brand-new objects with identical content.
    expect(invalidated).toBe(1);
  });

  it("re-renders no inbox card for a broadcast that changes nothing", () => {
    const state = loadedState();
    const next = apply(state, {
      type: "sessions",
      sessions: sessionRows(SESSION_COUNT, true),
    });
    expect(next.sessions).not.toBe(state.sessions);

    const before = inboxCards(state.sessions);
    const after = inboxCards(next.sessions);
    const invalidated = before.filter(
      (card, index) =>
        sessionCardKey(card, NOW) !== sessionCardKey(after[index]!, NOW),
    ).length;
    expect(invalidated).toBe(0);
  });

  it("keeps the reorder pass off a tick that repaints no card", () => {
    const state = loadedState();
    // The shared ticker runs at 1s while anything streams. A second in which no
    // rendered label changed must not reach the layout pass at all — that pass
    // measuring on every commit is what turned a scroll into a flicker.
    const idle = sessionRows(SESSION_COUNT, false);
    const quiet = apply(state, { type: "sessions", sessions: idle });
    expect(inboxLayoutKey(quiet.sessions, NOW + 999)).toBe(
      inboxLayoutKey(quiet.sessions, NOW),
    );
    // Working is a stable badge now, so a five-second tick changes no card and
    // never reaches the layout pass either. The separate card age still
    // invalidates the layout key when its visible minute bucket changes.
    const running = sessionRows(SESSION_COUNT, true).map((row, index) => ({
      ...row,
      runStartedAt: NOW - 3_000,
      updatedAt: NOW - 100_000 + index,
    }));
    expect(inboxLayoutKey(running, NOW + 5_000)).toBe(
      inboxLayoutKey(running, NOW),
    );
    expect(inboxLayoutKey(running, NOW + 60_000)).not.toBe(
      inboxLayoutKey(running, NOW),
    );
  });

  /**
   * A cluster is one card standing for several sessions, so it reads MORE of
   * the hot list than any other card does. The counts that matter are the same
   * two: a broadcast that changes nothing repaints nothing, and a change inside
   * one cluster reaches that cluster alone — a peer of another coordinator, or
   * an unrelated session entirely, must leave it untouched.
   */
  const clusterRows = (streaming: boolean): SessionListItem[] => {
    const rows = sessionRows(SESSION_COUNT, streaming);
    // Two coordinators, two owned peers each; the rest stay independent.
    return rows.map((row, index) =>
      index >= 2 && index <= 5
        ? {
            ...row,
            spawnedBySessionId: index <= 3 ? "s0" : "s1",
            spawnOwnership: "coordinator" as const,
          }
        : row,
    );
  };

  it("re-renders no cluster for a broadcast that changes nothing", () => {
    const state = apply(loadedState(), {
      type: "sessions",
      sessions: clusterRows(true),
    });
    const next = apply(state, {
      type: "sessions",
      sessions: clusterRows(true),
    });
    expect(next.sessions).not.toBe(state.sessions);

    const before = inboxCards(state.sessions);
    const after = inboxCards(next.sessions);
    expect(before.filter((card) => card.cluster)).toHaveLength(2);
    const invalidated = before.filter(
      (card, index) =>
        sessionCardKey(card, NOW) !==
        sessionCardKey(after[index] as SessionInboxCard, NOW),
    ).length;
    expect(invalidated).toBe(0);
  });

  it("repaints one cluster when one of its peers changes, and nothing else", () => {
    const state = apply(loadedState(), {
      type: "sessions",
      sessions: clusterRows(true),
    });
    // The peer of the FIRST coordinator stops running: its cluster's summary
    // moves, the second coordinator's does not, and neither do the eight cards
    // that have nothing to do with either.
    const moved = clusterRows(true).map((row) =>
      row.id === "s2" ? { ...row, isStreaming: false } : row,
    );
    const next = apply(state, { type: "sessions", sessions: moved });

    const before = new Map(
      inboxCards(state.sessions).map((card) => [
        card.session.id,
        sessionCardKey(card, NOW),
      ]),
    );
    const changed = inboxCards(next.sessions)
      .filter(
        (card) => before.get(card.session.id) !== sessionCardKey(card, NOW),
      )
      .map((card) => card.session.id);
    expect(changed).toEqual(["s0"]);
  });

  /**
   * A live Workflow Run is one more item reading this hot list, and it reads
   * BOTH hot lists: the sessions it owns and the `workflow` topic's own
   * broadcast, which the server re-sends whole on any run's change. So the same
   * two counts hold for it — a broadcast that changes nothing repaints nothing,
   * and a change to one run reaches that run alone.
   */
  const RUN_ROLE_IDS = ["s2", "s3", "s4"];
  const workflowRun = (
    partial: Partial<WorkflowRunSummary> = {},
  ): WorkflowRunSummary => ({
    id: "r1",
    taskId: "676",
    recipeId: "code-delivery",
    recipeVersion: 1,
    lifecycle: "active",
    limits: { maxIterations: 3, maxReviewPasses: 2 },
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 30_000,
    ...partial,
  });
  const workflowCard = (): WorkflowRunCard => ({
    runId: "r1",
    phase: "review",
    activity: "running",
    iterationsUsed: 1,
    nextAction: "Start the second review pass.",
    mergeDecisionReady: false,
    canRebaseAndReview: false,
    canRetry: false,
    canResume: true,
    coordinatorSessionId: RUN_ROLE_IDS[0] as string,
    implementerSessionId: RUN_ROLE_IDS[1] as string,
    reviewerSessions: [{ pass: 1, sessionId: RUN_ROLE_IDS[2] as string }],
  });
  const runKeys = (
    sessions: SessionListItem[],
    runs: WorkflowRunSummary[],
  ): Map<string, string> => {
    const view = buildSessionInbox(sessions, {
      workflowRuns: runs,
      workflowCards: { r1: workflowCard() },
    });
    return new Map(
      [...view.needsYou, ...view.active].map((item) => [
        inboxItemId(item),
        item.kind === "run"
          ? workflowRunItemKey(item, NOW)
          : sessionCardKey(item.card, NOW),
      ]),
    );
  };

  it("repaints no inbox item for a Workflow Run broadcast that changes nothing", () => {
    const sessions = sessionRows(SESSION_COUNT, true);
    const before = runKeys(sessions, [workflowRun()]);
    // The `workflow` topic re-broadcasts the whole list, so every summary is a
    // brand-new object with identical content.
    const after = runKeys(sessions, [workflowRun()]);
    expect(before.size).toBe(SESSION_COUNT - RUN_ROLE_IDS.length + 1);
    expect([...after].filter(([id, key]) => before.get(id) !== key)).toEqual(
      [],
    );
  });

  it("repaints the run alone when the run moves, and nothing when a session does", () => {
    const sessions = sessionRows(SESSION_COUNT, true);
    const before = runKeys(sessions, [workflowRun()]);

    const paused = runKeys(sessions, [
      workflowRun({
        lifecycle: "paused",
        lifecycleReason: "Waiting for your merge decision.",
        updatedAt: NOW - 1_000,
      }),
    ]);
    expect(
      [...paused]
        .filter(([id, key]) => before.get(id) !== key)
        .map(([id]) => id),
    ).toEqual(["run:r1"]);

    // An unrelated session's rename is the other direction: the run states its
    // sessions in counts, and a title is not one of them.
    const renamed = sessions.map((row) =>
      row.id === "s9" ? { ...row, title: "Renamed while streaming" } : row,
    );
    expect(
      [...runKeys(renamed, [workflowRun()])]
        .filter(([id, key]) => before.get(id) !== key)
        .map(([id]) => id),
    ).toEqual(["s9"]);
  });

  /**
   * The same two counts across the run's terminal boundary ([Task-677]): an
   * ended, unsettled run is one Needs-you item whose roles stay folded, and it
   * is exactly as content-stable as a live one — an unrelated session or
   * workflow broadcast repaints neither it nor its neighbours.
   */
  const endedRun = (): WorkflowRunSummary =>
    workflowRun({
      lifecycle: "completed",
      endedAt: NOW - 10_000,
      attention: {
        revision: 1,
        settledRevision: 0,
        kind: "completed",
        at: NOW - 10_000,
      },
    });

  it("repaints nothing for an ended run when an unrelated session or run broadcast lands", () => {
    const sessions = sessionRows(SESSION_COUNT, true);
    const before = runKeys(sessions, [endedRun()]);
    expect(before.has("run:r1")).toBe(true);
    expect(before.size).toBe(SESSION_COUNT - RUN_ROLE_IDS.length + 1);

    expect(
      [...runKeys(sessions, [endedRun()])].filter(
        ([id, key]) => before.get(id) !== key,
      ),
    ).toEqual([]);

    const renamed = sessions.map((row) =>
      row.id === "s9" ? { ...row, title: "Renamed while streaming" } : row,
    );
    expect(
      [...runKeys(renamed, [endedRun()])]
        .filter(([id, key]) => before.get(id) !== key)
        .map(([id]) => id),
    ).toEqual(["s9"]);

    // A Settle on another device: the run leaves, and its roles are released
    // as rows of their own — nothing else on the list changes.
    const settled = runKeys(sessions, [
      {
        ...endedRun(),
        attention: {
          revision: 1,
          settledRevision: 1,
          kind: "completed",
          at: NOW - 10_000,
        },
      },
    ]);
    expect(settled.has("run:r1")).toBe(false);
    expect(
      [...settled]
        .filter(([id, key]) => before.get(id) !== key)
        .map(([id]) => id)
        .sort(),
    ).toEqual([...RUN_ROLE_IDS].sort());
  });

  /**
   * The Backlog's delivery chip reads a projection that arrives on a TIMER, not
   * on a change (`hooks/useWorktreeHosting.ts`). It reaches the memoized sidebar
   * and through it every Task row, so the counts that matter are how many rows a
   * poll invalidates — none for a poll that repeats itself, whatever order the
   * server answered in, and exactly the one branch that actually moved.
   */
  const hostingRows = (
    tasks: Task[],
    sessions: SessionListItem[],
    statuses: WorktreeHostingStatusResponse[],
  ): string[] => {
    const ctx: TaskRowMetaContext = {
      today: "2026-08-06",
      sessionById: new Map(sessions.map((session) => [session.id, session])),
      showProjectBadge: false,
      hostingByWorktree: worktreeHostingMap(statuses),
      now: NOW,
    };
    return tasks.map((task) =>
      JSON.stringify(buildTaskRowMeta(task, ctx).delivery),
    );
  };

  const BACKLOG_SIZE = 226;
  const hostingScenario = () => {
    const sessions = Array.from({ length: BACKLOG_SIZE }, (_, i) => ({
      id: `s${i}`,
      harness: "pi",
      title: `Session ${i}`,
      updatedAt: NOW,
      messageCount: 1,
      worktreeId: `wt-${i}`,
    })) as unknown as SessionListItem[];
    const tasks = sessions.map(
      (session, i) =>
        ({
          id: `t${i}`,
          title: `Task ${i}`,
          status: "doing",
          source: { createdBy: "user" },
          createdAt: 0,
          updatedAt: NOW,
          sessionRefs: [{ sessionId: session.id, origin: "task-start" }],
        }) as unknown as Task,
    );
    const statuses: WorktreeHostingStatusResponse[] = sessions.map((_, i) => ({
      worktreeId: `wt-${i}`,
      ci: { state: "success", total: 2 },
      pr: {
        number: i,
        url: `https://forge/pulls/${i}`,
        title: "t",
        state: "open",
      },
    }));
    return { tasks, sessions, statuses };
  };

  it("invalidates no Task row when a hosting poll repeats itself", () => {
    const { tasks, sessions, statuses } = hostingScenario();
    // The server fills this list from a concurrent worker pool, so the same
    // answer routinely arrives in a different order.
    const reordered = [...statuses].reverse();
    expect(worktreeHostingKey(reordered)).toBe(worktreeHostingKey(statuses));

    const before = hostingRows(tasks, sessions, statuses);
    const after = hostingRows(tasks, sessions, reordered);
    const invalidated = before.filter(
      (row, index) => row !== after[index],
    ).length;
    expect(invalidated).toBe(0);
  });

  it("invalidates one Task row when one branch's checks go red", () => {
    const { tasks, sessions, statuses } = hostingScenario();
    const next = statuses.map((status, index) =>
      index === 7
        ? { ...status, ci: { state: "failure" as const, total: 2 } }
        : status,
    );
    expect(worktreeHostingKey(next)).not.toBe(worktreeHostingKey(statuses));

    const before = hostingRows(tasks, sessions, statuses);
    const after = hostingRows(tasks, sessions, next);
    const invalidated = before.filter(
      (row, index) => row !== after[index],
    ).length;
    expect(invalidated).toBe(1);
  });

  /**
   * The same rows' dirty dot, from the OTHER direction: it reads reducer state,
   * and the watcher rewrites a worktree's whole status several times a second
   * while an agent writes in it. So the counts that matter are how much of that
   * reaches the memoized list — nothing at all for a scan that found the same
   * dirt, nothing for a worktree outside the Backlog's own scope, and one row
   * for the branch that actually changed state.
   */
  const gitStatus = (
    worktreeId: string,
    dirty: boolean,
    patch: Partial<WorktreeGitStatus> = {},
  ): WorktreeGitStatus => ({
    worktreeId,
    branch: worktreeId,
    head: "abc1234",
    dirty,
    filesChanged: dirty ? 4 : 0,
    untracked: 0,
    additions: dirty ? 120 : 0,
    deletions: dirty ? 38 : 0,
    ahead: 0,
    behind: 0,
    merged: false,
    updatedAt: NOW,
    ...patch,
  });

  const dirtyState = (): UIState => {
    let state = createInitialState();
    for (let i = 0; i < BACKLOG_SIZE; i += 1)
      state = apply(state, {
        type: "worktreeStatus",
        status: gitStatus(`wt-${i}`, i === 3),
      });
    // The worktree of the conversation this browser has open: watched, not
    // linked to any Task in the list, and the one an agent is writing in.
    return apply(state, {
      type: "worktreeStatus",
      status: gitStatus("wt-chat", false),
    });
  };

  /** The Backlog's whole reach into worktree state (`taskWorktreeIds`). */
  const backlogScope = (tasks: Task[], sessions: SessionListItem[]): string[] =>
    taskWorktreeIds(
      tasks,
      new Map(sessions.map((session) => [session.id, session])),
    );

  const dirtySlice = (
    statuses: Record<string, WorktreeGitStatus>,
    scope: string[],
  ): string => dirtyWorktreeKey(dirtyWorktreeIds(statuses, scope));

  const dirtyRows = (
    tasks: Task[],
    sessions: SessionListItem[],
    statuses: Record<string, WorktreeGitStatus>,
  ): boolean[] => {
    const scope = backlogScope(tasks, sessions);
    const ctx: TaskRowMetaContext = {
      today: "2026-08-06",
      sessionById: new Map(sessions.map((session) => [session.id, session])),
      showProjectBadge: false,
      dirtyWorktrees: new Set(dirtyWorktreeIds(statuses, scope)),
      now: NOW,
    };
    return tasks.map((task) => buildTaskRowMeta(task, ctx).dirty);
  };

  it("invalidates no Task row when a scan reports the same dirt", () => {
    const state = dirtyState();
    const { tasks, sessions } = hostingScenario();
    const scope = backlogScope(tasks, sessions);
    // A watcher push carrying new file counts and a fresh scan time for a
    // worktree that was already dirty: the record is a new object, the answer
    // the Backlog reads is the same one.
    const next = apply(state, {
      type: "worktreeStatus",
      status: gitStatus("wt-3", true, {
        filesChanged: 9,
        additions: 400,
        updatedAt: NOW + 5_000,
      }),
    });
    expect(next.worktreeStatuses).not.toBe(state.worktreeStatuses);
    expect(dirtySlice(next.worktreeStatuses, scope)).toBe(
      dirtySlice(state.worktreeStatuses, scope),
    );

    const before = dirtyRows(tasks, sessions, state.worktreeStatuses);
    const after = dirtyRows(tasks, sessions, next.worktreeStatuses);
    expect(before.filter((row, index) => row !== after[index]).length).toBe(0);
  });

  it("invalidates no Task row when a worktree no row shows goes dirty", () => {
    const state = dirtyState();
    const { tasks, sessions } = hostingScenario();
    const scope = backlogScope(tasks, sessions);
    expect(scope).not.toContain("wt-chat");

    const next = apply(state, {
      type: "worktreeStatus",
      status: gitStatus("wt-chat", true),
    });
    // The slice is scoped to the Backlog's own worktrees, so this says nothing
    // new — the whole point of scoping it rather than reading every dirty id.
    expect(dirtySlice(next.worktreeStatuses, scope)).toBe(
      dirtySlice(state.worktreeStatuses, scope),
    );

    const before = dirtyRows(tasks, sessions, state.worktreeStatuses);
    const after = dirtyRows(tasks, sessions, next.worktreeStatuses);
    expect(before.filter((row, index) => row !== after[index]).length).toBe(0);
  });

  it("invalidates one Task row when one worktree goes dirty", () => {
    const state = dirtyState();
    const { tasks, sessions } = hostingScenario();
    const scope = backlogScope(tasks, sessions);
    const next = apply(state, {
      type: "worktreeStatus",
      status: gitStatus("wt-7", true),
    });
    expect(dirtySlice(next.worktreeStatuses, scope)).not.toBe(
      dirtySlice(state.worktreeStatuses, scope),
    );

    const before = dirtyRows(tasks, sessions, state.worktreeStatuses);
    const after = dirtyRows(tasks, sessions, next.worktreeStatuses);
    expect(before.filter((row, index) => row !== after[index]).length).toBe(1);
    expect(after[7]).toBe(true);
  });

  it("mounts a bounded window of a long transcript", () => {
    const state = loadedState();
    const rows = state.messages.map((message) => ({ key: message.id }));
    const start = transcriptWindowStart(rows, 120, null);
    expect(rows.length - start).toBe(120);
    // Arriving messages extend the window rather than sliding it.
    const grown = [...rows, { key: "new-1" }, { key: "new-2" }];
    expect(transcriptWindowStart(grown, 120, rows[start]!.key)).toBe(start);
  });

  it("coalesces a broadcast burst into a single cache write", () => {
    let now = 0;
    const timers = new Map<number, { at: number; run: () => void }>();
    let handle = 1;
    let idle: Array<() => void> = [];
    const env: IdleWriterEnv = {
      now: () => now,
      setTimer: (run, ms) => {
        const id = handle++;
        timers.set(id, { at: now + ms, run });
        return id;
      },
      clearTimer: (id) => void timers.delete(id),
      whenIdle: (run) => void idle.push(run),
    };
    const writes: number[] = [];
    const writer = createIdleWriter<number>((value) => writes.push(value), {
      delayMs: 1000,
      maxDelayMs: 15_000,
      idleTimeoutMs: 2000,
      env,
    });

    // One second of session broadcasts at the sustained ~4/s rate.
    for (let i = 0; i < 4; i += 1) {
      writer.schedule(i);
      now += 250;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
      const due = idle;
      idle = [];
      for (const run of due) run();
    }
    expect(writes.length).toBe(0);
    writer.flush();
    expect(writes).toEqual([3]);
  });
});
