import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionListItem, PullRequestCard } from "@assistant/shared";
import {
  associateInitiativeSessions,
  memberActivity,
} from "./initiativeActivity.ts";

const session = (
  id: string,
  extra: Partial<SessionListItem> = {},
): SessionListItem => ({
  id,
  title: id,
  harness: "pi",
  agentType: "developer",
  createdAt: 1,
  updatedAt: 1000,
  messageCount: 0,
  ...extra,
});

test("association follows coordinator ownership through settled roots and cuts other Tasks and taken-over subtrees", () => {
  const rows = [
    session("root", { settledAt: 1 }),
    session("child", { spawnOwnership: "coordinator" }),
    session("other", {
      spawnOwnership: "coordinator",
      objectRefs: [
        { objectType: "task", id: "2", source: "initial-context", linkedAt: 1 },
      ],
    }),
    session("below", { spawnOwnership: "coordinator" }),
    session("taken", { spawnOwnership: "taken-over" }),
  ];
  const result = associateInitiativeSessions(
    new Map([
      ["1", ["root"]],
      ["2", ["other"]],
    ]),
    new Map([
      ["child", "root"],
      ["other", "root"],
      ["below", "other"],
      ["taken", "root"],
    ]),
    rows,
  );
  assert.deepEqual([...result.get("1")!], ["root", "child"]);
  assert.deepEqual([...result.get("2")!], ["other", "below"]);
});

test("explicit outside Task context cuts a subtree without rooting passive references", () => {
  const rows = [
    session("root"),
    session("outside", {
      spawnOwnership: "coordinator",
      objectRefs: [
        {
          objectType: "task",
          id: "outside-task",
          source: "manual",
          linkedAt: 1,
        },
      ],
    }),
    session("below", { spawnOwnership: "coordinator" }),
    session("reference"),
  ];
  const result = associateInitiativeSessions(
    new Map([["1", ["root"]]]),
    new Map([
      ["outside", "root"],
      ["below", "outside"],
    ]),
    rows,
  );
  assert.deepEqual([...result.get("1")!], ["root"]);
});

test("session projection mirrors inbox precedence, timestamps, caps and stall hydration", () => {
  const rows = [
    session("asker", {
      awaitingRepliesFrom: ["peer", "b", "c", "d", "e"],
      title: "界".repeat(100),
      lastError: { at: 5000, message: "failed" },
    }),
    session("settled", { settledAt: 1 }),
  ];
  const activity = (peer: Partial<SessionListItem>) =>
    memberActivity(
      rows,
      new Map([["peer", session("peer", peer)]]),
      new Map([["asker", "implementer"]]),
      [],
      [],
    );
  const idle = activity({});
  assert.equal(idle.stalled, true);
  assert.equal(idle.sessions[0]!.state, "failed");
  assert.equal(idle.sessions[0]!.lastActivityAt, new Date(5000).toISOString());
  assert.equal(idle.sessions[0]!.agent, "implementer");
  assert.equal(idle.sessions[0]!.owedReplyCount, 5);
  assert.equal(idle.sessions[0]!.owedRepliesFrom.length, 3);
  assert.ok(Buffer.byteLength(idle.sessions[0]!.title) <= 120);
  for (const peer of [
    { isStreaming: true },
    { queuedWork: true },
    { awaitingInput: true },
    { settledAt: 1 },
    { archived: true },
  ])
    assert.equal(activity(peer).stalled, undefined);
  const states = memberActivity(
    [
      session("wait", { isStreaming: true, attention: "approval" }),
      session("run", { queuedWork: true }),
      session("interrupt", { interruptedRun: { at: 2 } }),
      ...Array.from({ length: 5 }, (_, i) => session(String(i))),
    ],
    new Map(),
    new Map(),
    [],
    [],
  );
  assert.deepEqual(
    states.sessions.slice(0, 3).map((s) => s.state),
    ["waiting-on-user", "running", "interrupted"],
  );
  assert.equal(states.sessions.length, 5);
  assert.equal(states.sessionCount, 8);
});

test("a refused peer send waits on the user and suppresses stalls even after peer settlement", () => {
  const refusal = { chainId: "chain", maxHops: 150 };
  const asker = session("asker", { awaitingRepliesFrom: ["peer", "other"] });
  const peers = new Map([
    ["peer", session("peer", { settledAt: 1, peerPromptHopRefusal: refusal })],
    ["other", session("other")],
  ]);
  assert.equal(
    memberActivity([asker], peers, new Map(), [], []).stalled,
    undefined,
  );
  const waiting = memberActivity(
    [session("refused", { peerPromptHopRefusal: refusal, isStreaming: true })],
    new Map(),
    new Map(),
    [],
    [],
  );
  assert.equal(waiting.sessions[0]!.state, "waiting-on-user");
});

test("PR projection deduplicates, prefers open cards and hides terminal checks; removed worktrees survive", () => {
  const card = (
    id: string,
    extra: Partial<PullRequestCard>,
  ): PullRequestCard => ({
    renderKind: "pullRequest",
    id,
    sessionId: "settled",
    status: "merged",
    title: "PR",
    headBranch: "feature",
    baseBranch: "main",
    createdAt: 1,
    updatedAt: 1,
    warnings: [],
    provider: "github",
    number: 1,
    url: "https://github.com/o/r/pull/1",
    ...extra,
  });
  const activity = memberActivity(
    [],
    new Map(),
    new Map(),
    [{ id: "removed", branch: "feature", status: "removed", createdAt: 1 }],
    [
      { card: card("old", {}), headSha: "old" },
      { card: card("new", { status: "open" }), headSha: "new" },
      {
        card: card("merged", {
          number: 2,
          url: "https://github.com/o/r/pull/2",
          ci: { state: "failure", total: 1 },
        }),
        headSha: "merged",
      },
    ],
  );
  assert.equal(activity.pullRequests.length, 2);
  assert.equal(activity.pullRequests[0]!.headSha, "new");
  assert.equal(activity.pullRequests[1]!.checks, undefined);
  assert.equal(activity.worktrees[0]!.status, "removed");
  const capped = memberActivity(
    [],
    new Map(),
    new Map(),
    Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      branch: "feature",
      status: i === 0 ? "removed" : "active",
      createdAt: i,
    })),
    Array.from({ length: 5 }, (_, i) => ({
      card: card(String(i), {
        number: i,
        url: `https://github.com/o/r/pull/${i}`,
      }),
    })),
  );
  assert.equal(capped.worktreeCount, 5);
  assert.equal(capped.worktrees.length, 3);
  assert.equal(capped.worktrees[0]!.status, "active");
  assert.equal(capped.pullRequestCount, 5);
  assert.equal(capped.pullRequests.length, 3);
});
