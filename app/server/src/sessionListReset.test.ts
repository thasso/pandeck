/** Test-owned resets must report the same public changes as production writers. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import { hub } from "./hub.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { directPeerChildStore } from "./db/directPeerChildStore.ts";
import { insertWorktree, linkSessionToWorktree } from "./db/worktreeStore.ts";
import { touchSessionRows } from "./db/sessionListChanges.ts";
import { recordSessionRowTouches } from "./test/sessionRowTouches.ts";
import { publicSessionRows } from "./test/sessionListPublicOracle.ts";
import { sessionRowIn, sessionTopicViewer } from "./test/sessionListClient.ts";
import {
  admitDirectPeerTurns,
  recordDirectPeerChild,
  resetDirectPeerChildrenForTests,
} from "./peerSpawnRuntimes.ts";
import {
  checkPresence,
  flushPresenceForTests,
  resetPresenceForTests,
} from "./worktrees/checkoutPresence.ts";
import { DEFAULT_WORKER_SIDE } from "./workers/placement.ts";

let serial = 0;
function seed(messageCount = 2) {
  const id = `reset-row-${++serial}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    title: id,
    messageCount,
  });
  return id;
}
afterEach(async () => {
  await hub.flushPendingBroadcastsForTests();
});

for (const reset of [
  directPeerChildStore.clearForTests,
  resetDirectPeerChildrenForTests,
])
  test(`${reset.name} reports removal of an already-published zero-message child`, async () => {
    const parent = seed();
    const child = seed(0);
    recordDirectPeerChild({
      childSessionId: child,
      spawnerSessionId: parent,
      costClass: "counted",
      source: { kind: "profile", profileId: "test-profile" },
      provider: "test",
      modelId: "test",
      thinkingLevel: "off",
      credentialProfileId: "test-profile",
      createdAt: Date.now(),
    });
    await hub.flushPendingBroadcastsForTests();
    assert.ok((await publicSessionRows()).has(`default:${child}`));
    const reports = recordSessionRowTouches();
    try {
      reset();
      assert.ok(
        reports.ids().has(child),
        "reset reports synchronously before returning",
      );
      assert.equal(
        reports.touchAlls.length,
        0,
        "reset names its affected rows",
      );
    } finally {
      reports.stop();
    }
    assert.ok(!(await publicSessionRows()).has(`default:${child}`));
    const sent: ServerMessage[] = [];
    const viewer = sessionTopicViewer(sent);
    hub.register(viewer);
    try {
      touchSessionRows([parent]);
      await hub.flushPendingBroadcastsForTests();
      assert.equal(sessionRowIn(sent, child), null, "published as a delete");
      touchSessionRows([parent]);
      await hub.flushPendingBroadcastsForTests();
    } finally {
      hub.unregister(viewer);
    }
  });

test("resetDirectPeerChildrenForTests reports held siblings losing in-flight tickets", async () => {
  const [parent, older, younger] = [seed(), seed(), seed()];
  const chainId = peerPromptStore.createChain("reset-held");
  const hold = (recipientSessionId: string) =>
    peerPromptStore.enqueueRouted({
      senderSessionId: parent,
      recipientSessionId,
      chainId,
      conversationId: `reset-${++serial}`,
      fallbackChainId: `reset-fallback-${serial}`,
      participants: [parent, recipientSessionId],
      maxHops: 100,
      prompt: "held",
      responseRequested: false,
      held: { queueSeq: peerPromptStore.allocateQueueSeq() },
    });
  hold(older);
  const claim = await admitDirectPeerTurns(parent, ["counted"]);
  const ticket = claim.rows[0]!;
  assert.ok("holdSeq" in ticket);
  hold(younger);
  peerPromptStore.cancelHeldTo(older, "withdraw");
  await hub.flushPendingBroadcastsForTests();
  assert.deepEqual(
    (await publicSessionRows()).get(`default:${younger}`)?.waitingForSlot,
    { position: 2 },
  );
  const reports = recordSessionRowTouches();
  try {
    resetDirectPeerChildrenForTests();
    assert.ok(reports.ids().has(younger));
  } finally {
    reports.stop();
    claim.release();
  }
  assert.deepEqual(
    (await publicSessionRows()).get(`default:${younger}`)?.waitingForSlot,
    { position: 1 },
  );
  touchSessionRows([parent]);
  await hub.flushPendingBroadcastsForTests();
});

test("resetPresenceForTests reports published missing-worktree rows before returning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reset-presence-"));
  const id = `reset-worktree-${++serial}`;
  const session = seed();
  insertWorktree({
    id,
    projectId: "reset",
    mainRepoRoot: tmpdir(),
    path: dir,
    branch: "feature",
    baseBranch: "main",
    baseCommit: "abc",
    status: "active",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  });
  linkSessionToWorktree(session, id);
  rmSync(dir, { recursive: true, force: true });
  try {
    assert.equal(await checkPresence(DEFAULT_WORKER_SIDE, dir), false);
    await hub.flushPendingBroadcastsForTests();
    assert.equal(
      (await publicSessionRows()).get(`default:${session}`)?.worktreeMissing,
      true,
    );
    await flushPresenceForTests();
    mkdirSync(dir);
    const reports = recordSessionRowTouches();
    try {
      resetPresenceForTests();
      assert.ok(
        reports.ids().has(session),
        "absence removal reports synchronously",
      );
      assert.equal(reports.touchAlls.length, 0);
    } finally {
      reports.stop();
    }
    assert.equal(
      (await publicSessionRows()).get(`default:${session}`)?.worktreeMissing,
      undefined,
    );
    touchSessionRows([seed()]);
    await hub.flushPendingBroadcastsForTests();
    await flushPresenceForTests();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
