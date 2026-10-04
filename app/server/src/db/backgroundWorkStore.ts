import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  BackgroundHostState,
  BackgroundWorkBackend,
  BackgroundWorkIntent,
  BackgroundWorkKind,
  BackgroundWorkState,
  BackgroundWorkStopState,
  SessionBackgroundActivity,
} from "@assistant/shared";
import { BACKGROUND_WORK_COMMAND_MAX_CHARS } from "@assistant/shared";
import { getDb, withDbTransaction } from "./index.ts";
import { nextId } from "./sequences.ts";
import { sessionStore } from "./sessionStore.ts";

/**
 * Durable, provider-neutral background work owned by a session (Task-482).
 *
 * The store owns the LEGAL transitions and the derived owner-slot capacity; it
 * owns no provider handle. Claude event bindings and pi process handles are
 * backend-internal, so nothing here takes a vendor task id as an address, and
 * no OS process id, credential, environment, path or output body is persisted.
 *
 * Every write enters `mutation`, which stamps revisions for the touched rows
 * inside the same transaction and notifies once after COMMIT
 * (`docs/state-sync.md`).
 */

const NONTERMINAL_STATES = new Set<BackgroundWorkState>([
  "pending-launch",
  "running",
]);
const TERMINAL_STATES = new Set<BackgroundWorkState>([
  "completed",
  "failed",
  "not-started",
  "stopped",
  "lost",
]);
const LIVE_HOST_STATES = new Set<BackgroundHostState>([
  "creating",
  "live",
  "draining",
]);

const LABEL_MAX_CHARS = 200;
const COMMAND_MAX_CHARS = BACKGROUND_WORK_COMMAND_MAX_CHARS;
const REASON_MAX_CHARS = 500;
const SUMMARY_MAX_CHARS = 2_000;
const ID_MAX_CHARS = 200;
const LIST_LIMIT_MAX = 200;

interface BackgroundWorkEvidence {
  artifactId?: string;
  originalBytes?: number;
  capturedBytes?: number;
  truncated?: boolean;
  text?: boolean;
  refusalReason?: string;
}

interface BackgroundHost {
  id: string;
  ownerSessionId: string;
  backend: "claude-query";
  epochKey: string;
  bootEpoch: string;
  state: BackgroundHostState;
  stopAllRequestedAt?: number;
  stopAllReason?: string;
  emptyGraceMs: number;
  settingsGeneration: number;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  terminalReason?: string;
  revision: number;
}

export interface BackgroundWorkItem {
  id: string;
  ownerSessionId: string;
  hostId?: string;
  backend: BackgroundWorkBackend;
  kind: BackgroundWorkKind;
  label: string;
  description?: string;
  command?: string;
  commandTruncated?: boolean;
  sourceRequestId: string;
  provenance: BackgroundWorkProvenance;
  providerTaskId?: string;
  providerTaskType?: string;
  state: BackgroundWorkState;
  intent: BackgroundWorkIntent;
  stopState: BackgroundWorkStopState;
  stopReason?: string;
  stopRequestedAt?: number;
  stopAttempts: number;
  stopLastAttemptAt?: number;
  stopAckDeadlineAt?: number;
  stopEvidence?: string;
  drainReason?: string;
  lifetimeMs: number;
  deadlineAt: number;
  settingsGeneration: number;
  bootEpoch: string;
  exitCode?: number;
  outcomeSummary?: string;
  terminalReason?: string;
  evidence?: BackgroundWorkEvidence;
  lastEventId?: string;
  lastEventSeq?: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  terminalAt?: number;
  revision: number;
}

/**
 * How this row came to exist. `reserved` is the only normal path: PA admitted
 * the work before it executed. The two `observed-*` values are degraded
 * reconciliation for work already running without a reservation, and
 * `observed-over-cap` additionally records that no owner slot was available —
 * it is counted, never evicted, and admits nothing further on that host.
 */
type BackgroundWorkProvenance =
  "reserved" | "observed-adopted" | "observed-over-cap";

interface BackgroundWorkRevisionRow {
  id: string;
  revision: number;
  member: boolean;
}

export interface BackgroundWorkStateChange {
  itemIds: string[];
  hostIds: string[];
  ownerSessionIds: string[];
}

/** The lazily created Claude host epoch an admission may need. */
interface BackgroundHostReservation {
  epochKey: string;
  emptyGraceMs: number;
}

export interface ReserveBackgroundWorkInput {
  id?: string;
  ownerSessionId: string;
  backend: BackgroundWorkBackend;
  kind: BackgroundWorkKind;
  label: string;
  /** The agent's own description of the job, bounded like the label. */
  description?: string;
  /** The command line (or monitor URL); cut at `COMMAND_MAX_CHARS`. */
  command?: string;
  /** The caller's request identity; repeating it returns the same row. */
  sourceRequestId: string;
  lifetimeMs: number;
  settingsGeneration: number;
  bootEpoch: string;
  /** Background-owning SESSION cap, resolved by the caller from Settings. */
  ownerLimit: number;
  /** Present only for `claude-query`: creates or reuses the retained epoch. */
  host?: BackgroundHostReservation;
  now?: number;
}

interface ObserveBackgroundWorkInput extends Omit<
  ReserveBackgroundWorkInput,
  "id"
> {
  id?: string;
  /** Already executing when observed, so the row starts `running`. */
  firstObservedAt?: number;
}

interface BindBackgroundProviderInput {
  itemId: string;
  providerTaskId: string;
  providerTaskType?: string;
  now?: number;
}

interface BackgroundEvidenceInput {
  itemId: string;
  /** Provider event identity; a repeat is ignored. */
  eventId?: string;
  /** Monotonic per item; an older sequence is ignored. */
  sequence?: number;
  evidence?: BackgroundWorkEvidence;
  outcomeSummary?: string;
  now?: number;
}

interface TerminalizeBackgroundWorkInput extends BackgroundEvidenceInput {
  state: Exclude<BackgroundWorkState, "pending-launch" | "running">;
  reason?: string;
  exitCode?: number;
}

interface RequestBackgroundStopInput {
  itemId: string;
  reason: string;
  /** Idempotency key for the Stop itself; a repeat records no second attempt. */
  sourceRequestId: string;
  ackDeadlineMs?: number;
  now?: number;
}

/** What a Stop reservation did, so the caller knows whether to act. */
interface BackgroundStopReservation {
  item: BackgroundWorkItem;
  /** True when this call reserved it; false when an earlier request already had. */
  reserved: boolean;
  /** True when the Stop won the pre-execution race and nothing must be signalled. */
  preventedLaunch: boolean;
}

export class BackgroundWorkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackgroundWorkValidationError";
  }
}

export class BackgroundWorkCapacityError extends Error {
  readonly ownerSessionId: string;
  readonly limit: number;
  constructor(ownerSessionId: string, limit: number, message?: string) {
    super(
      message ??
        `background work is at capacity: ${limit} session(s) already own background work`,
    );
    this.name = "BackgroundWorkCapacityError";
    this.ownerSessionId = ownerSessionId;
    this.limit = limit;
  }
}

/**
 * A reserved admission aimed at an epoch that was recorded over cap. This is
 * NOT ordinary cap exhaustion — the epoch is permanently ineligible, whatever
 * capacity is free now — so it says so, while remaining a capacity refusal for
 * an admission path that only needs to know the work was not admitted. The
 * `limit` stays the one the caller supplied, never a fabricated zero.
 */
export class BackgroundWorkOverCapEpochError extends BackgroundWorkCapacityError {
  readonly epochKey: string;
  constructor(ownerSessionId: string, limit: number, epochKey: string) {
    super(
      ownerSessionId,
      limit,
      `host epoch ${epochKey} was recorded over capacity and cannot accept newly admitted work`,
    );
    this.name = "BackgroundWorkOverCapEpochError";
    this.epochKey = epochKey;
  }
}

interface HostRow {
  id: string;
  owner_session_id: string;
  backend: "claude-query";
  epoch_key: string;
  boot_epoch: string;
  provenance: BackgroundWorkProvenance;
  state: BackgroundHostState;
  stop_all_requested_at_ms: number | null;
  stop_all_reason: string | null;
  empty_grace_ms: number;
  settings_generation: number;
  created_at_ms: number;
  updated_at_ms: number;
  closed_at_ms: number | null;
  terminal_reason: string | null;
  revision: number;
}

interface ItemRow {
  id: string;
  owner_session_id: string;
  host_id: string | null;
  backend: BackgroundWorkBackend;
  kind: BackgroundWorkKind;
  label: string;
  description: string | null;
  command: string | null;
  command_truncated: number;
  source_request_id: string;
  provenance: BackgroundWorkProvenance;
  provider_task_id: string | null;
  provider_task_type: string | null;
  state: BackgroundWorkState;
  intent: BackgroundWorkIntent;
  stop_state: BackgroundWorkStopState;
  stop_reason: string | null;
  stop_requested_at_ms: number | null;
  stop_attempts: number;
  stop_last_attempt_at_ms: number | null;
  stop_ack_deadline_at_ms: number | null;
  stop_source_request_id: string | null;
  stop_evidence: string | null;
  drain_reason: string | null;
  lifetime_ms: number;
  deadline_at_ms: number;
  settings_generation: number;
  boot_epoch: string;
  exit_code: number | null;
  outcome_summary: string | null;
  terminal_reason: string | null;
  evidence_artifact_id: string | null;
  evidence_original_bytes: number | null;
  evidence_captured_bytes: number | null;
  evidence_truncated: number;
  evidence_text: number;
  evidence_refusal_reason: string | null;
  last_event_id: string | null;
  last_event_seq: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  started_at_ms: number | null;
  terminal_at_ms: number | null;
  revision: number;
  is_member: number;
  deleted_at_ms: number | null;
}

