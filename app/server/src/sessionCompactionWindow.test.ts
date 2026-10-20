/**
 * The compaction-window setter, its WebSocket command and the detached view
 * (`docs/compaction-window.md`): actor rules, ordering, persistence before
 * apply, fresh reads in an open view, and no harness ever opened.
 *   pnpm --filter @assistant/server test src/sessionCompactionWindow.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import type {
  ClientMessage,
  CompactionWindowLiveStatus,
  ServerMessage,
} from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "session-compaction-window-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { setSessionCompactionWindow } =
  await import("./sessionCompactionWindow.ts");
const { inheritCompactionWindow } =
  await import("./harnesses/compactionWindow.ts");
const { Connection } = await import("./connection.ts");
const { hub } = await import("./hub.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { validateClientMessage } = await import("./validateClientMessage.ts");
const { getSettings, updateSettings } = await import("./settings.ts");
updateSettings({ claudeSdk: { ...getSettings().claudeSdk, enabled: true } });

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

let serial = 0;
function stored(harness: "claude-sdk" | "pi" = "claude-sdk", model = "opus") {
  serial += 1;
  const id = `window-${serial}`;
  sessionStore.upsert({
    id,
    harness,
    agentType: "developer",
    model,
    ...(harness === "pi" ? { provider: "nowhere" } : {}),
  });
  return id;
}

/** A resident session that records what the setter asks of it. */
function fakeLive(
  id: string,
  options: {
    contextWindow?: number;
    underlyingReserve?: number;
    applyGate?: Promise<void>;
  } = {},
) {
  const applied: Array<number | null> = [];
  const order: string[] = [];
  let broadcasts = 0;
  const live = {
    live: true,
    sessionId: id,
    compactionWindowStatus: () => ({
      live: {
        applied: "confirmed",
        appliedTokens: null,
      } as CompactionWindowLiveStatus,
      contextWindow: options.contextWindow ?? 200_000,
      ...(options.underlyingReserve !== undefined
        ? { underlyingReserve: options.underlyingReserve }
        : {}),
    }),
    applyCompactionWindow: async (tokens: number | null) => {
      order.push(
        `apply:${tokens}:stored=${sessionStore.get(id)?.compactionWindow}`,
      );
      await options.applyGate;
      applied.push(tokens);
      return { pendingReason: "process-restart" as const };
    },
    lowerCompactionWindow: async (
      tokens: number,
      persist: (value: number) => void,
    ) => {
      persist(tokens);
      return { ok: true as const, previous: null, applied: tokens };
    },
    broadcastState: () => {
      broadcasts += 1;
    },
  };
  vi.spyOn(hub, "getLiveById").mockImplementation((wanted: string) =>
    wanted === id ? (live as never) : undefined,
  );
  return { live, applied, order, broadcasts: () => broadcasts };
}

test("user: range refusal touches nothing; a value is stored before it is applied", async () => {
  const id = stored();
  const { applied, order, broadcasts } = fakeLive(id);
  const refusal = await setSessionCompactionWindow(id, 90_000, "user");
  assert.deepEqual(refusal, {
    ok: false,
    message:
      "The compaction window must be between 100,000 and 200,000 tokens.",
  });
  assert.deepEqual(applied, []);
  assert.equal(sessionStore.get(id)?.compactionWindow, undefined);

  assert.deepEqual(await setSessionCompactionWindow(id, 150_000, "user"), {
    ok: true,
    tokens: 150_000,
    pendingReason: "process-restart",
  });
  assert.deepEqual(order, ["apply:150000:stored=150000"]);
  assert.equal(broadcasts(), 1);

  assert.equal((await setSessionCompactionWindow(id, null, "user")).ok, true);
  assert.equal(sessionStore.get(id)?.compactionWindow, undefined);
  assert.deepEqual(applied, [150_000, null]);
});

test("user: a stored session is set without opening a harness", async () => {
  const id = stored();
  const acquire = vi.spyOn(hub, "acquireById");
  vi.spyOn(hub, "getLiveById").mockReturnValue(undefined);
  // The stored Opus row ranges up to 1M without a harness.
  assert.deepEqual(await setSessionCompactionWindow(id, 800_000, "user"), {
    ok: true,
    tokens: 800_000,
    pendingReason: "next-turn",
  });
  assert.equal(sessionStore.get(id)?.compactionWindow, 800_000);
  assert.equal(acquire.mock.calls.length, 0);
});

