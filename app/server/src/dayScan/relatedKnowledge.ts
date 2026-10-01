import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import { searchKnowledge, type KbSearchHit } from "../knowledgeBaseIndex.ts";

/**
 * Cross-reference the day's activity against EXISTING durable knowledge (plan
 * Task 153): search the KB for entries related to the day's meetings, action
 * candidates, active projects, and issue keys, so synthesis can notice "this
 * continues existing work" and link it — instead of describing already-started
 * work as if it were new. Day-scan-owned entries (daily summaries, per-meeting
 * curation, the threads/tempo-profile artifacts) are excluded so the day never
 * cross-references itself.
 */

export interface RelatedEntry {
  entryId: string;
  title: string;
  snippet: string;
}

const GENERIC_TERMS = new Set([
  "unmapped",
  "meeting",
  "meetings",
  "notes",
  "sync",
  "weekly",
  "daily",
  "standup",
  "review",
  "1:1",
  "out of office",
]);

/** A day-scan-owned entry we must not surface as "related existing work". */
function isDayScanOwnedEntry(hit: KbSearchHit): boolean {
  return (
    hit.type === "daily-summary" ||
    hit.id.startsWith("daily-summary-") ||
    hit.id.startsWith("meeting-") ||
    hit.id === "ongoing-threads" ||
    hit.id === "tempo-logging-profile"
  );
}

function normalizeTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (term.length < 4) continue;
    const key = term.toLowerCase();
    if (GENERIC_TERMS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * Find durable KB entries related to the day. Runs one bounded search per
 * salient term, aggregates by entry id (best score wins), excludes day-scan
 * artifacts, and returns the top `limit` (default 6).
 */
export async function findRelatedKnowledge(
  store: KnowledgeBaseStore,
  input: { terms: string[]; limit?: number },
): Promise<RelatedEntry[]> {
  const terms = normalizeTerms(input.terms);
  if (terms.length === 0) return [];
  const byId = new Map<string, { hit: KbSearchHit; score: number }>();
  for (const term of terms) {
    let hits: KbSearchHit[] = [];
    try {
      hits = await searchKnowledge(store, term, {
        limit: 3,
        statuses: ["active"],
      });
    } catch {
      continue;
    }
    for (const hit of hits) {
      if (isDayScanOwnedEntry(hit)) continue;
      const prior = byId.get(hit.id);
      if (!prior || hit.score > prior.score)
        byId.set(hit.id, { hit, score: hit.score });
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 6)
    .map(({ hit }) => ({
      entryId: hit.id,
      title: hit.title,
      snippet: (hit.summary ?? hit.snippet ?? "").slice(0, 160),
    }));
}
