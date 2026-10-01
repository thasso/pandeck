/**
 * Task 94: memory lifecycle service + scope resolver. Isolated temp DB + fake
 * clock. Table-driven coverage of lifecycle, scope, duplicate, correction,
 * expiry, stale-revision, atomic supersession, idempotency, and persona isolation.
 *   pnpm --filter @assistant/server test src/memory/memoryService.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "memory-service-test-"));
process.env.ASSISTANT_CWD = tmp;

const svc = await import("./memoryService.ts");
const { memoryStore } = await import("../db/memoryStore.ts");
const { closeDb, getDb } = await import("../db/index.ts");

let nowMs = 1_700_000_000_000;
svc.setMemoryClockForTests(() => nowMs);

beforeEach(() => {
  // Fresh table per test.
  getDb().exec("DELETE FROM memory_cards");
  nowMs = 1_700_000_000_000;
});

afterAll(() => {
  svc.resetMemoryClockForTests();
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

const prov = { sourceKind: "manual" as const, sessionId: "s1" };

test("create validates and rejects invalid/secret/empty records", () => {
  assert.equal(
    svc.createMemory({ text: "x", kind: "preference", provenance: prov }).ok,
    false,
    "too short",
  );
  assert.equal(
    svc.createMemory({
      text: "api_key=abcdef123456",
      kind: "fact",
      provenance: prov,
    }).ok,
    false,
    "secret-like",
  );
  const bad = svc.createMemory({
    text: "valid text",
    kind: "bogus" as never,
    provenance: prov,
  });
  assert.equal(bad.ok, false, "bad kind");
});

test("duplicate creates converge on one reinforced card (idempotent retries)", () => {
  const a = svc.createMemory({
    text: "Prefers dark mode",
    kind: "preference",
    provenance: prov,
  });
  const b = svc.createMemory({
    text: "prefers   dark mode",
    kind: "preference",
    provenance: { sourceKind: "processor" },
  });
  assert.ok(a.ok && b.ok);
  assert.equal(
    a.card.id,
    b.card.id,
    "explicit + processor writes converge on one card",
  );
  assert.ok(b.card.strength > a.card.strength, "duplicate reinforces strength");
  assert.equal(
    memoryStore.count({ states: ["active"] }),
    1,
    "no duplicate card",
  );
});

test("optimistic concurrency: stale revision makes no change and returns current", () => {
  const created = svc.createMemory({
    text: "Deploys on Fridays are frozen",
    kind: "constraint",
    provenance: prov,
  });
  assert.ok(created.ok);
  const rev = created.card.revision;
  const first = svc.editMemory(created.card.id, rev, {
    text: "Deploys on Fridays are blocked",
  });
  assert.ok(first.ok && first.card.revision === rev + 1);
  const stale = svc.editMemory(created.card.id, rev, {
    text: "should not apply",
  });
  assert.ok(!stale.ok && stale.reason === "stale", "stale revision rejected");
  assert.equal(
    memoryStore.get(created.card.id)!.text,
    "Deploys on Fridays are blocked",
    "stale caller cannot overwrite newer edit",
  );
});

test("correction supersedes atomically: one active replacement, inspectable chain", () => {
  const created = svc.createMemory({
    text: "Lives in Berlin",
    kind: "fact",
    provenance: prov,
  });
  assert.ok(created.ok);
  const result = svc.supersedeMemory(created.card.id, created.card.revision, {
    text: "Lives in Munich",
    kind: "fact",
    provenance: { sourceKind: "agent", sessionId: "s2" },
  });
  assert.ok(result.ok);
  assert.equal(result.old.state, "superseded");
  assert.equal(result.replacement.state, "active");
  assert.equal(
    result.replacement.supersedesId,
    created.card.id,
    "lineage recorded",
  );
  const active = memoryStore.activeCards();
  assert.equal(active.length, 1, "exactly one active card after correction");
  assert.equal(active[0]!.text, "Lives in Munich");
  assert.deepEqual(
    memoryStore.supersededBy(created.card.id).map((c) => c.id),
    [result.replacement.id],
  );

  // Stale correction changes nothing.
  const stale = svc.supersedeMemory(created.card.id, created.card.revision, {
    text: "Lives in Hamburg",
    kind: "fact",
    provenance: { sourceKind: "agent" },
  });
  assert.ok(!stale.ok && stale.reason === "stale");
  assert.equal(
    memoryStore.activeCards().length,
    1,
    "stale correction created no duplicate",
  );

  // A bad replacement leaves history intact (old stays active/unchanged).
  const fresh = svc.createMemory({
    text: "Uses vim",
    kind: "preference",
    provenance: prov,
  });
  assert.ok(fresh.ok);
  const badRepl = svc.supersedeMemory(fresh.card.id, fresh.card.revision, {
    text: "x",
    kind: "preference",
    provenance: { sourceKind: "agent" },
  });
  assert.ok(!badRepl.ok && badRepl.reason === "invalid");
  assert.equal(
    memoryStore.get(fresh.card.id)!.state,
    "active",
    "invalid replacement did not supersede the old card",
  );
});

test("deterministic expiry archives only ended, unpinned windows and keeps provenance", () => {
  const day = 86_400_000;
  const ended = svc.createMemory({
    text: "In Tokyo this week",
    kind: "working",
    temporal: {
      mode: "window",
      validFromMs: nowMs - day,
      validUntilMs: nowMs - 1,
    },
    provenance: prov,
  });
  const future = svc.createMemory({
    text: "In Paris next week",
    kind: "working",
    temporal: {
      mode: "window",
      validFromMs: nowMs + day,
      validUntilMs: nowMs + 2 * day,
    },
    provenance: prov,
  });
  const pinnedEnded = svc.createMemory({
    text: "Standing 1:1 slot",
    kind: "preference",
    pinned: true,
    temporal: { mode: "window", validUntilMs: nowMs - 1 },
    provenance: prov,
  });
  const stable = svc.createMemory({
    text: "Prefers metric units",
    kind: "preference",
    provenance: prov,
  });
  assert.ok(ended.ok && future.ok && pinnedEnded.ok && stable.ok);

  const archived = svc.expireDueMemories(nowMs);
  assert.deepEqual(
    archived.map((c) => c.id),
    [ended.card.id],
    "only the ended unpinned window expired",
  );
  assert.equal(memoryStore.get(ended.card.id)!.state, "archived");
  assert.equal(
    memoryStore.get(ended.card.id)!.provenance.sourceKind,
    "manual",
    "provenance retained on expiry",
  );
  assert.equal(
    memoryStore.get(future.card.id)!.state,
    "active",
    "future window not expired",
  );
  assert.equal(
    memoryStore.get(pinnedEnded.card.id)!.state,
    "active",
    "pinned never auto-expires",
  );
  assert.equal(
    memoryStore.get(stable.card.id)!.state,
    "active",
    "stable preference not expired by age",
  );
});

test("scope resolver + intersection matching: project/persona isolation and combined scope", () => {
  const ctx = svc.resolveSessionScope({
    persona: "personal-assistant",
    projectId: "acme",
  });
  assert.deepEqual(ctx, {
    persona: "personal-assistant",
    projectId: "acme",
  });
  // Explicit project wins over registry fallback.
  assert.equal(
    svc.resolveSessionScope({
      persona: "assistant",
      projectId: "a",
      fallbackProjectId: "b",
    }).projectId,
    "a",
  );
  assert.equal(
    svc.resolveSessionScope({ persona: "assistant", fallbackProjectId: "b" })
      .projectId,
    "b",
  );

  // Global matches everything.
  assert.ok(svc.scopeMatches({}, ctx));
  // Persona-scoped matches only that persona.
  assert.ok(svc.scopeMatches({ persona: "personal-assistant" }, ctx));
  assert.ok(!svc.scopeMatches({ persona: "assistant" }, ctx));
  // Project-scoped isolation.
  assert.ok(svc.scopeMatches({ projectId: "acme" }, ctx));
  assert.ok(!svc.scopeMatches({ projectId: "other" }, ctx));
  // Combined scope: both dimensions must match.
  assert.ok(
    svc.scopeMatches({ persona: "personal-assistant", projectId: "acme" }, ctx),
  );
  assert.ok(
    !svc.scopeMatches(
      { persona: "personal-assistant", projectId: "other" },
      ctx,
    ),
  );
  // Ordinary Assistant vs singleton Personal Assistant are isolated personas.
  const asst = svc.resolveSessionScope({ persona: "assistant" });
  assert.ok(!svc.scopeMatches({ persona: "personal-assistant" }, asst));
});

test("pin/unpin, archive/restore go through the same revision-checked path", () => {
  const created = svc.createMemory({
    text: "Prefers concise commit messages",
    kind: "preference",
    provenance: prov,
  });
  assert.ok(created.ok);
  let rev = created.card.revision;
  const pinned = svc.setMemoryPinned(created.card.id, rev, true);
  assert.ok(pinned.ok && pinned.card.pinned);
  rev = pinned.card.revision;
  const archived = svc.archiveMemory(
    created.card.id,
    rev,
    "no longer relevant",
  );
  assert.ok(archived.ok && archived.card.state === "archived");
  rev = archived.card.revision;
  const restored = svc.restoreMemory(created.card.id, rev);
  assert.ok(restored.ok && restored.card.state === "active");
  // not-found path.
  assert.deepEqual(svc.archiveMemory("nope", 1), {
    ok: false,
    reason: "not-found",
  });
});
