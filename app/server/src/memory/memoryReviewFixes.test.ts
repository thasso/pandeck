/**
 * Regression tests for the peer-review fixes: lifecycle atomicity/dedup coherence
 * (item 2), processor scope/security + strict validation + DST temporal + source
 * timestamp (items 1 & 4), and per-session scheduling + queue bounds (item 3).
 *   pnpm --filter @assistant/server test src/memory/memoryReviewFixes.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";
import type { MemoryProcessorRunner } from "./memoryProcessor.ts";
import type {
  HostCompactionOutcome,
  SyntheticToolHost,
} from "../hostSlashCommands.ts";

const tmp = mkdtempSync(join(tmpdir(), "memory-reviewfixes-test-"));
process.env.ASSISTANT_CWD = tmp;

const svc = await import("./memoryService.ts");
const proc = await import("./memoryProcessor.ts");
const sched = await import("./memoryScheduler.ts");
const { memoryStore } = await import("../db/memoryStore.ts");
const { memoryObservationStore } =
  await import("../db/memoryObservationStore.ts");
const { memoryLoadStore } = await import("../db/memoryLoadStore.ts");
const { getDb, closeDb } = await import("../db/index.ts");

let nowMs = 1_700_000_000_000;
svc.setMemoryClockForTests(() => nowMs);
proc.setMemoryProcessorClockForTests(() => nowMs);
sched.setMemorySchedulerClockForTests(() => nowMs);

const prov = { sourceKind: "manual" as const };
function fakeRunner(text: string): MemoryProcessorRunner {
  return { run: async () => ({ text }) };
}

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM memory_cards");
  db.exec("DELETE FROM memory_observations");
  db.exec("DELETE FROM memory_processor_runs");
  nowMs = 1_700_000_000_000;
  proc.resetMemoryProcessorRunnerForTests();
});
afterAll(() => {
  svc.resetMemoryClockForTests();
  proc.resetMemoryProcessorClockForTests();
  proc.resetMemoryProcessorRunnerForTests();
  sched.setMemorySchedulerClockForTests(() => Date.now());
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/* ------------------------------ item 2 ---------------------------------- */

test("correction never reactivates superseded history; content key is freed", () => {
  const c = svc.createMemory({
    text: "Lives in Berlin",
    kind: "fact",
    provenance: prov,
  });
  assert.ok(c.ok);
  const r = svc.supersedeMemory(c.card.id, c.card.revision, {
    text: "Lives in Munich",
    provenance: prov,
  });
  assert.ok(r.ok);
  // Re-creating the ORIGINAL content must NOT reactivate the superseded card — it
  // creates a fresh active card, leaving lineage intact.
  const again = svc.createMemory({
    text: "Lives in Berlin",
    kind: "fact",
    provenance: prov,
  });
  assert.ok(again.ok);
  assert.notEqual(
    again.card.id,
    c.card.id,
    "did not resurrect the superseded card",
  );
  assert.equal(
    memoryStore.get(c.card.id)!.state,
    "superseded",
    "superseded stays superseded",
  );
  const active = memoryStore
    .activeCards()
    .map((m) => m.text)
    .sort();
  assert.deepEqual(active, ["Lives in Berlin", "Lives in Munich"]);
});

test("correction inherits kind/scope/temporal when omitted (no reset to fact/global/persistent)", () => {
  const c = svc.createMemory({
    text: "In Tokyo this week",
    kind: "working",
    scope: { projectId: "acme" },
    temporal: { mode: "window", validUntilMs: nowMs + 86_400_000 },
    provenance: prov,
  });
  assert.ok(c.ok);
  const r = svc.supersedeMemory(c.card.id, c.card.revision, {
    text: "In Osaka this week",
    provenance: prov,
  });
  assert.ok(
    r.ok &&
      r.replacement.kind === "working" &&
      r.replacement.scope.projectId === "acme" &&
      r.replacement.temporal.mode === "window",
  );
});

