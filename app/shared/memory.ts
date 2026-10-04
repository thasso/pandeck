/**
 * Shared domain contracts for the agent memory system (Task 91).
 *
 * Runtime-light types + a few constants (enum member lists, budgets) shared by
 * the server persistence/service/selector layers and the browser management /
 * inspector UI. No server- or React-only imports.
 *
 * A memory is one concise reusable preference, fact, constraint, or piece of
 * near-term working state. Long-form material stays in the Knowledge Base;
 * commitments/events stay in Tasks/Calendar.
 */
import type {
  AgentType,
  CredentialProfilePin,
  ThinkingLevel,
} from "./protocol.ts";

/** What a memory card represents. */
export type MemoryKind = "preference" | "fact" | "constraint" | "working";
export const MEMORY_KINDS: readonly MemoryKind[] = [
  "preference",
  "fact",
  "constraint",
  "working",
];

/** Lifecycle state of a memory card. Superseded/archived rows stay auditable. */
export type MemoryLifecycleState = "active" | "superseded" | "archived";

/** How a memory's validity relates to time. */
export type MemoryTemporalMode =
  "persistent" | "window" | "until-changed" | "recurring";
export const MEMORY_TEMPORAL_MODES: readonly MemoryTemporalMode[] = [
  "persistent",
  "window",
  "until-changed",
  "recurring",
];

/** Automatic learning mode. `adaptive` is the default; `every-turn` is experimental. */
export type MemoryLearningMode = "off" | "adaptive" | "every-turn";
export const MEMORY_LEARNING_MODES: readonly MemoryLearningMode[] = [
  "off",
  "adaptive",
  "every-turn",
];

/**
 * Whether the effective memory snapshot was newly delivered, reused from
 * native context, cleared, or absent for an accepted turn.
 */
/** `failed` is a selection/delivery failure for an accepted turn (never persisted to the session snapshot). */
export type MemoryLoadDeliveryState =
  "injected" | "reused" | "cleared" | "none" | "failed";

/** State of one durable observation-buffer entry. */
export type MemoryObservationState =
  "pending" | "processing" | "processed" | "discarded" | "failed";

/** Immutable provenance channel that produced a memory card. */
export type MemorySourceKind =
  "manual" | "agent" | "processor" | "import" | "consolidation";

/**
 * Multidimensional scope. A memory applies only when EVERY specified dimension
 * matches the current context; an absent dimension is global on that axis.
 */
export interface MemoryScope {
  /** Registry project id, or absent for any project. */
  projectId?: string;
  /** Persona, or absent for any persona. */
  persona?: AgentType;
}

/** The v1 recurring shape: a set of weekdays. Kept deliberately small. */
export interface MemoryRecurrence {
  kind: "weekly";
  /** Weekdays, 0 (Sunday) – 6 (Saturday), sorted and de-duplicated. */
  weekdays: number[];
}

/** Immutable provenance of a memory card. */
interface MemoryProvenance {
  sourceKind: MemorySourceKind;
  /** Session that produced the card, when applicable. */
  sessionId?: string;
  /** Durable app user-entry / message id, when applicable. */
  messageId?: string;
}

/** Temporal validity of a memory card. UTC ms internally; IANA tz for rendering. */
export interface MemoryTemporal {
  mode: MemoryTemporalMode;
  validFromMs?: number;
  validUntilMs?: number;
  /** IANA timezone used to interpret the window/recurrence. */
  timezone?: string;
  recurrence?: MemoryRecurrence;
}

/** One versioned memory card (current state of a stable id). */
export interface MemoryCard {
  /** Stable compact id — survives revisions and supersession. */
  id: string;
  /** Monotonically increasing per id; the optimistic-concurrency token. */
  revision: number;
  text: string;
  kind: MemoryKind;
  scope: MemoryScope;
  state: MemoryLifecycleState;
  pinned: boolean;
  /** Reinforcement/confidence weight (>= 0). */
  strength: number;
  temporal: MemoryTemporal;
  /** Authoritative source timestamp used to interpret relative dates. */
  observedAtMs: number;
  createdAt: number;
  updatedAt: number;
  lastLoadedAt?: number;
  provenance: MemoryProvenance;
  /** The prior card id this card replaced (correction lineage). */
  supersedesId?: string;
  /** Bounded operation reason for the last mutation. */
  reason?: string;
}

/** Compact reason code for why a card entered the effective set. */
export type MemorySelectionReasonCode =
  | "pinned"
  | "baseline-preference"
  | "baseline-constraint"
  | "active-temporal"
  | "recurring-active"
  | "query-match";

/** One card as it appears in a rendered effective snapshot / load audit. */
export interface EffectiveMemoryItem {
  id: string;
  revision: number;
  kind: MemoryKind;
  scope: MemoryScope;
  text: string;
  /** 1-based rank in the effective set. */
  rank: number;
  reasonCode: MemorySelectionReasonCode;
  /** Compact human-readable reason (may include a temporal label). */
  reason: string;
  temporalLabel?: string;
  renderedChars: number;
  /** Snapshot of the card's provenance at delivery, for a resolvable source link. */
  provenance: MemoryProvenance;
}

