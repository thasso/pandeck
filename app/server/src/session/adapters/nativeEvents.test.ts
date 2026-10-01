/**
 * Adapter-native event contract tests. Run:
 *   pnpm --filter @assistant/server test src/session/adapters/nativeEvents.test.ts
 *
 * Covers the streaming lifecycle emitted by in-process harnesses (assistant +
 * tool, content accumulation, assistant-before-tool-result ordering) and host
 * command card passthrough/durable events.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { AdapterEvent } from "./contract.ts";
import {
  NativeAdapterEventSource,
  perTurnUsage,
  type CumulativeUsageTotals,
} from "./nativeEvents.ts";

function collect(source: NativeAdapterEventSource): AdapterEvent[] {
  const events: AdapterEvent[] = [];
  source.subscribe((event) => events.push(event));
  return events;
}

{
  const source = new NativeAdapterEventSource();
  const events = collect(source);

  source.messageStarted("t1");
  source.messageDelta("t1", "text", "Hel");
  source.messageDelta("t1", "text", "lo");
  source.toolStarted("tc1", "bash", {});
  source.toolCompleted({
    type: "toolEnd",
    sessionId: "s",
    id: "t1",
    toolId: "tc1",
    output: "ok",
    isError: false,
  });
  source.messageCompleted("t1");

  const types = events.map((e) => e.type);
  assert.deepEqual(
    types,
    [
      "messageStarted",
      "messageDelta",
      "messageDelta",
      "toolStarted",
      "passthrough",
      "messageCompleted",
      "toolCompleted",
      "runCompleted",
    ],
    "tool finish forwards a live passthrough before the durable assistant/toolResult entries",
  );
  assert.ok(
    types.indexOf("passthrough") < types.indexOf("messageCompleted"),
    "live toolEnd fires before the turn ends",
  );

  const completed = events.find(
    (e): e is Extract<AdapterEvent, { type: "messageCompleted" }> =>
      e.type === "messageCompleted",
  )!;
  assert.deepEqual(
    completed.content.map((c) => c.type),
    ["text", "toolCall"],
    "assistant content accumulated from deltas + tool open",
  );
}

/* ------------------------- aborted turn --------------------------------- */
{
  const source = new NativeAdapterEventSource();
  const out = collect(source);
  source.messageStarted("abort1");
  source.messageDelta("abort1", "text", "partial");
  source.toolStarted("tc-abort", "Edit", { file: "x" });
  source.toolCompleted({
    type: "toolEnd",
    sessionId: "s",
    id: "abort1",
    toolId: "tc-abort",
    output: "edited",
    isError: false,
  });
  source.messageCompleted("abort1", { aborted: true });

  const t = out.map((e) => e.type);
  assert.deepEqual(
    t,
    [
      "messageStarted",
      "messageDelta",
      "toolStarted",
      "passthrough",
      "messageCompleted",
      "toolCompleted",
      "runCompleted",
    ],
    "aborted turns persist partial assistant content and completed tool results before marking the run aborted",
  );
  const completed = out.find(
    (e): e is Extract<AdapterEvent, { type: "messageCompleted" }> =>
      e.type === "messageCompleted",
  )!;
  assert.equal(
    completed.stopReason,
    "aborted",
    "assistant entry is marked aborted",
  );
  assert.deepEqual(
    completed.content.map((c) => c.type),
    ["text", "toolCall"],
    "partial content is preserved",
  );
  const done = out.at(-1) as Extract<AdapterEvent, { type: "runCompleted" }>;
  assert.equal(done.stopReason, "aborted", "abort stop reason is preserved");
}

test("an intermediate attempt completes its message without completing the run", () => {
  const source = new NativeAdapterEventSource();
  const events = collect(source);
  source.messageStarted("attempt-1");
  source.messageDelta("attempt-1", "text", "partial");
  source.messageAttemptCompleted("attempt-1");
  source.messageStarted("attempt-2");
  source.messageDelta("attempt-2", "text", "complete");
  source.messageCompleted("attempt-2");

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "messageStarted",
      "messageDelta",
      "messageCompleted",
      "messageStarted",
      "messageDelta",
      "messageCompleted",
      "runCompleted",
    ],
  );
});

test("a run can complete between attempts without duplicating its last message", () => {
  const source = new NativeAdapterEventSource();
  const events = collect(source);
  source.messageStarted("attempt-1");
  source.messageDelta("attempt-1", "text", "partial");
  source.messageAttemptCompleted("attempt-1");
  source.runCompleted("aborted");

  assert.deepEqual(
    events.map((event) => event.type),
    ["messageStarted", "messageDelta", "messageCompleted", "runCompleted"],
  );
  assert.deepEqual(events.at(-1), {
    type: "runCompleted",
    stopReason: "aborted",
  });
});

