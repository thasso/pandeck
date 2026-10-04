/**
 * pi's `/clear` step (`PiLiveSession.clearContext`).
 *   pnpm --filter @assistant/server test src/piSdk/piContextClear.test.ts
 *
 * pi keeps the context in two places and a clear has to reach BOTH: the session
 * file's leaf pointer (durable — `resetLeaf` starts the next append as a new
 * root branch, deleting nothing) and `state.messages`, the array the agent
 * actually sends, which pi itself rebuilds from the branch after a compaction.
 * Missing the second one leaves a session that looks cleared and still sends
 * every old message.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "pi-clear-test-"));
process.env.ASSISTANT_CWD = tmp;

const { PiLiveSession } = await import("./PiLiveSession.ts");
const { runClearForHost } = await import("../hostSlashCommands.ts");
const { closeDb } = await import("../db/index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

interface FakeState {
  messages: unknown[];
  leafReset: number;
}

/** The AgentSession surface a `/clear` actually touches. */
function fakeAgentSession(sessionId: string, state: FakeState) {
  return {
    sessionId,
    sessionName: "Already named",
    isStreaming: false,
    state,
    get messages() {
      return state.messages;
    },
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
      getHeader: () => null,
      resetLeaf: () => {
        state.leafReset += 1;
      },
    },
    subscribe: () => () => {},
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextUsage: { tokens: 24_000, contextWindow: 200_000, percent: 12 },
    }),
    prompt: () => Promise.resolve(),
  };
}

function harness(sessionId: string, messages: unknown[]) {
  const state: FakeState = { messages, leafReset: 0 };
  const live = new PiLiveSession(
    "coding" as never,
    fakeAgentSession(sessionId, state) as never,
    {
      broadcastSessions: () => Promise.resolve(),
      noteRunStarted: () => {},
      checkPendingReload: () => {},
      isReloadQueued: () => false,
      browserRuntimesFor: () => [],
    } as never,
    () => {},
  );
  const seen: ServerMessage[] = [];
  live.addViewer({ send: (m: ServerMessage) => seen.push(m) });
  return { live, state, seen };
}

test("pi /clear resets the session leaf AND empties the live context", async () => {
  const h = harness("pi-clear", [{ role: "user" }, { role: "assistant" }]);
  const outcome = await h.live.clearContext();
  assert.equal(outcome.kind, "cleared");
  if (outcome.kind !== "cleared") return;
  assert.equal(
    outcome.tokensBefore,
    24_000,
    "the context size measured before the clear is reported",
  );
  assert.equal(h.state.leafReset, 1, "the durable leaf pointer was reset");
  assert.deepEqual(
    h.state.messages,
    [],
    "the messages the agent would send are gone",
  );
});

test("pi /clear renders the boundary card as one synthetic turn", async () => {
  const h = harness("pi-clear-card", [{ role: "user" }]);
  const { assistantId } = h.live.beginSyntheticTool("/clear", {
    command: "/clear",
  });
  const outcome = await h.live.clearContext();
  assert.equal(outcome.kind, "cleared");
  h.live.finishSyntheticCard({
    kind: "contextClear",
    contextClear: { tokensBefore: 24_000 },
  });
  const types = h.seen.map((m) => m.type);
  assert.ok(
    types.includes("contextClearResult"),
    `contextClearResult present: ${types.join(",")}`,
  );
  for (const message of h.seen)
    if (message.type === "contextClearResult") {
      assert.equal(message.id, assistantId, "the card owns the synthetic turn");
      assert.equal(message.contextClear.tokensBefore, 24_000);
    }
});

test("the /clear runner clears a real pi session instead of refusing its own turn", async () => {
  // `beginSyntheticTool` marks the session running for the turn it opens, so a
  // runner that reads that flag afterwards never reaches the harness at all —
  // invisible to a fake host with a stubbed begin.
  const h = harness("pi-clear-runner", [{ role: "user" }]);
  await runClearForHost(h.live);
  const cards = h.seen.filter((m) => m.type === "contextClearResult");
  assert.equal(cards.length, 1, "the runner rendered the boundary card");
  assert.equal(h.state.leafReset, 1, "the context was really cleared");
  assert.deepEqual(h.state.messages, [], "the live context is empty");
  assert.equal(h.live.isRunning, false, "the synthetic turn was closed");
});

test("the /clear runner refuses a streaming pi session", async () => {
  const h = harness("pi-clear-busy", [{ role: "user" }]);
  h.live.beginSyntheticTool("/other", { command: "/other" });
  await assert.rejects(
    runClearForHost(h.live),
    /while the agent is streaming/i,
    "the harness's own refusal reaches the dispatcher",
  );
  assert.equal(
    h.state.leafReset,
    0,
    "the refused clear left the context alone",
  );
});

test("pi /clear on a session with no context is skipped", async () => {
  const h = harness("pi-clear-empty", []);
  const outcome = await h.live.clearContext();
  assert.equal(outcome.kind, "skipped", "nothing to clear");
  assert.equal(h.state.leafReset, 0, "the session file is left alone");
});
