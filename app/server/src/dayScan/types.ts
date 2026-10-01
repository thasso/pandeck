import type { DayScanIdentities } from "@assistant/shared";
import type { DayWindow } from "./dayWindow.ts";
import type { DayScanCache } from "./cache.ts";

/** Bump when the snapshot/manifest shapes change incompatibly; old snapshots stop being delta baselines. */
export const DAY_SCAN_SCHEMA_VERSION = 1;

/** KB actor name on every collection commit; the PA collector excludes these (self-exclusion). */
export const DAY_SCAN_ACTOR_NAME = "day-scan";
/** KB actor name on synthesis-apply commits; equally excluded from PA collection. */
export const DAY_SYNTHESIS_ACTOR_NAME = "day-synthesis";

export type DaySourceKey =
  | "calendar"
  | "meet-attendance"
  | "jira"
  | "jira-sprints"
  | "github-events"
  | "github-notifications"
  | "github-releases"
  | "slack"
  | "slack-huddles"
  | "email"
  | "tempo"
  | "pa";

type DaySourceDisposition = "attempted" | "skipped";
type DaySkipReason =
  "disabled" | "unconfigured" | "intentionally-skipped" | "deferred";
/**
 * Result of an attempted source. `complete` supports absence conclusions and
 * becomes the negative-comparison baseline; `partial` retains observed facts
 * but suppresses negatives; `failed` retains prior state and produces no deltas.
 */
type DaySourceResult = "complete" | "partial" | "failed";

/**
 * One normalized layer-1 item. `data` holds compact source-native,
 * non-volatile fields only (post privacy filter — no raw payloads, no
 * participant lists, no verbose bodies). `observedAt` is volatile and excluded
 * from change detection.
 */
export interface DaySourceFact {
  id: string;
  /** Source-native item kind, e.g. "issue-activity", "issue-transition", "event", "worklog". */
  kind: string;
  occurredAt?: string | null;
  observedAt: string;
  actor?: string | null;
  title?: string;
  links?: string[];
  data?: Record<string, unknown>;
  /** Semantics tags the digest carries, e.g. "activity" | "transition" | "own". */
  tags?: string[];
}

/** The committed per-source snapshot asset (`assets/sources/<key>.json`). */
export interface DaySourceSnapshot {
  schemaVersion: number;
  source: DaySourceKey;
  date: string;
  runId: string;
  collectedAt: string;
  result: DaySourceResult;
  /** Per-source completeness detail (e.g. Jira's three levels, GitHub coverage flags). */
  completeness?: Record<string, string | number | boolean>;
  notes?: string[];
  facts: DaySourceFact[];
}

/** Positive-deletion evidence ids a collector may report (never inferred from absence). */
export interface CollectorOutput {
  result: DaySourceResult;
  facts: DaySourceFact[];
  completeness?: Record<string, string | number | boolean>;
  notes?: string[];
  /** Union facts with the prior snapshot by id (GitHub events: merge, not replace). */
  accumulate?: boolean;
  /** Ids whose deletion the source positively affirmed (tombstone/cancelled status). */
  confirmedDeletedIds?: string[];
}

export interface DayCollectContext {
  date: string;
  window: DayWindow;
  runId: string;
  identities: DayScanIdentities;
  /** The previous snapshot for this source (any result state), if one exists. */
  prior: DaySourceSnapshot | null;
  cache: DayScanCache;
  signal?: AbortSignal;
}

export interface DaySourceCollector {
  key: DaySourceKey;
  label: string;
  /** False → the source is skipped with the given reason instead of attempted. */
  readiness():
    { ready: true } | { ready: false; reason: DaySkipReason; detail?: string };
  collect(ctx: DayCollectContext): Promise<CollectorOutput>;
}

/** Delta classes per the plan's contract; absence is never narrated as removal. */
export interface DaySourceDelta {
  source: DaySourceKey;
  /** Run id of the negative-comparison baseline (last complete snapshot), if any. */
  baselineRunId: string | null;
  added: string[];
  changed: string[];
  /** Absent from a complete listing vs. a complete baseline — still not "removed". */
  noLongerObserved: string[];
  /** Positive deletion evidence only. */
  confirmedDeleted: string[];
  /** True when negatives were suppressed (partial run or no complete baseline). */
  suppressedNegative: boolean;
}

export interface DayManifestSource {
  key: DaySourceKey;
  label: string;
  disposition: DaySourceDisposition;
  skipReason?: DaySkipReason;
  skipDetail?: string;
  result?: DaySourceResult;
  factCount?: number;
  added?: number;
  changed?: number;
  noLongerObserved?: number;
  error?: string;
  completeness?: Record<string, string | number | boolean>;
}

/** The committed per-day run manifest asset (`assets/manifest.json`). */
export interface DayRunManifest {
  schemaVersion: number;
  runId: string;
  date: string;
  window: { startIso: string; endIso: string; timeZone: string };
  asOf: string;
  /** Version hash of the project-mapping inputs the run classified with. */
  mappingVersion?: string;
  sources: DayManifestSource[];
  /** Total added+changed across sources (changes-since-last-scan badge). */
  changesSinceLastRun: number;
  /** Metered minutes-curation substage summary (absent when no docs were discovered). */
  minutes?: DayMinutesSummary;
}

/** Counts for the metered minutes-curation substage of a run. */
interface DayMinutesSummary {
  discovered: number;
  processed: number;
  /** Skipped via a composite-cache-key hit (unchanged content + versions). */
  cached: number;
  /** Deferred past `maxMinutesDocsPerRun`; a later run resumes without reprocessing. */
  deferred: number;
  failed: number;
  tasksCreated: number;
}

export interface DayCollectionRunResult {
  runId: string;
  date: string;
  manifest: DayRunManifest;
  deltas: DaySourceDelta[];
  /** Layer 2–4 project rollup committed as `assets/rollup.json`. */
  rollup: import("./salience.ts").DayRollup;
  /** KB commit hash of the atomic run commit, or null when nothing changed. */
  commit: string | null;
  /** True when this call coalesced into an already-running collection. */
  coalesced?: boolean;
}
