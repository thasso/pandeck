/**
 * Deterministic, budget-bounded memory selection + search (Task 91, no
 * embeddings). Pure and testable: given the current persona/project/time/prompt,
 * the configured budgets, and the prior effective session snapshot, it returns a
 * hybrid sticky effective set — a stable baseline (pinned + preferences/
 * constraints + active-now temporal state) plus query additions admitted only
 * above a relevance + hysteresis threshold — with exact ordered ids/revisions,
 * reasons, a deterministic fingerprint, and character counts.
 *
 * `memory_search` (Task 97) reuses the same eligibility + scoring here so the
 * escape hatch and automatic selection agree, without pretending lexical match
 * provides semantic recall.
 */
import { createHash } from "node:crypto";
import type {
  EffectiveMemoryItem,
  EffectiveMemorySnapshot,
  MemoryCard,
  MemoryLifecycleState,
  MemorySelectionReasonCode,
} from "@assistant/shared";
import type { MemoryScopeContext } from "./memoryService.ts";
import { scopeMatches } from "./memoryService.ts";

/** Bump when the scoring/rendering changes so golden fixtures (Task 103) fail loudly. */
const SELECTOR_VERSION = "v1";

/* ------------------------------ tokenization ----------------------------- */

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "am",
  "i",
  "you",
  "it",
  "this",
  "that",
  "my",
  "me",
  "we",
  "do",
  "does",
  "please",
  "can",
  "could",
  "would",
  "should",
  "will",
  "what",
  "how",
  "when",
  "where",
  "who",
]);

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/** Normalized lexical relevance of a card to the prompt, 0..1. */
function lexicalScore(promptTokens: Set<string>, cardText: string): number {
  if (promptTokens.size === 0) return 0;
  const cardTokens = tokenize(cardText);
  if (cardTokens.size === 0) return 0;
  let shared = 0;
  for (const t of cardTokens) if (promptTokens.has(t)) shared += 1;
  if (shared === 0) return 0;
  // Coverage of the prompt weighted toward precise card matches.
  const promptCoverage = shared / promptTokens.size;
  const cardCoverage = shared / cardTokens.size;
  return 0.6 * promptCoverage + 0.4 * cardCoverage;
}

/* ----------------------------- temporal state ---------------------------- */

/** Weekday index 0 (Sun) – 6 (Sat) for `ms` interpreted in an IANA timezone. */
function weekdayInZone(ms: number, timezone: string | undefined): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone ?? "UTC",
    weekday: "short",
  });
  const label = fmt.format(new Date(ms));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(label);
}

export type TemporalEligibility =
  | { eligible: true; activeNow: boolean; label?: string }
  | { eligible: false; reason: "future" | "expired" | "off-recurrence" };

/**
 * Deterministic temporal eligibility of a card at `nowMs`. Recurring cards
 * without their own timezone fall back to `defaultTimezone` (the configured Memory
 * timezone), not UTC.
 */
export function temporalEligibility(
  card: MemoryCard,
  nowMs: number,
  defaultTimezone?: string,
): TemporalEligibility {
  const t = card.temporal;
  const from = t.validFromMs;
  const until = t.validUntilMs;
  if (from !== undefined && nowMs < from)
    return { eligible: false, reason: "future" };
  if (until !== undefined && nowMs > until)
    return { eligible: false, reason: "expired" };
  switch (t.mode) {
    case "persistent":
    case "until-changed":
      return { eligible: true, activeNow: until !== undefined };
    case "window": {
      const soon = until !== undefined && until - nowMs <= 48 * 3_600_000;
      return {
        eligible: true,
        activeNow: true,
        label: soon ? "expires soon" : "active now",
      };
    }
    case "recurring": {
      const weekdays = t.recurrence?.weekdays ?? [];
      const today = weekdayInZone(
        nowMs,
        t.timezone ?? defaultTimezone ?? "UTC",
      );
      if (!weekdays.includes(today))
        return { eligible: false, reason: "off-recurrence" };
      return { eligible: true, activeNow: true, label: "recurring today" };
    }
  }
}

/* ------------------------------- selection ------------------------------- */

