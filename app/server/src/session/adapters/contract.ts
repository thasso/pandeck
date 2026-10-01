/**
 * The provider-neutral adapter contract the runtime drives + ingests from. An
 * adapter wraps a backing engine ("harness") and turns it into a stream of
 * normalized {@link AdapterEvent}s plus normalized drive calls. It knows nothing
 * about the log or the transport.
 *
 * Both remaining harnesses (pi, claude-sdk) are in-process and promptable, so
 * both implement {@link PromptableAdapter}. The base {@link SessionAdapter}
 * (observe-only) is kept as a seam for a possible future external-process harness.
 *
 * Concrete pi / claude-sdk adapters implement this contract; runtime tests also
 * use scripted fake adapters for deterministic event ordering.
 */
import type {
  AgentContentBlock,
  AgentStopReason,
  AgentUsage,
  PromptDelivery,
  SessionConfigModel,
} from "@assistant/shared/session";
import type { PromptAttachment, ServerMessage } from "@assistant/shared";
import type { ProviderBinding } from "../log/identity.ts";
import type { HostCommandCard } from "../log/rawEntry.ts";
import type { MessageDelta } from "@assistant/shared/runtime";

export type { MessageDelta };

/**
 * Normalized events an adapter emits as a run proceeds. The runtime translates
 * these into log appends + outward `RuntimeEvent`s (see `../runtime/events.ts`).
 * `streamId` is the adapter's transient id for an in-flight message/tool; durable
 * entries are keyed separately by the log's `id`/`seq`.
 */
export type AdapterEvent =
  | { type: "messageStarted"; streamId: string }
  | { type: "messageDelta"; streamId: string; delta: MessageDelta }
  | {
      type: "messageCompleted";
      streamId: string;
      content: AgentContentBlock[];
      model?: string;
      usage?: AgentUsage;
      stopReason?: AgentStopReason;
      /** Human-readable provider error, present when the turn ended in `error`. */
      error?: string;
      providerMessageId?: string;
      startedAt?: string;
      completedAt?: string;
    }
  | {
      type: "toolStarted";
      streamId: string;
      toolCallId: string;
      name: string;
      input?: unknown;
    }
  | { type: "toolUpdated"; streamId: string; output: string }
  | {
      type: "toolCompleted";
      streamId: string;
      toolCallId: string;
      toolName?: string;
      content: AgentContentBlock[];
      isError?: boolean;
      providerMessageId?: string;
      /** Rendering-only provider display diff with real file line numbers (pi edit tools). */
      resultDiff?: string;
    }
  /** The provider accepted the pending prompt and assigned it a native id. */
  | { type: "promptAccepted"; providerMessageId: string }
  /**
   * The provider's persisted conversation entries IN NATIVE ORDER, recovered AFTER
   * a turn so EVERY entry — user, assistant AND tool result — can be bound to its
   * native id (the fork/resume anchor). pi emits this from its post-turn file scan;
   * the runtime hands it to `SessionLog.bindScannedEntries`.
   *
   * This is NOT positionally aligned with our log: a harness may write several
   * assistant messages (and their tool results) for the one turn our log aggregates
   * into a single assistant entry. The reconciliation therefore matches on turn
   * structure and tool call ids, so each row carries the calls it answers
   * (`toolCallId`) or declares (`toolCallIds`).
   */
  | {
      type: "entriesBound";
      entries: {
        role: "user" | "assistant" | "toolResult";
        providerMessageId: string;
        /** Tool result: the call it answers. */
        toolCallId?: string;
        /** Assistant message: the calls it declares. */
        toolCallIds?: string[];
        /** Assistant message: it declares a call whose id could not be read. */
        unidentifiedToolCalls?: true;
      }[];
    }
  /**
   * A harness wire envelope the runtime forwards to the client VERBATIM for live
   * rendering (for example completed `toolEnd` envelopes and host-command result
   * cards). Transport-only; this event itself is not persisted. Host-command
   * cards that must survive reconnect/history are also emitted as
   * `hostCommandResult` so the runtime can append a durable `command.result`.
   */
  | { type: "passthrough"; envelope: ServerMessage }
  /**
   * A host command (`/commit`, `/compact`) produced its DURABLE result card. The
   * runtime persists it as a `command.result` log entry and re-shows it on
   * reconnect. The live card was already forwarded via `passthrough`, so the
   * transport does NOT re-render this; it only closes the synthetic turn. Emitted
   * INSTEAD of `messageCompleted` for the synthetic host-command turn, so the
   * wrapper assistant/tool turn never becomes a dangling conversation entry.
   */
  | { type: "hostCommandResult"; name: string; card: HostCommandCard }
  /** A normal skipped host-command phase: close its transient wrapper without persisting it. */
  | { type: "hostCommandDiscarded" }
  /** A durable provider retry/failure diagnostic, retained outside model context. */
  | {
      type: "providerNotice";
      severity: "warning" | "error";
      message: string;
      providerError: import("@assistant/shared").ProviderErrorInfo;
      attempt?: number;
      maxAttempts?: number;
      delayMs?: number;
      phase?: string;
      requestBytes?: number;
    }
  /** The run finished; `error`/`aborted` are surfaced as transport-only status. */
  | {
      type: "runCompleted";
      stopReason: "end" | "error" | "aborted";
      errorMessage?: string;
    }
  /** Model/reasoning selection changed (e.g. provider applied a setModel). */
  | {
      type: "sessionConfigChanged";
      model?: SessionConfigModel;
      reasoning?: string;
    };

