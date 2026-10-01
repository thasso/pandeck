/**
 * Server-authoritative memory read/mutation surface for the browser (Task 100).
 * Bounded list/search/get/loads + validated mutations, all reusing the lifecycle
 * service + selector eligibility so browser edits share the same validation,
 * optimistic concurrency, and audit rules as tools and automatic processing.
 * Testable pure-ish seam — connection.ts only sends the results over the wire.
 */
import type {
  MemoryCard,
  MemoryLineage,
  MemoryListFilter,
  MemoryListResult,
  MemoryLoadBatch,
  MemoryMutateOperation,
  MemoryMutateResult,
  MemoryScope,
  MemoryTemporal,
} from "@assistant/shared";
import { createHash } from "node:crypto";
import { memoryStore, type MemoryCardFilter } from "../db/memoryStore.ts";
import { memoryLoadStore } from "../db/memoryLoadStore.ts";
import { projectStore } from "../db/projectStore.ts";
import { userTimeZone } from "../userProfile.ts";
import {
  archiveMemory,
  editMemory,
  restoreMemory,
  setMemoryPinned,
  supersedeMemory,
  withOperationIdempotency,
  type MemoryMutationResult,
} from "./memoryService.ts";
import { temporalEligibility } from "./memorySelector.ts";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
/** Every temporal mode except `recurring` is deterministically SQL-computable for `activeNow` (see `MemoryCardFilter.activeNowMs`). */
const DETERMINISTIC_TEMPORAL_MODES = [
  "persistent",
  "until-changed",
  "window",
] as const;
/** Fixed page size for the bounded-memory recurring scan below — never the whole recurring universe at once. */
const RECURRING_SCAN_CHUNK = 200;

/**
 * Scan every `recurring` card matching `filter` in fixed-size SQL chunks
 * (never materializing the whole recurring universe at once), evaluating each
 * card's timezone-aware eligibility as it goes. Chunks advance by a KEYSET
 * cursor (`afterCursor`, matching `list`'s `updated_at_ms DESC, id` order), NOT
 * an increasing `OFFSET` — an offset-based loop would make SQLite re-walk and
 * discard the entire already-seen prefix on every call, making a full scan
 * O(N²) row visits; the cursor makes each chunk O(chunk size) regardless of how
 * far into the scan it is. Returns the EXACT count of eligible cards (a full
 * scan is unavoidable — eligibility cannot be computed in SQL) plus only the
 * page of eligible cards within `[wantOffset, wantOffset + wantLimit)`, so
 * memory stays bounded by the chunk size + the requested page size regardless
 * of how many recurring cards exist.
 */
function scanRecurringActive(
  filter: MemoryCardFilter,
  nowMs: number,
  timezone: string,
  wantOffset: number,
  wantLimit: number,
): { count: number; page: MemoryCard[] } {
  let matched = 0;
  const page: MemoryCard[] = [];
  let cursor: { updatedAtMs: number; id: string } | undefined;
  for (;;) {
    const chunk = memoryStore.list({
      ...filter,
      temporalModes: ["recurring"],
      limit: RECURRING_SCAN_CHUNK,
      offset: 0,
      ...(cursor ? { afterCursor: cursor } : {}),
    });
    if (chunk.length === 0) break;
    for (const card of chunk) {
      const t = temporalEligibility(card, nowMs, timezone);
      if (t.eligible && t.activeNow) {
        if (matched >= wantOffset && page.length < wantLimit) page.push(card);
        matched += 1;
      }
    }
    const last = chunk[chunk.length - 1]!;
    cursor = { updatedAtMs: last.updatedAt, id: last.id };
    if (chunk.length < RECURRING_SCAN_CHUNK) break;
  }
  return { count: matched, page };
}

function baseFilter(filter: MemoryListFilter): MemoryCardFilter {
  return {
    states: filter.states ?? ["active"],
    ...(filter.kinds ? { kinds: filter.kinds } : {}),
    ...(filter.pinned !== undefined ? { pinned: filter.pinned } : {}),
    ...(filter.projectId ? { projectId: filter.projectId } : {}),
    ...(filter.persona ? { persona: filter.persona } : {}),
    ...(filter.text ? { text: filter.text } : {}),
  };
}

