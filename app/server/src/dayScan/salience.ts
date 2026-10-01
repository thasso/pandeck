import type { CorrelatedFact } from "./correlate.ts";
import { corroboratedIssueKeys } from "./correlate.ts";
import type { FactClassification } from "./classify.ts";
import type { DaySourceKey } from "./types.ts";

const MAX_ITEMS_PER_BUCKET = 12;

interface RollupItem {
  factId: string;
  source: DaySourceKey;
  kind: string;
  headline: string;
  links: string[];
  score: number;
  tags: string[];
  issueKeys: string[];
  own: boolean;
}

interface RollupBucket {
  key: string;
  projectId: string | null;
  label: string;
  unmapped: boolean;
  score: number;
  stats: {
    facts: number;
    transitions: number;
    own: number;
    suppressed: number;
  };
  /** Top items by salience, capped; the full facts stay in the source snapshots. */
  items: RollupItem[];
  secondary: string[];
}

/** Layer 2–4 output committed as `assets/rollup.json`. */
export interface DayRollup {
  schemaVersion: number;
  runId: string;
  date: string;
  mappingVersion: string;
  buckets: RollupBucket[];
  suppressed: { bots: number; routine: number };
}

const BOT_RE = /\[bot\]|(^|\W)(dependabot|renovate|github-actions)($|\W)/i;
/** Routine churn: branch lifecycle noise without review/decision content. */
const ROUTINE_GITHUB_KINDS = new Set([
  "create",
  "delete",
  "fork",
  "watch",
  "gollum",
]);

function isBot(item: CorrelatedFact): boolean {
  return Boolean(item.fact.actor && BOT_RE.test(item.fact.actor));
}

function isRoutine(item: CorrelatedFact): boolean {
  return (
    item.source === "github-events" && ROUTINE_GITHUB_KINDS.has(item.fact.kind)
  );
}

/**
 * Salience scoring (plan § layer 4): decisions/blockers/releases/reviews/user
 * involvement/corroboration up, bots and routine churn out. Deterministic —
 * same inputs, same rollup.
 */
function scoreFact(item: CorrelatedFact, corroborated: Set<string>): number {
  const tags = item.fact.tags ?? [];
  let score = 1;
  if (tags.includes("transition")) score += 3;
  if (tags.includes("review-requested")) score += 4;
  if (tags.includes("mention")) score += 2;
  if (tags.includes("saved")) score += 1;
  if (tags.includes("action-needed")) score += 3;
  if (tags.includes("follow-up")) score += 2;
  if (tags.includes("starred")) score += 1;
  // Own work outranks a lone inbound-attention signal (review-requested +4,
  // action-needed +3): what I did should not be buried under what landed in my
  // inbox, especially for the per-bucket top-items cut the digest surfaces.
  if (item.own) score += 5;
  if (item.fact.kind === "release") score += 3;
  if (item.fact.kind === "ci-failure") score += 4;
  if (item.fact.kind === "deployment") score += 3;
  if (item.fact.kind === "sprint") score += 2;
  if (tags.includes("overdue") || tags.includes("due-today")) score += 3;
  if (tags.includes("user-change")) score += 2;
  if (tags.includes("completed")) score += 2;
  if (tags.includes("unread")) score += 1;
  if (item.issueKeys.some((key) => corroborated.has(key))) score += 2;
  return score;
}

function headline(item: CorrelatedFact): string {
  const data = item.fact.data ?? {};
  if (item.fact.kind === "issue-transition") {
    return `${String(data.issueKey ?? "")} ${String(data.field ?? "status")}: ${String(data.from ?? "?")} → ${String(data.to ?? "?")}`.trim();
  }
  if (item.fact.title) return item.fact.title;
  return `${item.fact.kind}${item.repo ? ` in ${item.repo}` : ""}`;
}

export function buildRollup(opts: {
  runId: string;
  date: string;
  schemaVersion: number;
  mappingVersion: string;
  classified: Array<{
    item: CorrelatedFact;
    classification: FactClassification;
  }>;
}): DayRollup {
  const corroborated = corroboratedIssueKeys(
    opts.classified.map((c) => c.item),
  );
  const buckets = new Map<string, RollupBucket>();
  let bots = 0;
  let routine = 0;

  for (const { item, classification } of opts.classified) {
    if (isBot(item)) {
      bots += 1;
      continue;
    }
    const suppressedRoutine = isRoutine(item);
    if (suppressedRoutine) routine += 1;

    let bucket = buckets.get(classification.bucket);
    if (!bucket) {
      bucket = {
        key: classification.bucket,
        projectId: classification.projectId,
        label: classification.label,
        unmapped:
          classification.source === "unmapped" ||
          classification.source === "heuristic",
        score: 0,
        stats: { facts: 0, transitions: 0, own: 0, suppressed: 0 },
        items: [],
        secondary: classification.secondary,
      };
      buckets.set(classification.bucket, bucket);
    }
    bucket.stats.facts += 1;
    if ((item.fact.tags ?? []).includes("transition"))
      bucket.stats.transitions += 1;
    if (item.own) bucket.stats.own += 1;
    if (suppressedRoutine) {
      bucket.stats.suppressed += 1;
      continue;
    }
    const score = scoreFact(item, corroborated);
    bucket.score += score;
    bucket.items.push({
      factId: item.fact.id,
      source: item.source,
      kind: item.fact.kind,
      headline: headline(item),
      links: item.fact.links ?? [],
      score,
      tags: item.fact.tags ?? [],
      issueKeys: item.issueKeys,
      own: item.own,
    });
  }

  for (const bucket of buckets.values()) {
    bucket.items.sort(
      (a, b) => b.score - a.score || a.factId.localeCompare(b.factId),
    );
    bucket.items = bucket.items.slice(0, MAX_ITEMS_PER_BUCKET);
  }

  return {
    schemaVersion: opts.schemaVersion,
    runId: opts.runId,
    date: opts.date,
    mappingVersion: opts.mappingVersion,
    buckets: [...buckets.values()].sort(
      (a, b) => b.score - a.score || a.key.localeCompare(b.key),
    ),
    suppressed: { bots, routine },
  };
}
