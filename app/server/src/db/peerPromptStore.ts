/**
 * Transactional peer-prompt persistence (Task 87).
 *
 * The single SQL-facing façade for cross-session peer prompts, their
 * server-owned conversations, and causal chains. It replaces the uncoordinated
 * `agent-relays.json` file: every state change is a SQLite transaction with a
 * compare-and-set guard, so concurrent enqueues and status updates cannot lose
 * rows or overwrite newer state. Legal transitions live HERE, not in tool code.
 *
 * Downstream tasks build on these seams: Task 90 (public API/provenance/auto-
 * correlation), Task 88 (dispatch/queue/drain), Task 105 (loop guard), Task 89
 * (projections/retention). Full routing/audit data stays server-side.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "./index.ts";
import { nextId } from "./sequences.ts";

export type PeerPromptStatus =
  | "queued"
  | "dispatching"
  | "admitted"
  | "acknowledged"
  | "completed"
  | "awaiting_response"
  | "replied"
  | "retryable_failed"
  | "interrupted"
  | "cancelled"
  | "failed"
  | "expired";

/**
 * WHY a delivered turn never finished, which decides whether anyone should hear
 * about it.
 *
 * `restart` — the OS process died under a turn that was otherwise healthy. The
 * recipient's context survived, so the work is usually resumable and a sender
 * waiting on a reply is worth waking: it can re-ask or poke the recipient.
 *
 * `failure` — the provider or harness refused (usage limit, 529, a non-zero
 * exit). Re-asking reproduces the refusal, so waking a sender to retry is worse
 * than staying quiet; the durable row and its card carry the reason for whoever
 * looks.
 */
type PeerPromptInterruptionKind = "restart" | "failure";

/** Terminal states that hold no further obligation and may eventually be pruned. */
const TERMINAL_STATUSES: PeerPromptStatus[] = [
  "completed",
  "replied",
  "failed",
  "interrupted",
  "cancelled",
  "expired",
];

/** One recorded status transition, for the audit trail. */
interface PeerPromptTransition {
  to: PeerPromptStatus;
  at: number;
}

export interface PeerPromptRecord {
  id: string;
  conversationId: string;
  chainId: string;
  hop: number;
  queueSeq: number;
  senderSessionId: string;
  recipientSessionId: string;
  taskId?: string;
  prompt: string;
  responseRequested: boolean;
  status: PeerPromptStatus;
  attempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  failureReason?: string;
  /** Why an `interrupted` row was interrupted; absent on every other status. */
  interruptionKind?: PeerPromptInterruptionKind;
  /** When the sender was told this turn never finished; absent while it still owes one. */
  senderNotifiedAt?: number;
  senderLabel?: string;
  taskLabel?: string;
  replyToMessageId?: string;
  repliedByMessageId?: string;
  nextAttemptAt?: number;
  /** The id of this delivery batch's head row (set on every member, including the head itself) once admitted. */
  batchHeadId?: string;
  /** Bounded (most-recent-first-truncated) status transition history. */
  transitions: PeerPromptTransition[];
  createdAt: number;
  updatedAt: number;
  acceptedAt?: number;
  acknowledgedAt?: number;
  completedAt?: number;
  repliedAt?: number;
  expiresAt?: number;
}

interface PeerPromptChain {
  chainId: string;
  nextHop: number;
  closed: boolean;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  conversation_id: string;
  chain_id: string;
  hop: number;
  queue_seq: number;
  sender_session_id: string;
  recipient_session_id: string;
  task_id: string | null;
  prompt: string;
  response_requested: number;
  status: PeerPromptStatus;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at_ms: number | null;
  failure_reason: string | null;
  interruption_kind: PeerPromptInterruptionKind | null;
  sender_notified_at_ms: number | null;
  sender_label: string | null;
  task_label: string | null;
  reply_to_message_id: string | null;
  replied_by_message_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  accepted_at_ms: number | null;
  acknowledged_at_ms: number | null;
  completed_at_ms: number | null;
  replied_at_ms: number | null;
  expires_at_ms: number | null;
  next_attempt_at_ms: number | null;
  transitions_json: string;
  batch_head_id: string | null;
}

const MAX_TRANSITIONS = 20;

function parseTransitions(json: string): PeerPromptTransition[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Append one transition entry, keeping the audit trail bounded. */
function appendTransitionJson(
  currentJson: string,
  to: PeerPromptStatus,
  at: number,
): string {
  const history = parseTransitions(currentJson);
  history.push({ to, at });
  return JSON.stringify(
    history.length > MAX_TRANSITIONS
      ? history.slice(-MAX_TRANSITIONS)
      : history,
  );
}

function map(r: Row): PeerPromptRecord {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    chainId: r.chain_id,
    hop: r.hop,
    queueSeq: r.queue_seq,
    senderSessionId: r.sender_session_id,
    recipientSessionId: r.recipient_session_id,
    ...(r.task_id ? { taskId: r.task_id } : {}),
    prompt: r.prompt,
    responseRequested: r.response_requested === 1,
    status: r.status,
    attempts: r.attempts,
    ...(r.lease_owner ? { leaseOwner: r.lease_owner } : {}),
    ...(r.lease_expires_at_ms != null
      ? { leaseExpiresAt: r.lease_expires_at_ms }
      : {}),
    ...(r.failure_reason ? { failureReason: r.failure_reason } : {}),
    ...(r.interruption_kind ? { interruptionKind: r.interruption_kind } : {}),
    ...(r.sender_notified_at_ms != null
      ? { senderNotifiedAt: r.sender_notified_at_ms }
      : {}),
    ...(r.sender_label ? { senderLabel: r.sender_label } : {}),
    ...(r.task_label ? { taskLabel: r.task_label } : {}),
    ...(r.reply_to_message_id
      ? { replyToMessageId: r.reply_to_message_id }
      : {}),
    ...(r.replied_by_message_id
      ? { repliedByMessageId: r.replied_by_message_id }
      : {}),
    createdAt: r.created_at_ms,
    updatedAt: r.updated_at_ms,
    ...(r.accepted_at_ms != null ? { acceptedAt: r.accepted_at_ms } : {}),
    ...(r.acknowledged_at_ms != null
      ? { acknowledgedAt: r.acknowledged_at_ms }
      : {}),
    ...(r.completed_at_ms != null ? { completedAt: r.completed_at_ms } : {}),
    ...(r.replied_at_ms != null ? { repliedAt: r.replied_at_ms } : {}),
    ...(r.expires_at_ms != null ? { expiresAt: r.expires_at_ms } : {}),
    ...(r.next_attempt_at_ms != null
      ? { nextAttemptAt: r.next_attempt_at_ms }
      : {}),
    ...(r.batch_head_id ? { batchHeadId: r.batch_head_id } : {}),
    transitions: parseTransitions(r.transitions_json),
  };
}

