import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.ts";

/**
 * Persistent mapping of a user-local day (YYYY-MM-DD) to the assistant session
 * bound to it (the calendar's per-day chat/scan session). The session itself is
 * a normal session in the regular store; this only records the binding so the
 * calendar can reopen the same chat for a day.
 */
const STORE_PATH = join(DATA_DIR, "calendar", "day-sessions.json");

type StoreFile = { version: 1; days: Record<string, string> };

function read(): Record<string, string> {
  if (!existsSync(STORE_PATH)) return {};
  try {
    const parsed = JSON.parse(
      readFileSync(STORE_PATH, "utf8"),
    ) as Partial<StoreFile>;
    return parsed.days && typeof parsed.days === "object"
      ? { ...parsed.days }
      : {};
  } catch {
    return {};
  }
}

function write(days: Record<string, string>): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ version: 1, days } satisfies StoreFile, null, 2)}\n`,
    "utf8",
  );
  renameSync(tmp, STORE_PATH);
}

/**
 * The fixed session title a calendar day session carries (set before its first
 * prompt so it never auto-renames). Centralized so binding recovery can find the
 * day session by title without the convention drifting between call sites.
 */
export function daySessionTitle(date: string): string {
  return `Calendar · ${date}`;
}

export function getDaySessionId(date: string): string | null {
  return read()[date] ?? null;
}

export function setDaySessionId(date: string, sessionId: string): void {
  const days = read();
  days[date] = sessionId;
  write(days);
}

export function clearDaySession(date: string): void {
  const days = read();
  if (date in days) {
    delete days[date];
    write(days);
  }
}