function bounded(value: string, max: number, name: string): string {
  const text = value.trim();
  if (!text) throw new BackgroundWorkValidationError(`${name} is required`);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function boundedOptional(
  value: string | undefined,
  max: number,
  name: string,
): string | null {
  if (value === undefined) return null;
  return bounded(value, max, name);
}

/**
 * The command line, cut at the cap with the cut RECORDED rather than hidden
 * behind an ellipsis: a reader of a 4 KB script needs to know the row is not
 * the whole of it. Whitespace-only input is no command at all.
 */
function boundedCommand(value: string | undefined): {
  text: string | null;
  truncated: boolean;
} {
  const text = value?.trim() ?? "";
  if (!text) return { text: null, truncated: false };
  if (text.length <= COMMAND_MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, COMMAND_MAX_CHARS), truncated: true };
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new BackgroundWorkValidationError(
      `${name} must be a positive safe integer`,
    );
  return value;
}

function safeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value))
    throw new BackgroundWorkValidationError(`${name} must be a safe integer`);
  return value;
}

function nonnegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new BackgroundWorkValidationError(
      `${name} must be a non-negative safe integer`,
    );
  return value;
}

function evidenceOf(row: ItemRow): BackgroundWorkEvidence | undefined {
  const hasEvidence =
    row.evidence_artifact_id !== null ||
    row.evidence_original_bytes !== null ||
    row.evidence_captured_bytes !== null ||
    row.evidence_truncated !== 0 ||
    row.evidence_text !== 0 ||
    row.evidence_refusal_reason !== null;
  if (!hasEvidence) return undefined;
  return {
    ...(row.evidence_artifact_id
      ? { artifactId: row.evidence_artifact_id }
      : {}),
    ...(row.evidence_original_bytes !== null
      ? { originalBytes: row.evidence_original_bytes }
      : {}),
    ...(row.evidence_captured_bytes !== null
      ? { capturedBytes: row.evidence_captured_bytes }
      : {}),
    truncated: row.evidence_truncated !== 0,
    text: row.evidence_text !== 0,
    ...(row.evidence_refusal_reason
      ? { refusalReason: row.evidence_refusal_reason }
      : {}),
  };
}

function itemOf(row: ItemRow): BackgroundWorkItem {
  const evidence = evidenceOf(row);
  return {
    id: row.id,
    ownerSessionId: row.owner_session_id,
    ...(row.host_id ? { hostId: row.host_id } : {}),
    backend: row.backend,
    kind: row.kind,
    label: row.label,
    ...(row.description ? { description: row.description } : {}),
    ...(row.command ? { command: row.command } : {}),
    ...(row.command_truncated ? { commandTruncated: true } : {}),
    sourceRequestId: row.source_request_id,
    provenance: row.provenance,
    ...(row.provider_task_id ? { providerTaskId: row.provider_task_id } : {}),
    ...(row.provider_task_type
      ? { providerTaskType: row.provider_task_type }
      : {}),
    state: row.state,
    intent: row.intent,
    stopState: row.stop_state,
    ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
    ...(row.stop_requested_at_ms !== null
      ? { stopRequestedAt: row.stop_requested_at_ms }
      : {}),
    stopAttempts: row.stop_attempts,
    ...(row.stop_last_attempt_at_ms !== null
      ? { stopLastAttemptAt: row.stop_last_attempt_at_ms }
      : {}),
    ...(row.stop_ack_deadline_at_ms !== null
      ? { stopAckDeadlineAt: row.stop_ack_deadline_at_ms }
      : {}),
    ...(row.stop_evidence ? { stopEvidence: row.stop_evidence } : {}),
    ...(row.drain_reason ? { drainReason: row.drain_reason } : {}),
    lifetimeMs: row.lifetime_ms,
    deadlineAt: row.deadline_at_ms,
    settingsGeneration: row.settings_generation,
    bootEpoch: row.boot_epoch,
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.outcome_summary ? { outcomeSummary: row.outcome_summary } : {}),
    ...(row.terminal_reason ? { terminalReason: row.terminal_reason } : {}),
    ...(evidence ? { evidence } : {}),
    ...(row.last_event_id ? { lastEventId: row.last_event_id } : {}),
    ...(row.last_event_seq !== null
      ? { lastEventSeq: row.last_event_seq }
      : {}),
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    ...(row.started_at_ms !== null ? { startedAt: row.started_at_ms } : {}),
    ...(row.terminal_at_ms !== null ? { terminalAt: row.terminal_at_ms } : {}),
    revision: row.revision,
  };
}

function hostOf(row: HostRow): BackgroundHost {
  return {
    id: row.id,
    ownerSessionId: row.owner_session_id,
    backend: row.backend,
    epochKey: row.epoch_key,
    bootEpoch: row.boot_epoch,
    state: row.state,
    ...(row.stop_all_requested_at_ms !== null
      ? { stopAllRequestedAt: row.stop_all_requested_at_ms }
      : {}),
    ...(row.stop_all_reason ? { stopAllReason: row.stop_all_reason } : {}),
    emptyGraceMs: row.empty_grace_ms,
    settingsGeneration: row.settings_generation,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    ...(row.closed_at_ms !== null ? { closedAt: row.closed_at_ms } : {}),
    ...(row.terminal_reason ? { terminalReason: row.terminal_reason } : {}),
    revision: row.revision,
  };
}

function rawItem(id: string): ItemRow | undefined {
  return getDb()
    .prepare("SELECT * FROM background_work_items WHERE id = ?")
    .get(id) as ItemRow | undefined;
}

function rawHost(id: string): HostRow | undefined {
  return getDb()
    .prepare("SELECT * FROM background_hosts WHERE id = ?")
    .get(id) as HostRow | undefined;
}

function requireItem(id: string): ItemRow {
  const row = rawItem(id);
  if (!row || row.is_member === 0)
    throw new BackgroundWorkValidationError(
      `background work item ${id} does not exist`,
    );
  return row;
}

function requireHost(id: string): HostRow {
  const row = rawHost(id);
  if (!row)
    throw new BackgroundWorkValidationError(
      `background host ${id} does not exist`,
    );
  return row;
}

interface PendingTouches {
  itemIds: Set<string>;
  hostIds: Set<string>;
}

let stateChangeNotifier:
  ((change: BackgroundWorkStateChange) => void) | undefined;

/** The hub installs the one post-commit fan-out here; no projection read runs in a transaction. */
export function setBackgroundWorkStateChangeNotifier(
  notifier: ((change: BackgroundWorkStateChange) => void) | undefined,
): void {
  stateChangeNotifier = notifier;
}

/**
 * Ids bound per `IN (…)` statement. A write may touch every row one owner ever
 * had, which is unbounded, so no statement may bind them all at once.
 */
const IDS_PER_STATEMENT = 500;

/** `sql` ends in `IN`; runs it once per chunk of `ids` and concatenates. */
function selectByIds<Row>(
  db: DatabaseSync,
  sql: string,
  ids: readonly string[],
): Row[] {
  const rows: Row[] = [];
  for (let start = 0; start < ids.length; start += IDS_PER_STATEMENT) {
    const chunk = ids.slice(start, start + IDS_PER_STATEMENT);
    rows.push(
      ...(db
        .prepare(`${sql} (${chunk.map(() => "?").join(", ")})`)
        .all(...(chunk as never[])) as Row[]),
    );
  }
  return rows;
}

/**
 * Stamp every touched row from one persisted sequence. A touched host pulls in
 * its items, because the host's state is part of each item's projection and a
 * subscriber holding only items must still see it move.
 */
function markStateChanged(
  db: DatabaseSync,
  pending: PendingTouches,
): BackgroundWorkStateChange | undefined {
  const hostIds = [...pending.hostIds];
  const itemIds = new Set(pending.itemIds);
  for (const row of selectByIds<{ id: string }>(
    db,
    `SELECT id FROM background_work_items
     WHERE is_member = 1 AND host_id IN`,
    hostIds,
  ))
    itemIds.add(row.id);
  if (itemIds.size === 0 && hostIds.length === 0) return undefined;

  const revision = nextId("background_work_revision");
  const updateItem = db.prepare(
    "UPDATE background_work_items SET revision = ? WHERE id = ?",
  );
  const updateHost = db.prepare(
    "UPDATE background_hosts SET revision = ? WHERE id = ?",
  );
  for (const id of itemIds) updateItem.run(revision, id);
  for (const id of hostIds) updateHost.run(revision, id);

  const ids = [...itemIds].sort();
  const owners = new Set<string>();
  for (const row of selectByIds<{ owner_session_id: string }>(
    db,
    "SELECT DISTINCT owner_session_id FROM background_work_items WHERE id IN",
    ids,
  ))
    owners.add(row.owner_session_id);
  for (const row of selectByIds<{ owner_session_id: string }>(
    db,
    "SELECT DISTINCT owner_session_id FROM background_hosts WHERE id IN",
    hostIds,
  ))
    owners.add(row.owner_session_id);
  return {
    itemIds: ids,
    hostIds: [...new Set(hostIds)].sort(),
    ownerSessionIds: [...owners].sort(),
  };
}

