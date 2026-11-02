/**
 * What `session_lookup`/`session_read` tell a coordinator about a running peer:
 * observed activity and queued work, never content, and silence as silence.
 */
import assert from "node:assert/strict";
import { afterAll, afterEach, test, vi } from "vitest";
import { sessionRuntime } from "../../session/runtimeInstance.ts";
import { installBackgroundUpdateQueue } from "../../backgroundUpdateQueue.ts";
import { backgroundWorkStore } from "../../db/backgroundWorkStore.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import { liveActivityFields } from "./sessionInspection.ts";
import type {
  AdapterEvent,
  AgentRunResult,
  PromptableAdapter,
} from "../../session/adapters/contract.ts";

class ScriptedAdapter implements PromptableAdapter {
  readonly provider = "scripted";
  readonly capabilities = {
    fork: "none" as const,
    compact: false,
    attachments: false,
  };
  private listeners = new Set<(event: AdapterEvent) => void>();
  subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: AdapterEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  getBinding() {
    return { provider: this.provider, nativeId: "n" };
  }
  prompt(): Promise<AgentRunResult> {
    return new Promise(() => {});
  }
  abort(): void {}
  setModel(): void {}
  setReasoning(): void {}
  dispose(): void {}
}

afterEach(() => {
  installBackgroundUpdateQueue(undefined);
  vi.useRealTimers();
});
afterAll(async () => {
  await sessionRuntime.dispose();
});

test("a running peer reports what it is observed doing, in seconds", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const adapter = new ScriptedAdapter();
  sessionRuntime.createSession("peer-live", adapter);
  adapter.emit({ type: "messageStarted", streamId: "m", run: 1 });
  vi.setSystemTime(1_004_000);
  adapter.emit({
    type: "toolStarted",
    streamId: "t1",
    toolCallId: "t1",
    name: "Bash",
    input: { command: "secret-ish argument" },
    run: 1,
  });
  vi.setSystemTime(1_010_000);

  const fields = liveActivityFields("peer-live", "running");
  assert.deepEqual(fields.liveActivity, {
    phase: "tool",
    runningForSec: 10,
    lastActivitySecAgo: 6,
    lastModelOutputSecAgo: 6,
    runningTools: [{ name: "Bash", forSec: 6 }],
    lastTool: { name: "Bash", state: "started", secAgo: 6 },
  });
  assert.ok(
    !JSON.stringify(fields).includes("secret-ish"),
    "tool arguments never leave the runtime",
  );

  // A provider that has said nothing since the tool finished is reported as
  // waiting, with how long — not as stalled.
  adapter.emit({
    type: "passthrough",
    envelope: {
      type: "toolEnd",
      sessionId: "peer-live",
      id: "m",
      toolId: "t1",
      output: "",
      isError: false,
    },
    run: 1,
  });
  vi.setSystemTime(1_100_000);
  const quiet = liveActivityFields("peer-live", "running").liveActivity!;
  assert.equal(quiet.phase, "waiting");
  assert.equal(quiet.waitingForModelSec, 90);
  assert.equal(quiet.lastModelOutputSecAgo, 96);

  adapter.emit({
    type: "providerRetry",
    attempt: 4,
    maxAttempts: 10,
    status: 529,
    run: 1,
  });
  assert.deepEqual(
    liveActivityFields("peer-live", "running").liveActivity!.providerRetry,
    { attempt: 4, maxAttempts: 10, status: 529, secAgo: 0 },
  );
});

function reserve(
  owner: string,
  label: string,
  options: { kind?: "shell" | "check-watch"; start?: boolean } = {},
) {
  sessionStore.upsert({
    id: owner,
    harness: "pi",
    agentType: "developer",
    title: owner,
    scope: "user",
  });
  const item = backgroundWorkStore.reserveItem({
    ownerSessionId: owner,
    backend: options.kind === "check-watch" ? "server-task" : "host-process",
    kind: options.kind ?? "shell",
    label,
    command: "curl -H 'Authorization: secret-ish'",
    sourceRequestId: `${owner}-${label}`,
    lifetimeMs: 3_600_000,
    settingsGeneration: 1,
    bootEpoch: "test",
    ownerLimit: 100,
    now: 1_000_000,
  });
  return options.start === false
    ? item
    : backgroundWorkStore.markRunning({ itemId: item.id, now: 1_000_000 });
}

test("an idle or unloaded session still reports the background work it waits on", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_090_000);
  reserve("watcher", "GitHub PR checks o/r#1", { kind: "check-watch" });
  const server = reserve("watcher", "Vite dev server");
  backgroundWorkStore.setIntent({
    itemId: server.id,
    ownerSessionId: "watcher",
    intent: "service",
  });

  const fields = liveActivityFields("watcher", "not_loaded");
  assert.equal(fields.liveActivity, undefined, "no turn, so no run activity");
  assert.deepEqual(
    {
      awaited: fields.backgroundWork?.awaited,
      services: fields.backgroundWork?.services,
    },
    { awaited: 1, services: 1 },
  );
  const watch = fields.backgroundWork?.items.find(
    (item) => item.kind === "check-watch",
  );
  assert.deepEqual(watch, {
    kind: "check-watch",
    label: "GitHub PR checks o/r#1",
    intent: "awaited",
    state: "running",
    forSec: 90,
    deadlineInSec: 3_510,
  });
  assert.ok(
    !JSON.stringify(fields).includes("secret-ish"),
    "the command never leaves the registry",
  );
  assert.equal(
    liveActivityFields("watcher", "idle").backgroundWork?.awaited,
    1,
    "idle reports it the same",
  );
});

test("background work lists a bounded window and counts every item", () => {
  for (let index = 0; index < 7; index++)
    reserve("busy", `job ${index}`, { start: index !== 0 });
  const work = liveActivityFields("busy", "idle").backgroundWork!;
  assert.equal(work.awaited, 7);
  assert.equal(work.items.length, 5);
  assert.equal(work.more, 2);
});

test("an idle or unloaded session reports no activity; queued work is counted either way", () => {
  assert.deepEqual(liveActivityFields("nobody", "not_loaded"), {});
  installBackgroundUpdateQueue({
    count: (id) => (id === "held" ? 3 : 0),
    unhandled: (id) =>
      id === "failed"
        ? {
            count: 2,
            batch: [{ itemId: "bgw_a", revision: 3, attemptId: "attempt-1" }],
          }
        : { count: 0, batch: [] },
    publish: () => {},
  });
  assert.deepEqual(liveActivityFields("held", "idle"), {
    queuedWork: { backgroundUpdates: 3 },
  });
  assert.deepEqual(
    liveActivityFields("failed", "idle"),
    { queuedWork: { unhandledBackgroundUpdates: 2 } },
    "updates a turn did not finish are inspectable too",
  );
});
