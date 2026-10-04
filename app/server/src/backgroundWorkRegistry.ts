import type {
  BackgroundWorkItemSummary,
  StateDigestEntry,
  StateEvent,
} from "@assistant/shared";
import {
  backgroundWorkStore,
  type BackgroundWorkItem,
} from "./db/backgroundWorkStore.ts";

/**
 * The sole narrowing boundary between durable background-work rows and the
 * wire. Everything a provider or the OS handed us — vendor task ids, process
 * ids and groups, paths, environment and output bodies — stops here: the
 * summary carries PA identity, the bounded command and title, bounded state and
 * evidence FACTS only, and a consumer addresses work by `id` alone. Revisions
 * stay in event sidecars.
 */
export function backgroundWorkItemSummaryOf(
  item: BackgroundWorkItem,
): BackgroundWorkItemSummary {
  const host = item.hostId
    ? backgroundWorkStore.getHost(item.hostId)
    : undefined;
  return {
    id: item.id,
    ownerSessionId: item.ownerSessionId,
    backend: item.backend,
    kind: item.kind,
    label: item.label,
    ...(item.description ? { description: item.description } : {}),
    ...(item.command ? { command: item.command } : {}),
    ...(item.commandTruncated ? { commandTruncated: true } : {}),
    state: item.state,
    ...(item.intent === "service" ? { intent: "service" as const } : {}),
    stopState: item.stopState,
    ...(item.stopReason ? { stopReason: item.stopReason } : {}),
    ...(item.stopAttempts > 0 ? { stopAttempts: item.stopAttempts } : {}),
    ...(host
      ? {
          host: {
            id: host.id,
            state: host.state,
            ...(host.stopAllRequestedAt !== undefined
              ? { stopAllRequestedAt: host.stopAllRequestedAt }
              : {}),
          },
        }
      : {}),
    ...(item.providerTaskId ? { providerBound: true } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
    ...(item.terminalAt !== undefined ? { terminalAt: item.terminalAt } : {}),
    deadlineAt: item.deadlineAt,
    settingsGeneration: item.settingsGeneration,
    ...(item.terminalReason ? { terminalReason: item.terminalReason } : {}),
    ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
    ...(item.outcomeSummary ? { outcomeSummary: item.outcomeSummary } : {}),
    ...(item.evidence ? { evidence: item.evidence } : {}),
  };
}

/**
 * `{id → revision, live}` for exactly these ids. Callers pass the ids a write
 * reported: reading the whole table here made every broadcast flush cost a scan
 * of all background history ever recorded.
 */
export function backgroundWorkRevisionIndex(
  ids: Iterable<string>,
): Map<string, { revision: number; live: boolean }> {
  return new Map(
    backgroundWorkStore
      .itemRevisions(ids)
      .map((row) => [row.id, { revision: row.revision, live: row.member }]),
  );
}

/**
 * How many rows one subscribe/resync answer may carry. Background work retains
 * terminal history deliberately — a finished row stays addressable until its
 * owning session is deleted — so the member set only GROWS, and an unbounded
 * snapshot would ship the whole of it to every subscriber on every subscribe
 * ([Task-656](pa://task/656)). Matching the store's own list ceiling keeps this
 * one read with no paging loop, and makes the payload's size a constant of the
 * code rather than of how long this install has been running.
 */
export const BACKGROUND_WORK_SNAPSHOT_MAX = 200;

export interface BackgroundWorkSnapshot {
  items: BackgroundWorkItemSummary[];
  /** Revision sidecar for exactly the rows above — never for rows left out. */
  revisions: StateDigestEntry[];
  /** Older member rows exist beyond the window; the surface must say so. */
  truncated: boolean;
}

/**
 * The bounded `background` subscribe/resync answer: ACTIVE work first, then the
 * newest history, capped at {@link BACKGROUND_WORK_SNAPSHOT_MAX}. The order is
 * the store's, so what a cap drops is always the oldest finished work and never
 * something still running.
 *
 * A row outside the window is not lost to a subscriber: it is unchanged by
 * definition of being old, and the moment it changes the registry's ordinary
 * `stateEvents` upsert carries it (`docs/state-sync.md`). What the window does
 * NOT do is reconstruct arbitrarily old history for a surface that wants it —
 * the inspector's per-session list and a `?task=` deep link both read this same
 * snapshot, so work older than the window is absent until a scoped or cursored
 * read exists. `truncated` is how the surface admits that instead of presenting
 * a partial list as the whole registry.
 */
export function backgroundWorkSnapshot(
  limit: number = BACKGROUND_WORK_SNAPSHOT_MAX,
): BackgroundWorkSnapshot {
  // Each revision is read from the same row as its summary, so the sidecar can
  // never stamp a row with another write's revision.
  const window = backgroundWorkStore.listRegistryWindow(limit);
  return {
    items: window.items.map(backgroundWorkItemSummaryOf),
    revisions: window.items.map((item) => ({
      id: item.id,
      revision: item.revision,
    })),
    truncated: window.truncated,
  };
}

export function backgroundWorkStateItems(
  ids: readonly string[],
  index: Map<
    string,
    { revision: number; live: boolean }
  > = backgroundWorkRevisionIndex(ids),
): StateEvent<BackgroundWorkItemSummary>[] {
  const events: StateEvent<BackgroundWorkItemSummary>[] = [];
  for (const id of new Set(ids)) {
    const entry = index.get(id);
    if (!entry) continue;
    if (!entry.live) {
      events.push({ kind: "delete", id, revision: entry.revision });
      continue;
    }
    const item = backgroundWorkStore.getItem(id);
    if (item)
      events.push({
        kind: "upsert",
        id,
        revision: entry.revision,
        item: backgroundWorkItemSummaryOf(item),
      });
  }
  return events;
}
