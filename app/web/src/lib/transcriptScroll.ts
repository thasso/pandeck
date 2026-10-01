/**
 * The transcript's scroll policy and its per-session reading-position memory.
 *
 * Everything here is pure: numbers in, decisions out. The DOM half lives in
 * `hooks/useTranscriptScroll.ts`, which is where a scroll container, a
 * `ResizeObserver` and the settle loop belong — and which cannot be unit tested
 * in this package, whose web tests run without a DOM.
 *
 * One controller owns the container, in one of three modes:
 * - `bottom` — follow new content. Left when the reader scrolls away from it.
 * - `anchor` — hold a remembered row at a remembered offset, re-applied until
 *   the layout stops moving. Left by a scroll the READER made, or once settled;
 *   a scroll the layout made is what it is holding the row against.
 * - `free` — the reader owns the position; the controller only records it.
 */

import {
  createIdleWriter,
  type IdleWriter,
  type IdleWriterEnv,
} from "./idleWriter.ts";

/** How close to the end still counts as "at the bottom". */
const NEAR_BOTTOM_PX = 80;

export type TranscriptScrollMode = "bottom" | "anchor" | "free";

export interface TranscriptScrollAnchor {
  /** The row the reader's eye is on: the first one still visible at the top edge. */
  messageId: string;
  /** Distance from the container's top edge to that row's top, in px (usually negative). */
  offset: number;
  /**
   * How far the row sat from the newest one. A restore needs it to widen the
   * render window (`transcriptWindow.ts`) before the row can be looked up at
   * all — the window renders only the most recent rows.
   */
  rowsFromEnd: number;
}

export interface TranscriptScrollPosition {
  atBottom: boolean;
  anchor?: TranscriptScrollAnchor;
  /**
   * Identity of the transcript tail when this anchor was measured. An anchor
   * from before a later turn completed is a reading position in an older
   * transcript, not somewhere a newly opened session should jump back to.
   */
  tailKey?: string;
}

export interface TranscriptScrollMemoryEntry extends TranscriptScrollPosition {
  sessionId: string;
  savedAt: number;
}

export interface TranscriptScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