export function listMemory(
  filter: MemoryListFilter = {},
  nowMs = Date.now(),
): MemoryListResult {
  const offset = Math.max(0, filter.offset ?? 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, filter.limit ?? DEFAULT_LIMIT));
  const base = baseFilter(filter);

  if (!filter.activeNow) {
    // Fully SQL-backed: an exact count and an exact page, at any dataset size.
    const total = memoryStore.count(base);
    const cards = memoryStore.list({ ...base, limit, offset });
    return { cards, total, hasMore: offset + cards.length < total };
  }

  // activeNow: split into a deterministic part (persistent/until-changed/window,
  // fully SQL-computable — see `activeNowMs`) and a `recurring` part, which needs
  // per-card timezone-aware weekday evaluation that cannot be expressed in SQL.
  // The deterministic part stays fully SQL-paginated/counted at any dataset size.
  // `recurring` cards are scanned in fixed-size SQL chunks (`scanRecurringActive`,
  // never materializing the whole recurring universe at once) — an exact count
  // requires examining every recurring card (eligibility isn't SQL-computable),
  // but only the requested page's worth is ever retained, so memory stays
  // bounded regardless of how many recurring cards exist. Every card is still
  // findable and `total` is always exact — never truncated by an arbitrary cap.
  const timezone = userTimeZone();
  const deterministicFilter: MemoryCardFilter = {
    ...base,
    temporalModes: [...DETERMINISTIC_TEMPORAL_MODES],
    activeNowMs: nowMs,
  };
  const deterministicTotal = memoryStore.count(deterministicFilter);

  const { count: recurringCount, page: recurringPage } = scanRecurringActive(
    base,
    nowMs,
    timezone,
    offset,
    limit,
  );

  const total = deterministicTotal + recurringCount;
  let cards: MemoryCard[];
  if (offset < recurringCount) {
    const remaining = limit - recurringPage.length;
    const fromDeterministic =
      remaining > 0
        ? memoryStore.list({
            ...deterministicFilter,
            limit: remaining,
            offset: 0,
          })
        : [];
    cards = [...recurringPage, ...fromDeterministic];
  } else {
    cards = memoryStore.list({
      ...deterministicFilter,
      limit,
      offset: offset - recurringCount,
    });
  }
  return { cards, total, hasMore: offset + cards.length < total };
}

export function getMemoryLineage(id: string): MemoryLineage {
  const card = memoryStore.get(id) ?? null;
  const predecessor = card?.supersedesId
    ? memoryStore.get(card.supersedesId)
    : undefined;
  return {
    card,
    ...(predecessor ? { predecessor } : {}),
    supersededBy: memoryStore.supersededBy(id),
  };
}

export function recentMemoryLoads(
  sessionId: string,
  limit = 20,
): MemoryLoadBatch[] {
  return memoryLoadStore.recentForSession(
    sessionId,
    Math.min(MAX_LIMIT, Math.max(1, limit)),
  );
}

function toMutateResult(result: MemoryMutationResult): MemoryMutateResult {
  if (result.ok) return { ok: true, card: result.card };
  if (result.reason === "stale")
    return { ok: false, error: "stale-revision", current: result.current };
  if (result.reason === "invalid")
    return {
      ok: false,
      error: "invalid",
      message: `${result.error.field}: ${result.error.message}`,
    };
  return { ok: false, error: "not-found" };
}

/** Explicit scoped writes must reference a real project (agent/UI can supply any string). */
function projectScopeExists(scope: MemoryScope | undefined): boolean {
  return !scope?.projectId || projectStore.get(scope.projectId) !== undefined;
}

/** Deterministic key ordering so equal operations always hash identically. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Short content hash of a validated operation, for the idempotency key below. */
function hashOperation(operation: MemoryMutateOperation): string {
  return createHash("sha256")
    .update(stableStringify(operation))
    .digest("hex")
    .slice(0, 16);
}

/** A server-trusted identity for one browser mutation request (see `mutateMemory`). */
export interface MemoryMutateIdentity {
  /** Server-minted, per-connection id — never client-supplied. */
  connectionId: string;
  /** Caller-chosen request id, only meaningful scoped to `connectionId`. */
  requestId: string;
}

/**
 * Apply a browser mutation. `identity` threads a trusted operation-identity key
 * into the ledger, so a retried browser request is an idempotent no-op — Task
 * 94's "every mutation path" idempotency. The key is derived from the
 * server-minted connection id, the request id, AND a content hash of the
 * validated operation: `requestId` alone is caller-chosen and tab-local (e.g.
 * `Date.now()+seq`), so it can collide across connections or be crafted to
 * replay an unrelated operation's cached result — the connection id and content
 * hash close both gaps.
 */
