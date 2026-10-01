/**
 * The runtime-native vocabulary, shared by server and client (Phase 2). The
 * transport ships a {@link ClientSessionSnapshot} on attach, then one
 * {@link ClientRuntimeEvent} per frame; the client reducer applies them to a
 * keyed snapshot (entries by `id`/`seq`, streams by `streamId`).
 *
 * Two vocabularies live here on purpose. {@link RuntimeEvent} is what the
 * runtime EMITS: full bodies, raw durable entries. {@link ClientRuntimeEvent}
 * is what a viewer RECEIVES: the transport projects one onto the other, and
 * the projection is where verbose bodies are withheld (`docs/reference/
 * server-session.md`, "Live body projection").
 *
 * Lives in the shared root (not `./session`) because `passthrough` carries a
 * {@link ServerMessage} and the host-command cards reference the wire render types
 * (`CommitDisplay`/`CompactionDisplay`). `./session` stays a dependency-free leaf.
 */
import type {
  CommitDisplay,
  CompactionDisplay,
  ContextClearDisplay,
  PushDisplay,
  ServerMessage,
  WorktreeProvisionDisplay,
} from "./protocol.ts";
import type {
  LiveBodyKey,
  LiveBodyRef,
  SessionConfig,
  SessionEntry,
  SessionEntryEnvelope,
  SnapshotRunState,
  StreamingEntry,
} from "./session/index.ts";
import type { TurnStatsSeed } from "./turnStats.ts";

/** A text/thinking token delta for an in-flight assistant message. */
export interface MessageDelta {
  kind: "text" | "thinking";
  text: string;
}

/**
 * A durable host-command card (`/commit`, `/push`, `/compact`, `/clear`).
 * Intentionally references the wire render types rather than the
 * provider-neutral `AgentContentBlock` model.
 *
 * `/pr` is deliberately ABSENT: its card is store-driven (`pullRequestCards.ts`,
 * mirroring `ApprovalCard`) so it can keep changing after creation, and is
 * injected into snapshots rather than persisted as one of these terminal cards.
 */
export type HostCommandCard =
  | { kind: "commit"; id: string; commit: CommitDisplay }
  | { kind: "push"; id: string; push: PushDisplay }
  | { kind: "compaction"; id: string; compaction: CompactionDisplay }
  | { kind: "contextClear"; id: string; contextClear: ContextClearDisplay }
  | {
      kind: "worktreeProvision";
      id: string;
      provision: WorktreeProvisionDisplay;
    };

/**
 * The client projection of a durable host-command card, carried alongside the
 * conversation entries in the ordered {@link ClientTimelineEntry} stream so a
 * reconnecting client re-renders `/commit`/`/compact` cards.
 */
export type HostCommandClientEntry = SessionEntryEnvelope & {
  type: "command.result";
  name: string;
  card: HostCommandCard;
};

/** The full ordered client timeline: conversation entries + host-command cards. */
export type ClientTimelineEntry = SessionEntry | HostCommandClientEntry;

export function isHostCommandClientEntry(
  entry: ClientTimelineEntry,
): entry is HostCommandClientEntry {
  return entry.type === "command.result";
}

/**
 * The runtime-native chat-load payload the transport ships on attach. Unlike the
 * server-internal {@link SessionSnapshot} (whose `entries` are conversation-only),
 * this carries the full client TIMELINE (conversation + host-command cards) so a
 * reconnecting client re-renders `/commit`/`/compact` cards, plus the in-flight
 * streams and run state. The client reducer keys its timeline on this.
 */
export const SESSION_TIMELINE_PROJECTION_VERSION = 2;

/**
 * A browser's durable RANGE of one lazily-projected timeline: the entries at
 * `[startIndex, startIndex + entryCount)` of the server's projection. The server
 * only sends a tail delta when this anchor still matches that projection;
 * otherwise it falls back to a fresh windowed snapshot.
 *
 * `startIndex` is what makes a windowed cache safe: a browser that only ever saw
 * the tail of a long session holds a range that starts mid-timeline, and a
 * descriptor without it would be read as a prefix from zero and spliced wrong.
 */
export interface TimelineCacheDescriptor {
  projectionVersion: number;
  /** Absolute index of the first described entry in the server's projection. */
  startIndex: number;
  entryCount: number;
  lastEntryId: string | null;
  lastEntrySeq: number | null;
  /** Deterministic checksum of every projected entry in the range. */
  fingerprint: string;
}

/**
 * Describe a contiguous RANGE of a timeline. `range` holds the entries
 * themselves; `startIndex` is where they sit in the server's full projection.
 */