test("edit recomputes the dedup key so a later create converges (no duplicate)", () => {
  const c = svc.createMemory({
    text: "Uses vim",
    kind: "preference",
    provenance: prov,
  });
  assert.ok(c.ok);
  const e = svc.editMemory(c.card.id, c.card.revision, { text: "Uses neovim" });
  assert.ok(e.ok);
  // Creating the edited content converges on the same card rather than duplicating.
  const dup = svc.createMemory({
    text: "Uses neovim",
    kind: "preference",
    provenance: prov,
  });
  assert.ok(dup.ok && dup.card.id === c.card.id, "edited content deduped");
  assert.equal(memoryStore.count({ states: ["active"] }), 1);
  // Editing onto another active card's content is rejected (no unique crash).
  const other = svc.createMemory({
    text: "Prefers tabs",
    kind: "preference",
    provenance: prov,
  });
  assert.ok(other.ok);
  const clash = svc.editMemory(other.card.id, other.card.revision, {
    text: "Uses neovim",
  });
  assert.ok(!clash.ok && clash.reason === "invalid");
});

/* ---------------------------- items 1 & 4 -------------------------------- */

function enqueueAndClaim(
  text: string,
  opts: { persona?: string; project?: string; tz?: string; ts?: number } = {},
) {
  const obs = memoryObservationStore.enqueue({
    sessionId: "s1",
    userTurnId: `t-${Math.random()}`,
    persona: opts.persona ?? "personal-assistant",
    ...(opts.project !== undefined ? { projectId: opts.project } : {}),
    humanText: text,
    sourceTimestampMs: opts.ts ?? nowMs,
    timezone: opts.tz ?? "Europe/Berlin",
    createdAt: nowMs,
  });
  return memoryObservationStore.claim([obs.id], nowMs);
}

test("processor forces observation scope on created cards (no escalation)", async () => {
  const claimed = enqueueAndClaim("remember the deploy freeze", {
    persona: "personal-assistant",
    project: "acme",
  });
  // Model tries to create a GLOBAL card for another project — scope must be forced to the observation's.
  proc.setMemoryProcessorRunnerForTests(
    fakeRunner(
      JSON.stringify({
        operations: [
          {
            action: "create",
            observationIndex: 0,
            text: "Deploy freeze on Fridays",
            kind: "constraint",
            scope: { projectId: "other-project" },
          },
        ],
      }),
    ),
  );
  await proc.runMemoryProcessor(claimed, { trigger: "batch" });
  const cards = memoryStore.activeCards();
  assert.equal(cards.length, 1);
  assert.equal(
    cards[0]!.scope.projectId,
    "acme",
    "created card is scoped to the observation, not the model-supplied project",
  );
  assert.equal(cards[0]!.scope.persona, "personal-assistant");
});

test("processor rejects out-of-scope target ids and invalid observationIndex", async () => {
  // A card in another project.
  const other = memoryStore.insert({
    id: "mem_other",
    text: "x",
    kind: "fact",
    scope: { projectId: "project-b" },
    temporal: { mode: "persistent" },
    observedAtMs: nowMs,
    createdAt: nowMs,
    updatedAt: nowMs,
    sourceKind: "manual",
  });
  const claimed = enqueueAndClaim("something", { project: "project-a" });
  proc.setMemoryProcessorRunnerForTests(
    fakeRunner(
      JSON.stringify({
        operations: [
          { action: "archive", observationIndex: 0, targetId: other.id },
          {
            action: "create",
            observationIndex: 9,
            text: "should not apply",
            kind: "fact",
          },
        ],
      }),
    ),
  );
  const outcome = await proc.runMemoryProcessor(claimed, { trigger: "batch" });
  assert.equal(outcome.operationsApplied, 0);
  assert.ok(outcome.operations.every((o) => !o.ok));
  assert.equal(
    memoryStore.get("mem_other")!.state,
    "active",
    "out-of-scope archive rejected",
  );
});

