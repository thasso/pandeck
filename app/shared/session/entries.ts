/**
 * The CLIENT projection of a durable session entry — the public, harness-neutral
 * timeline unit. Server-only fields (native ids, raw provider payloads) are
 * stripped here; the server projection (server-side only) retains them.
 *
 * Identity is **per session**: `(sessionId, id)` and `(sessionId, seq)` are NOT
 * global. A fork copies prefix entries into the child keeping their `id`/`seq`.
 * `seq` is strictly increasing but **not gapless** (forks leave gaps); consumers
 * must not assume contiguity.
 */
import type {
  AgentContentBlock,
  AgentStopReason,
  AgentUsage,
} from "./content.ts";
import type { PromptOrigin } from "./origin.ts";
import type { PeerPromptCard } from "../protocol.ts";

/**
 * Where a copied entry was originally produced. A fork copies its parent's
 * prefix keeping every `id`, so this addresses the SAME entry in that session
 * and is what a "jump to the original" link resolves. A fork of a fork keeps
 * the ORIGINAL session, not the intermediate one: the message was written
 * there, and its id is valid in every descendant.
 */
export interface SessionEntryOrigin {
  sessionId: string;
  entryId: string;
}

export interface SessionEntryEnvelope {
  /** Unique within the session. */
  id: string;
  /** Total order within the session, assigned by the store on append. */
  seq: number;
  /** ISO-8601 persistence time. Ordering is by `seq`, not this. */
  createdAt: string;
  /**
   * Set on entries this session INHERITED from the session it was forked out
   * of, rather than produced itself. It marks the fork boundary for the
   * transcript; absent on every entry of an unforked session.
   */
  inheritedFrom?: SessionEntryOrigin;
  /**
   * This entry is bound to a native message, so a fork can be cut at it. The
   * anchor itself is server-only; this is the boolean the transcript needs to
   * decide whether to offer the action at all. Absent on entries recorded
   * before their harness captured anchors — those can never be forked.
   */
  forkable?: true;
}

/**
 * How a prompt sent WHILE a turn was running reached the model. `steer`: the
 * running turn took it at its next step. `followUp`: it arrived after that
 * turn's final reply, so the provider ran it as the next turn of the same run —
 * the model never saw it before answering, and the transcript must not say so.
 */
export type PromptDelivery = "steer" | "followUp";

/** A user prompt — one native message. */
type UserSessionEntry = SessionEntryEnvelope & {
  type: "message";
  role: "user";
  origin: PromptOrigin;
  /** Hidden prompts are persisted for provenance/fork/rebuild but skipped by chat rendering. */
  hidden?: boolean;
  /** Set only on a prompt sent while a turn was running. */
  delivery?: PromptDelivery;
  /**
   * Set on a delivered peer prompt (origin.kind === "agent"). Carries the
   * sanitized card the transcript renders INSTEAD of the raw delivery envelope
   * `content`, so opaque ids/reply syntax never appear in the timeline.
   */
  peerPrompt?: PeerPromptCard;
  content: AgentContentBlock[];
};

/** An assistant turn — text/thinking/toolCall blocks. Tool results are separate entries. */
type AssistantSessionEntry = SessionEntryEnvelope & {
  type: "message";
  role: "assistant";
  /** Present when the provider, rather than an app prompt, initiated this turn. */
  origin?: PromptOrigin;
  content: AgentContentBlock[];
  model?: string;
  stopReason?: AgentStopReason;
  /** Human-readable provider error retained on a failed turn, rendered in-chat. */
  error?: string;
  usage?: AgentUsage;
  /** ISO-8601 generation span; duration derived. */
  startedAt?: string;
  completedAt?: string;
};

/** A single tool result — its own `seq`-ordered entry, linked by `toolCallId`. */
type ToolResultSessionEntry = SessionEntryEnvelope & {
  type: "message";
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: AgentContentBlock[];
  isError?: boolean;
  /**
   * Rendering-only display diff with the file's REAL line numbers, when the
   * provider produced one (pi edit tools: `details.diff`). Never part of model
   * context; consumers must treat it as optional.
   */
  resultDiff?: string;
};

/** The public timeline unit. Bookkeeping entries are never projected to this. */
export type SessionEntry =
  UserSessionEntry | AssistantSessionEntry | ToolResultSessionEntry;
