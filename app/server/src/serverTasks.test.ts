import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BackgroundWorkBackendEvents } from "./backgroundWork/backends.ts";
import type { ToolCallContext } from "./mcp/tool.ts";
import type { ServerTaskBudget, ServerTaskResult } from "./serverTasks.ts";

const dataDir = mkdtempSync(join(tmpdir(), "server-tasks-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const {
  launchServerTask,
  registerServerTaskBackend,
  ServerTaskBackend,
  SERVER_TASK_DEADLINE_MARGIN_MS,
} = await import("./serverTasks.ts");
const { backgroundWorkSupervisor } =
  await import("./backgroundWork/supervisor.ts");
const { setBackgroundWorkAdmissionsOpenForTests } =
  await import("./backgroundWork/service.ts");
const { backgroundWorkStore } = await import("./db/backgroundWorkStore.ts");
const { backgroundDeliveryOutboxStore } =
  await import("./db/backgroundDeliveryOutboxStore.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { sessionArtifactFile } = await import("./mcp/toolGroups/packRuntime.ts");
const { getSettings, updateSettings } = await import("./settings.ts");

let serial = 0;
function owner(scope: "user" | "internal" = "user"): string {
  serial += 1;
  const id = `server-task-owner-${serial}`;
  sessionStore.upsert({ id, scope, harness: "pi", agentType: "developer" });
  return id;
}

function ctxFor(
  sessionId: string,
  toolCallId = `call-${++serial}`,
): Pick<ToolCallContext, "session" | "toolCallId"> {
  return {
    toolCallId,
    session: { sessionId, harness: "pi", agentType: "developer" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A job that waits for the test to finish it, recording its budget. */
function controlledJob() {
  const result = deferred<ServerTaskResult>();
  const budgets: ServerTaskBudget[] = [];
  return {
    budgets,
    result,
    run: (budget: ServerTaskBudget) => {
      budgets.push(budget);
      return result.promise;
    },
  };
}

function launch(
  ownerSessionId: string,
  run: (budget: ServerTaskBudget) => Promise<ServerTaskResult>,
  options: { requestedTimeoutMs?: number; toolCallId?: string } = {},
) {
  return launchServerTask({
    ctx: ctxFor(ownerSessionId, options.toolCallId),
    kind: "check-watch",
    label: "GitHub PR checks acme/app#42",
    command: "github_watch_pull_request_checks acme/app#42",
    sourceTool: "github_watch_pull_request_checks",
    requestedTimeoutMs: options.requestedTimeoutMs ?? 30_000,
    run,
  });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function receipts(itemId: string) {
  return backgroundDeliveryOutboxStore
    .list()
    .filter((row) => row.itemId === itemId)
    .map((row) => [row.revision, row.disposition, row.retained]);
}

function withLifetime(minutes: number) {
  updateSettings({
    backgroundWork: {
      ...getSettings().backgroundWork,
      enabled: true,
      taskLifetimeMinutes: minutes,
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  setBackgroundWorkAdmissionsOpenForTests(true);
  withLifetime(60);
});

test("boot registers a stoppable server-task port without a launch or reconciliation", async () => {
  registerServerTaskBackend();
  registerServerTaskBackend();
  withLifetime(60);
  const sessionId = owner();
  const admitted = backgroundWorkSupervisor.admit({
    ownerSessionId: sessionId,
    backend: "server-task",
    kind: "check-watch",
    label: "leftover",
    sourceRequestId: "leftover",
    requestedLifetimeMs: 90000,
  });
  if (!admitted.admitted) throw new Error(admitted.message);
  backgroundWorkStore.markRunning({ itemId: admitted.item.id });
  const stopped = await backgroundWorkSupervisor.stopOne({
    itemId: admitted.item.id,
    ownerSessionId: sessionId,
    sourceRequestId: "boot-stop",
    reason: "Stop",
  });
  expect(stopped.state).toBe("stopped");
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(
    index.indexOf('bootStep("server-task backend", registerServerTaskBackend)'),
  ).toBeGreaterThan(-1);
  expect(
    index.indexOf('bootStep("server-task backend", registerServerTaskBackend)'),
  ).toBeLessThan(index.indexOf('bootStep("background-work reconciliation"'));
});

describe("launchServerTask", () => {
  test("admits a hostless check watch whose own timeout ends before its deadline", async () => {
    withLifetime(60);
    const sessionId = owner();
    const job = controlledJob();
    const before = Date.now();
    const started = await launch(sessionId, job.run);
    expect(started.state).toBe("running");
    expect(started.hint).toContain(started.taskId);
    const item = backgroundWorkStore.getItem(started.taskId)!;
    expect(item).toMatchObject({
      backend: "server-task",
      kind: "check-watch",
      label: "GitHub PR checks acme/app#42",
      command: "github_watch_pull_request_checks acme/app#42",
      state: "running",
      lifetimeMs: 30_000 + SERVER_TASK_DEADLINE_MARGIN_MS,
    });
    expect(item.hostId).toBeUndefined();
    expect(item.deadlineAt).toBeGreaterThanOrEqual(before + item.lifetimeMs);
    await settle();
    expect(job.budgets).toHaveLength(1);
    expect(job.budgets[0]!.timeoutMs).toBe(30_000);
    expect(job.budgets[0]!.deadlineAt).toBe(item.deadlineAt);
    expect(job.budgets[0]!.signal.aborted).toBe(false);

    job.result.resolve({
      payload: { observation: { stopReason: "checks_finished" } },
      summary: "Checks finished: success, 3 checks on abc1234",
    });
    await settle();
    const ended = backgroundWorkStore.getItem(started.taskId)!;
    expect(ended.state).toBe("completed");
    expect(ended.outcomeSummary).toBe(
      "Checks finished: success, 3 checks on abc1234",
    );
    expect(ended.evidence).toMatchObject({ text: true, truncated: false });
    const artifact = sessionArtifactFile(
      sessionId,
      ended.evidence!.artifactId!,
    );
    expect(artifact?.artifact.mimeType).toBe("application/json");
    expect(JSON.parse(readFileSync(artifact!.path, "utf8"))).toEqual({
      observation: { stopReason: "checks_finished" },
    });
    expect(receipts(started.taskId)).toEqual([]);
  });

  test("fits a timeout longer than the Settings lifetime inside it", async () => {
    withLifetime(5);
    const job = controlledJob();
    const started = await launch(owner(), job.run, {
      requestedTimeoutMs: 30 * 60_000,
    });
    await settle();
    expect(backgroundWorkStore.getItem(started.taskId)?.lifetimeMs).toBe(
      5 * 60_000,
    );
    expect(job.budgets[0]!.timeoutMs).toBe(
      5 * 60_000 - SERVER_TASK_DEADLINE_MARGIN_MS,
    );
    job.result.resolve({ payload: {}, summary: "Timed out" });
    await settle();
  });

  test("a human Stop aborts the job and keeps whatever it returns afterwards", async () => {
    const sessionId = owner();
    const job = controlledJob();
    const started = await launch(sessionId, job.run);
    await settle();
    const result = await backgroundWorkSupervisor.stopOne({
      itemId: started.taskId,
      ownerSessionId: sessionId,
      sourceRequestId: "human-stop",
      reason: "Stopped from the Background tasks view",
    });
    expect(result.state).toBe("stopped");
    expect(job.budgets[0]!.signal.aborted).toBe(true);
    job.result.resolve({ payload: { late: true }, summary: "late" });
    await settle();
    const stopped = backgroundWorkStore.getItem(started.taskId)!;
    expect(stopped.state).toBe("stopped");
    expect(stopped.evidence).toBeUndefined();
    expect(stopped.outcomeSummary).toBeUndefined();
  });

  test("requester Stop after a planned-drain mark is not described as a restart", async () => {
    const sessionId = owner();
    const job = controlledJob();
    const started = await launch(sessionId, job.run);
    await settle();
    backgroundWorkStore.recordPlannedDrain({
      itemId: started.taskId,
      reason: "stopped-for-deployment",
    });
    const stop = backgroundWorkSupervisor.stopOne({
      itemId: started.taskId,
      ownerSessionId: sessionId,
      sourceRequestId: "requester-during-drain",
      reason: "User stopped",
    });
    job.result.resolve({ payload: {}, summary: "done" });
    await stop;
    const notices = await import("./backgroundCompletionNotices.ts");
    const enqueue = vi.fn();
    notices.enqueueCompletionNotice(
      { enqueue } as never,
      backgroundWorkStore.getItem(started.taskId)!,
      false,
    );
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]![1].outcomeSummary ?? "").not.toMatch(
      /server restart/,
    );
  });

  test("Stop after commit keeps the real result and does not abort the write", async () => {
    const sessionId = owner();
    const job = controlledJob();
    const started = await launch(sessionId, job.run);
    await settle();
    const budget = job.budgets[0]!;
    expect(budget.itemId).toBe(started.taskId);
    budget.commit();
    const stop = backgroundWorkSupervisor.stopOne({
      itemId: started.taskId,
      ownerSessionId: sessionId,
      sourceRequestId: "stop-after-commit",
      reason: "Stop",
    });
    await settle();
    expect(budget.signal.aborted).toBe(false);
    job.result.resolve({ payload: { merged: true }, summary: "Merged" });
    await stop;
    await settle();
    expect(backgroundWorkStore.getItem(started.taskId)).toMatchObject({
      state: "completed",
      outcomeSummary: "Merged",
    });
  });

  test("a Stop before commit prevents the outward step", async () => {
    const sessionId = owner();
    const job = controlledJob();
    const started = await launch(sessionId, job.run);
    await settle();
    const stop = backgroundWorkSupervisor.stopOne({
      itemId: started.taskId,
      ownerSessionId: sessionId,
      sourceRequestId: "stop-before-commit",
      reason: "Stop",
    });
    await settle();
    expect(() => job.budgets[0]!.commit()).toThrow();
    job.result.reject(new Error("Stopped"));
    await stop;
    expect(backgroundWorkStore.getItem(started.taskId)?.state).toBe("stopped");
  });

  test("an owner Stop-all exemption keeps only the named item", async () => {
    const sessionId = owner();
    const own = controlledJob();
    const sibling = controlledJob();
    const first = await launch(sessionId, own.run);
    const second = await launch(sessionId, sibling.run);
    await settle();
    const stopping = backgroundWorkSupervisor.stopAllOwner({
      ownerSessionId: sessionId,
      exceptItemIds: [first.taskId],
      sourceRequestId: "remove-worktree",
      reason: "Removed",
    });
    await settle();
    sibling.result.resolve({ payload: {}, summary: "stopped" });
    await stopping;
    expect(backgroundWorkStore.getItem(first.taskId)?.state).toBe("running");
    expect(own.budgets[0]!.signal.aborted).toBe(false);
    expect(backgroundWorkStore.getItem(second.taskId)?.state).toBe("stopped");
    own.result.resolve({
      payload: { merged: true },
      summary: "Merged and removed",
    });
    await settle();
    expect(backgroundWorkStore.getItem(first.taskId)?.state).toBe("completed");
  });

  test("a job that throws ends failed with its message", async () => {
    const started = await launch(owner(), async () => {
      throw new Error("GitHub returned no pull request #42.");
    });
    await settle();
    const failed = backgroundWorkStore.getItem(started.taskId)!;
    expect(failed.state).toBe("failed");
    expect(failed.outcomeSummary).toBe("GitHub returned no pull request #42.");
  });

  test("a retried tool call answers with the task it already started", async () => {
    const sessionId = owner();
    const job = controlledJob();
    const first = await launch(sessionId, job.run, { toolCallId: "retry-me" });
    const again = await launch(sessionId, job.run, { toolCallId: "retry-me" });
    await settle();
    expect(again.taskId).toBe(first.taskId);
    expect(job.budgets).toHaveLength(1);
    job.result.resolve({ payload: {}, summary: "done" });
    await settle();
  });

  test("a refused admission throws and creates no row", async () => {
    const run = vi.fn(async () => ({ payload: {}, summary: "never" }));
    const cases: Array<[string, () => string]> = [
      [
        "disabled",
        () => {
          updateSettings({
            backgroundWork: { ...getSettings().backgroundWork, enabled: false },
          });
          return owner();
        },
      ],
      [
        "draining",
        () => {
          setBackgroundWorkAdmissionsOpenForTests(false);
          return owner();
        },
      ],
      ["non-user owner", () => owner("internal")],
      ["unknown owner", () => "no-such-session"],
    ];
    for (const [name, arrange] of cases) {
      const sessionId = arrange();
      await expect(launch(sessionId, run), name).rejects.toThrow(
        /^Background work denied: /,
      );
      expect(
        backgroundWorkStore.listItems({ ownerSessionId: sessionId, limit: 5 }),
        name,
      ).toEqual([]);
      setBackgroundWorkAdmissionsOpenForTests(true);
      withLifetime(60);
    }
    expect(run).not.toHaveBeenCalled();
  });

  test("the deadline Stop ends a job that ignores its budget, and owes the owner its notice", async () => {
    vi.useFakeTimers();
    withLifetime(5);
    let signal: AbortSignal | undefined;
    const started = await launch(
      owner(),
      (budget) => {
        signal = budget.signal;
        return new Promise(() => {});
      },
      { requestedTimeoutMs: 30 * 60_000 },
    );
    const item = backgroundWorkStore.getItem(started.taskId)!;
    await vi.advanceTimersByTimeAsync(item.deadlineAt - Date.now());
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    const stopped = backgroundWorkStore.getItem(started.taskId)!;
    expect(stopped.state).toBe("stopped");
    expect(stopped.stopOrigin).toBe("deadline");
    expect(receipts(started.taskId)).toEqual([
      [stopped.revision, "wake", true],
    ]);
  });
});

describe("Stop-all across backends", () => {
  test("a watch started while another backend's Stop-all is pending is not this Stop's", async () => {
    // A native backend whose Stop-all answers only when the test says so.
    let release: (() => void) | undefined;
    const nativeStopAlls: string[][] = [];
    backgroundWorkSupervisor.registerBackend({
      backend: "host-process",
      launch: async () => ({ launched: true }),
      stop: async () => ({ acknowledged: true }),
      stopAll: async (request) => {
        nativeStopAlls.push([...request.itemIds]);
        await new Promise<void>((resolve) => (release = resolve));
        return {
          acknowledgedItemIds: [...request.itemIds],
          unconfirmedItemIds: [],
        };
      },
    });
    const sessionId = owner();
    const old = controlledJob();
    const oldWatch = await launch(sessionId, old.run);
    // Newer, so the Stop-all visits the native backend first.
    const admission = backgroundWorkSupervisor.admit({
      ownerSessionId: sessionId,
      backend: "host-process",
      kind: "shell",
      label: "pnpm run test",
      sourceRequestId: "native-shell",
    });
    if (!admission.admitted) throw new Error(admission.message);
    const native = await backgroundWorkSupervisor.launch(admission);
    await settle();

    const stopping = backgroundWorkSupervisor.stopAllOwner({
      ownerSessionId: sessionId,
      sourceRequestId: "human-stop-all",
      reason: "Stopped from the Background tasks view",
    });
    await settle();
    expect(nativeStopAlls).toEqual([[native!.id]]);
    // The agent starts another watch before the native answer arrives.
    const fresh = controlledJob();
    const freshWatch = await launch(sessionId, fresh.run);
    await settle();
    release!();
    await stopping;

    expect(backgroundWorkStore.getItem(oldWatch.taskId)?.state).toBe("stopped");
    expect(old.budgets[0]!.signal.aborted).toBe(true);
    expect(backgroundWorkStore.getItem(native!.id)?.state).toBe("stopped");
    expect(fresh.budgets[0]!.signal.aborted).toBe(false);
    expect(backgroundWorkStore.getItem(freshWatch.taskId)).toMatchObject({
      state: "running",
      stopState: "none",
    });
    // And it still delivers its own result.
    fresh.result.resolve({ payload: { ok: true }, summary: "done" });
    await settle();
    expect(backgroundWorkStore.getItem(freshWatch.taskId)?.state).toBe(
      "completed",
    );
  });
});

describe("ServerTaskBackend", () => {
  function events(): BackgroundWorkBackendEvents & {
    completions: string[];
  } {
    const completions: string[] = [];
    return {
      completions,
      providerBound: () => {},
      activity: () => {},
      activityRateExceeded: () => {},
      outputCaptured: () => {},
      completed: (completion) => void completions.push(completion.itemId),
    };
  }

  async function start(
    port: InstanceType<typeof ServerTaskBackend>,
    itemId: string,
    ownerSessionId: string,
    signals: Map<string, AbortSignal>,
  ) {
    port.reserve(itemId, {
      ownerSessionId,
      kind: "check-watch",
      label: itemId,
      sourceTool: "test",
      timeoutMs: 1_000,
      deadlineAt: Date.now() + 61_000,
      run: (budget) => {
        signals.set(itemId, budget.signal);
        return new Promise((_resolve, reject) =>
          budget.signal.addEventListener("abort", () =>
            reject(new Error("stopped")),
          ),
        );
      },
    });
    const ack = await port.launch({
      target: { itemId, ownerSessionId, kind: "check-watch" },
      deadlineAt: Date.now() + 61_000,
      emptyHostGraceMs: 0,
    });
    expect(ack).toEqual({ launched: true });
  }

  test("concurrent Stop-alls of two owners each stop only that owner's jobs", async () => {
    const sink = events();
    const port = new ServerTaskBackend({ events: sink });
    const signals = new Map<string, AbortSignal>();
    await start(port, "a-1", "owner-a", signals);
    await start(port, "a-2", "owner-a", signals);
    await start(port, "b-1", "owner-b", signals);
    await start(port, "c-1", "owner-c", signals);
    await settle();
    const [a, b] = await Promise.all([
      port.stopAll({
        ownerSessionId: "owner-a",
        sourceRequestId: "drain-a",
        itemIds: ["a-1", "a-2"],
        attempt: 1,
        reason: "deployment",
        protectOrdinaryTurn: false,
      }),
      port.stopAll({
        ownerSessionId: "owner-b",
        sourceRequestId: "drain-b",
        itemIds: ["b-1"],
        attempt: 1,
        reason: "deployment",
        protectOrdinaryTurn: false,
      }),
    ]);
    expect(a.acknowledgedItemIds.sort()).toEqual(["a-1", "a-2"]);
    expect(b.acknowledgedItemIds).toEqual(["b-1"]);
    expect(signals.get("c-1")?.aborted).toBe(false);
    // Only the items named: owner-a's job started after the reservation stays.
    await start(port, "a-3", "owner-a", signals);
    await settle();
    expect(
      await port.stopAll({
        ownerSessionId: "owner-a",
        sourceRequestId: "drain-a-again",
        itemIds: [],
        attempt: 1,
        reason: "deployment",
        protectOrdinaryTurn: false,
      }),
    ).toEqual({ acknowledgedItemIds: [], unconfirmedItemIds: [] });
    expect(signals.get("a-3")?.aborted).toBe(false);
    // A stopped job reports nothing.
    expect(sink.completions).toEqual([]);
    // Another owner cannot reach c-1 by its id.
    expect(
      await port.stop({
        target: {
          itemId: "c-1",
          ownerSessionId: "owner-a",
          kind: "check-watch",
        },
        sourceRequestId: "wrong-owner",
        attempt: 1,
        reason: "nope",
      }),
    ).toMatchObject({ acknowledged: false });
    expect(signals.get("c-1")?.aborted).toBe(false);
  });

  test("committed work outliving Stop grace is unconfirmed, then preserves its failure", async () => {
    const sink = events();
    const port = new ServerTaskBackend({ events: sink, stopGraceMs: 1 });
    const job = controlledJob();
    port.reserve("committed", {
      ownerSessionId: "o",
      kind: "merge-when-ready",
      label: "merge",
      sourceTool: "test",
      timeoutMs: 1000,
      deadlineAt: Date.now() + 61000,
      run: job.run,
    });
    await port.launch({
      target: {
        itemId: "committed",
        ownerSessionId: "o",
        kind: "merge-when-ready",
      },
      deadlineAt: Date.now() + 61000,
      emptyHostGraceMs: 0,
    });
    await settle();
    job.budgets[0]!.commit();
    expect(
      await port.stopAll({
        ownerSessionId: "o",
        sourceRequestId: "stop",
        itemIds: ["committed"],
        attempt: 1,
        reason: "Stop",
        protectOrdinaryTurn: false,
      }),
    ).toEqual({ acknowledgedItemIds: [], unconfirmedItemIds: ["committed"] });
    expect(job.budgets[0]!.signal.aborted).toBe(false);
    job.result.reject(new Error("uncertain provider write"));
    await settle();
    expect(sink.completions).toEqual(["committed"]);
  });

  test("Stop-all confirms reserved tasks absent from this process", async () => {
    const port = new ServerTaskBackend({ events: events() });
    expect(
      await port.stopAll({
        ownerSessionId: "o",
        sourceRequestId: "stop",
        itemIds: ["leftover"],
        attempt: 1,
        reason: "Stop",
        protectOrdinaryTurn: false,
      }),
    ).toEqual({ acknowledgedItemIds: ["leftover"], unconfirmedItemIds: [] });
  });

  test("a launch without its reservation starts nothing", async () => {
    const port = new ServerTaskBackend({ events: events() });
    expect(
      await port.launch({
        target: { itemId: "missing", ownerSessionId: "o", kind: "check-watch" },
        deadlineAt: Date.now() + 1_000,
        emptyHostGraceMs: 0,
      }),
    ).toMatchObject({ launched: false });
  });

  test("a result that cannot be kept still completes, saying why", async () => {
    const outputs: unknown[] = [];
    const sink = {
      ...events(),
      outputCaptured: (o: unknown) => outputs.push(o),
    };
    const port = new ServerTaskBackend({
      events: sink,
      stageArtifact: () => {
        throw new Error("disk full");
      },
    });
    port.reserve("kept", {
      ownerSessionId: "o",
      kind: "check-watch",
      label: "kept",
      sourceTool: "test",
      timeoutMs: 1_000,
      deadlineAt: Date.now() + 61_000,
      run: async () => ({ payload: {}, summary: "done" }),
    });
    await port.launch({
      target: { itemId: "kept", ownerSessionId: "o", kind: "check-watch" },
      deadlineAt: Date.now() + 61_000,
      emptyHostGraceMs: 0,
    });
    await settle();
    expect(outputs).toEqual([
      {
        itemId: "kept",
        eventId: "kept:output",
        evidence: { refusalReason: "artifact-write-failed" },
      },
    ]);
    expect(sink.completions).toEqual(["kept"]);
  });
});
