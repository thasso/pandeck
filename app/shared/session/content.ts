/**
 * Provider-neutral content blocks for normalized session entries. It is
 * intentionally small: the durable log stores semantic content, not
 * provider-specific payloads.
 *
 * NOTE: this is distinct from the wire/render `DisplayBlock` in `protocol.ts`.
 * `DisplayBlock` is what the client renders TODAY; `AgentContentBlock` is the
 * normalized DURABLE unit. A pure mapper (`entriesToDisplayMessages`, added with
 * the transport layer) bridges the two so the renderer is untouched while the log
 * becomes authoritative.
 */

import { sha256Hex } from "./sha256.ts";

export type LazyBlockKind = "thinking" | "toolInput" | "toolOutput";

/**
 * Names one live body: a thinking block of the in-flight assistant message
 * (`blockIndex` into the stream's content), or a tool stream's input/output
 * (`blockIndex` 0). Transient like the stream itself — it is never persisted
 * and stops meaning anything once the stream's durable entry lands.
 */
export interface LiveBodyKey {
  streamId: string;
  blockIndex: number;
  /** The same kinds as a lazy block: a thinking body, a tool's input or output. */
  kind: LazyBlockKind;
}

/**
 * Reference to a live block body the wire projection OMITS. The runtime keeps
 * the full body; a viewer that renders it subscribes
 * (`setLiveBodySubscriptions`) and receives a replacement snapshot followed by
 * ordered deltas. `length`/`lineCount` are what a collapsed row shows and what
 * the client compares its hydrated copy against.
 */
export interface LiveBodyRef extends LiveBodyKey {
  /** Characters accumulated so far (JSON bytes for `toolInput`). */
  length: number;
  lineCount?: number;
}

/** One string per body, for sets and maps on both ends of the wire. */
export function liveBodyKeyId(key: LiveBodyKey): string {
  return `${key.kind}:${key.blockIndex}:${key.streamId}`;
}

/**
 * The identity of a body's text, computed identically by the server (on a lazy
 * ref) and the browser (on a body it holds live or hydrated). Equality is
 * treated as PROOF that the two texts are the same — a browser that finds it
 * drops the lazy ref, its only way back to the persisted body — so it has to
 * be collision-resistant: SHA-256 of the UTF-8 text, prefixed with the length.
 * A 32-bit checksum was tried first and collided on same-length twelve-byte
 * strings (`content.test.ts`).
 */
export function bodyContentHash(text: string): string {
  return `${text.length}:sha256:${sha256Hex(text)}`;
}

/**
 * Reference to a verbose block body omitted from a reconnect snapshot. The raw
 * append-only log remains authoritative; the client can request the full body by
 * entry id + content block index when the user expands the block.
 */
export interface LazyBlockRef {
  entryId: string;
  blockIndex: number;
  kind: LazyBlockKind;
  fullLength: number;
  previewLength: number;
  /** Deterministic identity of the omitted body, used to verify local hydration. */
  contentHash?: string;
  lineCount?: number;
  previewLineCount?: number;
}

/**
 * A block of an assistant turn or a user prompt. `lazy` (durable projection)
 * says "the log holds the full body"; `live` (in-flight projection) says "the
 * stream holds it". They never coexist on one block.
 */
export type AgentContentBlock =
  | { type: "text"; text: string; lazy?: LazyBlockRef }
  | { type: "thinking"; text: string; lazy?: LazyBlockRef; live?: LiveBodyRef }
  /** A tool invocation the assistant made (the *call*, not its result). */
  | {
      type: "toolCall";
      toolCallId: string;
      name: string;
      input: unknown;
      inputLazy?: LazyBlockRef;
      inputLive?: LiveBodyRef;
      inputSummary?: string;
    }
  /**
   * An attachment the user added to a prompt (an image OR any other file). The
   * durable log holds a REFERENCE, never raw bytes: `ref` points at the saved
   * attachment id (`DATA_DIR/attachments/<sessionId>/...`), so the log stays small
   * and replayable. `size`/`role` are metadata for rendering the attachment chip;
   * inline image preview (data/url) is a transport concern, not stored here.
   */
  | {
      type: "image";
      mimeType: string;
      name?: string;
      ref?: string;
      size?: number;
      role?: "task-context" | "project-context" | "file-context";
    };

/**
 * Token/cost accounting for ONE completed assistant run, when the provider
 * reports it. Values are the run's own usage (a delta), never a session
 * cumulative — consumers sum entries to get session totals.
 */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Real USD cost when the provider/model registry prices it; may be 0 for OAuth/subscription providers. */
  costUSD?: number;
  /**
   * Prompt-side context size AFTER this run (a snapshot, not a delta), when the
   * provider reports it. Distinct from `inputTokens` + cache fields, which sum
   * over the run's requests and therefore over-count a multi-request tool loop.
   */
  contextTokens?: number;
  /** The model's context window, when reported (drives the context meter). */
  contextWindowTokens?: number;
}

/** Why an assistant turn stopped, when reported. Provider-neutral superset. */
export type AgentStopReason =
  "end" | "toolUse" | "maxTokens" | "aborted" | "error";
