import type {
  CalendarDayRunHealth,
  CalendarDayState,
  CalendarDaySummary,
  CalendarDayTaskRef,
  CalendarDayTempoRow,
  CalendarScanSource,
  TaskStatus,
} from "@assistant/shared";
import { listProposalsForDate } from "../db/tempoPlanStore.ts";
import { isGoogleConfigured } from "../googleSettings.ts";
import {
  clearDaySession,
  daySessionTitle,
  getDaySessionId,
  setDaySessionId,
} from "../calendarDaySessions.ts";
import { sessionStore } from "../db/sessionStore.ts";
import {
  readMeetingMinutesLedger,
  sourceKeys,
} from "../meetingMinutesProcessed.ts";
import { listTasks } from "../tasks.ts";
import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import { getKnowledgeIndex } from "../knowledgeBaseIndex.ts";
import { entryBodyText } from "../knowledgeBaseEntry.ts";
import type { DayRunManifest } from "./types.ts";
import {
  DATA_REGION_END,
  DATA_REGION_START,
  NARRATIVE_REGION_END,
  NARRATIVE_REGION_START,
} from "./appendix.ts";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertValidDate(date: string): string {
  if (!ISO_DATE_RE.test(date))
    throw new Error("date must be a YYYY-MM-DD day.");
  return date;
}

/** Stable KB entry id for a day's summary, e.g. `daily-summary-2026-07-08`. */
export function dailySummaryEntryId(date: string): string {
  return `daily-summary-${date}`;
}

/** Canonical KB entry folder path for a day's summary. */
export function dailySummaryEntryPath(date: string): string {
  return `daily-summaries/${date}`;
}

/**
 * Read-model for one user-local day: the meeting-minutes sources the scanner
 * has processed (ledger), the CL Tasks linked to those sources, the persisted
 * executive summary (a first-class KB `daily-summary` entry), and the health
 * of the last deterministic collection run (from the committed manifest).
 * This only reads what collection/synthesis produced.
 */
export async function getDayState(date: string): Promise<CalendarDayState> {
  assertValidDate(date);
  const records = readMeetingMinutesLedger().filter(
    (record) => (record.sourceDate ?? null) === date,
  );
  // A processed day's source tree is historical identity, not a current-work
  // list. Keep its durable Task links after retention archives completed rows.
  const allTasks = listTasks({ includeArchived: true });
  const seenTaskIds = new Set<string>();
  const flatTasks: CalendarDayTaskRef[] = [];

  // Each processed source becomes a tree node; the CL Tasks whose source link
  // matches it are its child nodes.
  const sources: CalendarScanSource[] = records.map((record) => {
    const keys = new Set(
      sourceKeys({
        sourceLink: record.sourceLink,
        ...(record.sourceIds !== undefined
          ? { sourceIds: record.sourceIds }
          : {}),
      }),
    );
    const tasks: CalendarDayTaskRef[] = [];
    for (const task of allTasks) {
      const matches = (task.externalLinks ?? []).some(
        (link) =>
          link.url &&
          sourceKeys({ sourceLink: link.url }).some((key) => keys.has(key)),
      );
      if (!matches) continue;
      const ref: CalendarDayTaskRef = {
        id: task.id,
        title: task.title,
        status: task.status as TaskStatus,
      };
      tasks.push(ref);
      if (!seenTaskIds.has(task.id)) {
        seenTaskIds.add(task.id);
        flatTasks.push(ref);
      }
    }
    return {
      title: record.sourceTitle ?? record.sourceLink,
      sourceLink: record.sourceLink,
      outcome: record.outcome,
      scannedAt: record.scannedAt ?? null,
      ...(record.error ? { error: record.error } : {}),
      tasks,
    };
  });

  const store = new KnowledgeBaseStore();
  return {
    date,
    googleConfigured: isGoogleConfigured(),
    daySessionId: resolveDaySessionId(date),
    sources,
    tasks: flatTasks,
    summary: await readDaySummary(store, date),
    run: await readRunHealth(store, date),
    tempo: readDayTempoRows(date),
  };
}

/** Project the day's Tempo proposal rows for the panel (dropped/cancelled/declined hidden). */
function readDayTempoRows(date: string): CalendarDayTempoRow[] {
  return listProposalsForDate(date)
    .filter(
      (row) =>
        row.status !== "dropped" &&
        row.status !== "cancelled" &&
        row.status !== "declined",
    )
    .map((row) => ({
      id: row.id,
      issueKey: row.issueKey,
      startTime: row.startTime,
      durationSeconds: row.durationSeconds,
      activityKey: row.activityKey,
      description: row.description,
      status: row.status,
      resultWorklogId: row.resultWorklogId,
    }));
}