export interface SelectionInput {
  cards: MemoryCard[];
  context: MemoryScopeContext;
  prompt: string;
  nowMs: number;
  maxCards: number;
  maxRenderedChars: number;
  /** Prior effective session snapshot ids/revisions (for stickiness/hysteresis). */
  prior?: Array<{ id: string; revision: number }>;
  priorFingerprint?: string;
  /** When false, selection yields an empty set (loading disabled). */
  loadingEnabled?: boolean;
  /** Configured Memory timezone; recurring cards without their own tz use it. */
  timezone?: string;
}

export interface SelectionResult extends EffectiveMemorySnapshot {
  /** Whether the effective fingerprint changed vs the prior snapshot. */
  changed: boolean;
}

const RELEVANCE_ADMIT = 0.18;
const HYSTERESIS_MARGIN = 0.08;
const RELEVANCE_RETAIN = RELEVANCE_ADMIT - HYSTERESIS_MARGIN;

interface Scored {
  card: MemoryCard;
  reasonCode: MemorySelectionReasonCode;
  score: number;
  lex: number;
  temporalLabel?: string;
  isBaseline: boolean;
}

function categorize(
  card: MemoryCard,
  temporal: Extract<TemporalEligibility, { eligible: true }>,
): { reasonCode: MemorySelectionReasonCode; isBaseline: boolean } {
  if (card.pinned) return { reasonCode: "pinned", isBaseline: true };
  if (card.kind === "preference")
    return { reasonCode: "baseline-preference", isBaseline: true };
  if (card.kind === "constraint")
    return { reasonCode: "baseline-constraint", isBaseline: true };
  if (temporal.activeNow) {
    return {
      reasonCode:
        card.temporal.mode === "recurring"
          ? "recurring-active"
          : "active-temporal",
      isBaseline: true,
    };
  }
  return { reasonCode: "query-match", isBaseline: false };
}

function compositeScore(
  card: MemoryCard,
  reasonCode: MemorySelectionReasonCode,
  lex: number,
  temporal: Extract<TemporalEligibility, { eligible: true }>,
  nowMs: number,
): number {
  let score = 0;
  if (card.pinned) score += 1_000;
  // Scope specificity: a more constrained card that still matches is more relevant.
  score += ((card.scope.persona ? 1 : 0) + (card.scope.projectId ? 1 : 0)) * 5;
  score += Math.min(card.strength, 10) * 3;
  if (temporal.activeNow) score += 8;
  if (temporal.label === "expires soon") score += 4;
  // Mild freshness: confirmed within the last week.
  const ageDays = (nowMs - card.observedAtMs) / 86_400_000;
  if (ageDays <= 7) score += 2 * (1 - ageDays / 7);
  // Lexical relevance contributes ONLY to query cards. Baseline cards
  // (pinned/preference/constraint/active-temporal) must rank independently of the
  // prompt so an unchanged baseline never reorders and reinjects (sticky snapshot).
  if (reasonCode === "query-match") score += lex * 24;
  return score;
}

function renderLine(card: MemoryCard, temporalLabel?: string): string {
  const scopeBits: string[] = [];
  if (card.scope.persona) scopeBits.push(card.scope.persona);
  if (card.scope.projectId) scopeBits.push(card.scope.projectId);
  const scope = scopeBits.length ? ` (${scopeBits.join("/")})` : "";
  const label = temporalLabel ? ` [${temporalLabel}]` : "";
  return `- [${card.id}@${card.revision}] ${card.kind}${scope}: ${card.text}${label}`;
}

function reasonText(
  reasonCode: MemorySelectionReasonCode,
  temporalLabel?: string,
): string {
  const base: Record<MemorySelectionReasonCode, string> = {
    pinned: "pinned",
    "baseline-preference": "stable preference",
    "baseline-constraint": "active constraint",
    "active-temporal": "active now",
    "recurring-active": "recurring today",
    "query-match": "matches this request",
  };
  return temporalLabel && reasonCode !== "recurring-active"
    ? `${base[reasonCode]} (${temporalLabel})`
    : base[reasonCode];
}