function getRow(id: string): Row | undefined {
  return getDb().prepare("SELECT * FROM peer_prompts WHERE id = ?").get(id) as
    Row | undefined;
}

/* ------------------------------- chains ---------------------------------- */

function createChain(
  chainId = `chain_${randomUUID().slice(0, 12)}`,
  now = Date.now(),
): string {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO peer_prompt_chains (chain_id, next_hop, closed, created_at_ms, updated_at_ms) VALUES (?, 1, 0, ?, ?)",
    )
    .run(chainId, now, now);
  return chainId;
}

function getChain(chainId: string): PeerPromptChain | undefined {
  const row = getDb()
    .prepare("SELECT * FROM peer_prompt_chains WHERE chain_id = ?")
    .get(chainId) as
    | {
        chain_id: string;
        next_hop: number;
        closed: number;
        created_at_ms: number;
        updated_at_ms: number;
      }
    | undefined;
  return row
    ? {
        chainId: row.chain_id,
        nextHop: row.next_hop,
        closed: Boolean(row.closed),
        createdAt: row.created_at_ms,
        updatedAt: row.updated_at_ms,
      }
    : undefined;
}

/**
 * Atomically reserve and return the next hop of a chain. Reserving at enqueue
 * (not delivery) is what stops concurrent/pending sends oversubscribing the
 * Task-105 loop limit. Creates the chain if it does not exist.
 */
function reserveHop(chainId: string, now = Date.now()): number {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    createChain(chainId, now);
    const before = db
      .prepare("SELECT next_hop FROM peer_prompt_chains WHERE chain_id = ?")
      .get(chainId) as { next_hop: number };
    db.prepare(
      "UPDATE peer_prompt_chains SET next_hop = next_hop + 1, updated_at_ms = ? WHERE chain_id = ?",
    ).run(now, chainId);
    db.exec("COMMIT");
    return before.next_hop;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function addParticipant(
  chainId: string,
  sessionId: string,
  now = Date.now(),
): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO peer_prompt_chain_participants (chain_id, session_id, added_at_ms) VALUES (?, ?, ?)",
    )
    .run(chainId, sessionId, now);
}

function participantsOf(chainId: string): string[] {
  return (
    getDb()
      .prepare(
        "SELECT session_id FROM peer_prompt_chain_participants WHERE chain_id = ? ORDER BY added_at_ms",
      )
      .all(chainId) as { session_id: string }[]
  ).map((r) => r.session_id);
}

function chainsForSession(sessionId: string): string[] {
  return (
    getDb()
      .prepare(
        "SELECT chain_id FROM peer_prompt_chain_participants WHERE session_id = ?",
      )
      .all(sessionId) as { chain_id: string }[]
  ).map((r) => r.chain_id);
}

/** Close every open chain the session participates in (human-prompt reset, Task 105). */
function closeChainsForSession(sessionId: string, now = Date.now()): string[] {
  const db = getDb();
  const ids = chainsForSession(sessionId);
  if (ids.length === 0) return [];
  const stmt = db.prepare(
    "UPDATE peer_prompt_chains SET closed = 1, updated_at_ms = ? WHERE chain_id = ? AND closed = 0",
  );
  const closed: string[] = [];
  for (const id of ids) {
    if (stmt.run(now, id).changes > 0) closed.push(id);
  }
  return closed;
}

/* ------------------------------- writes ---------------------------------- */

interface EnqueueInput {
  conversationId: string;
  chainId: string;
  hop: number;
  senderSessionId: string;
  recipientSessionId: string;
  taskId?: string;
  prompt: string;
  responseRequested: boolean;
  senderLabel?: string;
  taskLabel?: string;
  replyToMessageId?: string;
  expiresAt?: number;
}

/** Thrown by {@link enqueueRouted} when the causal-chain hop limit is reached. */
export class PeerPromptHopLimitError extends Error {
  readonly maxHops: number;
  constructor(maxHops: number) {
    super(`peer-prompt chain hop limit (${maxHops}) reached`);
    this.name = "PeerPromptHopLimitError";
    this.maxHops = maxHops;
  }
}

interface RoutedEnqueueInput {
  conversationId: string;
  /** Preferred chain to continue. */
  chainId: string;
  /**
   * A pre-generated fresh chain id, used INSTEAD of `chainId` iff `chainId` is
   * found closed at transaction time. This closes the human-reset race: the
   * open/closed check and the enqueue happen in the same transaction, so a
   * concurrent human-prompt close can never land a new message on a chain that
   * was open only at routing-decision time.
   */
  fallbackChainId?: string;
  senderSessionId: string;
  recipientSessionId: string;
  taskId?: string;
  prompt: string;
  responseRequested: boolean;
  senderLabel?: string;
  taskLabel?: string;
  replyToMessageId?: string;
  /** Mark this earlier message replied atomically with this enqueue. */
  markRepliedId?: string;
  expiresAt?: number;
  /** Extra chain participants to accumulate atomically (sender/recipient/etc.). */
  participants: string[];
  /** Loop-guard bound; reservation exceeding this rolls back without incrementing. */
  maxHops: number;
}