/** A deterministic, budget-bounded effective memory set for one turn. */
export interface EffectiveMemorySnapshot {
  items: EffectiveMemoryItem[];
  /** Deterministic fingerprint over ordered id@revision + settings-relevant inputs. */
  fingerprint: string;
  renderedText: string;
  renderedChars: number;
}

/** One item of a persisted per-turn load batch (audit record, not a transcript). */
export interface MemoryLoadItem {
  memoryId: string;
  revision: number;
  rank: number;
  reasonCode: MemorySelectionReasonCode;
  reason: string;
  renderedChars: number;
  /** Snapshot of the card text/kind/scope effective at delivery (historically accurate). */
  text: string;
  kind: MemoryKind;
  scope: MemoryScope;
  temporalLabel?: string;
  /** Snapshot of the card's provenance at delivery, for a resolvable source link. */
  provenance?: MemoryProvenance;
}

/** A persisted per-turn effective-load batch. `reused` records the set with 0 injected chars. */
export interface MemoryLoadBatch {
  id: number;
  sessionId: string;
  /** Durable accepted user-turn id (shared with Task 96/99). */
  userTurnId: string;
  fingerprint: string;
  deliveryState: MemoryLoadDeliveryState;
  renderedChars: number;
  injectedChars: number;
  /** Cumulative injected chars since the last detected compaction/rotation, as of this turn. */
  cumulativeInjectedChars: number;
  createdAt: number;
  items: MemoryLoadItem[];
}

/** Public, secret-free memory settings. */
export interface MemorySettings {
  /** Load existing memory into turns. Independent of automatic learning. */
  loadingEnabled: boolean;
  learningMode: MemoryLearningMode;
  /** Automatic maintenance (deterministic expiry + model consolidation). */
  maintenanceEnabled: boolean;
  /** Max effective cards per turn. */
  maxCards: number;
  /** Max rendered characters of the effective snapshot. */
  maxRenderedChars: number;
  /** The cheap model that runs extraction/evaluation/consolidation. */
  processor: CredentialProfilePin & {
    provider: string;
    modelId: string;
    thinkingLevel: ThinkingLevel;
  };
  /** Global processor ceiling: model calls per rolling hour, across all sessions/modes. */
  maxCallsPerHour: number;
  /** Global processor ceiling: reported USD cost per rolling day, across all sessions/modes. */
  maxCostPerDayUsd: number;
}

/**
 * Hard bounds on the configurable memory limits. The global ceilings are
 * configurable but can never be raised without bound, and a learning mode can
 * never bypass them (they are enforced by the processor, not the mode).
 */
export const MEMORY_SETTINGS_LIMITS = {
  maxCards: { min: 1, max: 32 },
  maxRenderedChars: { min: 200, max: 8_000 },
  maxCallsPerHour: { min: 0, max: 240 },
  maxCostPerDayUsd: { min: 0, max: 50 },
} as const;

/* ------------------------------ browser API ------------------------------ */

/** Filter for a bounded memory list/search request. */
export interface MemoryListFilter {
  /** Free-text lexical search over card text. */
  text?: string;
  projectId?: string;
  persona?: AgentType;
  kinds?: MemoryKind[];
  states?: MemoryLifecycleState[];
  pinned?: boolean;
  /** Only cards temporally active at the current time. */
  activeNow?: boolean;
  limit?: number;
  offset?: number;
}

/** A bounded, paginated memory list result. */
export interface MemoryListResult {
  cards: MemoryCard[];
  total: number;
  hasMore: boolean;
}

/** Card plus its supersession lineage (for the management UI). */
export interface MemoryLineage {
  card: MemoryCard | null;
  /** The card this one replaced, if any. */
  predecessor?: MemoryCard;
  /** Cards that replaced this one, newest first. */
  supersededBy: MemoryCard[];
}

/** A validated browser mutation. Existing-card ops require `expectedRevision`. */
export type MemoryMutateOperation =
  | {
      op: "edit";
      id: string;
      expectedRevision: number;
      text?: string;
      kind?: MemoryKind;
      scope?: MemoryScope;
      temporal?: MemoryTemporal;
      reason?: string;
    }
  | {
      op: "correct";
      id: string;
      expectedRevision: number;
      text: string;
      kind?: MemoryKind;
      scope?: MemoryScope;
      temporal?: MemoryTemporal;
      reason?: string;
    }
  | { op: "pin"; id: string; expectedRevision: number; reason?: string }
  | { op: "unpin"; id: string; expectedRevision: number; reason?: string }
  | { op: "archive"; id: string; expectedRevision: number; reason?: string }
  | { op: "restore"; id: string; expectedRevision: number; reason?: string };

/** Result of a browser mutation — a stale revision returns the current card. */
export type MemoryMutateResult =
  | { ok: true; card: MemoryCard }
  | { ok: false; error: "stale-revision"; current: MemoryCard }
  | { ok: false; error: "not-found" }
  | { ok: false; error: "invalid"; message: string };

/** Hard bound on a single memory card's normalized text. */
export const MEMORY_TEXT_MAX_CHARS = 400;
/** Minimum meaningful card text length. */
export const MEMORY_TEXT_MIN_CHARS = 3;
