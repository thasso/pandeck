/**
 * Who must hear that delegated work stopped on a failure, and what they are
 * told (`docs/delegation-failure-notices.md`).
 *
 * A child that fails — usage limit, expired sign-in, provider fault, a harness
 * that refused the prompt — cannot report that itself, and the coordinator
 * that is waiting on it is usually idle, so nothing would ever tell it. The
 * server does: the failure is recorded as a durable notice for the child's
 * IMMEDIATE coordinator in the same synchronous step that sees it, and the
 * peer drain delivers it (`peerPrompt.ts`) under the usual hold and busy rules.
 *
 * A notice is a FACT, never a permission. Nothing here retries the failed
 * turn, restarts a job, switches a runtime or credential, or replaces a peer.
 *
 * Nothing the provider said leaves this module: its wording is classified in
 * memory into a fixed category and dropped. The reset time is shown only when
 * the harness reported it as a structured field and it is a plausible date.
 */
import type { PromptOrigin } from "@assistant/shared/session";
import { automaticTurnsHeld } from "./automaticTurnHold.ts";
import { inDbTransaction } from "./db/index.ts";
import {
  compactJournal,
  journalDone,
  journalFailure,
  pendingJournaledFailures,
  type JournaledFailure,
} from "./delegationFailureJournal.ts";
import {
  delegationFailureNoticeStore,
  type DelegationFailureCategory,
  type DelegationFailureNotice,
  type DelegationFailureNoticeInput,
  type DelegationFailureRoute,
} from "./db/delegationFailureNoticeStore.ts";
import {
  peerPromptStore,
  type PeerPromptRecord,
} from "./db/peerPromptStore.ts";
import { sessionStore, type SessionMeta } from "./db/sessionStore.ts";
import { analyzeProviderError } from "./providerErrors.ts";
import type { RunFailureFacts } from "./session/adapters/contract.ts";
import type { RunFailureReport } from "./session/runtime/liveSession.ts";

/**
 * The origin of every server-generated notice turn — this one and the peer
 * interruption notice. A failure of such a turn is reported upward only along
 * the spawn tree, which has no cycles, so two sessions waiting on each other
 * cannot trade notices forever.
 */
export const PEER_NOTICE_AGENT_ID = "peer-notice";

/** At most this many unanswered requests are named per notice. */
const MAX_REQUESTS_PER_NOTICE = 5;
const TITLE_MAX = 80;
/** A reset further from the failure than this is not believed. */
const RESET_MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
const RESET_MAX_BEHIND_MS = 60 * 1000;

/* ------------------------------ stand-down ------------------------------- */

/**
 * Children a coordinator is stopping through `session_control`. A turn that
 * ends while its coordinator stands it down is the coordinator's own doing,
 * whatever the harness reports. Cleared when the child's next turn starts.
 */
const standingDown = new Set<string>();

export function noteDelegationStandDown(childSessionId: string): void {
  standingDown.add(childSessionId);
}

export function clearDelegationStandDown(childSessionId: string): void {
  standingDown.delete(childSessionId);
}

/* ------------------------------ categories ------------------------------- */

function categoryForKind(
  kind: ReturnType<typeof analyzeProviderError>["kind"],
): DelegationFailureCategory {
  switch (kind) {
    case "auth":
      return "auth";
    case "quota":
      return "usage_limit";
    case "rate_limit":
      return "rate_limit";
    case "content_policy":
      return "content_policy";
    default:
      return "provider_error";
  }
}