function fingerprintOf(items: EffectiveMemoryItem[]): string {
  if (items.length === 0) return `${SELECTOR_VERSION}:empty`;
  const key = items.map((i) => `${i.id}@${i.revision}`).join(",");
  return `${SELECTOR_VERSION}:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/**
 * Select the effective memory set for a turn. Deterministic for fixed inputs +
 * prior snapshot + clock. Fails CLOSED on individual invalid cards (skips them)
 * but the overall call never throws — a selection error yields an empty set so
 * the turn is never blocked (the caller falls open).
 */
export function selectMemory(input: SelectionInput): SelectionResult {
  // Prior identity is id@revision: a REVISED query card is not the same sticky
  // prior (it must re-clear the admission threshold + margin, not the lower retain).
  const priorKeys = new Set(
    (input.prior ?? []).map((p) => `${p.id}@${p.revision}`),
  );
  const inPrior = (card: MemoryCard): boolean =>
    priorKeys.has(`${card.id}@${card.revision}`);
  const empty = (): SelectionResult => {
    const items: EffectiveMemoryItem[] = [];
    const fingerprint = fingerprintOf(items);
    return {
      items,
      fingerprint,
      renderedText: "",
      renderedChars: 0,
      changed:
        input.priorFingerprint !== undefined &&
        input.priorFingerprint !== fingerprint,
    };
  };

  if (input.loadingEnabled === false) return empty();

  const promptTokens = tokenize(input.prompt ?? "");

  // Pass 1: gather eligible candidates with their lexical relevance + category.
  interface Candidate {
    card: MemoryCard;
    reasonCode: MemorySelectionReasonCode;
    isBaseline: boolean;
    lex: number;
    temporal: Extract<TemporalEligibility, { eligible: true }>;
  }
  const candidates: Candidate[] = [];
  for (const card of input.cards) {
    try {
      if (card.state !== ("active" satisfies MemoryLifecycleState)) continue;
      if (!scopeMatches(card.scope, input.context)) continue;
      const temporal = temporalEligibility(card, input.nowMs, input.timezone);
      if (!temporal.eligible) continue;
      const { reasonCode, isBaseline } = categorize(card, temporal);
      candidates.push({
        card,
        reasonCode,
        isBaseline,
        lex: lexicalScore(promptTokens, card.text),
        temporal,
      });
    } catch {
      // Skip an individual malformed card; never fail the whole selection.
    }
  }

  // Replacement hysteresis: a NEW query candidate is admitted only if it clears
  // the admission threshold AND exceeds the weakest CURRENT (prior) query card by
  // a margin; a prior query card stays while it clears the lower retain threshold.
  // This preserves the prior set/order unless a new candidate is clearly stronger.
  let weakestPriorQueryLex = Infinity;
  let hasPriorQuery = false;
  for (const c of candidates) {
    if (!c.isBaseline && inPrior(c.card) && c.lex >= RELEVANCE_RETAIN) {
      hasPriorQuery = true;
      weakestPriorQueryLex = Math.min(weakestPriorQueryLex, c.lex);
    }
  }

  const scored: Scored[] = [];
  for (const c of candidates) {
    if (!c.isBaseline) {
      if (inPrior(c.card)) {
        if (c.lex < RELEVANCE_RETAIN) continue; // sticky retain
      } else {
        if (c.lex < RELEVANCE_ADMIT) continue; // admission threshold
        if (hasPriorQuery && c.lex < weakestPriorQueryLex + HYSTERESIS_MARGIN)
          continue; // margin over weakest current query card
      }
    }
    scored.push({
      card: c.card,
      reasonCode: c.reasonCode,
      lex: c.lex,
      ...(c.temporal.label !== undefined
        ? { temporalLabel: c.temporal.label }
        : {}),
      isBaseline: c.isBaseline,
      score: compositeScore(
        c.card,
        c.reasonCode,
        c.lex,
        c.temporal,
        input.nowMs,
      ),
    });
  }

  // Deterministic order: score desc, then id asc.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0),
  );

  // Category reservation: guarantee the top card of each present category before
  // filling remaining slots by rank, so one category cannot crowd out the others.
  const chosen: Scored[] = [];
  const usedIds = new Set<string>();
  let chars = 0;
  const budgetFits = (s: Scored): boolean => {
    if (chosen.length >= input.maxCards) return false;
    const line = renderLine(s.card, s.temporalLabel);
    const add = (chosen.length === 0 ? 0 : 1) + line.length; // newline join between cards
    return chars + add <= input.maxRenderedChars;
  };
  const take = (s: Scored): void => {
    const line = renderLine(s.card, s.temporalLabel);
    chars += (chosen.length === 0 ? 0 : 1) + line.length;
    chosen.push(s);
    usedIds.add(s.card.id);
  };

  const categoryOrder: MemorySelectionReasonCode[] = [
    "pinned",
    "baseline-constraint",
    "baseline-preference",
    "active-temporal",
    "recurring-active",
    "query-match",
  ];
  for (const cat of categoryOrder) {
    const top = scored.find(
      (s) => s.reasonCode === cat && !usedIds.has(s.card.id),
    );
    if (top && budgetFits(top)) take(top);
  }
  for (const s of scored) {
    if (usedIds.has(s.card.id)) continue;
    if (budgetFits(s)) take(s);
  }

  // Output ordered by rank (score desc), 1-based.
  chosen.sort(
    (a, b) =>
      b.score - a.score ||
      (a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0),
  );
  const items: EffectiveMemoryItem[] = chosen.map((s, i) => ({
    id: s.card.id,
    revision: s.card.revision,
    kind: s.card.kind,
    scope: s.card.scope,
    text: s.card.text,
    rank: i + 1,
    reasonCode: s.reasonCode,
    reason: reasonText(s.reasonCode, s.temporalLabel),
    ...(s.temporalLabel ? { temporalLabel: s.temporalLabel } : {}),
    renderedChars: renderLine(s.card, s.temporalLabel).length,
    provenance: s.card.provenance,
  }));

  const renderedText = chosen
    .map((s) => renderLine(s.card, s.temporalLabel))
    .join("\n");
  const fingerprint = fingerprintOf(items);
  return {
    items,
    fingerprint,
    renderedText,
    renderedChars: renderedText.length,
    changed:
      input.priorFingerprint !== undefined &&
      input.priorFingerprint !== fingerprint,
  };
}

/* -------------------------------- search --------------------------------- */

export interface MemorySearchFilters {
  /** Restrict to cards matching this scope context (intersection). Omit for no scope filter. */
  context?: MemoryScopeContext;
  states?: MemoryLifecycleState[];
  kinds?: MemoryCard["kind"][];
  /** Only cards temporally eligible at this time (future/expired/off-recurrence excluded). */
  nowMs?: number;
  /** Configured Memory timezone; recurring cards without their own tz use it. */
  timezone?: string;
  limit?: number;
}

export interface MemorySearchHit {
  id: string;
  revision: number;
  kind: MemoryCard["kind"];
  text: string;
  scope: MemoryCard["scope"];
  score: number;
}

/**
 * Bounded lexical/metadata search over the same eligibility + scoring as
 * selection. The escape hatch for below-threshold / targeted recall; returns
 * compact scored hits with id + current revision so a caller can act on them.
 */
export function searchMemory(
  query: string,
  cards: MemoryCard[],
  filters: MemorySearchFilters = {},
): MemorySearchHit[] {
  const states =
    filters.states ?? (["active"] satisfies MemoryLifecycleState[]);
  const promptTokens = tokenize(query);
  const hits: MemorySearchHit[] = [];
  for (const card of cards) {
    if (!states.includes(card.state)) continue;
    if (filters.kinds && !filters.kinds.includes(card.kind)) continue;
    if (filters.context && !scopeMatches(card.scope, filters.context)) continue;
    if (
      filters.nowMs !== undefined &&
      !temporalEligibility(card, filters.nowMs, filters.timezone).eligible
    )
      continue;
    const lex = lexicalScore(promptTokens, card.text);
    // With an empty query, return by scope/recency (score 0 baseline); with a
    // query, require some overlap.
    if (promptTokens.size > 0 && lex === 0) continue;
    const score =
      lex * 20 + Math.min(card.strength, 10) + (card.pinned ? 5 : 0);
    hits.push({
      id: card.id,
      revision: card.revision,
      kind: card.kind,
      text: card.text,
      scope: card.scope,
      score,
    });
  }
  hits.sort(
    (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return hits.slice(0, Math.max(1, Math.min(filters.limit ?? 10, 50)));
}
