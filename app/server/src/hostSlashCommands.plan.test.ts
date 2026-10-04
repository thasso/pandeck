/**
 * Plan-mode refusal of the git-writing host commands (Task 332).
 *
 * `/commit`, `/push` and `/pr` run through ONE harness-independent seam
 * (`SyntheticToolHost`), so this tests the guard once with a fake host: a
 * session whose `sessionMode` is "plan" gets a finished error tool turn and no
 * workflow runs; a Build (or mode-less) session passes the guard.
 *
 * Run: pnpm --filter @assistant/server test src/hostSlashCommands.plan.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionMode } from "@assistant/shared";
import type { HostCommandResult } from "./sessionKit/hostCommandTurn.ts";
import {
  runCommitForHost,
  runPrForHost,
  runPushForHost,
  type SyntheticToolHost,
} from "./hostSlashCommands.ts";

interface FinishedTool {
  name: string;
  output: string;
  isError: boolean | undefined;
}

function fakeHost(sessionMode: SessionMode | undefined): {
  host: SyntheticToolHost;
  finished: FinishedTool[];
  contextReads: number;
} {
  const finished: FinishedTool[] = [];
  const state = { contextReads: 0, activeName: "" };
  const host = {
    kind: "developer",
    sessionId: "session-plan",
    sessionMode,
    beginSyntheticTool: (name: string) => {
      state.activeName = name;
      return { assistantId: "a-1", toolId: "t-1" };
    },
    updateSyntheticTool: () => {},
    finishSyntheticTool: (
      _toolId: string,
      output: string,
      isError?: boolean,
    ) => {
      finished.push({ name: state.activeName, output, isError });
    },
    finishSyntheticCard: (result: HostCommandResult) => {
      if (result.kind !== "push") return;
      finished.push({
        name: state.activeName,
        output: result.push.error ?? result.push.output ?? "",
        isError: Boolean(result.push.error),
      });
    },
    commitWorkflowContext: () => {
      state.contextReads += 1;
      // A nonexistent cwd: if the guard is missed the workflow itself fails,
      // which the assertions below tell apart via `contextReads`.
      return { sessionManager: {}, cwd: "/path/that/does/not/exist" };
    },
  } as unknown as SyntheticToolHost;
  return {
    host,
    finished,
    get contextReads() {
      return state.contextReads;
    },
  };
}

const runners: Array<
  [string, (host: SyntheticToolHost, rawArgs: string) => Promise<void>]
> = [
  ["/commit", runCommitForHost],
  ["/push", runPushForHost],
  ["/pr", runPrForHost],
];

test("a Plan session refuses /commit, /push and /pr with a legible error turn", async () => {
  for (const [name, run] of runners) {
    const fake = fakeHost("plan");
    await run(fake.host, "");
    assert.equal(fake.finished.length, 1, `${name} should finish one turn`);
    const turn = fake.finished[0]!;
    assert.equal(turn.name, name);
    assert.equal(turn.isError, true);
    assert.match(turn.output, /in Plan/);
    assert.match(turn.output, /switch the session to build/i);
    // Binding wording (epic decision 1): never claim Plan is read-only/enforced.
    assert.doesNotMatch(turn.output, /read.?only|enforced|safe/i);
    // The refusal happens before any workflow work.
    assert.equal(fake.contextReads, 0, `${name} must not start its workflow`);
  }
});

test("a Build (or mode-less) session passes the Plan guard into the workflow", async () => {
  for (const mode of ["build", undefined] as const) {
    const fake = fakeHost(mode);
    await runPushForHost(fake.host, "");
    // The workflow ran (and failed on the fake cwd) — the point is that it was
    // REACHED, not refused up front.
    assert.equal(fake.contextReads, 1);
    assert.equal(fake.finished.length, 1);
    assert.doesNotMatch(fake.finished[0]!.output, /in Plan/);
  }
});
