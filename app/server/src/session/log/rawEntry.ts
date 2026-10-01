/**
 * Raw, append-only log records — the INTERNAL source of truth of the log store.
 * Never exposed outside the `session/log` module: bookkeeping records (provider
 * bindings, audit, run/command markers) are projected out, and conversation
 * entries are projected into the client/server {@link SessionEntry} views.
 *
 * Conversation entries reuse the provider-neutral content model from
 * `@assistant/shared/session`; the store layers identity, ordering, and
 * bookkeeping on top.
 */
import type {
  AgentContentBlock,
  AgentStopReason,
  AgentUsage,
  PromptDelivery,
  PromptOrigin,
  SessionEntryOrigin,
} from "@assistant/shared/session";
import type { HostCommandCard } from "@assistant/shared/runtime";
import type { PeerPromptCard } from "@assistant/shared";

/**
 * A durable host-command result card (e.g. `/commit`, `/compact`) — the rich,
 * already-rendered payload the client shows. Defined in the shared package so the
 * wire's `hostCommandAppended` event and the client projection can reference it;
 * re-exported here for the server's existing imports.
 */
export type { HostCommandCard };

/** Common envelope shared by every raw log entry. Keys are `(sessionId, id)` and `(sessionId, seq)`. */
interface RawEntryBase {
  sessionId: string;
  /** Total order within the session, server-assigned on append. Strictly increasing, NOT gapless. */
  seq: number;
  /** Unique within the session. */
  id: string;
  /** ISO-8601 persistence time. */
  createdAt: string;
  /**
   * The native message THIS entry mirrors. Present only on conversation entries
   * mirrored from the harness. Server-side only; stripped from the client view.
   */
  providerMessageId?: string;
  /** Optional raw provider payload, retained for debugging/diagnostics. Server-only. */
  metadata?: Record<string, unknown>;
  /**
   * Stamped by {@link SessionLog.copyPrefixTo} on entries this session
   * inherited from the one it was forked out of. Unlike `providerMessageId` it
   * SURVIVES the copy and reaches the client: it is the fork boundary the
   * transcript marks, and the address of the message in the session that wrote
   * it (ids are preserved across the copy).
   */
  inheritedFrom?: SessionEntryOrigin;
}

/** A user prompt. Appended at submission, before the provider assigns an id. */
export type UserRawEntry = RawEntryBase & {
  type: "message";
  role: "user";
  origin: PromptOrigin;
  /** Hidden prompts are persisted but omitted from chat display. */
  hidden?: boolean;
  /** How a prompt sent during a running turn reached the model. */
  delivery?: PromptDelivery;
  /** Sanitized card for a delivered peer prompt; rendered instead of the envelope content. */
  peerPrompt?: PeerPromptCard;
  content: AgentContentBlock[];
  /** The submitting client's idempotency token; used to dedupe re-submits. Server-only. */
  clientRequestId?: string;
  /**
   * Durable admission keys for EVERY peer message combined into this delivered
   * entry (a batch is one turn). Server-only; lets crash recovery detect each
   * batched row as admitted, not just the batch head.
   */
  peerMessageIds?: string[];
};

/** An assistant turn (text/thinking/toolCall blocks). */
export type AssistantRawEntry = RawEntryBase & {
  type: "message";
  role: "assistant";
  /** Provenance for a provider-initiated turn with no durable user prompt. */
  origin?: PromptOrigin;
  content: AgentContentBlock[];
  model?: string;
  stopReason?: AgentStopReason;
  /** Human-readable provider error retained on a failed turn, rendered in-chat. */
  error?: string;
  usage?: AgentUsage;
  startedAt?: string;
  completedAt?: string;
};

/** A single tool result, linked to its call by `toolCallId`. */
export type ToolResultRawEntry = RawEntryBase & {
  type: "message";
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: AgentContentBlock[];
  isError?: boolean;
  /** Rendering-only provider display diff with real file line numbers (pi edit tools). */
  resultDiff?: string;
};

/** Bookkeeping: links a (previously unbound) conversation entry to its native message id. */
type MessageProviderBoundEntry = RawEntryBase & {
  type: "message.providerBound";
  /** The `id` of the conversation entry this binds. */
  boundEntryId: string;
  providerMessageId: string;
  /**
   * The native id the bound entry's TURN ends on. A harness may spend several
   * native messages on the one turn our log aggregates (pi: assistant → tool
   * result → assistant → … → final assistant), and only that terminal id names
   * the whole turn: a fork cutting inclusively at it reproduces every tool
   * result AND the final assistant output, where `providerMessageId` alone can
   * cut the turn open.
   *
   * ALWAYS written on an aggregated assistant entry that a turn reconciliation
   * placed — including when it equals `providerMessageId`, which is the ordinary
   * case of a turn ending on its final assistant message. Its PRESENCE is
   * therefore the discriminator: a binding that has it resolved its turn end, an
   * older one (or a user/tool-result binding) never did, and a fork must fall
   * back rather than read `providerMessageId` as a turn end. Do not "tidy" this
   * into being written only when the two differ — that would route every new
   * binding onto the fallback path.
   */
  providerTurnEndId?: string;
};

/** Bookkeeping: a server-only tool audit record (host-initiated tool calls, etc.). */
type ToolAuditEntry = RawEntryBase & {
  type: "tool.audit";
  toolName: string;
  payload: unknown;
};

/** Durable provider retry/failure diagnostic. It is a host record, never model context. */
export type ProviderNoticeEntry = RawEntryBase & {
  type: "provider.notice";
  severity: "warning" | "error";
  message: string;
  providerError: import("@assistant/shared").ProviderErrorInfo;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  phase?: string;
  requestBytes?: number;
};

/** Durable run lifecycle marker (crash recovery brackets an active run). */
type RunMarkerEntry = RawEntryBase & {
  type: "run.started" | "run.ended" | "run.aborted";
  runId: string;
};

/** Durable host-command lifecycle marker (e.g. /commit span). */
type CommandMarkerEntry = RawEntryBase & {
  type: "command.started" | "command.ended" | "command.aborted";
  commandId: string;
  name: string;
};

/**
 * Durable host-command RESULT card. Persisted so `/commit`/`/compact` cards
 * survive reconnect/history; projected back into the client timeline by
 * {@link projectHostCommandForClient}. Not a conversation entry — the model never
 * sees it.
 */
export type HostCommandResultEntry = RawEntryBase & {
  type: "command.result";
  commandId: string;
  name: string;
  card: HostCommandCard;
};

/** Conversation entries — the only ones that become a client/server SessionEntry. */
export type ConversationRawEntry =
  UserRawEntry | AssistantRawEntry | ToolResultRawEntry;

/** Every raw record the log can hold. */
export type SessionLogEntry =
  | ConversationRawEntry
  | MessageProviderBoundEntry
  | ToolAuditEntry
  | ProviderNoticeEntry
  | RunMarkerEntry
  | CommandMarkerEntry
  | HostCommandResultEntry;

export function isHostCommandResultEntry(
  entry: SessionLogEntry,
): entry is HostCommandResultEntry {
  return entry.type === "command.result";
}

export function isConversationEntry(
  entry: SessionLogEntry,
): entry is ConversationRawEntry {
  return entry.type === "message";
}
