/**
 * Where the reader was in a LIST, and how to put them back there.
 *
 * Everything here is pure: numbers in, decisions out, so the rules can be read
 * and tested without a container. The DOM half lives in
 * `hooks/useListScroll.ts` — the scroll container, the `ResizeObserver` and the
 * retry loop — and is covered by `useListScroll.test.tsx`, which opts into
 * jsdom (`// @vitest-environment jsdom`) rather than running in this package's
 * DOM-free default.
 *
 * The transcript keeps its own controller (`transcriptScroll.ts`): it follows
 * new content at the bottom and renders a windowed subset of its rows, neither
 * of which a list does. What the two share is the ANCHOR — the row at the top
 * edge plus its offset — because both move under the reader (sessions re-sort
 * by activity, a Task is filed, the archived shelf expands) and a raw pixel
 * offset then points at a different row than the one they left. The offset is
 * kept as the fallback for the rows an anchor cannot survive: a list that was
 * filtered, or a browser whose rows carry no id at all.
 */

import {
  createIdleWriter,
  type IdleWriter,
  type IdleWriterEnv,
} from "./idleWriter.ts";

/** Within this of the top there is nothing worth remembering — that is the default. */
export const LIST_SCROLL_TOP_PX = 4;

export interface ListScrollAnchor {
  /** `data-list-row-id` of the first row still visible at the top edge. */
  rowId: string;
  /** Distance from the container's top edge to that row's top, in px (usually negative). */
  offset: number;
}

export interface ListScrollPosition {
  scrollTop: number;
  anchor?: ListScrollAnchor;
}

export interface ListScrollMemoryEntry extends ListScrollPosition {
  listKey: string;
  savedAt: number;
}

export interface ListScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function maxScrollTop(metrics: ListScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

export function clampScrollTop(
  value: number,
  metrics: ListScrollMetrics,
): number {
  return Math.max(0, Math.min(value, maxScrollTop(metrics)));
}

/**
 * What to remember for this list, or `null` for "nothing" — a list resting at
 * its top is the state every list opens in, so storing it would only keep a
 * stale entry alive.
 */
export function positionToRemember(
  metrics: ListScrollMetrics,
  anchor: ListScrollAnchor | null,
): ListScrollPosition | null {
  if (metrics.clientHeight === 0) return null;
  if (metrics.scrollTop <= LIST_SCROLL_TOP_PX) return null;
  return {
    scrollTop: metrics.scrollTop,
    ...(anchor ? { anchor } : {}),
  };
}

/**
 * Where to scroll so the anchored row sits at the offset it was left at.
 * `rowTop` and `containerTop` are viewport coordinates, so the correction is
 * relative to wherever the container currently rests.
 */
export function anchorScrollTop(
  metrics: ListScrollMetrics,
  containerTop: number,
  rowTop: number,
  wantedOffset: number,
): number {
  return clampScrollTop(
    metrics.scrollTop + (rowTop - containerTop - wantedOffset),
    metrics,
  );
}

/** The pixel fallback: the remembered offset, as far as the content allows. */
export function fallbackScrollTop(
  position: ListScrollPosition,
  metrics: ListScrollMetrics,
): number {
  return clampScrollTop(position.scrollTop, metrics);
}

/**
 * Whether the content is already tall enough to hold the remembered position.
 * A list fills in after its container mounts (a Knowledge tree is fetched, a
 * Backlog subscription answers), and a restore against a short list would clamp
 * to a wrong offset and call itself done — so a retry that has neither its
 * anchor row nor the height for the fallback is not a failure yet.
 */
export function canReach(
  position: ListScrollPosition,
  metrics: ListScrollMetrics,
): boolean {
  return maxScrollTop(metrics) >= position.scrollTop - 1;
}

/** Whether the container already rests where the restore wants it. */
export function isAtScrollTop(
  metrics: ListScrollMetrics,
  target: number,
): boolean {
  return Math.abs(metrics.scrollTop - target) <= 1;
}

export const LIST_SCROLL_KEY = "assistant.listScroll.v1";
/** Lists whose position is kept. Older entries fall off the end. */
export const LIST_SCROLL_LIMIT = 24;

export interface ListScrollStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function validAnchor(value: unknown): ListScrollAnchor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const anchor = value as Record<string, unknown>;
  if (typeof anchor.rowId !== "string" || !anchor.rowId) return undefined;
  if (!Number.isFinite(anchor.offset)) return undefined;
  return { rowId: anchor.rowId, offset: Number(anchor.offset) };
}

