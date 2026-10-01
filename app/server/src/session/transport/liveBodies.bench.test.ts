/**
 * Deterministic wire-cost fixture for the live-body projection: a session with
 * a 130-row window and an active turn carrying ~500 KiB of thinking and tool
 * bodies. It measures what a viewer receives — the attach snapshot's streaming
 * state, and the frames of the live turn — against what the runtime emits
 * (which is what the transport relayed verbatim before Task 697), and pins the
 * ratio so a regression that puts bodies back on the wire fails here.
 *
 *   pnpm --filter @assistant/server test src/session/transport/liveBodies.bench.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type {
  ContextInfo,
  ServerMessage,
  SessionState,
} from "@assistant/shared";
import type { AdapterEvent } from "../adapters/contract.ts";
import type { LogEntryDraft } from "../log/store.ts";
import type { RuntimeEvent } from "../runtime/events.ts";

const tmp = mkdtempSync(join(tmpdir(), "live-bodies-bench-"));
process.env.ASSISTANT_CWD = tmp;

const { RuntimeTransport } = await import("./gateway.ts");
const { SessionRuntime } = await import("../runtime/runtime.ts");
const { SessionLogStore } = await import("../log/store.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const stubState = () => ({ sessionId: "b" }) as unknown as SessionState;
const stubContext = () => ({ sessionId: "b" }) as unknown as ContextInfo;

/** A seeded generator, so every run measures the same bytes. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function prose(random: () => number, chars: number): string {
  const words = [
    "the",
    "session",
    "renders",
    "tool",
    "output",
    "thinking",
    "\n",
  ];
  let out = "";
  while (out.length < chars)
    out += `${words[Math.floor(random() * words.length)]} `;
  return out.slice(0, chars);
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

describe("live body wire cost", () => {
  test("a 130-row window with ~500 KiB of live bodies ships compact", async () => {
    const random = rng(697);
    const store = new SessionLogStore(true);
    const log = store.open("b");
    let listener: ((event: AdapterEvent) => void) | undefined;
    const adapter = {
      provider: "fake",
      capabilities: { fork: "none", compact: false, attachments: false },
      subscribe(fn: (event: AdapterEvent) => void) {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
      getBinding() {
        return { provider: "fake" };
      },
      async prompt() {
        return { stopReason: "end" };
      },
      abort() {},
      setModel() {},
      async setReasoning() {},
      dispose() {},
    };
    // 130 durable rows: 26 turns of prompt, assistant (thinking + 2 calls),
    // 2 results and a closing answer, bodies sized like a real coding session.
    for (let turn = 0; turn < 26; turn += 1) {
      log.append({
        type: "message",
        role: "user",
        origin: { kind: "human" },
        content: [{ type: "text", text: `prompt ${turn}` }],
      } as LogEntryDraft);
      log.append({
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", text: prose(random, 1500) },
          { type: "text", text: prose(random, 300) },
          {
            type: "toolCall",
            toolCallId: `t${turn}a`,
            name: "bash",
            input: { command: "ls" },
          },
          {
            type: "toolCall",
            toolCallId: `t${turn}b`,
            name: "Write",
            input: { file_path: "/x", content: prose(random, 3000) },
          },
        ],
      } as LogEntryDraft);
      log.append({
        type: "message",
        role: "toolResult",
        toolCallId: `t${turn}a`,
        content: [{ type: "text", text: prose(random, 4000) }],
      } as LogEntryDraft);
      log.append({
        type: "message",
        role: "toolResult",
        toolCallId: `t${turn}b`,
        content: [{ type: "text", text: "ok" }],
      } as LogEntryDraft);
      log.append({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: prose(random, 600) }],
      } as LogEntryDraft);
    }
    const runtime = new SessionRuntime(store);
    const session = runtime.createSession("b", adapter as never);

    // The active turn: what the runtime emits (verbatim = the old wire) and what
    // the viewer now receives, side by side.
    const emitted: RuntimeEvent[] = [];
    session.subscribe((event) => emitted.push(event));
    const received: ServerMessage[] = [];
    const transport = new RuntimeTransport(
      "b",
      session,
      { send: (m) => received.push(m) },
      { buildState: stubState, buildContextInfo: stubContext },
    );
    transport.attach();
    // A second viewer that reads both bodies as they stream: the price of
    // watching is the bodies themselves, not the old cumulative re-sends.
    const watching: ServerMessage[] = [];
    const watcher = new RuntimeTransport(
      "b",
      session,
      { send: (m) => watching.push(m) },
      { buildState: stubState, buildContextInfo: stubContext },
    );
    watcher.attach();
    const emit = (event: AdapterEvent) => listener?.(event);
    emit({ type: "messageStarted", streamId: "m" });
    let thinking = "";
    while (thinking.length < 300_000) {
      const delta = prose(random, 400);
      thinking += delta;
      emit({
        type: "messageDelta",
        streamId: "m",
        delta: { kind: "thinking", text: delta },
      });
      if (thinking.length === delta.length)
        watcher.setLiveBodySubscriptions([
          { streamId: "m", blockIndex: 0, kind: "thinking" },
        ]);
    }
    emit({
      type: "toolStarted",
      streamId: "t",
      toolCallId: "t",
      name: "bash",
      input: { command: "make" },
    });
    watcher.setLiveBodySubscriptions([
      { streamId: "m", blockIndex: 0, kind: "thinking" },
      { streamId: "t", blockIndex: 0, kind: "toolOutput" },
    ]);
    let output = "";
    while (output.length < 200_000) {
      output += prose(random, 2000);
      emit({ type: "toolUpdated", streamId: "t", output });
    }
    emit({
      type: "passthrough",
      envelope: {
        type: "toolEnd",
        sessionId: "b",
        id: "m",
        toolId: "t",
        output,
        isError: false,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));

    const verbatimTurn = emitted.reduce((sum, event) => sum + bytes(event), 0);
    const receivedTurn = received
      .filter((m) => m.type === "event")
      .reduce((sum, m) => sum + bytes(m), 0);
    const watchedTurn = watching
      .filter((m) => m.type === "event")
      .reduce((sum, m) => sum + bytes(m), 0);

    // Reconnect mid-turn: the streaming state a viewer gets, old vs new.
    const late: ServerMessage[] = [];
    new RuntimeTransport(
      "b",
      session,
      { send: (m) => late.push(m) },
      { buildState: stubState, buildContextInfo: stubContext },
    ).attach();
    const snapshot = late[0];
    if (snapshot?.type !== "snapshot") throw new Error("no snapshot");
    const verbatimStreaming = bytes(session.getSnapshot().streaming);
    const compactStreaming = bytes(snapshot.snapshot.streaming);
    const timelineBytes = bytes(snapshot.snapshot.timeline);

    const report = {
      windowEntries: snapshot.snapshot.timeline.length,
      timelineKiB: Math.round(timelineBytes / 1024),
      liveBodiesKiB: Math.round((thinking.length + output.length) / 1024),
      streamingKiB: {
        verbatim: Math.round(verbatimStreaming / 1024),
        compact: Math.round(compactStreaming / 1024),
      },
      liveTurnKiB: {
        verbatim: Math.round(verbatimTurn / 1024),
        hidden: Math.round(receivedTurn / 1024),
        watched: Math.round(watchedTurn / 1024),
      },
    };
    // Written so a run leaves the numbers behind for the change record.
    process.stderr.write(`live body wire cost: ${JSON.stringify(report)}\n`);

    expect(report.windowEntries).toBe(130);
    expect(report.liveBodiesKiB).toBeGreaterThanOrEqual(488);
    expect(compactStreaming).toBeLessThan(2_000);
    expect(receivedTurn).toBeLessThan(verbatimTurn / 20);
    // Watching costs the bodies once (plus framing), never the re-sends.
    expect(watchedTurn).toBeLessThan((thinking.length + output.length) * 1.5);

    await runtime.dispose();
  }, 30_000);
});