const INSERT_MESSAGE_SQL = `
  INSERT INTO peer_prompts (
    id, conversation_id, chain_id, hop, queue_seq, sender_session_id, recipient_session_id,
    task_id, prompt, response_requested, status, attempts, sender_label, task_label,
    reply_to_message_id, created_at_ms, updated_at_ms, expires_at_ms, transitions_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?)
`;

function ensureChain(
  db: ReturnType<typeof getDb>,
  chainId: string,
  now: number,
): { nextHop: number; closed: boolean } {
  db.prepare(
    "INSERT OR IGNORE INTO peer_prompt_chains (chain_id, next_hop, closed, created_at_ms, updated_at_ms) VALUES (?, 1, 0, ?, ?)",
  ).run(chainId, now, now);
  const row = db
    .prepare(
      "SELECT next_hop, closed FROM peer_prompt_chains WHERE chain_id = ?",
    )
    .get(chainId) as { next_hop: number; closed: number };
  return { nextHop: row.next_hop, closed: Boolean(row.closed) };
}

/**
 * Atomically (one transaction): re-check whether the preferred chain is closed
 * and reroute to `fallbackChainId` if so, reject when the reserved hop would
 * exceed `maxHops` (WITHOUT incrementing), reserve+increment the hop,
 * accumulate participants, insert the message, and (if `markRepliedId` is set)
 * mark that earlier message replied. A rollback leaves no partial chain/
 * participant/message/hop/reply state. This is the only enqueue path for sends.
 */
function enqueueRouted(
  input: RoutedEnqueueInput,
  now = Date.now(),
): PeerPromptRecord {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    let chainId = input.chainId;
    let chain = ensureChain(db, chainId, now);
    if (chain.closed && input.fallbackChainId) {
      chainId = input.fallbackChainId;
      chain = ensureChain(db, chainId, now);
    }
    const hop = chain.nextHop;
    if (hop > input.maxHops) {
      db.exec("ROLLBACK");
      throw new PeerPromptHopLimitError(input.maxHops);
    }
    db.prepare(
      "UPDATE peer_prompt_chains SET next_hop = next_hop + 1, updated_at_ms = ? WHERE chain_id = ?",
    ).run(now, chainId);
    const addParticipantStmt = db.prepare(
      "INSERT OR IGNORE INTO peer_prompt_chain_participants (chain_id, session_id, added_at_ms) VALUES (?, ?, ?)",
    );
    for (const p of input.participants) addParticipantStmt.run(chainId, p, now);
    const id = `pp_${now}_${randomUUID().slice(0, 8)}`;
    const queueSeq = nextId("peer_prompt_seq");
    db.prepare(INSERT_MESSAGE_SQL).run(
      id,
      input.conversationId,
      chainId,
      hop,
      queueSeq,
      input.senderSessionId,
      input.recipientSessionId,
      input.taskId ?? null,
      input.prompt,
      input.responseRequested ? 1 : 0,
      input.senderLabel ?? null,
      input.taskLabel ?? null,
      input.replyToMessageId ?? null,
      now,
      now,
      input.expiresAt ?? null,
      JSON.stringify([{ to: "queued", at: now }]),
    );
    if (input.markRepliedId) {
      transitionInTxn(
        db,
        input.markRepliedId,
        ["admitted", "acknowledged", "completed", "awaiting_response"],
        "replied",
        { repliedAt: now, repliedByMessageId: id },
        now,
      );
    }
    db.exec("COMMIT");
    return map(getRow(id)!);
  } catch (err) {
    if (!(err instanceof PeerPromptHopLimitError)) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
    }
    throw err;
  }
}

