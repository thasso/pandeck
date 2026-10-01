/**
 * Pi entry scanner.
 *
 * Pi persists each conversation message to its `.jsonl` session file with a stable
 * native entry `id`, but does NOT surface those ids in live adapter events. So
 * the runtime appends durable log entries without native ids, then the pi adapter
 * — AFTER pi has persisted the turn — scans the session file to recover the native
 * ids and bind them (the fork/resume anchor). Reading happens post-persistence, so
 * the ids are stable.
 *
 * The scan is NOT 1:1 with our conversation entries and must not be read as one.
 * One prompt drives one pi agent turn, but that turn writes as many native
 * assistant messages as it takes model calls: `user → assistant(toolCall) →
 * toolResult → assistant(toolCall) → toolResult → assistant(final text)`. Our log
 * aggregates the whole turn into ONE assistant entry followed by its tool results,
 * so the two transcripts agree on TURNS and on tool call ids, never on row counts
 * or row order. `SessionLog.bindScannedEntries` reconciles them on exactly those
 * two invariants, which is why each row carries its tool call ids.
 */
import { existsSync, readFileSync } from "node:fs";

export interface ScannedPiEntry {
  /** Pi's native entry id (stable across reload/resume). */
  id: string;
  role: "user" | "assistant" | "toolResult";
  /** For tool results, the call they answer (for binding to our toolResult entry). */
  toolCallId?: string;
  /**
   * For assistant messages, the calls this native message DECLARES. It is what
   * tells a reconciler which native messages belong to the aggregated turn it is
   * placing, and where the next one starts.
   */
  toolCallIds?: string[];
  /**
   * Set when the message declares a `toolCall` block whose id could not be read.
   * Without it such a row would be indistinguishable from a message that calls
   * NOTHING — which is the turn's final answer — so a reconciler must treat the
   * row as unplaceable rather than as a turn boundary.
   */
  unidentifiedToolCalls?: true;
}

/**
 * Scan a pi session `.jsonl` for its ordered conversation entries (native id +
 * role). Tolerates a torn final line and skips non-message bookkeeping rows
 * (session/model_change/custom/…). Returns [] if the file is missing/unreadable.
 */
export function scanPiEntries(path: string | undefined): ScannedPiEntry[] {
  if (!path || !existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: ScannedPiEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // torn/corrupt line
    }
    if (!row || typeof row !== "object") continue;
    const r = row as {
      type?: unknown;
      id?: unknown;
      message?: { role?: unknown; toolCallId?: unknown; content?: unknown };
    };
    if (r.type !== "message" || typeof r.id !== "string" || !r.message)
      continue;
    const role = r.message.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult")
      continue;
    const declared =
      role === "assistant"
        ? declaredToolCalls(r.message.content)
        : { ids: [], unidentified: false };
    out.push({
      id: r.id,
      role,
      ...(typeof r.message.toolCallId === "string"
        ? { toolCallId: r.message.toolCallId }
        : {}),
      ...(declared.ids.length > 0 ? { toolCallIds: declared.ids } : {}),
      ...(declared.unidentified
        ? { unidentifiedToolCalls: true as const }
        : {}),
    });
  }
  return out;
}

/**
 * The tool calls an assistant message declares. Pi writes them as `toolCall`
 * content blocks whose `id` is the call id our normalized model calls
 * `toolCallId`; both spellings are accepted so a scan never silently loses the
 * one signal that ties a native message to our aggregated turn. A block whose id
 * is missing or not a string is REPORTED (`unidentified`) rather than dropped:
 * silently dropping it would turn a calling message into what looks like a
 * turn-ending one.
 */
function declaredToolCalls(content: unknown): {
  ids: string[];
  unidentified: boolean;
} {
  if (!Array.isArray(content)) return { ids: [], unidentified: false };
  const ids: string[] = [];
  let unidentified = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; id?: unknown; toolCallId?: unknown };
    if (b.type !== "toolCall") continue;
    const id = typeof b.id === "string" ? b.id : b.toolCallId;
    if (typeof id === "string" && id) ids.push(id);
    else unidentified = true;
  }
  return { ids, unidentified };
}

/** The native id of the LAST user entry in the file, or undefined. The prompt-accept anchor. */
export function lastUserNativeId(path: string | undefined): string | undefined {
  const entries = scanPiEntries(path);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.role === "user") return entries[i]!.id;
  }
  return undefined;
}
