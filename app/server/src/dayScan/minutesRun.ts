import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../config.ts";
import {
  KnowledgeBaseStore,
  type KbFileChange,
} from "../knowledgeBaseStore.ts";
import {
  applyMeetingRegion,
  buildCacheKey,
  cacheKeyMatches,
  MEETING_FULL_MINUTES_ASSET,
  meetingEntryId,
  meetingEntryPath,
  reconcileCandidates,
  renderMeetingEntry,
  shouldAutoCreateTask,
  type FreshCandidate,
  type MinutesCacheKey,
  type MinutesCandidate,
} from "./minutes.ts";

/** Fixed extraction concurrency (plan § bounded execution). */
const EXTRACTION_CONCURRENCY = 3;

/** One discovered minutes document, already anchored to its MEETING day. */
export interface MinutesDoc {
  /** Stable source id, e.g. `drive:<fileId>` or `gmail:<threadId>`. */
  sourceId: string;
  sourceLink: string;
  title: string;
  /** Meeting-day anchor (YYYY-MM-DD) — the calendar/Meet occurred day, not today. */
  meetingDate: string;
  /** Raw document text used for hashing and extraction. */
  content: string;
  /** True when observed on a later day than the meeting (late-arriving minutes). */
  observedLate: boolean;
}

/** The metered extraction seam (the sub-agent scanner in production; a fake in tests). */
export interface MinutesExtractor {
  extract(
    doc: MinutesDoc,
    signal?: AbortSignal,
  ): Promise<{ meetingSummary: string | null; actions: FreshCandidate[] }>;
}

export interface CurateMinutesDeps {
  store: KnowledgeBaseStore;
  extractor: MinutesExtractor;
  /** Creates a Task for an auto-create candidate; returns the new Task id. */
  createTask(input: {
    candidate: MinutesCandidate;
    doc: MinutesDoc;
  }): Promise<string>;
  mappingVersion: string;
  policy: "auto" | "review";
  maxDocsPerRun: number;
  /** Force-recuration: ignore composite-cache-key hits (per document or day). */
  force?: boolean;
  signal?: AbortSignal;
}

export interface CurateMinutesResult {
  /** KB writes to fold into the run's ONE atomic commit (meeting entries + candidate assets). */
  changes: KbFileChange[];
  /** Meeting entry ids touched, for the commit's invalidation broadcast. */
  entryIds: string[];
  processed: string[];
  deferred: string[];
  cached: string[];
  failed: string[];
  tasksCreated: number;
  /** Called after the atomic commit lands, recording its id in the ledger index. */
  finalize(commit: string | null): void;
}

/* -------------------------- ledger index (non-Git) ------------------------- */

/**
 * The minutes ledger is a fast INDEX; committed KB state is the source of
 * truth. It records the composite cache key, the entry ref, the
 * candidate→Task mapping (for crash-safe Task dedup), and the KB commit id.
 * A record only counts as a cache HIT when its cache key matches, its commit is
 * durable (non-null), and its committed entry still exists.
 */
export interface MinutesIndexRecord {
  sourceId: string;
  entryPath: string;
  entryId: string;
  cacheKey: MinutesCacheKey;
  candidateIds: string[];
  /** candidate id → Task id; survives a crash between Task creation and commit. */
  taskIdByCandidate: Record<string, string>;
  kbCommit: string | null;
  curatedAt: string;
}

const INDEX_PATH = join(DATA_DIR, "day-scan", "minutes-index.json");

export function readMinutesIndex(): MinutesIndexRecord[] {
  if (!existsSync(INDEX_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(INDEX_PATH, "utf8")) as {
      records?: MinutesIndexRecord[];
    };
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch {
    return [];
  }
}

function writeMinutesIndex(records: MinutesIndexRecord[]): void {
  mkdirSync(dirname(INDEX_PATH), { recursive: true });
  const tmp = `${INDEX_PATH}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ version: 1, records }, null, 2)}\n`,
    "utf8",
  );
  renameSync(tmp, INDEX_PATH);
}

function upsertMinutesIndexRecord(record: MinutesIndexRecord): void {
  const records = readMinutesIndex().filter(
    (r) => r.sourceId !== record.sourceId,
  );
  records.push(record);
  writeMinutesIndex(records);
}