test("non-user aborted turns retain their provider error and surface as failures", () => {
  const source = new NativeAdapterEventSource();
  const events = collect(source);
  source.messageStarted("provider-abort");
  source.messageCompleted("provider-abort", {
    aborted: true,
    errorMessage: "Request was aborted",
  });

  const completed = events.find(
    (event): event is Extract<AdapterEvent, { type: "messageCompleted" }> =>
      event.type === "messageCompleted",
  )!;
  assert.equal(completed.stopReason, "aborted");
  assert.equal(completed.error, "Request was aborted");
  assert.deepEqual(events.at(-1), {
    type: "runCompleted",
    stopReason: "error",
    errorMessage: "Request was aborted",
  });
});

test("provider notices are emitted as durable adapter records", () => {
  const source = new NativeAdapterEventSource();
  const events = collect(source);
  source.providerNotice({
    type: "providerNotice",
    severity: "warning",
    message: "Retrying 1/3 in 2s…",
    providerError: {
      kind: "network",
      title: "Provider connection failed",
      summary: "The connection failed.",
      rawMessage: "WebSocket error",
    },
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2_000,
  });
  assert.equal(events[0]?.type, "providerNotice");
});

/* ------------------------- host-command passthrough ---------------------- */
test("discarded host-command phase closes without a durable result", () => {
  const source = new NativeAdapterEventSource();
  const events = collect(source);
  source.messageStarted("skip");
  source.toolStarted("skip-tool", "/push", {});
  source.hostCommandDiscarded();
  assert.deepEqual(
    events.map((event) => event.type),
    ["messageStarted", "toolStarted", "hostCommandDiscarded"],
  );
});

{
  const source = new NativeAdapterEventSource();
  const out = collect(source);
  const commit = { renderKind: "commit", commitHash: "abc1234" } as never;
  const envelope = {
    type: "commitResult" as const,
    sessionId: "s",
    id: "syn1",
    commit,
  };

  source.messageStarted("syn1");
  source.toolStarted("tcmd", "/commit", {});
  source.hostCommandCard(
    "commit",
    { kind: "commit", id: "syn1", commit: envelope.commit },
    envelope,
  );
  source.messageCompleted("syn1");

  const t = out.map((e) => e.type);
  assert.deepEqual(
    t,
    ["messageStarted", "toolStarted", "passthrough", "hostCommandResult"],
    "synthetic /commit turn ends as hostCommandResult, not messageCompleted",
  );
  assert.ok(
    !t.includes("messageCompleted"),
    "the wrapper assistant turn is NOT persisted as a conversation entry",
  );
  const pass = out.find(
    (e): e is Extract<AdapterEvent, { type: "passthrough" }> =>
      e.type === "passthrough",
  )!;
  assert.equal(
    pass.envelope,
    envelope,
    "commit card is passed through verbatim",
  );
  const hc = out.find(
    (e): e is Extract<AdapterEvent, { type: "hostCommandResult" }> =>
      e.type === "hostCommandResult",
  )!;
  assert.equal(hc.name, "commit");
  assert.equal(hc.card.kind, "commit");
  assert.equal(hc.card.id, "syn1", "card keeps the synthetic turn id");
  assert.equal(
    hc.card.commit.commitHash,
    "abc1234",
    "card carries the commit payload verbatim",
  );
}

/* ------------------------- host-command passthrough: /push --------------- */
{
  const source = new NativeAdapterEventSource();
  const out = collect(source);
  const push = {
    status: "pushed",
    remote: "origin",
    branch: "main",
    forced: false,
    setUpstream: true,
  } as never;
  const envelope = {
    type: "pushResult" as const,
    sessionId: "s",
    id: "syn2",
    push,
  };

  source.messageStarted("syn2");
  source.toolStarted("tpush", "/push", {});
  source.hostCommandCard(
    "push",
    { kind: "push", id: "syn2", push: envelope.push },
    envelope,
  );
  source.messageCompleted("syn2");

  const t = out.map((e) => e.type);
  assert.deepEqual(
    t,
    ["messageStarted", "toolStarted", "passthrough", "hostCommandResult"],
    "synthetic /push turn ends as hostCommandResult, not messageCompleted",
  );
  const hc = out.find(
    (e): e is Extract<AdapterEvent, { type: "hostCommandResult" }> =>
      e.type === "hostCommandResult",
  )!;
  assert.equal(hc.name, "push");
  assert.equal(hc.card.kind, "push");
  assert.equal(hc.card.id, "syn2", "card keeps the synthetic turn id");
  assert.equal(
    hc.card.kind === "push" && hc.card.push.status,
    "pushed",
    "card carries the push payload verbatim",
  );
}