test("processor rejects malformed structured output (unknown keys/enums/bounds)", () => {
  // Exercised indirectly: strict validation lives in parseOperations via runMemoryProcessor.
  // Unknown key.
  assert.equal(
    proc.__parseOperationsForTests(
      JSON.stringify({ operations: [{ action: "create", bogusKey: 1 }] }),
    ),
    null,
  );
  // Bad kind enum.
  assert.equal(
    proc.__parseOperationsForTests(
      JSON.stringify({ operations: [{ action: "create", kind: "nope" }] }),
    ),
    null,
  );
  // Relative days out of bounds.
  assert.equal(
    proc.__parseOperationsForTests(
      JSON.stringify({
        operations: [
          {
            action: "create",
            temporal: { mode: "window", relativeFromDays: 999999 },
          },
        ],
      }),
    ),
    null,
  );
  // Valid.
  assert.ok(
    proc.__parseOperationsForTests(
      JSON.stringify({ operations: [{ action: "ignore" }] }),
    ),
  );
});

test("created card records the observation source timestamp, not processor time", async () => {
  const sourceTs = nowMs - 3 * 86_400_000; // observed 3 days ago
  const claimed = enqueueAndClaim("I prefer dark mode", { ts: sourceTs });
  nowMs += 10_000; // processor runs later
  proc.setMemoryProcessorRunnerForTests(
    fakeRunner(
      JSON.stringify({
        operations: [
          {
            action: "create",
            observationIndex: 0,
            text: "Prefers dark mode",
            kind: "preference",
          },
        ],
      }),
    ),
  );
  await proc.runMemoryProcessor(claimed, { trigger: "batch" });
  assert.equal(
    memoryStore.activeCards()[0]!.observedAtMs,
    sourceTs,
    "observedAtMs is the immutable source timestamp",
  );
});

/* ------------------------------ item 3 ---------------------------------- */

test("scheduler counts pending PER SESSION so one session cannot trigger another", () => {
  // Four pending in session B; a low-signal turn in session A must not flush (its own count is 1).
  for (let i = 0; i < 4; i += 1)
    memoryObservationStore.enqueue({
      sessionId: "B",
      userTurnId: `b${i}`,
      persona: "assistant",
      humanText: `x${i}`,
      sourceTimestampMs: nowMs,
      timezone: "UTC",
      createdAt: nowMs,
    });
  assert.equal(memoryObservationStore.pendingCountForSession("A"), 0);
  assert.equal(memoryObservationStore.pendingCountForSession("B"), 4);
});

test("correction rejects duplicate active content instead of creating an unkeyed duplicate (E)", () => {
  const a = svc.createMemory({
    text: "Prefers dark mode",
    kind: "preference",
    provenance: prov,
  });
  const b = svc.createMemory({
    text: "Prefers light mode",
    kind: "preference",
    provenance: prov,
  });
  assert.ok(a.ok && b.ok);
  // Correcting b to a's exact content would create a second active duplicate → reject.
  const r = svc.supersedeMemory(b.card.id, b.card.revision, {
    text: "Prefers dark mode",
    provenance: prov,
  });
  assert.ok(!r.ok && r.reason === "invalid");
  assert.equal(memoryStore.get(b.card.id)!.state, "active", "b left intact");
  assert.equal(memoryStore.activeCards().length, 2, "no duplicate created");
});

test("processor rejects operations targeting cards NOT shown for the observation (F1)", async () => {
  // An in-scope card that will NOT be surfaced by the observation's lexical search.
  const hidden = memoryStore.insert({
    id: "mem_hidden",
    text: "zzz unrelated topic quux",
    kind: "fact",
    scope: { persona: "personal-assistant" },
    temporal: { mode: "persistent" },
    observedAtMs: nowMs,
    createdAt: nowMs,
    updatedAt: nowMs,
    sourceKind: "manual",
  });
  const claimed = enqueueAndClaim("tell me about the weather forecast", {
    persona: "personal-assistant",
  });
  proc.setMemoryProcessorRunnerForTests(
    fakeRunner(
      JSON.stringify({
        operations: [
          { action: "archive", observationIndex: 0, targetId: hidden.id },
        ],
      }),
    ),
  );
  const outcome = await proc.runMemoryProcessor(claimed, { trigger: "batch" });
  assert.equal(
    outcome.operationsApplied,
    0,
    "cannot target a card that was not shown",
  );
  assert.equal(memoryStore.get("mem_hidden")!.state, "active");
});