/* --------------------------------- helpers -------------------------------- */

function candidatesAssetPath(entryPath: string): string {
  return `${entryPath}/assets/candidates.json`;
}

function entryIndexPath(entryPath: string): string {
  return `${entryPath}/index.md`;
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

async function readPriorCandidates(
  store: KnowledgeBaseStore,
  entryPath: string,
): Promise<MinutesCandidate[]> {
  const raw = await readTextIfPresent(store, candidatesAssetPath(entryPath));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { candidates?: MinutesCandidate[] };
    return Array.isArray(parsed.candidates) ? parsed.candidates : [];
  } catch {
    return [];
  }
}

function contentHash(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

/* ------------------------------ orchestrator ------------------------------ */

/**
 * Curate a run's discovered minutes docs (plan § minutes curation). Bounded by
 * `maxDocsPerRun` (the rest defer without reprocessing); composite-cache-key
 * gated with force-recuration; candidate identity reconciled against committed
 * KB; Tasks auto-created per policy with candidate-id dedup that survives a
 * crash between Task creation and the atomic commit. Returns staged KB writes
 * for the caller's single atomic run commit plus a `finalize` that records the
 * commit id in the ledger index.
 */
export async function curateMinutes(
  docs: MinutesDoc[],
  deps: CurateMinutesDeps,
): Promise<CurateMinutesResult> {
  const index = new Map(readMinutesIndex().map((r) => [r.sourceId, r]));
  // Deterministic order so "which docs defer" is stable across identical runs.
  const ordered = [...docs].sort(
    (a, b) =>
      a.meetingDate.localeCompare(b.meetingDate) ||
      a.sourceId.localeCompare(b.sourceId),
  );

  const cached: string[] = [];
  const toProcess: MinutesDoc[] = [];
  for (const doc of ordered) {
    const key = buildCacheKey(contentHash(doc.content), deps.mappingVersion);
    const prior = index.get(doc.sourceId);
    const entryPath =
      prior?.entryPath ??
      meetingEntryPath(doc.meetingDate, doc.title, doc.sourceId);
    const durable =
      prior &&
      prior.kbCommit !== null &&
      (await readTextIfPresent(deps.store, entryIndexPath(entryPath))) !== null;
    if (!deps.force && durable && cacheKeyMatches(prior.cacheKey, key)) {
      cached.push(doc.sourceId);
      continue;
    }
    toProcess.push(doc);
  }

  const selected = toProcess.slice(0, Math.max(0, deps.maxDocsPerRun));
  const deferred = toProcess.slice(selected.length).map((d) => d.sourceId);

  const changes: KbFileChange[] = [];
  const processed: string[] = [];
  const failed: string[] = [];
  const pendingIndex: MinutesIndexRecord[] = [];
  let tasksCreated = 0;

  const runOne = async (doc: MinutesDoc): Promise<void> => {
    if (deps.signal?.aborted) return;
    const observedAt = new Date().toISOString();
    const hash = contentHash(doc.content);
    const entryPath =
      index.get(doc.sourceId)?.entryPath ??
      meetingEntryPath(doc.meetingDate, doc.title, doc.sourceId);
    try {
      const [prior, existingDoc, extraction] = await Promise.all([
        readPriorCandidates(deps.store, entryPath),
        readTextIfPresent(deps.store, entryIndexPath(entryPath)),
        deps.extractor.extract(doc, deps.signal),
      ]);
      let candidates = reconcileCandidates(prior, extraction.actions, {
        sourceId: doc.sourceId,
        contentHash: hash,
        observedAt,
      });

      // Reattach Task ids known to the ledger (survives a crash before commit),
      // then auto-create per policy for any high-confidence candidate still unlinked.
      const known = index.get(doc.sourceId)?.taskIdByCandidate ?? {};
      candidates = candidates.map((c) =>
        c.taskId
          ? c
          : known[c.id]
            ? { ...c, taskId: known[c.id]!, status: "task-created" }
            : c,
      );
      const created: MinutesCandidate[] = [];
      for (const candidate of candidates) {
        if (!shouldAutoCreateTask(candidate, deps.policy)) {
          created.push(candidate);
          continue;
        }
        const taskId = await deps.createTask({ candidate, doc });
        tasksCreated += 1;
        created.push({ ...candidate, taskId, status: "task-created" });
      }
      candidates = created;

      const entryInput = {
        meetingDate: doc.meetingDate,
        title: doc.title,
        sourceId: doc.sourceId,
        sourceLink: doc.sourceLink,
        meetingSummary: extraction.meetingSummary,
        candidates,
        observedLate: doc.observedLate,
        fullMinutes: doc.content.trim().length > 0,
      };
      const entryContent =
        existingDoc === null
          ? renderMeetingEntry(entryInput)
          : applyMeetingRegion(existingDoc, entryInput);
      changes.push({
        op: "write",
        path: entryIndexPath(entryPath),
        content: entryContent,
      });
      // Store the full minutes/transcript as durable, readable entry content
      // (curated knowledge — the raw text otherwise lives only in the cache).
      if (entryInput.fullMinutes) {
        changes.push({
          op: "write",
          path: `${entryPath}/${MEETING_FULL_MINUTES_ASSET}`,
          content: `# ${doc.title} — full minutes (${doc.meetingDate})\n\nSource: ${doc.sourceLink}\n\n${doc.content.trim()}\n`,
        });
      }
      changes.push({
        op: "write",
        path: candidatesAssetPath(entryPath),
        content: JSON.stringify(
          {
            sourceId: doc.sourceId,
            entryId: meetingEntryId(doc.sourceId),
            title: doc.title,
            sourceLink: doc.sourceLink,
            meetingDate: doc.meetingDate,
            cacheKey: buildCacheKey(hash, deps.mappingVersion),
            candidates,
          },
          null,
          2,
        ),
      });
      const record: MinutesIndexRecord = {
        sourceId: doc.sourceId,
        entryPath,
        entryId: meetingEntryId(doc.sourceId),
        cacheKey: buildCacheKey(hash, deps.mappingVersion),
        candidateIds: candidates.map((c) => c.id),
        taskIdByCandidate: Object.fromEntries(
          candidates.filter((c) => c.taskId).map((c) => [c.id, c.taskId!]),
        ),
        kbCommit: null,
        curatedAt: observedAt,
      };
      // Persist the crash-recovery record (with any created Task ids) BEFORE the
      // caller's commit; finalize() stamps the commit id once it lands.
      upsertMinutesIndexRecord(record);
      pendingIndex.push(record);
      processed.push(doc.sourceId);
    } catch {
      failed.push(doc.sourceId);
    }
  };

  // Bounded-concurrency pool.
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(EXTRACTION_CONCURRENCY, selected.length) },
      async () => {
        while (cursor < selected.length) {
          const doc = selected[cursor++]!;
          await runOne(doc);
        }
      },
    ),
  );

  return {
    changes,
    entryIds: pendingIndex.map((r) => r.entryId),
    processed,
    deferred,
    cached,
    failed,
    tasksCreated,
    finalize(commit: string | null) {
      for (const record of pendingIndex)
        upsertMinutesIndexRecord({ ...record, kbCommit: commit });
    },
  };
}

