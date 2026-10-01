/**
 * Task 95: deterministic selector + search. Pure (no DB) with a fake clock.
 *   pnpm --filter @assistant/server test src/memory/memorySelector.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  MemoryCard,
  MemoryKind,
  MemoryScope,
  MemoryTemporal,
} from "@assistant/shared";
import {
  searchMemory,
  selectMemory,
  temporalEligibility,
} from "./memorySelector.ts";
import type { MemoryScopeContext } from "./memoryService.ts";
import { measureCpuMs } from "../test/cpuBudget.ts";

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

let seq = 0;
function card(
  text: string,
  kind: MemoryKind,
  opts: Partial<MemoryCard> = {},
): MemoryCard {
  seq += 1;
  return {
    id: opts.id ?? `mem_${seq.toString().padStart(3, "0")}`,
    revision: opts.revision ?? 1,
    text,
    kind,
    scope: opts.scope ?? ({} as MemoryScope),
    state: opts.state ?? "active",
    pinned: opts.pinned ?? false,
    strength: opts.strength ?? 1,
    temporal: opts.temporal ?? ({ mode: "persistent" } as MemoryTemporal),
    observedAtMs: opts.observedAtMs ?? T0,
    createdAt: T0,
    updatedAt: T0,
    provenance: opts.provenance ?? { sourceKind: "manual" },
  };
}

const ctx: MemoryScopeContext = {
  persona: "personal-assistant",
  projectId: "acme",
};

test("selection is deterministic and bounded, with baseline + query categories", () => {
  const cards = [
    card("Prefers concise answers", "preference"),
    card("Never deploy on Fridays", "constraint"),
    card("The API rate limit is 100 req/s", "fact"),
    card("Likes hiking on weekends", "fact"),
  ];
  const r1 = selectMemory({
    cards,
    context: ctx,
    prompt: "what is the api rate limit?",
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
  });
  const r2 = selectMemory({
    cards,
    context: ctx,
    prompt: "what is the api rate limit?",
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
  });
  assert.equal(r1.fingerprint, r2.fingerprint, "deterministic");
  const ids = r1.items.map((i) => i.id);
  // preference + constraint baseline always present; the rate-limit fact enters as a query match; hiking does not.
  assert.ok(
    ids.includes(cards[0]!.id) && ids.includes(cards[1]!.id),
    "baseline preference + constraint present",
  );
  assert.ok(ids.includes(cards[2]!.id), "query-relevant fact admitted");
  assert.ok(!ids.includes(cards[3]!.id), "irrelevant fact excluded");
  assert.ok(
    r1.items.every((i, idx) => i.rank === idx + 1),
    "1-based contiguous ranks",
  );
});

test("unchanged turns preserve one fingerprint", () => {
  const cards = [
    card("Prefers dark mode", "preference"),
    card("Uses PostgreSQL for analytics", "fact"),
  ];
  const first = selectMemory({
    cards,
    context: ctx,
    prompt: "tell me about postgresql analytics",
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
  });
  const second = selectMemory({
    cards,
    context: ctx,
    prompt: "tell me about postgresql analytics",
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
    prior: first.items.map((i) => ({ id: i.id, revision: i.revision })),
    priorFingerprint: first.fingerprint,
  });
  assert.equal(
    second.changed,
    false,
    "identical inputs produce one fingerprint",
  );
  assert.equal(second.fingerprint, first.fingerprint);
});

test("hysteresis retains a previously-admitted query card that would not be admitted fresh", () => {
  // Long card text so a low-overlap prompt lands between the retain and admit thresholds.
  const fact = card(
    "the quarterly revenue reporting dashboard uses postgres analytics engine internally",
    "fact",
  );
  const cards = [card("Prefers dark mode", "preference"), fact];
  const weakPrompt =
    "help me understand our analytics approach today please thanks";
  // Fresh (no prior): the weak overlap is below the admit threshold, so the fact is NOT admitted.
  const fresh = selectMemory({
    cards,
    context: ctx,
    prompt: weakPrompt,
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
  });
  assert.ok(
    !fresh.items.some((i) => i.id === fact.id),
    "weak overlap not admitted fresh",
  );
  // A strong prompt admits it.
  const strong = selectMemory({
    cards,
    context: ctx,
    prompt: "postgres analytics revenue dashboard",
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
  });
  assert.ok(
    strong.items.some((i) => i.id === fact.id),
    "strong overlap admitted",
  );
  // With the strong prior + the weak prompt, hysteresis RETAINS the sticky card.
  const retained = selectMemory({
    cards,
    context: ctx,
    prompt: weakPrompt,
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
    prior: strong.items.map((i) => ({ id: i.id, revision: i.revision })),
    priorFingerprint: strong.fingerprint,
  });
  assert.ok(
    retained.items.some((i) => i.id === fact.id),
    "previously-admitted query card retained under hysteresis",
  );
});

test("a qualifying query candidate crosses the admission threshold and changes the snapshot", () => {
  const cards = [
    card("Prefers dark mode", "preference"),
    card("The staging database password rotates monthly", "fact"),
  ];
  const base = selectMemory({
    cards,
    context: ctx,
    prompt: "hello",
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
  });
  assert.ok(
    !base.items.some((i) => i.reasonCode === "query-match"),
    "no query match for an unrelated prompt",
  );
  const withQuery = selectMemory({
    cards,
    context: ctx,
    prompt: "when does the staging database password rotate?",
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
    prior: base.items.map((i) => ({ id: i.id, revision: i.revision })),
    priorFingerprint: base.fingerprint,
  });
  assert.ok(
    withQuery.changed,
    "qualifying query candidate changes the snapshot",
  );
  assert.ok(
    withQuery.items.some((i) => i.reasonCode === "query-match"),
    "query fact admitted",
  );
});

test("replacement-margin hysteresis: a marginal new query card cannot displace a stronger current one", () => {
  const strong = card("alpha beta gamma", "fact");
  const weak = card("delta", "fact");
  const cards = [card("Prefers dark mode", "preference"), strong, weak];
  const prompt = "alpha beta gamma delta"; // strong lex ≈ 0.85, weak lex ≈ 0.55
  // Fresh (no prior): the weak fact clears the admission threshold and is admitted.
  const fresh = selectMemory({
    cards,
    context: ctx,
    prompt,
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
  });
  assert.ok(
    fresh.items.some((i) => i.id === weak.id),
    "weak query card admitted when there is no stronger current query card",
  );
  // With `strong` already a current (prior) query card, the weak new card does NOT
  // clear the margin over the weakest current query card, so it is suppressed.
  const prior = [{ id: strong.id, revision: strong.revision }];
  const withPrior = selectMemory({
    cards,
    context: ctx,
    prompt,
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
    prior,
    priorFingerprint: "x",
  });
  assert.ok(
    withPrior.items.some((i) => i.id === strong.id),
    "stronger prior query card retained",
  );
  assert.ok(
    !withPrior.items.some((i) => i.id === weak.id),
    "marginal new query card suppressed by replacement margin",
  );
});

test("scope intersection and temporal boundaries are enforced", () => {
  const other = selectMemory({
    cards: [
      card("Team standup is at 9", "fact", { scope: { projectId: "other" } }),
    ],
    context: ctx,
    prompt: "standup",
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
  });
  assert.equal(other.items.length, 0, "wrong-project card excluded");

  const future = card("In Tokyo", "working", {
    temporal: {
      mode: "window",
      validFromMs: T0 + DAY,
      validUntilMs: T0 + 2 * DAY,
    },
  });
  const expired = card("Was in Paris", "working", {
    temporal: {
      mode: "window",
      validFromMs: T0 - 2 * DAY,
      validUntilMs: T0 - DAY,
    },
  });
  const activeNow = card("In Berlin now", "working", {
    temporal: { mode: "window", validFromMs: T0 - DAY, validUntilMs: T0 + DAY },
  });
  const r = selectMemory({
    cards: [future, expired, activeNow],
    context: ctx,
    prompt: "where am i",
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
  });
  assert.deepEqual(
    r.items.map((i) => i.id),
    [activeNow.id],
    "only the active-now temporal card is selected",
  );
  assert.equal(r.items[0]!.reasonCode, "active-temporal");

  // Recurring: eligible only on matching weekday. T0 is a Tuesday in UTC.
  const tueUtc = temporalEligibility(
    card("weekly", "working", {
      temporal: {
        mode: "recurring",
        timezone: "UTC",
        recurrence: { kind: "weekly", weekdays: [2] },
      },
    }),
    T0,
  );
  assert.equal(tueUtc.eligible, true);
  const monOnly = temporalEligibility(
    card("weekly", "working", {
      temporal: {
        mode: "recurring",
        timezone: "UTC",
        recurrence: { kind: "weekly", weekdays: [1] },
      },
    }),
    T0,
  );
  assert.equal(monOnly.eligible, false);
});

test("stable preferences remain eligible when old; character budget drops whole cards", () => {
  const old = card("Prefers metric units", "preference", {
    observedAtMs: T0 - 400 * DAY,
  });
  const r = selectMemory({
    cards: [old],
    context: ctx,
    prompt: "anything",
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
  });
  assert.equal(r.items.length, 1, "old stable preference still eligible");

  // Tight char budget forces dropping the lowest-ranked whole card (never a fragment).
  // Global-scope short cards so line lengths are predictable (~50 chars each).
  const globalCtx: MemoryScopeContext = { persona: "personal-assistant" };
  const many = [
    card("Prefers concise answers", "preference", { pinned: true }),
    card("Never deploy Fridays", "constraint"),
    card("Prefers metric units", "preference"),
  ];
  const tight = selectMemory({
    cards: many,
    context: globalCtx,
    prompt: "x",
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 60,
  });
  assert.ok(tight.renderedChars <= 60, "rendered chars within budget");
  assert.ok(
    tight.items.length >= 1 && tight.items.length < many.length,
    "budget dropped whole cards",
  );
  // The pinned card is protected (top rank / reserved).
  assert.equal(tight.items[0]!.reasonCode, "pinned");
  for (const item of tight.items)
    assert.ok(item.text.length > 0, "no fragmented card text");
});

test("item budget never exceeded", () => {
  const cards = Array.from({ length: 20 }, (_, i) =>
    card(`Preference number ${i}`, "preference"),
  );
  const r = selectMemory({
    cards,
    context: ctx,
    prompt: "x",
    nowMs: T0,
    maxCards: 5,
    maxRenderedChars: 100000,
  });
  assert.equal(r.items.length, 5, "never exceeds the item budget");
});

test("clearing: empty result after a prior non-empty snapshot is a change", () => {
  const cards = [card("Prefers dark mode", "preference")];
  const first = selectMemory({
    cards,
    context: ctx,
    prompt: "x",
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
  });
  assert.ok(first.items.length > 0);
  const disabled = selectMemory({
    cards,
    context: ctx,
    prompt: "x",
    nowMs: T0,
    maxCards: 8,
    maxRenderedChars: 1200,
    prior: first.items.map((i) => ({ id: i.id, revision: i.revision })),
    priorFingerprint: first.fingerprint,
    loadingEnabled: false,
  });
  assert.equal(disabled.items.length, 0);
  assert.equal(
    disabled.changed,
    true,
    "clearing a prior snapshot is a real change",
  );
});

test("large fixture: bounded latency and output size", () => {
  const big: MemoryCard[] = [];
  for (let i = 0; i < 3000; i += 1) {
    big.push(
      card(
        `Preference ${i} about topic ${i % 50} and setting ${i % 13}`,
        i % 3 === 0 ? "fact" : "preference",
        {
          scope: i % 4 === 0 ? { projectId: "acme" } : {},
        },
      ),
    );
  }
  // CPU time, not wall clock: this is a blowup guard, and on a loaded runner a
  // wall clock measures the scheduler instead (see ../test/cpuBudget.ts). The
  // budget is an order of magnitude over the ~35ms this costs, because what it
  // has to catch — a selector gone quadratic over 3,000 cards — is a multiple.
  const { value: r, cpuMs } = measureCpuMs(() =>
    selectMemory({
      cards: big,
      context: ctx,
      prompt: "topic 7 setting 3 configuration",
      nowMs: T0,
      maxCards: 8,
      maxRenderedChars: 1200,
    }),
  );
  assert.ok(
    cpuMs < 400,
    `selection over 3000 cards should be fast (was ${cpuMs.toFixed(1)}ms CPU)`,
  );
  assert.ok(r.items.length <= 8, "item budget respected");
  assert.ok(r.renderedChars <= 1200, "char budget respected");
});

test("search shares eligibility and returns compact scored hits", () => {
  const cards = [
    card("Prefers concise answers", "preference"),
    card("The API rate limit is 100 req/s", "fact"),
    card("Archived note", "fact", { state: "archived" }),
  ];
  const hits = searchMemory("api rate limit", cards);
  assert.equal(hits[0]!.text, "The API rate limit is 100 req/s");
  assert.ok(
    hits.every(
      (h) => typeof h.revision === "number" && typeof h.id === "string",
    ),
    "hits carry id + revision",
  );
  // Archived excluded by default; included when requested.
  assert.ok(
    !searchMemory("archived", cards).some((h) => h.text === "Archived note"),
  );
  assert.ok(
    searchMemory("archived", cards, { states: ["archived"] }).some(
      (h) => h.text === "Archived note",
    ),
  );
});
