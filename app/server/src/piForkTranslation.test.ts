/**
 * The connection's fork translation for the PI branch.
 *
 * A client addresses a fork by OUR log entry id — the only id it holds — and the
 * connection translates that to the harness's own anchor. pi branches FROM the
 * selected native entry (it walks to the parent itself for a "before" fork), so
 * `piStore.forkSession` must receive pi's native entry id, never our log id. The
 * other pi fork tests call `piStore.forkSession` directly with native ids, so
 * nothing else covers this seam (`harnesses/fork.ts`).
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/piForkTranslation.test.ts
 */
import assert from "node:assert/strict";
import { afterAll, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "pi-fork-translation-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const forkCalls: Array<{
  file: string;
  entryId: string;
  position: string;
  originEntryId: string;
}> = [];
/** Set by a test that needs the fork to SUCCEED; otherwise piStore is stubbed out. */
let forkOutcome: (() => Promise<unknown>) | null = null;
vi.mock("./hub.ts", async (importOriginal) => {
  const actual = await importOriginal<{ hub: Record<string, unknown> }>();
  return {
    ...actual,
    hub: {
      ...actual.hub,
      listSessions: () => Promise.resolve([]),
      broadcastSessions: () => Promise.resolve(),
    },
  };
});

const { Connection } = await import("./connection.ts");
const settings = await import("./settings.ts");
const { piStore } = await import("./piSdk/piStore.ts");
vi.spyOn(piStore, "forkSession").mockImplementation(
  (_kind, file, entryId, position, originEntryId) => {
    forkCalls.push({ file, entryId, position, originEntryId });
    return (forkOutcome?.() ??
      Promise.reject(new Error("stop after translation"))) as never;
  },
);
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { SessionLogStore } = await import("./session/log/store.ts");
type AdapterEvent = import("./session/adapters/contract.ts").AdapterEvent;

function makeConnection(): {
  fork: (
    id: string,
    entryId: string,
    position: "before" | "at",
  ) => Promise<void>;
  sent: ServerMessage[];
} {
  const sent: ServerMessage[] = [];
  const conn = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )({
    OPEN: 1,
    readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s) as ServerMessage),
  });
  return {
    fork: (id, entryId, position) =>
      (
        conn as unknown as {
          onForkSession: (
            id: string,
            entryId: string,
            position: "before" | "at",
          ) => Promise<void>;
        }
      ).onForkSession(id, entryId, position),
    sent,
  };
}

/** Native rows as pi's post-turn scan reports them, in pi's own order. */
type ScannedRow = Extract<
  AdapterEvent,
  { type: "entriesBound" }
>["entries"][number];

/** The seeded sessions' adapters, so a test can drive a SECOND turn on one. */
const adapters = new Map<
  string,
  { emit: (event: AdapterEvent) => void; prompts: string[] }
>();

/**
 * A pi session in the registry whose log is bound the way pi binds: by scanning
 * pi's own transcript after the turn.
 *
 * With `withTool` the turn calls a tool, which is where the two transcripts stop
 * looking alike: our log aggregates the whole turn into ONE assistant entry
 * followed by its result, while pi wrote `assistant(call) → result → assistant`
 * — the shape a real `.jsonl` has, and the one the scan reports.
 */
/** A pi-shaped adapter under the runtime, whose events a test drives by hand. */
function makeAdapter(id: string): {
  emit: (event: AdapterEvent) => void;
  prompts: string[];
} {
  const prompts: string[] = [];
  const adapter = {
    prompts,
    provider: "pi",
    capabilities: {
      fork: "arbitrary" as const,
      compact: true,
      attachments: true,
    },
    listeners: new Set<(e: AdapterEvent) => void>(),
    subscribe(listener: (e: AdapterEvent) => void) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    emit(event: AdapterEvent) {
      for (const l of this.listeners) l(event);
    },
    getBinding: () => ({ provider: "pi", nativeId: "pi-session" }),
    prompt: (text: string) => {
      prompts.push(text);
      return Promise.resolve({ stopReason: "end" as const });
    },
    abort: () => {},
    setModel: () => {},
    setReasoning: () => {},
    listModels: () => Promise.resolve([]),
    dispose: () => {},
  };
  sessionRuntime.createSession(
    id,
    adapter as unknown as import("./session/adapters/contract.ts").PromptableAdapter,
  );
  adapters.set(id, adapter);
  return adapter;
}