/** Insert a new peer prompt in `queued` state. Allocates the FIFO queue seq. */
function enqueue(input: EnqueueInput, now = Date.now()): PeerPromptRecord {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const id = `pp_${now}_${randomUUID().slice(0, 8)}`;
    const queueSeq = nextId("peer_prompt_seq");
    db.prepare(
      `
      INSERT INTO peer_prompts (
        id, conversation_id, chain_id, hop, queue_seq, sender_session_id, recipient_session_id,
        task_id, prompt, response_requested, status, attempts, sender_label, task_label,
        reply_to_message_id, created_at_ms, updated_at_ms, expires_at_ms, transitions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      input.conversationId,
      input.chainId,
      input.hop,
      queueSeq,
      input.senderSessionId,
      input.recipientSessionId,
      input.taskId ?? null,
      input.prompt,
      input.responseRequested ? 1 : 0,
      input.senderLabel ?? null,
      input.taskLabel ?? null,
      input.replyToMessageId ?? null,
      now,
      now,
      input.expiresAt ?? null,
      JSON.stringify([{ to: "queued", at: now }]),
    );
    db.exec("COMMIT");
    return map(getRow(id)!);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

type TransitionPatch = Partial<{
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  failureReason: string | null;
  interruptionKind: PeerPromptInterruptionKind | null;
  nextAttemptAt: number | null;
  acceptedAt: number;
  acknowledgedAt: number;
  completedAt: number;
  repliedAt: number;
  repliedByMessageId: string;
  bumpAttempts: boolean;
}>;

/** Compare-and-set transition logic, assuming the caller already holds a transaction. */
function transitionInTxn(
  db: ReturnType<typeof getDb>,
  id: string,
  from: PeerPromptStatus[],
  to: PeerPromptStatus,
  patch: TransitionPatch,
  now: number,
): boolean {
  const current = getRow(id);
  if (!current || !from.includes(current.status)) return false;
  const sets: string[] = [
    "status = ?",
    "updated_at_ms = ?",
    "transitions_json = ?",
  ];
  const params: unknown[] = [
    to,
    now,
    appendTransitionJson(current.transitions_json, to, now),
  ];
  if (patch.leaseOwner !== undefined) {
    sets.push("lease_owner = ?");
    params.push(patch.leaseOwner);
  }
  if (patch.leaseExpiresAt !== undefined) {
    sets.push("lease_expires_at_ms = ?");
    params.push(patch.leaseExpiresAt);
  }
  if (patch.failureReason !== undefined) {
    sets.push("failure_reason = ?");
    params.push(patch.failureReason);
  }
  if (patch.interruptionKind !== undefined) {
    sets.push("interruption_kind = ?");
    params.push(patch.interruptionKind);
  }
  if (patch.nextAttemptAt !== undefined) {
    sets.push("next_attempt_at_ms = ?");
    params.push(patch.nextAttemptAt);
  }
  if (patch.acceptedAt !== undefined) {
    sets.push("accepted_at_ms = ?");
    params.push(patch.acceptedAt);
  }
  if (patch.acknowledgedAt !== undefined) {
    sets.push("acknowledged_at_ms = ?");
    params.push(patch.acknowledgedAt);
  }
  if (patch.completedAt !== undefined) {
    sets.push("completed_at_ms = ?");
    params.push(patch.completedAt);
  }
  if (patch.repliedAt !== undefined) {
    sets.push("replied_at_ms = ?");
    params.push(patch.repliedAt);
  }
  if (patch.repliedByMessageId !== undefined) {
    sets.push("replied_by_message_id = ?");
    params.push(patch.repliedByMessageId);
  }
  if (patch.bumpAttempts) sets.push("attempts = attempts + 1");
  const placeholders = from.map(() => "?").join(", ");
  const sql = `UPDATE peer_prompts SET ${sets.join(", ")} WHERE id = ? AND status IN (${placeholders})`;
  const result = db
    .prepare(sql)
    .run(...(params as never[]), id, ...(from as never[]));
  return result.changes > 0;
}

/** Compare-and-set status transition; returns the updated record or undefined. */
function transition(
  id: string,
  from: PeerPromptStatus[],
  to: PeerPromptStatus,
  patch: TransitionPatch = {},
  now = Date.now(),
): PeerPromptRecord | undefined {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const ok = transitionInTxn(db, id, from, to, patch, now);
    db.exec("COMMIT");
    return ok ? map(getRow(id)!) : undefined;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Atomically claim the oldest queued prompt for a recipient into `dispatching`
 * with a lease. Returns undefined when the queue is empty.
 */
function claimNext(
  recipientSessionId: string,
  leaseOwner: string,
  leaseMs: number,
  now = Date.now(),
): PeerPromptRecord | undefined {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare(
        "SELECT id FROM peer_prompts WHERE recipient_session_id = ? AND status = 'queued' ORDER BY queue_seq LIMIT 1",
      )
      .get(recipientSessionId) as { id: string } | undefined;
    if (!row) {
      db.exec("COMMIT");
      return undefined;
    }
    transitionInTxn(
      db,
      row.id,
      ["queued"],
      "dispatching",
      { leaseOwner, leaseExpiresAt: now + leaseMs, bumpAttempts: true },
      now,
    );
    db.exec("COMMIT");
    return map(getRow(row.id)!);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Claim a FIFO batch for a recipient: the oldest queued row plus any immediately
 * following queued rows (by queue_seq) that share the same sender AND
 * conversation, bounded by `maxCount` and `maxChars` of prompt text. All claimed
 * rows move to `dispatching` under one lease. Never reorders across batches.
 */
function claimBatch(
  recipientSessionId: string,
  leaseOwner: string,
  leaseMs: number,
  maxCount: number,
  maxChars: number,
  now = Date.now(),
): PeerPromptRecord[] {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db
      .prepare(
        "SELECT * FROM peer_prompts WHERE recipient_session_id = ? AND status = 'queued' ORDER BY queue_seq",
      )
      .all(recipientSessionId) as unknown as Row[];
    const batch: Row[] = [];
    let chars = 0;
    for (const row of rows) {
      if (batch.length === 0) {
        batch.push(row);
        chars += row.prompt.length;
        continue;
      }
      const head = batch[0]!;
      if (
        row.sender_session_id !== head.sender_session_id ||
        row.conversation_id !== head.conversation_id
      )
        break;
      if (batch.length >= maxCount) break;
      if (chars + row.prompt.length > maxChars) break;
      batch.push(row);
      chars += row.prompt.length;
    }
    for (const row of batch)
      transitionInTxn(
        db,
        row.id,
        ["queued"],
        "dispatching",
        { leaseOwner, leaseExpiresAt: now + leaseMs, bumpAttempts: true },
        now,
      );
    const claimed = batch.map((row) => map(getRow(row.id)!));
    db.exec("COMMIT");
    return claimed;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const releaseToQueue = (id: string, reason?: string, now = Date.now()) =>
  transition(
    id,
    ["dispatching"],
    "queued",
    { leaseOwner: null, leaseExpiresAt: null, failureReason: reason ?? null },
    now,
  );
const markAdmitted = (id: string, now = Date.now()) =>
  // A prior transient failure (busy-race, resume failure) may have left
  // `failure_reason` set from an earlier retryable_failed round; clear it on
  // successful admission so a card/history read never renders a stale
  // failure detail for a message that ultimately delivered fine. Kept
  // (deliberately NOT cleared) while queued/retrying — only admission itself
  // is the "this failure no longer applies" boundary.
  transition(
    id,
    ["dispatching"],
    "admitted",
    {
      acceptedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      failureReason: null,
    },
    now,
  );
const markAcknowledged = (id: string, now = Date.now()) =>
  transition(id, ["admitted"], "acknowledged", { acknowledgedAt: now }, now);

/**
 * Record which batch (by its head row's id) each of these rows was durably
 * admitted together as. Not a status transition (no audit entry) — a plain
 * durable fact recorded once at admission time so history projection can
 * later reconstruct the same recipient-side grouping the live delivery used,
 * even after the process restarts or the sender/recipient reconnects.
 */
function markDeliveryBatch(ids: string[], headId: string): void {
  if (ids.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    "UPDATE peer_prompts SET batch_head_id = ? WHERE id = ?",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of ids) stmt.run(headId, id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
const markInterrupted = (
  id: string,
  reason: string,
  kind: PeerPromptInterruptionKind,
  now = Date.now(),
) =>
  transition(
    id,
    ["admitted", "acknowledged", "dispatching"],
    "interrupted",
    {
      failureReason: reason,
      interruptionKind: kind,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
    now,
  );
/** Mark retryable with a scheduled due time; `sweepDueRetries` requeues it once due. */
const markRetryable = (
  id: string,
  reason: string,
  backoffMs: number,
  now = Date.now(),
) =>
  transition(
    id,
    ["dispatching", "queued", "admitted", "acknowledged"],
    "retryable_failed",
    {
      failureReason: reason,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: now + backoffMs,
    },
    now,
  );
const markFailed = (id: string, reason: string, now = Date.now()) =>
  transition(
    id,
    ["queued", "dispatching", "retryable_failed"],
    "failed",
    { failureReason: reason, leaseOwner: null, leaseExpiresAt: null },
    now,
  );
const markExpired = (id: string, now = Date.now()) =>
  transition(id, ["awaiting_response"], "expired", {}, now);

/**
 * Atomically remove not-yet-dispatched work from one recipient's queue.
 *
 * `senderSessionId` narrows this to messages the caller sent. Omitting it is
 * reserved for a coordinator clearing its still-owned child's whole queue
 * before stopping that child. A `dispatching` row is deliberately excluded:
 * the drainer may already be admitting it to the recipient log, so claiming it
 * was cancelled would be false.
 */
function cancelPending(
  recipientSessionId: string,
  reason: string,
  senderSessionId?: string,
  now = Date.now(),
): PeerPromptRecord[] {
  const db = getDb();
  const senderClause = senderSessionId ? " AND sender_session_id = ?" : "";
  const params = senderSessionId
    ? [recipientSessionId, senderSessionId]
    : [recipientSessionId];
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db
      .prepare(
        `SELECT id FROM peer_prompts
          WHERE recipient_session_id = ?${senderClause}
            AND status IN ('queued', 'retryable_failed')
          ORDER BY queue_seq`,
      )
      .all(...(params as never[])) as { id: string }[];
    const cancelled: PeerPromptRecord[] = [];
    for (const row of rows) {
      if (
        transitionInTxn(
          db,
          row.id,
          ["queued", "retryable_failed"],
          "cancelled",
          {
            failureReason: reason,
            leaseOwner: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
          },
          now,
        )
      )
        cancelled.push(map(getRow(row.id)!));
    }
    db.exec("COMMIT");
    return cancelled;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Admitted/acknowledged turn ended: completed, or awaiting_response if a reply is wanted. */
function markCompleted(
  id: string,
  now = Date.now(),
): PeerPromptRecord | undefined {
  const row = getRow(id);
  if (!row) return undefined;
  const to: PeerPromptStatus =
    row.response_requested === 1 ? "awaiting_response" : "completed";
  return transition(
    id,
    ["admitted", "acknowledged"],
    to,
    { completedAt: now },
    now,
  );
}

/** Mark the original request replied and record the reply message id. */
function markReplied(
  originalId: string,
  replyMessageId: string,
  now = Date.now(),
): PeerPromptRecord | undefined {
  return transition(
    originalId,
    ["admitted", "acknowledged", "completed", "awaiting_response"],
    "replied",
    { repliedAt: now, repliedByMessageId: replyMessageId },
    now,
  );
}

/* ------------------------------- reads ----------------------------------- */

const getById = (id: string): PeerPromptRecord | undefined => {
  const row = getRow(id);
  return row ? map(row) : undefined;
};

/** Distinct recipient ids that currently have queued messages (for startup drain). */
function queuedRecipientIds(): string[] {
  return (
    getDb()
      .prepare(
        "SELECT DISTINCT recipient_session_id FROM peer_prompts WHERE status = 'queued'",
      )
      .all() as { recipient_session_id: string }[]
  ).map((r) => r.recipient_session_id);
}

/**
 * The rows that still owe their sender a "this never finished" notice: a reply
 * was requested, the process died under the delivered turn, and nobody has been
 * told yet. Ordered oldest-first so one notice reads as a timeline.
 *
 * `interruption_kind = 'restart'` is the whole gate. A provider refusal is
 * deliberately excluded — see {@link PeerPromptInterruptionKind}.
 */
function interruptedOwingSenderNotice(
  senderSessionId?: string,
): PeerPromptRecord[] {
  const where =
    "status = 'interrupted' AND interruption_kind = 'restart'" +
    " AND response_requested = 1 AND sender_notified_at_ms IS NULL";
  const rows = senderSessionId
    ? (getDb()
        .prepare(
          `SELECT * FROM peer_prompts WHERE ${where} AND sender_session_id = ? ORDER BY created_at_ms`,
        )
        .all(senderSessionId) as unknown as Row[])
    : (getDb()
        .prepare(
          `SELECT * FROM peer_prompts WHERE ${where} ORDER BY created_at_ms`,
        )
        .all() as unknown as Row[]);
  return rows.map(map);
}

/** Every sender with at least one row owing a notice, so boot can reach cold ones. */
function senderIdsOwingNotice(): string[] {
  return (
    getDb()
      .prepare(
        "SELECT DISTINCT sender_session_id FROM peer_prompts" +
          " WHERE status = 'interrupted' AND interruption_kind = 'restart'" +
          " AND response_requested = 1 AND sender_notified_at_ms IS NULL",
      )
      .all() as { sender_session_id: string }[]
  ).map((r) => r.sender_session_id);
}

/**
 * Record that the sender has been told, exactly once and durably. Written only
 * after the notice turn is accepted, so a crash mid-notice re-notifies rather
 * than swallowing the only warning the sender was ever going to get.
 */
function markSenderNotified(ids: readonly string[], now = Date.now()): void {
  if (ids.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    "UPDATE peer_prompts SET sender_notified_at_ms = ? WHERE id = ? AND sender_notified_at_ms IS NULL",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of ids) stmt.run(now, id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function listPendingForRecipient(
  recipientSessionId: string,
): PeerPromptRecord[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM peer_prompts WHERE recipient_session_id = ? AND status = 'queued' ORDER BY queue_seq",
      )
      .all(recipientSessionId) as unknown as Row[]
  ).map(map);
}

/**
 * Statuses in which one sender's message to a recipient is a turn that has been
 * accepted but has not finished: waiting in the queue, being dispatched, or
 * running. `completed`/`awaiting_response` are post-turn bookkeeping, and
 * `retryable_failed` is not running now — its retry re-enters as `queued`.
 */
const UNFINISHED_TURN_STATUSES: PeerPromptStatus[] = [
  "queued",
  "dispatching",
  "admitted",
  "acknowledged",
];

/**
 * How many turns this sender has queued or running in that recipient right now.
 *
 * The concurrency accounting for directly spawned peers
 * ([Task-595](pa://task/595)) needs this: a freshly created child's runtime does
 * not read as `running` until its queued prompt is actually picked up, and a
 * budget that cannot see the queue would let a second batch claim the same
 * slots during that window.
 */
function unfinishedTurnCount(
  senderSessionId: string,
  recipientSessionId: string,
): number {
  const placeholders = UNFINISHED_TURN_STATUSES.map(() => "?").join(", ");
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM peer_prompts WHERE sender_session_id = ? AND recipient_session_id = ? AND status IN (${placeholders})`,
    )
    .get(senderSessionId, recipientSessionId, ...UNFINISHED_TURN_STATUSES) as {
    n: number;
  };
  return row?.n ?? 0;
}

