import { randomUUID } from "node:crypto";
import { getSettings } from "../settings.ts";
import {
  KnowledgeBaseStore,
  type KbFileChange,
} from "../knowledgeBaseStore.ts";
import { dailySummaryEntryId, dailySummaryEntryPath } from "./dayState.ts";
import { localDayWindow } from "./dayWindow.ts";
import { DayScanCache } from "./cache.ts";
import { computeDelta } from "./deltas.ts";
import { correlateFacts } from "./correlate.ts";
import { buildMappingIndex, classifyFact } from "./classify.ts";
import { buildRollup, type DayRollup } from "./salience.ts";
import {
  applyMachineRegion,
  renderMachineAppendix,
  skeletonEntry,
} from "./appendix.ts";
import {
  curateMinutes,
  resolveMinutesPipeline,
  type MinutesPipeline,
} from "./minutesRun.ts";
import { deriveAndPersistTempoProposals } from "./tempoDerive.ts";
import { calendarCollector } from "./collectors/calendar.ts";
import { meetAttendanceCollector } from "./collectors/meetAttendance.ts";
import { jiraCollector } from "./collectors/jira.ts";
import { jiraSprintsCollector } from "./collectors/jiraSprints.ts";
import { githubEventsCollector } from "./collectors/githubEvents.ts";
import { githubNotificationsCollector } from "./collectors/githubNotifications.ts";
import { githubReleasesCollector } from "./collectors/githubReleases.ts";
import { slackCollector } from "./collectors/slack.ts";
import { slackHuddlesCollector } from "./collectors/slackHuddles.ts";
import { emailCollector } from "./collectors/email.ts";
import { tempoCollector } from "./collectors/tempo.ts";
import { createPaCollector } from "./collectors/pa.ts";
import {
  DAY_SCAN_ACTOR_NAME,
  DAY_SCAN_SCHEMA_VERSION,
  type DayCollectionRunResult,
  type DayManifestSource,
  type DayRunManifest,
  type DaySourceCollector,
  type DaySourceDelta,
  type DaySourceFact,
  type DaySourceSnapshot,
} from "./types.ts";

/** Coarse progress events for the live day-scan workflow widget (Task 162). */
type DayCollectionProgress =
  | { kind: "collect"; done: number; total: number }
  | {
      kind: "minutes";
      state: "start" | "done";
      discovered?: number;
      processed?: number;
    }
  | { kind: "commit" };

export interface RunDayCollectionOptions {
  store?: KnowledgeBaseStore;
  collectors?: DaySourceCollector[];
  cache?: DayScanCache;
  signal?: AbortSignal;
  /** Metered minutes-curation substage; omitted/null skips minutes entirely. */
  minutes?: MinutesPipeline | null;
  /** Optional live-progress callback (best-effort; never affects the run). */
  onProgress?: (event: DayCollectionProgress) => void;
}

function defaultCollectors(): DaySourceCollector[] {
  return [
    calendarCollector,
    meetAttendanceCollector,
    jiraCollector,
    jiraSprintsCollector,
    githubEventsCollector,
    githubNotificationsCollector,
    githubReleasesCollector,
    slackCollector,
    slackHuddlesCollector,
    emailCollector,
    tempoCollector,
    createPaCollector(),
  ];
}

/* ------------------------- per-day lock/coalescing ------------------------ */

interface ActiveRun {
  promise: Promise<DayCollectionRunResult>;
  /** One pending follow-up at most; further requests coalesce into it. */
  followUp: Promise<DayCollectionRunResult> | null;
}

const activeRuns = new Map<string, ActiveRun>();
let shuttingDown = false;

/** Graceful shutdown: no NEW collection runs start; in-flight runs finish their atomic commit. */
export function stopDayCollection(): void {
  shuttingDown = true;
}

/** Test seam. */
export function resetDayCollectionForTests(): void {
  shuttingDown = false;
  activeRuns.clear();
}

/**
 * One collection run per day at a time. A request during an active run
 * coalesces into at most ONE pending follow-up run (so a refresh clicked
 * mid-run still observes post-run state without queueing unbounded work).
 */