/**
 * One write sequence: `fn` performs the writes and returns a PROJECTOR, which
 * runs after the revisions are stamped but still inside the transaction. That
 * ordering is why a caller's returned row already carries the revision this
 * write minted, instead of the one it replaced.
 */
function mutation<T>(fn: (touch: PendingTouches) => () => T): T {
  const committed = withDbTransaction(() => {
    const touch: PendingTouches = { itemIds: new Set(), hostIds: new Set() };
    const project = fn(touch);
    const change = markStateChanged(getDb(), touch);
    return { value: project(), change };
  });
  if (committed.change) stateChangeNotifier?.(committed.change);
  return committed.value;
}

/**
 * The owner session must be a live `user` session: background work is the
 * user's to see and stop. This is the durable floor under Task-483's richer
 * eligibility policy, not a replacement for it.
 */
function requireOwnerSession(ownerSessionId: string): void {
  const row = getDb()
    .prepare("SELECT scope, deleted_at_ms FROM session_index WHERE id = ?")
    .get(ownerSessionId) as
    { scope: string; deleted_at_ms: number | null } | undefined;
  if (!row || row.deleted_at_ms !== null)
    throw new BackgroundWorkValidationError(
      `owner session ${ownerSessionId} does not exist`,
    );
  if (row.scope !== "user")
    throw new BackgroundWorkValidationError(
      `session ${ownerSessionId} (scope ${row.scope}) may not own background work`,
    );
}

/**
 * The derived owner slot: a session HOLDS one exactly while it has admitted
 * nonterminal work or a live host epoch, so no bookkeeping can drift from the
 * truth. A launch that never happened releases the slot through `failLaunch` or
 * a pre-launch owner Stop — the two paths that may conclude nothing ran — while
 * an ordinary `terminalize` is a runtime outcome and releases no reservation.
 *
 * `observed-over-cap` work is deliberately excluded: it exists because the cap
 * was already full, so treating it as a held slot would turn one unreserved
 * observation into a licence to admit more.
 */
function holdsOwnerSlot(ownerSessionId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT
         EXISTS (
           SELECT 1 FROM background_work_items
           WHERE owner_session_id = ? AND is_member = 1
             AND state IN ('pending-launch', 'running')
             AND provenance <> 'observed-over-cap'
         ) OR EXISTS (
           SELECT 1 FROM background_hosts
           WHERE owner_session_id = ? AND state IN ('creating', 'live', 'draining')
             AND provenance <> 'observed-over-cap'
         ) AS held`,
    )
    .get(ownerSessionId, ownerSessionId) as { held: number };
  return row.held === 1;
}

/**
 * Occupancy, which is not quite the same question: an over-cap observation is
 * real work on the machine, so it counts here even though its owner cannot
 * reuse it. That keeps the cap from handing out more while over-subscribed.
 */
function occupiedOwnerSlots(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM (
         SELECT owner_session_id FROM background_work_items
         WHERE is_member = 1 AND state IN ('pending-launch', 'running')
         UNION
         SELECT owner_session_id FROM background_hosts
         WHERE state IN ('creating', 'live', 'draining')
       )`,
    )
    .get() as { count: number };
  return row.count;
}

/**
 * Atomically claim the owner slot. Reuse is free — the same session's later
 * children never consume a second slot — so only a session with no live work
 * can be refused, and the last free slot is decided inside this transaction.
 */
function claimOwnerSlot(ownerSessionId: string, limit: number): boolean {
  positiveSafeInteger(limit, "ownerLimit");
  if (holdsOwnerSlot(ownerSessionId)) return false;
  if (occupiedOwnerSlots() >= limit)
    throw new BackgroundWorkCapacityError(ownerSessionId, limit);
  return true;
}

/**
 * Look the row up by the SAME normalized identity the insert stores. Comparing
 * the raw value would miss an over-long id that was truncated on the way in,
 * and the retry would then collide with the uniqueness constraint instead of
 * being recognised as the same admission.
 */
function existingSource(
  ownerSessionId: string,
  sourceRequestId: string,
): ItemRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM background_work_items
       WHERE owner_session_id = ? AND source_request_id = ?`,
    )
    .get(
      ownerSessionId,
      bounded(sourceRequestId, ID_MAX_CHARS, "sourceRequestId"),
    ) as ItemRow | undefined;
}

function liveHostForOwner(ownerSessionId: string): HostRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM background_hosts
       WHERE owner_session_id = ? AND state IN ('creating', 'live', 'draining')`,
    )
    .get(ownerSessionId) as HostRow | undefined;
}

/**
 * A `creating` epoch is a RESERVATION; the moment any child demonstrably
 * executes, the query it executes in is live. Promoting here rather than
 * waiting for the backend to say so is what keeps the reservation-release path
 * below from ever mistaking a running epoch for one nothing ran in.
 */
function promoteHostToLive(
  touch: PendingTouches,
  hostId: string,
  now: number,
): void {
  const host = rawHost(hostId);
  if (!host || host.state !== "creating") return;
  getDb()
    .prepare(
      "UPDATE background_hosts SET state = 'live', updated_at_ms = ? WHERE id = ?",
    )
    .run(now, hostId);
  touch.hostIds.add(hostId);
}

/**
 * Create the retained Claude epoch lazily, or reuse the owner's live one. An
 * ordinary transient query never reaches this: it is called only when the first
 * background item on that query is admitted or observed.
 */
