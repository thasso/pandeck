/**
 * The narrow contract between the provider-neutral background-work service and
 * a provider backend ([Task-483](pa://task/483)).
 *
 * Declarations only. This module holds no implementation, no timer and no
 * provider import: `architecture.test.ts` confines
 * `@anthropic-ai/claude-agent-sdk` to `claudeSdk/` and `@earendil-works/*` to
 * `piSdk/`, and the whole point of these ports is that the service never learns
 * what a Claude `Query` or a pi `AgentSession` is.
 *
 * The address in every direction is the PA item id. A vendor task id, an OS
 * process or group id, a socket handle, a command line, a path, an environment
 * or an output body is the backend's alone and never crosses this boundary.
 * Provider binding and bounded output-evidence metadata are writes into the
 * store, never addresses anyone may use.
 */
import type {
  BackgroundWorkBackend,
  BackgroundWorkKind,
} from "@assistant/shared";

/** The admitted row a backend is asked to act on. */
export interface BackgroundWorkTarget {
  /** PA item id: the only address either side uses. */
  itemId: string;
  ownerSessionId: string;
  kind: BackgroundWorkKind;
  /** The retained host epoch this item executes in, when its backend has one. */
  hostEpochKey?: string;
}

/**
 * What the service hands a backend once admission has already succeeded. The
 * deadline and the empty-host grace are the values FROZEN on the row, passed
 * verbatim so a backend can never re-read live settings for work already
 * admitted.
 */
export interface BackgroundWorkLaunchRequest {
  target: BackgroundWorkTarget;
  deadlineAt: number;
  emptyHostGraceMs: number;
}

/**
 * The backend's answer to a launch. `launched: false` is the honest outcome
 * when nothing started — the provider reported no task, or the spawn failed —
 * and the service turns it into `failLaunch`, which is the only path that may
 * conclude an admission never executed.
 */
export interface BackgroundWorkLaunchAck {
  launched: boolean;
  /** Bounded failure text when nothing started; never a command or a path. */
  reason?: string;
  /**
   * The provider handle, when the backend already knows it at launch. A backend
   * that learns it later reports it through
   * {@link BackgroundWorkBackendEvents.providerBound} instead.
   */
  binding?: BackgroundWorkProviderBinding;
}

/** The authoritative provider handle for one item, once the backend has it. */
export interface BackgroundWorkProviderBinding {
  itemId: string;
  providerTaskId: string;
  providerTaskType?: string;
}

/** A targeted stop of exactly one item. */
export interface BackgroundWorkStopRequest {
  target: BackgroundWorkTarget;
  /** Stable across the one automatic retry; attempt distinguishes both calls. */
  sourceRequestId: string;
  attempt: 1 | 2;
  /** Bounded reason, recorded on the row and shown to the owner. */
  reason: string;
}

/**
 * Whether the backend can say the item actually stopped. `acknowledged: false`
 * is NOT a terminal outcome: it becomes `unconfirmed` on the row, which later
 * evidence or a further attempt may still answer.
 */
export interface BackgroundWorkStopAck {
  acknowledged: boolean;
  /** Bounded evidence for an unanswered attempt; never a signal, pid or log. */
  evidence?: string;
}

/** The owner-wide escalation: stop everything this session owns on this backend. */
export interface BackgroundWorkStopAllRequest {
  ownerSessionId: string;
  /** The caller identity, when a model/human owner request supplies one. */
  callerSessionId?: string;
  sourceRequestId: string;
  attempt: 1 | 2;
  reason: string;
  /**
   * True while an ordinary prompted turn is inside its protected boundary. The
   * backend may reserve Stop-all now, but must not close that turn's host until
   * the boundary exits.
   */
  protectOrdinaryTurn: boolean;
}

export interface BackgroundWorkStopAllAck {
  /** Items the backend acknowledged stopping, by PA id. */
  acknowledgedItemIds: string[];
  /** Items it could not confirm, by PA id. */
  unconfirmedItemIds: string[];
}

/** Close a retained host epoch (a Claude query); backends without one omit it. */
export interface BackgroundWorkHostCloseRequest {
  ownerSessionId: string;
  hostEpochKey: string;
  reason: string;
}

export interface BackgroundWorkHostCloseAck {
  closed: boolean;
  reason?: string;
}

/** One bounded, lossy batch of non-terminal process or monitor activity. */
export interface BackgroundWorkActivity {
  itemId: string;
  lines: string[];
  bytes: number;
  droppedEventCount: number;
  /** Backend-local monotonic identity used only for delivery request dedupe. */
  eventId: string;
}

/**
 * A monitor produced more notifications than its sustained budget allows.
 *
 * Carries counts only: WHICH lines flooded is the backend's business, and the
 * service's answer is the same whatever they said. The backend has already
 * stopped streaming when it reports this, so the service owes the item a Stop.
 */
export interface BackgroundWorkActivityRateExceeded {
  itemId: string;
  eventId: string;
  notificationCount: number;
  windowMs: number;
}

/** Safe metadata from one provider-specific bounded output capture. */
export interface BackgroundWorkOutputCaptured {
  itemId: string;
  eventId: string;
  evidence: {
    artifactId?: string;
    originalBytes?: number;
    capturedBytes?: number;
    truncated?: boolean;
    text?: boolean;
    refusalReason?: string;
  };
}

/** How one item ended, as the backend observed it. */
export interface BackgroundWorkCompletion {
  itemId: string;
  state: "completed" | "failed" | "stopped";
  exitCode?: number;
  /** Bounded human summary; the output body itself stays with the backend. */
  outcomeSummary?: string;
  /** Provider event identity, so a repeated or reordered report is ignored. */
  eventId?: string;
  sequence?: number;
}

/**
 * What a provider backend must supply. Every method is addressed by PA id and
 * may be called only for work this service admitted.
 *
 * Deployment drain calls `stopAll` CONCURRENTLY for distinct owners on the same
 * backend, then may likewise call `closeHost` concurrently for their distinct
 * host epochs. Adapters must isolate mutable state by owner/epoch and make those
 * calls concurrency-safe; process-wide "current target" state is not valid.
 */
export interface BackgroundWorkBackendPort {
  readonly backend: BackgroundWorkBackend;
  launch(
    request: BackgroundWorkLaunchRequest,
  ): Promise<BackgroundWorkLaunchAck>;
  stop(request: BackgroundWorkStopRequest): Promise<BackgroundWorkStopAck>;
  stopAll(
    request: BackgroundWorkStopAllRequest,
  ): Promise<BackgroundWorkStopAllAck>;
  /** Present only on a backend that retains a host epoch. */
  closeHost?(
    request: BackgroundWorkHostCloseRequest,
  ): Promise<BackgroundWorkHostCloseAck>;
}

/**
 * The service side a backend reports INTO. This is the only way a provider fact
 * reaches durable state, which is what keeps a backend from writing rows of its
 * own.
 */
export interface BackgroundWorkBackendEvents {
  providerBound(binding: BackgroundWorkProviderBinding): void;
  /** Lossy delivery hint. Raw lines never enter the durable provider-neutral row. */
  activity(activity: BackgroundWorkActivity): void;
  /**
   * The backend muted a monitor for exceeding its notification budget. Reporting
   * it is not optional: the service must Stop the item, because a live monitor
   * nobody hears from reads exactly like a quiet one.
   */
  activityRateExceeded(event: BackgroundWorkActivityRateExceeded): void;
  outputCaptured(output: BackgroundWorkOutputCaptured): void;
  completed(completion: BackgroundWorkCompletion): void;
}