function distanceFromBottom(metrics: TranscriptScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

export function isNearBottom(metrics: TranscriptScrollMetrics): boolean {
  return distanceFromBottom(metrics) < NEAR_BOTTOM_PX;
}

export type TranscriptScrollEvent =
  /** A session's transcript became visible (mount, or a switch to another session). */
  | { kind: "session-opened"; remembered?: TranscriptScrollPosition }
  /** This browser submitted something: follow the answer, wherever the reader was. */
  | { kind: "pin-requested" }
  /** Hold a row deliberately: "load earlier", or a cross-pane jump to a message. */
  | { kind: "anchor-requested" }
  /**
   * A scroll the controller did not cause. The two flags are how it is told
   * apart from one the reader made: `fromReaderInput` marks a scroll a wheel,
   * touch, key or pointer drag backs, and `duringLayoutShift` the ones that
   * arrived while the container was still changing size, which the browser
   * produces by itself and the reader did not ask for.
   */
  | {
      kind: "user-scrolled";
      nearBottom: boolean;
      fromReaderInput?: boolean;
      duringLayoutShift?: boolean;
    }
  /** The layout stopped moving under an in-flight restore. */
  | { kind: "settled" };

/**
 * With nothing remembered, a transcript opens at its end: the newest message is
 * what a conversation is usually opened for.
 */
export function nextScrollMode(
  mode: TranscriptScrollMode,
  event: TranscriptScrollEvent,
): TranscriptScrollMode {
  switch (event.kind) {
    case "session-opened":
      return event.remembered &&
        !event.remembered.atBottom &&
        event.remembered.anchor
        ? "anchor"
        : "bottom";
    case "pin-requested":
      return "bottom";
    case "anchor-requested":
      return "anchor";
    case "user-scrolled":
      // A scroll no reader input backs, arriving while the container is still
      // resizing, belongs to the LAYOUT and changes nothing. The browser writes
      // the offset by itself in exactly this window and by hundreds of px at a
      // time: a phone submit closes the keyboard and collapses the composer back
      // into the dock row and the position is clamped, and every row scrolled
      // into view for the first time replaces its `content-visibility` estimate
      // with its real height, which moves everything above the reader. Reading
      // either as "the reader moved" left a just-submitted turn's Thinking row
      // parked under the bottom card, and abandoned the restore that "load
      // earlier" had just started — while the very layout churn it exists to
      // absorb was still running.
      if (!event.fromReaderInput && event.duringLayoutShift) return mode;
      // A restore is abandoned the moment the reader moves, including by an iOS
      // momentum fling — which keeps firing scroll events with no finger on the
      // glass, so a fling's tail is covered by the input window rather than by
      // the events themselves.
      if (mode === "anchor") return "free";
      return event.nearBottom ? "bottom" : "free";
    case "settled":
      return mode === "anchor" ? "free" : mode;
  }
}

/**
 * What to remember for this session, or `null` while a restore is in flight —
 * recording then would overwrite the memory with the intermediate positions the
 * controller itself is producing.
 */
export function positionToRemember(
  mode: TranscriptScrollMode,
  metrics: TranscriptScrollMetrics,
  anchor: TranscriptScrollAnchor | null,
): TranscriptScrollPosition | null {
  if (mode === "anchor") return null;
  if (mode === "bottom" || isNearBottom(metrics)) return { atBottom: true };
  return anchor ? { atBottom: false, anchor } : { atBottom: true };
}

/**
 * A compact content version for scroll memory. Two rows rather than only the
 * last one distinguish consecutive streaming turns, whose transient last row
 * deliberately reuses the id `live`.
 */
export function transcriptTailKey(
  rows: readonly { id: string }[],
): string | undefined {
  const tail = rows.slice(-2).map((row) => row.id);
  return tail.length > 0 ? tail.join("\0") : undefined;
}

/**
 * Return a remembered position only when it describes the transcript now open.
 *
 * `savedAt` cannot answer this: a completed turn and a local write can share a
 * coarse clock tick, and metadata-only session updates are not transcript
 * changes. The durable tail identity can. Legacy anchors have no identity and
 * intentionally fall back to the end once instead of replaying a potentially
 * stale jump forever.
 */
export function restorableTranscriptPosition(
  remembered: TranscriptScrollPosition | undefined,
  currentTailKey: string | undefined,
): TranscriptScrollPosition | undefined {
  if (!remembered || remembered.atBottom) return remembered;
  return currentTailKey && remembered.tailKey === currentTailKey
    ? remembered
    : undefined;
}

/**
 * What an unrendered row is worth, as a placeholder height.
 *
 * A `content-visibility: auto` row the browser has never laid out contributes
 * its `contain-intrinsic-size` instead of its content, and ONE such number
 * cannot fit a whole app: a phone's rows are two to three times a desktop's, a
 * tool-heavy transcript's a fraction of a prose one's. Growing the render window
 * turns that error into tens of thousands of px of fiction above the reader,
 * which the browser un-does row by row as they scroll into it — a scrollbar that
 * lies, and a remembered offset measured against a height that was never real.
 *
 * So the controller re-measures it from the rows on screen. These three rules
 * are what keep a measurement from being worse than the constant it replaces;
 * the DOM half (`hooks/useTranscriptScroll.ts`) only walks the rows and writes
 * the CSS property.
 */
export const ROW_ESTIMATE_DEFAULT_PX = 240;
export const ROW_ESTIMATE_MIN_PX = 80;
export const ROW_ESTIMATE_MAX_PX = 800;
/**
 * Rows a sample needs, and how much of the estimate one sample is worth. ONE row
 * is enough: a transcript whose rows are taller than the viewport shows exactly
 * one at a time, and that is the transcript the default is most wrong about —
 * refusing to sample there left the estimate at 240px for 600px rows, which is
 * the geometry a "load earlier" prepend is then built out of. The clamp and the
 * weight are what make a sample of one safe.
 */
const ROW_ESTIMATE_SAMPLE = 1;
const ROW_ESTIMATE_WEIGHT = 0.4;
/** How far the estimate must leave the published one to be worth a relayout. */
const ROW_ESTIMATE_CHANGE = 0.2;

/**
 * The median of the rows on screen, clamped — or `null` when there are too few
 * to mean anything.
 *
 * The median, not the mean, because one screenshot card should not outvote five
 * short rows; and clamped because a screenful can BE one freak row (measured: a
 * 117px row beside a 5789px one).
 */
export function rowHeightSample(heights: readonly number[]): number | null {
  if (heights.length < ROW_ESTIMATE_SAMPLE) return null;
  const sorted = [...heights].sort((a, b) => a - b);
  const half = sorted.length >> 1;
  const upper = sorted[half];
  if (upper === undefined) return null;
  const median =
    sorted.length % 2 === 1 ? upper : ((sorted[half - 1] ?? upper) + upper) / 2;
  return Math.min(ROW_ESTIMATE_MAX_PX, Math.max(ROW_ESTIMATE_MIN_PX, median));
}

/**
 * The estimate after one sample. A sample MOVES it and never replaces it, so a
 * screenful of two rows cannot own a session, and every sample counts — this is
 * what makes the estimate converge on the transcript over the reader's stops
 * rather than settling short of it.
 */
export function nextRowEstimate(current: number, sample: number): number {
  return current * (1 - ROW_ESTIMATE_WEIGHT) + sample * ROW_ESTIMATE_WEIGHT;
}

/**
 * Whether the estimate has left the PUBLISHED placeholder far enough to be worth
 * re-laying out every skipped row for. Gating the write rather than the estimate
 * is what keeps those relayouts bounded (a geometric series of them, from the
 * default to wherever the transcript actually is) while the estimate itself
 * keeps converging.
 */
export function shouldPublishRowEstimate(
  published: number,
  estimate: number,
): boolean {
  return Math.abs(estimate - published) / published >= ROW_ESTIMATE_CHANGE;
}

export const TRANSCRIPT_SCROLL_KEY = "assistant.transcriptScroll.v1";
/** Sessions whose reading position is kept. Older entries fall off the end. */
export const TRANSCRIPT_SCROLL_LIMIT = 30;

export interface TranscriptScrollStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function validAnchor(value: unknown): TranscriptScrollAnchor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const anchor = value as Record<string, unknown>;
  if (typeof anchor.messageId !== "string" || !anchor.messageId)
    return undefined;
  if (!Number.isFinite(anchor.offset) || !Number.isFinite(anchor.rowsFromEnd))
    return undefined;
  return {
    messageId: anchor.messageId,
    offset: Number(anchor.offset),
    rowsFromEnd: Number(anchor.rowsFromEnd),
  };
}

