/**
 * Standalone test for prompt idempotency + clientRequestId echo on
 * {@link ClaudeSdkSession}.
 *
 * Run through Vitest: `pnpm --filter @assistant/server test src/claudeSdk/ClaudeSdkSession.idempotency.test.ts`
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import { ClaudeSdkSession } from "./ClaudeSdkSession.ts";
import type { ClaudeSdkSeam } from "./sdkSeam.ts";

// An empty stream: the turn opens and immediately finishes.
const seam: ClaudeSdkSeam = {
  query() {
    return { async *[Symbol.asyncIterator]() {} };
  },
};

async function main(): Promise<void> {
  const session = new ClaudeSdkSession("idem-test", {
    seam: () => Promise.resolve(seam),
  });
  const envelopes: ServerMessage[] = [];
  session.addViewer({ send: (m) => envelopes.push(m) });

  const adapter = session.createRuntimeAdapter();

  // First send.
  await adapter.prompt("hello", { clientRequestId: "req-1" });
  // Duplicate send with the SAME clientRequestId — must be a no-op.
  await adapter.prompt("hello", { clientRequestId: "req-1" });

  const userMsgs = envelopes.filter(
    (e): e is Extract<ServerMessage, { type: "userMessage" }> =>
      e.type === "userMessage",
  );
  assert.equal(
    userMsgs.length,
    1,
    `expected 1 user message after a duplicate send, got ${userMsgs.length}`,
  );
  assert.equal(
    userMsgs[0]!.clientRequestId,
    "req-1",
    "userMessage echoes the clientRequestId",
  );

  // A different clientRequestId is a fresh turn.
  await adapter.prompt("again", { clientRequestId: "req-2" });
  const userMsgs2 = envelopes.filter((e) => e.type === "userMessage");
  assert.equal(
    userMsgs2.length,
    2,
    `expected 2 user messages, got ${userMsgs2.length}`,
  );

  // A send WITHOUT a clientRequestId is never deduped.
  await adapter.prompt("no-id");
  await adapter.prompt("no-id");
  const userMsgs3 = envelopes.filter((e) => e.type === "userMessage");
  assert.equal(
    userMsgs3.length,
    4,
    `un-ided sends are not deduped, got ${userMsgs3.length}`,
  );

  console.log("ClaudeSdkSession idempotency test: PASS");
}

test("deduplicates prompts by clientRequestId", async () => {
  await main();
});