test("user: pi's range is the native trigger, from pi's default reserve when closed", async () => {
  const id = stored("pi", "unknown-model");
  vi.spyOn(hub, "getLiveById").mockReturnValue(undefined);
  const closed = await setSessionCompactionWindow(id, 50_000, "user");
  assert.equal(closed.ok, false, "an unknown stored pi model has no range");

  const live = stored("pi");
  fakeLive(live, { contextWindow: 32_768, underlyingReserve: 16_384 });
  assert.equal(
    (await setSessionCompactionWindow(live, 16_384, "user")).ok,
    true,
  );
  assert.equal(
    (await setSessionCompactionWindow(live, 16_385, "user")).ok,
    false,
  );
});

test("structural and capability refusals", async () => {
  const id = stored();
  vi.spyOn(hub, "getLiveById").mockReturnValue(undefined);
  for (const tokens of [0, -5, 1.5, Number.NaN])
    assert.equal(
      (await setSessionCompactionWindow(id, tokens, "user")).ok,
      false,
      `${tokens}`,
    );
  assert.equal(
    (await setSessionCompactionWindow("missing-session", 150_000, "user")).ok,
    false,
  );
  assert.equal((await setSessionCompactionWindow(id, null, "agent")).ok, false);
});

test("concurrent sets for one session apply in the order they were made", async () => {
  const id = stored();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { applied } = fakeLive(id, { applyGate: gate });
  const first = setSessionCompactionWindow(id, 120_000, "user");
  const second = setSessionCompactionWindow(id, 180_000, "user");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    sessionStore.get(id)?.compactionWindow,
    120_000,
    "the second waits for the first",
  );
  release();
  await Promise.all([first, second]);
  assert.deepEqual(applied, [120_000, 180_000]);
  assert.equal(sessionStore.get(id)?.compactionWindow, 180_000);
});

test("agent: only a live session; the harness persists through the callback", async () => {
  const closed = stored();
  vi.spyOn(hub, "getLiveById").mockReturnValue(undefined);
  assert.equal(
    (await setSessionCompactionWindow(closed, 150_000, "agent")).ok,
    false,
  );
  const id = stored();
  fakeLive(id);
  sessionStore.setCompactionWindow(id, 180_000, "Creation-time note");
  assert.deepEqual(await setSessionCompactionWindow(id, 150_000, "agent"), {
    ok: true,
    tokens: 150_000,
    previous: null,
  });
  assert.equal(sessionStore.get(id)?.compactionWindow, 150_000);
  assert.equal(sessionStore.get(id)?.compactionWindowNote, undefined);
});

test("spawn: a row value is agent-written; a definition default is clamped", async () => {
  const id = stored();
  fakeLive(id, { contextWindow: 200_000 });
  assert.equal(
    (await setSessionCompactionWindow(id, 90_000, { spawn: "row" })).ok,
    false,
  );
  assert.equal(
    (await setSessionCompactionWindow(id, 250_000, { spawn: "row" })).ok,
    true,
  );
  assert.deepEqual(
    await setSessionCompactionWindow(id, 2_000_000, { spawn: "definition" }),
    {
      ok: true,
      tokens: 200_000,
      pendingReason: "process-restart",
      note: "The definition's 2,000,000-token window was clamped to 200,000 for this model.",
    },
  );

  const small = stored();
  fakeLive(small, { contextWindow: 80_000 });
  const dropped = await setSessionCompactionWindow(small, 150_000, {
    spawn: "definition",
  });
  assert.equal(dropped.ok && dropped.tokens, null);
  assert.match((dropped.ok && dropped.note) || "", /No compaction window/);
});

test.each([
  {
    context: 272_000,
    reserve: 72_000,
    source: "row",
    request: 220_000,
    estimate: 220_000,
    actual: 200_000,
  },
  {
    context: 272_000,
    reserve: 72_000,
    source: "definition",
    request: 250_000,
    estimate: 250_000,
    actual: 200_000,
  },
  {
    context: 272_000,
    reserve: 190_000,
    source: "definition",
    request: 150_000,
    estimate: 150_000,
    actual: 82_000,
  },
  {
    context: 272_000,
    reserve: 10_000,
    source: "definition",
    request: 260_000,
    estimate: 255_616,
    actual: 255_616,
  },
  {
    context: 16_000,
    reserve: 1_000,
    source: "definition",
    request: 12_000,
    estimate: null,
    actual: 12_000,
  },
  {
    context: 16_000,
    reserve: 16_384,
    source: "definition",
    request: 12_000,
    estimate: null,
    actual: null,
  },
] as const)(
  "spawn actual reconcile $request to $actual at reserve $reserve",
  async ({ context, reserve, source, request, estimate, actual }) => {
    const id = stored("pi");
    fakeLive(id, { contextWindow: context, underlyingReserve: reserve });
    const result = await setSessionCompactionWindow(id, request, {
      spawn: source,
      estimate: { tokens: estimate },
    });
    assert.equal(result.ok && result.tokens, actual);
    assert.equal(sessionStore.get(id)?.compactionWindow, actual ?? undefined);
    const { storedCompactionWindowState } =
      await import("./harnesses/compactionWindow.ts");
    assert.equal(
      storedCompactionWindowState(sessionStore.get(id)!)?.note,
      result.ok ? result.note : undefined,
    );
    assert.equal(
      sessionStore.get(id)?.compactionWindowNote,
      result.ok ? result.note : undefined,
    );
    if (estimate !== actual)
      assert.ok(
        result.ok &&
          result.note?.includes(actual?.toLocaleString("en-US") ?? "Not set"),
      );
    if (estimate === null && actual === 12_000)
      assert.match(
        (result.ok && result.note) || "",
        /estimate.*found no range/,
      );
    await setSessionCompactionWindow(id, null, "user");
    assert.equal(sessionStore.get(id)?.compactionWindowNote, undefined);
  },
);