function ensureHostRow(
  touch: PendingTouches,
  input: {
    ownerSessionId: string;
    reservation: BackgroundHostReservation;
    provenance: BackgroundWorkProvenance;
    /** The caller's configured cap, reported verbatim by a refusal below. */
    ownerLimit: number;
    /** Observed work is already executing, so its epoch is live, not reserved. */
    live: boolean;
    settingsGeneration: number;
    bootEpoch: string;
    now: number;
  },
): HostRow {
  const epochKey = bounded(
    input.reservation.epochKey,
    ID_MAX_CHARS,
    "host.epochKey",
  );
  const byEpoch = getDb()
    .prepare("SELECT * FROM background_hosts WHERE epoch_key = ?")
    .get(epochKey) as HostRow | undefined;
  if (byEpoch) {
    if (byEpoch.owner_session_id !== input.ownerSessionId)
      throw new BackgroundWorkValidationError(
        `host epoch ${epochKey} belongs to another session`,
      );
    if (!LIVE_HOST_STATES.has(byEpoch.state))
      throw new BackgroundWorkValidationError(
        `host epoch ${epochKey} is ${byEpoch.state} and cannot take new work`,
      );
    // An epoch first seen over cap stays over cap. Admitting reserved work into
    // it would launder the breach into an ordinary held slot.
    if (
      byEpoch.provenance === "observed-over-cap" &&
      input.provenance === "reserved"
    )
      throw new BackgroundWorkOverCapEpochError(
        input.ownerSessionId,
        input.ownerLimit,
        epochKey,
      );
    if (input.live && byEpoch.state === "creating")
      promoteHostToLive(touch, byEpoch.id, input.now);
    return rawHost(byEpoch.id) ?? byEpoch;
  }
  const live = liveHostForOwner(input.ownerSessionId);
  if (live)
    throw new BackgroundWorkValidationError(
      `session ${input.ownerSessionId} already retains host epoch ${live.epoch_key}`,
    );
  const id = `bgh_${randomUUID()}`;
  getDb()
    .prepare(
      `INSERT INTO background_hosts (
        id, owner_session_id, backend, epoch_key, boot_epoch, provenance, state,
        empty_grace_ms, settings_generation, created_at_ms, updated_at_ms, revision
      ) VALUES (?, ?, 'claude-query', ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      id,
      input.ownerSessionId,
      epochKey,
      bounded(input.bootEpoch, ID_MAX_CHARS, "bootEpoch"),
      // The epoch inherits the admission's provenance: an epoch first seen
      // over cap is counted but is never a slot its owner may reuse.
      input.provenance,
      // Observed work is running INSIDE this query already, so the epoch is
      // live on arrival; only a pre-execution reservation starts `creating`.
      input.live ? "live" : "creating",
      nonnegativeSafeInteger(
        input.reservation.emptyGraceMs,
        "host.emptyGraceMs",
      ),
      nonnegativeSafeInteger(input.settingsGeneration, "settingsGeneration"),
      input.now,
      input.now,
    );
  touch.hostIds.add(id);
  return requireHost(id);
}

function insertItem(
  touch: PendingTouches,
  input: ReserveBackgroundWorkInput,
  options: {
    provenance: BackgroundWorkProvenance;
    state: "pending-launch" | "running";
    startedAt?: number;
    now: number;
  },
): ItemRow {
  requireOwnerSession(input.ownerSessionId);
  if (input.backend !== "claude-query" && input.host)
    throw new BackgroundWorkValidationError(
      "only claude-query work has a retained host epoch",
    );
  // A Claude background task IS work inside a retained query: it executes
  // there, and its provider handle means nothing outside that epoch. A hostless
  // `claude-query` row could never be bound or stopped, so it may not exist.
  if (input.backend === "claude-query" && !input.host)
    throw new BackgroundWorkValidationError(
      "claude-query work requires its retained host epoch",
    );
  const host = input.host
    ? ensureHostRow(touch, {
        ownerSessionId: input.ownerSessionId,
        reservation: input.host,
        provenance: options.provenance,
        ownerLimit: input.ownerLimit,
        live: options.state === "running",
        settingsGeneration: input.settingsGeneration,
        bootEpoch: input.bootEpoch,
        now: options.now,
      })
    : undefined;
  const lifetimeMs = positiveSafeInteger(input.lifetimeMs, "lifetimeMs");
  // The deadline is frozen HERE, from the admission-time lifetime, and is never
  // recomputed from later Settings.
  const anchor = options.startedAt ?? options.now;
  const id = input.id ?? `bgw_${randomUUID()}`;
  const command = boundedCommand(input.command);
  getDb()
    .prepare(
      `INSERT INTO background_work_items (
        id, owner_session_id, host_id, backend, kind, label, description,
        command, command_truncated, source_request_id,
        provenance, state, stop_state, stop_attempts, lifetime_ms, deadline_at_ms,
        settings_generation, boot_epoch, evidence_truncated, evidence_text,
        created_at_ms, updated_at_ms, started_at_ms, revision, is_member
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 0, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0, 1)`,
    )
    .run(
      id,
      input.ownerSessionId,
      host?.id ?? null,
      input.backend,
      input.kind,
      bounded(input.label, LABEL_MAX_CHARS, "label"),
      // A blank description is no description, not a validation error: the
      // agent's parameter is optional and free text.
      boundedOptional(
        input.description?.trim() ? input.description : undefined,
        LABEL_MAX_CHARS,
        "description",
      ),
      command.text,
      command.truncated ? 1 : 0,
      bounded(input.sourceRequestId, ID_MAX_CHARS, "sourceRequestId"),
      // The epoch's provenance governs its children. A child observed inside an
      // over-cap epoch is over-cap too, whatever capacity happens to be free at
      // that instant — otherwise "held" would flap with whichever child is
      // currently active while the same epoch stays live throughout.
      host?.provenance === "observed-over-cap"
        ? "observed-over-cap"
        : options.provenance,
      options.state,
      lifetimeMs,
      anchor + lifetimeMs,
      nonnegativeSafeInteger(input.settingsGeneration, "settingsGeneration"),
      bounded(input.bootEpoch, ID_MAX_CHARS, "bootEpoch"),
      options.now,
      options.now,
      options.startedAt ?? null,
    );
  touch.itemIds.add(id);
  return requireItem(id);
}

/**
 * Atomic pre-execution admission: idempotent on the caller's request identity,
 * claims the owner slot (and lazily the retained host epoch) in one
 * transaction, and leaves the item `pending-launch` so a Stop can still win the
 * race before anything executes.
 */
function reserveItem(input: ReserveBackgroundWorkInput): BackgroundWorkItem {
  return mutation((touch) => {
    const now = input.now ?? Date.now();
    const existing = existingSource(
      input.ownerSessionId,
      input.sourceRequestId,
    );
    // A retried admission reserves nothing new; the first reservation stands
    // with its frozen deadline and generation.
    if (existing) return () => itemOf(existing);
    claimOwnerSlot(input.ownerSessionId, input.ownerLimit);
    const inserted = insertItem(touch, input, {
      provenance: "reserved",
      state: "pending-launch",
      now,
    });
    return () => itemOf(requireItem(inserted.id));
  });
}

/**
 * Degraded reconciliation for work already executing without a reservation.
 * The slot is adopted when one is free (`observed-adopted`); otherwise the row
 * is recorded and counted as `observed-over-cap` — never evicted, and never a
 * reason to admit more.
 */
function observeItem(input: ObserveBackgroundWorkInput): BackgroundWorkItem {
  return mutation((touch) => {
    const now = input.now ?? Date.now();
    const existing = existingSource(
      input.ownerSessionId,
      input.sourceRequestId,
    );
    if (existing) return () => itemOf(existing);
    // The observed row's lifetime is frozen from when it was FIRST SEEN: the
    // real start is unknown and inventing one would move its deadline.
    const firstObservedAt = input.firstObservedAt ?? now;
    let provenance: BackgroundWorkProvenance;
    try {
      claimOwnerSlot(input.ownerSessionId, input.ownerLimit);
      provenance = "observed-adopted";
    } catch (err) {
      if (!(err instanceof BackgroundWorkCapacityError)) throw err;
      provenance = "observed-over-cap";
    }
    const inserted = insertItem(touch, input, {
      provenance,
      state: "running",
      startedAt: firstObservedAt,
      now,
    });
    return () => itemOf(requireItem(inserted.id));
  });
}

function assertNonterminal(row: ItemRow, action: string): void {
  if (TERMINAL_STATES.has(row.state))
    throw new BackgroundWorkValidationError(
      `background work item ${row.id} is ${row.state}; ${action} is not legal`,
    );
}

/**
 * Reject evidence that has already been applied or that arrived out of order.
 * Provider snapshots repeat and reorder; neither may move a row backwards.
 *
 * The two guards are deliberately different in strength, and a caller has to
 * know which one it is relying on. `sequence` is the ORDERING guard: monotonic
 * per item, it rejects anything at or below what was already applied, so it
 * covers both duplicates and reordering. `eventId` alone only recognises the
 * IMMEDIATELY preceding event — one stored id cannot remember a whole history —
 * so a backend whose events can arrive non-adjacently out of order must supply
 * a sequence rather than rely on ids.
 */
function evidenceIsStale(
  row: ItemRow,
  eventId: string | undefined,
  sequence: number | undefined,
): boolean {
  if (eventId && row.last_event_id === eventId) return true;
  if (
    sequence !== undefined &&
    row.last_event_seq !== null &&
    sequence <= row.last_event_seq
  )
    return true;
  return false;
}

function recordEventIdentity(
  row: ItemRow,
  eventId: string | undefined,
  sequence: number | undefined,
): void {
  if (eventId === undefined && sequence === undefined) return;
  getDb()
    .prepare(
      `UPDATE background_work_items
       SET last_event_id = COALESCE(?, last_event_id),
           last_event_seq = COALESCE(?, last_event_seq)
       WHERE id = ?`,
    )
    .run(
      eventId ? bounded(eventId, ID_MAX_CHARS, "eventId") : null,
      sequence === undefined
        ? null
        : nonnegativeSafeInteger(sequence, "sequence"),
      row.id,
    );
}

/**
 * Bind the authoritative provider handle. Uniqueness is per host epoch, because
 * a vendor id is only meaningful inside the query that issued it. A Stop that
 * was waiting for this binding becomes an ordinary outstanding request.
 */
function bindProvider(input: BindBackgroundProviderInput): BackgroundWorkItem {
  return mutation((touch) => {
    const now = input.now ?? Date.now();
    const row = requireItem(input.itemId);
    assertNonterminal(row, "provider binding");
    if (!row.host_id)
      throw new BackgroundWorkValidationError(
        `background work item ${row.id} has no host epoch to bind against`,
      );
    const providerTaskId = bounded(
      input.providerTaskId,
      ID_MAX_CHARS,
      "providerTaskId",
    );
    if (row.provider_task_id && row.provider_task_id !== providerTaskId)
      throw new BackgroundWorkValidationError(
        `background work item ${row.id} is already bound to another provider task`,
      );
    getDb()
      .prepare(
        `UPDATE background_work_items
         SET provider_task_id = ?, provider_task_type = COALESCE(?, provider_task_type),
             stop_state = CASE WHEN stop_state = 'awaiting-binding' THEN 'requested' ELSE stop_state END,
             updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(
        providerTaskId,
        boundedOptional(
          input.providerTaskType,
          ID_MAX_CHARS,
          "providerTaskType",
        ),
        now,
        row.id,
      );
    touch.itemIds.add(row.id);
    return () => itemOf(requireItem(row.id));
  });
}

/** `pending-launch` → `running`: execution has begun and Stop must now signal. */
function markRunning(input: BackgroundEvidenceInput): BackgroundWorkItem {
  return mutation((touch) => {
    const now = input.now ?? Date.now();
    const row = requireItem(input.itemId);
    if (evidenceIsStale(row, input.eventId, input.sequence))
      return () => itemOf(row);
    if (row.state === "running") {
      // Already running, but this snapshot is NEWER than the last one applied:
      // advance the cursor, or an older event that follows it would still be
      // accepted and could rewind the row's evidence.
      if (input.eventId === undefined && input.sequence === undefined)
        return () => itemOf(row);
      recordEventIdentity(row, input.eventId, input.sequence);
      touch.itemIds.add(row.id);
      return () => itemOf(requireItem(row.id));
    }
    assertNonterminal(row, "start");
    // Execution has begun inside the query, so its epoch is no longer a
    // reservation — recorded here rather than trusting the backend to say so.
    if (row.host_id) promoteHostToLive(touch, row.host_id, now);
    getDb()
      .prepare(
        `UPDATE background_work_items
         SET state = 'running', started_at_ms = COALESCE(started_at_ms, ?), updated_at_ms = ?
         WHERE id = ? AND state = 'pending-launch'`,
      )
      .run(now, now, row.id);
    recordEventIdentity(row, input.eventId, input.sequence);
    touch.itemIds.add(row.id);
    return () => itemOf(requireItem(row.id));
  });
}

