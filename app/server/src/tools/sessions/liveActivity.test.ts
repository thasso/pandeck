/**
 * What `session_lookup`/`session_read` tell a coordinator about a running peer:
 * observed activity and queued work, never content, and silence as silence.
 */
import assert from "node:assert/strict";
import { afterAll, afterEach, test, vi } from "vitest";
import { sessionRuntime } from "../../session/runtimeInstance.ts";
import { installBackgroundUpdateQueue } from "../../backgroundUpdateQueue.ts";
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
  adapter.emit({ type: "messageStarted", streamId: "m" });
  vi.setSystemTime(1_004_000);
  adapter.emit({
    type: "toolStarted",
    streamId: "t1",
    toolCallId: "t1",
    name: "Bash",
    input: { command: "secret-ish argument" },
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
  });
  assert.deepEqual(
    liveActivityFields("peer-live", "running").liveActivity!.providerRetry,
    { attempt: 4, maxAttempts: 10, status: 529, secAgo: 0 },
  );
});

test("an idle or unloaded session reports no activity; queued work is counted either way", () => {
  assert.deepEqual(liveActivityFields("nobody", "not_loaded"), {});
  installBackgroundUpdateQueue({
    count: (id) => (id === "held" ? 3 : 0),
    publish: () => {},
  });
  assert.deepEqual(liveActivityFields("held", "idle"), {
    queuedWork: { backgroundUpdates: 3 },
  });
});