export function describeTimelineCache(
  range: readonly ClientTimelineEntry[],
  startIndex = 0,
): TimelineCacheDescriptor {
  const last = range.at(-1);
  return {
    projectionVersion: SESSION_TIMELINE_PROJECTION_VERSION,
    startIndex,
    entryCount: range.length,
    lastEntryId: last?.id ?? null,
    lastEntrySeq: last?.seq ?? null,
    fingerprint: timelineFingerprint(range, 0, range.length),
  };
}

/** Describe the range `[startIndex, end)` of an already-projected timeline. */
export function describeTimelineRange(
  timeline: readonly ClientTimelineEntry[],
  startIndex: number,
  end = timeline.length,
): TimelineCacheDescriptor {
  return describeTimelineCache(timeline.slice(startIndex, end), startIndex);
}

export function timelineMatchesCacheDescriptor(
  timeline: readonly ClientTimelineEntry[],
  descriptor: TimelineCacheDescriptor,
): boolean {
  if (descriptor.projectionVersion !== SESSION_TIMELINE_PROJECTION_VERSION)
    return false;
  if (
    !Number.isInteger(descriptor.startIndex) ||
    descriptor.startIndex < 0 ||
    !Number.isInteger(descriptor.entryCount) ||
    descriptor.entryCount < 0 ||
    descriptor.startIndex + descriptor.entryCount > timeline.length
  )
    return false;
  if (descriptor.entryCount === 0) {
    return (
      descriptor.startIndex === 0 &&
      descriptor.lastEntryId === null &&
      descriptor.lastEntrySeq === null &&
      descriptor.fingerprint === timelineFingerprint(timeline, 0, 0)
    );
  }
  const end = descriptor.startIndex + descriptor.entryCount;
  const last = timeline[end - 1];
  return (
    last?.id === descriptor.lastEntryId &&
    last.seq === descriptor.lastEntrySeq &&
    descriptor.fingerprint ===
      timelineFingerprint(timeline, descriptor.startIndex, end)
  );
}