/**
 * Replies this sender explicitly asked for and has not received or abandoned.
 *
 * This is the coordinator's durable "more peer work is still coming" fact.
 * It includes queued/running delivery and retryable failures as well as a turn
 * that finished and is awaiting its answer. Terminal rows hold no future reply.
 */
function outstandingResponseRequestCount(senderSessionId: string): number {
  const terminal = TERMINAL_STATUSES.map(() => "?").join(", ");
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM peer_prompts
       WHERE sender_session_id = ? AND response_requested = 1
         AND status NOT IN (${terminal})`,
    )
    .get(senderSessionId, ...TERMINAL_STATUSES) as { n: number };
  return row?.n ?? 0;
}

/** The read behind {@link outstandingRepliesBySender}; exported for its plan test. */
export const OUTSTANDING_REPLIES_SQL = `
  WITH owed AS (
    SELECT id, sender_session_id, recipient_session_id, chain_id, queue_seq
      FROM peer_prompts
     WHERE status = 'awaiting_response' AND response_requested = 1
    UNION ALL
    SELECT o.id, o.sender_session_id, o.recipient_session_id, o.chain_id,
           o.queue_seq
      FROM peer_prompts a
      CROSS JOIN peer_prompts o ON o.replied_by_message_id = a.id
     WHERE a.status IN ('cancelled', 'failed') AND a.accepted_at_ms IS NULL
       AND o.status = 'replied' AND o.response_requested = 1
  )
  SELECT DISTINCT o.sender_session_id, o.recipient_session_id
    FROM owed o
   WHERE NOT EXISTS (
           SELECT 1 FROM peer_prompts r
            WHERE r.recipient_session_id = o.sender_session_id
              AND r.sender_session_id = o.recipient_session_id
              AND r.queue_seq > o.queue_seq
              AND r.accepted_at_ms IS NOT NULL
         )
     AND NOT EXISTS (
           SELECT 1 FROM peer_prompts r
            WHERE r.recipient_session_id = o.sender_session_id
              AND r.chain_id = o.chain_id
              AND r.queue_seq > o.queue_seq
              AND r.accepted_at_ms IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM peer_prompts f
                 WHERE f.chain_id = o.chain_id
                   AND f.sender_session_id = o.recipient_session_id
                   AND f.recipient_session_id = r.sender_session_id
                   AND f.queue_seq > o.queue_seq
                   AND f.queue_seq < r.queue_seq)
         )
   ORDER BY o.sender_session_id, o.recipient_session_id`;

/**
 * For every sender, the peers that still OWE it a reply: a `responseRequested`
 * prompt whose turn ended without the answer (`awaiting_response`) — the
 * session list's "who still owes whom" fact, which a quiet tree reads as
 * stalled. One read, so the list rebuild pays it once, not per row.
 *
 * A request marked `replied` whose correlated reply never reached the
 * sender — cancelled or failed before admission — is still owed: `replied`
 * is written when the reply is QUEUED, not when it lands. That half starts
 * from the few lost replies (`CROSS JOIN` keeps SQLite from driving it from
 * every replied row instead) and follows the back-link index.
 *
 * Two kinds of open row do NOT count:
 * - one still being delivered or retried (`queued` … `retryable_failed`):
 *   delivery is work in progress, not a stall;
 * - one effectively answered without being marked: a reply closes exactly
 *   one request by strict correlation, so a report forwarded through a third
 *   peer, or an answer after the sender re-asked, leaves the original row
 *   open. A LATER prompt that REACHED the sender (durably admitted — a report
 *   cancelled or failed before delivery answers nothing) from the owed peer
 *   counts as the answer, and so does one on the request's own chain (which a
 *   forward keeps) — but only from a session the owed peer itself handed the
 *   work to on that chain since the request: peers spawned in one turn share a
 *   chain, and one reviewer's reply must not answer for the reviewer beside it,
 *   even when that reviewer delegated elsewhere on the same chain.
 *
 * Each question is its own NOT EXISTS so each is one exact index seek on
 * (recipient, sender or chain, queue_seq) — `0065_peer_prompt_reply_lookup.sql`
 * (whose header overstates the gain: the earlier probes already seeked the
 * sender/chain indexes, reading the owed peer's later sends or the chain) —
 * and the lost-reply half follows `0066_peer_prompt_replied_by_index.sql`;
 * `peerPromptStore.test.ts` pins the plan.
 *
 * Not modelled: a report that reaches the sender on a fresh chain through a
 * third peer (a poke closes the poked peer's chains, so its forward starts a
 * new one), a forward of two or more hops (owed peer → X → Y → sender), and a
 * sender that releases a peer with a plain message ("stand down") — each stays
 * owed until the user settles or archives that peer, or the request expires
 * (`RESPONSE_TTL_MS`, 30 days).
 */
function outstandingRepliesBySender(): Map<string, string[]> {
  const rows = getDb().prepare(OUTSTANDING_REPLIES_SQL).all() as {
    sender_session_id: string;
    recipient_session_id: string;
  }[];
  const bySender = new Map<string, string[]>();
  for (const row of rows) {
    const recipients = bySender.get(row.sender_session_id);
    if (recipients) recipients.push(row.recipient_session_id);
    else bySender.set(row.sender_session_id, [row.recipient_session_id]);
  }
  return bySender;
}

function listByConversation(conversationId: string): PeerPromptRecord[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM peer_prompts WHERE conversation_id = ? ORDER BY queue_seq",
      )
      .all(conversationId) as unknown as Row[]
  ).map(map);
}

function listByChain(chainId: string): PeerPromptRecord[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM peer_prompts WHERE chain_id = ? ORDER BY queue_seq",
      )
      .all(chainId) as unknown as Row[]
  ).map(map);
}

function listByParticipant(sessionId: string, limit = 50): PeerPromptRecord[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM peer_prompts WHERE sender_session_id = ? OR recipient_session_id = ? ORDER BY queue_seq DESC LIMIT ?",
      )
      .all(sessionId, sessionId, limit) as unknown as Row[]
  ).map(map);
}

/**
 * EVERY member of one delivered batch for this recipient, regardless of any
 * bounded/paginated window — used to compute a batch's aggregate card state
 * from its COMPLETE membership rather than whatever subset a history page or
 * broadcast happens to have in hand. Matches by `batch_head_id` (set on every
 * member including the head) OR `id` (so the head row still matches even if,
 * in a narrow crash window, its own `batch_head_id` has not yet been set).
 */
function listByBatchHead(
  recipientSessionId: string,
  headId: string,
): PeerPromptRecord[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM peer_prompts WHERE recipient_session_id = ? AND (batch_head_id = ? OR id = ?) ORDER BY queue_seq ASC",
      )
      .all(recipientSessionId, headId, headId) as unknown as Row[]
  ).map(map);
}

/**
 * Unreplied `responseRequested` messages FROM `fromSessionId` TO `toSessionId`
 * used by Task-90 auto-correlation. Newest first.
 */
function unrepliedRequestsBetween(
  fromSessionId: string,
  toSessionId: string,
): PeerPromptRecord[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM peer_prompts
      WHERE sender_session_id = ? AND recipient_session_id = ? AND response_requested = 1
        AND status IN ('admitted','acknowledged','completed','awaiting_response')
      ORDER BY queue_seq DESC`,
      )
      .all(fromSessionId, toSessionId) as unknown as Row[]
  ).map(map);
}