/**
 * Resolve the day's chat session (Task 162) for the panel's "Open day session"
 * action. A scan/chat always names it `Calendar · <date>` and records a binding.
 *
 * Resilience matters here: a resumable pi session that is not currently loaded
 * into the metadata store is NOT a ghost, so a plain `get` miss must never
 * destroy the durable binding (an earlier version cleared on any miss, which
 * permanently lost a valid binding when the row was read before boot-time pi
 * metadata repair). We therefore only clear a binding whose session is
 * DEFINITIVELY deleted, and we self-heal: if the binding is missing/unknown but
 * the titled session still exists, we rebind to it so the day chat is always
 * reachable.
 */
export function resolveDaySessionId(date: string): string | null {
  const boundId = getDaySessionId(date);
  if (boundId) {
    const meta = sessionStore.getIncludingDeleted(boundId);
    if (meta && !meta.deletedAt) return boundId;
    if (meta?.deletedAt) clearDaySession(date); // definitively gone → drop it
    // meta === undefined (unknown id): don't clear — fall through to recovery.
  }
  const recovered = findDaySessionByTitle(date);
  if (recovered) {
    if (recovered !== boundId) setDaySessionId(date, recovered);
    return recovered;
  }
  return null;
}

/** Find a live (non-deleted, non-archived) day chat session by its fixed title. */
function findDaySessionByTitle(date: string): string | null {
  const title = daySessionTitle(date);
  const matches = sessionStore
    .list()
    .filter((s) => s.title === title && !s.archivedAt);
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.createdAt - a.createdAt); // newest wins if duplicated
  return matches[0]!.id;
}

async function readDaySummary(
  store: KnowledgeBaseStore,
  date: string,
): Promise<CalendarDaySummary | null> {
  try {
    const index = await getKnowledgeIndex(store);
    const entry = index.entries.find(
      (candidate) => candidate.id === dailySummaryEntryId(date),
    );
    if (!entry) return null;
    const markdown = presentDayReport(
      entryBodyText(await store.readEntryFile(entry.path)),
    );
    return {
      entryId: entry.id,
      path: entry.path,
      markdown,
      updatedAt: entry.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Present the day entry body as the attention-first report: drop the machine
 * DATA region (its stats surface in the disposition-aware health header, not as
 * inline markdown) and unwrap the narrative-region markers, keeping the
 * synthesized sections and the user-owned `## Notes`.
 */
function presentDayReport(body: string): string {
  let text = body;
  const ds = text.indexOf(DATA_REGION_START);
  const de = text.indexOf(DATA_REGION_END);
  if (ds !== -1 && de !== -1 && de > ds)
    text = text.slice(0, ds) + text.slice(de + DATA_REGION_END.length);
  text = text
    .split(NARRATIVE_REGION_START)
    .join("")
    .split(NARRATIVE_REGION_END)
    .join("");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** Project the last committed run manifest to the wire health header. */
async function readRunHealth(
  store: KnowledgeBaseStore,
  date: string,
): Promise<CalendarDayRunHealth | null> {
  try {
    const raw = await store.readEntryFile(
      `${dailySummaryEntryPath(date)}/assets/manifest.json`,
    );
    const manifest = JSON.parse(raw) as DayRunManifest;
    return {
      runId: manifest.runId,
      asOf: manifest.asOf,
      schemaVersion: manifest.schemaVersion,
      changesSinceLastRun: manifest.changesSinceLastRun,
      ...(manifest.minutes
        ? {
            minutes: {
              discovered: manifest.minutes.discovered,
              processed: manifest.minutes.processed,
              cached: manifest.minutes.cached,
              deferred: manifest.minutes.deferred,
              failed: manifest.minutes.failed,
              tasksCreated: manifest.minutes.tasksCreated,
            },
          }
        : {}),
      sources: manifest.sources.map((source) => ({
        key: source.key,
        label: source.label,
        disposition: source.disposition,
        ...(source.skipReason ? { skipReason: source.skipReason } : {}),
        ...(source.result ? { result: source.result } : {}),
        ...(source.factCount !== undefined
          ? { factCount: source.factCount }
          : {}),
        ...(source.added !== undefined ? { added: source.added } : {}),
        ...(source.changed !== undefined ? { changed: source.changed } : {}),
        ...(source.error ? { error: source.error } : {}),
      })),
    };
  } catch {
    return null;
  }
}
