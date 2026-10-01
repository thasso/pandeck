import type {
  DaySourceDelta,
  DaySourceFact,
  DaySourceKey,
  DaySourceSnapshot,
} from "./types.ts";

/**
 * Change detection runs over this comparable projection: stable identity plus
 * non-volatile content. `observedAt` (and anything a collector keeps out of
 * `data`) never causes a phantom `changed`.
 */
function comparableProjection(fact: DaySourceFact): string {
  return JSON.stringify({
    id: fact.id,
    kind: fact.kind,
    occurredAt: fact.occurredAt ?? null,
    actor: fact.actor ?? null,
    title: fact.title ?? null,
    links: fact.links ?? [],
    data: fact.data ?? {},
    tags: fact.tags ?? [],
  });
}

/**
 * Delta contract (plan § Source disposition and result states):
 * - positive deltas (`added`/`changed`) compare against the PREVIOUS snapshot
 *   (any result state) — a partial run still yields observed positives;
 * - `noLongerObserved` compares against the last COMPLETE baseline and only
 *   when the CURRENT run is itself complete; otherwise negatives are
 *   suppressed (`suppressedNegative`);
 * - `confirmedDeleted` carries only collector-affirmed deletions.
 * `failed` runs never reach this function — the orchestrator retains prior
 * state and produces no delta for them.
 */
export function computeDelta(opts: {
  source: DaySourceKey;
  current: { result: "complete" | "partial"; facts: DaySourceFact[] };
  previous: DaySourceSnapshot | null;
  /** Last complete snapshot for this source (negative-comparison baseline). */
  baseline: DaySourceSnapshot | null;
  confirmedDeletedIds?: string[];
}): DaySourceDelta {
  const prevById = new Map(
    (opts.previous?.facts ?? []).map((f) => [f.id, comparableProjection(f)]),
  );
  const currentIds = new Set(opts.current.facts.map((f) => f.id));

  const added: string[] = [];
  const changed: string[] = [];
  for (const fact of opts.current.facts) {
    const prev = prevById.get(fact.id);
    if (prev === undefined) added.push(fact.id);
    else if (prev !== comparableProjection(fact)) changed.push(fact.id);
  }

  const confirmedDeleted = [...new Set(opts.confirmedDeletedIds ?? [])];
  const confirmedSet = new Set(confirmedDeleted);

  const canConcludeAbsence =
    opts.current.result === "complete" && opts.baseline !== null;
  const noLongerObserved: string[] = [];
  if (canConcludeAbsence && opts.baseline) {
    for (const fact of opts.baseline.facts) {
      if (!currentIds.has(fact.id) && !confirmedSet.has(fact.id))
        noLongerObserved.push(fact.id);
    }
  }

  return {
    source: opts.source,
    baselineRunId: opts.baseline?.runId ?? null,
    added,
    changed,
    noLongerObserved,
    confirmedDeleted,
    suppressedNegative: !canConcludeAbsence,
  };
}