/**
 * A pluggable minutes pipeline: discovers the day's minutes docs (meeting-day
 * anchored), extracts actions, and creates Tasks. The collection run resolves
 * one and folds its curation into the atomic commit. Injectable so tests use a
 * deterministic fake and unconfigured deployments resolve `null`.
 */
export interface MinutesPipeline {
  discover(
    input: { date: string; window: { startIso: string; endIso: string } },
    signal?: AbortSignal,
  ): Promise<MinutesDoc[]>;
  extractor: MinutesExtractor;
  createTask(input: {
    candidate: MinutesCandidate;
    doc: MinutesDoc;
  }): Promise<string>;
}

let pipelineFactory: (() => MinutesPipeline | null) | null = null;

/**
 * Install the production minutes pipeline (live Google discovery/extraction +
 * Task creation). Kept as an injection seam so the deterministic collection
 * core carries no Google/agent dependency and unconfigured deployments resolve
 * `null` (the substage is then skipped). Wired once at startup.
 */
export function setMinutesPipelineFactory(
  factory: (() => MinutesPipeline | null) | null,
): void {
  pipelineFactory = factory;
}

/** The collection run resolves this when no pipeline is injected explicitly. */
export function resolveMinutesPipeline(): MinutesPipeline | null {
  return pipelineFactory?.() ?? null;
}