test("H1: unchanged baseline does not reorder/reinject across different prompts", async () => {
  const p1 = svc.createMemory({
    text: "Prefers concise answers",
    kind: "preference",
    provenance: prov,
  });
  const p2 = svc.createMemory({
    text: "Uses metric units everywhere",
    kind: "preference",
    provenance: prov,
  });
  assert.ok(p1.ok && p2.ok);
  const { selectMemory } = await import("./memorySelector.ts");
  const ctx = { persona: "personal-assistant" as const };
  const a = selectMemory({
    cards: memoryStore.activeCards(),
    context: ctx,
    prompt: "tell me about concise answers",
    nowMs,
    maxCards: 8,
    maxRenderedChars: 1200,
  });
  const b = selectMemory({
    cards: memoryStore.activeCards(),
    context: ctx,
    prompt: "what metric units do you use",
    nowMs,
    maxCards: 8,
    maxRenderedChars: 1200,
  });
  assert.equal(
    a.fingerprint,
    b.fingerprint,
    "baseline order/fingerprint is prompt-independent (no churn)",
  );
});

/* ------------------------------ item 8 ---------------------------------- */

test("model consolidation merges duplicates through the bounded processor/budget path", async () => {
  const a = svc.createMemory({
    text: "Prefers dark mode",
    kind: "preference",
    provenance: prov,
  });
  const b = svc.createMemory({
    text: "Likes the dark theme",
    kind: "preference",
    provenance: prov,
  });
  assert.ok(a.ok && b.ok);
  // The model proposes archiving the redundant duplicate and reinforcing the canonical.
  proc.setMemoryProcessorRunnerForTests(
    fakeRunner(
      JSON.stringify({
        operations: [
          {
            action: "archive",
            targetId: b.card.id,
            reason: "duplicate of dark mode",
          },
          { action: "reinforce", targetId: a.card.id, reason: "canonical" },
        ],
      }),
    ),
  );
  const outcome = await proc.runConsolidation();
  assert.ok(outcome.ran && outcome.operationsApplied === 2);
  assert.equal(memoryStore.get(b.card.id)!.state, "archived");
  assert.equal(memoryStore.activeCards().length, 1);
  // Consolidation cannot create or target a card outside the listed set.
  proc.setMemoryProcessorRunnerForTests(
    fakeRunner(
      JSON.stringify({
        operations: [
          { action: "create", text: "Invented memory", kind: "fact" },
          { action: "archive", targetId: "mem_not_listed" },
        ],
      }),
    ),
  );
  const guarded = await proc.runConsolidation();
  assert.equal(
    guarded.operationsApplied,
    0,
    "consolidation cannot create or target unlisted cards",
  );
});

test("consolidation never compares/archives across scopes (F)", async () => {
  // Two cards in project-a (a group of 2) and one isolated card in project-b.
  const a1 = svc.createMemory({
    text: "Deploy target is staging",
    kind: "fact",
    scope: { projectId: "project-a" },
    provenance: prov,
  });
  const a2 = svc.createMemory({
    text: "Deploy target is staging server",
    kind: "fact",
    scope: { projectId: "project-a" },
    provenance: prov,
  });
  const b1 = svc.createMemory({
    text: "Deploy target is production",
    kind: "fact",
    scope: { projectId: "project-b" },
    provenance: prov,
  });
  assert.ok(a1.ok && a2.ok && b1.ok);
  // The model tries to archive project-b's card while "consolidating" — it is not
  // in the chosen (project-a) group's allowlist, so it is rejected.
  proc.setMemoryProcessorRunnerForTests(
    fakeRunner(
      JSON.stringify({
        operations: [
          { action: "archive", targetId: a2.card.id, reason: "dup of a1" },
          {
            action: "archive",
            targetId: b1.card.id,
            reason: "cross-scope archive attempt",
          },
        ],
      }),
    ),
  );
  const outcome = await proc.runConsolidation();
  assert.ok(outcome.ran);
  assert.equal(
    memoryStore.get(b1.card.id)!.state,
    "active",
    "cross-scope card never archived by consolidation",
  );
});

