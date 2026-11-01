import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { WorkerMethodError } from "../workerProtocol/connection.ts";
import type { HostedEngineItem } from "../workerProtocol/engineMethods.ts";
import type { PiEngineHandle } from "./piEngine.ts";
import {
  STEER_NOT_TAKEN,
  hostPiEngine,
  hostedPiEngine,
} from "./piEngineHosted.ts";

/**
 * The hosted pi engine over a scripted local handle: what it emits and how it
 * reconciles a submit, without pi.
 */

interface Entry {
  type: string;
  id: string;
  parentId: string | null;
}

function scriptedLocal() {
  const listeners: Array<(event: AgentSessionEvent) => void> = [];
  const header = { type: "session", id: "sid" };
  const entries: Entry[] = [];
  const calls: unknown[][] = [];
  let leafId: string | null = null;
  let statsReads = 0;
  const state = {
    isStreaming: false,
    sessionName: undefined as string | undefined,
  };
  const append = (type: string) => {
    const entry = { type, id: `e${entries.length + 1}`, parentId: leafId };
    entries.push(entry);
    leafId = entry.id;
    return entry.id;
  };
  const run = (
    disposition: Promise<"steered" | "started">,
    settled: Promise<void>,
  ) => {
    disposition.catch(() => {});
    settled.catch(() => {});
    return { disposition, settled };
  };
  const local = {
    sessionId: "sid",
    sessionFile: "/tmp/sid.jsonl",
    get isStreaming() {
      return state.isStreaming;
    },
    get sessionName() {
      return state.sessionName;
    },
    model: undefined,
    thinkingLevel: "off",
    stats: () => {
      statsReads += 1;
      return { totalMessages: entries.length } as never;
    },
    contextMessageCount: () => entries.length,
    skills: () => [],
    transcript: {
      getSessionId: () => "sid",
      getHeader: () => header as never,
      getEntries: () => [...entries] as never,
      getEntry: (id: string) => entries.find((e) => e.id === id) as never,
      getBranch: () => [] as never,
      getLeafId: () => leafId,
    },
    compactionWindowStatus: () => ({
      live: { applied: "pending", pendingReason: "next-turn" },
    }),
    toolSessionManager: () => ({
      getSessionId: () => "sid",
      getBranch: () => [] as never,
      getEntry: () => undefined,
      appendCustomEntry: async (type: string) => append(type),
    }),
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    submit(...args: unknown[]) {
      calls.push(["submit", ...args]);
      return run(Promise.resolve("started"), Promise.resolve());
    },
    continueFailedTurn(context: string) {
      calls.push(["continueFailedTurn", context]);
      if (context === "write fails") {
        const failed = Promise.reject(new Error("disk full"));
        return run(failed as never, failed);
      }
      // pi's first event of the turn, before the disposition's callbacks.
      for (const listener of listeners)
        listener({ type: "agent_start" } as AgentSessionEvent);
      return run(Promise.resolve("started"), Promise.resolve());
    },
    async setSessionName(name: string) {
      state.sessionName = name;
      append("session_info");
    },
    async abort() {
      throw new Error("abort failed");
    },
    markToolUsed: (name: string) => calls.push(["markToolUsed", name]),
    async dispose() {
      calls.push(["dispose"]);
    },
    async discard(options: unknown) {
      calls.push(["discard", options]);
    },
  } as unknown as PiEngineHandle;
  return {
    local,
    calls,
    state,
    append,
    statsReads: () => statsReads,
    emit: (event: AgentSessionEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function hosted(script = scriptedLocal(), engineId?: number) {
  const engine = hostPiEngine(script.local, { sessionId: "sid" }, engineId);
  engine.snapshot();
  const items: HostedEngineItem[] = [];
  engine.onItem((item) => items.push(item));
  return { engine, items, script };
}

const kinds = (items: HostedEngineItem[]) =>
  items.map((item) =>
    item.kind === "event"
      ? `event:${(item.event as { type: string }).type}`
      : item.kind === "disposition"
        ? `disposition:${String(item.disposition)}`
        : "state",
  );

test("an idle engine refuses a steerOnly steer and sends nothing to pi", async () => {
  const { engine, items, script } = hosted();
  await assert.rejects(
    engine.command(
      "submit",
      ["hi", [], { steer: true, steerOnly: true, userTurnIdleMs: 0 }],
      1,
    ),
    (err: unknown) =>
      err instanceof WorkerMethodError && err.code === STEER_NOT_TAKEN,
  );
  assert.deepEqual(script.calls, []);
  assert.deepEqual(kinds(items), ["state"], "a state item, no disposition");
});

test("a steer that finds the engine idle runs as a prompt and reports started first", async () => {
  const { engine, items, script } = hosted();
  const answered = engine.command(
    "submit",
    ["hi", [], { steer: true, steerOnly: false, userTurnIdleMs: 5 }],
    1,
  );
  script.emit({ type: "agent_start" } as AgentSessionEvent);
  await answered;
  assert.deepEqual(script.calls, [
    ["submit", "hi", [], { steer: false, steerOnly: false, userTurnIdleMs: 5 }],
  ]);
  assert.deepEqual(kinds(items), [
    "disposition:started",
    "event:agent_start",
    "state",
  ]);
  assert.equal(items[0]!.commandId, 1);
});

test("a prompt that finds the engine streaming steers and reports steered", async () => {
  const { engine, items, script } = hosted();
  script.state.isStreaming = true;
  await engine.command(
    "submit",
    ["more", [], { steer: false, steerOnly: false, userTurnIdleMs: 0 }],
    4,
  );
  assert.deepEqual(script.calls, [
    [
      "submit",
      "more",
      [],
      { steer: true, steerOnly: false, userTurnIdleMs: 0 },
    ],
  ]);
  assert.deepEqual(items[0], {
    kind: "disposition",
    commandId: 4,
    disposition: "steered",
  });
});

test("a continuation reports started before its first event; a failed write reports none", async () => {
  const { engine, items } = hosted();
  await assert.rejects(
    engine.command("continueFailedTurn", ["write fails"], 1),
    /disk full/,
  );
  assert.deepEqual(kinds(items), ["state"]);
  items.length = 0;
  await engine.command("continueFailedTurn", ["go on"], 2);
  assert.deepEqual(kinds(items), [
    "disposition:started",
    "event:agent_start",
    "state",
  ]);
  assert.equal(items[0]!.commandId, 2);
});

test("every command emits a state item before it settles, failures included", async () => {
  const { engine, items } = hosted();
  let seenAtSettle = -1;
  await engine
    .command("setSessionName", ["Named"], 1)
    .then(() => (seenAtSettle = items.length));
  assert.equal(seenAtSettle, 1);
  const named = items[0]!;
  assert.equal(named.kind, "state");
  assert.equal((named.state as { sessionName: string }).sessionName, "Named");
  assert.deepEqual(named.transcript, {
    entries: [{ type: "session_info", id: "e1", parentId: null }],
    leafId: "e1",
  });
  await assert.rejects(
    engine.command("abort", [], 2).finally(() => (seenAtSettle = items.length)),
    /abort failed/,
  );
  assert.equal(seenAtSettle, 2);
  assert.deepEqual(
    items[1],
    { kind: "state" },
    "nothing changed, nothing sent",
  );
  await assert.rejects(
    engine.command("nope", [], 3),
    /Unknown pi engine command/,
  );
});

test("an event carries the state and the entries appended since the last item", async () => {
  const { items, script } = hosted();
  script.append("message");
  script.state.isStreaming = true;
  script.emit({ type: "message_end" } as AgentSessionEvent);
  script.emit({ type: "message_update" } as AgentSessionEvent);
  const [first, second] = items;
  assert.equal((first!.state as { isStreaming: boolean }).isStreaming, true);
  assert.deepEqual(first!.transcript, {
    entries: [{ type: "message", id: "e1", parentId: null }],
    leafId: "e1",
  });
  assert.equal(second!.state, undefined);
  assert.equal(second!.transcript, undefined);
});

test("stats are recomputed only when an input changed", () => {
  const { script } = hosted();
  const before = script.statsReads();
  script.emit({ type: "message_update" } as AgentSessionEvent);
  script.emit({ type: "message_update" } as AgentSessionEvent);
  assert.equal(script.statsReads(), before);
  script.append("message");
  script.emit({ type: "message_end" } as AgentSessionEvent);
  assert.equal(script.statsReads(), before + 1);
});

test("the test map holds an engine only until it is disposed", async () => {
  const script = scriptedLocal();
  const { engine } = hosted(script, 4242);
  assert.equal(hostedPiEngine(4242), script.local);
  await engine.dispose({ removeFile: {} });
  assert.equal(hostedPiEngine(4242), undefined);
  assert.deepEqual(script.calls, [["discard", { removeFile: {} }]]);
  script.emit({ type: "agent_start" } as AgentSessionEvent);
});