/* ------------------------- provider error on a turn ---------------------- */
{
  const source = new NativeAdapterEventSource();
  const out = collect(source);
  source.messageStarted("err1");
  source.messageDelta("err1", "text", "partial");
  source.messageCompleted("err1", {
    errorMessage:
      "Model usage limit reached (openai-codex/gpt-5): quota exceeded.",
  });

  const completed = out.find(
    (e): e is Extract<AdapterEvent, { type: "messageCompleted" }> =>
      e.type === "messageCompleted",
  )!;
  assert.equal(completed.stopReason, "error", "failed turn is marked error");
  assert.equal(
    completed.error,
    "Model usage limit reached (openai-codex/gpt-5): quota exceeded.",
    "the provider error text rides on the durable assistant entry, not only the transient runCompleted",
  );
  const done = out.at(-1) as Extract<AdapterEvent, { type: "runCompleted" }>;
  assert.equal(done.stopReason, "error");
  assert.equal(
    done.errorMessage,
    "Model usage limit reached (openai-codex/gpt-5): quota exceeded.",
  );
}

/* ------------------------- per-turn usage deltas ------------------------- */
{
  const totals = (
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
    cost: number,
  ): CumulativeUsageTotals => ({ input, output, cacheRead, cacheWrite, cost });

  // Delta between the before/after cumulative snapshots, plus the context snapshot.
  const usage = perTurnUsage(
    totals(100, 10, 900, 200, 0.01),
    totals(150, 40, 2900, 250, 0.035),
    { tokens: 3100, window: 200_000 },
  );
  assert.ok(usage, "billed run yields usage");
  assert.equal(usage.inputTokens, 50, "input is the run's delta");
  assert.equal(usage.outputTokens, 30, "output is the run's delta");
  assert.equal(usage.cacheReadTokens, 2000, "cacheRead is the run's delta");
  assert.equal(usage.cacheCreationTokens, 50, "cacheWrite is the run's delta");
  assert.ok(
    usage.costUSD !== undefined && Math.abs(usage.costUSD - 0.025) < 1e-9,
    `cost is the run's delta (${usage.costUSD})`,
  );
  assert.equal(usage.contextTokens, 3100, "context snapshot rides along");
  assert.equal(
    usage.contextWindowTokens,
    200_000,
    "context window rides along",
  );

  // No before-snapshot (first run): the whole cumulative is the run.
  const first = perTurnUsage(undefined, totals(100, 5, 0, 200, 0.01));
  assert.deepEqual(
    first,
    {
      inputTokens: 100,
      outputTokens: 5,
      cacheCreationTokens: 200,
      costUSD: 0.01,
    },
    "first run without a snapshot uses the full totals",
  );

  // Nothing billed (e.g. aborted before the first provider response) → no usage.
  const before = totals(100, 10, 900, 200, 0.01);
  assert.equal(
    perTurnUsage(before, { ...before }, { tokens: 1200, window: 200_000 }),
    undefined,
    "zero-billing run carries no usage",
  );

  // Defensive clamp: an (impossible) shrinking cumulative never yields negatives.
  assert.deepEqual(
    perTurnUsage(totals(500, 100, 0, 0, 0.05), totals(400, 150, 0, 0, 0.04)),
    { outputTokens: 50 },
    "negative deltas clamp to zero",
  );
}

/* ------------------------- run timing on completion ---------------------- */
{
  const source = new NativeAdapterEventSource();
  const out = collect(source);
  source.messageStarted("time1");
  source.messageDelta("time1", "text", "hi");
  source.messageCompleted("time1");

  const completed = out.find(
    (e): e is Extract<AdapterEvent, { type: "messageCompleted" }> =>
      e.type === "messageCompleted",
  )!;
  assert.ok(completed.startedAt, "durable entry records when the run started");
  assert.ok(
    completed.completedAt,
    "durable entry records when the run completed",
  );
  assert.ok(
    Date.parse(completed.completedAt!) >= Date.parse(completed.startedAt!),
    "completion is not before the start",
  );
}

console.log("native adapter events contract test: PASS");

test("emits adapter-native turn events", () => {
  // Assertions run during module evaluation to preserve the former standalone script structure.
});
