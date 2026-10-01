/**
 * An idle Claude SDK session is released from memory and comes back from disk
 * as it left: the store drops it — committed timeline, runtime session and
 * log — once nobody has viewed it and nothing has driven it for the harness
 * idle grace; never while it is viewed, running, or has a prompt admitted; an
 * acquisition restarts the clock; and a released instance is refused at the
 * prompt door instead of being bound again.
 *
 * Run through Vitest: `pnpm --filter @assistant/server test src/claudeSdk/claudeSdkEviction.test.ts`
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";
import type { ServerMessage, SessionState } from "@assistant/shared";
import { DATA_DIR } from "../config.ts";
import { HARNESS_IDLE_EVICT_MS } from "../harness.ts";
import { attachRuntimeView } from "../session/attach.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";
import { ensureRuntimeSessionWithRuntime } from "../session/runtimePrompt.ts";
import { claudeTurnSeam } from "../test/claudeTurnSeam.ts";
import type { ClaudeSdkSeam } from "./sdkSeam.ts";
import type { ClaudeSdkSession } from "./ClaudeSdkSession.ts";
import { claudeSdkStore } from "./claudeSdkStore.ts";
import {
  readClaudeSdkRecord,
  removeClaudeSdkRecord,
} from "./claudeSdkRecords.ts";

const STORE_DIR = join(DATA_DIR, "claude-sdk");

/** While set, every turn holds its `result` until the gate opens. */
let gate: Promise<void> | undefined;
const gatedSeam: ClaudeSdkSeam = {
  ...claudeTurnSeam,
  query(params) {
    const inner = claudeTurnSeam.query(params);
    const held = gate;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const message of inner) {
          if (held && (message as { type: string }).type === "result")
            await held;
          yield message;
        }
      },
    } as ReturnType<ClaudeSdkSeam["query"]>;
  },
};

let counter = 0;
const freshId = () => `claude-evict-${Date.now()}-${counter++}`;
const ids: string[] = [];

function acquire(): { id: string; session: ClaudeSdkSession } {
  const id = freshId();
  ids.push(id);
  const session = claudeSdkStore.acquire(id, { modelId: "sonnet" });
  ensureRuntimeSessionWithRuntime(sessionRuntime, session);
  return { id, session };
}

/** What a reader of the session is sent: its runtime timeline. */
function viewedTimeline(session: ClaudeSdkSession): unknown {
  const sent: ServerMessage[] = [];
  const handle = attachRuntimeView(
    sessionRuntime,
    session.id,
    session,
    { send: (message) => sent.push(message) },
    { buildState: () => ({ sessionId: session.id }) as SessionState },
  );
  handle.detach();
  const snapshot = sent.find((message) => message.type === "snapshot");
  assert.ok(snapshot?.type === "snapshot");
  return snapshot.snapshot.timeline;
}

function resident(id: string): boolean {
  return Boolean(claudeSdkStore.get(id) && sessionRuntime.get(id));
}

beforeAll(() => claudeSdkStore.setSeam(() => Promise.resolve(gatedSeam)));

beforeEach(() => {
  gate = undefined;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const id of ids.splice(0)) claudeSdkStore.remove(id);
});