function applyEvidence(
  row: ItemRow,
  evidence: BackgroundWorkEvidence | undefined,
  outcomeSummary: string | undefined,
  now: number,
): void {
  if (!evidence && outcomeSummary === undefined) return;
  // The artifact identity is immutable: the row PINS one retained capture, and
  // silently repointing it would strand the old artifact and change what an
  // already-reported completion refers to. Compared in NORMALIZED form, or an
  // over-long id would read as a different artifact every time it repeated.
  const artifactId = evidence?.artifactId
    ? bounded(evidence.artifactId, ID_MAX_CHARS, "evidence.artifactId")
    : null;
  if (
    artifactId &&
    row.evidence_artifact_id &&
    row.evidence_artifact_id !== artifactId
  )
    throw new BackgroundWorkValidationError(
      `background work item ${row.id} already pins another evidence artifact`,
    );
  // The store and the schema reject the same states: validate the MERGED
  // result, since each call may supply only part of it, so an incoherent
  // capture is a named refusal here rather than a raw constraint failure.
  const mergedOriginal =
    evidence?.originalBytes ?? row.evidence_original_bytes ?? undefined;
  const mergedCaptured =
    evidence?.capturedBytes ?? row.evidence_captured_bytes ?? undefined;
  const mergedTruncated =
    evidence?.truncated ?? Boolean(row.evidence_truncated);
  if (
    mergedOriginal !== undefined &&
    mergedCaptured !== undefined &&
    mergedCaptured > mergedOriginal
  )
    throw new BackgroundWorkValidationError(
      `evidence.capturedBytes (${mergedCaptured}) exceeds evidence.originalBytes (${mergedOriginal})`,
    );
  if (
    mergedTruncated &&
    (mergedOriginal === undefined || mergedCaptured === undefined)
  )
    throw new BackgroundWorkValidationError(
      "truncated evidence must report both original and captured sizes",
    );
  getDb()
    .prepare(
      `UPDATE background_work_items
       SET evidence_artifact_id = COALESCE(?, evidence_artifact_id),
           evidence_original_bytes = COALESCE(?, evidence_original_bytes),
           evidence_captured_bytes = COALESCE(?, evidence_captured_bytes),
           evidence_truncated = COALESCE(?, evidence_truncated),
           evidence_text = COALESCE(?, evidence_text),
           evidence_refusal_reason = COALESCE(?, evidence_refusal_reason),
           outcome_summary = COALESCE(?, outcome_summary),
           updated_at_ms = ?
       WHERE id = ?`,
    )
    .run(
      artifactId,
      evidence?.originalBytes === undefined
        ? null
        : nonnegativeSafeInteger(
            evidence.originalBytes,
            "evidence.originalBytes",
          ),
      evidence?.capturedBytes === undefined
        ? null
        : nonnegativeSafeInteger(
            evidence.capturedBytes,
            "evidence.capturedBytes",
          ),
      evidence?.truncated === undefined ? null : evidence.truncated ? 1 : 0,
      evidence?.text === undefined ? null : evidence.text ? 1 : 0,
      boundedOptional(
        evidence?.refusalReason,
        REASON_MAX_CHARS,
        "evidence.refusalReason",
      ),
      boundedOptional(outcomeSummary, SUMMARY_MAX_CHARS, "outcomeSummary"),
      now,
      row.id,
    );
}

/**
 * Record bounded progress evidence on a nonterminal row. Duplicate and
 * out-of-order provider snapshots are no-ops rather than errors: they are
 * EVIDENCE, and evidence never resurrects or rewinds a row.
 */
function recordEvidence(input: BackgroundEvidenceInput): BackgroundWorkItem {
  return mutation((touch) => {
    const now = input.now ?? Date.now();
    const row = requireItem(input.itemId);
    if (TERMINAL_STATES.has(row.state)) return () => itemOf(row);
    if (evidenceIsStale(row, input.eventId, input.sequence))
      return () => itemOf(row);
    applyEvidence(row, input.evidence, input.outcomeSummary, now);
    recordEventIdentity(row, input.eventId, input.sequence);
    touch.itemIds.add(row.id);
    return () => itemOf(requireItem(row.id));
  });
}

/**
 * Release a retained epoch this admission created but that never became real.
 *
 * A `creating` epoch is a RESERVATION: nothing has executed in it, since any
 * execution promotes it to `live`. Once the admission it was created for ends
 * without running it can never acquire another child (that needs a new
 * admission, which creates its own epoch), so leaving it open would hold the
 * owner slot forever. Closed in the SAME transaction as that outcome, so a
 * crash cannot strand it either.
 *
 * Called ONLY from the two paths that may conclude nothing ran — `failLaunch`
 * and a pre-launch owner Stop — never from an ordinary `terminalize`, which is
 * the runtime outcome of work that did run. A `live`/`draining` epoch and any
 * row carrying a `started_at_ms` are refused here regardless.
 */
function releaseUnusedHostReservation(
  touch: PendingTouches,
  row: ItemRow,
  now: number,
): void {
  const hostId = row.host_id;
  if (!hostId) return;
  // Belt and braces beside the two call sites: a row that ever started proves
  // something ran in this epoch, whatever its state says.
  if (row.started_at_ms !== null) return;
  const host = rawHost(hostId);
  if (!host || host.state !== "creating") return;
  const remaining = getDb()
    .prepare(
      `SELECT 1 FROM background_work_items
       WHERE host_id = ? AND is_member = 1 AND state IN ('pending-launch', 'running')
       LIMIT 1`,
    )
    .get(hostId);
  if (remaining) return;
  getDb()
    .prepare(
      `UPDATE background_hosts
       SET state = 'closed', closed_at_ms = ?, updated_at_ms = ?,
           terminal_reason = COALESCE(terminal_reason, 'reservation-released')
       WHERE id = ?`,
    )
    .run(now, now, hostId);
  touch.hostIds.add(hostId);
}