export function parseTranscriptScrollMemory(
  raw: string | null,
): TranscriptScrollMemoryEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: TranscriptScrollMemoryEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.sessionId !== "string" || !record.sessionId) continue;
    if (!Number.isFinite(record.savedAt)) continue;
    const anchor = validAnchor(record.anchor);
    const atBottom = record.atBottom === true || !anchor;
    const tailKey =
      typeof record.tailKey === "string" && record.tailKey
        ? record.tailKey
        : undefined;
    entries.push({
      sessionId: record.sessionId,
      savedAt: Number(record.savedAt),
      atBottom,
      ...(anchor ? { anchor } : {}),
      ...(tailKey ? { tailKey } : {}),
    });
  }
  return entries.slice(0, TRANSCRIPT_SCROLL_LIMIT);
}

/** Newest first, one entry per session, bounded. */
export function rememberTranscriptScroll(
  entries: readonly TranscriptScrollMemoryEntry[],
  entry: TranscriptScrollMemoryEntry,
): TranscriptScrollMemoryEntry[] {
  return [
    entry,
    ...entries.filter((item) => item.sessionId !== entry.sessionId),
  ].slice(0, TRANSCRIPT_SCROLL_LIMIT);
}

export interface TranscriptScrollMemory {
  read(sessionId: string): TranscriptScrollPosition | undefined;
  save(sessionId: string, position: TranscriptScrollPosition): void;
  forget(sessionId: string): void;
  /** Write any deferred change now (unmount, `pagehide`, tab hidden). */
  flush(): void;
}