export function parseListScrollMemory(
  raw: string | null,
): ListScrollMemoryEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: ListScrollMemoryEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.listKey !== "string" || !record.listKey) continue;
    if (!Number.isFinite(record.savedAt)) continue;
    if (!Number.isFinite(record.scrollTop)) continue;
    const anchor = validAnchor(record.anchor);
    entries.push({
      listKey: record.listKey,
      savedAt: Number(record.savedAt),
      scrollTop: Math.max(0, Number(record.scrollTop)),
      ...(anchor ? { anchor } : {}),
    });
  }
  return entries.slice(0, LIST_SCROLL_LIMIT);
}

/** Newest first, one entry per list, bounded. */
export function rememberListScroll(
  entries: readonly ListScrollMemoryEntry[],
  entry: ListScrollMemoryEntry,
): ListScrollMemoryEntry[] {
  return [
    entry,
    ...entries.filter((item) => item.listKey !== entry.listKey),
  ].slice(0, LIST_SCROLL_LIMIT);
}

export interface ListScrollMemory {
  read(listKey: string): ListScrollPosition | undefined;
  save(listKey: string, position: ListScrollPosition): void;
  forget(listKey: string): void;
  /** Write any deferred change now (unmount, `pagehide`, tab hidden). */
  flush(): void;
}

export interface ListScrollMemoryOptions {
  storage: ListScrollStorage | null;
  now?: () => number;
  writerEnv?: IdleWriterEnv;
}

/**
 * A list's position is browser-local and deliberately not shared across tabs:
 * two tabs browsing the same section share one entry and the last write wins.
 * Written through `idleWriter` because a scroll can produce one candidate per
 * frame.
 */
export function createListScrollMemory(
  options: ListScrollMemoryOptions,
): ListScrollMemory {
  const { storage } = options;
  const now = options.now ?? (() => Date.now());
  let entries: ListScrollMemoryEntry[] | null = null;

  const load = (): ListScrollMemoryEntry[] => {
    if (entries) return entries;
    let raw: string | null = null;
    try {
      raw = storage?.getItem(LIST_SCROLL_KEY) ?? null;
    } catch {
      raw = null;
    }
    entries = parseListScrollMemory(raw);
    return entries;
  };

  const writer: IdleWriter<ListScrollMemoryEntry[]> = createIdleWriter(
    (value) => {
      try {
        storage?.setItem(LIST_SCROLL_KEY, JSON.stringify(value));
      } catch {
        // Best-effort: a full or blocked storage costs the position, not the list.
      }
    },
    {
      delayMs: 400,
      maxDelayMs: 2000,
      idleTimeoutMs: 1000,
      ...(options.writerEnv ? { env: options.writerEnv } : {}),
    },
  );

  return {
    read(listKey) {
      const entry = load().find((item) => item.listKey === listKey);
      if (!entry) return undefined;
      return {
        scrollTop: entry.scrollTop,
        ...(entry.anchor ? { anchor: entry.anchor } : {}),
      };
    },
    save(listKey, position) {
      entries = rememberListScroll(load(), {
        listKey,
        savedAt: now(),
        ...position,
      });
      writer.schedule(entries);
    },
    forget(listKey) {
      const current = load();
      if (!current.some((item) => item.listKey === listKey)) return;
      entries = current.filter((item) => item.listKey !== listKey);
      writer.schedule(entries);
    },
    flush() {
      writer.flush();
    },
  };
}

let sharedMemory: ListScrollMemory | null = null;

/**
 * ONE memory for the whole app, at module level: on a phone the entire object
 * browser is unmounted while any object screen is open (`AppShell` renders the
 * left panel only on a browser route), so a position held in component state
 * would already be gone by the time the reader comes back — which is exactly
 * the complaint this exists for.
 */
export function listScrollMemory(): ListScrollMemory {
  if (sharedMemory) return sharedMemory;
  let storage: ListScrollStorage | null = null;
  try {
    storage = typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Private-mode/blocked storage: the position then lives for this page only.
    storage = null;
  }
  sharedMemory = createListScrollMemory({ storage });
  return sharedMemory;
}