export async function runDayCollection(
  date: string,
  opts: RunDayCollectionOptions = {},
): Promise<DayCollectionRunResult> {
  if (shuttingDown)
    throw new Error(
      "The server is shutting down; no new day-scan runs are started.",
    );
  const active = activeRuns.get(date);
  if (active) {
    if (!active.followUp) {
      active.followUp = active.promise
        .catch(() => undefined)
        .then(() => {
          const next = executeRun(date, opts).finally(() => {
            const current = activeRuns.get(date);
            if (current?.promise === next) activeRuns.delete(date);
          });
          activeRuns.set(date, { promise: next, followUp: null });
          return next;
        });
    }
    const result = await active.followUp;
    return { ...result, coalesced: true };
  }
  const run = executeRun(date, opts).finally(() => {
    const current = activeRuns.get(date);
    if (current?.promise === run && !current.followUp) activeRuns.delete(date);
  });
  activeRuns.set(date, { promise: run, followUp: null });
  return run;
}

/* --------------------------------- the run -------------------------------- */

function snapshotPath(date: string, key: string): string {
  return `${dailySummaryEntryPath(date)}/assets/sources/${key}.json`;
}

function baselinePath(date: string, key: string): string {
  return `${dailySummaryEntryPath(date)}/assets/sources/${key}.baseline.json`;
}

function manifestPath(date: string): string {
  return `${dailySummaryEntryPath(date)}/assets/manifest.json`;
}

function deltasPath(date: string): string {
  return `${dailySummaryEntryPath(date)}/assets/deltas.json`;
}

async function readJsonIfPresent<T>(
  store: KnowledgeBaseStore,
  path: string,
): Promise<T | null> {
  try {
    return JSON.parse(await store.readEntryFile(path)) as T;
  } catch {
    return null;
  }
}

/** A prior snapshot is only usable when schema-compatible. */
function compatible(
  snapshot: DaySourceSnapshot | null,
): DaySourceSnapshot | null {
  return snapshot && snapshot.schemaVersion === DAY_SCAN_SCHEMA_VERSION
    ? snapshot
    : null;
}

