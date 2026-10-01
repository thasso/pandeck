/**
 * The point-in-time view the transport serves a (re)connecting client: the
 * durable {@link SessionEntry}s plus any in-flight {@link StreamingEntry}s.
 * Reconnect is gap-free because completed messages arrive as durable entries and
 * the one still-generating message arrives as a streaming entry carrying
 * everything streamed so far.
 *
 * Transient streams are keyed by `streamId`; durable rows by `id`/`seq`. The
 * runtime removes a completed stream BEFORE broadcasting its durable replacement;
 * clients keep completed assistant streams visible until the replacement entry is
 * applied so the handoff is gap-free without rendering duplicate durable rows.
 */
import type { AgentContentBlock, LiveBodyRef } from "./content.ts";
import type { SessionEntry } from "./entries.ts";

export type SnapshotRunState = "idle" | "running";

/** A live, in-flight assistant message (token deltas accumulated in memory). */
export interface StreamingMessageEntry {
  streamId: string;
  kind: "message";
  role: "assistant";
  /** Content accumulated so far (text/thinking blocks; toolCall blocks open as tools start). */
  content: AgentContentBlock[];
}

/** A live, in-flight tool call (before its durable tool-result entry lands). */
export interface StreamingToolEntry {
  streamId: string;
  kind: "tool";
  toolCallId: string;
  name: string;
  input?: unknown;
  /** Wire projection only: the input was summarized; the full one is a live body. */
  inputLive?: LiveBodyRef;
  inputSummary?: string;
  /** Partial textual output streamed so far, when the provider streams it. */
  output?: string;
  /**
   * Wire projection only: the output body is omitted (or hydrated by
   * subscription); `length`/`lineCount` describe what the runtime holds.
   */
  outputLive?: LiveBodyRef;
  /**
   * Set when a live `toolEnd` arrives before the durable tool-result entry, so
   * snapshots/reconnects and the live projection can stop the tool's spinner
   * immediately (the runtime defers the durable `toolResult` until after the
   * assistant entry). Older clients may also set this from the passthrough event.
   */
  done?: boolean;
  isError?: boolean;
}

export type StreamingEntry = StreamingMessageEntry | StreamingToolEntry;

export interface SessionSnapshot {
  sessionId: string;
  runState: SnapshotRunState;
  entries: SessionEntry[];
  streaming: StreamingEntry[];
}