test("processor create/reinforce are idempotent on exact retry of the same observation (G)", async () => {
  const obs = memoryObservationStore.enqueue({
    sessionId: "s1",
    userTurnId: "turn-idem",
    persona: "personal-assistant",
    humanText: "I prefer dark mode",
    sourceTimestampMs: nowMs,
    timezone: "UTC",
    createdAt: nowMs,
  });
  const runOnce = () =>
    proc.runMemoryProcessor(
      memoryObservationStore.claim([obs.id], nowMs).length
        ? [memoryObservationStore.get(obs.id)!]
        : [memoryObservationStore.get(obs.id)!],
      { trigger: "batch" },
    );
  proc.setMemoryProcessorRunnerForTests(
    fakeRunner(
      JSON.stringify({
        operations: [
          {
            action: "create",
            observationIndex: 0,
            text: "Prefers dark mode",
            kind: "preference",
          },
        ],
      }),
    ),
  );
  // First run applies; simulate a crash-recovery re-claim by re-running the SAME observation id.
  await runOnce();
  const after1 = memoryStore.activeCards();
  assert.equal(after1.length, 1);
  const strength1 = after1[0]!.strength;
  memoryObservationStore.release(obs.id); // pretend it went back to pending
  await runOnce();
  const after2 = memoryStore.activeCards();
  assert.equal(after2.length, 1, "no duplicate on exact retry");
  assert.equal(
    after2[0]!.strength,
    strength1,
    "exact retry did not reinforce again",
  );
});

test("consolidation rotates fairly across scope groups (F rotation)", async () => {
  // Two eligible groups (project-a: 2 cards, project-b: 2 cards).
  svc.createMemory({
    text: "A one",
    kind: "fact",
    scope: { projectId: "project-a" },
    provenance: prov,
  });
  svc.createMemory({
    text: "A two",
    kind: "fact",
    scope: { projectId: "project-a" },
    provenance: prov,
  });
  svc.createMemory({
    text: "B one",
    kind: "fact",
    scope: { projectId: "project-b" },
    provenance: prov,
  });
  svc.createMemory({
    text: "B two",
    kind: "fact",
    scope: { projectId: "project-b" },
    provenance: prov,
  });
  proc.setMemoryProcessorRunnerForTests(
    fakeRunner(JSON.stringify({ operations: [] })),
  );
  const groups = new Set<string>();
  // Capture which group each run reserves by reading the ledger trigger.
  const { memoryProcessorStore } =
    await import("../db/memoryProcessorStore.ts");
  await proc.runConsolidation();
  await proc.runConsolidation();
  for (const run of memoryProcessorStore.recent(10))
    if (run.trigger?.startsWith("consolidation:")) groups.add(run.trigger);
  assert.equal(
    groups.size,
    2,
    "two consolidation runs cover BOTH scope groups (no starvation)",
  );
});

test("unconfigured processor defers (releases) observations instead of burning retries (I)", async () => {
  // Deterministic unconfigured state: processor set to Claude SDK while the Claude
  // SDK integration is disabled (default), so no model registry lookup is involved.
  const { updateSettings, getSettings } = await import("../settings.ts");
  const { CLAUDE_SDK_PROVIDER } = await import("@assistant/shared");
  updateSettings({
    memory: {
      ...getSettings().memory,
      processor: {
        provider: CLAUDE_SDK_PROVIDER,
        modelId: "sonnet",
        thinkingLevel: "off",
      },
    },
    claudeSdk: { enabled: false },
  });
  const status = await proc.processorConfigStatus();
  assert.equal(status.configured, false);
  assert.ok(
    status.message && status.message.length > 0,
    "actionable message provided",
  );
  const obs = memoryObservationStore.enqueue({
    sessionId: "s1",
    userTurnId: "unconf",
    persona: "assistant",
    humanText: "please remember x",
    sourceTimestampMs: nowMs,
    timezone: "UTC",
    createdAt: nowMs,
  });
  memoryObservationStore.claim([obs.id], nowMs);
  const outcome = await proc.runMemoryProcessor(
    [memoryObservationStore.get(obs.id)!],
    { trigger: "batch" },
  );
  assert.equal(outcome.reason, "unconfigured");
  assert.equal(
    memoryObservationStore.get(obs.id)!.state,
    "pending",
    "released for later, not failed/retried",
  );
  assert.equal(
    memoryObservationStore.get(obs.id)!.attempts,
    1,
    "no extra retries burned",
  );
  // Restore a valid processor for other tests.
  updateSettings({
    memory: {
      ...getSettings().memory,
      processor: {
        provider: "github-copilot",
        modelId: "gpt-4.1",
        thinkingLevel: "off",
      },
    },
  });
});