/** The result of one `prompt()` run. A failed run RESOLVES with `error` (the runtime throws it). */
export interface AgentRunResult {
  stopReason: "end" | "error" | "aborted";
  errorMessage?: string;
  code?: string;
  /**
   * Answers a {@link PromptOptions.steerOnly} request: `false` means the turn was
   * already over and NOTHING was sent. Only that mode sets it — an ordinary
   * prompt or an opportunistic steer leaves it undefined.
   */
  steered?: boolean;
  /**
   * Answers an opportunistic steer to an adapter whose
   * {@link ForkCapability.steerAcceptance} is `"deferred"`: how the provider
   * took the message. Absent means it took nothing — the message was withdrawn
   * or never sent — so the caller treats the session as busy.
   */
  steerDelivery?: PromptDelivery;
  /**
   * With no `steerDelivery`: the message WAS handed to the provider, and the
   * turn ended (a Stop, a failure) before it read it. Still nothing was
   * recorded, but the caller holds the only copy of what the user wrote.
   */
  steerWithdrawn?: boolean;
  /**
   * With `steerWithdrawn`: the provider never confirmed it dropped the message
   * unread, so it may have been read before the turn ended.
   */
  steerUncertain?: boolean;
}

export interface PromptOptions {
  clientRequestId?: string;
  /** Hidden prompts (e.g. resume-with-answers) are not echoed as a user bubble by the client. */
  hidden?: boolean;
  /**
   * Files the user attached to this prompt. The adapter saves them + threads them
   * to the model (pi and claude-sdk); the runtime records attachment content
   * blocks on the durable user entry. Adapters whose `capabilities.attachments` is
   * false ignore them.
   */
  attachments?: PromptAttachment[];
  /** Accept as a steering/follow-up prompt if the provider supports mid-turn input. */
  steer?: boolean;
  /**
   * Steer or do NOTHING — never fall back to starting a turn.
   *
   * `steer` alone is decided twice: once by the runtime's `runState` and again by
   * the driver's own live streaming state. A turn ending between those two reads
   * makes the driver start a fresh turn, which the caller then hears about as a
   * successful steer. A human clicking mid-turn rarely loses that race; an
   * automatic sender does, because the events that produce its message are the
   * same events that end turns. This mode moves the decision into the driver,
   * which holds the authoritative state, and reports back through
   * {@link AgentRunResult.steered} so the caller can fall back deliberately.
   */
  steerOnly?: boolean;
  /**
   * Deferred steers only: called SYNCHRONOUSLY the moment the provider takes the
   * message, before the adapter commits anything after it (a reply, the run's
   * end). The runtime appends the user entry here, which is the only way it
   * lands inside the run and ahead of the reply the model then writes; awaiting
   * the answer would resume only after both. Must not throw.
   */
  onSteerAccepted?: (delivery: PromptDelivery) => void;
}

export interface ForkCapability {
  fork: "arbitrary" | "lastTurn" | "none";
  compact: boolean;
  /** Whether the adapter can accept a steering prompt while a turn is running. */
  steer?: boolean;
  /**
   * `"deferred"`: the provider decides only LATER whether a steer joined the
   * running turn or came after its reply (the Claude CLI queues the message and
   * folds it in at the next tool step, or runs it next). The runtime then
   * appends the user entry when the adapter answers with
   * {@link AgentRunResult.steerDelivery}, so a late message lands after the
   * reply it missed, and nothing at all when the adapter withdrew it.
   */
  steerAcceptance?: "deferred";
  /** Whether the adapter forwards prompt attachments to the model. */
  attachments: boolean;
}

/** Observe/drive-externally surface. Nothing implements ONLY this today. */
interface SessionAdapter {
  readonly provider: string;
  /** Subscribe to the adapter's normalized event stream. Returns an unsubscribe fn. */
  subscribe(listener: (event: AdapterEvent) => void): () => void;
  /** The current native binding (provider + native id + restore detail). */
  getBinding(): ProviderBinding;
  /** Per-provider capabilities (fork/compact). */
  readonly capabilities: ForkCapability;
  dispose(): void | Promise<void>;
}

/** A {@link SessionAdapter} that also owns its conversation and accepts prompts. */
export interface PromptableAdapter extends SessionAdapter {
  /** Run one prompt to completion. Resolves with the run result (errors resolve, not reject). */
  prompt(text: string, options?: PromptOptions): Promise<AgentRunResult>;
  abort(): void | Promise<void>;
  setModel(model: SessionConfigModel): void | Promise<void>;
  setReasoning(level: string): void | Promise<void>;
  /** Optional model catalog for the picker; a missing/failed list degrades to empty. */
  listModels?(): Promise<SessionConfigModel[]>;
}
