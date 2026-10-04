/**
 * Accepting a pi `/commit` dry run runs as a synthetic host-command turn: its
 * progress streams into the tool block, the commit card ends it (or the
 * failure does), and the session is idle and drivable again afterwards.
 *
 * Run through Vitest: `pnpm --filter @assistant/server test src/piSdk/piCommitAccept.test.ts`
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import type { AdapterEvent } from "../session/adapters/contract.ts";

const tmp = mkdtempSync(join(tmpdir(), "pi-commit-accept-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const accept = vi.fn();
vi.mock("../commitWorkflow.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commitWorkflow.ts")>()),
  acceptCommitDryRun: (...args: unknown[]) => accept(...args),
  toCommitDisplay: () => ({ status: "committed", commitHash: "abc1234" }),
}));

const { PiLiveSession } = await import("./PiLiveSession.ts");
const { closeDb } = await import("../db/index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => accept.mockReset());

let counter = 0;

/** A viewed pi session, what its viewer is sent and what its runtime adapter hears. */
function viewedSession(opts: { reloadQueued?: boolean } = {}) {
  const sent: ServerMessage[] = [];
  const events: AdapterEvent[] = [];
  const live = new PiLiveSession(
    "developer" as never,
    {
      sessionId: `pi-accept-${counter++}`,
      sessionName: "Already named",
      isStreaming: false,
      sessionManager: {
        getBranch: () => [],
        getEntries: () => [],
        getHeader: () => undefined,
      },
      subscribe: () => () => {},
      getSessionStats: () => ({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        contextSize: 0,
      }),
      dispose: () => {},
    } as never,
    {
      broadcastSessions: () => Promise.resolve(),
      noteRunStarted: () => {},
      checkPendingReload: () => {},
      isReloadQueued: () => opts.reloadQueued ?? false,
      browserRuntimesFor: () => [],
    } as never,
    () => {},
  );
  live.addViewer({ send: (message) => sent.push(message) });
  live.subscribeAdapterEvents((event) => events.push(event));
  return { live, sent, events };
}

/** The turn's own messages, without the state and context refreshes. */
function turnMessages(sent: ServerMessage[]) {
  return sent
    .filter((m) => m.type !== "state" && m.type !== "contextInfo")
    .map((m) => {
      const { type } = m;
      if (type === "toolUpdate") return `${type}:${m.output}`;
      if (type === "toolEnd") return `${type}:${m.output}:${m.isError}`;
      if (type === "assistantEnd") return `${type}:${m.error ?? ""}`;
      return type;
    });
}

test("an accepted dry run streams progress and ends with the commit card", async () => {
  const { live, sent, events } = viewedSession();
  accept.mockImplementation(
    async (opts: { onProgress: (message: string) => void }) => {
      opts.onProgress("Committing…");
      return {};
    },
  );

  await live.acceptCommitDryRun("entry-1");

  assert.deepEqual(accept.mock.calls[0]?.[0]?.entryId, "entry-1");
  assert.deepEqual(turnMessages(sent), [
    "assistantStart",
    "toolStart",
    "toolUpdate:Starting…",
    "toolUpdate:Committing…",
    "commitResult",
    "assistantEnd:",
  ]);
  const card = sent.find((m) => m.type === "commitResult");
  assert.deepEqual((card as { commit?: unknown }).commit, {
    status: "committed",
    commitHash: "abc1234",
  });
  // The card is the turn's durable entry, under the commit name.
  assert.deepEqual(events.at(-1), {
    type: "hostCommandResult",
    name: "commit",
    card: {
      kind: "commit",
      id: card?.id,
      commit: (card as { commit?: unknown }).commit,
    },
  });
  assert.equal(live.isRunning, false);
  // Idle again: a slash command may start.
  live.beginSyntheticTool("/commit", {});
});

test("a failed accept ends the turn with the error", async () => {
  const { live, sent, events } = viewedSession();
  accept.mockRejectedValue(new Error("the dry run is stale"));

  await live.acceptCommitDryRun("entry-2");

  assert.deepEqual(turnMessages(sent).slice(-2), [
    "toolEnd:the dry run is stale:true",
    "assistantEnd:the dry run is stale",
  ]);
  // The failure is the turn's durable error, not a card.
  const completed = events.find((e) => e.type === "messageCompleted");
  assert.deepEqual(
    completed?.type === "messageCompleted"
      ? [completed.stopReason, completed.error]
      : undefined,
    ["error", "the dry run is stale"],
  );
  assert.ok(!events.some((e) => e.type === "hostCommandResult"));
  assert.equal(live.isRunning, false);
});

test("an accept is refused while the session runs", async () => {
  const { live } = viewedSession();
  live.beginSyntheticTool("/commit", {});
  await assert.rejects(
    live.acceptCommitDryRun("entry-3"),
    /Cannot accept a commit dry run while the agent is streaming/,
  );
  assert.equal(accept.mock.calls.length, 0);
});

test("an accept is refused while a dev reload is queued", async () => {
  const { live, sent } = viewedSession({ reloadQueued: true });
  await assert.rejects(live.acceptCommitDryRun("entry-4"));
  assert.equal(accept.mock.calls.length, 0);
  assert.deepEqual(turnMessages(sent), [], "no turn opened");
});
