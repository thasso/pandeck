/**
 * Task 96: memory injection seam + effective-load audit.
 *   pnpm --filter @assistant/server test src/memory/memoryRuntime.test.ts
 *
 * Covers the delivery decision (injected/reused/cleared/none), cumulative
 * injected-char accounting, cross-harness equivalence, and — through the real
 * runtime prompt facade with a scripted adapter — that the model-bound text
 * carries the memory block while the durable app log stays clean, with one
 * injection followed by reused audits for many unchanged turns.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";
import type {
  AdapterEvent,
  AgentRunResult,
  ForkCapability,
  PromptableAdapter,
  PromptOptions,
} from "../session/adapters/contract.ts";

const tmp = mkdtempSync(join(tmpdir(), "memory-runtime-test-"));
process.env.ASSISTANT_CWD = tmp;

const svc = await import("./memoryService.ts");
const rt = await import("./memoryRuntime.ts");
const { memoryLoadStore } = await import("../db/memoryLoadStore.ts");
const { SessionRuntime } = await import("../session/runtime/runtime.ts");
const { SessionLogStore } = await import("../session/log/store.ts");
const { promptRuntimeSessionWithRuntime } =
  await import("../session/runtimePrompt.ts");
const { getDb, closeDb } = await import("../db/index.ts");
const { updateSettings, getSettings } = await import("../settings.ts");

let nowMs = 1_700_000_000_000;
svc.setMemoryClockForTests(() => nowMs);
rt.setMemoryRuntimeClockForTests(() => nowMs);

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM memory_cards");
  db.exec("DELETE FROM memory_session_snapshots");
  db.exec("DELETE FROM memory_load_batches");
  db.exec("DELETE FROM memory_load_items");
  nowMs = 1_700_000_000_000;
  // This suite covers delivery (Task 96); disable automatic learning so the
  // facade's post-turn observation (Task 99) never invokes the real processor.
  updateSettings({
    memory: {
      ...getSettings().memory,
      loadingEnabled: true,
      learningMode: "off",
    },
  });
});

afterAll(() => {
  svc.resetMemoryClockForTests();
  rt.resetMemoryRuntimeClockForTests();
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

const driver = (
  sessionId: string,
  agentType: "personal-assistant" | "assistant" = "personal-assistant",
) => ({ sessionId, agentType });

test("delivery decision cycles injected → reused → cleared → none with cumulative accounting", () => {
  const created = svc.createMemory({
    text: "Prefers concise answers",
    kind: "preference",
    pinned: true,
    provenance: { sourceKind: "manual" },
  });
  assert.ok(created.ok);

  const d1 = rt.decideMemoryDeliveryForPrompt(driver("s1"), "hello");
  assert.equal(d1.deliveryState, "injected");
  assert.ok(
    d1.memoryBlock && d1.memoryBlock.includes("Prefers concise answers"),
    "block carries the card text",
  );
  assert.ok(
    d1.memoryBlock!.includes("SUPERSEDES all earlier memory"),
    "precedence guidance present",
  );
  rt.commitMemoryDelivery(driver("s1"), "turn-1", d1);
  assert.equal(
    memoryLoadStore.getSnapshot("s1")!.cumulativeInjectedChars,
    d1.injectedChars,
  );

  // Unchanged → reused, no block, zero injected chars.
  const d2 = rt.decideMemoryDeliveryForPrompt(
    driver("s1"),
    "another unrelated question",
  );
  assert.equal(d2.deliveryState, "reused");
  assert.equal(d2.memoryBlock, undefined);
  assert.equal(d2.injectedChars, 0);
  rt.commitMemoryDelivery(driver("s1"), "turn-2", d2);
  assert.equal(
    memoryLoadStore.getSnapshot("s1")!.cumulativeInjectedChars,
    d1.injectedChars,
    "reused adds no injected chars",
  );
  const reusedBatch = memoryLoadStore.latestForSession("s1")!;
  assert.equal(reusedBatch.deliveryState, "reused");
  assert.equal(
    reusedBatch.items.length,
    1,
    "reused batch still records the exact effective set",
  );
  assert.equal(reusedBatch.injectedChars, 0);

  // Archive the only card → effective set empty after a non-empty snapshot → cleared once.
  svc.archiveMemory(created.card.id, created.card.revision, "done");
  const d3 = rt.decideMemoryDeliveryForPrompt(driver("s1"), "hi again");
  assert.equal(d3.deliveryState, "cleared");
  assert.ok(
    d3.memoryBlock!.includes("No durable memories"),
    "clear marker injected",
  );
  rt.commitMemoryDelivery(driver("s1"), "turn-3", d3);
  const afterClear = memoryLoadStore.getSnapshot("s1")!;
  assert.equal(afterClear.effective.length, 0);
  assert.equal(
    afterClear.cumulativeInjectedChars,
    d1.injectedChars + d3.injectedChars,
    "clear marker counts toward cumulative",
  );

  // Now empty with no prior content → none (nothing sent).
  const d4 = rt.decideMemoryDeliveryForPrompt(driver("s1"), "and again");
  assert.equal(d4.deliveryState, "none");
  assert.equal(d4.memoryBlock, undefined);
});

test("cross-harness equivalence: identical scope/prompt/prior derive the same decision", () => {
  svc.createMemory({
    text: "Deploys are frozen on Fridays",
    kind: "constraint",
    provenance: { sourceKind: "manual" },
  });
  const pi = rt.decideMemoryDeliveryForPrompt(driver("s-pi"), "can we deploy?");
  const claude = rt.decideMemoryDeliveryForPrompt(
    driver("s-claude"),
    "can we deploy?",
  );
  assert.equal(
    pi.selection.fingerprint,
    claude.selection.fingerprint,
    "same effective fingerprint",
  );
  assert.equal(pi.deliveryState, claude.deliveryState);
  assert.equal(pi.memoryBlock, claude.memoryBlock);
});

test("many unchanged turns produce one injection then reused audits (through the runtime facade)", async () => {
  svc.createMemory({
    text: "Prefers metric units",
    kind: "preference",
    pinned: true,
    provenance: { sourceKind: "manual" },
  });

  // A scripted adapter records the model-bound text and resolves immediately.
  const modelTexts: string[] = [];
  const capabilities: ForkCapability = {
    fork: "none",
    compact: false,
    steer: false,
    attachments: true,
  };
  const adapter: PromptableAdapter = {
    provider: "scripted",
    capabilities,
    subscribe: (_l: (e: AdapterEvent) => void) => () => {},
    getBinding: () => ({ provider: "scripted", nativeId: "n1" }),
    prompt: (text: string, _o?: PromptOptions): Promise<AgentRunResult> => {
      modelTexts.push(text);
      return Promise.resolve({ stopReason: "end" });
    },
    abort: () => {},
    setModel: () => {},
    setReasoning: () => {},
    dispose: () => {},
  };

  const runtime = new SessionRuntime(new SessionLogStore(true));
  const sessionDriver = {
    id: "sess-many",
    key: "sess-many",
    sessionId: "sess-many",
    harness: "pi" as const,
    agentType: "personal-assistant" as const,
    sessionFile: undefined,
    isRunning: false,
    canSteer: false,
    contextInfo: () => ({}) as never,
    broadcastState: () => {},
    createRuntimeAdapter: () => adapter,
  };

  // Capture the durable user entries via the runtime stream.
  runtime.createSession("sess-many", adapter);
  const appended: string[] = [];
  runtime.openSessionStream("sess-many", (e) => {
    if (
      e.type === "entryAppended" &&
      e.entry.type === "message" &&
      e.entry.role === "user"
    ) {
      const textBlock = e.entry.content.find(
        (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
      );
      if (textBlock) appended.push(textBlock.text);
    }
  });

  for (let i = 0; i < 5; i += 1) {
    await promptRuntimeSessionWithRuntime(
      runtime,
      sessionDriver,
      `question ${i}`,
      { clientRequestId: `r${i}` },
    );
  }

  // Exactly one model-bound text carried the memory block; the rest did not.
  const withBlock = modelTexts.filter((t) => t.includes("<memory>"));
  assert.equal(withBlock.length, 1, "one injection for many unchanged turns");
  assert.ok(withBlock[0]!.includes("Prefers metric units"));

  // Every durable user entry is the clean human text — never the memory block.
  assert.deepEqual(appended, [
    "question 0",
    "question 1",
    "question 2",
    "question 3",
    "question 4",
  ]);
  for (const t of appended)
    assert.ok(
      !t.includes("<memory>"),
      "durable transcript never contains the memory block",
    );

  // Audit: 1 injected + 4 reused, all recording the effective set.
  const recent = memoryLoadStore.recentForSession("sess-many", 10);
  assert.equal(recent.length, 5, "one audit batch per accepted turn");
  assert.equal(recent.filter((b) => b.deliveryState === "injected").length, 1);
  assert.equal(recent.filter((b) => b.deliveryState === "reused").length, 4);
  assert.ok(
    recent.every((b) => b.items.length === 1),
    "each batch records the exact effective set",
  );
});

test("recordMemoryDeliveryFailure persists an explicit failed audit without touching the snapshot", () => {
  memoryLoadStore.putSnapshot({
    sessionId: "s-fail",
    fingerprint: "fp-before",
    effective: [{ id: "m1", revision: 1 }],
    renderedText: "x",
    renderedChars: 1,
    lastDeliveryState: "injected",
    cumulativeInjectedChars: 42,
    updatedAt: nowMs,
  });
  rt.recordMemoryDeliveryFailure(
    { sessionId: "s-fail", agentType: "assistant" },
    "turn-1",
  );

  const batch = memoryLoadStore.recentForSession("s-fail", 1)[0];
  assert.ok(batch);
  assert.equal(batch!.deliveryState, "failed");
  assert.equal(batch!.items.length, 0);
  assert.equal(batch!.injectedChars, 0);
  assert.equal(
    batch!.cumulativeInjectedChars,
    42,
    "cumulative carried through unchanged (nothing injected)",
  );

  // The delivered snapshot is untouched — the next turn still sees the PRIOR
  // fingerprint (selection was never advanced past the failure).
  const snapshot = memoryLoadStore.getSnapshot("s-fail");
  assert.equal(snapshot!.fingerprint, "fp-before");
});

test("commitMemoryDelivery is atomic: a snapshot-write failure rolls back the audit batch too (exchange 21 hardening)", () => {
  svc.createMemory({
    text: "Prefers dark mode",
    kind: "preference",
    pinned: true,
    provenance: { sourceKind: "manual" },
  });
  const decision = rt.decideMemoryDeliveryForPrompt(
    { sessionId: "s-atomic", agentType: "assistant" },
    "hello",
  );
  assert.equal(decision.deliveryState, "injected");

  const originalPutSnapshot = memoryLoadStore.putSnapshot;
  memoryLoadStore.putSnapshot = () => {
    throw new Error("boom: simulated snapshot write failure");
  };
  try {
    assert.throws(() =>
      rt.commitMemoryDelivery(
        { sessionId: "s-atomic", agentType: "assistant" },
        "turn-1",
        decision,
      ),
    );
  } finally {
    memoryLoadStore.putSnapshot = originalPutSnapshot;
  }

  // recordBatch's insert must have rolled back together with the failed
  // putSnapshot — no orphaned/inconsistent audit row left behind.
  assert.equal(
    memoryLoadStore.recentForSession("s-atomic", 5).length,
    0,
    "the audit batch did not persist without its matching snapshot update",
  );
  assert.equal(
    memoryLoadStore.getSnapshot("s-atomic"),
    undefined,
    "no partial snapshot either",
  );
});

test("a selection failure (through the runtime facade) records a failed batch instead of silently reusing the prior turn", async () => {
  svc.createMemory({
    text: "Prefers metric units",
    kind: "preference",
    pinned: true,
    provenance: { sourceKind: "manual" },
  });

  const modelTexts: string[] = [];
  const capabilities: ForkCapability = {
    fork: "none",
    compact: false,
    steer: false,
    attachments: true,
  };
  const adapter: PromptableAdapter = {
    provider: "scripted",
    capabilities,
    subscribe: (_l: (e: AdapterEvent) => void) => () => {},
    getBinding: () => ({ provider: "scripted", nativeId: "n1" }),
    prompt: (text: string, _o?: PromptOptions): Promise<AgentRunResult> => {
      modelTexts.push(text);
      return Promise.resolve({ stopReason: "end" });
    },
    abort: () => {},
    setModel: () => {},
    setReasoning: () => {},
    dispose: () => {},
  };

  const runtime = new SessionRuntime(new SessionLogStore(true));
  const sessionDriver = {
    id: "sess-fail",
    key: "sess-fail",
    sessionId: "sess-fail",
    harness: "pi" as const,
    agentType: "personal-assistant" as const,
    sessionFile: undefined,
    isRunning: false,
    canSteer: false,
    contextInfo: () => ({}) as never,
    broadcastState: () => {},
    createRuntimeAdapter: () => adapter,
  };
  runtime.createSession("sess-fail", adapter);

  rt.setMemorySelectorForTests(() => {
    throw new Error("boom: simulated selection failure");
  });
  try {
    await promptRuntimeSessionWithRuntime(runtime, sessionDriver, "question", {
      clientRequestId: "r1",
    });
  } finally {
    rt.resetMemorySelectorForTests();
  }

  // The turn still completed (fails open) with no memory block.
  assert.equal(modelTexts.length, 1);
  assert.ok(
    !modelTexts[0]!.includes("<memory>"),
    "no memory block on a selection failure",
  );

  // An explicit 'failed' audit batch was recorded for this accepted turn.
  const recent = memoryLoadStore.recentForSession("sess-fail", 5);
  assert.equal(recent.length, 1);
  assert.equal(recent[0]!.deliveryState, "failed");
});