/* --------------------------- recovery/retention -------------------------- */

/**
 * Read-only: every row currently leased (`dispatching`). The caller (Task 88
 * boot recovery) reconciles each against the recipient canonical log BEFORE
 * deciding its fate — see {@link applyRecoveryDecisions}, which is the only
 * function that actually moves these rows, so the decision and the write are
 * never split across two separate commits.
 */
function listDispatching(): PeerPromptRecord[] {
  return (
    getDb()
      .prepare("SELECT * FROM peer_prompts WHERE status = 'dispatching'")
      .all() as unknown as Row[]
  ).map(map);
}

export interface PeerPromptRecoveryDecision {
  id: string;
  toStatus: "queued" | "interrupted";
  /** Restore the durable batch grouping fact in the SAME transaction as the status write. */
  batchHeadId?: string;
}

/**
 * Apply a full boot-recovery plan for currently-`dispatching` rows in ONE
 * transaction: every row moves DIRECTLY from `dispatching` to its final
 * decided status (never through an intermediate `queued` commit for a row
 * that is decided `interrupted`), and any accompanying `batch_head_id`
 * restoration lands in the SAME transaction. A two-phase commit (`dispatching`
 * -> `queued` always, THEN separately maybe -> `interrupted`) would leave a
 * durably-committed "queued but already canonically admitted" state after a
 * crash between those two commits — a state neither this function nor
 * `recoverStrandedAdmitted` would ever re-scan on a later boot, and that
 * ordinary drain/retry logic could misinterpret as never having been
 * delivered. Returns the affected records so the caller can broadcast.
 */
