/**
 * The single deterministic domain layer for ALL memory mutations (human, agent
 * tool, UI, and automatic processor). No UI, tool, processor, or scheduler
 * touches the memory tables directly — they call this service, which owns
 * validation, optimistic concurrency, lifecycle, provenance/supersession
 * lineage, idempotency/deduplication, deterministic expiry, scope resolution,
 * and the domain change event.
 *
 * Model output PROPOSES operations; this module VALIDATES and applies them.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  AgentType,
  MemoryCard,
  MemoryKind,
  MemoryScope,
  MemorySourceKind,
  MemoryTemporal,
  MemoryValidationError,
} from "@assistant/shared";
import {
  isMemoryKind,
  validateMemoryScope,
  validateMemoryTemporal,
  validateMemoryText,
} from "@assistant/shared";
import { memoryStore, type MemoryCardUpdate } from "../db/memoryStore.ts";
import { memoryOperationStore } from "../db/memoryOperationStore.ts";
import { withDbTransaction } from "../db/index.ts";

/* --------------------------------- clock --------------------------------- */

let clock: () => number = () => Date.now();
/** Override the service clock in tests. */
export function setMemoryClockForTests(now: () => number): void {
  clock = now;
}
export function resetMemoryClockForTests(): void {
  clock = () => Date.now();
}

/* ----------------------------- change events ----------------------------- */

interface MemoryChangeEvent {
  id: string;
  revision: number;
  change:
    | "created"
    | "reinforced"
    | "updated"
    | "superseded"
    | "archived"
    | "restored"
    | "expired";
}
type MemoryChangeListener = (event: MemoryChangeEvent) => void;
const listeners = new Set<MemoryChangeListener>();
/** Subscribe to memory domain changes (live UI refresh, maintenance counters). */
export function onMemoryChange(listener: MemoryChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit(card: MemoryCard, change: MemoryChangeEvent["change"]): void {
  const event: MemoryChangeEvent = {
    id: card.id,
    revision: card.revision,
    change,
  };
  for (const l of listeners) {
    try {
      l(event);
    } catch {
      // a listener failure must never break a mutation.
    }
  }
}

/* -------------------------------- results -------------------------------- */

export type MemoryMutationResult =
  | { ok: true; card: MemoryCard }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "stale"; current: MemoryCard }
  | { ok: false; reason: "invalid"; error: MemoryValidationError };

function invalid(field: string, message: string): MemoryMutationResult {
  return { ok: false, reason: "invalid", error: { field, message } };
}

/* ------------------------------- provenance ------------------------------ */

interface MemoryProvenanceInput {
  sourceKind: MemorySourceKind;
  sessionId?: string;
  messageId?: string;
}

const STRENGTH_MAX = 10;
const REINFORCE_STEP = 0.5;

/** Deterministic content-dedup key so explicit writes and automatic processing converge on one card. */
function contentKey(
  text: string,
  kind: MemoryKind,
  scope: MemoryScope,
): string {
  const normalized = text.trim().toLowerCase();
  const scopeKey = `${scope.projectId ?? "*"}|${scope.persona ?? "*"}|${kind}`;
  return `dedup:${createHash("sha256").update(`${scopeKey}\n${normalized}`).digest("hex").slice(0, 32)}`;
}