async function seedPiSession(
  id: string,
  bind: boolean,
  withTool = false,
  memoryBlock?: string,
): Promise<string[]> {
  sessionStore.upsert({ id, harness: "pi", agentType: "developer" });
  const adapter = makeAdapter(id);
  const native: ScannedRow[] = [
    { role: "user", providerMessageId: "pi-entry-u1" },
    ...(withTool
      ? ([
          {
            role: "assistant",
            providerMessageId: "pi-entry-a1",
            toolCallIds: ["call-1"],
          },
          {
            role: "toolResult",
            providerMessageId: "pi-entry-t1",
            toolCallId: "call-1",
          },
          { role: "assistant", providerMessageId: "pi-entry-a2" },
        ] satisfies ScannedRow[])
      : ([
          { role: "assistant", providerMessageId: "pi-entry-a1" },
        ] satisfies ScannedRow[])),
  ];
  await runPiTurn(id, adapter, {
    streamId: "m1",
    ...(withTool ? { toolCallId: "call-1" } : {}),
    ...(bind ? { native } : {}),
    ...(memoryBlock ? { memoryBlock } : {}),
  });
  return sessionRuntime
    .get(id)!
    .clientTimeline()
    .map((entry) => entry.id);
}

/**
 * Drive one turn the way the pi adapter does: the aggregated assistant message,
 * its buffered tool result, then the post-turn scan of pi's WHOLE transcript
 * (`native`, which therefore restates the earlier turns too).
 */