async function executeRun(
  date: string,
  opts: RunDayCollectionOptions,
): Promise<DayCollectionRunResult> {
  const window = localDayWindow(date);
  const runId = `${date}-${randomUUID().slice(0, 8)}`;
  const store = opts.store ?? new KnowledgeBaseStore();
  const cache = opts.cache ?? new DayScanCache();
  cache.cleanup();
  const identities = getSettings().dayScan.identities;
  const collectors = opts.collectors ?? defaultCollectors();

  const changes: KbFileChange[] = [];
  const manifestSources: DayManifestSource[] = [];
  const deltas: DaySourceDelta[] = [];
  /** Facts feeding correlation/classification: fresh when collected, last-good otherwise. */
  const factSets: Array<{
    source: DaySourceCollector["key"];
    facts: DaySourceFact[];
  }> = [];

  // Sources run independently: one failing never blocks the others. Each
  // settled source bumps the live-progress counter (best-effort).
  const totalSources = collectors.length;
  let settledSources = 0;
  const bumpCollect = () =>
    opts.onProgress?.({
      kind: "collect",
      done: ++settledSources,
      total: totalSources,
    });
  opts.onProgress?.({ kind: "collect", done: 0, total: totalSources });
  await Promise.all(
    collectors.map(async (collector) => {
      const readiness = collector.readiness();
      if (!readiness.ready) {
        const prior = compatible(
          await readJsonIfPresent<DaySourceSnapshot>(
            store,
            snapshotPath(date, collector.key),
          ),
        );
        if (prior) factSets.push({ source: collector.key, facts: prior.facts });
        manifestSources.push({
          key: collector.key,
          label: collector.label,
          disposition: "skipped",
          skipReason: readiness.reason,
          ...(readiness.detail ? { skipDetail: readiness.detail } : {}),
        });
        bumpCollect();
        return;
      }
      const prior = compatible(
        await readJsonIfPresent<DaySourceSnapshot>(
          store,
          snapshotPath(date, collector.key),
        ),
      );
      const baseline = compatible(
        await readJsonIfPresent<DaySourceSnapshot>(
          store,
          baselinePath(date, collector.key),
        ),
      );
      try {
        const output = await collector.collect({
          date,
          window,
          runId,
          identities,
          prior,
          cache,
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        });
        // Accumulating sources (GitHub events) merge by id: add-only union.
        const facts: DaySourceFact[] =
          output.accumulate && prior
            ? unionById(prior.facts, output.facts)
            : output.facts;
        const snapshot: DaySourceSnapshot = {
          schemaVersion: DAY_SCAN_SCHEMA_VERSION,
          source: collector.key,
          date,
          runId,
          collectedAt: new Date().toISOString(),
          result: output.result,
          ...(output.completeness ? { completeness: output.completeness } : {}),
          ...(output.notes?.length ? { notes: output.notes } : {}),
          facts,
        };
        const delta = computeDelta({
          source: collector.key,
          current: {
            result: output.result === "failed" ? "partial" : output.result,
            facts,
          },
          previous: prior,
          baseline,
          ...(output.confirmedDeletedIds !== undefined
            ? { confirmedDeletedIds: output.confirmedDeletedIds }
            : {}),
        });
        deltas.push(delta);
        factSets.push({ source: collector.key, facts });
        changes.push({
          op: "write",
          path: snapshotPath(date, collector.key),
          content: JSON.stringify(snapshot, null, 2),
        });
        if (output.result === "complete") {
          changes.push({
            op: "write",
            path: baselinePath(date, collector.key),
            content: JSON.stringify(snapshot, null, 2),
          });
        }
        manifestSources.push({
          key: collector.key,
          label: collector.label,
          disposition: "attempted",
          result: output.result,
          factCount: facts.length,
          added: delta.added.length,
          changed: delta.changed.length,
          noLongerObserved: delta.noLongerObserved.length,
          ...(output.completeness ? { completeness: output.completeness } : {}),
        });
        bumpCollect();
      } catch (err) {
        // Failed source: prior snapshot stays untouched on disk (last-success
        // retention); no deltas are produced for it this run.
        if (prior) factSets.push({ source: collector.key, facts: prior.facts });
        manifestSources.push({
          key: collector.key,
          label: collector.label,
          disposition: "attempted",
          result: "failed",
          ...(prior ? { factCount: prior.facts.length } : {}),
          error: err instanceof Error ? err.message : String(err),
        });
        bumpCollect();
      }
    }),
  );

  manifestSources.sort((a, b) => a.key.localeCompare(b.key));
  deltas.sort((a, b) => a.source.localeCompare(b.source));
  const changesSinceLastRun = deltas.reduce(
    (sum, d) => sum + d.added.length + d.changed.length,
    0,
  );

  // Layers 2–4: correlation, project classification, salience → rollup.
  const mapping = await buildMappingIndex({ store });
  const correlated = correlateFacts(factSets, identities);
  const classified = correlated.map((item) => ({
    item,
    classification: classifyFact(item, mapping),
  }));
  const rollup: DayRollup = buildRollup({
    runId,
    date,
    schemaVersion: DAY_SCAN_SCHEMA_VERSION,
    mappingVersion: mapping.version,
    classified,
  });

  // Metered minutes-curation substage (plan § minutes): the one deliberate
  // model-token exception. Its meeting entries fold into THIS run's atomic
  // commit; the ledger index is finalized with the commit id afterwards.
  const daySettings = getSettings().dayScan;
  const pipeline =
    opts.minutes === undefined ? resolveMinutesPipeline() : opts.minutes;
  let minutesFinalize: ((commit: string | null) => void) | null = null;
  const extraEntryIds: string[] = [];
  let minutesSummary: DayRunManifest["minutes"];
  if (pipeline) {
    try {
      opts.onProgress?.({ kind: "minutes", state: "start" });
      const docs = await pipeline.discover(
        { date, window: { startIso: window.startIso, endIso: window.endIso } },
        opts.signal,
      );
      if (docs.length > 0) {
        const curated = await curateMinutes(docs, {
          store,
          extractor: pipeline.extractor,
          createTask: pipeline.createTask,
          mappingVersion: mapping.version,
          policy: daySettings.taskProposalPolicy,
          maxDocsPerRun: daySettings.maxMinutesDocsPerRun,
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        });
        changes.push(...curated.changes);
        extraEntryIds.push(...curated.entryIds);
        minutesFinalize = curated.finalize;
        minutesSummary = {
          discovered: docs.length,
          processed: curated.processed.length,
          cached: curated.cached.length,
          deferred: curated.deferred.length,
          failed: curated.failed.length,
          tasksCreated: curated.tasksCreated,
        };
      }
      opts.onProgress?.({
        kind: "minutes",
        state: "done",
        discovered: docs.length,
        ...(minutesSummary?.processed !== undefined
          ? { processed: minutesSummary?.processed }
          : {}),
      });
    } catch {
      // Minutes is a best-effort substage; a discovery/extraction failure never
      // blocks the deterministic collection commit.
      opts.onProgress?.({ kind: "minutes", state: "done" });
    }
  } else {
    opts.onProgress?.({ kind: "minutes", state: "done" });
  }

  const manifest: DayRunManifest = {
    schemaVersion: DAY_SCAN_SCHEMA_VERSION,
    runId,
    date,
    window: {
      startIso: window.startIso,
      endIso: window.endIso,
      timeZone: window.timeZone,
    },
    asOf: new Date().toISOString(),
    mappingVersion: mapping.version,
    sources: manifestSources,
    changesSinceLastRun,
    ...(minutesSummary ? { minutes: minutesSummary } : {}),
  };
  changes.push({
    op: "write",
    path: manifestPath(date),
    content: JSON.stringify(manifest, null, 2),
  });
  changes.push({
    op: "write",
    path: deltasPath(date),
    content: JSON.stringify(deltas, null, 2),
  });
  changes.push({
    op: "write",
    path: rollupPath(date),
    content: JSON.stringify(rollup, null, 2),
  });

  // Skeleton entry + machine appendix: the collection run owns the entry
  // skeleton and rewrites ONLY the marked data region; narrative sections and
  // the user-owned Notes region are never touched.
  const appendix = renderMachineAppendix(manifest, rollup, deltas);
  const entryPath = `${dailySummaryEntryPath(date)}/index.md`;
  const existingEntry = await readTextIfPresent(store, entryPath);
  changes.push({
    op: "write",
    path: entryPath,
    content:
      existingEntry === null
        ? skeletonEntry(date, appendix)
        : applyMachineRegion(existingEntry, appendix),
  });

  // ONE atomic commit per run; the actor name is the origin tag the PA
  // collector's self-exclusion keys on.
  const commit = await store.commitChanges(changes, {
    actor: { kind: "system", name: DAY_SCAN_ACTOR_NAME },
    reason: `day-scan collection ${runId}`,
    body: `Day-Scan-Run: ${runId}\nDay-Scan-Date: ${date}`,
    entryIds: [dailySummaryEntryId(date), ...extraEntryIds],
  });
  opts.onProgress?.({ kind: "commit" });
  // Stamp the durable commit id into the minutes ledger index AFTER the commit
  // lands (crash between here and the commit re-runs curation without dup Tasks).
  minutesFinalize?.(commit.commit);

  // Deterministic Tempo proposal derivation from the committed calendar facts +
  // the learned profile (model-free; best-effort — never blocks the run).
  try {
    const tempo = await deriveAndPersistTempoProposals(store, date);
    if (tempo.derived > 0 || tempo.alreadyLogged > 0) {
      console.log(
        `[day-scan] tempo ${date}: derived ${tempo.derived}, persisted ${tempo.persisted}, already-logged ${tempo.alreadyLogged}`,
      );
    }
  } catch (err) {
    console.warn(
      `[day-scan] tempo derivation failed (${date}):`,
      err instanceof Error ? err.message : String(err),
    );
  }

  return { runId, date, manifest, deltas, rollup, commit: commit.commit };
}

function rollupPath(date: string): string {
  return `${dailySummaryEntryPath(date)}/assets/rollup.json`;
}

async function readTextIfPresent(
  store: KnowledgeBaseStore,
  path: string,
): Promise<string | null> {
  try {
    return await store.readEntryFile(path);
  } catch {
    return null;
  }
}

function unionById(
  prior: DaySourceFact[],
  current: DaySourceFact[],
): DaySourceFact[] {
  const byId = new Map(prior.map((f) => [f.id, f]));
  for (const fact of current) byId.set(fact.id, fact);
  return [...byId.values()];
}