function timelineFingerprint(
  timeline: readonly ClientTimelineEntry[],
  start: number,
  end: number,
): string {
  // FNV-1a is not a security boundary; it cheaply detects stale/corrupt local
  // projection content while the stable version + id/seq anchor enforce shape.
  let hash = 0x811c9dc5;
  for (let i = start; i < end; i += 1) {
    const json = JSON.stringify(timeline[i]);
    for (let j = 0; j < json.length; j += 1) {
      hash ^= json.charCodeAt(j);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Entries in an uncached session's snapshot. The transcript renders 120 rows and
 * grows by 240 per "load earlier", so a light session keeps the render window
 * plus one step locally available while a 2,700-entry one stops shipping
 * megabytes.
 */
export const SNAPSHOT_TIMELINE_WINDOW_ENTRIES = 400;

/**
 * Second bound on the same window, because entries differ in size by an order of
 * magnitude: on real sessions 400 projected entries measured anywhere from
 * 436 KB to 873 KB. Entry count decides how much CONVERSATION is available, this
 * decides how much PAYLOAD, and whichever is reached first stops the window — so
 * a heavy session trades rows for bytes and reaches for a range one step sooner.
 *
 * Two documented over-runs exist: {@link SNAPSHOT_TIMELINE_MIN_ENTRIES} (bytes
 * only, capped at its own entry count) and the renderability floor in
 * `renderableStart`, which may exceed this budget AND the entry budget — a
 * renderable slice outranks both. Nothing else may.
 */
export const SNAPSHOT_TIMELINE_WINDOW_BYTES = 180_000;

/**
 * Entries a window always carries even when they blow the byte budget: a
 * snapshot too small to fill the first screen would just turn into an immediate
 * range request. Together with the renderability floor (`renderableStart`),
 * this is one of the only two things that may push a window past
 * {@link SNAPSHOT_TIMELINE_WINDOW_BYTES}, and it caps its own over-run at this
 * many entries.
 */
export const SNAPSHOT_TIMELINE_MIN_ENTRIES = 130;

/** Entries one `loadTimelineRange` answers with, unless the client asks for fewer. */
export const TIMELINE_RANGE_LIMIT = 240;

/** The same payload bound for a range; one "load earlier" is one screenful of work. */
export const TIMELINE_RANGE_BYTES = 180_000;

/**
 * Entries a range carries regardless, so a fat session still makes progress —
 * and, with the renderability floor, a permitted over-run of
 * {@link TIMELINE_RANGE_BYTES}.
 */
export const TIMELINE_RANGE_MIN_ENTRIES = 40;

/** Hard ceiling on one range, so a hostile/buggy request cannot ask for the world. */
export const TIMELINE_RANGE_MAX_LIMIT = 1000;

/**
 * Whether an entry STARTS a rendered turn, i.e. is a visible user prompt. A
 * window or range prefers to start at one: cutting mid-turn orphans that turn's
 * tool results (their declaring assistant entry is outside the slice, so the
 * display projection drops them) and leaves a turn FRAGMENT whose stats are not
 * the turn's. A hidden user entry is not a boundary — the display projection
 * skips it, so it starts no rendered turn.
 */
export function timelineEntryStartsTurn(
  entry: ClientTimelineEntry | undefined,
): boolean {
  return (
    entry !== undefined &&
    entry.type === "message" &&
    entry.role === "user" &&
    entry.hidden !== true
  );
}

/**
 * Whether the slice `[start, end)` holds anything the display projection renders
 * ON ITS OWN: a visible user prompt, an assistant entry, or a host-command card.
 * A slice of nothing but tool results whose declaring assistant entry sits
 * before `start` projects to ZERO display messages — the transcript is blank on
 * a session that has content — so this is the predicate every slice handed to a
 * client must satisfy, whether it comes from the budget walk (which extends it
 * through {@link renderableStart}) or from a browser's persisted cache RANGE
 * (which the server drops instead, falling back to the window).
 *
 * Structural by design: it stays O(slice) with no allocation, so a hot attach
 * path can ask it about a multi-thousand-entry range. The one divergence from
 * the projection is a host-command card of a kind this build no longer knows —
 * counted here, dropped there.
 */
export function timelineRangeIsRenderable(
  timeline: readonly ClientTimelineEntry[],
  start = 0,
  end = timeline.length,
): boolean {
  for (let i = Math.max(0, start); i < end; i += 1) {
    const entry = timeline[i]!;
    if (entry.type === "command.result") return true;
    if (entry.role === "assistant") return true;
    if (entry.role === "user" && entry.hidden !== true) return true;
  }
  return false;
}

/**
 * The floor that keeps a slice RENDERABLE. A budget cut can land inside a long
 * tool loop such that the slice holds nothing but tool results: their declaring
 * assistant entry sits before `start`, the display projection drops every
 * orphan, and the transcript shows ZERO messages — the client then treats a
 * session that has content as empty. When a slice contains no entry that
 * renders on its own ({@link timelineRangeIsRenderable}), extend it back to the
 * NEAREST assistant entry declaring ANY of the slice's calls — not a specific
 * result's, so one undeclared call (a truncated or compacted head) cannot
 * defeat the floor. A renderable slice outranks BOTH budgets: the over-run may
 * exceed `maxBytes` and, when the orphan run is longer than the window,
 * `maxEntries` too; its size is the tail of ONE turn — the declaring entry plus
 * the results between it and the budget frontier (measured about 2x `maxBytes`
 * at worst on real sessions, see `docs/reference/shared-protocol.md`).
 */
function renderableStart(
  timeline: readonly ClientTimelineEntry[],
  start: number,
  end: number,
): number {
  if (start <= 0) return start;
  if (timelineRangeIsRenderable(timeline, start, end)) return start;
  const orphanCallIds = new Set<string>();
  for (let i = start; i < end; i += 1) {
    const entry = timeline[i]!;
    if (entry.type === "message" && entry.role === "toolResult")
      orphanCallIds.add(entry.toolCallId);
  }
  if (orphanCallIds.size === 0) return start;
  // Ownership is the LAST assistant entry declaring a call before its result
  // (`displayMapping.ts`). Reaching this walk means the slice holds no
  // assistant entry at all, so the nearest declarer of any of its calls IS
  // those calls' owner — and the smallest extension that renders.
  for (let i = start - 1; i >= 0; i -= 1) {
    const entry = timeline[i]!;
    if (entry.type !== "message" || entry.role !== "assistant") continue;
    for (const block of entry.content)
      if (block.type === "toolCall" && orphanCallIds.has(block.toolCallId))
        return i;
  }
  return start;
}

/**
 * Walk back from `end` while the slice stays within BOTH bounds, and start at
 * the FURTHEST-back turn boundary that fit. Budget first, boundary second: the
 * snap never adds an entry (and therefore never a byte) beyond what the walk
 * already paid for, which is what makes `maxBytes` an actual bound.
 *
 * Two cases return a MID-TURN start, and both are deliberate:
 * - a single turn longer than the budget (a very long tool loop) — starting at
 *   its prompt would put the whole turn on the wire, which is the cost this
 *   exists to avoid;
 * - a turn boundary so close to `end` that starting there would leave less than
 *   `minEntries` — a three-entry window is not worth a clean boundary.
 * Callers must therefore treat a leading turn as possibly PARTIAL; the seed
 * (`turnStatsSeedForWindow`) says when it is, and the renderer suppresses that
 * turn's stats row rather than showing a fragment's numbers as a turn's.
 *
 * Two floors outrank the budgets: the entry floor beats `maxBytes` (a slice too
 * small to fill the reader's screen would only be asked for again), and the
 * renderability floor (`renderableStart` — a slice of nothing but orphan tool
 * results renders as an empty transcript) beats both `maxBytes` and
 * `maxEntries`.
 */
function boundedStart(
  timeline: readonly ClientTimelineEntry[],
  end: number,
  maxEntries: number,
  maxBytes: number,
  minEntries: number,
): number {
  let frontier = end;
  let bytes = 0;
  let turnStart = -1;
  while (frontier > 0) {
    const candidate = frontier - 1;
    const kept = end - candidate;
    if (kept > maxEntries) break;
    const size = JSON.stringify(timeline[candidate]).length;
    if (kept > minEntries && bytes + size > maxBytes) break;
    bytes += size;
    frontier = candidate;
    if (timelineEntryStartsTurn(timeline[candidate])) turnStart = candidate;
  }
  if (frontier === 0) return 0;
  const start =
    turnStart >= 0 && end - turnStart >= minEntries ? turnStart : frontier;
  return renderableStart(timeline, start, end);
}

/**
 * Index of the first entry an uncached snapshot carries: the bounded tail of the
 * timeline, at a turn boundary whenever one fits the budget.
 */
export function timelineWindowStart(
  timeline: readonly ClientTimelineEntry[],
  windowEntries: number = SNAPSHOT_TIMELINE_WINDOW_ENTRIES,
  windowBytes: number = SNAPSHOT_TIMELINE_WINDOW_BYTES,
): number {
  return boundedStart(
    timeline,
    timeline.length,
    windowEntries,
    windowBytes,
    Math.min(windowEntries, SNAPSHOT_TIMELINE_MIN_ENTRIES),
  );
}

/**
 * Index of the first entry a "load older" range carries: the bounded slice
 * before `end`, at a turn boundary whenever one fits the budget.
 */
export function timelineRangeStart(
  timeline: readonly ClientTimelineEntry[],
  end: number,
  limit: number = TIMELINE_RANGE_LIMIT,
  maxBytes: number = TIMELINE_RANGE_BYTES,
): number {
  // The connection validates the client's `limit`, but this is exported: a
  // non-positive one would otherwise answer an empty range forever.
  const entries =
    Number.isInteger(limit) && limit > 0 ? limit : TIMELINE_RANGE_LIMIT;
  return boundedStart(
    timeline,
    Math.max(0, Math.min(end, timeline.length)),
    entries,
    maxBytes,
    Math.min(entries, TIMELINE_RANGE_MIN_ENTRIES),
  );
}

export interface ClientSessionSnapshot {
  sessionId: string;
  runState: SnapshotRunState;
  /**
   * The entries the browser does not already hold: the windowed tail of the
   * timeline, or — when the server accepted a `timelineBase` — only the entries
   * appended after that cached range.
   */
  timeline: ClientTimelineEntry[];
  /** Absolute index of `timeline[0]` in the server's full projection. */
  timelineStart: number;
  /** Entries in the server's full projection (what `timelineStart` counts into). */
  totalEntryCount: number;
  /** Cached range the server accepted; the browser prepends its own rows to it. */
  timelineBase?: TimelineCacheDescriptor;
  /** Anchor the browser persists for the range it renders after reconstruction. */
  timelineCache?: TimelineCacheDescriptor;
  /**
   * Server-computed turn stats for everything BEFORE the rendered range, so a
   * windowed transcript's Session cumulative and context delta stay honest.
   * Absent when the range starts at zero (nothing precedes it).
   */
  turnStatsSeed?: TurnStatsSeed;
  streaming: StreamingEntry[];
}

export type RuntimeEvent =
  // ---- transient live streams (not persisted) ----
  | { type: "messageStarted"; streamId: string }
  | { type: "messageDelta"; streamId: string; delta: MessageDelta }
  | { type: "messageCompleted"; streamId: string }
  | {
      type: "toolStarted";
      streamId: string;
      toolCallId: string;
      name: string;
      input?: unknown;
    }
  | { type: "toolUpdated"; streamId: string; output: string }
  | { type: "toolCompleted"; streamId: string }
  // ---- durable + lifecycle ----
  /**
   * A durable entry was appended. `clientRequestId` echoes the submitting client's
   * token ONLY on the originating user entry, for optimistic reconciliation; it is
   * absent on assistant/tool entries.
   */
  | { type: "entryAppended"; entry: SessionEntry; clientRequestId?: string }
  /**
   * A durable host-command card (`/commit`/`/compact`) was appended. The live card
   * was already forwarded via `passthrough`; this drives the durable timeline + the
   * reconnect snapshot, and lets the transport CLOSE the synthetic streaming turn.
   */
  | { type: "hostCommandAppended"; entry: HostCommandClientEntry }
  | { type: "runStateChanged"; runState: SnapshotRunState }
  | { type: "sessionConfigChanged"; config: SessionConfig }
  /** Transport-only failed/aborted run status (the durable recovery markers are separate). */
  | { type: "runStatus"; status: "error" | "aborted"; message?: string }
  /** Transport-only verbatim wire envelope (live toolEnd + host-command result cards). */
  | { type: "passthrough"; envelope: ServerMessage };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

/**
 * What a VIEWER receives: the runtime vocabulary with every verbose body taken
 * out of the event stream.
 *
 * - Text deltas stream as before; they are the answer being read.
 * - A thinking block or tool output is announced and kept current by
 *   `liveBodyProgress` (its ref: index, length, lines), never by its text. Text
 *   arrives only as `liveBody` frames, and only for bodies the viewer has
 *   subscribed to — a `replace` snapshot on subscribe, then `append` deltas
 *   whose `offset` is the length the viewer must already hold.
 * - `toolEnded` is the projected stand-in for the live `toolEnd` envelope. A
 *   generic result carries only status and size; a visible rich card carries
 *   the exact fields that card reads.
 * - Durable rows arrive as `timelineDelta`: every entry the append touched,
 *   projected exactly as a reconnect snapshot projects it (lazy bodies, rich-
 *   card payloads whole), so a live turn leaves the browser holding the same
 *   compact timeline a reload would hand it. A viewer that held a body live
 *   carries its hydrated text over to the durable block itself (the lengths
 *   match by construction), so nothing is sent twice and nothing flashes.
 */
export type ClientRuntimeEvent =
  | { type: "messageStarted"; streamId: string }
  | {
      type: "messageDelta";
      streamId: string;
      delta: { kind: "text"; text: string };
    }
  | { type: "messageCompleted"; streamId: string }
  | {
      type: "toolStarted";
      streamId: string;
      toolCallId: string;
      name: string;
      input?: unknown;
      inputSummary?: string;
      inputLive?: LiveBodyRef;
    }
  | { type: "toolCompleted"; streamId: string }
  /** Projected completion of a live tool (the former `toolEnd` passthrough). */
  | {
      type: "toolEnded";
      streamId: string;
      isError: boolean;
      /** Exact text for an output-reading rich card; otherwise a compact ref. */
      output: string | LiveBodyRef;
      /** Marks a visible rich card, including cards that do not read output. */
      card?: true;
      /** Exact arguments only when the visible card reads them. */
      input?: unknown;
    }
  /** A live body exists / grew: its ref, no text. */
  | { type: "liveBodyProgress"; ref: LiveBodyRef }
  /** Subscribed body text. `replace` resets to `text`; `append` extends at `offset`. */
  | {
      type: "liveBody";
      key: LiveBodyKey;
      mode: "replace" | "append";
      offset: number;
      /** The text (thinking/output) or JSON value (`toolInput`, always `replace`). */
      content: unknown;
      /** Body length after applying this frame. */
      length: number;
      /** Current line count when the server already tracks it. */
      lineCount?: number;
    }
  | {
      type: "timelineDelta";
      entries: ClientTimelineEntry[];
      /** Echoed on the originating user entry only (optimistic reconciliation). */
      clientRequestId?: string;
    }
  | { type: "hostCommandAppended"; entry: HostCommandClientEntry }
  | { type: "runStateChanged"; runState: SnapshotRunState }
  | { type: "sessionConfigChanged"; config: SessionConfig }
  | { type: "runStatus"; status: "error" | "aborted"; message?: string }
  /** Verbatim host-command result cards only; `toolEnd` never passes through. */
  | { type: "passthrough"; envelope: ServerMessage };