export function mutateMemory(
  operation: MemoryMutateOperation,
  identity?: MemoryMutateIdentity,
): MemoryMutateResult {
  if (
    (operation.op === "edit" || operation.op === "correct") &&
    operation.scope &&
    !projectScopeExists(operation.scope)
  ) {
    return {
      ok: false,
      error: "invalid",
      message: `unknown project: ${operation.scope.projectId}`,
    };
  }
  const opKey = identity
    ? `api:${identity.connectionId}:${identity.requestId}:${hashOperation(operation)}`
    : undefined;
  switch (operation.op) {
    case "edit":
      return toMutateResult(
        withOperationIdempotency(opKey, () =>
          editMemory(operation.id, operation.expectedRevision, {
            ...(operation.text !== undefined ? { text: operation.text } : {}),
            ...(operation.kind !== undefined ? { kind: operation.kind } : {}),
            ...(operation.scope !== undefined
              ? { scope: operation.scope }
              : {}),
            ...(operation.temporal !== undefined
              ? { temporal: operation.temporal }
              : {}),
            ...(operation.reason !== undefined
              ? { reason: operation.reason }
              : {}),
          }),
        ),
      );
    case "correct": {
      const result = supersedeMemory(
        operation.id,
        operation.expectedRevision,
        {
          text: operation.text,
          // Omitted kind/scope/temporal inherit from the corrected card.
          ...(operation.kind !== undefined ? { kind: operation.kind } : {}),
          ...(operation.scope !== undefined ? { scope: operation.scope } : {}),
          ...(operation.temporal !== undefined
            ? { temporal: operation.temporal }
            : {}),
          ...(operation.reason !== undefined
            ? { reason: operation.reason }
            : {}),
          provenance: { sourceKind: "manual" },
        },
        opKey,
      );
      if (result.ok) return { ok: true, card: result.replacement };
      if (result.reason === "stale")
        return { ok: false, error: "stale-revision", current: result.current };
      if (result.reason === "invalid")
        return {
          ok: false,
          error: "invalid",
          message: `${result.error.field}: ${result.error.message}`,
        };
      return { ok: false, error: "not-found" };
    }
    case "pin":
      return toMutateResult(
        withOperationIdempotency(opKey, () =>
          setMemoryPinned(
            operation.id,
            operation.expectedRevision,
            true,
            operation.reason,
          ),
        ),
      );
    case "unpin":
      return toMutateResult(
        withOperationIdempotency(opKey, () =>
          setMemoryPinned(
            operation.id,
            operation.expectedRevision,
            false,
            operation.reason,
          ),
        ),
      );
    case "archive":
      return toMutateResult(
        withOperationIdempotency(opKey, () =>
          archiveMemory(
            operation.id,
            operation.expectedRevision,
            operation.reason,
          ),
        ),
      );
    case "restore":
      return toMutateResult(
        withOperationIdempotency(opKey, () =>
          restoreMemory(
            operation.id,
            operation.expectedRevision,
            operation.reason,
          ),
        ),
      );
    default:
      return { ok: false, error: "invalid", message: `unknown operation` };
  }
}

/** Coerce an untrusted client filter into the bounded shape (defensive). */
export function coerceMemoryListFilter(raw: unknown): MemoryListFilter {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const filter: MemoryListFilter = {};
  if (typeof r.text === "string") filter.text = r.text.slice(0, 200);
  if (typeof r.projectId === "string") filter.projectId = r.projectId;
  if (
    r.persona === "assistant" ||
    r.persona === "personal-assistant" ||
    r.persona === "developer" ||
    r.persona === "workshop"
  )
    filter.persona = r.persona;
  if (Array.isArray(r.kinds))
    filter.kinds = r.kinds.filter(
      (k): k is MemoryCard["kind"] =>
        k === "preference" ||
        k === "fact" ||
        k === "constraint" ||
        k === "working",
    );
  if (Array.isArray(r.states))
    filter.states = r.states.filter(
      (s): s is MemoryCard["state"] =>
        s === "active" || s === "superseded" || s === "archived",
    );
  if (typeof r.pinned === "boolean") filter.pinned = r.pinned;
  if (typeof r.activeNow === "boolean") filter.activeNow = r.activeNow;
  if (typeof r.limit === "number") filter.limit = r.limit;
  if (typeof r.offset === "number") filter.offset = r.offset;
  return filter;
}

/** Coerce an untrusted mutation operation; returns null when structurally invalid. */
export function coerceMemoryMutateOperation(
  raw: unknown,
): MemoryMutateOperation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const op = r.op;
  if (typeof r.id !== "string" || typeof r.expectedRevision !== "number")
    return null;
  const base = {
    id: r.id,
    expectedRevision: r.expectedRevision,
    ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
  };
  // Scope/temporal are validated deterministically by the lifecycle service; here
  // we only pass through plain-object shapes and let the service reject invalids.
  const scope =
    typeof r.scope === "object" && r.scope !== null
      ? (r.scope as MemoryScope)
      : undefined;
  const temporal =
    typeof r.temporal === "object" && r.temporal !== null
      ? (r.temporal as MemoryTemporal)
      : undefined;
  const kind =
    r.kind === "preference" ||
    r.kind === "fact" ||
    r.kind === "constraint" ||
    r.kind === "working"
      ? r.kind
      : undefined;
  switch (op) {
    case "edit":
      return {
        op,
        ...base,
        ...(typeof r.text === "string" ? { text: r.text } : {}),
        ...(kind ? { kind } : {}),
        ...(scope ? { scope } : {}),
        ...(temporal ? { temporal } : {}),
      };
    case "correct":
      if (typeof r.text !== "string") return null;
      return {
        op,
        ...base,
        text: r.text,
        ...(kind ? { kind } : {}),
        ...(scope ? { scope } : {}),
        ...(temporal ? { temporal } : {}),
      };
    case "pin":
    case "unpin":
    case "archive":
    case "restore":
      return { op, ...base };
    default:
      return null;
  }
}
