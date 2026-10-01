/**
 * Task 100: bounded memory management/audit API. Isolated temp DB.
 *   pnpm --filter @assistant/server test src/memory/memoryApi.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "memory-api-test-"));
process.env.ASSISTANT_CWD = tmp;

const api = await import("./memoryApi.ts");
const svc = await import("./memoryService.ts");
const { memoryStore } = await import("../db/memoryStore.ts");
const { memoryLoadStore } = await import("../db/memoryLoadStore.ts");
const { getDb, closeDb } = await import("../db/index.ts");

const prov = { sourceKind: "manual" as const };

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM memory_cards");
  db.exec("DELETE FROM memory_load_batches");
  db.exec("DELETE FROM memory_load_items");
});
afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("list is bounded, paginated, and filterable", () => {
  for (let i = 0; i < 30; i += 1)
    svc.createMemory({
      text: `Preference number ${i}`,
      kind: "preference",
      scope: i % 2 ? { projectId: "acme" } : {},
      provenance: prov,
    });
  const page = api.listMemory({ limit: 10, offset: 0 });
  assert.equal(page.cards.length, 10);
  assert.equal(page.total, 30);
  assert.equal(page.hasMore, true);
  const scoped = api.listMemory({ projectId: "acme", limit: 100 });
  assert.ok(scoped.cards.every((c) => c.scope.projectId === "acme"));
  const text = api.listMemory({ text: "number 7" });
  assert.deepEqual(
    text.cards.map((c) => c.text),
    ["Preference number 7"],
  );
});

test("list total/pagination are exact SQL results across combined filters (project+persona+pin+kind+text), not a JS-side re-derivation (exchange 17)", () => {
  // 12 matching cards (project+persona+kind+pinned+text all match), interleaved
  // with non-matching cards on EACH dimension so a JS post-filter bug (deriving
  // `total` from a differently-filtered candidate set) would show up as a wrong count.
  for (let i = 0; i < 12; i += 1) {
    svc.createMemory({
      text: `deploy freeze note ${i}`,
      kind: "constraint",
      scope: { projectId: "acme", persona: "assistant" },
      pinned: true,
      provenance: prov,
    });
  }
  svc.createMemory({
    text: "deploy freeze note other project",
    kind: "constraint",
    scope: { projectId: "other", persona: "assistant" },
    pinned: true,
    provenance: prov,
  });
  svc.createMemory({
    text: "deploy freeze note other persona",
    kind: "constraint",
    scope: { projectId: "acme", persona: "developer" },
    pinned: true,
    provenance: prov,
  });
  svc.createMemory({
    text: "deploy freeze note unpinned",
    kind: "constraint",
    scope: { projectId: "acme", persona: "assistant" },
    pinned: false,
    provenance: prov,
  });
  svc.createMemory({
    text: "deploy freeze note wrong kind",
    kind: "fact",
    scope: { projectId: "acme", persona: "assistant" },
    pinned: true,
    provenance: prov,
  });
  svc.createMemory({
    text: "unrelated text entirely",
    kind: "constraint",
    scope: { projectId: "acme", persona: "assistant" },
    pinned: true,
    provenance: prov,
  });

  const filter = {
    projectId: "acme",
    persona: "assistant" as const,
    kinds: ["constraint" as const],
    pinned: true,
    text: "deploy freeze",
  };
  const page1 = api.listMemory({ ...filter, limit: 5, offset: 0 });
  assert.equal(
    page1.total,
    12,
    "total is an exact SQL count over the full combined filter, not a page-sized/JS-derived guess",
  );
  assert.equal(page1.cards.length, 5);
  assert.equal(page1.hasMore, true);
  const page3 = api.listMemory({ ...filter, limit: 5, offset: 10 });
  assert.equal(page3.cards.length, 2, "last page has the remainder");
  assert.equal(page3.hasMore, false);

  // Collected across all pages, every returned id is exactly the 12 matching cards.
  const seen = new Set<string>();
  for (const c of [
    ...page1.cards,
    ...api.listMemory({ ...filter, limit: 5, offset: 5 }).cards,
    ...page3.cards,
  ])
    seen.add(c.id);
  assert.equal(seen.size, 12);
});

test("activeNow evaluates temporal eligibility using the profile timezone, not UTC (exchange 18a)", async () => {
  const { updateSettings, getSettings } = await import("../settings.ts");
  const prevProfile = getSettings().profile;
  try {
    // 2026-07-13T23:30:00Z is Monday in UTC, but already Tuesday 08:30 in Tokyo —
    // a Tuesday-only recurring card (no timezone of its own) must be evaluated
    // against the CONFIGURED profile timezone, not UTC.
    updateSettings({
      profile: { ...prevProfile, timeZone: "Asia/Tokyo" },
    });
    const nowMs = Date.parse("2026-07-13T23:30:00Z");
    svc.createMemory({
      text: "Tuesday-only reminder",
      kind: "working",
      temporal: {
        mode: "recurring",
        recurrence: { kind: "weekly", weekdays: [2] },
      },
      provenance: prov,
    });
    const active = api.listMemory({ activeNow: true }, nowMs);
    assert.deepEqual(
      active.cards.map((c) => c.text),
      ["Tuesday-only reminder"],
      "eligible using Tokyo's Tuesday, not UTC's Monday",
    );
  } finally {
    updateSettings({ profile: prevProfile });
  }
});

test("activeNow total/pagination for the deterministic (window/persistent/until-changed) part is exact SQL, not a JS scan cap (exchange 21)", () => {
  const nowMs = Date.parse("2026-07-13T12:00:00Z");
  // 25 active window cards (well beyond a small page size) + distractors that
  // must be EXCLUDED: an expired window, a future window, and a windowless
  // persistent card (per temporalEligibility, activeNow requires an actual window).
  for (let i = 0; i < 25; i += 1) {
    svc.createMemory({
      text: `active window ${i}`,
      kind: "working",
      temporal: { mode: "window", validUntilMs: nowMs + 86_400_000 },
      provenance: prov,
    });
  }
  svc.createMemory({
    text: "expired window",
    kind: "working",
    temporal: { mode: "window", validUntilMs: nowMs - 1 },
    provenance: prov,
  });
  svc.createMemory({
    text: "future window",
    kind: "working",
    temporal: {
      mode: "window",
      validFromMs: nowMs + 86_400_000,
      validUntilMs: nowMs + 2 * 86_400_000,
    },
    provenance: prov,
  });
  svc.createMemory({
    text: "windowless persistent",
    kind: "fact",
    provenance: prov,
  });

  const page1 = api.listMemory(
    { activeNow: true, limit: 10, offset: 0 },
    nowMs,
  );
  assert.equal(
    page1.total,
    25,
    "exact SQL count across the full matching set, no truncation",
  );
  assert.equal(page1.cards.length, 10);
  assert.equal(page1.hasMore, true);
  const page3 = api.listMemory(
    { activeNow: true, limit: 10, offset: 20 },
    nowMs,
  );
  assert.equal(page3.cards.length, 5, "last page has the remainder");
  assert.equal(page3.hasMore, false);

  const seen = new Set<string>();
  for (const c of [
    ...page1.cards,
    ...api.listMemory({ activeNow: true, limit: 10, offset: 10 }, nowMs).cards,
    ...page3.cards,
  ])
    seen.add(c.id);
  assert.equal(seen.size, 25, "every active card is reachable across pages");
});

test("activeNow merges the recurring (JS-evaluated) and deterministic (SQL) parts into one correctly paginated set (exchange 21)", () => {
  const nowMs = Date.parse("2026-07-14T12:00:00Z"); // a Tuesday in UTC
  for (let i = 0; i < 3; i += 1) {
    svc.createMemory({
      text: `recurring tuesday ${i}`,
      kind: "working",
      temporal: {
        mode: "recurring",
        timezone: "UTC",
        recurrence: { kind: "weekly", weekdays: [2] },
      },
      provenance: prov,
    });
  }
  for (let i = 0; i < 4; i += 1) {
    svc.createMemory({
      text: `deterministic window ${i}`,
      kind: "working",
      temporal: { mode: "window", validUntilMs: nowMs + 86_400_000 },
      provenance: prov,
    });
  }
  // A non-matching recurring card (wrong weekday) must be excluded from the merge.
  svc.createMemory({
    text: "recurring monday only",
    kind: "working",
    temporal: {
      mode: "recurring",
      timezone: "UTC",
      recurrence: { kind: "weekly", weekdays: [1] },
    },
    provenance: prov,
  });

  const all = api.listMemory({ activeNow: true, limit: 100, offset: 0 }, nowMs);
  assert.equal(
    all.total,
    7,
    "3 recurring + 4 deterministic, excluding the non-matching weekday",
  );
  assert.equal(
    new Set(all.cards.map((c) => c.id)).size,
    7,
    "no duplicates, no gaps",
  );

  // A page straddling the recurring/deterministic boundary still returns exactly
  // the right count with no duplicate or missing id versus the full listing.
  const straddling = api.listMemory(
    { activeNow: true, limit: 3, offset: 2 },
    nowMs,
  );
  assert.equal(straddling.cards.length, 3);
  const allIds = new Set(all.cards.map((c) => c.id));
  for (const c of straddling.cards)
    assert.ok(
      allIds.has(c.id),
      "straddling page ids are a subset of the full matching set",
    );
});

test("activeNow's recurring scan is exact and bounded across a chunk boundary, not a single unbounded fetch (exchange 23)", () => {
  const nowMs = Date.parse("2026-07-14T12:00:00Z"); // a Tuesday in UTC
  // 250 eligible recurring cards spans the 200-row scan chunk boundary.
  const RECURRING_COUNT = 250;
  for (let i = 0; i < RECURRING_COUNT; i += 1) {
    svc.createMemory({
      text: `recurring tuesday bulk ${i}`,
      kind: "working",
      temporal: {
        mode: "recurring",
        timezone: "UTC",
        recurrence: { kind: "weekly", weekdays: [2] },
      },
      provenance: prov,
    });
  }

  const page1 = api.listMemory(
    { activeNow: true, limit: 10, offset: 0 },
    nowMs,
  );
  assert.equal(
    page1.total,
    RECURRING_COUNT,
    "exact count across the full scan, spanning the chunk boundary",
  );
  assert.equal(
    page1.cards.length,
    10,
    "only the requested page is materialized, not the whole 250-row scan",
  );
  assert.equal(page1.hasMore, true);

  // A page whose offset falls in the SECOND scan chunk (>= 200) is still exact.
  const lastPage = api.listMemory(
    { activeNow: true, limit: 10, offset: 245 },
    nowMs,
  );
  assert.equal(lastPage.cards.length, 5, "last page has the remainder");
  assert.equal(lastPage.hasMore, false);

  const seen = new Set<string>();
  for (const c of [...page1.cards, ...lastPage.cards]) seen.add(c.id);
  assert.equal(
    seen.size,
    15,
    "no duplicate ids across pages spanning the chunk boundary",
  );
});

test("activeNow's recurring scan keyset cursor has no gaps/duplicates when many cards share the SAME updated_at_ms, across a chunk boundary (exchange 25)", () => {
  const nowMs = Date.parse("2026-07-14T12:00:00Z"); // a Tuesday in UTC
  const RECURRING_COUNT = 250;
  const FIXED_TS = 1_800_000_000_000;
  svc.setMemoryClockForTests(() => FIXED_TS);
  try {
    // All 250 cards share the exact same updated_at_ms, forcing the keyset
    // cursor's tie-break on `id` to do all the work across the chunk boundary
    // (a cursor keyed on updated_at_ms alone would skip or repeat rows here).
    for (let i = 0; i < RECURRING_COUNT; i += 1) {
      svc.createMemory({
        text: `same-timestamp recurring ${i}`,
        kind: "working",
        temporal: {
          mode: "recurring",
          timezone: "UTC",
          recurrence: { kind: "weekly", weekdays: [2] },
        },
        provenance: prov,
      });
    }
  } finally {
    svc.resetMemoryClockForTests();
  }

  const first = api.listMemory(
    { activeNow: true, limit: 10, offset: 0 },
    nowMs,
  );
  assert.equal(first.total, RECURRING_COUNT);

  // Walk every page-of-10 boundary (crossing the 200-row scan chunk at least
  // once) and confirm the union reconstructs the full set with no gaps.
  const collected = new Set<string>();
  for (let offset = 0; offset < RECURRING_COUNT; offset += 10) {
    const page = api.listMemory({ activeNow: true, limit: 10, offset }, nowMs);
    for (const c of page.cards) collected.add(c.id);
  }
  assert.equal(
    collected.size,
    RECURRING_COUNT,
    "paging through every offset reconstructs the full set — no gaps",
  );
});

test("the recurring scan issues multiple bounded SQL chunk calls, not one unbounded fetch (exchange 25 query-count seam)", () => {
  const nowMs = Date.parse("2026-07-14T12:00:00Z"); // a Tuesday in UTC
  for (let i = 0; i < 250; i += 1) {
    svc.createMemory({
      text: `chunked call-count recurring ${i}`,
      kind: "working",
      temporal: {
        mode: "recurring",
        timezone: "UTC",
        recurrence: { kind: "weekly", weekdays: [2] },
      },
      provenance: prov,
    });
  }

  let recurringListCalls = 0;
  const originalList = memoryStore.list;
  memoryStore.list = ((filter: Parameters<typeof memoryStore.list>[0]) => {
    if (filter?.temporalModes?.includes("recurring")) recurringListCalls += 1;
    return originalList(filter);
  }) as typeof memoryStore.list;
  try {
    const result = api.listMemory(
      { activeNow: true, limit: 10, offset: 0 },
      nowMs,
    );
    assert.equal(result.total, 250);
  } finally {
    memoryStore.list = originalList;
  }
  // 250 rows / 200-row chunk = at least 2 chunk calls (200 + 50), proving the
  // scan chunks rather than issuing one unbounded query.
  assert.ok(
    recurringListCalls >= 2,
    `expected >= 2 chunked recurring list() calls, got ${recurringListCalls}`,
  );
});

test("mutate honors revision conflicts and returns the current card", () => {
  const created = svc.createMemory({
    text: "Lives in Berlin",
    kind: "fact",
    provenance: prov,
  });
  assert.ok(created.ok);
  const rev = created.card.revision;
  const ok = api.mutateMemory({
    op: "edit",
    id: created.card.id,
    expectedRevision: rev,
    text: "Lives in Munich",
  });
  assert.ok(ok.ok && ok.card.text === "Lives in Munich");
  const conflict = api.mutateMemory({
    op: "edit",
    id: created.card.id,
    expectedRevision: rev,
    text: "Lives in Hamburg",
  });
  assert.ok(!conflict.ok && conflict.error === "stale-revision");
  if (!conflict.ok && conflict.error === "stale-revision")
    assert.equal(conflict.current.text, "Lives in Munich");
});

test("correct produces lineage; archive/restore round-trip", () => {
  const created = svc.createMemory({
    text: "Uses tabs",
    kind: "preference",
    provenance: prov,
  });
  assert.ok(created.ok);
  const corrected = api.mutateMemory({
    op: "correct",
    id: created.card.id,
    expectedRevision: created.card.revision,
    text: "Uses spaces",
    kind: "preference",
  });
  assert.ok(corrected.ok);
  const lineage = api.getMemoryLineage(created.card.id);
  assert.equal(lineage.card!.state, "superseded");
  assert.equal(lineage.supersededBy.length, 1);
  assert.equal(lineage.supersededBy[0]!.text, "Uses spaces");

  const replacementId = corrected.ok ? corrected.card.id : "";
  const replacement = svc.memoryService.get(replacementId)!;
  const archived = api.mutateMemory({
    op: "archive",
    id: replacementId,
    expectedRevision: replacement.revision,
  });
  assert.ok(archived.ok && archived.card.state === "archived");
  const restored = api.mutateMemory({
    op: "restore",
    id: replacementId,
    expectedRevision: archived.ok ? archived.card.revision : 0,
  });
  assert.ok(restored.ok && restored.card.state === "active");
});

test("loading can be inspected per session (bounded recent batches)", () => {
  memoryLoadStore.recordBatch({
    sessionId: "s1",
    userTurnId: "t1",
    fingerprint: "fp",
    deliveryState: "injected",
    renderedChars: 5,
    injectedChars: 5,
    cumulativeInjectedChars: 5,
    createdAt: 1,
    items: [],
  });
  memoryLoadStore.recordBatch({
    sessionId: "s1",
    userTurnId: "t2",
    fingerprint: "fp",
    deliveryState: "reused",
    renderedChars: 5,
    injectedChars: 0,
    cumulativeInjectedChars: 5,
    createdAt: 2,
    items: [],
  });
  const batches = api.recentMemoryLoads("s1", 20);
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.userTurnId, "t2", "newest first");
});

test("mutation idempotency key is scoped by connection identity + operation content, not a bare requestId (exchange 14)", () => {
  const a = svc.createMemory({
    text: "Card A",
    kind: "fact",
    provenance: prov,
  });
  const b = svc.createMemory({
    text: "Card B",
    kind: "fact",
    provenance: prov,
  });
  assert.ok(a.ok && b.ok);

  // An exact retry (same connection, same requestId, same operation) is an
  // idempotent no-op: pinning twice does not toggle/error.
  const identity = { connectionId: "conn-1", requestId: "req-1" };
  const first = api.mutateMemory(
    { op: "pin", id: a.card.id, expectedRevision: a.card.revision },
    identity,
  );
  assert.ok(first.ok && first.card.pinned);
  const retry = api.mutateMemory(
    { op: "pin", id: a.card.id, expectedRevision: a.card.revision },
    identity,
  );
  assert.ok(
    retry.ok &&
      retry.card.id === first.card.id &&
      retry.card.revision === first.card.revision,
    "exact retry returns the prior result",
  );

  // A crafted/collided requestId reused on the SAME connection for a DIFFERENT
  // operation must NOT return the stale ledger result for card A — the content
  // hash in the key must distinguish it, so it actually pins card B.
  const differentOp = api.mutateMemory(
    { op: "pin", id: b.card.id, expectedRevision: b.card.revision },
    identity,
  );
  assert.ok(
    differentOp.ok &&
      differentOp.card.id === b.card.id &&
      differentOp.card.pinned,
    "same requestId + connection but a different operation is NOT treated as the prior retry",
  );

  // The same requestId on a DIFFERENT connection is an independent operation,
  // not a collision with connection 1's ledger entry.
  const otherConnection = api.mutateMemory(
    { op: "unpin", id: a.card.id, expectedRevision: first.card.revision },
    { connectionId: "conn-2", requestId: "req-1" },
  );
  assert.ok(
    otherConnection.ok && !otherConnection.card.pinned,
    "a different connection with the same requestId is not conflated with connection 1's operation",
  );
});

test("untrusted filter/operation shapes are coerced/rejected before side effects", () => {
  assert.deepEqual(
    api.coerceMemoryListFilter({
      persona: "bogus",
      kinds: ["preference", "nope"],
      limit: 5,
    }),
    { kinds: ["preference"], limit: 5 },
  );
  assert.equal(
    api.coerceMemoryMutateOperation({ op: "edit" }),
    null,
    "missing id/revision rejected",
  );
  assert.equal(
    api.coerceMemoryMutateOperation({
      op: "correct",
      id: "x",
      expectedRevision: 1,
    }),
    null,
    "correct requires text",
  );
  assert.deepEqual(
    api.coerceMemoryMutateOperation({
      op: "pin",
      id: "x",
      expectedRevision: 2,
    }),
    { op: "pin", id: "x", expectedRevision: 2 },
  );
});
