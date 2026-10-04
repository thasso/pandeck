/**
 * The session list carries who still owes each session a reply — the fact the
 * browser reads to tell a stalled tree from a finished one.
 *   pnpm --filter @assistant/server test src/sessionListAwaitingReplies.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { listSessions } from "./sessions.ts";

test("a session row lists the peers it awaits a reply from", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const coordinator = `awaits-root-${stamp}`;
  const reviewer = `awaits-rev-${stamp}`;
  for (const id of [coordinator, reviewer])
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "assistant",
      title: id,
      messageCount: 2,
    });
  const chainId = peerPromptStore.createChain(`chain-${stamp}`);
  const request = peerPromptStore.enqueue({
    conversationId: `conv-${stamp}`,
    chainId,
    hop: peerPromptStore.reserveHop(chainId),
    senderSessionId: coordinator,
    recipientSessionId: reviewer,
    prompt: "review this",
    responseRequested: true,
  });
  const row = async (id: string) =>
    (await listSessions([], () => Date.now())).find((item) => item.id === id);
  try {
    // Still being delivered: nothing is owed yet.
    assert.equal((await row(coordinator))?.awaitingRepliesFrom, undefined);
    // Delivered, and the turn ended without the answer: now it is owed.
    peerPromptStore.claimNext(reviewer, "drainer", 1_000);
    peerPromptStore.markAdmitted(request.id);
    peerPromptStore.markCompleted(request.id);
    assert.ok(await row(coordinator), "the coordinator is listed");
    assert.deepEqual((await row(coordinator))?.awaitingRepliesFrom, [reviewer]);
    assert.equal((await row(reviewer))?.awaitingRepliesFrom, undefined);
    // Answered: nothing is owed any more.
    peerPromptStore.markReplied(request.id, "reply");
    assert.equal((await row(coordinator))?.awaitingRepliesFrom, undefined);
  } finally {
    for (const id of [coordinator, reviewer]) sessionStore.remove(id);
  }
});
