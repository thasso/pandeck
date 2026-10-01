/**
 * Server-side session attachment store under `DATA_DIR/attachments/<sessionId>/`.
 *
 * The pi harness already writes uploaded prompt attachments here so the model
 * can be pointed at a saved path; this module makes that store a first-class,
 * addressable surface. Bytes are moved BY REFERENCE (an attachment id) — the
 * agent never has to route a binary through its context. Both uploaded files
 * and server-fetched binaries (e.g. a Slack PDF) land here, and KB asset
 * ingestion copies straight out of it.
 *
 * A per-session `index.json` sidecar records the real id/name/mime for every
 * attachment this module writes. Listing/resolution also scan the directory so
 * files written before the index existed (or by older code) stay discoverable;
 * such orphans get a synthesized record keyed by their on-disk basename.
 */
import { Buffer } from "node:buffer";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { AttachmentRole } from "@assistant/shared";
import { DATA_DIR } from "./config.ts";

export type SessionAttachmentSource =
  "upload" | "slack" | "confluence" | "agent";

/** One addressable attachment stored for a session. */
export interface SessionAttachmentRecord {
  /** Stable id the agent passes back to read/copy this attachment. */
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Basename of the stored file within the session's attachment dir. */
  file: string;
  /** Absolute path on disk. */
  path: string;
  createdAt: number;
  source: SessionAttachmentSource;
  /** Special attachment role (task/knowledge/project context), when set. */
  role?: AttachmentRole;
}

/** The persisted subset of a record (path is derived from `file`). */
type StoredRecord = Omit<SessionAttachmentRecord, "path">;

const INDEX_FILE = "index.json";

export function sessionAttachmentsDir(sessionId: string): string {
  return join(DATA_DIR, "attachments", sessionId);
}

/** Filesystem-safe attachment file name (shared with the pi save path). */
function safeAttachmentFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned || "attachment";
}

/** Persist an uploaded (base64) prompt attachment and index it. */
export function persistUploadedAttachment(
  sessionId: string,
  attachment: {
    id: string;
    name: string;
    mimeType: string;
    data: string;
    role?: AttachmentRole;
  },
): SessionAttachmentRecord {
  return writeAttachment(sessionId, {
    id: attachment.id,
    name: attachment.name,
    mimeType:
      normalizeMime(attachment.mimeType) || inferMimeFromName(attachment.name),
    bytes: Buffer.from(attachment.data, "base64"),
    source: "upload",
    ...(attachment.role !== undefined ? { role: attachment.role } : {}),
  });
}

/** Stage server-fetched bytes (e.g. a downloaded Slack file) as an attachment. */
export function stageSessionAttachment(
  sessionId: string,
  input: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    source: SessionAttachmentSource;
    id?: string;
  },
): SessionAttachmentRecord {
  const id =
    input.id?.trim() ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return writeAttachment(sessionId, {
    id,
    name: input.name,
    mimeType: normalizeMime(input.mimeType) || inferMimeFromName(input.name),
    bytes: Buffer.from(input.bytes),
    source: input.source,
  });
}

/** List every attachment available to a session (indexed + orphan files). */
export function listSessionAttachments(
  sessionId: string,
): SessionAttachmentRecord[] {
  const dir = sessionAttachmentsDir(sessionId);
  if (!existsSync(dir)) return [];
  const byFile = new Map(
    readIndex(sessionId).map((record) => [record.file, record]),
  );
  const records: SessionAttachmentRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (name === INDEX_FILE) continue;
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const stored = byFile.get(name);
    records.push(
      stored
        ? { ...stored, path }
        : synthesizeRecord(dir, name, stat.size, stat.mtimeMs),
    );
  }
  records.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return records;
}

