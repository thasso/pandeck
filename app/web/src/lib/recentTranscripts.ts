/**
 * A short, browser-local history of what dictation actually produced.
 *
 * Authoring a vocabulary rule requires knowing the misheard phrase, and that
 * information is fleeting: the transcript lands in the draft, you fix the word
 * in passing, and the evidence is gone. Keeping the last few transcripts means
 * the Settings editor can show you what the recognizer really wrote instead of
 * asking you to remember it.
 *
 * Deliberately `localStorage` and nothing more: the server persists no
 * transcripts, and this must not quietly change that. The text is already in
 * your draft on the same device, entries are length- and count-capped, and the
 * editor offers a Clear action. Per-device by design — merging phone and laptop
 * would mean durable server-side storage of dictated text, a bigger decision
 * than this feature needs.
 *
 * The list transforms are exported as pure functions so they are covered without
 * a DOM (this package's tests run DOM-free); the storage wrapper around them is
 * deliberately trivial.
 */

const STORAGE_KEY = "assistant.dictation.recent";
/** Enough to spot a pattern; short enough to scan. */
export const MAX_RECENT_TRANSCRIPTS = 20;
/** Rules are made of words, not paragraphs; keep only the head of long dictations. */
export const MAX_TRANSCRIPT_CHARS = 300;

export interface RecentTranscript {
  text: string;
  /** Epoch ms, for ordering and a relative label. */
  at: number;
}

/** Parse stored JSON defensively: corrupt storage must never break the page. */
export function parseStoredTranscripts(raw: string | null): RecentTranscript[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is RecentTranscript =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as RecentTranscript).text === "string" &&
          typeof (entry as RecentTranscript).at === "number",
      )
      .slice(0, MAX_RECENT_TRANSCRIPTS);
  } catch {
    return [];
  }
}

/**
 * Newest first, deduplicated against the immediately previous entry so
 * re-dictating the same phrase does not fill the list, truncated and capped.
 * Returns the input unchanged when there is nothing worth recording.
 */
export function appendTranscript(
  existing: RecentTranscript[],
  text: string,
  at: number,
): RecentTranscript[] {
  const trimmed = text.trim().slice(0, MAX_TRANSCRIPT_CHARS);
  if (!trimmed) return existing;
  if (existing[0]?.text === trimmed) return existing;
  return [{ text: trimmed, at }, ...existing].slice(0, MAX_RECENT_TRANSCRIPTS);
}

/** Compact relative age for a list row ("just now", "14m", "3h", "2d"). */
export function transcriptAge(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/* ------------------------------ browser storage ----------------------------- */

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    // Blocked storage (private mode, embedded contexts) is not an error here.
    return undefined;
  }
}

/** Most recent first; empty when storage is unavailable. */
export function recentTranscripts(): RecentTranscript[] {
  return parseStoredTranscripts(storage()?.getItem(STORAGE_KEY) ?? null);
}

/**
 * Record one transcript. This is the transcript as DELIVERED — vocabulary rules
 * have already been applied server-side, which is what you want: a phrase an
 * existing rule already fixes is not one you need a new rule for.
 */
export function recordTranscript(text: string, at: number = Date.now()): void {
  const store = storage();
  if (!store) return;
  const next = appendTranscript(
    parseStoredTranscripts(store.getItem(STORAGE_KEY)),
    text,
    at,
  );
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full; this is a convenience, never a requirement.
  }
}

export function clearRecentTranscripts(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}
