/**
 * Unit test for runtime attachment assembly. Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/session/attach.test.ts
 *
 * Verifies that attachRuntimeView
 * wires an existing Claude SDK session through runtime + transport to a viewer
 * (snapshot + deltas), driving the run via the returned handle without
 * duplicating the session.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, SessionState } from "@assistant/shared";
import type {
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
} from "../claudeSdk/sdkSeam.ts";

const tmp = mkdtempSync(join(tmpdir(), "attach-test-"));
process.env.ASSISTANT_CWD = tmp;
const { attachRuntimeView } = await import("./attach.ts");
const { SessionRuntime } = await import("./runtime/runtime.ts");
const { SessionLogStore } = await import("./log/store.ts");
const { ClaudeSdkSession } = await import("../claudeSdk/ClaudeSdkSession.ts");

/* --------------------------- scripted seam ------------------------------- */
function scripted(): ClaudeSdkMessage[] {
  const stream = (event: unknown): ClaudeSdkMessage =>
    ({
      type: "stream_event",
      event,
      parent_tool_use_id: null,
      uuid: `e${Math.random()}`,
      session_id: "s1",
    }) as unknown as ClaudeSdkMessage;
  return [
    stream({ type: "message_start", message: { id: "m1" } }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi there" },
    }),
    stream({ type: "content_block_stop", index: 0 }),
    {
      type: "assistant",
      uuid: "a1",
      session_id: "s1",
      message: {
        id: "m1",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "hi there" }],
        usage: { input_tokens: 5 },
      },
    } as unknown as ClaudeSdkMessage,
    {
      type: "result",
      subtype: "success",
      session_id: "s1",
      usage: { input_tokens: 5 },
      total_cost_usd: 0,
    } as unknown as ClaudeSdkMessage,
  ];
}
function fakeSeam(messages: ClaudeSdkMessage[]): ClaudeSdkSeam {
  return {
    query: (_p: ClaudeQueryParams) => ({
      async *[Symbol.asyncIterator]() {
        for (const m of messages) yield m;
      },
    }),
  };
}

/* --------------------- attach an existing session ------------------------ */
{
  const runtime = new SessionRuntime(new SessionLogStore(true));
  const hubSession = new ClaudeSdkSession("cs", {
    seam: async () => fakeSeam(scripted()),
  });
  const sent: ServerMessage[] = [];
  const view = attachRuntimeView(
    runtime,
    "cs",
    hubSession,
    { send: (m) => sent.push(m) },
    { buildState: () => ({ sessionId: "cs" }) as unknown as SessionState },
  );

  assert.equal(
    sent[0]?.type,
    "snapshot",
    "attach sends the atomic snapshot first",
  );

  await view.prompt("hello", { clientRequestId: "r1" });

  const events = sent
    .filter(
      (m): m is Extract<ServerMessage, { type: "event" }> => m.type === "event",
    )
    .map((m) => m.event);
  assert.ok(
    events.some(
      (e) =>
        e.type === "timelineDelta" &&
        e.entries.some(
          (entry) => entry.type === "message" && entry.role === "user",
        ),
    ),
    "user entry relayed",
  );
  assert.ok(
    events.some((e) => e.type === "messageStarted") &&
      events.some((e) => e.type === "messageDelta") &&
      events.some((e) => e.type === "messageCompleted"),
    "assistant streaming relayed",
  );
  // The runtime drove the run on the SAME hub session (no duplicate): its snapshot reflects the turn.
  assert.equal(
    runtime
      .get("cs")!
      .getSnapshot()
      .entries.filter((e) => e.role === "assistant").length,
    1,
    "one assistant entry in the runtime log",
  );

  /* ----- durable host-command card: /commit survives reconnect (gap 1) ----- */
  // Drive a synthetic /commit turn on the hub session; the adapter observes its
  // envelopes. The card must (a) render LIVE and (b) re-appear on a fresh attach
  // (reconnect), WITHOUT leaving a dangling "/commit" assistant/tool entry.
  hubSession.beginSyntheticTool("/commit", { command: "/commit" });
  hubSession.finishSyntheticCommit({
    renderKind: "commit",
    commitHash: "abc1234",
    status: "committed",
  } as never);

  const liveEvents = sent
    .filter(
      (m): m is Extract<ServerMessage, { type: "event" }> => m.type === "event",
    )
    .map((m) => m.event);
  assert.ok(
    liveEvents.some(
      (e) => e.type === "passthrough" && e.envelope.type === "commitResult",
    ),
    "commit card forwarded LIVE via passthrough",
  );
  assert.ok(
    liveEvents.some((e) => e.type === "hostCommandAppended"),
    "durable host-command card appended",
  );

  // The runtime log holds exactly ONE assistant entry (the prompt turn), not a
  // second dangling one from the synthetic /commit wrapper.
  assert.equal(
    runtime
      .get("cs")!
      .getSnapshot()
      .entries.filter((e) => e.role === "assistant").length,
    1,
    "synthetic /commit did not add a dangling assistant conversation entry",
  );

  // Reconnect: a fresh transport's snapshot history must include the commit card.
  const reconnectSent: ServerMessage[] = [];
  const reconnect = attachRuntimeView(
    runtime,
    "cs",
    hubSession,
    { send: (m) => reconnectSent.push(m) },
    { buildState: () => ({ sessionId: "cs" }) as unknown as SessionState },
  );
  const snap = reconnectSent[0];
  assert.ok(
    snap?.type === "snapshot" && snap.snapshot,
    "reconnect gets a native snapshot",
  );
  const commitEntry = (
    snap as Extract<ServerMessage, { type: "snapshot" }>
  ).snapshot!.timeline.find((e) => e.type === "command.result");
  assert.ok(
    commitEntry,
    "reconnect snapshot timeline re-shows the durable /commit card",
  );

  reconnect.detach();
  view.detach();
  await runtime.dispose();
}

rmSync(tmp, { recursive: true, force: true });
console.log("runtime attachment test: PASS");

test("assembles runtime-backed Claude SDK attachment flow", () => {
  // Assertions run during module evaluation to preserve the former standalone script structure.
});