async function runPiTurn(
  id: string,
  adapter: { emit: (event: AdapterEvent) => void },
  turn: {
    streamId: string;
    toolCallId?: string;
    native?: ScannedRow[];
    memoryBlock?: string;
  },
): Promise<void> {
  const run = sessionRuntime.prompt(id, "a pi prompt", {
    ...(turn.memoryBlock ? { memoryBlock: turn.memoryBlock } : {}),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  adapter.emit({
    type: "messageCompleted",
    streamId: turn.streamId,
    content: [
      { type: "text", text: "an answer" },
      ...(turn.toolCallId
        ? [
            {
              type: "toolCall" as const,
              toolCallId: turn.toolCallId,
              name: "read",
              input: {},
            },
          ]
        : []),
    ],
  });
  if (turn.toolCallId)
    adapter.emit({
      type: "toolCompleted",
      streamId: turn.toolCallId,
      toolCallId: turn.toolCallId,
      content: [{ type: "text", text: "file body" }],
    });
  // pi supplies EVERY native id from its post-turn file scan, never inline.
  if (turn.native) adapter.emit({ type: "entriesBound", entries: turn.native });
  adapter.emit({ type: "runCompleted", stopReason: "end" });
  await run;
}

test("a pi fork reaches piStore with pi's native entry id", async () => {
  const [userId, assistantId] = await seedPiSession("pi-bound", true);
  const { fork } = makeConnection();

  await fork("pi-bound", assistantId!, "at");
  await fork("pi-bound", userId!, "before");

  assert.deepEqual(
    forkCalls.map((call) => call.entryId),
    ["pi-entry-a1", "pi-entry-u1"],
    "our log ids are translated to pi's own entry ids, both positions",
  );
  assert.deepEqual(
    forkCalls.map((call) => call.position),
    ["at", "before"],
    "and the side is passed through untouched",
  );
  assert.deepEqual(
    forkCalls.map((call) => call.originEntryId),
    [assistantId, userId],
    "while OUR id travels alongside for the lineage the client resolves",
  );
});

/**
 * A child live session carrying only what the fork path reads off it. It is not
 * a real `PiLiveSession`, so the connection's view attach declines it — the
 * seeded log is read from the runtime directly below, which is the half under
 * test.
 */
function makeFakeLive(id: string): unknown {
  return {
    id,
    key: id,
    sessionId: id,
    kind: "developer",
    harness: "pi",
    agentType: "developer",
    sessionFile: `${tmp}/${id}.jsonl`,
    isRunning: false,
    addViewer: () => {},
    removeViewer: () => {},
    broadcastState: () => {},
    state: () => ({ sessionId: id, agentType: "developer", harness: "pi" }),
    snapshot: () => [],
    contextInfo: () => ({ sessionId: id, updatedAt: Date.now() }),
  };
}

/** The child's seeded transcript, brought up under the runtime to read it. */
function childTimeline(id: string) {
  return sessionRuntime
    .createSession(id, {
      provider: "pi",
      capabilities: { fork: "arbitrary", compact: true, attachments: true },
      subscribe: () => () => {},
      getBinding: () => ({ provider: "pi" }),
      prompt: () => Promise.resolve({ stopReason: "end" as const }),
      abort: () => {},
      setModel: () => {},
      setReasoning: () => {},
      dispose: () => {},
    } as unknown as import("./session/adapters/contract.ts").PromptableAdapter)
    .clientTimeline();
}

test("a pi edit-and-retry draft excludes model-only memory", async () => {
  const memoryBlock =
    "<memory>\nThe following are your durable memories for this context.\n</memory>";
  const [userId] = await seedPiSession(
    "pi-clean-retry-draft",
    true,
    false,
    memoryBlock,
  );
  assert.equal(
    adapters.get("pi-clean-retry-draft")?.prompts[0],
    `${memoryBlock}\n\na pi prompt`,
    "the pi-native prompt contains the model-only enrichment",
  );

  forkOutcome = () => Promise.resolve(makeFakeLive("pi-clean-retry-child"));
  const { fork, sent } = makeConnection();
  await fork("pi-clean-retry-draft", userId!, "before");
  forkOutcome = null;

  const response = sent.find(
    (message): message is Extract<ServerMessage, { type: "forkedSession" }> =>
      message.type === "forkedSession",
  );
  assert.equal(
    response?.selectedText,
    "a pi prompt",
    "the composer draft comes from the clean app log",
  );
});

test("a pi fork seeds the child transcript from the parent's log", async () => {
  // pi branches its own session file and never touches ours, so without the
  // seeding the child opens on an empty chat next to a pi session holding the
  // whole history — the visible difference from a claude-sdk fork.
  const [userId, assistantId] = await seedPiSession("pi-seeded", true);
  forkOutcome = () => Promise.resolve(makeFakeLive("pi-seeded-child"));
  const { fork } = makeConnection();

  await fork("pi-seeded", assistantId!, "at");
  forkOutcome = null;

  const timeline = childTimeline("pi-seeded-child");
  assert.deepEqual(
    timeline.map((entry) => entry.id),
    [userId, assistantId],
    "the child carries the parent's prefix through the forked turn",
  );
  assert.deepEqual(
    timeline.map((entry) => entry.inheritedFrom?.sessionId),
    ["pi-seeded", "pi-seeded"],
    "and every copied row is marked as the parent's, for the fork-boundary marker",
  );
  assert.deepEqual(
    timeline.map((entry) => entry.forkable === true),
    [false, false],
    "the copy stays unanchored: pi's ids belong to the parent's branch walk",
  );
});

test("a tool-using turn cuts BOTH sides at the END of that turn", async () => {
  // The two transcripts end the turn in different places: our copy runs through
  // the tool result trailing the aggregated entry, pi's `.jsonl` through the
  // assistant message it wrote AFTER that result — its final answer. Each cut
  // must name its own end, or the child loses half a turn: branching pi at the
  // result would drop that final answer, and branching it at the assistant
  // message that opened the turn would hand the child a tool call whose result
  // nothing holds.
  const ids = await seedPiSession("pi-tools", true, true);
  const before = forkCalls.length;
  forkOutcome = () => Promise.resolve(makeFakeLive("pi-tools-child"));
  const { fork } = makeConnection();

  await fork("pi-tools", ids[1]!, "at");
  forkOutcome = null;

  assert.equal(
    forkCalls[before]?.entryId,
    "pi-entry-a2",
    "pi branches at the native message its turn ended on",
  );
  assert.equal(
    forkCalls[before]?.originEntryId,
    ids[1],
    "but the lineage records the ROW the user clicked, which the client can find",
  );
  assert.deepEqual(
    childTimeline("pi-tools-child").map((entry) => entry.id),
    ids,
    "and our copy ends on that same turn — prompt, turn, result",
  );
});

test("forking before a prompt copies the turn ahead of it, anchored or not", async () => {
  // The reconciliation refuses a turn it cannot place with certainty, so an
  // UNANCHORED turn in the middle of a session is a deliberate outcome now. pi
  // still branches from the selected prompt's parent and keeps that turn in
  // context, so our copy must run through it too — cutting at the nearest
  // ANCHORED entry instead would open the child on a transcript missing a turn
  // its own model remembers.
  const id = "pi-unbound-middle";
  sessionStore.upsert({ id, harness: "pi", agentType: "developer" });
  const adapter = makeAdapter(id);
  // Turn 1 binds.
  await runPiTurn(id, adapter, {
    streamId: "m1",
    native: [
      { role: "user", providerMessageId: "pi-u1" },
      { role: "assistant", providerMessageId: "pi-a1" },
    ],
  });
  // Turn 2 is refused: our answer records a call pi's transcript never shows.
  await runPiTurn(id, adapter, {
    streamId: "m2",
    toolCallId: "call-x",
    native: [
      { role: "user", providerMessageId: "pi-u1" },
      { role: "assistant", providerMessageId: "pi-a1" },
      { role: "user", providerMessageId: "pi-u2" },
      { role: "assistant", providerMessageId: "pi-a2" },
    ],
  });
  // Turn 3 binds again, independently.
  await runPiTurn(id, adapter, {
    streamId: "m3",
    native: [
      { role: "user", providerMessageId: "pi-u1" },
      { role: "assistant", providerMessageId: "pi-a1" },
      { role: "user", providerMessageId: "pi-u2" },
      { role: "assistant", providerMessageId: "pi-a2" },
      { role: "user", providerMessageId: "pi-u3" },
      { role: "assistant", providerMessageId: "pi-a3" },
    ],
  });

  const timeline = sessionRuntime.get(id)!.clientTimeline();
  assert.deepEqual(
    timeline.map((entry) => entry.forkable === true),
    [true, true, false, false, false, true, true],
    "the middle turn stayed unbound, the ones around it did not",
  );
  const thirdPrompt = timeline[5]!.id;
  forkOutcome = () => Promise.resolve(makeFakeLive("pi-unbound-middle-child"));
  const { fork } = makeConnection();

  await fork(id, thirdPrompt, "before");
  forkOutcome = null;

  assert.deepEqual(
    childTimeline("pi-unbound-middle-child").map((entry) => entry.id),
    timeline.slice(0, 5).map((entry) => entry.id),
    "the copy runs through everything before that prompt, including the unbound turn",
  );
});

test("a LATER turn is anchored too, so its prompt can be forked before", async () => {
  // The regression this covers: the extra native assistant of a tool-using turn
  // used to break a positional walk, leaving every entry after it unbound — so
  // the second prompt of a working session had no anchor and its fork failed.
  const first = await seedPiSession("pi-second-turn", true, true);
  const adapter = adapters.get("pi-second-turn")!;
  await runPiTurn("pi-second-turn", adapter, {
    streamId: "m2",
    toolCallId: "call-2",
    native: [
      { role: "user", providerMessageId: "pi-entry-u1" },
      {
        role: "assistant",
        providerMessageId: "pi-entry-a1",
        toolCallIds: ["call-1"],
      },
      {
        role: "toolResult",
        providerMessageId: "pi-entry-t1",
        toolCallId: "call-1",
      },
      { role: "assistant", providerMessageId: "pi-entry-a2" },
      { role: "user", providerMessageId: "pi-entry-u2" },
      {
        role: "assistant",
        providerMessageId: "pi-entry-a3",
        toolCallIds: ["call-2"],
      },
      {
        role: "toolResult",
        providerMessageId: "pi-entry-t2",
        toolCallId: "call-2",
      },
      { role: "assistant", providerMessageId: "pi-entry-a4" },
    ],
  });
  const timeline = sessionRuntime
    .get("pi-second-turn")!
    .clientTimeline()
    .map((entry) => entry.id);
  const secondPrompt = timeline[first.length]!;
  assert.equal(
    sessionRuntime
      .get("pi-second-turn")!
      .clientTimeline()
      .every((entry) => entry.forkable === true),
    true,
    "every entry of both turns carries an anchor",
  );
  const before = forkCalls.length;
  const { fork, sent } = makeConnection();

  await fork("pi-second-turn", secondPrompt, "before");
  await fork("pi-second-turn", timeline[first.length + 1]!, "at");

  assert.deepEqual(
    forkCalls.slice(before).map((call) => call.entryId),
    ["pi-entry-u2", "pi-entry-a4"],
    "the second prompt forks from its own native id, its turn from that turn's end",
  );
  assert.equal(
    sent.some(
      (message) =>
        message.type === "error" && /no provider anchor/.test(message.message),
    ),
    false,
    "and neither is refused for a missing anchor (the stub then stops the fork)",
  );
});

test("a LEGACY binding keeps the cut it was written under", async () => {
  // A session anchored before turn ends were resolved has bindings that name a
  // message somewhere INSIDE the turn and no turn end at all. Reading the anchor
  // as a turn end would cut pi before the tool result our copy carries, so those
  // entries keep the older rule: cut pi at the anchor of OUR turn-end entry.
  const id = "pi-legacy";
  sessionStore.upsert({ id, harness: "pi", agentType: "developer" });
  // Written straight to this session's durable log file, which the runtime opens
  // lazily — there is no live session, and nothing in the current code path can
  // produce a legacy binding any more.
  const log = new SessionLogStore().open(id);
  const user = log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "a pi prompt" }],
  });
  const assistant = log.append({
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "an answer" },
      { type: "toolCall", toolCallId: "call-1", name: "read", input: {} },
    ],
  });
  const result = log.append({
    type: "message",
    role: "toolResult",
    toolCallId: "call-1",
    content: [{ type: "text", text: "file body" }],
  });
  // Exactly what the old positional binder wrote: an anchor per entry, no turn
  // end, and the assistant pointing at the message that OPENED the turn.
  for (const [entryId, providerMessageId] of [
    [user.id, "pi-legacy-u1"],
    [assistant.id, "pi-legacy-a1"],
    [result.id, "pi-legacy-t1"],
  ] as const)
    log.append({
      type: "message.providerBound",
      boundEntryId: entryId,
      providerMessageId,
    });

  const before = forkCalls.length;
  const { fork } = makeConnection();
  await fork(id, assistant.id, "at");

  assert.equal(
    forkCalls[before]?.entryId,
    "pi-legacy-t1",
    "the legacy cut still lands on the last row both transcripts agree on",
  );
  assert.notEqual(
    forkCalls[before]?.entryId,
    "pi-legacy-a1",
    "never on the anchor itself, which would drop the tool result we copy",
  );
});

