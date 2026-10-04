import { describe, expect, it } from "vitest";
import type {
  SessionListItem,
  WorkflowRunAttention,
  WorkflowRunCard,
  WorkflowRunSummary,
} from "@assistant/shared";
import { isShelvedSession } from "@assistant/shared";
import {
  buildSessionInbox,
  inboxItemId,
  clusterBubbleDismissible,
  clusterLiveSummary,
  spawnTreeStall,
  stallLabel,
  sameClusterChildProps,
  sameWorkflowRunItemProps,
  sessionSettleCascade,
  workflowRunBadge,
  workflowRunDetail,
  workflowRunItemKey,
  workflowRunPhaseLine,
  workflowRunRolesSummary,
  workflowRunSettleOffered,
  type WorkflowRunInboxItem,
  sessionClusterBubbleLabel,
  sessionClusterSummary,
  spawnedSessionsKey,
  spawnedSessionsSummary,
  spawnedSessionsView,
  type SessionClusterCounts,
  type SessionInboxTier,
  classifySessionStatus,
  planCardReorder,
  sameSessionCardProps,
  sessionCardAge,
  sessionCardKey,
  sessionCardMeta,
  sessionRelationsKey,
  sessionStatusBadge,
  sessionStatusDetail,
  sessionStatusText,
  SETTLED_PAGE_SIZE,
  tierForStatus,
  workflowRunPullRequestSession,
  worktreeChangesText,
  type SessionCardRelations,
  type SessionInboxCard,
  type SessionInboxItem,
} from "./sessionInbox.ts";
import { elapsedLabel, relativeAge } from "./relativeTime.ts";

const NOW = 1_800_000_000_000;

/**
 * The SESSION cards of a shaped list. The inbox's lists carry two kinds of item
 * since [Task-676](pa://task/676); the run items are asserted on their own
 * below, and every expectation about sessions reads them through here.
 */
function cards(items: SessionInboxItem[]): SessionInboxCard[] {
  return items.flatMap((item) => (item.kind === "session" ? [item.card] : []));
}

function session(
  partial: Partial<SessionListItem> & { id: string },
): SessionListItem {
  return {
    harness: "pi",
    agentType: "assistant",
    title: partial.id,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    messageCount: 2,
    ...partial,
  };
}

describe("classifySessionStatus", () => {
  it("puts a human decision ahead of everything else", () => {
    expect(
      classifySessionStatus(
        session({
          id: "a",
          attention: "approval",
          isStreaming: true,
          unread: true,
        }),
      ),
    ).toBe("approval");
    expect(
      classifySessionStatus(
        session({
          id: "b",
          attention: "question",
          lastError: { at: NOW, message: "boom" },
        }),
      ),
    ).toBe("question");
  });

  it("keeps a /pr Task pick as its own decision", () => {
    const row = session({
      id: "a",
      attention: "task-choice",
      awaitingInput: true,
      unread: true,
    });
    expect(classifySessionStatus(row)).toBe("task-choice");
    expect(tierForStatus(classifySessionStatus(row))).toBe("needs-you");
    expect(isShelvedSession(session({ ...row, settledAt: NOW - 1000 }))).toBe(
      false,
    );
  });

  it("treats a bare awaitingInput row as a question", () => {
    expect(
      classifySessionStatus(session({ id: "a", awaitingInput: true })),
    ).toBe("question");
  });

  it("ranks running above a stale failure, and a failure above an unread response", () => {
    expect(
      classifySessionStatus(
        session({
          id: "a",
          isStreaming: true,
          lastError: { at: NOW, message: "boom" },
        }),
      ),
    ).toBe("running");
    expect(
      classifySessionStatus(
        session({
          id: "b",
          lastError: { at: NOW, message: "boom" },
          unread: true,
        }),
      ),
    ).toBe("failed");
    expect(classifySessionStatus(session({ id: "c", unread: true }))).toBe(
      "unread",
    );
    expect(classifySessionStatus(session({ id: "d" }))).toBe("quiet");
  });

  it("never calls the session you are looking at unread", () => {
    expect(
      classifySessionStatus(session({ id: "open", unread: true }), "open"),
    ).toBe("quiet");
  });

  it("uses Done only while a successful response is unread", () => {
    const done = session({
      id: "open",
      unread: true,
      outcomeAttention: {
        revision: 3,
        settledRevision: 2,
        kind: "completed",
        at: NOW - 1000,
      },
    });
    const unreadStatus = classifySessionStatus(done);
    expect(unreadStatus).toBe("unread");
    expect(tierForStatus(unreadStatus)).toBe("attention");
    expect(sessionStatusBadge(done, unreadStatus, NOW)).toEqual({
      label: "Done",
      tone: "success",
    });

    // Reading changes the visible status, but does not acknowledge the outcome:
    // the quiet card stays in the working set until the user settles it.
    const readStatus = classifySessionStatus(done, "open");
    expect(readStatus).toBe("quiet");
    expect(tierForStatus(readStatus)).toBe("active");
    expect(sessionStatusBadge(done, readStatus, NOW)).toEqual({
      label: "Idle",
      tone: "muted",
    });
    const view = buildSessionInbox([done], { readCurrentId: "open" });
    expect(cards(view.active)[0]?.status).toBe("quiet");
    expect(view.settled).toHaveLength(0);
  });

  it("keeps a failure's badge on an outcome a later run's message no longer explains", () => {
    // `lastError` is cleared by the next run start; the unacknowledged failure
    // is not, so the card must still say what the user has not dealt with.
    const row = session({
      id: "a",
      unread: true,
      interruptedRun: { at: NOW - 500 },
      outcomeAttention: {
        revision: 1,
        settledRevision: 0,
        kind: "failed",
        at: NOW - 1000,
      },
    });
    expect(classifySessionStatus(row)).toBe("failed");
    expect(sessionStatusBadge(row, "failed", NOW)).toEqual({
      label: "Failed",
      tone: "danger",
    });
  });
});

describe("isShelvedSession", () => {
  it("keeps settled work out of the active list", () => {
    const row = session({ id: "a", settledAt: NOW - 1000 });
    expect(isShelvedSession(row)).toBe(true);
  });

  it("refuses to hide human-blocking work in the shelf", () => {
    const question = session({
      id: "a",
      settledAt: NOW - 1000,
      attention: "question",
    });
    expect(isShelvedSession(question)).toBe(false);
  });

  it("leaves a settled session on the shelf while its next turn runs", () => {
    const running = session({
      id: "b",
      settledAt: NOW - 1000,
      isStreaming: true,
    });
    expect(isShelvedSession(running)).toBe(true);
  });

  it("takes the row back when the server withholds settledAt for a new outcome", () => {
    // The server projects no `settledAt` once an outcome is unacknowledged, so
    // the card is back in the working set stating what happened.
    const woken = session({
      id: "c",
      outcomeAttention: {
        revision: 1,
        settledRevision: 0,
        kind: "completed",
        at: NOW - 500,
      },
    });
    expect(isShelvedSession(woken)).toBe(false);
    expect(cards(buildSessionInbox([woken]).active)).toHaveLength(1);
  });
});