/** A minimal harness-neutral `/compact` host (the surface `runCompactForHost` drives). */
function fakeCompactHost(
  sessionId: string,
  outcome: HostCompactionOutcome,
): SyntheticToolHost {
  return {
    kind: "personal-assistant",
    sessionId,
    beginSyntheticTool: () => ({ assistantId: "a1", toolId: "slash-1" }),
    updateSyntheticTool: () => {},
    finishSyntheticTool: () => {},
    finishSyntheticCard: () => {},
    commitWorkflowContext: () => ({ sessionManager: undefined }),
    compactContext: async () => outcome,
  } as unknown as SyntheticToolHost;
}

function putCompactionSnapshot(sessionId: string): void {
  memoryLoadStore.putSnapshot({
    sessionId,
    fingerprint: "fp",
    effective: [{ id: "m1", revision: 1 }],
    renderedText: "x",
    renderedChars: 1,
    lastDeliveryState: "injected",
    cumulativeInjectedChars: 120,
    updatedAt: nowMs,
  });
}

test("/compact resets the memory session snapshot so the next turn reinjects (B)", async () => {
  const { runCompactForHost } = await import("../hostSlashCommands.ts");
  putCompactionSnapshot("compact-s");
  await runCompactForHost(
    fakeCompactHost("compact-s", {
      kind: "compacted",
      summary: "did it",
      tokensBefore: 1000,
      firstKeptEntryId: "e1",
    }),
    "",
  );
  assert.equal(
    memoryLoadStore.getSnapshot("compact-s"),
    undefined,
    "delivered snapshot + cumulative diagnostic cleared after compaction (next turn reinjects)",
  );
});

test("a harness that declines to compact leaves the memory snapshot in place", async () => {
  const { runCompactForHost } = await import("../hostSlashCommands.ts");
  putCompactionSnapshot("compact-skip");
  await runCompactForHost(
    fakeCompactHost("compact-skip", {
      kind: "skipped",
      reason: "Not enough messages to compact.",
    }),
    "",
  );
  assert.ok(
    memoryLoadStore.getSnapshot("compact-skip"),
    "nothing was replaced, so the delivered snapshot still describes the live context",
  );
});

test("prunePending bounds the queue by count and age", () => {
  for (let i = 0; i < 3; i += 1)
    memoryObservationStore.enqueue({
      sessionId: "s",
      userTurnId: `old${i}`,
      humanText: "x",
      sourceTimestampMs: nowMs,
      timezone: "UTC",
      createdAt: nowMs - 30 * 86_400_000,
    });
  memoryObservationStore.enqueue({
    sessionId: "s",
    userTurnId: "fresh",
    humanText: "x",
    sourceTimestampMs: nowMs,
    timezone: "UTC",
    createdAt: nowMs,
  });
  const discarded = memoryObservationStore.prunePending(
    nowMs,
    500,
    7 * 86_400_000,
    1_000_000,
  );
  assert.equal(discarded, 3, "aged-out pending discarded");
  assert.equal(memoryObservationStore.pendingCount(), 1);
});

/* --------------------- archive-as-suppression (exchange 12) -------------------- */