test("a LEGACY multi-cycle turn with no anchored end is REFUSED, not cut", async () => {
  // The shape the old positional binder actually left in production: it stopped
  // at the first extra native assistant, so the turn's tool results carry no
  // anchor at all. Nothing then names the end of that turn — our copy runs
  // through both results and the final answer, while the only id we hold is the
  // message that OPENED the turn. Cutting there would give the child tool calls
  // whose results nothing holds, so the fork is refused instead.
  const id = "pi-legacy-multi";
  sessionStore.upsert({ id, harness: "pi", agentType: "developer" });
  const log = new SessionLogStore().open(id);
  const user = log.append({
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: "a tool-heavy prompt" }],
  });
  const assistant = log.append({
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "looking" },
      { type: "toolCall", toolCallId: "call-1", name: "read", input: {} },
      { type: "toolCall", toolCallId: "call-2", name: "bash", input: {} },
      { type: "text", text: "done" },
    ],
  });
  log.append({
    type: "message",
    role: "toolResult",
    toolCallId: "call-1",
    content: [{ type: "text", text: "file body" }],
  });
  log.append({
    type: "message",
    role: "toolResult",
    toolCallId: "call-2",
    content: [{ type: "text", text: "built" }],
  });
  // The old walk bound the prompt and the assistant row, then hit the turn's
  // SECOND native assistant and stopped: both results stayed unanchored.
  for (const [entryId, providerMessageId] of [
    [user.id, "pi-legacy-multi-u1"],
    [assistant.id, "pi-legacy-multi-a1"],
  ] as const)
    log.append({
      type: "message.providerBound",
      boundEntryId: entryId,
      providerMessageId,
    });

  const before = forkCalls.length;
  const { fork, sent } = makeConnection();
  await fork(id, assistant.id, "at");

  assert.equal(
    forkCalls.length,
    before,
    "no fork is attempted at the message that merely opened the turn",
  );
  assert.match(
    (sent.find((message) => message.type === "error") as { message: string })
      .message,
    /no provider anchor for its end/,
    "and the refusal says which anchor is missing",
  );
});