export interface TranscriptScrollMemoryOptions {
  storage: TranscriptScrollStorage | null;
  now?: () => number;
  writerEnv?: IdleWriterEnv;
}

/**
 * A session's reading position is browser-local and deliberately not shared
 * across tabs: two tabs on one session share a single entry and the last write
 * wins. A scroll offset is not worth a cross-tab protocol (the same call
 * `usePrefs` makes for the text scale), and the position is written through
 * `idleWriter` because a scroll can produce one candidate per frame.
 */
export function createTranscriptScrollMemory(
  options: TranscriptScrollMemoryOptions,
): TranscriptScrollMemory {
  const { storage } = options;
  const now = options.now ?? (() => Date.now());
  let entries: TranscriptScrollMemoryEntry[] | null = null;

  const load = (): TranscriptScrollMemoryEntry[] => {
    if (entries) return entries;
    let raw: string | null = null;
    try {
      raw = storage?.getItem(TRANSCRIPT_SCROLL_KEY) ?? null;
    } catch {
      raw = null;
    }
    entries = parseTranscriptScrollMemory(raw);
    return entries;
  };

  const writer: IdleWriter<TranscriptScrollMemoryEntry[]> = createIdleWriter(
    (value) => {
      try {
        storage?.setItem(TRANSCRIPT_SCROLL_KEY, JSON.stringify(value));
      } catch {
        // Best-effort: a full or blocked storage costs the reading position, not
        // the transcript.
      }
    },
    {
      delayMs: 400,
      maxDelayMs: 2000,
      idleTimeoutMs: 1000,
      ...(options.writerEnv ? { env: options.writerEnv } : {}),
    },
  );

  const memory: TranscriptScrollMemory = {
    read(sessionId) {
      const entry = load().find((item) => item.sessionId === sessionId);
      if (!entry) return undefined;
      return entry.atBottom
        ? { atBottom: true }
        : {
            atBottom: false,
            ...(entry.anchor ? { anchor: entry.anchor } : {}),
            ...(entry.tailKey ? { tailKey: entry.tailKey } : {}),
          };
    },
    save(sessionId, position) {
      entries = rememberTranscriptScroll(load(), {
        sessionId,
        savedAt: now(),
        ...position,
      });
      writer.schedule(entries);
    },
    forget(sessionId) {
      const current = load();
      if (!current.some((item) => item.sessionId === sessionId)) return;
      entries = current.filter((item) => item.sessionId !== sessionId);
      writer.schedule(entries);
    },
    flush() {
      writer.flush();
    },
  };
  return memory;
}

let sharedMemory: TranscriptScrollMemory | null = null;

/**
 * ONE memory for the whole app, at module level: the chat surface is unmounted
 * whenever another object screen is open (`App.tsx` renders it only on session
 * routes), so a position held in component state would already be gone by the
 * time the reader comes back — which is exactly the complaint this exists for.
 */
export function transcriptScrollMemory(): TranscriptScrollMemory {
  if (sharedMemory) return sharedMemory;
  let storage: TranscriptScrollStorage | null = null;
  try {
    storage = typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Private-mode/blocked storage: the position then lives for this page only.
    storage = null;
  }
  sharedMemory = createTranscriptScrollMemory({ storage });
  return sharedMemory;
}

/** Drop a session's remembered position — its transcript is gone for good. */
export function forgetTranscriptScrollPosition(sessionId: string): void {
  transcriptScrollMemory().forget(sessionId);
}