/** An instant `Date` can represent, as an ISO string; else nothing. */
function isoAt(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * A structured reset time worth stating: a real date, not long before the
 * failure and within a year after it. Anything else is dropped on its own —
 * the notice and its category still go out.
 */
function plausibleReset(
  resetAtMs: number | undefined,
  failedAt: number,
): number | undefined {
  if (resetAtMs === undefined || isoAt(resetAtMs) === undefined)
    return undefined;
  if (resetAtMs < failedAt - RESET_MAX_BEHIND_MS) return undefined;
  if (resetAtMs > failedAt + RESET_MAX_AHEAD_MS) return undefined;
  return resetAtMs;
}

/**
 * Classify a failure into the fixed vocabulary. Structured facts win; prose is
 * classified in memory only and never stored or forwarded.
 */
function classify(
  errorMessage: string | undefined,
  facts: RunFailureFacts | undefined,
  failedAt: number,
): { category: DelegationFailureCategory; resetAt?: number } {
  if (facts) {
    const category = categoryForKind(facts.kind);
    const resetAt =
      category === "usage_limit" || category === "rate_limit"
        ? plausibleReset(facts.resetAtMs, failedAt)
        : undefined;
    return { category, ...(resetAt !== undefined ? { resetAt } : {}) };
  }
  return {
    category: categoryForKind(analyzeProviderError(errorMessage ?? "").kind),
  };
}

/**
 * The reason stored on a peer row this module interrupts: the category in
 * words of our own, so the row and its card never carry the provider's.
 */
const PEER_FAILURE_REASONS: Record<DelegationFailureCategory, string> = {
  auth: "The recipient's turn failed: its credentials were rejected.",
  usage_limit:
    "The recipient's turn failed: its account reached a usage limit.",
  rate_limit: "The recipient's turn failed: it was rate-limited.",
  content_policy:
    "The recipient's turn failed: the provider refused the content.",
  provider_error: "The recipient's turn failed: a provider or harness error.",
  delivery: "The message could not be delivered.",
};

/** The category of a stored peer failure reason, for the interruption notice. */
export function categoryForFailureReason(
  reason: string | undefined,
): DelegationFailureCategory {
  for (const [category, text] of Object.entries(PEER_FAILURE_REASONS))
    if (text === reason) return category as DelegationFailureCategory;
  return classify(reason, undefined, Date.now()).category;
}

/* ------------------------------ eligibility ------------------------------ */

/** A session that may still receive a notice, or be reported about. */
function liveUserSession(sessionId: string): SessionMeta | undefined {
  const meta = sessionStore.get(sessionId);
  if (!meta || meta.scope !== "user" || meta.archivedAt !== undefined)
    return undefined;
  return meta;
}

function isNoticeTurn(origin: PromptOrigin | undefined): boolean {
  return origin?.kind === "agent" && origin.agentId === PEER_NOTICE_AGENT_ID;
}

/** Whether the coordinator still owns the child through its spawn edge. */
function ownsChild(coordinatorId: string, childId: string): boolean {
  const spawn = sessionStore.spawnedParentsByChildIds([childId]).get(childId);
  return (
    spawn?.ownership === "coordinator" &&
    spawn.parentSessionId === coordinatorId
  );
}

/** Neither side of a spawned delegation was put down by the user. */
function neitherSettled(coordinator: SessionMeta, child: SessionMeta): boolean {
  return coordinator.settledAt === undefined && child.settledAt === undefined;
}

/**
 * A request still waiting for its reply: asked for one, and neither answered,
 * withdrawn nor expired since.
 */
function unanswered(m: PeerPromptRecord): boolean {
  return (
    m.responseRequested &&
    m.status !== "replied" &&
    m.status !== "cancelled" &&
    m.status !== "expired" &&
    m.status !== "completed"
  );
}

function anchorBetween(
  coordinatorId: string,
  childId: string,
): DelegationFailureNoticeInput["anchor"] {
  const latest = peerPromptStore.latestBetween(coordinatorId, childId);
  return latest
    ? {
        chainId: latest.chainId,
        conversationId: latest.conversationId,
        hop: latest.hop,
      }
    : undefined;
}

function requestIdsFrom(
  rows: readonly PeerPromptRecord[],
  coordinatorId: string,
): string[] {
  return rows
    .filter((m) => m.senderSessionId === coordinatorId)
    .slice(-MAX_REQUESTS_PER_NOTICE)
    .map((m) => m.id);
}

/**
 * A failed turn as safe facts — or nothing, when it owes no notice at all: its
 * child is being stood down by its coordinator or was stopped by the user (its
 * Stop hold). Classifies the provider's wording in memory and keeps only the
 * category and a structured reset.
 */
function safeFailureOf(report: RunFailureReport): JournaledFailure | undefined {
  if (standingDown.has(report.sessionId)) return undefined;
  let held = false;
  try {
    held = automaticTurnsHeld(report.sessionId);
  } catch {
    // The database is what failed; a Stop also marks the turn's abort in the
    // runtime, which never reports it, so an unreadable hold is not a Stop.
  }
  if (held) return undefined;
  const { category, resetAt } = classify(
    report.errorMessage,
    report.failure,
    report.at,
  );
  return {
    incidentKey: `run:${report.sessionId}:${report.runId}`,
    sessionId: report.sessionId,
    runId: report.runId,
    category,
    ...(resetAt !== undefined ? { resetAt } : {}),
    at: report.at,
    noticeTurn: isNoticeTurn(report.origin),
  };
}

/**
 * The notices one failed turn owes, recorded in ONE transaction. Returns the
 * rows written; throws when the database refuses.
 *
 * Who is told, and only them:
 * - `spawn` — the session that spawned the child and still owns it. Neither
 *   may be settled (the user put that delegation down), unless the
 *   coordinator has a request open in the child right now.
 * - `request` — a session whose requested reply the child still owes: it was
 *   being answered in the failed turn, or the child holds it unanswered
 *   (`awaiting_response`). Not from a notice turn's failure: requests can form
 *   cycles, spawn edges cannot.
 *
 * A requested reply that was being answered IN the failed turn is interrupted
 * here, in the same transaction, with a reason of our own words and marked as
 * told: this notice is what tells its sender, so the peer interruption notice
 * does not tell it a second time.
 *
 * Nothing is recorded for a child deleted, archived or outside the user's
 * scope.
 */
function recordSafeFailure(
  failure: JournaledFailure,
  now = Date.now(),
): DelegationFailureNotice[] {
  const childId = failure.sessionId;
  const child = liveUserSession(childId);
  if (!child) return [];

  const open = peerPromptStore.openForRecipient(childId);
  const inTurn = open.filter(
    (m) =>
      m.responseRequested &&
      (m.status === "admitted" || m.status === "acknowledged"),
  );

  const routes = new Map<string, DelegationFailureRoute>();
  const spawn = sessionStore.spawnedParentsByChildIds([childId]).get(childId);
  if (spawn?.ownership === "coordinator") {
    const parentId = spawn.parentSessionId;
    const parent = liveUserSession(parentId);
    const asked = open.some((m) => m.senderSessionId === parentId);
    if (parent && (asked || neitherSettled(parent, child)))
      routes.set(parentId, "spawn");
  }
  for (const m of inTurn)
    if (!routes.has(m.senderSessionId) && liveUserSession(m.senderSessionId))
      routes.set(m.senderSessionId, "request");
  if (!failure.noticeTurn)
    for (const m of open)
      if (
        m.status === "awaiting_response" &&
        !routes.has(m.senderSessionId) &&
        liveUserSession(m.senderSessionId)
      )
        routes.set(m.senderSessionId, "request");
  routes.delete(childId);
  // A failure recorded late (its first write failed) may already have been
  // seen by the peer path, which interrupted the failed turn's requested
  // replies and tells their senders itself. A row this function interrupted
  // belongs to an incident already recorded. Either way: told elsewhere.
  for (const m of peerPromptStore.failedForRecipientSince(childId, failure.at))
    if (m.responseRequested) routes.delete(m.senderSessionId);
  if (routes.size === 0) return [];

  const inputs: DelegationFailureNoticeInput[] = [...routes].map(
    ([coordinatorId, route]) => {
      const anchor = anchorBetween(coordinatorId, childId);
      return {
        incidentKey: failure.incidentKey,
        childSessionId: childId,
        coordinatorSessionId: coordinatorId,
        route,
        category: failure.category,
        ...(failure.resetAt !== undefined ? { resetAt: failure.resetAt } : {}),
        requestIds: requestIdsFrom(open, coordinatorId),
        ...(anchor ? { anchor } : {}),
        failedAt: failure.at,
      };
    },
  );
  return inDbTransaction(() => {
    const written = delegationFailureNoticeStore.record(inputs, now);
    peerPromptStore.interruptAsTold(
      inTurn.filter((m) => routes.has(m.senderSessionId)).map((m) => m.id),
      PEER_FAILURE_REASONS[failure.category],
      now,
    );
    return written;
  });
}

/**
 * Record what one failed turn of `report.sessionId` owes — the runtime's
 * failure hook, called before anything else learns of the failure.
 *
 * The safe facts go to the journal FIRST (`delegationFailureJournal.ts`), then
 * to the database, and the journal entry is retired only once the database
 * holds them. A database that refuses leaves the entry pending for the retry
 * sweep and the next boot, and this returns normally: the failure is durable.
 * Only when NEITHER store took it does this throw, so the runtime keeps it in
 * memory and tries again. Returns the notices written now.
 */
export function recordRunFailureNotices(
  report: RunFailureReport,
  now = Date.now(),
): DelegationFailureNotice[] {
  const failure = safeFailureOf(report);
  if (!failure) return [];
  let journaled = false;
  try {
    journalFailure(failure);
    journaled = true;
  } catch {
    console.error(
      `[delegation-failure] could not journal the failure of run ${failure.runId} in ${failure.sessionId}`,
    );
  }
  let written: DelegationFailureNotice[];
  try {
    written = recordSafeFailure(failure, now);
  } catch (err) {
    if (!journaled) throw err;
    console.error(
      `[delegation-failure] could not record the failure of run ${failure.runId} in ${failure.sessionId}; it stays journaled and is retried`,
    );
    return [];
  }
  if (journaled) journalDone(failure.incidentKey);
  return written;
}

/**
 * Record every journaled failure the database does not hold yet — at boot,
 * before peer recovery reclassifies the rows of runs the restart cut off, and
 * from the retry sweep. A failure already recorded is recognized by its
 * incident key and writes nothing. One the database still refuses stays
 * journaled. Returns the notices written.
 */
export function replayJournaledFailures(
  now = Date.now(),
): DelegationFailureNotice[] {
  const written: DelegationFailureNotice[] = [];
  for (const failure of pendingJournaledFailures()) {
    try {
      written.push(...recordSafeFailure(failure, now));
    } catch {
      console.error(
        `[delegation-failure] could not record the journaled failure of run ${failure.runId} in ${failure.sessionId}; it stays journaled`,
      );
      continue;
    }
    journalDone(failure.incidentKey);
  }
  return written;
}

/** Boot: replay what is owed, then shrink the journal to what still is. */
export function recoverJournaledFailuresOnBoot(): number {
  const recorded = replayJournaledFailures().length;
  try {
    compactJournal();
  } catch {
    console.error("[delegation-failure] could not compact the failure journal");
  }
  return recorded;
}

/**
 * The notice a delivery that gave up owes its sender, if the sender is waiting
 * on it: it asked for a reply, or it is the coordinator that spawned and still
 * owns the recipient. Called inside the transaction that marks the row
 * `failed` (`peerPromptStore.markFailed`), so the notice commits with it.
 */
export function recordDeliveryFailureNotice(
  failed: PeerPromptRecord,
  now = Date.now(),
): DelegationFailureNotice[] {
  const childId = failed.recipientSessionId;
  const coordinatorId = failed.senderSessionId;
  if (coordinatorId === childId) return [];
  if (!liveUserSession(childId) || !liveUserSession(coordinatorId)) return [];
  const owns = ownsChild(coordinatorId, childId);
  if (!owns && !failed.responseRequested) return [];
  const classified = categoryForFailureReason(failed.failureReason);
  // Only a failure the reason names outright is more specific than "it could
  // not be delivered"; anything else is the delivery's own failure.
  const category: DelegationFailureCategory =
    classified === "provider_error" ? "delivery" : classified;
  return delegationFailureNoticeStore.record(
    [
      {
        incidentKey: `delivery:${failed.id}`,
        childSessionId: childId,
        coordinatorSessionId: coordinatorId,
        route: owns ? "spawn" : "request",
        category,
        requestIds: [failed.id],
        anchor: {
          chainId: failed.chainId,
          conversationId: failed.conversationId,
          hop: failed.hop,
        },
        failedAt: now,
      },
    ],
    now,
  );
}

/**
 * Why a recorded notice may no longer be delivered, or `undefined` when it may.
 * Asked again right before the notice turn is appended, because the user may
 * have ended the delegation since it was recorded: the evidence that routed it
 * must still hold.
 */
function noLongerOwed(n: DelegationFailureNotice): string | undefined {
  const coordinator = liveUserSession(n.coordinatorSessionId);
  if (!coordinator) return "coordinator no longer active";
  const child = liveUserSession(n.childSessionId);
  if (!child) return "child no longer active";
  const waiting = n.requestIds
    .map((id) => peerPromptStore.getById(id))
    .some((m) => m !== undefined && unanswered(m));
  if (n.route === "request")
    return waiting ? undefined : "the request was answered or withdrawn";
  if (!ownsChild(n.coordinatorSessionId, n.childSessionId))
    return "the child is no longer the coordinator's";
  if (!waiting && !neitherSettled(coordinator, child))
    return "the delegation was settled";
  return undefined;
}

/**
 * The notices still deliverable to a coordinator. Ones the user ended since —
 * either session deleted or archived, the child taken over, the delegation
 * settled, the request answered — are retired as dropped instead.
 */
export function deliverableNotices(
  coordinatorSessionId: string,
): DelegationFailureNotice[] {
  const pending = delegationFailureNoticeStore.pendingFor(coordinatorSessionId);
  const deliverable: DelegationFailureNotice[] = [];
  for (const notice of pending) {
    const reason = noLongerOwed(notice);
    if (reason) delegationFailureNoticeStore.drop([notice.id], reason);
    else deliverable.push(notice);
  }
  return deliverable;
}

/* -------------------------------- wording -------------------------------- */

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function at(ms: number): string {
  return isoAt(ms) ?? "an unknown time";
}

/** One sentence per category: what happened, never the provider's words. */
export function failureSentence(
  category: DelegationFailureCategory,
  resetAt?: number,
): string {
  const reset =
    resetAt !== undefined && isoAt(resetAt) !== undefined
      ? ` The provider reports the limit resets at ${isoAt(resetAt)}.`
      : "";
  switch (category) {
    case "auth":
      return "The provider rejected its credentials (an expired or invalid sign-in).";
    case "usage_limit":
      return `Its account reached a usage, spend or billing limit.${reset}`;
    case "rate_limit":
      return `The provider rate-limited it and the harness's retries ran out.${reset}`;
    case "content_policy":
      return "The provider refused the conversation's content; sending the same session more of it will likely be refused again.";
    case "delivery":
      return "Your message could not be delivered after repeated attempts: the session could not be started or did not accept it.";
    case "provider_error":
      return "The provider or harness failed and the turn ended without finishing.";
  }
}

function requestLine(ids: readonly string[]): string | undefined {
  const rows = ids
    .map((id) => peerPromptStore.getById(id))
    .filter((m): m is PeerPromptRecord => m !== undefined);
  if (rows.length === 0) return undefined;
  const sent = rows
    .map(
      (m) => `sent ${at(m.createdAt)}${m.taskId ? ` (Task ${m.taskId})` : ""}`,
    )
    .join("; ");
  return `  Left unanswered: your message${rows.length === 1 ? "" : "s"} ${sent}.`;
}

/**
 * The notice section. Names the child SESSION ID, so the one useful follow-up
 * — asking it for a status, or looking at it — needs no lookup. Repeated
 * failures of one child read as one entry with the latest category.
 */
export function delegationFailureNoticeLines(
  notices: readonly DelegationFailureNotice[],
): string[] {
  const byChild = new Map<string, DelegationFailureNotice[]>();
  for (const n of notices) {
    const list = byChild.get(n.childSessionId) ?? [];
    list.push(n);
    byChild.set(n.childSessionId, list);
  }
  const lines = [
    `${byChild.size === 1 ? "A session" : `${byChild.size} sessions`} you delegated to stopped on a failure and cannot report it on its own:`,
  ];
  for (const [childId, list] of byChild) {
    const latest = list[list.length - 1]!;
    const title = clip(
      sessionStore.get(childId)?.title ?? "a session",
      TITLE_MAX,
    );
    const when =
      list.length === 1
        ? `failed at ${at(latest.failedAt)}`
        : `failed ${list.length} times, last at ${at(latest.failedAt)}`;
    const subject = latest.category === "delivery" ? "Delivery" : "Its turn";
    lines.push(
      `- ${title} (session \`${childId}\`): ${subject} ${when}. ${failureSentence(latest.category, latest.resetAt)}`,
    );
    const requests = requestLine([
      ...new Set(list.flatMap((n) => n.requestIds)),
    ]);
    if (requests) lines.push(requests);
  }
  return lines;
}