describe("buildSessionInbox", () => {
  it("splits Needs you from the rest and orders by tier, then activity, then id", () => {
    const view = buildSessionInbox([
      session({ id: "quiet-old", updatedAt: NOW - 500_000 }),
      session({ id: "running", isStreaming: true, updatedAt: NOW - 900_000 }),
      session({ id: "asks", attention: "question", updatedAt: NOW - 900_000 }),
      session({
        id: "failed",
        lastError: { at: NOW - 10_000, message: "provider error" },
        updatedAt: NOW - 900_000,
      }),
      session({ id: "quiet-new", updatedAt: NOW - 1_000 }),
    ]);
    expect(cards(view.needsYou).map((card) => card.session.id)).toEqual([
      "asks",
    ]);
    expect(cards(view.active).map((card) => card.session.id)).toEqual([
      "failed",
      "running",
      "quiet-new",
      "quiet-old",
    ]);
  });

  it("breaks an exact tie on id so rows never shuffle between renders", () => {
    const view = buildSessionInbox([
      session({ id: "b", updatedAt: NOW }),
      session({ id: "a", updatedAt: NOW }),
    ]);
    expect(cards(view.active).map((card) => card.session.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("excludes archived rows", () => {
    const sessions = [
      session({ id: "gone", archived: true, title: "inbox work" }),
      session({ id: "kept", title: "inbox work" }),
    ];
    const view = buildSessionInbox(sessions);
    expect(cards(view.active).map((card) => card.session.id)).toEqual(["kept"]);
  });

  it("pages the settled shelf newest-settled first and reports the remainder", () => {
    const sessions = Array.from({ length: SETTLED_PAGE_SIZE + 3 }, (_, index) =>
      session({ id: `s${index}`, settledAt: NOW - index * 1000 }),
    );
    const view = buildSessionInbox(sessions);
    expect(view.settled).toHaveLength(SETTLED_PAGE_SIZE);
    expect(view.settled[0]?.id).toBe("s0");
    expect(view.settledHidden).toBe(3);
    expect(view.settledTotal).toBe(SETTLED_PAGE_SIZE + 3);
  });

  it("keeps a routed settled row visible past the page cutoff", () => {
    const sessions = Array.from({ length: SETTLED_PAGE_SIZE + 3 }, (_, index) =>
      session({ id: `s${index}`, settledAt: NOW - index * 1000 }),
    );
    const view = buildSessionInbox(sessions, { currentId: "s12" });
    expect(view.settled.map((item) => item.id)).toContain("s12");
    expect(view.settledHidden).toBe(2);
  });

  it("keeps the just-opened session unread until the read dwell has passed", () => {
    const sessions = [session({ id: "open", unread: true })];
    // Routed, but not yet read through: it must stay in the attention tier, or
    // the card re-sorts out from under the click that opened it.
    const during = buildSessionInbox(sessions, { currentId: "open" });
    expect(cards(during.active)[0]?.status).toBe("unread");
    const after = buildSessionInbox(sessions, {
      currentId: "open",
      readCurrentId: "open",
    });
    expect(cards(after.active)[0]?.status).toBe("quiet");
  });

  it("marks Settle as blocked for running, blocked and queued work only", () => {
    const view = buildSessionInbox([
      session({ id: "running", isStreaming: true }),
      session({ id: "asks", attention: "question" }),
      session({ id: "approves", attention: "approval" }),
      session({ id: "queued", queuedWork: true }),
      session({ id: "free" }),
    ]);
    const blocked = new Map(
      [...cards(view.needsYou), ...cards(view.active)].map((card) => [
        card.session.id,
        card.settleBlocked,
      ]),
    );
    expect(blocked.get("running")).toBe("it is still running.");
    expect(blocked.get("asks")).toBe("it is waiting for your answer.");
    expect(blocked.get("approves")).toBe("it is waiting for your approval.");
    expect(blocked.get("queued")).toBe("work is queued behind it.");
    expect(blocked.get("free")).toBeUndefined();
  });

  it("reports an empty browser when there is nothing to show", () => {
    expect(buildSessionInbox([session({ id: "a" })]).empty).toBe(false);
    expect(buildSessionInbox([]).empty).toBe(true);
  });
});

describe("labels", () => {
  it("marks the state with one short, stable coloured badge", () => {
    expect(
      sessionStatusBadge(
        session({ id: "a", isStreaming: true, runStartedAt: NOW - 245_000 }),
        "running",
        NOW,
      ),
    ).toEqual({
      label: "Working",
      tone: "accent",
    });
    expect(
      sessionStatusBadge(
        session({ id: "a", attention: "question" }),
        "question",
        NOW,
      ),
    ).toEqual({ label: "Answer", tone: "accent" });
    expect(
      sessionStatusBadge(
        session({ id: "a", attention: "approval" }),
        "approval",
        NOW,
      ),
    ).toEqual({ label: "Approve", tone: "warning" });
    expect(
      sessionStatusBadge(
        session({ id: "a", attention: "task-choice" }),
        "task-choice",
        NOW,
      ),
    ).toEqual({ label: "Pick task", tone: "accent" });
    expect(
      sessionStatusBadge(
        session({ id: "a", lastError: { at: NOW, message: "boom" } }),
        "failed",
        NOW,
      ),
    ).toEqual({
      label: "Failed",
      tone: "danger",
    });
    expect(
      sessionStatusBadge(session({ id: "a", unread: true }), "unread", NOW),
    ).toEqual({ label: "Done", tone: "success" });
  });

  it("gives a quiet session the neutral Idle badge and NO detail", () => {
    expect(sessionStatusBadge(session({ id: "a" }), "quiet", NOW)).toEqual({
      label: "Idle",
      tone: "muted",
    });
    // No sentence restating the absence either: it was the line on nine cards
    // in ten, and it cost each of them a line.
    expect(sessionStatusDetail(session({ id: "a" }), "quiet")).toBeUndefined();
    expect(sessionStatusText(session({ id: "a" }), "quiet", NOW)).toBe("Idle");
  });

  it("survives malformed timestamps instead of rendering NaN", () => {
    expect(relativeAge(Number.NaN, NOW)).toBe("—");
    expect(relativeAge(0, NOW)).toBe("—");
    expect(elapsedLabel(Number.NaN)).toBe("0s");
    expect(elapsedLabel(-5)).toBe("0s");
    expect(elapsedLabel(3_930_000)).toBe("1h 5m");
  });

  it("names the failure beside the badge, bounded to one card line", () => {
    const long = "x".repeat(400);
    const detail =
      sessionStatusDetail(
        session({
          id: "a",
          lastError: { at: NOW, message: `boom\n\n${long}` },
        }),
        "failed",
      ) ?? "";
    expect(detail.startsWith("boom x")).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(170);
  });

  it("keeps the one quiet detail that says something: queued work", () => {
    expect(
      sessionStatusDetail(session({ id: "a", queuedWork: true }), "quiet"),
    ).toBe("Queued work is waiting to run");
    expect(sessionStatusDetail(session({ id: "b" }), "quiet")).toBeUndefined();
  });

  it("still states the whole status in words for assistive technology", () => {
    expect(
      sessionStatusText(
        session({ id: "a", attention: "approval" }),
        "approval",
        NOW,
      ),
    ).toBe("Approve · Waiting for your approval");
    expect(
      sessionStatusText(
        session({ id: "a", isStreaming: true, runStartedAt: NOW - 30_000 }),
        "running",
        NOW,
      ),
    ).toBe("Working");
  });
});

describe("sessionCardMeta", () => {
  it("orders metadata by truncation priority and drops what is unknown", () => {
    const row = session({
      id: "a",
      taskProgress: { todo: 1, doing: 1, done: 2 },
    });
    expect(
      sessionCardMeta(row, {
        projectId: "pa",
        projectKey: "PA",
        projectName: "Pandeck",
        projectColor: "#8b5cf6",
        worktreeBranch: "sessions-ui",
        taskId: "227",
        taskTitle: "Implement the Sessions inbox",
      }),
    ).toEqual([
      {
        kind: "project",
        label: "PA",
        title: "Pandeck",
        color: "#8b5cf6",
      },
      { kind: "worktree", label: "sessions-ui" },
      { kind: "task", label: "#227", title: "Implement the Sessions inbox" },
    ]);
    expect(
      sessionCardMeta(session({ id: "b" }), { worktreeBranch: "main" }),
    ).toEqual([{ kind: "worktree", label: "main" }]);
    expect(sessionCardMeta(session({ id: "c" }))).toEqual([]);
  });

  it("marks the worktree item `missing` when the session's edge is dead (Task 325)", () => {
    expect(
      sessionCardMeta(session({ id: "a", worktreeMissing: true }), {
        worktreeBranch: "gone-branch",
      }),
    ).toEqual([
      {
        kind: "worktree",
        label: "gone-branch",
        missing: true,
        title: "gone-branch — worktree removed",
      },
    ]);
  });

  it("names the Task by ID and keeps its title as the tooltip", () => {
    expect(sessionCardMeta(session({ id: "a" }), { taskId: "227" })).toEqual([
      { kind: "task", label: "#227", title: "Task 227" },
    ]);
  });

  it("carries only items that lead somewhere: no persona, no model, no Task counter", () => {
    const row = session({
      id: "a",
      agentType: "developer",
      taskProgress: { todo: 1, doing: 0, done: 1 },
    });
    expect(
      sessionCardMeta(row, { projectKey: "PA" }).map((item) => item.kind),
    ).toEqual(["project"]);
  });

  it("carries fork lineage last, and only when the parent is actually known", () => {
    const forked = session({
      id: "a",
      forkOrigin: { parentSessionFile: "p.jsonl", parentSessionId: "p" },
    });
    expect(
      sessionCardMeta(forked, {
        worktreeBranch: "main",
        forkedFromTitle: "Original chat",
      }),
    ).toEqual([
      { kind: "worktree", label: "main" },
      { kind: "fork", label: "Forked from Original chat" },
    ]);
    expect(sessionCardMeta(forked, { worktreeBranch: "main" })).toEqual([
      { kind: "worktree", label: "main" },
    ]);
  });
});

function card(
  partial: Partial<SessionListItem> & { id: string },
): SessionInboxCard {
  const row = session(partial);
  const status = classifySessionStatus(row);
  return { session: row, status, tier: tierForStatus(status) };
}

describe("sessionCardKey", () => {
  it("is stable across rebroadcast copies of the same row", () => {
    // `mergeSessionList` hands back brand-new row objects several times a
    // second while an agent streams; identical content must stay one key.
    expect(sessionCardKey(card({ id: "a" }), NOW)).toBe(
      sessionCardKey(card({ id: "a" }), NOW),
    );
  });

  it("ignores a tick that changes no rendered label", () => {
    // The shared ticker runs at 1s while anything is running, but a card whose
    // age still reads "1m" has nothing new to show.
    expect(sessionCardKey(card({ id: "a" }), NOW + 999)).toBe(
      sessionCardKey(card({ id: "a" }), NOW),
    );
  });

  it("changes only when a rendered time label ticks over", () => {
    const running = card({ id: "a", isStreaming: true, runStartedAt: NOW });
    // The Working badge no longer changes every second.
    expect(sessionCardKey(running, NOW + 5_000)).toBe(
      sessionCardKey(running, NOW),
    );
    // The card age still moves from "1m" to "2m".
    expect(sessionCardKey(card({ id: "a" }), NOW + 60_000)).not.toBe(
      sessionCardKey(card({ id: "a" }), NOW),
    );
  });

  it("changes for every field the card renders", () => {
    const base = sessionCardKey(card({ id: "a" }), NOW);
    const variants: Array<Partial<SessionListItem>> = [
      { id: "b" },
      { title: "Other" },
      { titleGenerationPending: true },
      { harness: "claude-sdk" },
      { agentType: "developer" },
      { archived: true },
      { worktreeId: "wt-1" },
      { worktreeMissing: true },
      { forkOrigin: { parentSessionFile: "p.jsonl", parentSessionId: "p" } },
      { isStreaming: true },
      { unread: true },
      { attention: "approval" },
      { awaitingInput: true },
      { lastError: { message: "boom", at: NOW } },
      { queuedWork: true },
    ];
    for (const patch of variants) {
      expect(
        sessionCardKey(card({ id: "a", ...patch }), NOW),
        JSON.stringify(patch),
      ).not.toBe(base);
    }
  });

  it("covers the settle-blocked reason the gutter renders", () => {
    const blocked: SessionInboxCard = {
      ...card({ id: "a" }),
      settleBlocked: "A run is still going",
    };
    expect(sessionCardKey(blocked, NOW)).not.toBe(
      sessionCardKey(card({ id: "a" }), NOW),
    );
  });
});

describe("sessionRelationsKey", () => {
  it("is stable across freshly built relation objects", () => {
    const build = (): SessionCardRelations => ({
      projectId: "pa",
      projectKey: "PA",
      projectName: "Pandeck",
      projectColor: "#abc",
      worktreeBranch: "main",
      taskId: "338",
      taskTitle: "Scrolling",
    });
    expect(sessionRelationsKey(build())).toBe(sessionRelationsKey(build()));
  });

  it("changes for every relation field the card renders", () => {
    const base = sessionRelationsKey({});
    const variants: SessionCardRelations[] = [
      { projectId: "pa" },
      { projectKey: "PA" },
      { projectName: "Pandeck" },
      { projectColor: "#abc" },
      { worktreeBranch: "main" },
      { taskId: "338" },
      { taskTitle: "Scrolling" },
      { forkedFromTitle: "Original chat" },
    ];
    for (const relations of variants) {
      expect(
        sessionRelationsKey(relations),
        JSON.stringify(relations),
      ).not.toBe(base);
    }
  });
});

describe("sameSessionCardProps", () => {
  function noop() {}
  const props = (patch: Record<string, unknown> = {}) => ({
    card: card({ id: "a" }),
    now: NOW,
    active: false,
    relations: { projectKey: "PA" } as SessionCardRelations,
    worktreeDirty: false,
    onOpen: noop,
    ...patch,
  });

  it("treats freshly rebuilt card and relations objects as equal", () => {
    // Exactly what a broadcast produces: same content, all-new objects.
    expect(sameSessionCardProps(props(), props())).toBe(true);
  });

  it("re-renders when the card's own content moves", () => {
    expect(
      sameSessionCardProps(
        props(),
        props({ card: card({ id: "a", unread: true }) }),
      ),
    ).toBe(false);
  });

  it("re-renders when a resolved relation changes", () => {
    expect(
      sameSessionCardProps(props(), props({ relations: { projectKey: "XX" } })),
    ).toBe(false);
  });

  it("re-renders when any other prop changes by identity", () => {
    expect(sameSessionCardProps(props(), props({ active: true }))).toBe(false);
    expect(sameSessionCardProps(props(), props({ worktreeDirty: true }))).toBe(
      false,
    );
    // A fresh arrow is a different handler as far as this can tell, which is
    // exactly why the host must pass stable ones.
    expect(sameSessionCardProps(props(), props({ onOpen: () => {} }))).toBe(
      false,
    );
  });

  it("re-renders when a prop is present on one side only", () => {
    const { worktreeDirty: _dropped, ...fewer } = props();
    expect(sameSessionCardProps(props(), fewer as never)).toBe(false);
    expect(sameSessionCardProps(fewer as never, props())).toBe(false);
  });

  it("ignores a tick that changes no rendered label", () => {
    expect(sameSessionCardProps(props(), props({ now: NOW + 999 }))).toBe(true);
  });
});

describe("planCardReorder", () => {
  it("plans nothing when no card moved", () => {
    const previous = new Map([
      ["a", 0],
      ["b", 64],
    ]);
    const { moves, next } = planCardReorder(previous, [
      { id: "a", top: 0 },
      { id: "b", top: 64 },
    ]);
    expect(moves).toEqual([]);
    expect([...next]).toEqual([
      ["a", 0],
      ["b", 64],
    ]);
  });

  it("gives a moved card the delta back to where it was", () => {
    const { moves } = planCardReorder(
      new Map([
        ["a", 0],
        ["b", 64],
      ]),
      [
        { id: "b", top: 0 },
        { id: "a", top: 64 },
      ],
    );
    // b travelled up 64px, so it starts 64px BELOW its new place and plays in.
    expect(moves).toEqual([
      { id: "b", from: 64 },
      { id: "a", from: -64 },
    ]);
  });

  it("lets a first-seen card arrive rather than inventing a from", () => {
    const { moves, next } = planCardReorder(new Map([["a", 0]]), [
      { id: "new", top: 0 },
      { id: "a", top: 64 },
    ]);
    expect(moves).toEqual([{ id: "a", from: -64 }]);
    expect(next.get("new")).toBe(0);
  });

  it("drops a departed card from the baseline rather than remembering it", () => {
    const { next } = planCardReorder(
      new Map([
        ["a", 0],
        ["gone", 64],
      ]),
      [{ id: "a", top: 0 }],
    );
    expect(next.has("gone")).toBe(false);
    expect([...next]).toEqual([["a", 0]]);
  });

  it("does not treat a sub-pixel difference as movement", () => {
    const { moves } = planCardReorder(new Map([["a", 100]]), [
      { id: "a", top: 100.4 },
    ]);
    expect(moves).toEqual([]);
  });
});

/**
 * A turn the server died inside. The session cannot report it itself — its
 * transcript is missing the turn entirely — so the card is the only place the
 * user learns which sessions are waiting to be continued.
 */
describe("interrupted turns", () => {
  const interrupted = (extra: Partial<SessionListItem> = {}) =>
    session({
      id: "cut",
      interruptedRun: { at: NOW - 60_000 },
      ...extra,
    });

  it("lifts the card out of quiet and names the action", () => {
    const s = interrupted();
    const status = classifySessionStatus(s, undefined);
    expect(status).toBe("interrupted");
    expect(tierForStatus(status)).toBe("attention");
    expect(sessionStatusBadge(s, status, NOW)).toEqual({
      label: "Interrupted",
      tone: "warning",
    });
    expect(sessionStatusDetail(s, status)).toBe(
      "Cut off by a restart — send a prompt to continue",
    );
  });

  it("yields to a session that is running again", () => {
    // The next prompt clears the mark server-side, but a list built in the same
    // moment must not label a moving session as waiting.
    expect(
      classifySessionStatus(interrupted({ isStreaming: true }), undefined),
    ).toBe("running");
  });

  it("yields to a real failure, which is a different thing to do about it", () => {
    expect(
      classifySessionStatus(
        interrupted({ lastError: { at: NOW, message: "provider exploded" } }),
        undefined,
      ),
    ).toBe("failed");
  });

  it("yields to anything that needs the user personally", () => {
    expect(
      classifySessionStatus(interrupted({ attention: "question" }), undefined),
    ).toBe("question");
    expect(
      classifySessionStatus(interrupted({ attention: "approval" }), undefined),
    ).toBe("approval");
  });

  it("counts as activity, so the card sorts by when it was cut", () => {
    const older = session({ id: "a", updatedAt: NOW - 600_000 });
    const cut = session({
      id: "b",
      updatedAt: NOW - 600_000,
      interruptedRun: { at: NOW - 1_000 },
    });
    const inbox = buildSessionInbox([older, cut]);
    expect(cards(inbox.active).map((c) => c.session.id)).toEqual(["b", "a"]);
  });
});

describe("spawn clusters", () => {
  /** A coordinator-owned peer of `parent`, the only shape that folds. */
  const child = (
    id: string,
    parent: string,
    extra: Partial<SessionListItem> = {},
  ): SessionListItem =>
    session({
      id,
      spawnedBySessionId: parent,
      spawnOwnership: "coordinator",
      ...extra,
    });

  const topLevel = (view: ReturnType<typeof buildSessionInbox>) =>
    [...cards(view.needsYou), ...cards(view.active)].map(
      (card) => card.session.id,
    );

  it("folds a coordinator and its owned peers into one item", () => {
    const view = buildSessionInbox([
      session({ id: "root", isStreaming: true }),
      child("a", "root", { isStreaming: true }),
      child("b", "root", { isStreaming: true }),
      child("c", "root", { attention: "question" }),
      child("d", "root"),
      child("e", "root", { lastError: { at: NOW, message: "boom" } }),
    ]);
    expect(topLevel(view)).toEqual(["root"]);
    const card = cards(view.needsYou)[0] as SessionInboxCard;
    expect(card.cluster?.counts).toEqual({
      total: 5,
      working: 2,
      running: 2,
      jobs: 0,
      waiting: 1,
      failed: 1,
    });
    expect(
      sessionClusterSummary(card.cluster?.counts as SessionClusterCounts),
    ).toBe("5 sessions · 2 running · 1 waiting · 1 failed");
    expect(card.cluster?.children.map((c) => c.session.id)).toEqual([
      "c",
      "e",
      "a",
      "b",
      "d",
    ]);
    // The coordinator's OWN status is untouched by what it coordinates.
    expect(card.status).toBe("running");
  });

  it("aggregates descendants at every depth under the one root", () => {
    const view = buildSessionInbox([
      session({ id: "root" }),
      child("a", "root"),
      child("b", "a"),
      child("c", "b"),
    ]);
    expect(topLevel(view)).toEqual(["root"]);
    expect(cards(view.active)[0]?.cluster?.counts.total).toBe(3);
  });

  it("keeps a taken-over child at top level with its spawn edge intact", () => {
    const taken = child("mine", "root", { spawnOwnership: "taken-over" });
    const view = buildSessionInbox([session({ id: "root" }), taken]);
    expect(topLevel(view).sort()).toEqual(["mine", "root"]);
    expect(
      cards(view.active).filter((c) => c.session.id === "mine"),
    ).toHaveLength(1);
    expect(
      cards(view.active).find((c) => c.session.id === "mine")?.session
        .spawnedBySessionId,
    ).toBe("root");
    expect(
      cards(view.active).find((c) => c.session.id === "root")?.cluster,
    ).toBe(undefined);
  });

  it("never folds an unknown spawn edge", () => {
    const view = buildSessionInbox([
      session({ id: "root" }),
      child("legacy", "root", { spawnOwnership: "unknown" }),
    ]);
    expect(topLevel(view).sort()).toEqual(["legacy", "root"]);
  });

  it("leaves a child top-level when its spawner is missing or archived", () => {
    const orphan = buildSessionInbox([child("kid", "gone")]);
    expect(topLevel(orphan)).toEqual(["kid"]);

    const archived = buildSessionInbox([
      session({ id: "root", archived: true }),
      child("kid", "root"),
    ]);
    expect(topLevel(archived)).toEqual(["kid"]);
  });

  it("keeps every folded peer under its coordinator", () => {
    const view = buildSessionInbox([
      session({ id: "root", title: "coordinator" }),
      child("kid", "root", { title: "reviewer peer" }),
      child("other", "root", { title: "implementer peer" }),
      session({ id: "loner", title: "something else" }),
    ]);
    expect(topLevel(view)).toEqual(["loner", "root"]);
    const root = cards(view.active).find((card) => card.session.id === "root");
    expect(root?.cluster?.children).toHaveLength(2);
    expect(root?.cluster?.counts.total).toBe(2);
  });

  it("folds a chain of any depth into its one root", () => {
    const chain = [session({ id: "s0" })];
    for (let i = 1; i <= 9; i += 1) chain.push(child(`s${i}`, `s${i - 1}`));
    const view = buildSessionInbox(chain);
    expect(topLevel(view)).toEqual(["s0"]);
    const children = cards(view.active)[0]?.cluster?.children ?? [];
    expect(children.map((c) => [c.session.id, c.depth])).toEqual(
      Array.from({ length: 9 }, (_, i) => [`s${i + 1}`, i + 1]),
    );
  });

  it("lists the fold as a tree: each peer under its spawner, with its own peers counted", () => {
    const view = buildSessionInbox([
      session({ id: "root" }),
      child("impl", "root", { updatedAt: NOW - 50_000 }),
      child("rev", "impl", {
        updatedAt: NOW - 1_000,
        backgroundActivity: {
          activeCount: 2,
          shellCount: 1,
          monitorCommandCount: 1,
          monitorWebsocketCount: 0,
          startingCount: 0,
          stoppingCount: 0,
          oldestStartedAt: NOW - 30_000,
        },
      }),
      child("fix", "impl", { isStreaming: true }),
      child("helper", "root", { updatedAt: NOW - 20_000 }),
    ]);
    const card = cards(view.active)[0] as SessionInboxCard;
    // Siblings in inbox order (working — a turn or a background job — first,
    // then newest), every child right under its spawner however recently it
    // moved.
    expect(card.cluster?.children.map((c) => [c.session.id, c.depth])).toEqual([
      ["helper", 1],
      ["impl", 1],
      ["rev", 2],
      ["fix", 2],
    ]);
    const impl = card.cluster?.children.find((c) => c.session.id === "impl");
    expect(impl?.peers).toMatchObject({ total: 2, running: 1, jobs: 2 });
    expect(
      card.cluster?.children.find((c) => c.session.id === "helper")?.peers,
    ).toBe(undefined);
    // The card counts every depth, and jobs separately from turns.
    expect(card.cluster?.counts).toMatchObject({
      total: 4,
      running: 1,
      jobs: 2,
    });
    expect(
      clusterLiveSummary(card.cluster?.counts as SessionClusterCounts),
    ).toBe("1 running · 2 jobs");
  });

  it("lists the coordinator's settled peers only on request, in their place in the tree", () => {
    const view = buildSessionInbox([
      session({ id: "root" }),
      child("live", "root", { isStreaming: true }),
      child("done", "root", { settledAt: NOW - 5_000 }),
      child("done-under-live", "live", { settledAt: NOW - 5_000 }),
      child("done-under-done", "done", { settledAt: NOW - 5_000 }),
      // The user's own session stays out of the coordinator's history.
      child("mine", "root", {
        settledAt: NOW - 5_000,
        spawnOwnership: "taken-over",
      }),
    ]);
    const card = cards(view.active)[0] as SessionInboxCard;
    expect(card.cluster?.children.map((c) => c.session.id)).toEqual(["live"]);
    expect(card.cluster?.counts.total).toBe(1);
    expect(card.cluster?.settledCount).toBe(3);
    expect(
      card.cluster?.childrenWithSettled.map((c) => [c.session.id, c.depth]),
    ).toEqual([
      ["live", 1],
      ["done-under-live", 2],
      ["done", 1],
      ["done-under-done", 2],
    ]);
    // History is a view: the settled peers are still on the shelf.
    expect(view.settled.map((s) => s.id).sort()).toEqual([
      "done",
      "done-under-done",
      "done-under-live",
      "mine",
    ]);
  });

  it("terminates on a spawn cycle without dropping or duplicating a session", () => {
    const view = buildSessionInbox([
      child("a", "c"),
      child("b", "a"),
      child("c", "b"),
      session({ id: "loner" }),
    ]);
    const seen = cards(view.active).flatMap((card) => [
      card.session.id,
      ...(card.cluster?.children ?? []).map((c) => c.session.id),
    ]);
    expect(seen.sort()).toEqual(["a", "b", "c", "loner"]);
    expect(topLevel(view).sort()).toEqual(["a", "loner"]);
  });

  it("lifts the cluster for every gate a folded child can hold", () => {
    const gates: Array<[Partial<SessionListItem>, SessionInboxTier, string]> = [
      [{ attention: "question" }, "needs-you", "Answer in “kid”"],
      [{ attention: "approval" }, "needs-you", "Approve in “kid”"],
      [{ attention: "task-choice" }, "needs-you", "Pick task in “kid”"],
      [
        { lastError: { at: NOW, message: "boom" } },
        "attention",
        "Failed in “kid”",
      ],
    ];
    for (const [state, tier, label] of gates) {
      const view = buildSessionInbox([
        session({ id: "root" }),
        child("kid", "root", state),
      ]);
      const card = [
        ...cards(view.needsYou),
        ...cards(view.active),
      ][0] as SessionInboxCard;
      expect(card.session.id).toBe("root");
      expect(card.tier).toBe(tier);
      expect(card.cluster?.bubbled?.session.id).toBe("kid");
      expect(
        sessionClusterBubbleLabel(
          card.cluster?.bubbled as SessionInboxCard,
          NOW,
        ),
      ).toBe(label);
    }
  });

  it("bubbles the most urgent child when several are waiting", () => {
    const view = buildSessionInbox([
      session({ id: "root" }),
      child("failed", "root", { lastError: { at: NOW, message: "boom" } }),
      child("asks", "root", { attention: "question" }),
    ]);
    expect(cards(view.needsYou)[0]?.cluster?.bubbled?.session.id).toBe("asks");
  });

  it("lets a cluster settle over a peer failure, which the settle acknowledges", () => {
    // Settling the cluster settles the peer with it, so its failure is exactly
    // what the Settle is for — as a Workflow Run's role failure never blocks
    // the run's Settle.
    const view = buildSessionInbox([
      session({ id: "root" }),
      child("kid", "root", { lastError: { at: NOW, message: "boom" } }),
    ]);
    expect(cards(view.active)[0]?.cluster?.bubbled?.session.id).toBe("kid");
    expect(cards(view.active)[0]?.settleBlocked).toBe(undefined);
  });

  it("blocks a cluster settle on a peer that is itself blocked, in its words", () => {
    // A running peer does not bubble, but it would be settled with the
    // cluster, so it refuses the cluster the way it refuses its own row.
    const view = buildSessionInbox([
      session({ id: "root" }),
      child("quiet", "root"),
      child("busy", "root", { isStreaming: true }),
      child("deep", "quiet", { queuedWork: true }),
    ]);
    const card = cards(view.active)[0] as SessionInboxCard;
    expect(card.cluster?.bubbled).toBe(undefined);
    expect(card.settleBlocked).toBe("it is still running.");
    // A folded peer's own row answers for what IT coordinates too: settling
    // "quiet" from the disclosure would shelve "deep", so "deep" refuses it.
    const rows = new Map(
      card.cluster?.children.map((c) => [c.session.id, c.settleBlocked]),
    );
    expect(rows.get("quiet")).toBe("work is queued behind it.");
    expect(rows.get("deep")).toBe("work is queued behind it.");
    expect(rows.get("busy")).toBe("it is still running.");
  });

  it("names the blocking peer in forest order, the order the server refuses in", () => {
    // The card's list puts the asking peer first (needs-you outranks working),
    // but the reason is read in the shared forest's order — list order — so
    // the disabled button and the server's refusal say the same thing.
    const rows = [
      session({ id: "root" }),
      child("busy", "root", { isStreaming: true }),
      child("asks", "root", { attention: "question" }),
    ];
    const card = cards(buildSessionInbox(rows).needsYou)[0] as SessionInboxCard;
    expect(card.cluster?.children[0]?.session.id).toBe("asks");
    expect(card.settleBlocked).toBe("it is still running.");
    expect(sessionSettleCascade("root", rows, null, {}).blocked).toBe(
      "it is still running.",
    );
  });

  it("answers the inspector and the optimistic settle with what the card folded", () => {
    // The surfaces that hold no built inbox read the same forest: the peers a
    // Settle shelves are the card's folded peers, and the reason it is refused
    // is the card's. A run's role on the spawn path belongs to the run.
    const rows = [
      session({ id: "root" }),
      child("kid", "root"),
      child("deep", "kid"),
      child("mine", "root", { spawnOwnership: "taken-over" }),
      child("shelved", "root", { settledAt: NOW - 1_000 }),
      child("role", "root"),
    ];
    const run: WorkflowRunSummary = {
      id: "7",
      taskId: "676",
      recipeId: "code-delivery",
      recipeVersion: 1,
      lifecycle: "active",
      limits: { maxIterations: 3, maxReviewPasses: 2 },
      createdAt: NOW - 3_600_000,
      updatedAt: NOW - 30_000,
    };
    const cards7: Record<string, WorkflowRunCard> = {
      "7": {
        runId: "7",
        phase: "implement",
        iterationsUsed: 1,
        nextAction: "Implement.",
        mergeDecisionReady: false,
        canRebaseAndReview: false,
        canRetry: false,
        canResume: true,
        coordinatorSessionId: "role",
      },
    };
    expect(sessionSettleCascade("root", rows, [run], cards7)).toEqual({
      peerIds: ["kid", "deep"],
    });
    expect(sessionSettleCascade("kid", rows, [run], cards7)).toEqual({
      peerIds: ["deep"],
    });
    expect(sessionSettleCascade("root", rows, null, {}).peerIds).toEqual([
      "kid",
      "role",
      "deep",
    ]);
    expect(
      sessionSettleCascade(
        "root",
        rows.map((row) =>
          row.id === "deep" ? { ...row, queuedWork: true } : row,
        ),
        null,
        {},
      ).blocked,
    ).toBe("work is queued behind it.");
    // Unsettle and a lone session: nothing besides the row itself.
    expect(sessionSettleCascade("mine", rows, null, {})).toEqual({
      peerIds: [],
    });
    // A run's role is no member — it folds nothing and shelves nothing — but
    // its OWN reason still refuses, so the inspector's Settle is disabled for
    // exactly what the server would refuse it with.
    const busyRole = rows.map((row) =>
      row.id === "role" ? { ...row, isStreaming: true } : row,
    );
    expect(sessionSettleCascade("role", busyRole, [run], cards7)).toEqual({
      peerIds: [],
      blocked: "it is still running.",
    });
    const askingRole = rows.map((row) =>
      row.id === "role" ? { ...row, attention: "question" as const } : row,
    );
    expect(
      sessionSettleCascade("role", askingRole, [run], cards7).blocked,
    ).toBe("it is waiting for your answer.");
  });

  it("does not lift the cluster for a folded child that is merely working", () => {
    const view = buildSessionInbox([
      session({ id: "root" }),
      child("kid", "root", { isStreaming: true }),
    ]);
    expect(cards(view.active)[0]?.tier).toBe("active");
    expect(cards(view.active)[0]?.cluster?.bubbled).toBe(undefined);
  });

  it("wakes a settled coordinator while a folded child needs a human", () => {
    const view = buildSessionInbox([
      session({ id: "root", settledAt: NOW - 5_000 }),
      child("kid", "root", { attention: "question" }),
    ]);
    expect(view.settled).toHaveLength(0);
    expect(cards(view.needsYou).map((card) => card.session.id)).toEqual([
      "root",
    ]);
    expect(cards(view.needsYou)[0]?.cluster?.bubbled?.session.id).toBe("kid");
    // Settling would settle the child with it, and the child's question
    // refuses that — in the same words the child's own row would use.
    expect(cards(view.needsYou)[0]?.settleBlocked).toBe(
      "it is waiting for your answer.",
    );
  });

  it("keeps its own reason when the coordinator itself cannot be settled", () => {
    const view = buildSessionInbox([
      session({ id: "root", isStreaming: true }),
      child("kid", "root", { attention: "question" }),
    ]);
    expect(cards(view.needsYou)[0]?.settleBlocked).toBe("it is still running.");
  });

  it("wakes a settled coordinator for a folded peer that failed", () => {
    const view = buildSessionInbox([
      session({ id: "root", settledAt: NOW - 5_000 }),
      child("failed", "root", { lastError: { at: NOW, message: "boom" } }),
      child("quiet", "root"),
    ]);
    expect(view.settled).toHaveLength(0);
    expect(topLevel(view)).toEqual(["root"]);
    expect(cards(view.active)[0]?.cluster?.bubbled?.session.id).toBe("failed");
    // Settling again settles the failed peer with it, acknowledging the
    // failure — so the woken cluster offers the Settle that puts it back down.
    expect(cards(view.active)[0]?.settleBlocked).toBe(undefined);
  });

  it("keeps a settled coordinator a card while live peers hang under it", () => {
    // A Settle from the card shelves the peers too; these are the peers that
    // came back on their own (an outcome woke them) or were spawned after.
    const view = buildSessionInbox([
      session({ id: "root", settledAt: NOW - 5_000 }),
      child("quiet", "root"),
      child("busy", "root", { isStreaming: true }),
      child("deep", "quiet"),
    ]);
    // The live work stays under the session that started it rather than
    // surfacing as cards of its own, and nothing live is on the shelf.
    expect(view.settled).toEqual([]);
    expect(topLevel(view)).toEqual(["root"]);
    expect(
      cards(view.active)[0]?.cluster?.children.map((c) => c.session.id),
    ).toEqual(["busy", "quiet", "deep"]);
  });

  it("puts a settled coordinator with nothing live under it on the shelf", () => {
    const view = buildSessionInbox([
      session({ id: "root", settledAt: NOW - 5_000 }),
      child("done", "root", { settledAt: NOW - 5_000 }),
    ]);
    expect(view.settled.map((s) => s.id).sort()).toEqual(["done", "root"]);
    expect(topLevel(view)).toEqual([]);
  });

  it("treats an unacknowledged failed outcome as a failure", () => {
    // The next run cleared `lastError`, but the durable outcome keeps the row
    // failed. A summary that called this nothing would hide the one thing the
    // cluster exists to surface.
    const view = buildSessionInbox([
      session({ id: "root" }),
      child("kid", "root", {
        outcomeAttention: {
          revision: 4,
          settledRevision: 3,
          kind: "failed",
          at: NOW - 10_000,
        },
      }),
    ]);
    const card = cards(view.active)[0] as SessionInboxCard;
    expect(card.cluster?.children[0]?.status).toBe("failed");
    expect(card.cluster?.counts.failed).toBe(1);
    expect(card.cluster?.bubbled?.session.id).toBe("kid");
    expect(card.tier).toBe("attention");
    expect(card.settleBlocked).toBe(undefined);
  });

  it("keeps a settled child in the tree while what it spawned is live", () => {
    const view = buildSessionInbox([
      session({ id: "root" }),
      child("mid", "root", { settledAt: NOW - 5_000 }),
      child("leaf", "mid"),
    ]);
    expect(view.settled).toEqual([]);
    expect(topLevel(view)).toEqual(["root"]);
    expect(
      cards(view.active)[0]?.cluster?.children.map((c) => [
        c.session.id,
        c.depth,
      ]),
    ).toEqual([
      ["mid", 1],
      ["leaf", 2],
    ]);
  });

  it("keys the card on what the cluster says, and on nothing else about it", () => {
    const rows = [
      session({ id: "root" }),
      child("kid", "root", { attention: "question" }),
      child("other", "root"),
    ];
    const cardOf = (sessions: SessionListItem[]) => {
      const view = buildSessionInbox(sessions);
      return [
        ...cards(view.needsYou),
        ...cards(view.active),
      ][0] as SessionInboxCard;
    };
    const before = sessionCardKey(cardOf(rows), NOW);
    // A folded child renaming itself under a collapsed summary changes nothing
    // the card renders.
    const renamed = rows.map((row) =>
      row.id === "other" ? { ...row, title: "new name" } : row,
    );
    expect(sessionCardKey(cardOf(renamed), NOW)).toBe(before);
    // A folded child that starts running does change the summary.
    const started = rows.map((row) =>
      row.id === "other" ? { ...row, isStreaming: true } : row,
    );
    expect(sessionCardKey(cardOf(started), NOW)).not.toBe(before);
    // As does the bubbled child asking for something else.
    const answered = rows.map((row) =>
      row.id === "kid" ? session({ ...row, attention: "approval" }) : row,
    );
    expect(sessionCardKey(cardOf(answered), NOW)).not.toBe(before);
  });

  it("compares a cluster child row on its card alone", () => {
    const card = (extra: Partial<SessionListItem>): SessionInboxCard => ({
      session: session({ id: "kid", ...extra }),
      status: "quiet",
      tier: "active",
    });
    const onOpen = () => {};
    expect(
      sameClusterChildProps(
        { card: card({}), now: NOW, onOpen },
        { card: card({}), now: NOW, onOpen },
      ),
    ).toBe(true);
    expect(
      sameClusterChildProps(
        { card: card({}), now: NOW, onOpen },
        { card: card({ title: "moved" }), now: NOW, onOpen },
      ),
    ).toBe(false);
    expect(
      sameClusterChildProps(
        { card: card({}), now: NOW, onOpen },
        { card: card({}), now: NOW, onOpen: () => {} },
      ),
    ).toBe(false);
  });

  it("offers a peer FAILURE for dismissal, and a human decision never", () => {
    const bubbleOf = (rows: SessionListItem[]) => {
      const view = buildSessionInbox(rows);
      const card = [
        ...cards(view.needsYou),
        ...cards(view.active),
      ][0] as SessionInboxCard;
      return card.cluster?.bubbled as SessionInboxCard;
    };
    expect(
      clusterBubbleDismissible(
        bubbleOf([
          session({ id: "root" }),
          child("kid", "root", { lastError: { at: NOW, message: "boom" } }),
        ]),
      ),
    ).toBe(true);
    // Answering is the only way through a question: settling it is refused
    // everywhere, so the card offers nothing that would be.
    expect(
      clusterBubbleDismissible(
        bubbleOf([
          session({ id: "root" }),
          child("kid", "root", { attention: "question" }),
        ]),
      ),
    ).toBe(false);
    // A failure whose peer is blocked for a reason of its own, likewise.
    expect(
      clusterBubbleDismissible(
        bubbleOf([
          session({ id: "root" }),
          child("kid", "root", {
            lastError: { at: NOW, message: "boom" },
            queuedWork: true,
          }),
        ]),
      ),
    ).toBe(false);
  });

  it("takes a dismissed peer failure out of the cluster entirely", () => {
    const rows = [
      session({ id: "root" }),
      child("kid", "root", { lastError: { at: NOW, message: "boom" } }),
    ];
    const settled = rows.map((row) =>
      row.id === "kid" ? { ...row, settledAt: NOW } : row,
    );
    const view = buildSessionInbox(settled);
    // Dismissing IS the peer's settle: it lands on the shelf, and the
    // coordinator goes back to being a card with nothing folded into it.
    expect(view.settled.map((row) => row.id)).toEqual(["kid"]);
    const card = cards(view.active)[0] as SessionInboxCard;
    expect(card.session.id).toBe("root");
    expect(card.cluster).toBe(undefined);
    expect(card.settleBlocked).toBe(undefined);
  });

  it("says how many sessions a cluster holds, leaving out what is zero", () => {
    const counts = (over: Partial<SessionClusterCounts>) => ({
      total: 1,
      working: 0,
      running: 0,
      jobs: 0,
      waiting: 0,
      failed: 0,
      ...over,
    });
    expect(sessionClusterSummary(counts({}))).toBe("1 session");
    expect(
      sessionClusterSummary(counts({ total: 3, working: 3, running: 2 })),
    ).toBe("3 sessions · 2 running");
    expect(sessionClusterSummary(counts({ total: 2, jobs: 1 }))).toBe(
      "2 sessions · 1 job",
    );
    expect(clusterLiveSummary(counts({ jobs: 0 }))).toBe("");
    // Busy with neither a turn nor a job (a retained host): the spinner turns,
    // so the words say why.
    expect(clusterLiveSummary(counts({ working: 1 }))).toBe("1 working");
    expect(clusterLiveSummary(counts({ working: 2, running: 1 }))).toBe(
      "1 running",
    );
  });
});

describe("formal Workflow Runs", () => {
  const run = (
    partial: Partial<WorkflowRunSummary> & { id: string },
  ): WorkflowRunSummary => ({
    taskId: "676",
    recipeId: "code-delivery",
    recipeVersion: 1,
    lifecycle: "active",
    limits: { maxIterations: 3, maxReviewPasses: 2 },
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 30_000,
    ...partial,
  });

  const runCard = (
    partial: Partial<WorkflowRunCard> & { runId: string },
  ): WorkflowRunCard => ({
    phase: "review",
    iterationsUsed: 1,
    nextAction: "Start the second review pass.",
    mergeDecisionReady: false,
    canRebaseAndReview: false,
    canRetry: false,
    canResume: true,
    ...partial,
  });

  /** A run with a coordinator, an implementer and two review passes. */
  const staffedCard = (runId: string): WorkflowRunCard =>
    runCard({
      runId,
      coordinatorSessionId: "coord",
      implementerSessionId: "impl",
      reviewerSessions: [
        { pass: 1, sessionId: "rev-1" },
        { pass: 2, sessionId: "rev-2" },
      ],
    });

  const roleSessions = () => [
    session({ id: "coord", title: "Coordinator" }),
    session({ id: "impl", title: "Implementer", isStreaming: true }),
    session({ id: "rev-1", title: "Reviewer pass 1" }),
    session({ id: "rev-2", title: "Reviewer pass 2", isStreaming: true }),
  ];

  const runItems = (view: ReturnType<typeof buildSessionInbox>) =>
    [...view.needsYou, ...view.active].flatMap((item) =>
      item.kind === "run" ? [item] : [],
    );

  it("takes the run's pull request from the role session that owns its card", () => {
    const withPr = (ci: "pending" | "failure") =>
      runItems(
        buildSessionInbox(
          roleSessions().map((row) =>
            row.id === "impl"
              ? {
                  ...row,
                  pullRequest: {
                    status: "open" as const,
                    number: 7,
                    ci: { state: ci, total: 3 },
                  },
                }
              : row,
          ),
          {
            workflowRuns: [run({ id: "r1" })],
            workflowCards: {
              r1: {
                ...staffedCard("r1"),
                pullRequest: {
                  cardId: "c",
                  sessionId: "impl",
                  number: 7,
                  url: "https://example.invalid/pr/7",
                },
              },
            },
          },
        ),
      )[0] as WorkflowRunInboxItem;
    expect(workflowRunPullRequestSession(withPr("pending"))?.id).toBe("impl");
    // A CI poll on the owning session repaints the run item.
    expect(workflowRunItemKey(withPr("pending"), NOW)).not.toBe(
      workflowRunItemKey(withPr("failure"), NOW),
    );
    // A run whose card names no pull request shows none.
    const plain = runItems(
      buildSessionInbox(roleSessions(), {
        workflowRuns: [run({ id: "r1" })],
        workflowCards: { r1: staffedCard("r1") },
      }),
    )[0] as WorkflowRunInboxItem;
    expect(workflowRunPullRequestSession(plain)).toBeUndefined();
  });

  it("shows one item per run however many sessions it owns", () => {
    const view = buildSessionInbox(roleSessions(), {
      workflowRuns: [run({ id: "r1" })],
      workflowCards: { r1: staffedCard("r1") },
    });
    expect(runItems(view)).toHaveLength(1);
    expect(cards(view.active)).toEqual([]);
    expect(cards(view.needsYou)).toEqual([]);
    expect(runItems(view)[0]?.counts).toMatchObject({
      total: 4,
      working: 2,
      waiting: 0,
      failed: 0,
    });
  });

  it("puts a paused run in Needs you with its actionable reason", () => {
    const view = buildSessionInbox(roleSessions(), {
      workflowRuns: [
        run({
          id: "r1",
          lifecycle: "paused",
          lifecycleReason: "Merge decision: the pull request is green.",
        }),
      ],
      workflowCards: { r1: staffedCard("r1") },
    });
    const item = view.needsYou[0];
    expect(item?.kind).toBe("run");
    expect(item && item.kind === "run" && workflowRunDetail(item)).toBe(
      "Merge decision: the pull request is green.",
    );
    expect(item && item.kind === "run" && workflowRunBadge(item).label).toBe(
      "Paused",
    );
  });

  it("puts an active run in the working list, next action and all", () => {
    const view = buildSessionInbox(roleSessions(), {
      workflowRuns: [run({ id: "r1" })],
      workflowCards: { r1: staffedCard("r1") },
    });
    expect(view.needsYou).toEqual([]);
    const item = runItems(view)[0] as WorkflowRunInboxItem;
    expect(item.tier).toBe("working");
    expect(workflowRunDetail(item)).toBe("Start the second review pass.");
    expect(workflowRunPhaseLine(item)).toBe("Review");
  });

  it("names the gate a stopped run reached instead of the machine's word", () => {
    const view = buildSessionInbox([], {
      workflowRuns: [
        run({ id: "r1", lifecycle: "paused", lifecycleReason: "Ceiling." }),
      ],
      workflowCards: {
        r1: runCard({
          runId: "r1",
          phase: "ceiling-decision",
          ceilingDecision: {
            blocked: "review-passes",
            wanted: "another review pass",
            allowedChoices: ["raise", "cancel"],
            ceilings: { maxIterations: 3, maxReviewPasses: 2 },
            spent: { iterations: 1, reviewPasses: 2, sessions: 4 },
            headCarriesDiscoveryReview: false,
            suggestedRaise: 2,
          },
        }),
      },
    });
    const item = runItems(view)[0] as WorkflowRunInboxItem;
    expect(workflowRunBadge(item).label).toBe("Decide");
  });

  it("never hides a session whose run has no card projection", () => {
    const view = buildSessionInbox(roleSessions(), {
      // The recipe is one this browser has no projection for: the run is still
      // shown, and not one of its sessions disappears.
      workflowRuns: [run({ id: "r1", recipeId: "some-future-recipe" })],
      workflowCards: {},
    });
    expect(runItems(view)).toHaveLength(1);
    expect(
      cards(view.active)
        .map((card) => card.session.id)
        .sort(),
    ).toEqual(["coord", "impl", "rev-1", "rev-2"]);
    expect(runItems(view)[0]?.counts.total).toBe(0);
  });

  it("never resurrects a historical terminal run that carries no cursor", () => {
    for (const lifecycle of ["completed", "cancelled"] as const) {
      const view = buildSessionInbox(roleSessions(), {
        workflowRuns: [run({ id: "r1", lifecycle })],
        workflowCards: { r1: staffedCard("r1") },
      });
      expect(runItems(view)).toEqual([]);
      expect(cards(view.active)).toHaveLength(4);
    }
  });

  /* -------------- across the terminal boundary ([Task-677]) -------------- */

  const attention = (
    kind: WorkflowRunAttention["kind"],
    revision = 1,
    settledRevision = 0,
  ): WorkflowRunAttention => ({
    revision,
    settledRevision,
    kind,
    at: NOW - 10_000,
  });

  /** The roles as they stand once the run has ended: idle, outcomes pending. */
  const endedRoleSessions = () => [
    session({
      id: "coord",
      title: "Coordinator",
      outcomeAttention: {
        revision: 3,
        settledRevision: 2,
        kind: "completed",
        at: NOW - 20_000,
      },
    }),
    session({
      id: "impl",
      title: "Implementer",
      outcomeAttention: {
        revision: 1,
        settledRevision: 0,
        kind: "completed",
        at: NOW - 40_000,
      },
    }),
    session({ id: "rev-1", title: "Reviewer pass 1" }),
    session({
      id: "rev-2",
      title: "Reviewer pass 2",
      outcomeAttention: {
        revision: 1,
        settledRevision: 0,
        kind: "failed",
        at: NOW - 30_000,
      },
    }),
  ];

  it("keeps a completed, unsettled run as ONE Needs-you item stating its outcome", () => {
    const view = buildSessionInbox(endedRoleSessions(), {
      workflowRuns: [
        run({
          id: "r1",
          lifecycle: "completed",
          endedAt: NOW - 10_000,
          attention: attention("completed"),
        }),
      ],
      workflowCards: {
        r1: {
          ...staffedCard("r1"),
          phase: "merge",
          pullRequest: {
            cardId: "pr-1",
            sessionId: "coord",
            number: 286,
            url: "https://example.test/pr/286",
          },
        },
      },
      taskTitles: new Map([["676", "Show live Workflow Runs"]]),
    });
    expect(view.needsYou).toHaveLength(1);
    expect(view.active).toEqual([]);
    expect(view.settled).toEqual([]);
    const item = view.needsYou[0] as WorkflowRunInboxItem;
    expect(item.kind).toBe("run");
    expect(item.tier).toBe("needs-you");
    expect(workflowRunBadge(item)).toEqual({
      kind: "merged",
      label: "Merged",
      tone: "success",
    });
    expect(workflowRunDetail(item)).toBe("Pull request #286 merged.");
    expect(workflowRunPhaseLine(item)).toBe("Merge decision");
    // Every role is folded — none of the four is a card, whatever its own
    // pending outcome says — and the item still counts the failure it holds.
    expect(item.counts).toMatchObject({
      total: 4,
      working: 0,
      waiting: 0,
      failed: 1,
    });
    expect(item.bubbled?.session.id).toBe("rev-2");
    expect(workflowRunSettleOffered(item)).toBe(true);
    expect(item.settleBlocked).toBeUndefined();
  });

  it("states a cancelled run's reason, and a completion without a pull request plainly", () => {
    const cancelled = runItems(
      buildSessionInbox([], {
        workflowRuns: [
          run({
            id: "r1",
            lifecycle: "cancelled",
            lifecycleReason: "CI never went green.",
            attention: attention("cancelled", 2),
          }),
        ],
        workflowCards: { r1: staffedCard("r1") },
      }),
    )[0] as WorkflowRunInboxItem;
    expect(workflowRunBadge(cancelled)).toEqual({
      kind: "cancelled",
      label: "Cancelled",
      tone: "warning",
    });
    expect(workflowRunDetail(cancelled)).toBe("CI never went green.");

    const completed = runItems(
      buildSessionInbox([], {
        workflowRuns: [
          run({
            id: "r2",
            lifecycle: "completed",
            attention: attention("completed"),
          }),
        ],
        workflowCards: {},
      }),
    )[0] as WorkflowRunInboxItem;
    expect(workflowRunBadge(completed).label).toBe("Completed");
    expect(workflowRunDetail(completed)).toBe("Run complete.");
  });

  it("releases the run and its sessions once the run is settled", () => {
    const view = buildSessionInbox(endedRoleSessions(), {
      workflowRuns: [
        run({
          id: "r1",
          lifecycle: "completed",
          attention: attention("completed", 1, 1),
        }),
      ],
      workflowCards: { r1: staffedCard("r1") },
    });
    expect(runItems(view)).toEqual([]);
    // Today's behaviour again: each session is exactly the row it would be on
    // its own — the ones with a pending outcome are cards, the idle one quiet.
    expect(
      cards(view.active)
        .map((card) => card.session.id)
        .sort(),
    ).toEqual(["coord", "impl", "rev-1", "rev-2"]);
  });

  it("shows a terminal run whose projection is absent from its summary, hiding no session", () => {
    const view = buildSessionInbox(endedRoleSessions(), {
      workflowRuns: [
        run({
          id: "r1",
          lifecycle: "cancelled",
          recipeId: "some-future-recipe",
          attention: attention("cancelled"),
        }),
      ],
      workflowCards: {},
    });
    expect(runItems(view)).toHaveLength(1);
    expect(runItems(view)[0]?.counts.total).toBe(0);
    expect(
      workflowRunSettleOffered(runItems(view)[0] as WorkflowRunInboxItem),
    ).toBe(true);
    expect(cards(view.active)).toHaveLength(4);
  });

  it("offers Settle on a failure pause, and parks the run once it is acknowledged", () => {
    const paused = run({
      id: "r1",
      lifecycle: "paused",
      lifecycleReason: "CI repair failed: the rebase left conflicts.",
      attention: attention("paused"),
    });
    const awake = buildSessionInbox(endedRoleSessions(), {
      workflowRuns: [paused],
      workflowCards: { r1: staffedCard("r1") },
    });
    const item = awake.needsYou[0] as WorkflowRunInboxItem;
    expect(item.kind).toBe("run");
    expect(workflowRunSettleOffered(item)).toBe(true);
    expect(item.settleBlocked).toBeUndefined();

    // A pause does not abort a running turn, and a role still running cannot
    // be put down: the run's Settle says so in that role's own wording.
    const running = buildSessionInbox(roleSessions(), {
      workflowRuns: [paused],
      workflowCards: { r1: staffedCard("r1") },
    });
    expect((running.needsYou[0] as WorkflowRunInboxItem).settleBlocked).toBe(
      "it is still running.",
    );
    expect(workflowRunDetail(item)).toBe(
      "CI repair failed: the rebase left conflicts.",
    );

    const parked = buildSessionInbox(roleSessions(), {
      workflowRuns: [{ ...paused, attention: attention("paused", 1, 1) }],
      workflowCards: { r1: staffedCard("r1") },
    });
    expect(runItems(parked)).toEqual([]);
    expect(cards(parked.active)).toHaveLength(4);
  });

  it("refuses Settle while the run waits on an unresolved user decision, and keeps it", () => {
    const gate = runCard({
      runId: "r1",
      phase: "ceiling-decision",
      ceilingDecision: {
        blocked: "review-passes",
        wanted: "another review pass",
        allowedChoices: ["raise", "cancel"],
        ceilings: { maxIterations: 3, maxReviewPasses: 2 },
        spent: { iterations: 1, reviewPasses: 2, sessions: 4 },
        headCarriesDiscoveryReview: false,
        suggestedRaise: 2,
      },
    });
    const ceiling = runItems(
      buildSessionInbox([], {
        workflowRuns: [
          run({
            id: "r1",
            lifecycle: "paused",
            attention: attention("paused"),
          }),
        ],
        workflowCards: { r1: gate },
      }),
    )[0] as WorkflowRunInboxItem;
    expect(ceiling.settleBlocked).toBe(
      "it is waiting for your decision at its ceiling.",
    );

    const merge = runItems(
      buildSessionInbox([], {
        workflowRuns: [
          // Acknowledged already — and still an item, because a gate is
          // work that cannot proceed without an answer.
          run({
            id: "r1",
            lifecycle: "paused",
            attention: attention("paused", 1, 1),
          }),
        ],
        workflowCards: {
          r1: runCard({
            runId: "r1",
            phase: "merge",
            mergeDecisionReady: true,
          }),
        },
      }),
    )[0] as WorkflowRunInboxItem;
    expect(merge.settleBlocked).toBe("it is waiting for your merge decision.");
    expect(workflowRunSettleOffered(merge)).toBe(false);

    const cancelling = runItems(
      buildSessionInbox([], {
        workflowRuns: [
          run({
            id: "r1",
            lifecycle: "paused",
            attention: attention("paused"),
          }),
        ],
        workflowCards: { r1: runCard({ runId: "r1", cancelRequested: true }) },
      }),
    )[0] as WorkflowRunInboxItem;
    expect(cancelling.settleBlocked).toBe("it is being cancelled.");
  });

  it("blocks Settle with the role's own wording while a role waits on a human", () => {
    const view = buildSessionInbox(
      [
        session({ id: "coord" }),
        session({ id: "impl", attention: "question", title: "Implementer" }),
      ],
      {
        workflowRuns: [
          run({
            id: "r1",
            lifecycle: "completed",
            attention: attention("completed"),
          }),
        ],
        workflowCards: {
          r1: runCard({
            runId: "r1",
            coordinatorSessionId: "coord",
            implementerSessionId: "impl",
          }),
        },
      },
    );
    const item = view.needsYou[0] as WorkflowRunInboxItem;
    expect(item.settleBlocked).toBe("it is waiting for your answer.");
    // A failed role never blocks: acknowledging it is what the Settle is for.
    const failed = runItems(
      buildSessionInbox(endedRoleSessions(), {
        workflowRuns: [
          run({
            id: "r1",
            lifecycle: "completed",
            attention: attention("completed"),
          }),
        ],
        workflowCards: { r1: staffedCard("r1") },
      }),
    )[0] as WorkflowRunInboxItem;
    expect(failed.counts.failed).toBe(1);
    expect(failed.settleBlocked).toBeUndefined();
  });

  it("keeps an active run live without offering a Settle that would acknowledge nothing", () => {
    const item = runItems(
      buildSessionInbox(roleSessions(), {
        workflowRuns: [run({ id: "r1", attention: attention("paused", 1, 1) })],
        workflowCards: { r1: staffedCard("r1") },
      }),
    )[0] as WorkflowRunInboxItem;
    expect(item.tier).toBe("working");
    expect(workflowRunSettleOffered(item)).toBe(false);
    // Resumed without settling the pause: the stale pause is still
    // acknowledgeable, and the run stays live rather than climbing into
    // Needs you for an event the user already moved past.
    const resumed = runItems(
      buildSessionInbox(roleSessions(), {
        workflowRuns: [run({ id: "r1", attention: attention("paused") })],
        workflowCards: { r1: staffedCard("r1") },
      }),
    )[0] as WorkflowRunInboxItem;
    expect(resumed.tier).toBe("working");
    expect(workflowRunSettleOffered(resumed)).toBe(true);
  });

  it("folds an ended run's roles even beside an implicit cluster, and neither touches the other", () => {
    const view = buildSessionInbox(
      [
        ...endedRoleSessions(),
        session({ id: "root", isStreaming: true }),
        session({
          id: "peer",
          spawnedBySessionId: "root",
          spawnOwnership: "coordinator",
          attention: "question",
        }),
      ],
      {
        workflowRuns: [
          run({
            id: "r1",
            lifecycle: "completed",
            attention: attention("completed"),
          }),
        ],
        workflowCards: { r1: staffedCard("r1") },
      },
    );
    expect(runItems(view)).toHaveLength(1);
    expect(view.needsYou.map(inboxItemId).sort()).toEqual(["root", "run:r1"]);
    expect(cards(view.needsYou)[0]?.cluster?.counts.total).toBe(1);
    expect(view.active).toEqual([]);
  });

  it("repaints the item for a Settle and for a new revision, and for nothing else about attention", () => {
    const item = (partial: Partial<WorkflowRunSummary>): WorkflowRunInboxItem =>
      runItems(
        buildSessionInbox([], {
          workflowRuns: [run({ id: "r1", lifecycle: "completed", ...partial })],
          workflowCards: { r1: runCard({ runId: "r1" }) },
        }),
      )[0] as WorkflowRunInboxItem;
    const awake = workflowRunItemKey(
      item({ attention: attention("completed", 2) }),
      NOW,
    );
    expect(
      workflowRunItemKey(item({ attention: attention("completed", 2) }), NOW),
    ).toBe(awake);
    expect(
      workflowRunItemKey(item({ attention: attention("completed", 3) }), NOW),
    ).not.toBe(awake);
    // The `at` of the revision is not on the card, so it is not on the key.
    expect(
      workflowRunItemKey(
        item({ attention: { ...attention("completed", 2), at: NOW - 1 } }),
        NOW,
      ),
    ).toBe(awake);
  });

  it("leaves implicit clusters beside a formal run untouched", () => {
    const view = buildSessionInbox(
      [
        ...roleSessions(),
        session({ id: "root", isStreaming: true }),
        session({
          id: "peer",
          spawnedBySessionId: "root",
          spawnOwnership: "coordinator",
        }),
      ],
      {
        workflowRuns: [run({ id: "r1" })],
        workflowCards: { r1: staffedCard("r1") },
      },
    );
    expect(runItems(view)).toHaveLength(1);
    expect(cards(view.active).map((card) => card.session.id)).toEqual(["root"]);
    expect(cards(view.active)[0]?.cluster?.counts.total).toBe(1);
  });

  it("lifts the run when one of its sessions is waiting on the user", () => {
    const view = buildSessionInbox(
      [
        session({ id: "coord" }),
        session({ id: "impl", attention: "question", title: "Implementer" }),
      ],
      {
        workflowRuns: [run({ id: "r1" })],
        workflowCards: {
          r1: runCard({
            runId: "r1",
            coordinatorSessionId: "coord",
            implementerSessionId: "impl",
          }),
        },
      },
    );
    const item = view.needsYou[0];
    expect(item?.kind).toBe("run");
    expect(item && item.kind === "run" && item.bubbled?.session.id).toBe(
      "impl",
    );
    expect(item && item.kind === "run" && item.counts.waiting).toBe(1);
  });

  it("lists every suppressed role session under the item", () => {
    const view = buildSessionInbox(roleSessions(), {
      workflowRuns: [run({ id: "r1" })],
      workflowCards: { r1: staffedCard("r1") },
    });
    const item = runItems(view)[0] as WorkflowRunInboxItem;
    // The roles are off the top level and reachable only through the item, so
    // the disclosure is what has to reach all of them.
    expect(item.roles.map((role) => role.session.id)).toContain("rev-2");
    expect(item.roles).toHaveLength(4);
  });

  it("keeps a run's own sessions off the Settled shelf while it lives", () => {
    const view = buildSessionInbox(
      [
        session({ id: "coord", settledAt: NOW - 10_000 }),
        session({ id: "impl" }),
      ],
      {
        workflowRuns: [run({ id: "r1" })],
        workflowCards: {
          r1: runCard({
            runId: "r1",
            coordinatorSessionId: "coord",
            implementerSessionId: "impl",
          }),
        },
      },
    );
    expect(view.settled).toEqual([]);
    expect(view.settledTotal).toBe(0);
    expect(runItems(view)[0]?.counts.total).toBe(2);
  });

  it("orders runs among the cards by when each last moved", () => {
    const view = buildSessionInbox(
      [session({ id: "older", updatedAt: NOW - 600_000 })],
      {
        workflowRuns: [run({ id: "r1", updatedAt: NOW - 1_000 })],
        workflowCards: { r1: runCard({ runId: "r1" }) },
      },
    );
    expect(view.active.map(inboxItemId)).toEqual(["run:r1", "older"]);
  });

  it("keys a run item on what it renders, and on nothing else", () => {
    const item = (
      partial: Partial<WorkflowRunSummary> = {},
    ): WorkflowRunInboxItem =>
      runItems(
        buildSessionInbox([], {
          workflowRuns: [run({ id: "r1", ...partial })],
          workflowCards: { r1: runCard({ runId: "r1" }) },
        }),
      )[0] as WorkflowRunInboxItem;
    // A field the card does not render moves nothing.
    expect(workflowRunItemKey(item(), NOW)).toBe(
      workflowRunItemKey(item({ projectId: "pa" }), NOW),
    );
    expect(workflowRunItemKey(item(), NOW)).not.toBe(
      workflowRunItemKey(
        item({ lifecycle: "paused", lifecycleReason: "x" }),
        NOW,
      ),
    );
    const onOpen = () => {};
    expect(
      sameWorkflowRunItemProps(
        { item: item(), now: NOW, onOpen },
        { item: item(), now: NOW, onOpen },
      ),
    ).toBe(true);
    expect(
      sameWorkflowRunItemProps(
        { item: item(), now: NOW, onOpen },
        { item: item(), now: NOW, onOpen: () => {} },
      ),
    ).toBe(false);
  });

  it("reads membership from ids alone, never from a role-like title", () => {
    const view = buildSessionInbox(
      [
        session({ id: "impl", title: "Reviewer for the workflow run" }),
        session({ id: "stranger", title: "reviewer" }),
      ],
      {
        workflowRuns: [run({ id: "r1" })],
        workflowCards: {
          r1: runCard({ runId: "r1", implementerSessionId: "impl" }),
        },
      },
    );
    expect(cards(view.active).map((card) => card.session.id)).toEqual([
      "stranger",
    ]);
    expect(runItems(view)[0]?.counts.total).toBe(1);
  });

  it("says how many sessions a run holds, leaving out what is zero", () => {
    const counts = (over: Partial<SessionClusterCounts>) => ({
      total: 1,
      working: 0,
      running: 0,
      jobs: 0,
      waiting: 0,
      failed: 0,
      ...over,
    });
    expect(workflowRunRolesSummary(counts({}))).toBe("1 workflow session");
    expect(
      workflowRunRolesSummary(
        counts({ total: 5, working: 2, running: 2, waiting: 1, failed: 1 }),
      ),
    ).toBe("5 workflow sessions · 2 running · 1 waiting · 1 failed");
  });
});

describe("spawnedSessionsView", () => {
  const peer = (
    id: string,
    parent: string,
    extra: Partial<SessionListItem> = {},
  ): SessionListItem =>
    session({
      id,
      spawnedBySessionId: parent,
      spawnOwnership: "coordinator",
      ...extra,
    });

  const view = (sessions: SessionListItem[], includeSettled = false) =>
    spawnedSessionsView({ sessions, coordinatorId: "root", includeSettled });

  it("takes the peers of one session, newest activity first", () => {
    const shaped = view([
      session({ id: "root" }),
      session({ id: "stranger" }),
      peer("quiet", "root", { updatedAt: NOW - 30_000 }),
      peer("working", "root", { isStreaming: true, updatedAt: NOW - 1_000 }),
      peer("asking", "root", {
        attention: "question",
        updatedAt: NOW - 60_000,
      }),
      peer("elsewhere", "other"),
    ]);
    // NOT the inbox's tier order: the strip reads as "what just happened among
    // my peers", so the one that asked a minute ago sits under the one still
    // streaming and the one that went quiet since. The tiering is stated on
    // the collapsed line instead — the counts, and the bubbled peer below.
    expect(shaped.rows.map((card) => card.session.id)).toEqual([
      "working",
      "quiet",
      "asking",
    ]);
    expect(shaped.bubbled?.session.id).toBe("asking");
    expect(shaped.counts).toEqual({
      total: 3,
      working: 1,
      running: 1,
      jobs: 0,
      waiting: 1,
      failed: 0,
    });
    expect(shaped.settled).toBe(0);
  });

  it("walks every depth, whoever owns the edge, and draws it as a tree", () => {
    const shaped = view([
      session({ id: "root" }),
      peer("impl", "root", { updatedAt: NOW - 50_000 }),
      peer("rev", "impl", { updatedAt: NOW - 1_000, isStreaming: true }),
      // A peer the user took over still started what it spawned in turn.
      peer("mine", "root", {
        spawnOwnership: "taken-over",
        updatedAt: NOW - 40_000,
      }),
      peer("deep", "mine", { updatedAt: NOW - 30_000 }),
    ]);
    expect(shaped.rows.map((c) => [c.session.id, c.depth])).toEqual([
      ["mine", 1],
      ["deep", 2],
      ["impl", 1],
      ["rev", 2],
    ]);
    expect(shaped.counts).toMatchObject({ total: 4, running: 1 });
    expect(
      shaped.rows.find((c) => c.session.id === "impl")?.peers,
    ).toMatchObject({ total: 1, running: 1 });
  });

  it("keeps settled peers out unless asked, but never cuts live work loose", () => {
    const sessions = [
      session({ id: "root" }),
      peer("done", "root", { settledAt: NOW - 5_000 }),
      peer("done-deep", "done", { settledAt: NOW - 5_000 }),
      // Settled, but it spawned something still live: it stays as the branch
      // that live peer hangs from.
      peer("mid", "root", { settledAt: NOW - 5_000 }),
      peer("live", "mid", { isStreaming: true }),
    ];
    const live = view(sessions);
    expect(live.rows.map((c) => [c.session.id, c.depth])).toEqual([
      ["mid", 1],
      ["live", 2],
    ]);
    expect(live.settled).toBe(2);
    expect(live.settledShown).toBe(false);
    expect(spawnedSessionsSummary(live)).toBe(
      "2 sessions · 1 running · 2 settled",
    );
    const all = view(sessions, true);
    expect(all.rows.map((c) => c.session.id).sort()).toEqual([
      "done",
      "done-deep",
      "live",
      "mid",
    ]);
    // The counts stay about what is live, whatever the list shows.
    expect(all.counts.total).toBe(2);
    expect(spawnedSessionsKey(all, true)).not.toBe(
      spawnedSessionsKey(live, true),
    );
  });

  it("walks a spawn cycle once", () => {
    const shaped = view([
      session({ id: "root", spawnedBySessionId: "b" }),
      peer("a", "root"),
      peer("b", "a"),
    ]);
    expect(shaped.rows.map((c) => c.session.id)).toEqual(["a", "b"]);
  });

  it("keeps a peer the user took over — it is still one this chat started", () => {
    const shaped = view([
      session({ id: "root" }),
      peer("mine", "root", { spawnOwnership: "taken-over" }),
      peer("unknown-edge", "root", { spawnOwnership: "unknown" }),
    ]);
    expect(shaped.rows.map((card) => card.session.id).sort()).toEqual([
      "mine",
      "unknown-edge",
    ]);
  });

  it("leaves out archived peers and the session's own row", () => {
    const shaped = view([
      session({ id: "root", spawnedBySessionId: "root" }),
      peer("put-away", "root", { archived: true }),
      peer("live", "root"),
    ]);
    expect(shaped.rows.map((card) => card.session.id)).toEqual(["live"]);
    expect(shaped.counts.total).toBe(1);
  });

  it("names the peer that needs the user", () => {
    const shaped = view([
      session({ id: "root" }),
      peer("a", "root", { isStreaming: true }),
      peer("b", "root", { isStreaming: true }),
      peer("c", "root", {
        title: "Reviewer",
        outcomeAttention: {
          kind: "failed",
          revision: 3,
          settledRevision: 2,
          at: NOW - 1_000,
        },
      }),
    ]);
    expect(shaped.rows).toHaveLength(3);
    expect(shaped.counts.total).toBe(3);
    expect(shaped.counts.failed).toBe(1);
    expect(shaped.bubbled?.session.id).toBe("c");
    expect(
      sessionClusterBubbleLabel(shaped.bubbled as SessionInboxCard, NOW),
    ).toBe("Failed in “Reviewer”");
  });

  it("says what it is coordinating in the cluster card's words", () => {
    const shaped = view([
      session({ id: "root" }),
      peer("a", "root", { isStreaming: true }),
      peer("b", "root"),
    ]);
    expect(spawnedSessionsSummary(shaped)).toBe(
      sessionClusterSummary(shaped.counts),
    );
    expect(spawnedSessionsSummary(shaped)).toBe("2 sessions · 1 running");
  });

  it("keys on what it renders, so a rebroadcast that changes nothing is free", () => {
    const sessions = [
      session({ id: "root" }),
      peer("a", "root", { isStreaming: true, runStartedAt: NOW - 12_000 }),
    ];
    // The whole point: new row objects, same drawn content, same key — this is
    // what stops the composer re-rendering several times a second.
    const again = sessions.map((item) => ({ ...item }));
    expect(spawnedSessionsKey(view(sessions), true)).toBe(
      spawnedSessionsKey(view(again), true),
    );
    for (const changed of [
      peer("a", "root", { title: "Renamed" }),
      peer("a", "root", { attention: "question" }),
      peer("a", "root", { lastError: { at: NOW, message: "boom" } }),
      peer("a", "root", { agentType: "developer" }),
      peer("a", "root", { titleGenerationPending: true }),
    ]) {
      expect(
        spawnedSessionsKey(view([session({ id: "root" }), changed]), true),
        JSON.stringify(changed),
      ).not.toBe(spawnedSessionsKey(view(sessions), true));
    }
  });

  it("ignores a peer's timestamps while closed and holds them while open", () => {
    const at = (updatedAt: number, open: boolean) =>
      spawnedSessionsKey(
        view([
          session({ id: "root" }),
          peer("a", "root", {
            isStreaming: true,
            runStartedAt: NOW - 12_000,
            updatedAt,
          }),
        ]),
        open,
      );
    // CLOSED, the rows are not on screen: a peer streaming tokens moves its
    // `updatedAt` several times a second and the strip draws none of it, so
    // the gate must hold — this is the hot path the whole gate is for.
    expect(at(NOW - 2_000, false)).toBe(at(NOW - 600_000, false));
    // OPEN, every row shows its own age off that timestamp. The key holds a
    // value the host RETAINS, so a stale one cannot be re-labelled into a
    // current one: the movement has to invalidate it, whatever bucket it lands
    // in. (A `memo` comparator may bucket; this may not.)
    expect(at(NOW - 2_000, true)).not.toBe(at(NOW - 4_000, true));
    // And opening it is itself a change, so the rows arrive current.
    expect(at(NOW - 2_000, true)).not.toBe(at(NOW - 2_000, false));
  });

  it("keys the collapsed line's own content while closed", () => {
    const closed = (peers: SessionListItem[]) =>
      spawnedSessionsKey(view([session({ id: "root" }), ...peers]), false);
    const quiet = closed([peer("a", "root")]);
    // The counts it states.
    expect(closed([peer("a", "root", { isStreaming: true })])).not.toBe(quiet);
    // The bubble it names, and that bubble's own state.
    expect(
      closed([peer("a", "root", { attention: "question", title: "Reviewer" })]),
    ).not.toBe(quiet);
    expect(
      closed([peer("a", "root", { attention: "question", title: "Renamed" })]),
    ).not.toBe(
      closed([peer("a", "root", { attention: "question", title: "Reviewer" })]),
    );
    // A settled peer is drawn as a count on the line.
    expect(
      closed([peer("a", "root"), peer("b", "root", { settledAt: NOW - 1 })]),
    ).not.toBe(quiet);
  });

  it("keys the sentence a row says, not only its status", () => {
    const quiet = peer("a", "root");
    const queued = peer("a", "root", { queuedWork: true });
    // Both classify as `quiet`; only the DETAIL differs ("Queued work is
    // waiting to run"), and `ClusterChildRow` speaks it in its label.
    expect(classifySessionStatus(queued)).toBe(classifySessionStatus(quiet));
    expect(
      spawnedSessionsKey(view([session({ id: "root" }), queued]), true),
    ).not.toBe(
      spawnedSessionsKey(view([session({ id: "root" }), quiet]), true),
    );
    // Same for two failures with different sentences: the status stays
    // `failed`, but the recorded error changes what the row says.
    const failed = peer("a", "root", {
      outcomeAttention: {
        kind: "failed",
        revision: 3,
        settledRevision: 2,
        at: NOW - 1_000,
      },
    });
    const failedWithMessage = peer("a", "root", {
      ...failed,
      lastError: { at: NOW, message: "The run failed" },
    });
    expect(classifySessionStatus(failedWithMessage)).toBe(
      classifySessionStatus(failed),
    );
    expect(
      spawnedSessionsKey(
        view([session({ id: "root" }), failedWithMessage]),
        true,
      ),
    ).not.toBe(
      spawnedSessionsKey(view([session({ id: "root" }), failed]), true),
    );
  });

  it("keys the bubble's own dismissibility, which is a control on the strip", () => {
    const failing = peer("a", "root", {
      lastError: { at: NOW, message: "boom" },
    });
    const blocked = { ...failing, queuedWork: true };
    // Same failure, same label, but one of them can be dismissed and the other
    // cannot — a difference the strip DRAWS.
    expect(
      spawnedSessionsKey(view([session({ id: "root" }), blocked]), false),
    ).not.toBe(
      spawnedSessionsKey(view([session({ id: "root" }), failing]), false),
    );
  });
});

describe("sessionCardAge", () => {
  it("says how long a running session has run, at minute resolution", () => {
    const running = session({
      id: "a",
      isStreaming: true,
      runStartedAt: NOW - 4 * 60_000 - 30_000,
      updatedAt: NOW,
    });
    expect(sessionCardAge(running, "running", NOW)).toEqual({
      label: "for 4m",
      title: "Running for 4m",
    });
    expect(
      sessionCardAge({ ...running, runStartedAt: NOW - 20_000 }, "running", NOW)
        .label,
    ).toBe("now");
    // Any other state states the age of the last update.
    expect(
      sessionCardAge(
        session({ id: "b", updatedAt: NOW - 60_000 }),
        "quiet",
        NOW,
      ),
    ).toEqual({ label: "1m", title: "Updated 1m ago" });
  });

  it("repaints a running card when its minute turns, not every second", () => {
    const running = card({
      id: "a",
      isStreaming: true,
      runStartedAt: NOW - 4 * 60_000,
      updatedAt: NOW,
    });
    expect(sessionCardKey(running, NOW + 30_000)).toBe(
      sessionCardKey(running, NOW),
    );
    expect(sessionCardKey(running, NOW + 60_000)).not.toBe(
      sessionCardKey(running, NOW),
    );
  });
});

describe("worktreeChangesText", () => {
  it("states uncommitted lines and commits ahead, and nothing when clean", () => {
    expect(
      worktreeChangesText({
        worktreeAdditions: 12,
        worktreeDeletions: 3,
        worktreeAhead: 1,
      }),
    ).toBe("12 lines added, 3 removed, uncommitted · 1 commit ahead of base");
    expect(worktreeChangesText({ worktreeAhead: 2 })).toBe(
      "2 commits ahead of base",
    );
    expect(
      worktreeChangesText({
        worktreeAdditions: 0,
        worktreeDeletions: 0,
        worktreeAhead: 0,
      }),
    ).toBeUndefined();
  });

  it("is on the relations key, so a changed diff repaints the card", () => {
    expect(sessionRelationsKey({ worktreeAdditions: 1 })).not.toBe(
      sessionRelationsKey({ worktreeAdditions: 2 }),
    );
    expect(sessionRelationsKey({ worktreeAhead: 1 })).not.toBe(
      sessionRelationsKey({ worktreeAhead: 2 }),
    );
  });
});

describe("peer trees without a depth cap", () => {
  const peer = (
    id: string,
    parent: string,
    extra: Partial<SessionListItem> = {},
  ): SessionListItem =>
    session({
      id,
      spawnedBySessionId: parent,
      spawnOwnership: "coordinator",
      ...extra,
    });
  const allCards = (view: ReturnType<typeof buildSessionInbox>) => [
    ...cards(view.needsYou),
    ...cards(view.active),
  ];

  it("shapes a long chain in work linear in its length, folded or open", () => {
    // Every property read on every row is counted: a walk per node (the shape
    // a capped depth used to make harmless) reads ~n²/2 rows on a chain, so
    // over 750 per row here, where one sweep stays under 100.
    let reads = 0;
    const counted = (row: SessionListItem): SessionListItem =>
      new Proxy(row, {
        get(target, key, receiver) {
          reads += 1;
          return Reflect.get(target, key, receiver);
        },
      });
    const n = 1_500;
    const chain = Array.from({ length: n }, (_, i) =>
      counted(i === 0 ? session({ id: "s0" }) : peer(`s${i}`, `s${i - 1}`)),
    );
    const view = buildSessionInbox(chain);
    expect(allCards(view)[0]?.cluster?.counts.total).toBe(n - 1);
    expect(reads).toBeLessThan(150 * n);
    reads = 0;
    const ledge = spawnedSessionsView({ sessions: chain, coordinatorId: "s0" });
    expect(ledge.counts.total).toBe(n - 1);
    expect(reads).toBeLessThan(150 * n);
  });

  it("keys the spinner's own count, which no sentence states", () => {
    const host = {
      activeCount: 0,
      shellCount: 0,
      monitorCommandCount: 0,
      monitorWebsocketCount: 0,
      startingCount: 0,
      stoppingCount: 0,
      oldestStartedAt: 0,
      retainedHost: true,
    };
    // The coordinator's own block holds the Settle reason still, so only the
    // count can tell the two apart.
    const rows = (retained: boolean) => [
      session({ id: "root", queuedWork: true }),
      peer("kid", "root", retained ? { backgroundActivity: host } : {}),
    ];
    const cardKey = (retained: boolean) =>
      sessionCardKey(
        allCards(buildSessionInbox(rows(retained)))[0] as SessionInboxCard,
        NOW,
      );
    expect(cardKey(true)).not.toBe(cardKey(false));
    const ledgeKey = (retained: boolean) =>
      spawnedSessionsKey(
        spawnedSessionsView({
          sessions: rows(retained),
          coordinatorId: "root",
        }),
        false,
      );
    expect(ledgeKey(true)).not.toBe(ledgeKey(false));
  });

  it("refuses a ledge peer's dismissal for what its Settle would settle", () => {
    const sessions = [
      session({ id: "root" }),
      peer("helper", "root"),
      peer("failed", "helper", {
        title: "Verifier",
        lastError: { at: NOW, message: "boom" },
      }),
      peer("busy", "failed", { isStreaming: true }),
    ];
    const view = spawnedSessionsView({ sessions, coordinatorId: "root" });
    expect(view.bubbled?.session.id).toBe("failed");
    expect(view.bubbled?.settleBlocked).toBe("it is still running.");
    expect(clusterBubbleDismissible(view.bubbled as SessionInboxCard)).toBe(
      false,
    );
    expect(sessionSettleCascade("failed", sessions, null, {}).blocked).toBe(
      "it is still running.",
    );
    // A peer the user took over is not settled with it, so it blocks nothing.
    const mine = spawnedSessionsView({
      sessions: [
        ...sessions.slice(0, 3),
        peer("busy", "failed", {
          isStreaming: true,
          spawnOwnership: "taken-over",
        }),
      ],
      coordinatorId: "root",
    });
    expect(mine.bubbled?.settleBlocked).toBe(undefined);
    expect(clusterBubbleDismissible(mine.bubbled as SessionInboxCard)).toBe(
      true,
    );
  });

  it("never counts a settled host's acknowledged failure as live", () => {
    const old = { lastError: { at: NOW - 60_000, message: "old failure" } };
    const sessions = [
      session({ id: "root", settledAt: NOW - 10_000, ...old }),
      peer("mid", "root", { settledAt: NOW - 10_000, ...old }),
      peer("live", "mid"),
    ];
    const card = allCards(buildSessionInbox(sessions))[0] as SessionInboxCard;
    // Kept up by the live peer below, without reviving the history above it.
    expect(card.session.id).toBe("root");
    expect(card.status).toBe("quiet");
    expect(card.cluster?.counts.failed).toBe(0);
    expect(card.cluster?.bubbled).toBe(undefined);
    const ledge = spawnedSessionsView({ sessions, coordinatorId: "root" });
    expect(ledge.counts.failed).toBe(0);
    expect(ledge.bubbled).toBe(undefined);
    // A failure the user has NOT acknowledged unsettles the row, and still
    // counts and bubbles.
    const fresh = allCards(
      buildSessionInbox([
        session({ id: "root" }),
        peer("mid", "root", old),
        peer("live", "mid"),
      ]),
    )[0] as SessionInboxCard;
    expect(fresh.cluster?.counts.failed).toBe(1);
    expect(fresh.cluster?.bubbled?.session.id).toBe("mid");
  });
});

describe("an expanded peer row", () => {
  it("redraws when the age it draws moves, though a running card's key holds", () => {
    const running = (updatedAt: number): SessionInboxCard =>
      allCardsOf(
        buildSessionInbox([
          session({ id: "root" }),
          session({
            id: "kid",
            spawnedBySessionId: "root",
            spawnOwnership: "coordinator",
            isStreaming: true,
            runStartedAt: NOW - 120_000,
            updatedAt,
          }),
        ]),
      )[0]?.cluster?.children[0] as SessionInboxCard;
    const before = running(NOW - 60_000);
    const after = running(NOW);
    // The card key reads the elapsed run, which did not move.
    expect(sessionCardKey(before, NOW)).toBe(sessionCardKey(after, NOW));
    expect(
      sameClusterChildProps(
        { card: before, now: NOW },
        { card: after, now: NOW },
      ),
    ).toBe(false);
  });
});

describe("a settled peer set running again", () => {
  const rows = [
    session({ id: "root" }),
    session({
      id: "kid",
      spawnedBySessionId: "root",
      spawnOwnership: "coordinator",
      settledAt: NOW - 10_000,
      isStreaming: true,
      runStartedAt: NOW - 5_000,
    }),
  ];

  it("is live work in the fold, and refuses the coordinator's Settle", () => {
    const view = buildSessionInbox(rows);
    const card = cards(view.active)[0] as SessionInboxCard;
    expect(card.cluster?.children.map((c) => c.session.id)).toEqual(["kid"]);
    expect(card.cluster?.counts.running).toBe(1);
    expect(card.settleBlocked).toBe("it is still running.");
    expect(view.settled).toEqual([]);
  });

  it("keeps a settled coordinator on the shelf: the peer runs from there", () => {
    const shelvedRows = [
      session({ id: "root", settledAt: NOW - 20_000 }),
      ...rows.slice(1),
    ];
    const view = buildSessionInbox(shelvedRows);
    // No card coming and going with every peer turn: nothing under the
    // coordinator is unsettled or waiting on the user.
    expect([...cards(view.needsYou), ...cards(view.active)]).toEqual([]);
    // Both keep their shelf rows; the peer runs from there.
    expect(view.settled.map((s) => s.id).sort()).toEqual(["kid", "root"]);
    // The coordinator's own ledge still shows the run.
    const ledge = spawnedSessionsView({
      sessions: shelvedRows,
      coordinatorId: "root",
    });
    expect(ledge.counts.running).toBe(1);
  });

  it("keeps every session of a shelved fold on the shelf while a peer runs", () => {
    const chain = (running: boolean) => [
      session({ id: "root", settledAt: NOW - 30_000 }),
      session({
        id: "bridge",
        spawnedBySessionId: "root",
        spawnOwnership: "coordinator",
        settledAt: NOW - 20_000,
      }),
      session({
        id: "leaf",
        spawnedBySessionId: "bridge",
        spawnOwnership: "coordinator",
        settledAt: NOW - 10_000,
        ...(running ? { isStreaming: true, runStartedAt: NOW - 1_000 } : {}),
      }),
    ];
    for (const running of [true, false]) {
      const view = buildSessionInbox(chain(running), { currentId: "leaf" });
      expect([...cards(view.needsYou), ...cards(view.active)]).toEqual([]);
      expect(view.settled.map((s) => s.id).sort()).toEqual([
        "bridge",
        "leaf",
        "root",
      ]);
      expect(view.settledTotal).toBe(3);
    }
  });

  it("is live work on the composer ledge", () => {
    const ledge = spawnedSessionsView({
      sessions: rows,
      coordinatorId: "root",
    });
    expect(ledge.rows.map((c) => c.session.id)).toEqual(["kid"]);
    expect(ledge.counts).toMatchObject({ total: 1, running: 1 });
    expect(ledge.settled).toBe(0);
  });
});

function allCardsOf(view: ReturnType<typeof buildSessionInbox>) {
  return [...cards(view.needsYou), ...cards(view.active)];
}

describe("a stalled tree", () => {
  const peer = (
    id: string,
    parent: string,
    extra: Partial<SessionListItem> = {},
  ): SessionListItem =>
    session({
      id,
      spawnedBySessionId: parent,
      spawnOwnership: "coordinator",
      ...extra,
    });
  const jobs = {
    activeCount: 1,
    shellCount: 1,
    monitorCommandCount: 0,
    monitorWebsocketCount: 0,
    startingCount: 0,
    stoppingCount: 0,
    oldestStartedAt: NOW - 1_000,
  };
  const stallOf = (rows: SessionListItem[]) => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    return spawnTreeStall(rows, byId)?.peers.map((p) => p.id);
  };

  it("is a quiet tree still owed a reply, naming who owes it", () => {
    expect(
      stallOf([
        session({ id: "root", awaitingRepliesFrom: ["rev"] }),
        peer("rev", "root", { title: "Reviewer" }),
      ]),
    ).toEqual(["rev"]);
  });

  it("is not a stall while anything in the tree, or the peer owed, is moving", () => {
    const owed = session({ id: "root", awaitingRepliesFrom: ["rev"] });
    for (const moving of [
      { isStreaming: true },
      { queuedWork: true },
      { backgroundActivity: jobs },
    ]) {
      // The owed peer itself is working on the answer...
      expect(stallOf([owed, peer("rev", "root", moving)])).toBe(undefined);
      // ...or the work went elsewhere in the tree: an implementer told to
      // report to the reviewer, not to the coordinator that asked.
      expect(
        stallOf([owed, peer("rev", "root"), peer("impl", "root", moving)]),
      ).toBe(undefined);
    }
    // The coordinator's own background job is work going on too.
    expect(
      stallOf([
        session({
          id: "root",
          awaitingRepliesFrom: ["rev"],
          backgroundActivity: jobs,
        }),
        peer("rev", "root"),
      ]),
    ).toBe(undefined);
  });

  it("leaves a tree waiting on the user to its own bubble", () => {
    expect(
      stallOf([
        session({ id: "root", awaitingRepliesFrom: ["rev"] }),
        peer("rev", "root", { attention: "question" }),
      ]),
    ).toBe(undefined);
  });

  it("is nothing when no reply is owed, or the owed peer was put away", () => {
    expect(stallOf([session({ id: "root" }), peer("rev", "root")])).toBe(
      undefined,
    );
    expect(
      stallOf([
        session({ id: "root", awaitingRepliesFrom: ["gone", "archived"] }),
        peer("archived", "root", { archived: true }),
      ]),
    ).toBe(undefined);
  });

  it("lifts the coordinator's card to attention and names the peer", () => {
    const view = buildSessionInbox([
      session({ id: "root", awaitingRepliesFrom: ["rev"] }),
      peer("rev", "root", { title: "Reviewer" }),
    ]);
    const card = [...cards(view.needsYou), ...cards(view.active)][0];
    expect(card?.tier).toBe("attention");
    expect(card?.stall?.peers.map((p) => p.id)).toEqual(["rev"]);
    expect(stallLabel(card!.stall!)).toBe("No reply from “Reviewer”");
    // The chip is keyed, so a stall that starts or ends repaints the card.
    const quiet = buildSessionInbox([
      session({ id: "root" }),
      peer("rev", "root", { title: "Reviewer" }),
    ]);
    expect(
      sessionCardKey(cards(quiet.active)[0] as SessionInboxCard, NOW),
    ).not.toBe(sessionCardKey(card as SessionInboxCard, NOW));
  });

  it("is stated on the composer ledge of the chat that is owed", () => {
    const sessions = [
      session({ id: "root", awaitingRepliesFrom: ["rev", "impl"] }),
      peer("rev", "root", { title: "Reviewer", updatedAt: NOW - 1_000 }),
      peer("impl", "root", { title: "Implementer", updatedAt: NOW - 9_000 }),
    ];
    const ledge = spawnedSessionsView({ sessions, coordinatorId: "root" });
    expect(ledge.stall?.peers.map((p) => p.id)).toEqual(["rev", "impl"]);
    expect(stallLabel(ledge.stall!)).toBe("No reply from “Reviewer” +1");
    expect(spawnedSessionsKey(ledge, false)).not.toBe(
      spawnedSessionsKey(
        spawnedSessionsView({
          sessions: [session({ id: "root" }), ...sessions.slice(1)],
          coordinatorId: "root",
        }),
        false,
      ),
    );
  });
});

describe("a stalled tree, at its edges", () => {
  const row = (id: string, extra: Partial<SessionListItem> = {}) =>
    session({ id, ...extra });
  const stallOf = (scope: SessionListItem[], others: SessionListItem[] = []) =>
    spawnTreeStall(
      scope,
      new Map([...scope, ...others].map((s) => [s.id, s])),
    )?.peers.map((p) => p.id);
  const host = {
    activeCount: 0,
    shellCount: 0,
    monitorCommandCount: 0,
    monitorWebsocketCount: 0,
    startingCount: 0,
    stoppingCount: 0,
    oldestStartedAt: 0,
  };

  it("weighs an owed peer outside the tree by whether it is working", () => {
    const root = row("root", { awaitingRepliesFrom: ["outside"] });
    expect(stallOf([root], [row("outside", { isStreaming: true })])).toBe(
      undefined,
    );
    expect(stallOf([root], [row("outside")])).toEqual(["outside"]);
  });

  it("owes nothing from a peer the user settled", () => {
    // A coordinator told it to stand down, and the user put it down.
    const root = row("root", { awaitingRepliesFrom: ["done"] });
    expect(stallOf([root], [row("done", { settledAt: NOW - 1_000 })])).toBe(
      undefined,
    );
  });

  it("counts working subagent runs as work, but not one waiting on its parent", () => {
    const root = row("root", { awaitingRepliesFrom: ["rev"] });
    const delegation = (working: number, awaiting: number) => ({
      activeCount: working + awaiting,
      startingCount: 0,
      workingCount: working,
      awaitingParentCount: awaiting,
    });
    expect(stallOf([root, row("rev", { delegation: delegation(1, 0) })])).toBe(
      undefined,
    );
    expect(
      stallOf([root, row("rev", { delegation: delegation(0, 1) })]),
    ).toEqual(["rev"]);
  });

  it("counts a job starting, or a retained host, as work going on", () => {
    const root = row("root", { awaitingRepliesFrom: ["rev"] });
    for (const activity of [
      { ...host, startingCount: 1 },
      { ...host, retainedHost: true },
    ])
      expect(
        stallOf([root, row("rev", { backgroundActivity: activity })]),
      ).toBe(undefined);
  });

  it("hears a grandchild that still owes its own coordinator", () => {
    const view = buildSessionInbox([
      row("root"),
      row("impl", {
        spawnedBySessionId: "root",
        spawnOwnership: "coordinator",
        awaitingRepliesFrom: ["rev"],
      }),
      row("rev", {
        title: "Reviewer",
        spawnedBySessionId: "impl",
        spawnOwnership: "coordinator",
      }),
    ]);
    const card = [...cards(view.needsYou), ...cards(view.active)][0];
    expect(card?.session.id).toBe("root");
    expect(card?.stall?.peers.map((p) => p.id)).toEqual(["rev"]);
  });

  it("leaves a settled tree on the shelf, where it raises nothing", () => {
    const view = buildSessionInbox([
      row("root", { settledAt: NOW - 1_000, awaitingRepliesFrom: ["rev"] }),
      row("rev", {
        spawnedBySessionId: "root",
        spawnOwnership: "coordinator",
        settledAt: NOW - 1_000,
      }),
    ]);
    expect([...cards(view.needsYou), ...cards(view.active)]).toEqual([]);
  });
});

describe("the composer ledge's stall", () => {
  it("is judged over the card's tree: a taken-over child's work does not hide it", () => {
    const sessions = [
      session({ id: "root", awaitingRepliesFrom: ["rev"] }),
      session({
        id: "rev",
        title: "Reviewer",
        spawnedBySessionId: "root",
        spawnOwnership: "coordinator",
      }),
      session({
        id: "mine",
        spawnedBySessionId: "root",
        spawnOwnership: "taken-over",
        isStreaming: true,
      }),
    ];
    const card = [
      ...cards(buildSessionInbox(sessions).needsYou),
      ...cards(buildSessionInbox(sessions).active),
    ].find((c) => c.session.id === "root");
    const ledge = spawnedSessionsView({ sessions, coordinatorId: "root" });
    expect(card?.stall?.peers.map((p) => p.id)).toEqual(["rev"]);
    expect(ledge.stall?.peers.map((p) => p.id)).toEqual(["rev"]);
  });

  it("is read for a chat that spawned no one but asked an existing session", () => {
    const ledge = spawnedSessionsView({
      sessions: [
        session({ id: "root", awaitingRepliesFrom: ["impl"] }),
        session({ id: "impl", title: "Implementer" }),
      ],
      coordinatorId: "root",
    });
    expect(ledge.rows).toEqual([]);
    expect(ledge.stall?.peers.map((p) => p.id)).toEqual(["impl"]);
  });
});

describe("the composer ledge for a Workflow Run's role", () => {
  const activeRun: WorkflowRunSummary = {
    id: "r1",
    taskId: "676",
    recipeId: "code-delivery",
    recipeVersion: 1,
    lifecycle: "active",
    limits: { maxIterations: 3, maxReviewPasses: 2 },
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 30_000,
  };
  const card: WorkflowRunCard = {
    runId: "r1",
    phase: "review",
    iterationsUsed: 1,
    nextAction: "Wait for the implementer.",
    mergeDecisionReady: false,
    canRebaseAndReview: false,
    canRetry: false,
    canResume: true,
    coordinatorSessionId: "coord",
    implementerSessionId: "impl",
  };

  it("raises no stall of its own, spawned peers or not", () => {
    for (const spawned of [false, true]) {
      const sessions = [
        session({ id: "coord", awaitingRepliesFrom: ["impl"] }),
        session({
          id: "impl",
          ...(spawned
            ? {
                spawnedBySessionId: "coord",
                spawnOwnership: "coordinator" as const,
              }
            : {}),
        }),
      ];
      const ledge = spawnedSessionsView({
        sessions,
        coordinatorId: "coord",
        workflowRuns: [activeRun],
        workflowCards: { r1: card },
      });
      expect(ledge.stall, spawned ? "with peers" : "alone").toBe(undefined);
    }
  });
});

describe("a tree waiting on its own coordinator", () => {
  it("names the peer that waits, not the card itself", () => {
    const sessions = [
      session({ id: "root", title: "Coordinator" }),
      session({
        id: "impl",
        title: "Implementer",
        spawnedBySessionId: "root",
        spawnOwnership: "coordinator",
        awaitingRepliesFrom: ["root"],
      }),
    ];
    const view = buildSessionInbox(sessions);
    const card = [...cards(view.needsYou), ...cards(view.active)][0];
    expect(card?.stall?.peers).toEqual([]);
    expect(card?.stall?.askers.map((s) => s.id)).toEqual(["impl"]);
    expect(stallLabel(card!.stall!)).toBe("“Implementer” awaits a reply");
    const ledge = spawnedSessionsView({ sessions, coordinatorId: "root" });
    expect(stallLabel(ledge.stall!)).toBe("“Implementer” awaits a reply");
  });

  it("raises nothing once the user settled that coordinator, though a live peer keeps the card", () => {
    const sessions = [
      session({ id: "root", title: "Coordinator", settledAt: NOW - 1_000 }),
      session({
        id: "impl",
        title: "Implementer",
        spawnedBySessionId: "root",
        spawnOwnership: "coordinator",
        awaitingRepliesFrom: ["root"],
      }),
    ];
    const view = buildSessionInbox(sessions);
    const card = [...cards(view.needsYou), ...cards(view.active)].find(
      (c) => c.session.id === "root",
    );
    expect(card, "the live peer keeps the card").toBeDefined();
    expect(card?.stall).toBe(undefined);
    expect(spawnedSessionsView({ sessions, coordinatorId: "root" }).stall).toBe(
      undefined,
    );
  });
});

describe("the composer ledge of a chat the user put down", () => {
  const owedBy = (extra: Partial<SessionListItem>) => [
    session({ id: "root", awaitingRepliesFrom: ["x"], ...extra }),
    session({ id: "x" }),
  ];

  it("raises nothing for a settled or archived chat, as its card does not", () => {
    for (const extra of [{ settledAt: NOW - 1_000 }, { archived: true }]) {
      const sessions = owedBy(extra);
      expect(
        [
          ...cards(buildSessionInbox(sessions).needsYou),
          ...cards(buildSessionInbox(sessions).active),
        ].find((c) => c.session.id === "root"),
      ).toBe(undefined);
      expect(
        spawnedSessionsView({ sessions, coordinatorId: "root" }).stall,
        JSON.stringify(extra),
      ).toBe(undefined);
    }
  });
});

describe("the stall chip's content key", () => {
  it("changes when only the direction of the debt changes", () => {
    // Same idle rows, titles and times: the coordinator owed by its peer,
    // then the peer waiting on the coordinator. The chip's words differ.
    const owedByPeer = [
      session({ id: "root", awaitingRepliesFrom: ["impl"] }),
      session({
        id: "impl",
        title: "Implementer",
        spawnedBySessionId: "root",
        spawnOwnership: "coordinator",
      }),
    ];
    const peerWaits = [
      session({ id: "root" }),
      session({
        id: "impl",
        title: "Implementer",
        spawnedBySessionId: "root",
        spawnOwnership: "coordinator",
        awaitingRepliesFrom: ["root"],
      }),
    ];
    const card = (rows: SessionListItem[]) =>
      [
        ...cards(buildSessionInbox(rows).needsYou),
        ...cards(buildSessionInbox(rows).active),
      ][0] as SessionInboxCard;
    expect(stallLabel(card(owedByPeer).stall!)).not.toBe(
      stallLabel(card(peerWaits).stall!),
    );
    expect(sessionCardKey(card(owedByPeer), NOW)).not.toBe(
      sessionCardKey(card(peerWaits), NOW),
    );
    const ledge = (rows: SessionListItem[]) =>
      spawnedSessionsKey(
        spawnedSessionsView({ sessions: rows, coordinatorId: "root" }),
        false,
      );
    expect(ledge(owedByPeer)).not.toBe(ledge(peerWaits));
  });
});