function newId(): string {
  return `mem_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/* ----------------------------- idempotency ------------------------------- */

/**
 * Run a mutation under a trusted operation-identity key so an EXACT retry is a
 * no-op that returns the prior result (a retried create does not reinforce; a
 * retried reinforce does not increment; a processor rerun after crash cannot
 * double-apply). A different key (a genuinely later observation/tool call) still
 * applies. Pass `undefined` to skip (no trusted identity available).
 */
export function withOperationIdempotency(
  key: string | undefined,
  fn: () => MemoryMutationResult,
): MemoryMutationResult {
  if (!key) return fn();
  const priorCardId = memoryOperationStore.cardIdFor(key);
  if (priorCardId) {
    const card = memoryStore.get(priorCardId);
    if (card) return { ok: true, card };
    // The recorded card is gone (hard-deleted?); fall through to re-apply.
  }
  // Mutation + ledger record commit ATOMICALLY: a crash after the mutation but
  // before the record cannot happen (both roll back together), so a retry either
  // sees the recorded key (no-op) or re-applies exactly once. `fn` must be a
  // single-statement mutation (create/reinforce/edit/pin/archive/restore) — never
  // supersede, which opens its own transaction (it records the key internally).
  return withDbTransaction(() => {
    const result = fn();
    if (result.ok) memoryOperationStore.record(key, result.card.id, clock());
    return result;
  });
}

/* --------------------------------- create -------------------------------- */

export interface CreateMemoryInput {
  text: string;
  kind: MemoryKind;
  scope?: MemoryScope;
  temporal?: MemoryTemporal;
  pinned?: boolean;
  strength?: number;
  provenance: MemoryProvenanceInput;
  reason?: string;
  /** Immutable authoritative source timestamp; defaults to the service clock. */
  observedAtMs?: number;
}

/**
 * Create a memory. If an active card with the same normalized text + scope + kind
 * already exists, this REINFORCES that card and returns it (so explicit agent
 * writes and later automatic processing converge on one card, and retries do not
 * duplicate). Otherwise inserts a fresh active card.
 */
export function createMemory(input: CreateMemoryInput): MemoryMutationResult {
  if (!isMemoryKind(input.kind)) return invalid("kind", "unknown memory kind");
  const text = validateMemoryText(input.text);
  if (!text.ok) return { ok: false, reason: "invalid", error: text.error };
  const scope = validateMemoryScope(input.scope);
  if (!scope.ok) return { ok: false, reason: "invalid", error: scope.error };
  const temporal = validateMemoryTemporal(input.temporal);
  if (!temporal.ok)
    return { ok: false, reason: "invalid", error: temporal.error };

  const key = contentKey(text.value, input.kind, scope.value);
  const existing = memoryStore.findByIdempotencyKey(key);
  const now = clock();
  if (existing && existing.state === "active") {
    // Converge: reinforce the existing active card rather than duplicate it.
    const reasonValue = input.reason ?? existing.reason;
    const bumped = memoryStore.updateChecked(
      existing.id,
      existing.revision,
      {
        strength: Math.min(STRENGTH_MAX, existing.strength + REINFORCE_STEP),
        ...(reasonValue !== undefined ? { reason: reasonValue } : {}),
      },
      now,
    );
    const card = bumped ?? memoryStore.get(existing.id)!;
    emit(card, "reinforced");
    return { ok: true, card };
  }
  if (existing && existing.state === "archived") {
    // A previously ARCHIVED card with this exact content exists. Archive is
    // SUPPRESSION: automatic capture (processor/consolidation/import) must NOT
    // resurrect a memory the user suppressed — it is left archived and returned
    // as-is. Only an EXPLICIT write (manual, or an agent acting on a user request)
    // restores it; explicit user restore via the API also remains available.
    // Superseded cards are never reactivated (supersede clears their dedup key).
    const explicit =
      input.provenance.sourceKind === "manual" ||
      input.provenance.sourceKind === "agent";
    if (!explicit) return { ok: true, card: existing };
    const restored = memoryStore.updateChecked(
      existing.id,
      existing.revision,
      {
        state: "active",
        strength: Math.min(STRENGTH_MAX, existing.strength + REINFORCE_STEP),
        reason: input.reason ?? "re-observed",
      },
      now,
    );
    const card = restored ?? memoryStore.get(existing.id)!;
    emit(card, "restored");
    return { ok: true, card };
  }

  const card = memoryStore.insert({
    id: newId(),
    text: text.value,
    kind: input.kind,
    scope: scope.value,
    pinned: input.pinned ?? false,
    strength: input.strength ?? 1,
    temporal: temporal.value,
    // Preserve the immutable source timestamp: relative-date normalization and
    // temporal reasoning must use when the exchange happened, not processor time.
    observedAtMs: input.observedAtMs ?? now,
    createdAt: now,
    updatedAt: now,
    sourceKind: input.provenance.sourceKind,
    ...(input.provenance.sessionId !== undefined
      ? { sourceSessionId: input.provenance.sessionId }
      : {}),
    ...(input.provenance.messageId !== undefined
      ? { sourceMessageId: input.provenance.messageId }
      : {}),
    idempotencyKey: key,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
  emit(card, "created");
  return { ok: true, card };
}

/* ------------------------- existing-card mutations ----------------------- */

/** Apply a revision-checked field update, mapping the store result to a MemoryMutationResult. */
function applyChecked(
  id: string,
  expectedRevision: number,
  fields: MemoryCardUpdate,
  change: MemoryChangeEvent["change"],
): MemoryMutationResult {
  const current = memoryStore.get(id);
  if (!current) return { ok: false, reason: "not-found" };
  const updated = memoryStore.updateChecked(
    id,
    expectedRevision,
    fields,
    clock(),
  );
  if (!updated) return { ok: false, reason: "stale", current };
  emit(updated, change);
  return { ok: true, card: updated };
}

/**
 * Reinforce a specific card (bump strength). Additive/commutative, so no revision
 * is required; when the caller passes `expectedRevision`, a stale value fails
 * without mutating (returns the current card) for optimistic-concurrency parity.
 */
export function reinforceMemory(
  id: string,
  reason?: string,
  expectedRevision?: number,
): MemoryMutationResult {
  const current = memoryStore.get(id);
  if (!current) return { ok: false, reason: "not-found" };
  if (expectedRevision !== undefined && expectedRevision !== current.revision)
    return { ok: false, reason: "stale", current };
  const reasonValue = reason ?? current.reason;
  return applyChecked(
    id,
    current.revision,
    {
      strength: Math.min(STRENGTH_MAX, current.strength + REINFORCE_STEP),
      ...(reasonValue !== undefined ? { reason: reasonValue } : {}),
    },
    "reinforced",
  );
}

export interface EditMemoryInput {
  text?: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  temporal?: MemoryTemporal;
  reason?: string;
}

/** Non-semantic edit of an existing card (text/kind/scope/temporal), revision-checked. */
export function editMemory(
  id: string,
  expectedRevision: number,
  input: EditMemoryInput,
): MemoryMutationResult {
  const current = memoryStore.get(id);
  if (!current) return { ok: false, reason: "not-found" };
  const fields: MemoryCardUpdate = {};
  if (input.text !== undefined) {
    const text = validateMemoryText(input.text);
    if (!text.ok) return { ok: false, reason: "invalid", error: text.error };
    fields.text = text.value;
  }
  if (input.kind !== undefined) {
    if (!isMemoryKind(input.kind))
      return invalid("kind", "unknown memory kind");
    fields.kind = input.kind;
  }
  if (input.scope !== undefined) {
    const scope = validateMemoryScope(input.scope);
    if (!scope.ok) return { ok: false, reason: "invalid", error: scope.error };
    fields.scope = scope.value;
  }
  if (input.temporal !== undefined) {
    const temporal = validateMemoryTemporal(input.temporal);
    if (!temporal.ok)
      return { ok: false, reason: "invalid", error: temporal.error };
    fields.temporal = temporal.value;
  }
  if (input.reason !== undefined) fields.reason = input.reason;

  // Keep the content-dedup key coherent when text/kind/scope change, so a later
  // create of the edited content converges rather than duplicating, and the old
  // content key is freed. A key collision with a different active card fails the
  // edit deterministically instead of throwing a raw SQLite unique error.
  if (
    fields.text !== undefined ||
    fields.kind !== undefined ||
    fields.scope !== undefined
  ) {
    const nextKey = contentKey(
      fields.text ?? current.text,
      fields.kind ?? current.kind,
      fields.scope ?? current.scope,
    );
    const clash = memoryStore.findByIdempotencyKey(nextKey);
    if (clash && clash.id !== id && clash.state === "active")
      return invalid(
        "text",
        "an active memory with this content already exists",
      );
    fields.idempotencyKey = nextKey;
  }
  return applyChecked(id, expectedRevision, fields, "updated");
}

export function setMemoryPinned(
  id: string,
  expectedRevision: number,
  pinned: boolean,
  reason?: string,
): MemoryMutationResult {
  return applyChecked(
    id,
    expectedRevision,
    { pinned, ...(reason !== undefined ? { reason } : {}) },
    "updated",
  );
}

export function archiveMemory(
  id: string,
  expectedRevision: number,
  reason?: string,
): MemoryMutationResult {
  return applyChecked(
    id,
    expectedRevision,
    { state: "archived", ...(reason !== undefined ? { reason } : {}) },
    "archived",
  );
}

export function restoreMemory(
  id: string,
  expectedRevision: number,
  reason?: string,
): MemoryMutationResult {
  const current = memoryStore.get(id);
  if (!current) return { ok: false, reason: "not-found" };
  if (current.state === "superseded")
    return invalid(
      "state",
      "a superseded card cannot be restored; correct the replacement instead",
    );
  return applyChecked(
    id,
    expectedRevision,
    { state: "active", ...(reason !== undefined ? { reason } : {}) },
    "restored",
  );
}

/* ------------------------------- correction ------------------------------ */

export type MemorySupersedeResult =
  | { ok: true; old: MemoryCard; replacement: MemoryCard }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "stale"; current: MemoryCard }
  | { ok: false; reason: "invalid"; error: MemoryValidationError };

/**
 * The replacement for a correction. `text` is required; `kind`/`scope`/`temporal`
 * are inherited from the corrected card when omitted (so a text-only correction
 * never silently resets kind to `fact`, scope to global, or temporal to persistent).
 */
export interface SupersedeReplacement extends Omit<CreateMemoryInput, "kind"> {
  kind?: MemoryKind;
}

/**
 * Correct a card: atomically check the old revision, supersede it, and create the
 * replacement in ONE transaction — never a silent erase, never a contradictory
 * active duplicate, and never a half-applied correction if the insert fails. A
 * stale revision makes no change and returns the current card.
 */
export function supersedeMemory(
  oldId: string,
  expectedRevision: number,
  replacement: SupersedeReplacement,
  operationKey?: string,
): MemorySupersedeResult {
  const current = memoryStore.get(oldId);
  if (!current) return { ok: false, reason: "not-found" };

  // Idempotency: an exact retry returns the prior replacement (no second
  // supersede/create). The ledger record is written inside the correction's own
  // transaction below, so mutation + record are atomic.
  if (operationKey) {
    const priorCardId = memoryOperationStore.cardIdFor(operationKey);
    if (priorCardId) {
      const card = memoryStore.get(priorCardId);
      if (card) {
        const old = card.supersedesId
          ? memoryStore.get(card.supersedesId)
          : undefined;
        return { ok: true, old: old ?? current, replacement: card };
      }
    }
  }

  // Validate the replacement BEFORE touching the old card so a bad replacement
  // leaves history intact. Omitted fields inherit from the corrected card.
  const kind = replacement.kind ?? current.kind;
  if (!isMemoryKind(kind))
    return {
      ok: false,
      reason: "invalid",
      error: { field: "kind", message: "unknown memory kind" },
    };
  const text = validateMemoryText(replacement.text);
  if (!text.ok) return { ok: false, reason: "invalid", error: text.error };
  const scope =
    replacement.scope !== undefined
      ? validateMemoryScope(replacement.scope)
      : { ok: true as const, value: current.scope };
  if (!scope.ok) return { ok: false, reason: "invalid", error: scope.error };
  const temporal =
    replacement.temporal !== undefined
      ? validateMemoryTemporal(replacement.temporal)
      : { ok: true as const, value: current.temporal };
  if (!temporal.ok)
    return { ok: false, reason: "invalid", error: temporal.error };

  const now = clock();
  // The replacement's dedup key is the NEW content key. If a DIFFERENT active card
  // already owns it, a correction would create a contradictory active duplicate —
  // reject deterministically (the caller can reinforce/correct that card instead)
  // rather than insert an unkeyed duplicate.
  const newKey = contentKey(text.value, kind, scope.value);
  const clash = memoryStore.findByIdempotencyKey(newKey);
  if (clash && clash.id !== oldId && clash.state === "active") {
    return {
      ok: false,
      reason: "invalid",
      error: {
        field: "text",
        message: "an active memory with this content already exists",
      },
    };
  }

  let outcome: { superseded: MemoryCard; card: MemoryCard };
  try {
    outcome = withDbTransaction(() => {
      // Supersede the old card AND free its content key so it is never returned by
      // dedup lookups or accidentally reactivated as replaced history.
      const superseded = memoryStore.updateChecked(
        oldId,
        expectedRevision,
        {
          state: "superseded",
          reason: replacement.reason ?? "corrected",
          idempotencyKey: null,
        },
        now,
      );
      if (!superseded) throw new StaleSupersedeError();
      const card = memoryStore.insert({
        id: newId(),
        text: text.value,
        kind,
        scope: scope.value,
        pinned: replacement.pinned ?? current.pinned,
        strength: replacement.strength ?? current.strength,
        temporal: temporal.value,
        observedAtMs: replacement.observedAtMs ?? now,
        createdAt: now,
        updatedAt: now,
        sourceKind: replacement.provenance.sourceKind,
        ...(replacement.provenance.sessionId !== undefined
          ? { sourceSessionId: replacement.provenance.sessionId }
          : {}),
        ...(replacement.provenance.messageId !== undefined
          ? { sourceMessageId: replacement.provenance.messageId }
          : {}),
        supersedesId: oldId,
        idempotencyKey: newKey,
        reason: replacement.reason ?? "correction",
      });
      // Record the operation-idempotency key in the SAME transaction so a crash
      // cannot leave the correction applied without the ledger entry.
      if (operationKey) memoryOperationStore.record(operationKey, card.id, now);
      return { superseded, card };
    });
  } catch (err) {
    if (err instanceof StaleSupersedeError)
      return { ok: false, reason: "stale", current };
    throw err;
  }
  // Emit domain events only AFTER the transaction commits.
  emit(outcome.superseded, "superseded");
  emit(outcome.card, "created");
  return { ok: true, old: outcome.superseded, replacement: outcome.card };
}

class StaleSupersedeError extends Error {}

/* --------------------------------- expiry -------------------------------- */

/**
 * Deterministic expiry with no model call: archive active cards whose validity
 * window has ended. Pinned cards never auto-expire; cards without an end bound
 * (persistent / until-changed / open-ended recurring) never expire by age.
 * Returns the archived cards.
 */
export function expireDueMemories(nowMs = clock()): MemoryCard[] {
  const archived: MemoryCard[] = [];
  for (const card of memoryStore.activeCards()) {
    if (card.pinned) continue;
    const end = card.temporal.validUntilMs;
    if (end === undefined) continue;
    if (end >= nowMs) continue;
    const result = memoryStore.updateChecked(
      card.id,
      card.revision,
      { state: "archived", reason: "expired" },
      nowMs,
    );
    if (result) {
      emit(result, "expired");
      archived.push(result);
    }
  }
  return archived;
}

/* ----------------------------- scope resolver ---------------------------- */

/** The resolved effective context for a session, used for scope-intersection matching. */
export interface MemoryScopeContext {
  persona: AgentType;
  projectId?: string;
}

export interface ResolveScopeInput {
  persona: AgentType;
  /** Explicit active-session project (standalone or Task-derived); wins over registry hints. */
  projectId?: string;
  /** Registry-derived fallback project when no explicit evidence exists. */
  fallbackProjectId?: string;
}

/** Resolve the effective session scope. Explicit active project evidence wins over registry hints. */
export function resolveSessionScope(
  input: ResolveScopeInput,
): MemoryScopeContext {
  const projectId =
    input.projectId?.trim() || input.fallbackProjectId?.trim() || undefined;
  return { persona: input.persona, ...(projectId ? { projectId } : {}) };
}

/**
 * Intersection scope match: EVERY dimension specified on the card must match the
 * context. An absent card dimension is global on that axis (matches anything).
 */
export function scopeMatches(
  cardScope: MemoryScope,
  context: MemoryScopeContext,
): boolean {
  if (cardScope.persona !== undefined && cardScope.persona !== context.persona)
    return false;
  if (
    cardScope.projectId !== undefined &&
    cardScope.projectId !== context.projectId
  )
    return false;
  return true;
}

/** Bundled service surface for callers that prefer an object. */
export const memoryService = {
  create: createMemory,
  reinforce: reinforceMemory,
  edit: editMemory,
  setPinned: setMemoryPinned,
  archive: archiveMemory,
  restore: restoreMemory,
  supersede: supersedeMemory,
  expireDue: expireDueMemories,
  resolveSessionScope,
  scopeMatches,
  get: (id: string): MemoryCard | undefined => memoryStore.get(id),
};