test("an unanchored pi entry is refused with a clear message", async () => {
  // Passing our log id through would reach piStore as an id it cannot resolve
  // and surface as an obscure downstream error instead.
  const ids = await seedPiSession("pi-unbound", false);
  const before = forkCalls.length;
  const { fork, sent } = makeConnection();

  await fork("pi-unbound", ids[1]!, "at");

  assert.equal(forkCalls.length, before, "no fork is attempted");
  const error = sent.find((message) => message.type === "error");
  assert.match(
    (error as { message: string }).message,
    /no provider anchor/,
    "the user gets the same clear message the claude-sdk branch gives",
  );
});

test("a refused fork never claims the view, on either engine", async () => {
  const claims = vi.spyOn(
    Connection.prototype as unknown as { claimViewRequest(): unknown },
    "claimViewRequest",
  );
  const real = settings.getSettings();
  const enabled = vi.spyOn(settings, "getSettings").mockReturnValue({
    ...real,
    claudeSdk: { ...real.claudeSdk, enabled: true },
  });
  try {
    const ids = await seedPiSession("unbound-for-claims", false);
    const { fork, sent } = makeConnection();

    await fork("unbound-for-claims", ids[1]!, "at");
    // The same session as Claude's: before its first prompt there is nothing
    // to cut at, which only the Claude engine says this way.
    sessionStore.upsert({
      id: "unbound-for-claims",
      harness: "claude-sdk",
      agentType: "developer",
    });
    await fork("unbound-for-claims", ids[0]!, "before");

    assert.equal(claims.mock.calls.length, 0);
    assert.deepEqual(
      sent.filter((message) => message.type === "error").map((m) => m.message),
      [
        "Failed to fork session: this message has no provider anchor to branch from.",
        "Failed to fork session: there is nothing before this prompt to branch from.",
      ],
    );
  } finally {
    claims.mockRestore();
    enabled.mockRestore();
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
