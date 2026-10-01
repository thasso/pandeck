import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { TaskSummary } from "@assistant/shared";
import { DATA_DIR } from "./config.ts";
import { listTasks } from "./tasks.ts";

const LEDGER_PATH = join(DATA_DIR, "meeting-minutes", "processed-sources.json");

type MeetingMinutesScanOutcome =
  "actions_found" | "no_actions" | "unclear" | "error";

export type MeetingMinutesSourceIds = {
  driveFileId?: string;
  gmailThreadId?: string;
  calendarEventId?: string;
};

export type MeetingMinutesProcessedRecord = {
  key: string;
  sourceLink: string;
  sourceTitle?: string;
  sourceIds?: MeetingMinutesSourceIds;
  sourceDate?: string | null;
  scannedAt: string;
  contentHash?: string;
  outcome: MeetingMinutesScanOutcome;
  actionCount: number;
  taskIds?: string[];
  scanner?: { provider?: string; modelId?: string; thinkingLevel?: string };
  error?: string;
};

type LedgerFile = { version: 1; records: MeetingMinutesProcessedRecord[] };

export function sourceKey(input: {
  sourceLink?: string;
  sourceIds?: MeetingMinutesSourceIds;
}): string {
  return (
    sourceKeys(input)[0] ??
    `unknown:${createHash("sha1").update(JSON.stringify(input)).digest("hex")}`
  );
}

export function sourceKeys(input: {
  sourceLink?: string;
  sourceIds?: MeetingMinutesSourceIds;
}): string[] {
  const keys: string[] = [];
  const ids = input.sourceIds ?? {};
  if (ids.driveFileId) keys.push(`drive:${ids.driveFileId}`);
  if (ids.gmailThreadId) keys.push(`gmail:${ids.gmailThreadId}`);
  const normalized = normalizeUrl(input.sourceLink ?? "");
  if (normalized)
    keys.push(`url:${createHash("sha1").update(normalized).digest("hex")}`);
  return keys;
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    parsed.hash = parsed.hash.replace(/\/[^/?#]+$/, (value) => value);
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

export function readMeetingMinutesLedger(): MeetingMinutesProcessedRecord[] {
  if (!existsSync(LEDGER_PATH)) return [];
  try {
    const parsed = JSON.parse(
      readFileSync(LEDGER_PATH, "utf8"),
    ) as Partial<LedgerFile>;
    return Array.isArray(parsed.records) ? parsed.records.filter(isRecord) : [];
  } catch {
    return [];
  }
}

export function upsertMeetingMinutesRecord(
  record: MeetingMinutesProcessedRecord,
): MeetingMinutesProcessedRecord {
  const records = readMeetingMinutesLedger().filter(
    (item) => item.key !== record.key,
  );
  records.push(record);
  writeLedger(records);
  return record;
}

function processedSourceKeysFromLedger(): Set<string> {
  return new Set(readMeetingMinutesLedger().map((record) => record.key));
}

function processedSourceKeysFromTasks(): Set<string> {
  const keys = new Set<string>();
  for (const task of listTasks({ includeArchived: true }) as TaskSummary[]) {
    for (const link of task.externalLinks ?? []) {
      if (link.type !== "source" || !link.url) continue;
      keys.add(sourceKey({ sourceLink: link.url }));
    }
  }
  return keys;
}

export function processedSourceKeys(): Set<string> {
  return new Set([
    ...processedSourceKeysFromLedger(),
    ...processedSourceKeysFromTasks(),
  ]);
}

function writeLedger(records: MeetingMinutesProcessedRecord[]): void {
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  const tmp = `${LEDGER_PATH}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ version: 1, records }, null, 2)}\n`,
    "utf8",
  );
  renameSync(tmp, LEDGER_PATH);
}

function isRecord(value: unknown): value is MeetingMinutesProcessedRecord {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as MeetingMinutesProcessedRecord).key === "string",
  );
}