/** Resolve one attachment by its indexed id or on-disk basename (path-contained). */
export function resolveSessionAttachment(
  sessionId: string,
  ref: string,
): SessionAttachmentRecord | null {
  const key = ref?.trim();
  if (!key) return null;
  const dir = sessionAttachmentsDir(sessionId);
  const indexed = readIndex(sessionId).find((record) => record.id === key);
  if (indexed) {
    const path = join(dir, indexed.file);
    if (isContained(dir, path) && existsSync(path)) return { ...indexed, path };
  }
  if (
    !key.includes("/") &&
    !key.includes("\\") &&
    key !== "." &&
    key !== ".." &&
    key !== INDEX_FILE
  ) {
    const path = join(dir, key);
    if (isContained(dir, path) && existsSync(path)) {
      const stat = statSync(path);
      if (stat.isFile())
        return synthesizeRecord(dir, key, stat.size, stat.mtimeMs);
    }
  }
  return null;
}

/** Resolve an attachment and read its raw bytes; null when not found. */
export function readSessionAttachmentBytes(
  sessionId: string,
  ref: string,
): { record: SessionAttachmentRecord; bytes: Buffer } | null {
  const record = resolveSessionAttachment(sessionId, ref);
  if (!record) return null;
  return { record, bytes: readFileSync(record.path) };
}

/**
 * Read at most `limit + 1` bytes of one resolved attachment.
 *
 * The extra byte is the point: a caller that has already checked the recorded
 * size against a budget can see that the file has GROWN since, instead of
 * discovering it by allocating the whole thing. Reading the file in full before
 * a bound is applied is what lets one oversized attachment cost the process
 * arbitrary memory.
 */
export async function readSessionAttachmentUpTo(
  record: SessionAttachmentRecord,
  limit: number,
): Promise<Buffer> {
  const handle = await open(record.path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(limit, 0) + 1);
    // Until EOF or the bound, never "one read is the whole file": `read` may
    // return fewer bytes than asked for, and treating the first answer as
    // complete is how silently truncated binary content reaches a commit.
    let filled = 0;
    while (filled < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.byteLength - filled,
        filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

/* ------------------------------- internals ------------------------------- */

function writeAttachment(
  sessionId: string,
  input: {
    id: string;
    name: string;
    mimeType: string;
    bytes: Buffer;
    source: SessionAttachmentSource;
    role?: AttachmentRole;
  },
): SessionAttachmentRecord {
  const dir = sessionAttachmentsDir(sessionId);
  mkdirSync(dir, { recursive: true });
  const file = `${Date.now()}-${safeAttachmentFileName(input.id)}-${safeAttachmentFileName(input.name)}`;
  const path = join(dir, file);
  writeFileSync(path, input.bytes);
  const stored: StoredRecord = {
    id: input.id,
    name: input.name,
    mimeType: input.mimeType,
    size: input.bytes.byteLength,
    file,
    createdAt: Date.now(),
    source: input.source,
    ...(input.role ? { role: input.role } : {}),
  };
  upsertIndex(sessionId, stored);
  return { ...stored, path };
}

function indexPath(sessionId: string): string {
  return join(sessionAttachmentsDir(sessionId), INDEX_FILE);
}

function readIndex(sessionId: string): StoredRecord[] {
  const path = indexPath(sessionId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is StoredRecord =>
        Boolean(entry) &&
        typeof entry.id === "string" &&
        typeof entry.file === "string",
    );
  } catch {
    return [];
  }
}

function upsertIndex(sessionId: string, record: StoredRecord): void {
  const records = readIndex(sessionId).filter(
    (existing) => existing.id !== record.id && existing.file !== record.file,
  );
  records.push(record);
  writeFileSync(indexPath(sessionId), JSON.stringify(records, null, 2));
}

function synthesizeRecord(
  dir: string,
  file: string,
  size: number,
  mtimeMs: number,
): SessionAttachmentRecord {
  return {
    id: file,
    name: file,
    mimeType: inferMimeFromName(file),
    size,
    file,
    path: join(dir, file),
    createdAt: Math.round(mtimeMs),
    source: "upload",
  };
}

function isContained(dir: string, path: string): boolean {
  const base = resolve(dir);
  const target = resolve(path);
  return target === base || target.startsWith(base + sep);
}

function normalizeMime(value?: string): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  jsonl: "application/x-ndjson",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html",
  htm: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};

function inferMimeFromName(name: string): string {
  const ext = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}
