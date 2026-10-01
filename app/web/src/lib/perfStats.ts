/**
 * Dev-only performance counters: what the socket delivers, and what React
 * commits because of it.
 *
 * The client's cost is dominated by two things that are invisible while using
 * the app — how much of which server message type arrives per second, and which
 * subtrees re-render for it. Both were previously found by instrumenting the
 * code by hand for one investigation and then removing it again, so the numbers
 * were never comparable between two changes. This keeps a rolling one-second
 * window of both, cheaply enough to leave on in dev.
 *
 * Recording is a no-op unless {@link setPerfStatsEnabled} turned it on, so the
 * production bundle pays a boolean per message and nothing else.
 */

interface PerfMessageStat {
  type: string;
  count: number;
  /** UTF-8 bytes on the wire (a JS string length under-counts non-ASCII). */
  bytes: number;
  /** Time spent in `JSON.parse` for these frames, in ms. */
  parseMs: number;
}

/**
 * One session load, as four points in time: the load was asked for, its
 * snapshot frame was parsed, the transcript committed it, the browser painted
 * that commit. The gaps between them are the cost the reader waits through.
 */
interface SessionLoadTrace {
  sessionId: string;
  requestAt: number;
  snapshotParsedAt?: number;
  committedAt?: number;
  paintedAt?: number;
}

export interface PerfSnapshot {
  /** Length of the window these counts cover, in ms. */
  windowMs: number;
  messages: PerfMessageStat[];
  totalCount: number;
  totalBytes: number;
  totalParseMs: number;
  /** Render (commit) counts per instrumented component, over the same window. */
  renders: Array<{ name: string; count: number; durationMs: number }>;
  /** The most recent session load, complete or still in flight. */
  sessionLoad: SessionLoadTrace | null;
}

interface Sample {
  at: number;
  type: string;
  bytes: number;
  parseMs: number;
}

const WINDOW_MS = 1000;

let enabled = false;
let samples: Sample[] = [];
let renders: Array<{ at: number; name: string; durationMs: number }> = [];
let sessionLoad: SessionLoadTrace | null = null;
const listeners = new Set<() => void>();

/** UTF-8 length of a string without encoding it (no second copy of a large frame). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair is one 4-byte code point.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function perfStatsEnabled(): boolean {
  return enabled;
}

export function setPerfStatsEnabled(next: boolean): void {
  enabled = next;
  if (!next) {
    samples = [];
    renders = [];
    sessionLoad = null;
  }
  for (const listener of listeners) listener();
}

export function subscribePerfStats(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Record one inbound server message: its wire size and what parsing it cost. */
export function recordServerMessage(
  type: string,
  bytes: number,
  parseMs = 0,
): void {
  if (!enabled) return;
  samples.push({ at: Date.now(), type, bytes, parseMs });
}

/** Record one React commit of an instrumented component, with its duration when measured. */
export function recordRender(name: string, durationMs = 0): void {
  if (!enabled) return;
  renders.push({ at: Date.now(), name, durationMs });
}

/**
 * Mark a point of the current session load. `request` opens a new trace (an
 * earlier unfinished one is dropped); the other marks land on the open trace
 * for the same session, in order, and are ignored otherwise.
 */
export function recordSessionLoadMark(
  mark: "request" | "snapshotParsed" | "committed" | "painted",
  sessionId: string,
  at = performance.now(),
): void {
  if (!enabled) return;
  if (mark === "request") {
    sessionLoad = { sessionId, requestAt: at };
    return;
  }
  if (!sessionLoad || sessionLoad.sessionId !== sessionId) return;
  if (mark === "snapshotParsed" && sessionLoad.snapshotParsedAt === undefined)
    sessionLoad.snapshotParsedAt = at;
  else if (
    mark === "committed" &&
    sessionLoad.snapshotParsedAt !== undefined &&
    sessionLoad.committedAt === undefined
  )
    sessionLoad.committedAt = at;
  else if (
    mark === "painted" &&
    sessionLoad.committedAt !== undefined &&
    sessionLoad.paintedAt === undefined
  )
    sessionLoad.paintedAt = at;
}

/**
 * Count this component's commits while the HUD is on.
 *
 * Called during RENDER rather than in an effect: work React later discards
 * still cost what this measures. It lives here rather than with the HUD so an
 * instrumented component does not pull the overlay into its chunk.
 */
export function usePerfRenderCount(name: string): void {
  recordRender(name);
}

export function perfSnapshot(now = Date.now()): PerfSnapshot {
  const cutoff = now - WINDOW_MS;
  samples = samples.filter((sample) => sample.at >= cutoff);
  renders = renders.filter((render) => render.at >= cutoff);

  const byType = new Map<string, PerfMessageStat>();
  let totalCount = 0;
  let totalBytes = 0;
  let totalParseMs = 0;
  for (const sample of samples) {
    const stat = byType.get(sample.type) ?? {
      type: sample.type,
      count: 0,
      bytes: 0,
      parseMs: 0,
    };
    stat.count += 1;
    stat.bytes += sample.bytes;
    stat.parseMs += sample.parseMs;
    byType.set(sample.type, stat);
    totalCount += 1;
    totalBytes += sample.bytes;
    totalParseMs += sample.parseMs;
  }

  const byName = new Map<string, { count: number; durationMs: number }>();
  for (const render of renders) {
    const held = byName.get(render.name) ?? { count: 0, durationMs: 0 };
    held.count += 1;
    held.durationMs += render.durationMs;
    byName.set(render.name, held);
  }

  return {
    windowMs: WINDOW_MS,
    messages: [...byType.values()].sort((a, b) => b.bytes - a.bytes),
    totalCount,
    totalBytes,
    totalParseMs,
    renders: [...byName.entries()]
      .map(([name, held]) => ({ name, ...held }))
      .sort((a, b) => b.count - a.count),
    sessionLoad: sessionLoad ? { ...sessionLoad } : null,
  };
}