test("archive is suppression: automatic capture never resurrects a user-archived duplicate", () => {
  const created = svc.createMemory({
    text: "Prefers dark mode",
    kind: "preference",
    provenance: prov,
  });
  assert.ok(created.ok);
  const archived = svc.archiveMemory(created.card.id, created.card.revision);
  assert.ok(archived.ok && archived.card.state === "archived");

  // Automatic capture (processor) re-observing the exact same content must leave
  // it archived, not resurrect it.
  const autoAgain = svc.createMemory({
    text: "Prefers dark mode",
    kind: "preference",
    provenance: { sourceKind: "processor" },
  });
  assert.ok(
    autoAgain.ok &&
      autoAgain.card.id === created.card.id &&
      autoAgain.card.state === "archived",
    "automatic re-observation left the card archived",
  );

  // Consolidation/import provenance is likewise automatic, not explicit.
  const consolidationAgain = svc.createMemory({
    text: "Prefers dark mode",
    kind: "preference",
    provenance: { sourceKind: "consolidation" },
  });
  assert.ok(
    consolidationAgain.ok && consolidationAgain.card.state === "archived",
  );
  const importAgain = svc.createMemory({
    text: "Prefers dark mode",
    kind: "preference",
    provenance: { sourceKind: "import" },
  });
  assert.ok(importAgain.ok && importAgain.card.state === "archived");

  // An EXPLICIT write (manual or agent-on-user-request) DOES restore it.
  const manualAgain = svc.createMemory({
    text: "Prefers dark mode",
    kind: "preference",
    provenance: { sourceKind: "manual" },
  });
  assert.ok(
    manualAgain.ok &&
      manualAgain.card.id === created.card.id &&
      manualAgain.card.state === "active",
    "explicit manual re-write restores the suppressed card",
  );
});

test("archive is suppression: an explicit agent-provenance write also restores", () => {
  const created = svc.createMemory({
    text: "Uses two-space indent",
    kind: "preference",
    provenance: prov,
  });
  assert.ok(created.ok);
  const archived = svc.archiveMemory(created.card.id, created.card.revision);
  assert.ok(archived.ok);
  const agentAgain = svc.createMemory({
    text: "Uses two-space indent",
    kind: "preference",
    provenance: { sourceKind: "agent" },
  });
  assert.ok(
    agentAgain.ok &&
      agentAgain.card.id === created.card.id &&
      agentAgain.card.state === "active",
  );
});

/* ------------------- operation-idempotency ledger (exchange 12) --------------- */

test("withOperationIdempotency: exact key retry is a no-op; a different key re-applies", () => {
  const created = svc.createMemory({
    text: "Idempotent card A",
    kind: "fact",
    provenance: prov,
  });
  assert.ok(created.ok);
  let calls = 0;
  const run = () => {
    calls += 1;
    return svc.reinforceMemory(created.card.id);
  };
  const first = svc.withOperationIdempotency("op:fixed-key", run);
  assert.ok(first.ok && calls === 1);
  const retry = svc.withOperationIdempotency("op:fixed-key", run);
  assert.ok(
    retry.ok &&
      retry.card.id === first.card.id &&
      retry.card.revision === first.card.revision,
    "exact retry returns the prior result without re-applying",
  );
  assert.ok(calls === 1, "the mutation function itself was not invoked again");
  const different = svc.withOperationIdempotency("op:other-key", run);
  assert.ok(
    different.ok && (calls as number) === 2,
    "a genuinely different key re-applies",
  );
});

test("memoryOperationStore.prune removes only rows older than the retention cutoff", async () => {
  const { memoryOperationStore } =
    await import("../db/memoryOperationStore.ts");
  memoryOperationStore.record("op:old", "card-old", nowMs - 40 * 86_400_000);
  memoryOperationStore.record("op:fresh", "card-fresh", nowMs);
  const removed = memoryOperationStore.prune(nowMs - 30 * 86_400_000);
  assert.equal(removed, 1, "only the aged-out row was pruned");
  assert.equal(memoryOperationStore.cardIdFor("op:old"), undefined);
  assert.equal(
    memoryOperationStore.cardIdFor("op:fresh"),
    "card-fresh",
    "recent row retained for the retry/audit window",
  );
});
