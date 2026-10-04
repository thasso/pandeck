/**
 * The harness-independent `/clear` runner (Task: in-place context clear).
 *
 * `/clear` shares one seam with `/compact` (`SyntheticToolHost`), so the runner
 * is tested once against a fake host: the memory flush happens BEFORE context
 * goes away, the delivered snapshot is reset only when a clear actually landed,
 * and the result is a boundary card rather than tool text.
 *
 * The fake is STATEFUL on purpose — `beginSyntheticTool` refuses a running
 * session and then marks the session running, exactly like both real harnesses.
 * A stubbed begin that skips that transition hides the failure mode this file
 * exists to prevent: a runner that reads the running flag AFTER opening its own
 * turn refuses every time and never reaches the harness at all.
 *
 * Run: pnpm --filter @assistant/server test src/hostSlashCommands.clear.test.ts
 */
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { slashCommandApplies } from "@assistant/shared";
import type { HostCommandResult } from "./sessionKit/hostCommandTurn.ts";
import {
  hostSlashCommandRunner,
  runClearForHost,
  type HostClearOutcome,
  type SyntheticToolHost,
} from "./hostSlashCommands.ts";
import { findSlashCommand } from "./slashCommands.ts";

const calls: string[] = [];

vi.mock("./memory/memoryScheduler.ts", () => ({
  memoryScheduler: {
    flushBeforeReset: async () => {
      calls.push("flush");
    },
  },
}));

vi.mock("./memory/memoryRuntime.ts", () => ({
  resetMemorySessionContext: () => {
    calls.push("reset");
  },
}));

interface FakeHost {
  host: SyntheticToolHost;
  finishedTools: Array<{ output: string; isError: boolean | undefined }>;
  cards: Array<{ tokensBefore?: number }>;
  isRunning: () => boolean;
}

function fakeHost(
  outcome: HostClearOutcome | Error,
  options: { running?: boolean } = {},
): FakeHost {
  const finishedTools: FakeHost["finishedTools"] = [];
  const cards: FakeHost["cards"] = [];
  const state = { running: options.running ?? false };
  const host = {
    kind: "developer",
    sessionId: "clear-session",
    get isRunning() {
      return state.running;
    },
    beginSyntheticTool: () => {
      // Both real harnesses refuse here and then own the turn.
      if (state.running)
        throw new Error(
          "Cannot run a slash command while the agent is streaming.",
        );
      state.running = true;
      return { assistantId: "a-1", toolId: "t-1" };
    },
    updateSyntheticTool: () => {},
    finishSyntheticTool: (
      _toolId: string,
      output: string,
      isError?: boolean,
    ) => {
      state.running = false;
      finishedTools.push({ output, isError });
    },
    finishSyntheticCard: (result: HostCommandResult) => {
      state.running = false;
      if (result.kind !== "contextClear")
        throw new Error(`unexpected ${result.kind} card`);
      cards.push(result.contextClear);
    },
    clearContext: async () => {
      calls.push("clear");
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  } as unknown as SyntheticToolHost;
  return { host, finishedTools, cards, isRunning: () => state.running };
}

test("/clear flushes memory first, then resets the snapshot, and renders the card", async () => {
  calls.length = 0;
  const fake = fakeHost({ kind: "cleared", tokensBefore: 51_000 });
  await runClearForHost(fake.host);
  // Reaching the harness at all is half the assertion: the synthetic turn this
  // runner opened has the session marked running for its whole duration.
  assert.deepEqual(
    calls,
    ["flush", "clear", "reset"],
    "observations are learned from the real conversation, before it is dropped",
  );
  assert.equal(fake.finishedTools.length, 0, "no plain tool output on success");
  assert.deepEqual(
    fake.cards,
    [{ tokensBefore: 51_000 }],
    "one boundary card carrying what was dropped",
  );
});

test("a harness with nothing to clear reports it as plain output and keeps the snapshot", async () => {
  calls.length = 0;
  const fake = fakeHost({
    kind: "skipped",
    reason: "Nothing to clear — this session has no context yet.",
  });
  await runClearForHost(fake.host);
  assert.deepEqual(calls, ["flush", "clear"], "nothing was replaced, no reset");
  assert.equal(fake.cards.length, 0, "no boundary card for a skipped clear");
  assert.equal(fake.finishedTools.length, 1);
  assert.equal(fake.finishedTools[0]!.isError, false);
  assert.match(fake.finishedTools[0]!.output, /Nothing to clear/);
});

test("a session already running a turn refuses before any turn is opened", async () => {
  calls.length = 0;
  const fake = fakeHost({ kind: "cleared" }, { running: true });
  await assert.rejects(
    runClearForHost(fake.host),
    /while the agent is streaming/i,
    "the harness's own refusal reaches the dispatcher",
  );
  assert.deepEqual(calls, [], "neither the flush nor the harness step ran");
  assert.equal(fake.cards.length, 0);
  assert.equal(
    fake.finishedTools.length,
    0,
    "no turn was opened, so none is finished",
  );
});

test("a harness failure lands as an error turn, not a card", async () => {
  calls.length = 0;
  const fake = fakeHost(new Error("Background work still holds this host."));
  await runClearForHost(fake.host);
  assert.equal(fake.cards.length, 0);
  assert.equal(fake.finishedTools.length, 1);
  assert.equal(fake.finishedTools[0]!.isError, true);
  assert.match(fake.finishedTools[0]!.output, /Background work/);
  assert.ok(
    !calls.includes("reset"),
    "a failed clear leaves the memory snapshot alone",
  );
});

test("/clear is registered as a host runner and applies to every harness", () => {
  assert.equal(
    hostSlashCommandRunner("clear"),
    runClearForHost,
    "dispatch reaches the shared runner",
  );
  const cmd = findSlashCommand("clear");
  assert.ok(cmd, "the registry still carries /clear");
  assert.equal(
    cmd.execution,
    undefined,
    "it is a host command, not client-run",
  );
  for (const harness of ["pi", "claude-sdk"] as const)
    assert.equal(
      slashCommandApplies(cmd, "developer", harness),
      true,
      `/clear applies on ${harness}`,
    );
  assert.equal(
    slashCommandApplies(cmd, "personal-assistant", "claude-sdk"),
    true,
    "the permanent assistant can shed context too",
  );
});