describe("idle Claude SDK sessions", () => {
  test("are released after the grace and reload from disk exactly as they left", async () => {
    const { id, session } = acquire();
    await sessionRuntime.prompt(id, "first");
    const committed = session.timelineEntries();
    const timeline = viewedTimeline(session);
    assert.equal(committed.length, 2);

    vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS - 1);
    assert.equal(resident(id), true, "still inside the grace");
    vi.advanceTimersByTime(1);
    assert.equal(claudeSdkStore.get(id), undefined);
    assert.equal(sessionRuntime.get(id), undefined, "its runtime went too");
    assert.equal(session.released, true);

    const reloaded = claudeSdkStore.acquire(id);
    assert.notEqual(reloaded, session);
    assert.deepEqual(reloaded.timelineEntries(), committed);
    ensureRuntimeSessionWithRuntime(sessionRuntime, reloaded);
    assert.deepEqual(viewedTimeline(reloaded), timeline);

    // And it drives on from where it was.
    await sessionRuntime.prompt(id, "second");
    assert.equal(reloaded.timelineEntries().length, 4);
    assert.deepEqual(reloaded.timelineEntries().slice(0, 2), committed);
  });

  test("are never released while someone views them", async () => {
    const { id, session } = acquire();
    await sessionRuntime.prompt(id, "first");
    const viewer = { send: () => {} };
    session.addViewer(viewer);
    vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS * 3);
    assert.equal(resident(id), true);

    session.removeViewer(viewer);
    vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS);
    assert.equal(resident(id), false);
  });

  test("are never released while a turn runs, and get a full grace after it", async () => {
    const { id, session } = acquire();
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));
    const run = sessionRuntime.prompt(id, "slow");
    await vi.waitFor(() => assert.equal(session.isRunning, true));

    vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS * 3);
    assert.equal(resident(id), true, "running");

    open();
    await run;
    vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS - 1);
    assert.equal(resident(id), true, "the turn's end restarted the clock");
    vi.advanceTimersByTime(1);
    assert.equal(resident(id), false);
  });

  test("are never released while a prompt is admitted", () => {
    const { id } = acquire();
    const admitted = sessionRuntime.admitPrompt(id);
    vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS * 3);
    assert.equal(resident(id), true);

    admitted();
    vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS);
    assert.equal(resident(id), false);
  });

  test("get a full grace from every acquisition", () => {
    const { id, session } = acquire();
    vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS - 1_000);
    assert.equal(claudeSdkStore.acquire(id), session);
    vi.advanceTimersByTime(2_000);
    assert.equal(resident(id), true, "the acquisition restarted the clock");
    vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS);
    assert.equal(resident(id), false);
  });

  test("stay resident while their final persist fails, and go once it succeeds", async () => {
    const { id, session } = acquire();
    await sessionRuntime.prompt(id, "first");
    const committed = session.timelineEntries();
    vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS);
    assert.equal(resident(id), false);

    // Rewrite it as a LEGACY single-file record, whose first persist migrates
    // it, and make that migration fail: its new log's path is a directory.
    const record = readClaudeSdkRecord(STORE_DIR, id)!.record;
    removeClaudeSdkRecord(STORE_DIR, id);
    const metaPath = join(STORE_DIR, `${id}.json`);
    const logPath = join(STORE_DIR, `${id}.entries.jsonl`);
    writeFileSync(metaPath, JSON.stringify(record));
    const legacy = claudeSdkStore.acquire(id);
    ensureRuntimeSessionWithRuntime(sessionRuntime, legacy);
    mkdirSync(join(logPath, "blocked"), { recursive: true });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS);
      assert.equal(resident(id), true, "a failed persist keeps it resident");
      assert.equal(legacy.released, false);
      assert.ok(
        "entries" in JSON.parse(readFileSync(metaPath, "utf8")),
        "the legacy record is untouched",
      );
    } finally {
      quiet.mockRestore();
    }

    rmSync(logPath, { recursive: true, force: true });
    vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS);
    assert.equal(resident(id), false, "the next attempt persisted and went");
    assert.equal(
      "entries" in JSON.parse(readFileSync(metaPath, "utf8")),
      false,
      "migrated on the way out",
    );
    assert.deepEqual(claudeSdkStore.acquire(id).timelineEntries(), committed);
  });

  test("once released, are refused at the prompt door rather than bound again", async () => {
    const { id, session } = acquire();
    await sessionRuntime.prompt(id, "first");
    vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS);
    assert.equal(session.released, true);

    assert.throws(
      () => ensureRuntimeSessionWithRuntime(sessionRuntime, session),
      /released from memory/,
    );
    assert.equal(sessionRuntime.get(id), undefined, "nothing was bound");
    await assert.rejects(
      session.createRuntimeAdapter().prompt("late", {}),
      /released from memory/,
    );
  });
});
