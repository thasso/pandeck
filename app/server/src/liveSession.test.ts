/**
 * `LiveSession` (`harness.ts`): what tells a resident session from a storage
 * view, and the neutral surface app code drives a session through.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeSdkSession } from "./claudeSdk/ClaudeSdkSession.ts";
import type { ClaudeSdkSeam } from "./claudeSdk/sdkSeam.ts";
import { isLiveSession, type LiveSession } from "./harness.ts";

const idleSeam: ClaudeSdkSeam = {
  query: () => ({
    async *[Symbol.asyncIterator]() {
      // A session under test never runs a turn.
    },
  }),
};

test("only a driver that says it is live counts as a resident session", () => {
  assert.equal(isLiveSession({ live: true }), true);
  for (const value of [{ live: false }, {}, null, undefined, "live", true])
    assert.equal(isLiveSession(value), false, JSON.stringify(value));
});

test("a Claude session is driven through the neutral surface", () => {
  const session = new ClaudeSdkSession("live-session-test", {
    modelId: "opus",
    thinkingLevel: "high",
    seam: () => Promise.resolve(idleSeam),
  });

  assert.equal(isLiveSession(session), true);
  assert.deepEqual(session.modelSelection(), {
    model: { provider: "claude-sdk", id: "opus" },
    thinkingLevel: "high",
  });
  const live: LiveSession = session;
  assert.equal(live.acceptCommitDryRun, undefined, "only pi has dry runs");

  session.setMode("plan");
  assert.equal(session.sessionMode, "plan");
  session.dispose();
});
