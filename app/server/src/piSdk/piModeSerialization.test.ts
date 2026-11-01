/**
 * A session's Build/Plan flips run one at a time (`PiLiveSession.setMode`).
 *   pnpm --filter @assistant/server test src/piSdk/piModeSerialization.test.ts
 *
 * The engine's apply is awaited, so an overlapping flip would compare against
 * a mode about to change: a Build→Plan flip held at the engine, then a flip
 * back to Build, must end in Build, and a refused flip must not make the next
 * one look like a no-op. Each case checks that every owner of the mode agrees:
 * piStore's tool gate, the live session, the persisted row and the engine.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, test } from "vitest";
import type { SessionMode } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "pi-mode-serialization-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

await import("../hub.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { piStore } = await import("./piStore.ts");
const { openPiEngine } = await import("./piEngineHost.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");

type PiEngineOpenSpec = import("./piEngineHost.ts").PiEngineOpenSpec;
type PiEngineOpened = import("./piEngineHost.ts").PiEngineOpened;
type PiEngineHandle = import("./piEngine.ts").PiEngineHandle;

interface StoreInternals {
  openEngine: (spec: PiEngineOpenSpec) => Promise<PiEngineOpened>;
  sessionModes: Map<string, SessionMode>;
}
const internals = piStore as unknown as StoreInternals;

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** One engine `setToolMode` call: held until the test answers it. */
interface ToolModeCall {
  mode: SessionMode;
  apply: () => void;
  refuse: (error: Error) => void;
}

async function openScripted(id: string, initialMode: SessionMode) {
  const file = canonicalPiSessionPath(id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: tmp })}\n`,
  );
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    mode: initialMode,
  });
  const calls: ToolModeCall[] = [];
  let applied: SessionMode = initialMode;
  const original = internals.openEngine;
  internals.openEngine = async (spec) => {
    const opened = await openPiEngine(
      spec,
      {} as never,
      async (_spec, _ctx, { sm }) => ({
        session: {
          sessionId: sm.getSessionId(),
          get sessionFile() {
            return sm.getSessionFile();
          },
          sessionName: "Already named",
          sessionManager: sm,
          isStreaming: false,
          messages: [],
          subscribe: () => () => {},
          getSessionStats: () => ({
            totalMessages: 0,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            cost: 0,
            contextSize: 0,
          }),
          dispose: () => {},
        } as never,
        notices: [],
      }),
    );
    const engine: PiEngineHandle = Object.create(opened.engine, {
      setToolMode: {
        value: (mode: SessionMode) =>
          new Promise<void>((resolve, reject) =>
            calls.push({
              mode,
              apply: () => {
                applied = mode;
                resolve();
              },
              refuse: reject,
            }),
          ),
      },
    });
    return { ...opened, engine };
  };
  try {
    const live = await piStore.acquireExisting("developer", file, id);
    assert.equal(live.sessionMode, initialMode);
    return { live, calls, applied: () => applied };
  } finally {
    internals.openEngine = original;
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function assertModeEverywhere(
  id: string,
  h: Awaited<ReturnType<typeof openScripted>>,
  mode: SessionMode,
) {
  assert.equal(internals.sessionModes.get(id), mode, "piStore's tool gate");
  assert.equal(h.live.sessionMode, mode, "the live session");
  assert.equal(sessionStore.get(id)?.mode, mode, "the persisted row");
  assert.equal(h.applied(), mode, "the engine's last applied mode");
}

for (const [from, to] of [
  ["build", "plan"],
  ["plan", "build"],
] as const)
  test(`a flip back to ${from} while the flip to ${to} is held ends in ${from}`, async () => {
    const id = `mode-serial-${from}-${to}`;
    const h = await openScripted(id, from);
    try {
      const away = h.live.setMode(to);
      const back = h.live.setMode(from);
      await settle();
      assert.deepEqual(
        h.calls.map((c) => c.mode),
        [to],
        "the second flip waits for the first",
      );

      h.calls[0]!.apply();
      await away;
      await settle();
      assert.deepEqual(
        h.calls.map((c) => c.mode),
        [to, from],
        "then flips back against the mode the first one left",
      );
      h.calls[1]!.apply();
      await back;
      assertModeEverywhere(id, h, from);
    } finally {
      piStore.evict(id);
    }
  });

test("a refused flip does not make the next one a no-op", async () => {
  const id = "mode-serial-refused";
  const h = await openScripted(id, "build");
  try {
    const refused = h.live.setMode("plan");
    refused.catch(() => {});
    const valid = h.live.setMode("plan");
    await settle();
    assert.equal(h.calls.length, 1);

    h.calls[0]!.refuse(new Error("the engine could not apply plan"));
    await assert.rejects(refused, /could not apply plan/);
    await settle();
    assert.deepEqual(
      h.calls.map((c) => c.mode),
      ["plan", "plan"],
      "the valid flip still asks the engine",
    );
    h.calls[1]!.apply();
    await valid;
    assertModeEverywhere(id, h, "plan");
  } finally {
    piStore.evict(id);
  }
});
