/** Corrective regressions for Task-1301 milestone findings F001-F005. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach, vi } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import { hub } from "./hub.ts";
import * as mergedList from "./harnesses/sessionList.ts";
import { touchSessionRows } from "./db/sessionListChanges.ts";
import { getDb } from "./db/index.ts";
import { setInboxPositions } from "./db/inboxPositionStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { peerPromptStore as peer } from "./db/peerPromptStore.ts";
import { permanentAssistantStore as pa } from "./db/permanentAssistantStore.ts";
import { recordSessionRowTouches } from "./test/sessionRowTouches.ts";
import { projectStore } from "./db/projectStore.ts";
import { linkSessionToWorktree } from "./db/worktreeStore.ts";
import {
  clearMainRepoCache,
  resolveMainWorktreeRow,
} from "./worktrees/worktreeResolve.ts";
import { sessionWorktreeMissing } from "./worktrees/sessionCwd.ts";
import {
  resetSessionListAuditBaselineForTests,
  sweepSessionRows,
} from "./sessionsTopic.ts";
import { takeStateTopicInvariantsForTests } from "./stateTopicKernel.ts";
import { sessionListClient } from "./test/sessionListClient.ts";
import {
  createApproval,
  resolveApproval,
  registerApprovalExecutor,
  setApprovalBroadcastForTests,
} from "./pendingApprovals.ts";
import { rotatePermanentAssistantSession } from "./permanentAssistant.ts";
let serial = 0;
function seed() {
  const id = `correction-${++serial}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    messageCount: 2,
    title: id,
  });
  return id;
}
function send(
  a: string,
  b: string,
  response = true,
  now = Date.now(),
  chainId?: string,
) {
  const chain = chainId ?? peer.createChain(`correction-chain-${++serial}`);
  return peer.enqueue(
    {
      senderSessionId: a,
      recipientSessionId: b,
      conversationId: `correction-conv-${++serial}`,
      chainId: chain,
      hop: peer.reserveHop(chain),
      prompt: "test",
      responseRequested: response,
    },
    now,
  );
}
function accept(r: ReturnType<typeof send>, now = Date.now()) {
  peer.claimOne(r.id, "correction", now);
  peer.markAdmitted(r.id, now);
  peer.markCompleted(r.id, now);
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionListAuditBaselineForTests();
  await hub.flushPendingBroadcastsForTests();
});

test("pruning a delivered handoff reports the NULL-deadline requester whose owed field returns", async () => {
  const [a, b, c] = [seed(), seed(), seed()];
  const t = Date.now() - 10000;
  // enqueue supports an absent deadline, including legacy persisted requests.
  const original = send(a, b, true, t);
  accept(original, t);
  assert.equal(peer.getById(original.id)?.expiresAt, undefined);
  const forward = send(b, c, false, t + 100);
  accept(forward, t + 100);
  const reply = send(c, a, false, t + 9000, forward.chainId);
  accept(reply, t + 9000);
  const row = () =>
    hub.listSessions({ includeArchived: true }).find((x) => x.id === a)!;
  assert.equal(row().awaitingRepliesFrom, undefined);
  await hub.flushPendingBroadcastsForTests();
  const recorder = recordSessionRowTouches();
  try {
    peer.pruneTerminal(t + 1000);
    const touched = recorder.ids();
    assert.deepEqual(row().awaitingRepliesFrom, [b]);
    assert.ok(touched.has(a), "requester changed but was not touched");
    assert.ok(touched.has(b) && touched.has(c));
  } finally {
    recorder.stop();
  }
});

test("terminal prune dependency reads seek the recipient and lost-reply indexes", () => {
  const plan = (sql: string) =>
    (
      getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all("session") as {
        detail: string;
      }[]
    )
      .map((step) => step.detail)
      .join("\n");
  assert.match(
    plan(
      "SELECT DISTINCT sender_session_id FROM peer_prompts WHERE recipient_session_id = ? AND status IN ('queued','delivered','reminded')",
    ),
    /SEARCH peer_prompts USING (?:COVERING )?INDEX peer_prompts_recipient_(?:fifo|sender_seq)_idx/,
  );
  assert.match(
    plan(
      "SELECT sender_session_id, recipient_session_id FROM peer_prompts WHERE replied_by_message_id = ?",
    ),
    /SEARCH peer_prompts USING (?:COVERING )?INDEX peer_prompts_replied_by_idx/,
  );
});

test("binding and clearing a published legacy singleton updates PUBLIC membership", async () => {
  const id = seed();
  const previous = pa.sessionId();
  const client = sessionListClient();
  try {
    await hub.flushPendingBroadcastsForTests();
    assert.ok(client.row(id));
    pa.setSessionId(id);
    await hub.flushPendingBroadcastsForTests();
    assert.equal(client.row(id), undefined);
    assert.ok(client.deleted().includes(id));
    pa.clearSessionId();
    await hub.flushPendingBroadcastsForTests();
    assert.ok(client.row(id));
  } finally {
    if (previous) pa.setSessionId(previous);
    else pa.clearSessionId();
    client.close();
  }
});

for (const mode of ["clear", "rotate"] as const)
  test(`${mode} of an unread singleton sends false once and clears the new-connection cache`, async () => {
    const id = seed();
    const sent: ServerMessage[] = [];
    const viewer = { send: (m: ServerMessage) => sent.push(m) };
    const previous = pa.sessionId();
    hub.register(viewer);
    try {
      pa.setSessionId(id);
      await hub.flushPendingBroadcastsForTests();
      assert.ok(
        sent.some((m) => m.type === "permanentAssistantUnread" && m.unread),
      );
      sent.length = 0;
      if (mode === "rotate") await rotatePermanentAssistantSession();
      else pa.clearSessionId();
      await hub.flushPendingBroadcastsForTests();
      assert.deepEqual(
        sent.filter((m) => m.type === "permanentAssistantUnread"),
        [{ type: "permanentAssistantUnread", unread: false }],
      );
      sent.length = 0;
      await hub.sendPermanentAssistantUnreadTo(viewer);
      assert.deepEqual(sent, [
        { type: "permanentAssistantUnread", unread: false },
      ]);
      sent.length = 0;
      sessionStore.touch(id);
      await hub.flushPendingBroadcastsForTests();
      assert.ok(!sent.some((m) => m.type === "permanentAssistantUnread"));
    } finally {
      if (previous) pa.setSessionId(previous);
      else pa.clearSessionId();
      hub.unregister(viewer);
    }
  });

for (const mode of ["late read", "timer"] as const)
  test(`no-repository TTL reports before the verdict changes via ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "correction-ttl-"));
    const projectId = `correction-ttl-${++serial}`;
    const id = seed();
    projectStore.put({
      id: projectId,
      name: projectId,
      key: projectId,
      description: "",
      status: "active",
      localPaths: [{ path: dir, kind: "repo", match: "prefix" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Parameters<typeof projectStore.put>[0]);
    linkSessionToWorktree(id, `main:${projectId}`);
    if (mode === "timer")
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await resolveMainWorktreeRow(projectId);
    assert.equal(sessionWorktreeMissing(id), true);
    await hub.flushPendingBroadcastsForTests();
    const recorder = recordSessionRowTouches((ids) => {
      if (ids.has(id))
        assert.equal(
          sessionWorktreeMissing(id),
          true,
          "touch precedes verdict change, including reentrant readers",
        );
    });
    try {
      if (mode === "late read")
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
      else vi.advanceTimersByTime(60000);
      const missing = sessionWorktreeMissing(id);
      const touched = recorder.ids();
      assert.equal(missing, false);
      assert.ok(touched.has(id));
      assert.equal(recorder.countFor(id), 1, "expiry reported only once");
    } finally {
      recorder.stop();
      vi.useRealTimers();
      vi.restoreAllMocks();
      clearMainRepoCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

test("public membership, not unchanged internal JSON, drives the audit and sweep", async () => {
  const [id, loud] = [seed(), seed()];
  const previous = pa.sessionId();
  const client = sessionListClient();
  const bindSilently = () =>
    getDb()
      .prepare(
        "INSERT INTO permanent_assistant_state(singleton_id,session_id,created_at_ms,updated_at_ms) VALUES(1,?,0,0) ON CONFLICT(singleton_id) DO UPDATE SET session_id=excluded.session_id",
      )
      .run(id);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await hub.flushPendingBroadcastsForTests();
    bindSilently();
    touchSessionRows([loud]);
    await assert.rejects(
      hub.flushPendingBroadcastsForTests(),
      new RegExp(`unreported session row change: ${id} .*removed`),
    );
    assert.equal(takeStateTopicInvariantsForTests().length, 1);
    // Restore and establish the same visible baseline, then exercise repair.
    if (previous) pa.setSessionId(previous);
    else pa.clearSessionId();
    resetSessionListAuditBaselineForTests();
    await hub.flushPendingBroadcastsForTests();
    client.clear();
    bindSilently();
    sweepSessionRows();
    await hub.flushPendingBroadcastsForTests();
    assert.ok(
      warn.mock.calls.some((call) =>
        String(call[0]).includes(`unreported row change: ${id}`),
      ),
    );
    assert.ok(client.deleted().includes(id));
    assert.equal(client.row(id), undefined);
  } finally {
    if (previous) pa.setSessionId(previous);
    else pa.clearSessionId();
    client.close();
    resetSessionListAuditBaselineForTests();
  }
});

test("file-only internal changes are absent from published items, audit and sweep", async () => {
  const id = seed();
  const client = sessionListClient();
  try {
    await hub.flushPendingBroadcastsForTests();
    client.clear();
    const original = mergedList.mergedSessionList;
    vi.spyOn(mergedList, "mergedSessionList").mockImplementation((opts) =>
      original(opts).map((row) =>
        row.id === id ? { ...row, file: "different-internal-file" } : row,
      ),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    sweepSessionRows();
    await hub.flushPendingBroadcastsForTests();
    assert.deepEqual(client.events(), [], "the sweep repaired nothing");
    touchSessionRows([id]);
    await hub.flushPendingBroadcastsForTests();
    assert.deepEqual(client.upserted(), [id]);
    assert.ok(!("file" in client.row(id)!));
    assert.ok(
      !warn.mock.calls.some((call) =>
        String(call[0]).includes("unreported row change"),
      ),
    );
  } finally {
    client.close();
  }
});

test("archiving a hidden row signals the archived count with no visible row change", async () => {
  const id = seed();
  const previous = pa.sessionId();
  pa.setSessionId(id);
  const client = sessionListClient();
  try {
    await hub.flushPendingBroadcastsForTests();
    const before = client.archivedCount()!;
    const visible = [...client.rows().keys()];
    client.clear();
    sessionStore.setArchived(id, true);
    await hub.flushPendingBroadcastsForTests();
    assert.deepEqual(
      client.sent.filter((m) => m.type === "archivedSessionCount"),
      [{ type: "archivedSessionCount", count: before + 1 }],
    );
    assert.deepEqual([...client.rows().keys()], visible);
  } finally {
    if (previous) pa.setSessionId(previous);
    else pa.clearSessionId();
    client.close();
  }
});

test("explicit session-write transactions touch before COMMIT, including inbox placement", () => {
  const [a, b] = [seed(), seed()];
  const checks: { action: string; inTransaction: boolean }[] = [];
  let action = "inbox";
  const recorder = recordSessionRowTouches(() =>
    checks.push({ action, inTransaction: getDb().isTransaction }),
  );
  try {
    assert.equal(
      setInboxPositions({ sessions: [{ id: a, position: 1 }], runs: [] }),
      true,
    );
    assert.equal(checks.length, 1);
    recorder.clear();
    sessionStore.setSettled(a, true, 1);
    checks.splice(1);
    action = "archiveSettledBatch";
    assert.deepEqual(sessionStore.archiveSettledBatch([a], 2), [a]);
    action = "settleWithPeers";
    assert.equal(sessionStore.settleWithPeers(a, 0, [b]), true);
    assert.deepEqual(
      checks.map((c) => c.action),
      ["inbox", "archiveSettledBatch", "settleWithPeers"],
    );
    assert.ok(checks.every((c) => c.inTransaction));
  } finally {
    recorder.stop();
  }
});

test("approval creation, supersession, reject and approve touch inside their writing transactions", async () => {
  const id = seed();
  setApprovalBroadcastForTests(() => {});
  registerApprovalExecutor("commit", {
    execute: async () => ({ resultSummary: "done" }),
  });
  const checks: boolean[] = [];
  const recorder = recordSessionRowTouches((ids) => {
    if (ids.has(id)) checks.push(getDb().isTransaction);
  });
  const create = (supersedes = false) =>
    createApproval({
      sessionId: id,
      kind: "commit",
      title: "Commit",
      body: { kind: "commit", message: "test", files: ["a.ts"] },
      ...(supersedes ? { supersedes: () => true } : {}),
    });
  try {
    create();
    const rejected = create(true);
    await resolveApproval(rejected.id, "rejected");
    const approved = create();
    await resolveApproval(approved.id, "approved");
    assert.ok(checks.length >= 6);
    assert.ok(checks.every(Boolean), "no post-COMMIT approval touch");
  } finally {
    recorder.stop();
    setApprovalBroadcastForTests(null);
  }
});