/** Legal terminal move; a row that is already terminal keeps its first outcome. */
function terminalize(
  input: TerminalizeBackgroundWorkInput,
): BackgroundWorkItem {
  return mutation((touch) => {
    const now = input.now ?? Date.now();
    const row = requireItem(input.itemId);
    if (TERMINAL_STATES.has(row.state)) return () => itemOf(row);
    if (evidenceIsStale(row, input.eventId, input.sequence))
      return () => itemOf(row);
    if (!TERMINAL_STATES.has(input.state))
      throw new BackgroundWorkValidationError(
        `${input.state} is not a terminal background work state`,
      );
    if (input.state === "not-started" && row.state !== "pending-launch")
      throw new BackgroundWorkValidationError(
        `background work item ${row.id} already executed; not-started is not legal`,
      );
    applyEvidence(row, input.evidence, input.outcomeSummary, now);
    getDb()
      .prepare(
        `UPDATE background_work_items
         SET state = ?, terminal_at_ms = ?, terminal_reason = COALESCE(?, terminal_reason),
             exit_code = COALESCE(?, exit_code),
             stop_state = CASE WHEN stop_state = 'unconfirmed' THEN 'requested' ELSE stop_state END,
             updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(
        input.state,
        now,
        boundedOptional(input.reason, REASON_MAX_CHARS, "reason"),
        input.exitCode === undefined
          ? null
          : safeInteger(input.exitCode, "exitCode"),
        now,
        row.id,
      );
    recordEventIdentity(row, input.eventId, input.sequence);
    touch.itemIds.add(row.id);
    return () => itemOf(requireItem(row.id));
  });
}

/**
 * The admission was accepted but nothing ever started: the provider reported no
 * task, or the process could not be spawned. Distinct from `terminalize` with
 * `failed`, which is a RUNTIME failure of work that did run — only this path
 * may conclude that an epoch reserved for it was never used, and it refuses a
 * row that has already executed rather than guessing from the terminal state.
 */
function failLaunch(input: {
  itemId: string;
  reason: string;
  now?: number;
}): BackgroundWorkItem {
  return mutation((touch) => {
    const now = input.now ?? Date.now();
    const row = requireItem(input.itemId);
    if (TERMINAL_STATES.has(row.state)) return () => itemOf(row);
    if (row.state !== "pending-launch" || row.started_at_ms !== null)
      throw new BackgroundWorkValidationError(
        `background work item ${row.id} already executed; use terminalize for a runtime failure`,
      );
    getDb()
      .prepare(
        `UPDATE background_work_items
         SET state = 'failed', terminal_at_ms = ?, updated_at_ms = ?,
             terminal_reason = COALESCE(terminal_reason, ?)
         WHERE id = ? AND state = 'pending-launch'`,
      )
      .run(now, now, bounded(input.reason, REASON_MAX_CHARS, "reason"), row.id);
    touch.itemIds.add(row.id);
    releaseUnusedHostReservation(touch, row, now);
    return () => itemOf(requireItem(row.id));
  });
}

/**
 * Reserve a Stop before any side effect. Three outcomes, by where execution is:
 * pre-launch it WINS and terminalizes as `not-started`; running but not yet
 * bound to a provider handle it parks as `awaiting-binding`; otherwise it is an
 * ordinary outstanding request with an acknowledgement deadline. A repeated
 * source request id records no second attempt.
 */
function requestStop(
  input: RequestBackgroundStopInput,
): BackgroundStopReservation {
  return mutation<BackgroundStopReservation>((touch) => {
    const now = input.now ?? Date.now();
    const row = requireItem(input.itemId);
    const reason = bounded(input.reason, REASON_MAX_CHARS, "reason");
    const sourceRequestId = bounded(
      input.sourceRequestId,
      ID_MAX_CHARS,
      "sourceRequestId",
    );
    if (TERMINAL_STATES.has(row.state))
      return () => ({
        item: itemOf(row),
        reserved: false,
        preventedLaunch: false,
      });
    if (row.stop_source_request_id === sourceRequestId)
      return () => ({
        item: itemOf(row),
        reserved: false,
        preventedLaunch: false,
      });

    if (row.state === "pending-launch") {
      getDb()
        .prepare(
          `UPDATE background_work_items
           SET state = 'not-started', stop_state = 'requested', stop_reason = ?,
               stop_requested_at_ms = ?, stop_source_request_id = ?, terminal_at_ms = ?,
               terminal_reason = 'stopped-by-owner', updated_at_ms = ?
           WHERE id = ? AND state = 'pending-launch'`,
        )
        .run(reason, now, sourceRequestId, now, now, row.id);
      touch.itemIds.add(row.id);
      // The Stop won before anything executed, so an epoch reserved for this
      // admission alone is released with it rather than holding the slot.
      releaseUnusedHostReservation(touch, row, now);
      return () => ({
        item: itemOf(requireItem(row.id)),
        reserved: true,
        preventedLaunch: true,
      });
    }

    const stopState: BackgroundWorkStopState =
      row.host_id && !row.provider_task_id ? "awaiting-binding" : "requested";
    getDb()
      .prepare(
        `UPDATE background_work_items
         SET stop_state = ?, stop_reason = ?, stop_requested_at_ms = COALESCE(stop_requested_at_ms, ?),
             stop_source_request_id = ?, stop_ack_deadline_at_ms = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(
        stopState,
        reason,
        now,
        sourceRequestId,
        input.ackDeadlineMs === undefined
          ? null
          : now + positiveSafeInteger(input.ackDeadlineMs, "ackDeadlineMs"),
        now,
        row.id,
      );
    touch.itemIds.add(row.id);
    return () => ({
      item: itemOf(requireItem(row.id)),
      reserved: true,
      preventedLaunch: false,
    });
  });
}

/**
 * The owner declared whether it waits on a running item (`awaited`) or keeps
 * it beside its work (`service`). Only the owner may say so, and only while the
 * item is nonterminal: a finished item's meaning is history. Repeating the
 * current intent writes nothing.
 */
function setIntent(input: {
  itemId: string;
  ownerSessionId: string;
  intent: BackgroundWorkIntent;
  now?: number;
}): BackgroundWorkItem {
  return mutation((touch) => {
    const row = requireItem(input.itemId);
    if (row.owner_session_id !== input.ownerSessionId)
      throw new BackgroundWorkValidationError(
        `background work item ${row.id} is not owned by this session`,
      );
    if (input.intent !== "awaited" && input.intent !== "service")
      throw new BackgroundWorkValidationError(
        "intent must be awaited or service",
      );
    assertNonterminal(row, "declaring its intent");
    if (row.intent === input.intent) return () => itemOf(row);
    getDb()
      .prepare(
        "UPDATE background_work_items SET intent = ?, updated_at_ms = ? WHERE id = ?",
      )
      .run(input.intent, input.now ?? Date.now(), row.id);
    touch.itemIds.add(row.id);
    return () => itemOf(requireItem(row.id));
  });
}

/**
 * One targeted Stop attempt was made, or went unanswered. `unconfirmed` stays
 * NONTERMINAL on purpose: later evidence or a new explicit attempt may still
 * answer it, and the app never fabricates a terminal outcome it did not see.
 */
function recordStopAttempt(input: {
  itemId: string;
  unconfirmed?: boolean;
  /** Bounded reason the attempt went unanswered; never a signal, pid or log. */
  evidence?: string;
  now?: number;
}): BackgroundWorkItem {
  return mutation((touch) => {
    const now = input.now ?? Date.now();
    const row = requireItem(input.itemId);
    assertNonterminal(row, "a stop attempt");
    if (row.stop_state === "none")
      throw new BackgroundWorkValidationError(
        `background work item ${row.id} has no reserved stop to attempt`,
      );
    // Nothing can have been signalled yet: the provider handle this Stop has to
    // target does not exist. Recording an attempt — let alone an unconfirmed
    // one — would claim we tried something we could not have tried.
    if (row.stop_state === "awaiting-binding")
      throw new BackgroundWorkValidationError(
        `background work item ${row.id} has no provider binding to stop yet`,
      );
    getDb()
      .prepare(
        `UPDATE background_work_items
         SET stop_attempts = stop_attempts + 1, stop_last_attempt_at_ms = ?,
             stop_state = ?, stop_evidence = COALESCE(?, stop_evidence), updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(
        now,
        input.unconfirmed ? "unconfirmed" : row.stop_state,
        boundedOptional(input.evidence, REASON_MAX_CHARS, "evidence"),
        now,
        row.id,
      );
    touch.itemIds.add(row.id);
    return () => itemOf(requireItem(row.id));
  });
}

/**
 * A planned deployment drain reserved this row's outcome. Boot reconciliation
 * honours the recorded reason instead of overwriting it with an unclean loss.
 */
function recordPlannedDrain(input: {
  ownerSessionId?: string;
  itemId?: string;
  reason: string;
  now?: number;
}): BackgroundWorkItem[] {
  return mutation((touch) => {
    const now = input.now ?? Date.now();
    const reason = bounded(input.reason, REASON_MAX_CHARS, "reason");
    const rows = (
      input.itemId
        ? [requireItem(input.itemId)]
        : (getDb()
            .prepare(
              `SELECT * FROM background_work_items
               WHERE owner_session_id = ? AND is_member = 1
                 AND state IN ('pending-launch', 'running')`,
            )
            .all(input.ownerSessionId ?? "") as unknown as ItemRow[])
    ).filter((row) => NONTERMINAL_STATES.has(row.state));
    const update = getDb().prepare(
      "UPDATE background_work_items SET drain_reason = ?, updated_at_ms = ? WHERE id = ?",
    );
    for (const row of rows) {
      update.run(reason, now, row.id);
      touch.itemIds.add(row.id);
    }
    return () => rows.map((row) => itemOf(requireItem(row.id)));
  });
}

function setHostState(input: {
  hostId: string;
  state: BackgroundHostState;
  reason?: string;
  now?: number;
}): BackgroundHost {
  return mutation((touch) => {
    const now = input.now ?? Date.now();
    const row = requireHost(input.hostId);
    if (!LIVE_HOST_STATES.has(row.state))
      throw new BackgroundWorkValidationError(
        `background host ${row.id} is ${row.state} and cannot transition`,
      );
    if (input.state === "creating")
      throw new BackgroundWorkValidationError(
        "a host epoch cannot return to creating",
      );
    const terminal = !LIVE_HOST_STATES.has(input.state);
    getDb()
      .prepare(
        `UPDATE background_hosts
         SET state = ?, closed_at_ms = ?, terminal_reason = COALESCE(?, terminal_reason),
             updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(
        input.state,
        terminal ? now : null,
        boundedOptional(input.reason, REASON_MAX_CHARS, "reason"),
        now,
        row.id,
      );
    touch.hostIds.add(row.id);
    if (terminal) {
      // A closing epoch takes its remaining work with it, and each child gets
      // the outcome it actually had. Three distinctions the fan-out may not
      // flatten: an epoch that was LOST loses its children too (nobody saw them
      // stop), a child that never launched ends `not-started` rather than
      // claiming an execution that never began, and a planned drain's recorded
      // reason is more specific than the generic host-close one.
      const remaining = getDb()
        .prepare(
          `SELECT id, state, drain_reason FROM background_work_items
           WHERE host_id = ? AND is_member = 1 AND state IN ('pending-launch', 'running')`,
        )
        .all(row.id) as Array<{
        id: string;
        state: BackgroundWorkState;
        drain_reason: string | null;
      }>;
      const close = getDb().prepare(
        `UPDATE background_work_items
         SET state = ?, terminal_at_ms = ?, updated_at_ms = ?,
             terminal_reason = COALESCE(terminal_reason, ?),
             stop_state = CASE WHEN stop_state = 'unconfirmed' THEN 'requested' ELSE stop_state END
         WHERE id = ?`,
      );
      const hostLost = input.state === "lost";
      for (const item of remaining) {
        const childState: BackgroundWorkState = hostLost
          ? "lost"
          : item.state === "pending-launch"
            ? "not-started"
            : "stopped";
        const childReason = hostLost
          ? "host-lost"
          : (item.drain_reason ?? "stopped-by-host-close");
        close.run(childState, now, now, childReason, item.id);
        touch.itemIds.add(item.id);
      }
    }
    return () => hostOf(requireHost(row.id));
  });
}

/** Owner Stop-all: reserved on the epoch before any of its work is signalled. */
function requestHostStopAll(input: {
  hostId: string;
  reason: string;
  now?: number;
}): BackgroundHost {
  return mutation((touch) => {
    const now = input.now ?? Date.now();
    const row = requireHost(input.hostId);
    if (!LIVE_HOST_STATES.has(row.state))
      throw new BackgroundWorkValidationError(
        `background host ${row.id} is ${row.state}; stop-all is not legal`,
      );
    getDb()
      .prepare(
        `UPDATE background_hosts
         SET stop_all_requested_at_ms = COALESCE(stop_all_requested_at_ms, ?),
             stop_all_reason = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .run(now, bounded(input.reason, REASON_MAX_CHARS, "reason"), now, row.id);
    touch.hostIds.add(row.id);
    return () => hostOf(requireHost(row.id));
  });
}

/**
 * Boot truth: no row written by a previous server process can still be
 * executing, so every nonterminal item and live host epoch from another boot
 * epoch is marked lost. A planned drain becomes stopped only when its Stop was
 * not left unconfirmed; an abandoned unconfirmed drain remains honestly lost.
 * Idempotent — a second pass finds only terminal rows — and nothing is replayed.
 */
function reconcileBoot(input: { bootEpoch: string; now?: number }): {
  items: number;
  hosts: number;
} {
  return mutation((touch) => {
    const now = input.now ?? Date.now();
    const bootEpoch = bounded(input.bootEpoch, ID_MAX_CHARS, "bootEpoch");
    const staleItems = getDb()
      .prepare(
        `SELECT id, drain_reason, stop_state FROM background_work_items
         WHERE is_member = 1 AND boot_epoch <> ? AND state IN ('pending-launch', 'running')`,
      )
      .all(bootEpoch) as Array<{
      id: string;
      drain_reason: string | null;
      stop_state: BackgroundWorkStopState;
    }>;
    const loseItem = getDb().prepare(
      `UPDATE background_work_items
       SET state = ?, terminal_at_ms = ?, updated_at_ms = ?, terminal_reason = ?,
           stop_state = CASE WHEN stop_state = 'unconfirmed' THEN 'requested' ELSE stop_state END
       WHERE id = ?`,
    );
    for (const item of staleItems) {
      const abandonedDrainStop =
        item.drain_reason !== null && item.stop_state === "unconfirmed";
      loseItem.run(
        item.drain_reason && !abandonedDrainStop ? "stopped" : "lost",
        now,
        now,
        abandonedDrainStop
          ? "deployment-stop-unconfirmed"
          : (item.drain_reason ?? "server-restart"),
        item.id,
      );
      touch.itemIds.add(item.id);
    }
    const staleHosts = getDb()
      .prepare(
        `SELECT id FROM background_hosts
         WHERE boot_epoch <> ? AND state IN ('creating', 'live', 'draining')`,
      )
      .all(bootEpoch) as Array<{ id: string }>;
    const loseHost = getDb().prepare(
      `UPDATE background_hosts
       SET state = 'lost', closed_at_ms = ?, updated_at_ms = ?,
           terminal_reason = COALESCE(terminal_reason, 'server-restart')
       WHERE id = ?`,
    );
    for (const host of staleHosts) {
      loseHost.run(now, now, host.id);
      touch.hostIds.add(host.id);
    }
    return () => ({ items: staleItems.length, hosts: staleHosts.length });
  });
}

/**
 * Tombstone every member row of one owner inside the caller's mutation, or
 * name what still runs and write nothing. Live work must be stopped first —
 * this never kills a process.
 */
function tombstoneOwnerRows(
  touch: PendingTouches,
  ownerSessionId: string,
  now: number,
): { ids: string[] } | { blocked: string } {
  const rows = getDb()
    .prepare(
      "SELECT id, state FROM background_work_items WHERE owner_session_id = ? AND is_member = 1",
    )
    .all(ownerSessionId) as Array<{ id: string; state: BackgroundWorkState }>;
  const active = rows.filter((row) => NONTERMINAL_STATES.has(row.state));
  if (active.length)
    return {
      blocked: `session ${ownerSessionId} still owns ${active.length} active background work item(s)`,
    };
  // A live epoch outlives its last child, so "no active items" is not the
  // same as "nothing running": deleting here would orphan a retained query.
  if (liveHostForOwner(ownerSessionId))
    return {
      blocked: `session ${ownerSessionId} still retains a live background host epoch`,
    };
  // One statement for the whole owner, however much history it has; the
  // SELECT above, in the same transaction, names exactly the rows it changes.
  getDb()
    .prepare(
      `UPDATE background_work_items
       SET is_member = 0, deleted_at_ms = ?, label = 'deleted', description = NULL,
           command = NULL, command_truncated = 0, outcome_summary = NULL,
           terminal_reason = NULL, stop_reason = NULL, stop_evidence = NULL,
           stop_source_request_id = NULL, drain_reason = NULL, evidence_artifact_id = NULL,
           evidence_refusal_reason = NULL, updated_at_ms = ?
       WHERE owner_session_id = ? AND is_member = 1`,
    )
    .run(now, now, ownerSessionId);
  for (const row of rows) touch.itemIds.add(row.id);
  return { ids: rows.map((row) => row.id) };
}

/**
 * The Task-490 tombstone seam, and the only way a session is deleted: ONE
 * transaction refuses while the owner still has live work, marks the session
 * deleted and tombstones its history, keeping only identity and revision
 * metadata so subscribers receive an authoritative delete. Either all of it
 * commits or none: a session write that fails leaves the session live with its
 * history intact. An id with no session row has no history either (the owner
 * foreign key), so it deletes nothing and succeeds. Once the row is marked,
 * admission refuses the owner (`requireOwnerSession`), so nothing new joins.
 */
function deleteOwnerSession(
  ownerSessionId: string,
  now = Date.now(),
): { session: "deleted" | "already-deleted" | "missing"; itemIds: string[] } {
  return mutation((touch) => {
    const result = tombstoneOwnerRows(touch, ownerSessionId, now);
    if ("blocked" in result)
      throw new BackgroundWorkValidationError(result.blocked);
    const session = sessionStore.markDeleted(ownerSessionId, now);
    return () => ({ session, itemIds: result.ids });
  });
}

/**
 * The repair behind the delete seam: tombstone the member rows of every owner
 * whose session is deleted, or has no row at all. Idempotent, since a
 * tombstoned row is no longer a member. Each owner is its own transaction, so
 * one failure or one large owner never holds the rest. An owner that still has
 * live work is skipped and reported rather than failing the sweep; boot runs
 * this after `reconcileBoot`, where nothing from an earlier process is live.
 */
function tombstoneDeletedOwners(now = Date.now()): {
  itemIds: string[];
  ownerSessionIds: string[];
  blockedOwnerSessionIds: string[];
} {
  const owners = getDb()
    .prepare(
      `SELECT DISTINCT item.owner_session_id AS id
       FROM background_work_items AS item
       LEFT JOIN session_index AS session ON session.id = item.owner_session_id
       WHERE item.is_member = 1
         AND (session.id IS NULL OR session.deleted_at_ms IS NOT NULL)
       ORDER BY item.owner_session_id`,
    )
    .all() as Array<{ id: string }>;
  const itemIds: string[] = [];
  const ownerSessionIds: string[] = [];
  const blockedOwnerSessionIds: string[] = [];
  for (const owner of owners) {
    const result = mutation((touch) => {
      const rows = tombstoneOwnerRows(touch, owner.id, now);
      return () => rows;
    });
    if ("blocked" in result) {
      blockedOwnerSessionIds.push(owner.id);
      continue;
    }
    itemIds.push(...result.ids);
    ownerSessionIds.push(owner.id);
  }
  return { itemIds, ownerSessionIds, blockedOwnerSessionIds };
}

function getItem(
  id: string,
  includeTombstoned = false,
): BackgroundWorkItem | undefined {
  const row = rawItem(id);
  if (!row || (!includeTombstoned && row.is_member === 0)) return undefined;
  return itemOf(row);
}

/**
 * The row a previous admission created for this request identity, if any. The
 * read half of `reserveItem`'s idempotency: an admission path has to recognise
 * its own retry BEFORE it re-applies mutable policy, or a retry would be judged
 * against settings that never governed the row it is about to hand back. Any
 * state — a completed or stopped item answers too, because a retry may never
 * resurrect work that already ended.
 */
function getItemBySource(
  ownerSessionId: string,
  sourceRequestId: string,
): BackgroundWorkItem | undefined {
  const row = existingSource(ownerSessionId, sourceRequestId);
  return row && row.is_member === 1 ? itemOf(row) : undefined;
}

function getHost(id: string): BackgroundHost | undefined {
  const row = rawHost(id);
  return row ? hostOf(row) : undefined;
}

function hostForOwner(ownerSessionId: string): BackgroundHost | undefined {
  const row = liveHostForOwner(ownerSessionId);
  return row ? hostOf(row) : undefined;
}

interface ListBackgroundWorkOptions {
  ownerSessionId?: string;
  /** `active` is every nonterminal row; `terminal` every finished one. */
  state?: "active" | "terminal" | "all";
  limit?: number;
  /** Keyset continuation for the deterministic active/created-at/id ordering. */
  after?: { active: boolean; createdAt: number; id: string };
  /** Retained for internal callers that do not need a keyset traversal. */
  offset?: number;
}

/**
 * The exact statement `listItems` runs, split out so
 * `backgroundWorkStoreQueryPlan.test.ts` can `EXPLAIN QUERY PLAN` it.
 */
export function listItemsQuery(options: ListBackgroundWorkOptions = {}): {
  sql: string;
  args: Array<string | number>;
} {
  const limit = Math.min(
    positiveSafeInteger(options.limit ?? 50, "limit"),
    LIST_LIMIT_MAX,
  );
  const offset = nonnegativeSafeInteger(options.offset ?? 0, "offset");
  const clauses = ["is_member = 1"];
  const args: Array<string | number> = [];
  if (options.after) {
    const activeRank = options.after.active ? 0 : 1;
    safeInteger(options.after.createdAt, "after.createdAt");
    bounded(options.after.id, ID_MAX_CHARS, "after.id");
    clauses.push(
      `id <> ? AND
       (CASE WHEN state IN ('pending-launch', 'running') THEN 0 ELSE 1 END > ?
        OR (CASE WHEN state IN ('pending-launch', 'running') THEN 0 ELSE 1 END = ?
          AND (created_at_ms < ? OR (created_at_ms = ? AND id < ?))))`,
    );
    args.push(
      options.after.id,
      activeRank,
      activeRank,
      options.after.createdAt,
      options.after.createdAt,
      options.after.id,
    );
  }
  if (options.ownerSessionId) {
    clauses.push("owner_session_id = ?");
    args.push(options.ownerSessionId);
  }
  if (options.state === "active")
    clauses.push("state IN ('pending-launch', 'running')");
  else if (options.state === "terminal")
    clauses.push("state NOT IN ('pending-launch', 'running')");
  // Unary `+` keeps an active read off the registry index: that index orders
  // every member row, so the planner would walk all of history to find the few
  // active ones instead of reading the partial active indexes.
  const createdAt =
    options.state === "active" ? "+created_at_ms" : "created_at_ms";
  return {
    sql: `SELECT * FROM background_work_items
       WHERE ${clauses.join(" AND ")}
       ORDER BY
         CASE WHEN state IN ('pending-launch', 'running') THEN 0 ELSE 1 END,
         ${createdAt} DESC, id DESC
       LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  };
}

/** Bounded registry read, newest first. Callers never page unboundedly. */
function listItems(
  options: ListBackgroundWorkOptions = {},
): BackgroundWorkItem[] {
  const { sql, args } = listItemsQuery(options);
  const rows = getDb()
    .prepare(sql)
    .all(...(args as never[])) as unknown as ItemRow[];
  return rows.map(itemOf);
}

/**
 * Per-owner activity for the session list. Derived from durable rows only: it
 * never reads, sets or implies provider run state.
 */
function activityByOwner(): Map<string, SessionBackgroundActivity> {
  const rows = getDb()
    .prepare(
      `SELECT owner_session_id, kind, state, stop_state, intent,
              COALESCE(started_at_ms, created_at_ms) AS since
       FROM background_work_items
       WHERE is_member = 1 AND state IN ('pending-launch', 'running')`,
    )
    .all() as Array<{
    owner_session_id: string;
    kind: BackgroundWorkKind;
    state: BackgroundWorkState;
    stop_state: BackgroundWorkStopState;
    intent: BackgroundWorkIntent;
    since: number;
  }>;
  const activity = new Map<string, SessionBackgroundActivity>();
  for (const row of rows) {
    const current = activity.get(row.owner_session_id) ?? {
      activeCount: 0,
      shellCount: 0,
      monitorCommandCount: 0,
      monitorWebsocketCount: 0,
      startingCount: 0,
      stoppingCount: 0,
      oldestStartedAt: row.since,
    };
    current.activeCount += 1;
    if (row.kind === "shell") current.shellCount += 1;
    else if (row.kind === "monitor-command") current.monitorCommandCount += 1;
    else current.monitorWebsocketCount += 1;
    if (row.state === "pending-launch") current.startingCount += 1;
    if (row.stop_state !== "none") current.stoppingCount += 1;
    if (row.intent === "service")
      current.serviceCount = (current.serviceCount ?? 0) + 1;
    current.oldestStartedAt = Math.min(current.oldestStartedAt, row.since);
    activity.set(row.owner_session_id, current);
  }
  // A live epoch with no children left is still a retained provider host: it
  // holds its owner's slot until the backend closes it, so the session is NOT
  // dormant and must not read as such. Such an owner gets an activity row of
  // its own rather than being invisible until its next child starts.
  const hosts = getDb()
    .prepare(
      `SELECT DISTINCT owner_session_id, created_at_ms FROM background_hosts
       WHERE state IN ('creating', 'live', 'draining')`,
    )
    .all() as Array<{ owner_session_id: string; created_at_ms: number }>;
  for (const host of hosts) {
    const current = activity.get(host.owner_session_id) ?? {
      activeCount: 0,
      shellCount: 0,
      monitorCommandCount: 0,
      monitorWebsocketCount: 0,
      startingCount: 0,
      stoppingCount: 0,
      oldestStartedAt: host.created_at_ms,
    };
    current.retainedHost = true;
    activity.set(host.owner_session_id, current);
  }
  return activity;
}

/**
 * The per-read SQL the broadcast and subscribe paths issue, exported so
 * `backgroundWorkStoreQueryPlan.test.ts` can `EXPLAIN QUERY PLAN` the exact
 * statements: each must be an index search, never a scan of all history.
 */
export const BACKGROUND_WORK_REGISTRY_SQL = {
  revision:
    "SELECT id, revision, is_member FROM background_work_items WHERE id = ?",
  // `+` as in `listItems`: the partial active indexes, not the registry index.
  // The sort that leaves is over the active rows alone.
  activeWindow: `SELECT * FROM background_work_items
     WHERE is_member = 1 AND state IN ('pending-launch', 'running')
     ORDER BY +created_at_ms DESC, id
     LIMIT ?`,
  // Ties break on `id` ASCENDING, exactly the registry index's order, so the
  // walk stops at LIMIT. `id DESC` made SQLite sort every row sharing a
  // millisecond first. Ids are random, so neither direction means anything;
  // the browser orders the window itself.
  historyWindow: `SELECT * FROM background_work_items
     WHERE is_member = 1 AND state NOT IN ('pending-launch', 'running')
     ORDER BY created_at_ms DESC, id
     LIMIT ?`,
} as const;

/**
 * The newest `limit` member rows, active first, plus whether more exist. Two
 * reads instead of `listItems`' one CASE ordering, because that ordering can
 * only be answered by sorting every member row: this reads the active rows
 * through their partial index and then walks the registry index newest-first
 * for just enough history, so the cost follows the window, not the table.
 */
function listRegistryWindow(limit: number): {
  items: BackgroundWorkItem[];
  truncated: boolean;
} {
  const want =
    Math.min(positiveSafeInteger(limit, "limit"), LIST_LIMIT_MAX) + 1;
  const db = getDb();
  const active = db
    .prepare(BACKGROUND_WORK_REGISTRY_SQL.activeWindow)
    .all(want) as unknown as ItemRow[];
  const history =
    active.length < want
      ? (db
          .prepare(BACKGROUND_WORK_REGISTRY_SQL.historyWindow)
          .all(want - active.length) as unknown as ItemRow[])
      : [];
  const rows = [...active, ...history];
  return {
    items: rows.slice(0, want - 1).map(itemOf),
    truncated: rows.length === want,
  };
}

/**
 * Revision and membership for exactly these ids, by primary key — never the
 * whole table. Every write reports the ids it stamped (`mutation`), so a caller
 * diffing state already knows which rows can have moved.
 */
function itemRevisions(ids: Iterable<string>): BackgroundWorkRevisionRow[] {
  const read = getDb().prepare(BACKGROUND_WORK_REGISTRY_SQL.revision);
  const rows: BackgroundWorkRevisionRow[] = [];
  for (const id of new Set(ids)) {
    const row = read.get(id) as
      { id: string; revision: number; is_member: number } | undefined;
    if (row)
      rows.push({
        id: row.id,
        revision: row.revision,
        member: Boolean(row.is_member),
      });
  }
  return rows;
}

/** Sessions currently holding an owner slot, for capacity display and tests. */
function ownerSlotCount(): number {
  return occupiedOwnerSlots();
}

/** Kept beside the facade so tests can require coverage for every write seam. */
export const BACKGROUND_WORK_PUBLIC_WRITE_PATHS = [
  "reserveItem",
  "observeItem",
  "bindProvider",
  "markRunning",
  "recordEvidence",
  "terminalize",
  "failLaunch",
  "requestStop",
  "recordStopAttempt",
  "setIntent",
  "recordPlannedDrain",
  "setHostState",
  "requestHostStopAll",
  "reconcileBoot",
  "deleteOwnerSession",
  "tombstoneDeletedOwners",
] as const;

export const backgroundWorkStore = {
  reserveItem,
  observeItem,
  bindProvider,
  markRunning,
  recordEvidence,
  terminalize,
  failLaunch,
  requestStop,
  recordStopAttempt,
  setIntent,
  recordPlannedDrain,
  setHostState,
  requestHostStopAll,
  reconcileBoot,
  deleteOwnerSession,
  tombstoneDeletedOwners,
  getItem,
  getItemBySource,
  getHost,
  hostForOwner,
  listItems,
  listRegistryWindow,
  activityByOwner,
  itemRevisions,
  ownerSlotCount,
};
