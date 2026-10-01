/**
 * On-disk state of one Tempo worklog export under
 * `DATA_DIR/tempo-exports/<exportId>/`: a checkpoint of finished date windows,
 * the extracted rows as JSONL (appended per window, deduplicated by worklog id
 * on read), the Jira issue/user join caches, and the final CSV/JSON/manifest
 * the user downloads. A crash between an append and its checkpoint only
 * repeats one window, which the dedup absorbs.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config.ts";
import type { TempoIssueMeta } from "./tempoJiraJoin.ts";
import type { TempoExportRow } from "./tempoReportRows.ts";

export const EXPORTS_DIR = join(DATA_DIR, "tempo-exports");
const EXPORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

interface ExportWindow {
  from: string;
  to: string;
  status: "pending" | "done";
  count: number;
  seconds: number;
}

export interface ExportCheckpoint {
  exportId: string;
  createdAt: string;
  updatedAt: string;
  params: {
    from: string;
    to: string;
    projectKeys: string[];
    issueKeys: string[];
    includeAllAuthors: boolean;
    authorAccountId: string | null;
    projectIds: string[];
    issueIds: string[];
    /** Extra Jira field ids the export joins; unioned with later requests. */
    jiraFields: string[];
  };
  windows: ExportWindow[];
  /** "extracting" until every window is done; "complete" once outputs are written. */
  status: "extracting" | "extracted" | "complete";
}

export interface ExportManifest {
  exportId: string;
  from: string;
  to: string;
  params: ExportCheckpoint["params"];
  rowCount: number;
  totalSeconds: number;
  totalHours: number;
  /** sha256 over sorted `worklogId:seconds` pairs — order-independent identity of the dataset. */
  checksum: string;
  duplicatesRemoved: number;
  issueCount: number;
  authorCount: number;
  jiraEnrichment: "on" | "off" | "partial";
  unresolvedIssueIds: number;
  extraFields: string[];
  files: { csv: string; json: string; jsonl: string; manifest: string };
  completedAt: string;
}

export function assertExportId(value: string): string {
  const id = value.trim();
  if (!EXPORT_ID_RE.test(id))
    throw new Error(
      `exportId "${value}" is invalid: letters, digits, ".", "_" and "-" only.`,
    );
  return id;
}

function exportDir(exportId: string): string {
  return join(EXPORTS_DIR, assertExportId(exportId));
}

/**
 * Mint an export id and claim its directory atomically, so two exports started
 * in the same second never share a `worklogs.jsonl`.
 */
export function createExportDir(from: string, to: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  for (;;) {
    const exportId = `tempo-${from}_${to}-${stamp}-${randomBytes(3).toString("hex")}`;
    try {
      mkdirSync(EXPORTS_DIR, { recursive: true });
      mkdirSync(exportDir(exportId), { recursive: false });
      return exportId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

const files = {
  checkpoint: "checkpoint.json",
  rows: "worklogs.jsonl",
  issues: "issues.json",
  users: "users.json",
  csv: "worklogs.csv",
  json: "worklogs.json",
  manifest: "manifest.json",
} as const;

export function exportFilePath(
  exportId: string,
  file: keyof typeof files,
): string {
  return join(exportDir(exportId), files[file]);
}

export function readCheckpoint(exportId: string): ExportCheckpoint | null {
  const checkpoint = readJson<ExportCheckpoint>(
    exportFilePath(exportId, "checkpoint"),
  );
  if (checkpoint) checkpoint.params.jiraFields ??= [];
  return checkpoint;
}

export function writeCheckpoint(checkpoint: ExportCheckpoint): void {
  checkpoint.updatedAt = new Date().toISOString();
  writeJsonAtomic(
    exportFilePath(checkpoint.exportId, "checkpoint"),
    checkpoint,
  );
}

export function readManifest(exportId: string): ExportManifest | null {
  return readJson<ExportManifest>(exportFilePath(exportId, "manifest"));
}

export function writeManifest(manifest: ExportManifest): void {
  writeJsonAtomic(exportFilePath(manifest.exportId, "manifest"), manifest);
}

export function appendRows(exportId: string, rows: TempoExportRow[]): void {
  if (rows.length === 0) return;
  mkdirSync(exportDir(exportId), { recursive: true });
  appendFileSync(
    exportFilePath(exportId, "rows"),
    rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
    "utf8",
  );
}

/** Every persisted row, deduplicated by worklog id (last write wins). */
export function readRows(exportId: string): {
  rows: TempoExportRow[];
  duplicatesRemoved: number;
} {
  const path = exportFilePath(exportId, "rows");
  if (!existsSync(path)) return { rows: [], duplicatesRemoved: 0 };
  const byId = new Map<string, TempoExportRow>();
  let duplicatesRemoved = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as TempoExportRow;
    if (byId.has(row.worklogId)) duplicatesRemoved += 1;
    byId.set(row.worklogId, row);
  }
  const rows = [...byId.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.startTime ?? "").localeCompare(b.startTime ?? "") ||
      a.worklogId.localeCompare(b.worklogId, undefined, { numeric: true }),
  );
  return { rows, duplicatesRemoved };
}

export function readIssueCache(exportId: string): Map<string, TempoIssueMeta> {
  const raw =
    readJson<Record<string, TempoIssueMeta>>(
      exportFilePath(exportId, "issues"),
    ) ?? {};
  const out = new Map<string, TempoIssueMeta>();
  for (const meta of Object.values(raw)) {
    out.set(meta.id, meta);
    out.set(meta.key, meta);
  }
  return out;
}

export function writeIssueCache(
  exportId: string,
  issues: Map<string, TempoIssueMeta>,
): void {
  const byId: Record<string, TempoIssueMeta> = {};
  for (const meta of issues.values()) byId[meta.id] = meta;
  writeJsonAtomic(exportFilePath(exportId, "issues"), byId);
}

export function readUserCache(exportId: string): Map<string, string> {
  const raw =
    readJson<Record<string, string>>(exportFilePath(exportId, "users")) ?? {};
  return new Map(Object.entries(raw));
}

export function writeUserCache(
  exportId: string,
  users: Map<string, string>,
): void {
  writeJsonAtomic(
    exportFilePath(exportId, "users"),
    Object.fromEntries([...users.entries()].sort()),
  );
}

export function writeExportFile(
  exportId: string,
  file: "csv" | "json",
  content: string,
): string {
  const path = exportFilePath(exportId, file);
  writeTextAtomic(path, content);
  return path;
}

/** Persist one aggregate as `report-<timestamp>.csv` beside the export. */
export function writeReportCsv(exportId: string, content: string): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  const path = join(
    exportDir(exportId),
    `report-${stamp}-${randomBytes(3).toString("hex")}.csv`,
  );
  writeTextAtomic(path, content);
  return path;
}

/** Order-independent dataset checksum: sha256 of sorted `worklogId:seconds`. */
export function rowsChecksum(rows: TempoExportRow[]): string {
  const hash = createHash("sha256");
  for (const pair of rows
    .map((row) => `${row.worklogId}:${row.seconds}`)
    .sort())
    hash.update(`${pair}\n`);
  return hash.digest("hex");
}

export function listExportIds(): string[] {
  if (!existsSync(EXPORTS_DIR)) return [];
  return readdirSync(EXPORTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && EXPORT_ID_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}
