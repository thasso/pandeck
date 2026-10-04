/**
 * `LiveSession` (`harness.ts`): what tells a resident session from a storage
 * view, and the neutral surface app code drives a session through.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { ClaudeSdkSeam } from "./claudeSdk/sdkSeam.ts";
import type { LiveSession } from "./harness.ts";

const tmp = mkdtempSync(join(tmpdir(), "live-session-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { ClaudeSdkSession } = await import("./claudeSdk/ClaudeSdkSession.ts");
const { PiLiveSession } = await import("./piSdk/PiLiveSession.ts");
const { isLiveSession } = await import("./harness.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

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

function fakeAgentSession(selection: {
  model?: { provider: string; id: string };
  thinkingLevel?: string;
}) {
  return {
    sessionId: "pi-model-selection",
    sessionName: "Named",
    ...selection,
    isStreaming: false,
    sessionManager: { getBranch: () => [] },
    subscribe: () => () => {},
    dispose: () => {},
  };
}

function piSession(selection: Parameters<typeof fakeAgentSession>[0]) {
  return new PiLiveSession(
    "assistant" as never,
    fakeAgentSession(selection) as never,
    {} as never,
    () => {},
  );
}

test("a pi session names its model and thinking level only when it has them", () => {
  const session = piSession({
    model: { provider: "openai-codex", id: "gpt-5" },
    thinkingLevel: "low",
  });
  assert.equal(isLiveSession(session), true);
  assert.deepEqual(session.modelSelection(), {
    model: { provider: "openai-codex", id: "gpt-5" },
    thinkingLevel: "low",
  });
  assert.deepEqual(piSession({}).modelSelection(), {});
});

test("a session shows as its live title, and a pi session as pi's name without one", () => {
  const pi = piSession({});
  pi.title = undefined;
  assert.equal(pi.sessionTitle, "Named");
  pi.title = "Fix the build";
  assert.equal(pi.sessionTitle, "Fix the build");

  const claude = new ClaudeSdkSession("live-session-title", {
    seam: () => Promise.resolve(idleSeam),
  });
  claude.title = "Plan the release";
  const live: LiveSession = claude;
  assert.equal(live.sessionTitle, "Plan the release");
  claude.dispose();
});
