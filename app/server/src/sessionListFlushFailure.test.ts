/** Failed publications retain reported work until a later ordinary touch retries it. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import { hub } from "./hub.ts";
import * as list from "./harnesses/sessionList.ts";
import * as sessions from "./sessions.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { permanentAssistantStore } from "./db/permanentAssistantStore.ts";
import {
  touchAllSessionRows,
  touchSessionRows,
} from "./db/sessionListChanges.ts";

let serial = 0;
const messages: ServerMessage[][] = [[], []];
const viewers = messages.map((sent, i) => ({
  send: (message: ServerMessage) => sent.push(message),
  wantsArchivedSessions: () => i === 1,
}));
function seed() {
  const id = `flush-failure-${++serial}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: id,
    messageCount: 2,
  });
  return id;
}
function clearMessages() {
  for (const sent of messages) sent.length = 0;
}
function rowIn(sent: ServerMessage[], id: string) {
  return sent
    .flatMap((m) =>
      m.type === "sessions"
        ? m.sessions
        : m.type === "sessionUpdated"
          ? [m.session]
          : [],
    )
    .find((row) => row.id === id);
}
beforeEach(() => {
  for (const viewer of viewers) hub.register(viewer);
});
afterEach(async () => {
  vi.restoreAllMocks();
  // A new report, not an automatic busy retry, drains any failed test's work.
  touchAllSessionRows("failure fixture cleanup");
  await hub.flushPendingBroadcastsForTests();
  for (const viewer of viewers) hub.unregister(viewer);
});

/** Call one is the strict audit; fail only after it, inside the publication. */
function failBuild(call: number, duringFailure?: () => void) {
  const original = list.mergedSessionList;
  let calls = 0;
  return vi
    .spyOn(list, "mergedSessionList")
    .mockImplementation(async (opts) => {
      if (++calls === call) {
        duringFailure?.();
        throw new Error("one-shot row build failure");
      }
      return original(opts);
    });
}

