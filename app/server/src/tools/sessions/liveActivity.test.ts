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
import { backgroundWorkTitle } from "../../backgroundWork/title.ts";
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

let reserved = 0;

/**
 * One active item, titled the way production admission titles it: a server
 * task by its own label, a shell through `backgroundWorkTitle`, which falls
 * back to the command line when the agent gave no description.
 */
function reserve(
  owner: string,
  options: {
    watch?: string;
    description?: string;
    command?: string;
    service?: boolean;
    start?: boolean;
    now?: number;
  } = {},
) {
  sessionStore.upsert({
    id: owner,
    harness: "pi",
    agentType: "developer",
    title: owner,
    scope: "user",
  });
  const command = options.command ?? "deploy --target secret-ish-argument";
  const now = options.now ?? 1_000_000;
  const item = backgroundWorkStore.reserveItem({
    ownerSessionId: owner,
    ...(options.watch
      ? {
          backend: "server-task" as const,
          kind: "check-watch" as const,
          label: options.watch,
          command: `github_watch_pull_request_checks ${options.watch}`,
        }
      : {
          backend: "host-process" as const,
          kind: "shell" as const,
          label: backgroundWorkTitle({
            description: options.description,
            command,
            fallback: "Background shell command",
          }),
          ...(options.description ? { description: options.description } : {}),
          command,
        }),
    sourceRequestId: `${owner}-${(reserved += 1)}`,
    lifetimeMs: 3_600_000,
    settingsGeneration: 1,
    bootEpoch: "test",
    ownerLimit: 1_000,
    now,
  });
  if (options.service)
    backgroundWorkStore.setIntent({
      itemId: item.id,
      ownerSessionId: owner,
      intent: "service",
      now,
    });
  return options.start === false
    ? item
    : backgroundWorkStore.markRunning({ itemId: item.id, now: now + 5_000 });
}

test("an idle or unloaded session still reports the background work it waits on", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_090_000);
  reserve("watcher", { watch: "GitHub PR checks o/r#1" });
  reserve("watcher", { description: "Vite dev server", service: true });

  const fields = liveActivityFields("watcher", "not_loaded");
  assert.equal(fields.liveActivity, undefined, "no turn, so no run activity");
  assert.equal(fields.backgroundWork?.awaited, 1);
  assert.equal(fields.backgroundWork?.services, 1);
  assert.equal(fields.backgroundWork?.more, undefined);
  const watch = fields.backgroundWork?.items.find(
    (item) => item.kind === "check-watch",
  );
  assert.deepEqual(watch, {
    kind: "check-watch",
    label: "GitHub PR checks o/r#1",
    intent: "awaited",
    state: "running",
    forSec: 85,
    deadlineInSec: 3_510,
  });
  assert.ok(
    !JSON.stringify(fields).includes("secret-ish"),
    "the command never leaves the registry",
  );
  assert.deepEqual(
    liveActivityFields("watcher", "idle").backgroundWork,
    fields.backgroundWork,
    "idle reports it the same",
  );
});

test("a shell is listed without its title, whether command line or description", () => {
  reserve("untitled", { command: "deploy --target COMMAND_LINE_ARGUMENT" });
  reserve("untitled", { description: "deploy with DESCRIBED_ARGUMENT" });
  const fields = liveActivityFields("untitled", "idle");
  const items = fields.backgroundWork!.items;
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.equal(item.kind, "shell");
    assert.equal(item.label, undefined);
  }
  const text = JSON.stringify(fields);
  assert.ok(!text.includes("COMMAND_LINE_ARGUMENT"), "the command line");
  assert.ok(!text.includes("DESCRIBED_ARGUMENT"), "the agent's free text");
});

test("a services-only session reports no awaited work", () => {
  reserve("server-only", { description: "Vite dev server", service: true });
  const work = liveActivityFields("server-only", "not_loaded").backgroundWork!;
  assert.equal(work.awaited, 0);
  assert.equal(work.services, 1);
});

test("finished items are not counted", () => {
  const done = reserve("finished", { description: "build" });
  backgroundWorkStore.terminalize({ itemId: done.id, state: "completed" });
  assert.equal(
    liveActivityFields("finished", "idle").backgroundWork,
    undefined,
  );
});

test("counts cover every active item, not the listed window", () => {
  // One old awaited job under 200 newer services: the window holds only
  // services, and the awaited job must still be counted.
  reserve("crowded", { description: "awaited job", now: 1_000 });
  for (let index = 0; index < 200; index++)
    reserve("crowded", {
      description: `service ${index}`,
      service: true,
      start: index % 2 === 0,
      now: 2_000 + index,
    });
  const work = liveActivityFields("crowded", "idle").backgroundWork!;
  assert.equal(work.awaited, 1);
  assert.equal(work.services, 200);
  assert.equal(work.items.length, 5);
  assert.equal(work.more, 196);
  assert.ok(work.items.every((item) => item.intent === "service"));
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
