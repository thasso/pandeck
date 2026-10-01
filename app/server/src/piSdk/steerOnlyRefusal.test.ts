/**
 * What a viewer sees when a `steerOnly` prompt is refused.
 *   pnpm --filter @assistant/server test src/piSdk/steerOnlyRefusal.test.ts
 *
 * A refused steer is expected control flow, not a provider failure: the adapter
 * reports `steered: false` and background delivery retries. So it must produce
 * NO user bubble, NO error banner, and no synthetic assistant turn — the last
 * two being the reason this test exists rather than a bubble-ordering assertion.
 * `finishPromptError` posts a banner unconditionally and, once the original turn
 * has cleared, manufactures an assistant error turn plus adapter events for a
 * message that was never sent.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "steer-refusal-test-"));
process.env.ASSISTANT_CWD = tmp;

const { PiLiveSession } = await import("./PiLiveSession.ts");
const { closeDb } = await import("../db/index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/** The AgentSession surface a steering `prompt()` actually touches. */
function fakeAgentSession(sessionId: string, steer: () => Promise<void>) {
  return {
    sessionId,
    // A named session skips auto-naming, which would otherwise run detached and
    // fail on infrastructure that has nothing to do with steering.
    sessionName: "Already named",
    isStreaming: true,
    sessionManager: { getBranch: () => [] },
    subscribe: () => () => {},
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextSize: 0,
    }),
    steer,
    prompt: () => Promise.resolve(),
  };
}

function host() {
  return {
    broadcastSessions: () => Promise.resolve(),
    noteRunStarted: () => {},
    checkPendingReload: () => {},
    isReloadQueued: () => false,
    browserRuntimesFor: () => [],
  };
}

/**
 * Drive through the REAL adapter seam rather than the private prompt method:
 * the behaviour under test spans the adapter's outcome mapping and the live
 * session's broadcast, and only the pair together says what a viewer sees.
 */
function harness(sessionId: string, steer: () => Promise<void>) {
  const seen: ServerMessage[] = [];
  let steerCalls = 0;
  const live = new PiLiveSession(
    "coding" as never,
    fakeAgentSession(sessionId, () => {
      steerCalls += 1;
      return steer();
    }) as never,
    host() as never,
    () => {},
  );
  live.addViewer({ send: (m: ServerMessage) => seen.push(m) });
  return {
    adapter: live.createRuntimeAdapter(),
    seen,
    steerCalls: () => steerCalls,
  };
}

const kinds = (seen: ServerMessage[]): string[] =>
  seen.map((m) => (m as { type: string }).type);

test("a refused steerOnly prompt shows nothing at all to the viewer", async () => {
  const h = harness("pi-refused", () =>
    Promise.reject(new Error("Cannot steer while idle")),
  );
  const { adapter, seen } = h;

  const result = await adapter.prompt("Background work updated.", {
    steer: true,
    steerOnly: true,
    clientRequestId: "bg:steer",
  });
  // `promptSteerOnly` also answers `steered: false` when the driver THROWS, so
  // without this the test would pass on an unrelated harness defect rather than
  // on pi's refusal — which is exactly how an earlier version of it fooled me.
  assert.equal(h.steerCalls(), 1, "pi was actually asked to steer");
  assert.equal(
    result.steered,
    false,
    "the refusal reaches the adapter as an honest not-delivered",
  );
  // Let any rejection handlers run before asserting on what was broadcast.
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(
    !kinds(seen).includes("userMessage"),
    "no bubble for a message that was never sent",
  );
  assert.ok(
    !seen.some(
      (m) =>
        (m as { type: string; severity?: string }).type === "notice" &&
        (m as { severity?: string }).severity === "error",
    ),
    "an expected refusal is not a provider error banner",
  );
  assert.ok(
    !kinds(seen).some((t) => t.startsWith("assistant")),
    "and it never manufactures a synthetic assistant turn",
  );
});

test("an accepted steerOnly prompt shows its bubble once pi takes it", async () => {
  let accept!: () => void;
  const { adapter, seen } = harness(
    "pi-accepted",
    () => new Promise<void>((resolve) => (accept = resolve)),
  );

  const pending = adapter.prompt("Background work updated.", {
    steer: true,
    steerOnly: true,
    clientRequestId: "bg:steer",
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(
    !kinds(seen).includes("userMessage"),
    "the bubble waits for acceptance rather than appearing optimistically",
  );

  accept();
  assert.equal((await pending).steered, true);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(
    kinds(seen).includes("userMessage"),
    "and appears once pi has taken the message",
  );
});

test("a peer prompt waits for agent_settled across a pi retry", async () => {
  let listener: ((event: unknown) => void) | undefined;
  let streaming = false;
  let promptCalls = 0;
  let steerCalls = 0;
  const nativeRuns: Array<() => void> = [];
  const native = {
    sessionId: "pi-agent-settled-boundary",
    sessionName: "Already named",
    get isStreaming() {
      return streaming;
    },
    sessionManager: { getBranch: () => [] },
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => {};
    },
    getSessionStats: () => ({
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextSize: 0,
    }),
    prompt: () => {
      promptCalls += 1;
      streaming = true;
      return new Promise<void>((resolve) => nativeRuns.push(resolve));
    },
    abort: async () => {
      streaming = false;
    },
    steer: () => {
      steerCalls += 1;
      return Promise.resolve();
    },
  };
  const live = new PiLiveSession(
    "coding" as never,
    native as never,
    host() as never,
    () => {},
  );
  const adapter = live.createRuntimeAdapter();
  let firstSettled = false;
  let completedMessages = 0;
  let completedRuns = 0;
  let peerTurn: ReturnType<typeof adapter.prompt> | undefined;
  adapter.subscribe((event) => {
    if (event.type === "messageCompleted") completedMessages += 1;
    if (event.type !== "runCompleted") return;
    completedRuns += 1;
    if (peerTurn) return;
    // The production drain crosses an async acquisition boundary before it
    // prompts; do not re-enter PiAdapter while it is resolving the prior run.
    queueMicrotask(() => {
      peerTurn = adapter.prompt("Peer follow-up");
    });
  });

  const firstTurn = adapter.prompt("First turn").then((value) => {
    firstSettled = true;
    return value;
  });
  listener?.({ type: "agent_start" });
  listener?.({ type: "agent_end", willRetry: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    firstSettled,
    false,
    "an intermediate retry is not runtime idle",
  );
  assert.equal(completedMessages, 1, "the failed attempt keeps its own entry");
  assert.equal(completedRuns, 0, "the logical pi run remains open for retry");
  assert.equal(
    promptCalls,
    1,
    "the peer prompt has not started during backoff",
  );

  listener?.({ type: "agent_start" });
  listener?.({ type: "agent_end", willRetry: false });
  streaming = false;
  listener?.({ type: "agent_settled" });
  nativeRuns.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(promptCalls, 2, "the peer prompt starts at true native idle");
  assert.equal(steerCalls, 0, "it is not steered into the retrying turn");

  listener?.({ type: "agent_start" });
  listener?.({ type: "agent_end", willRetry: true });
  assert.equal(completedMessages, 3, "the peer's failed attempt is persisted");
  assert.equal(completedRuns, 1, "its retrying run is still open");

  await live.abort();
  listener?.({ type: "agent_settled" });
  nativeRuns.shift()?.();
  await firstTurn;
  await peerTurn;
  assert.equal(
    completedMessages,
    3,
    "settling between attempts does not duplicate the failed attempt",
  );
  assert.equal(completedRuns, 2, "the cancelled retry completes its run");
});