for (const mode of ["selective", "global", "fallback"] as const)
  test(`${mode} failure retains touched work, new touches and its audit classification`, async () => {
    const [a, b, during] = [seed(), seed(), seed()];
    await hub.flushPendingBroadcastsForTests();
    clearMessages();
    sessionStore.upsert({
      id: a,
      harness: "pi",
      agentType: "assistant",
      title: "changed before failure",
    });
    if (mode === "global") touchAllSessionRows("test global refresh");
    if (mode === "fallback") seed(); // membership forces the second full build
    const build = failBuild(mode === "fallback" ? 3 : 2, () => {
      sessionStore.upsert({
        id: during,
        harness: "pi",
        agentType: "assistant",
        title: "changed during failed build",
      });
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await assert.rejects(hub.flushPendingBroadcastsForTests(), /one-shot/);
    assert.equal(
      messages[0]!.length,
      0,
      "no partial rows published on build failure",
    );
    const callsAfterFailure = build.mock.calls.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      build.mock.calls.length,
      callsAfterFailure,
      "failure does not self-retry",
    );
    touchSessionRows([b]);
    await hub.flushPendingBroadcastsForTests();
    for (const sent of messages) {
      assert.equal(rowIn(sent, a)?.title, "changed before failure");
      assert.equal(rowIn(sent, during)?.title, "changed during failed build");
      if (mode === "global")
        assert.ok(
          sent.some(
            (m) => m.type === "sessionUpdated" || m.type === "sessions",
          ),
        );
    }
    if (mode === "global") {
      const retryBuilds = build.mock.calls.slice(callsAfterFailure);
      assert.ok(retryBuilds.length >= 2);
      assert.equal(
        retryBuilds[1]![0]?.onlyIds,
        undefined,
        "global intent survived failure",
      );
    }
  });

for (const mode of ["delete archived", "restore"] as const)
  test(`${mode} failed full fallback does not acknowledge the archived count for either variant`, async () => {
    const [a, b] = [seed(), seed()];
    sessionStore.setArchived(a, true);
    await hub.flushPendingBroadcastsForTests();
    clearMessages();
    if (mode === "restore") sessionStore.setArchived(a, false);
    else sessionStore.remove(a);
    failBuild(3);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await assert.rejects(hub.flushPendingBroadcastsForTests(), /one-shot/);
    for (const sent of messages) assert.equal(sent.length, 0);
    touchSessionRows([b]);
    await hub.flushPendingBroadcastsForTests();
    const count = await hub.archivedSessionCount();
    for (const [i, sent] of messages.entries()) {
      const full = sent.find((m) => m.type === "sessions");
      assert.ok(
        full?.type === "sessions",
        `variant ${i} received the count despite unchanged membership`,
      );
      assert.equal(full.archivedSessionCount, count);
      assert.equal(
        full.sessions.some((row) => row.id === a),
        mode === "restore",
      );
    }
  });

test("an equal forced refresh rejects a failed attempt and retains its send-before-refusal intent", async () => {
  const [a, b] = [seed(), seed()];
  await hub.flushPendingBroadcastsForTests();
  clearMessages();
  failBuild(2);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await assert.rejects(hub.broadcastSessionUpdated(a), /one-shot/);
  for (const sent of messages) assert.equal(sent.length, 0);
  touchSessionRows([b]);
  await hub.flushPendingBroadcastsForTests();
  for (const sent of messages) assert.equal(rowIn(sent, a)?.id, a);
  clearMessages();
  await hub.broadcastSessionUpdated(a);
  messages[0]!.push({ type: "error", message: "refused" });
  assert.equal(messages[0]![0]?.type, "sessionUpdated");
  assert.equal(messages[0]![1]?.type, "error");
});

for (const stage of ["count", "send"] as const)
  test(`${stage} failure leaves publication state recoverable`, async () => {
    const [a, b] = [seed(), seed()];
    await hub.flushPendingBroadcastsForTests();
    clearMessages();
    sessionStore.setArchived(a, true);
    if (stage === "count")
      vi.spyOn(sessions, "archivedSessionCount").mockRejectedValueOnce(
        new Error("one-shot count failure"),
      );
    else
      vi.spyOn(viewers[1]!, "send").mockImplementationOnce(() => {
        throw new Error("one-shot send failure");
      });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await assert.rejects(hub.flushPendingBroadcastsForTests(), /one-shot/);
    clearMessages();
    touchSessionRows([b]);
    await hub.flushPendingBroadcastsForTests();
    const count = await hub.archivedSessionCount();
    for (const [i, sent] of messages.entries()) {
      const full = sent.find((m) => m.type === "sessions");
      assert.ok(full?.type === "sessions");
      assert.equal(full.archivedSessionCount, count);
      assert.equal(
        full.sessions.some((row) => row.id === a),
        i === 1,
      );
    }
  });

test("a failed fallback does not spend the singleton unread scalar or its published baseline", async () => {
  const previous = permanentAssistantStore.sessionId();
  const a = seed();
  permanentAssistantStore.setSessionId(a);
  await hub.flushPendingBroadcastsForTests();
  assert.ok(
    messages[0]!.some((m) => m.type === "permanentAssistantUnread" && m.unread),
  );
  clearMessages();
  permanentAssistantStore.clearSessionId(); // scalar false and public membership appears
  failBuild(3);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await assert.rejects(hub.flushPendingBroadcastsForTests(), /one-shot/);
    for (const sent of messages)
      assert.equal(
        sent.length,
        0,
        "nothing is sent before all row builds succeed",
      );
    touchSessionRows([seed()]);
    await hub.flushPendingBroadcastsForTests();
    for (const sent of messages) {
      assert.ok(rowIn(sent, a));
      assert.ok(
        sent.some((m) => m.type === "permanentAssistantUnread" && !m.unread),
      );
    }
  } finally {
    if (previous) permanentAssistantStore.setSessionId(previous);
    else permanentAssistantStore.clearSessionId();
  }
});