function applyRecoveryDecisions(
  decisions: PeerPromptRecoveryDecision[],
  failureReason: string,
  kind: PeerPromptInterruptionKind,
  now = Date.now(),
): PeerPromptRecord[] {
  if (decisions.length === 0) return [];
  const db = getDb();
  const setBatchHead = db.prepare(
    "UPDATE peer_prompts SET batch_head_id = ? WHERE id = ?",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    const applied: PeerPromptRecord[] = [];
    for (const d of decisions) {
      if (d.batchHeadId) setBatchHead.run(d.batchHeadId, d.id);
      const patch: TransitionPatch =
        d.toStatus === "interrupted"
          ? {
              failureReason,
              interruptionKind: kind,
              leaseOwner: null,
              leaseExpiresAt: null,
            }
          : { leaseOwner: null, leaseExpiresAt: null };
      if (transitionInTxn(db, d.id, ["dispatching"], d.toStatus, patch, now))
        applied.push(map(getRow(d.id)!));
    }
    db.exec("COMMIT");
    return applied;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Boot recovery (Task 88): a row already `admitted`/`acknowledged` when the
 * process died was durably delivered to the recipient's canonical log, so
 * re-queuing it would re-inject a second visible prompt — the crash window
 * this closes is strictly AFTER admission and BEFORE run completion. Every
 * such row unconditionally becomes `interrupted` (never re-checked against
 * the log; admission is a fact recorded in `status`, not something to
 * re-derive), through the same audited `transitionInTxn` path as every other
 * lifecycle change.
 */
function recoverStrandedAdmitted(
  reason: string,
  kind: PeerPromptInterruptionKind,
  now = Date.now(),
): PeerPromptRecord[] {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db
      .prepare(
        "SELECT id FROM peer_prompts WHERE status IN ('admitted', 'acknowledged')",
      )
      .all() as { id: string }[];
    const recovered: PeerPromptRecord[] = [];
    for (const r of rows) {
      if (
        transitionInTxn(
          db,
          r.id,
          ["admitted", "acknowledged"],
          "interrupted",
          {
            failureReason: reason,
            interruptionKind: kind,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
          now,
        )
      ) {
        recovered.push(map(getRow(r.id)!));
      }
    }
    db.exec("COMMIT");
    return recovered;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Requeue every `retryable_failed` row whose backoff has elapsed, so the normal
 * FIFO claim/drain path picks it up again. This is the ONLY path back from
 * `retryable_failed`; without it those rows are a permanent dead end.
 */
function requeueDueRetries(now = Date.now()): PeerPromptRecord[] {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db
      .prepare(
        "SELECT * FROM peer_prompts WHERE status = 'retryable_failed' AND next_attempt_at_ms IS NOT NULL AND next_attempt_at_ms <= ?",
      )
      .all(now) as unknown as Row[];
    const requeued: PeerPromptRecord[] = [];
    for (const r of rows) {
      if (
        transitionInTxn(
          db,
          r.id,
          ["retryable_failed"],
          "queued",
          { leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null },
          now,
        )
      ) {
        requeued.push(map(getRow(r.id)!));
      }
    }
    db.exec("COMMIT");
    return requeued;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Requeue only leases that have expired (periodic sweep). */
function requeueExpiredLeases(now = Date.now()): PeerPromptRecord[] {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db
      .prepare(
        "SELECT id FROM peer_prompts WHERE status = 'dispatching' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms < ?",
      )
      .all(now) as { id: string }[];
    const requeued: PeerPromptRecord[] = [];
    for (const r of rows) {
      if (
        transitionInTxn(
          db,
          r.id,
          ["dispatching"],
          "queued",
          { leaseOwner: null, leaseExpiresAt: null },
          now,
        )
      ) {
        requeued.push(map(getRow(r.id)!));
      }
    }
    db.exec("COMMIT");
    return requeued;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Expire unresolved response expectations older than the cutoff (Task 89). Returns the affected records so callers can broadcast. */
function expireUnresolved(
  cutoffMs: number,
  now = Date.now(),
): PeerPromptRecord[] {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db
      .prepare(
        "SELECT id FROM peer_prompts WHERE status = 'awaiting_response' AND expires_at_ms IS NOT NULL AND expires_at_ms < ?",
      )
      .all(cutoffMs) as { id: string }[];
    const expired: PeerPromptRecord[] = [];
    for (const r of rows) {
      if (
        transitionInTxn(db, r.id, ["awaiting_response"], "expired", {}, now)
      ) {
        expired.push(map(getRow(r.id)!));
      }
    }
    db.exec("COMMIT");
    return expired;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Prune old terminal rows, except identities retained by a live subagent run.
 * The run is the result envelope's retention owner until Task-490 deletion.
 */
function pruneTerminal(cutoffMs: number): number {
  const placeholders = TERMINAL_STATUSES.map(() => "?").join(", ");
  return Number(
    getDb()
      .prepare(
        `DELETE FROM peer_prompts
         WHERE status IN (${placeholders}) AND updated_at_ms < ?
           AND id NOT IN (
             SELECT triggering_peer_prompt_id FROM subagent_runs
               WHERE is_member = 1 AND triggering_peer_prompt_id IS NOT NULL
             UNION SELECT optional_result_correlation_id FROM subagent_runs
               WHERE is_member = 1 AND optional_result_correlation_id IS NOT NULL
             UNION SELECT required_response_message_id FROM subagent_runs
               WHERE is_member = 1 AND required_response_message_id IS NOT NULL
             UNION SELECT required_response_answer_message_id FROM subagent_runs
               WHERE is_member = 1 AND required_response_answer_message_id IS NOT NULL
             UNION SELECT result_message_id FROM subagent_runs
               WHERE is_member = 1 AND result_message_id IS NOT NULL
           )`,
      )
      .run(...(TERMINAL_STATUSES as never[]), cutoffMs).changes,
  );
}

export const peerPromptStore = {
  // chains
  createChain,
  getChain,
  reserveHop,
  addParticipant,
  participantsOf,
  chainsForSession,
  closeChainsForSession,
  // writes / transitions
  enqueue,
  enqueueRouted,
  transition,
  claimNext,
  claimBatch,
  releaseToQueue,
  markAdmitted,
  markAcknowledged,
  markDeliveryBatch,
  markCompleted,
  markReplied,
  markInterrupted,
  markRetryable,
  markFailed,
  markExpired,
  cancelPending,
  markSenderNotified,
  // reads
  getById,
  queuedRecipientIds,
  interruptedOwingSenderNotice,
  senderIdsOwingNotice,
  listPendingForRecipient,
  unfinishedTurnCount,
  outstandingResponseRequestCount,
  outstandingRepliesBySender,
  listByConversation,
  listByChain,
  listByParticipant,
  listByBatchHead,
  unrepliedRequestsBetween,
  // recovery / retention
  listDispatching,
  applyRecoveryDecisions,
  recoverStrandedAdmitted,
  requeueExpiredLeases,
  requeueDueRetries,
  expireUnresolved,
  pruneTerminal,
};