test("spawn refuses a row when its actual pi trigger is below the agent floor", async () => {
  const id = stored("pi");
  const { applied } = fakeLive(id, {
    contextWindow: 272_000,
    underlyingReserve: 190_000,
  });
  assert.equal(
    (
      await setSessionCompactionWindow(id, 150_000, {
        spawn: "row",
        estimate: { tokens: 150_000 },
      })
    ).ok,
    false,
  );
  assert.equal(sessionStore.get(id)?.compactionWindow, undefined);
  assert.deepEqual(applied, []);
});

test("a fork copies the parent's stored window and applies it once", async () => {
  const parent = stored();
  sessionStore.setCompactionWindow(parent, 180_000);
  const child = stored();
  const { live, applied } = fakeLive(child);
  await inheritCompactionWindow(parent, live as never);
  assert.equal(sessionStore.get(child)?.compactionWindow, 180_000);
  assert.deepEqual(applied, [180_000]);

  const plain = stored();
  const second = fakeLive(stored());
  await inheritCompactionWindow(plain, second.live as never);
  assert.deepEqual(second.applied, []);
});

test("the client command: validation, settlement and an in-place refusal", async () => {
  assert.equal(
    validateClientMessage({
      type: "setCompactionWindow",
      sessionId: "s",
      tokens: null,
    }).ok,
    true,
  );
  for (const tokens of [1.5, "x", 0, undefined])
    assert.equal(
      validateClientMessage({
        type: "setCompactionWindow",
        sessionId: "s",
        tokens,
      }).ok,
      false,
      String(tokens),
    );

  const id = stored();
  vi.spyOn(hub, "getLiveById").mockReturnValue(undefined);
  const sent: ServerMessage[] = [];
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0]);
  await connection.handle({
    type: "setCompactionWindow",
    sessionId: id,
    tokens: 150_000,
    requestId: "ok-1",
  } as ClientMessage);
  assert.ok(
    sent.some((m) => m.type === "mutationSettled" && m.requestId === "ok-1"),
  );
  await connection.handle({
    type: "setCompactionWindow",
    sessionId: id,
    tokens: 50_000,
    requestId: "bad-1",
  } as ClientMessage);
  const error = sent.find((m) => m.type === "error");
  assert.ok(error && error.type === "error");
  assert.equal(error.requestId, "bad-1");
  assert.deepEqual(error.target, { type: "session", id });
  assert.equal(
    sent.some((m) => m.type === "mutationSettled" && m.requestId === "bad-1"),
    false,
  );
});

test("an open detached view reports the new window fresh from the row", async () => {
  const id = stored();
  vi.spyOn(hub, "getLiveById").mockReturnValue(undefined);
  const acquire = vi.spyOn(hub, "acquireById");
  const sent: ServerMessage[] = [];
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0]);
  hub.register(connection);
  void connection.handle({ type: "loadSession", id } as ClientMessage);
  for (let i = 0; i < 6; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
  const before = sent.length;

  assert.equal(
    (await setSessionCompactionWindow(id, 300_000, "user")).ok,
    true,
  );
  const state = sent
    .slice(before)
    .find((m) => m.type === "state" && m.state.sessionId === id);
  assert.ok(state && state.type === "state");
  assert.deepEqual(state.state.compactionWindow, {
    applied: "pending",
    pendingReason: "next-turn",
    tokens: 300_000,
    range: { min: 100_000, max: 1_000_000 },
    effectiveTokens: 300_000,
  });
  assert.equal(acquire.mock.calls.length, 0);
  hub.unregister(connection);
});
