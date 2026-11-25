/**
 * Whether a session's canonical log holds the user entry a prompt was admitted
 * with, found by its `clientRequestId` (`docs/schedules.md`, "Admission and
 * crash safety"). Read synchronously, the way the file persistence's `load`
 * reads: only complete lines count, and a torn final line is not an entry.
 *
 * Evidence is a PARSED user message carrying exactly that key. The key in any
 * other field or entry proves nothing, and neither does a longer key that
 * starts with it. A record that contains the raw key but cannot be read as an
 * entry (a corrupt complete line, a torn tail) might have been it, so it makes
 * the answer `unknown` unless a valid keyed entry is found as well.
 */
import { readFileSync } from "node:fs";
import { logPathFor } from "./persistence.ts";
import type { UserRawEntry } from "./rawEntry.ts";

/** `present`: admitted; `absent`: provably not; `unknown`: the log cannot say. */
export type AdmittedUserEntry = "present" | "absent" | "unknown";

export function findAdmittedUserEntry(
  sessionId: string,
  clientRequestId: string,
  path = logPathFor(sessionId),
): AdmittedUserEntry {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? "absent"
      : "unknown";
  }
  const lastNl = raw.lastIndexOf("\n");
  const complete = lastNl >= 0 ? raw.slice(0, lastNl) : "";
  // The bytes after the last newline are a write that never finished.
  let uncertain = raw.slice(lastNl + 1).includes(clientRequestId);
  for (const line of complete.split("\n")) {
    if (!line || !line.includes(clientRequestId)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      uncertain = true;
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      uncertain = true;
      continue;
    }
    const entry = parsed as Partial<UserRawEntry> & { seq?: unknown };
    if (
      entry.type === "message" &&
      entry.role === "user" &&
      typeof entry.seq === "number" &&
      entry.clientRequestId === clientRequestId
    )
      return "present";
  }
  return uncertain ? "unknown" : "absent";
}
