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
import type { SessionLogEntry } from "./session/log/rawEntry.ts";
import type { RunFailureReport } from "./session/runtime/liveSession.ts";
import { sessionRuntime } from "./session/runtimeInstance.ts";

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
 * The notices one failed turn of `report.sessionId` owes, recorded in ONE
 * transaction before the caller lets anything else learn of the failure. A
 * write that fails throws, and nothing is recorded: the caller keeps the
 * failure and asks again. Returns the rows written.
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
 * Nothing is recorded for a child the user stopped (its Stop hold), one its
 * coordinator is standing down, or one deleted, archived or outside the user's
 * scope.
 */
export function recordRunFailureNotices(
  report: RunFailureReport,
  now = Date.now(),
): DelegationFailureNotice[] {
  const failedAt = report.at;
  const childId = report.sessionId;
  const child = liveUserSession(childId);
  if (!child) return [];
  if (standingDown.has(childId) || automaticTurnsHeld(childId)) return [];

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
  if (!isNoticeTurn(report.origin))
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
  for (const m of peerPromptStore.failedForRecipientSince(childId, failedAt))
    if (m.responseRequested) routes.delete(m.senderSessionId);
  if (routes.size === 0) return [];

  const { category, resetAt } = classify(
    report.errorMessage,
    report.failure,
    failedAt,
  );
  const inputs: DelegationFailureNoticeInput[] = [...routes].map(
    ([coordinatorId, route]) => {
      const anchor = anchorBetween(coordinatorId, childId);
      return {
        incidentKey: `run:${childId}:${report.runId}`,
        childSessionId: childId,
        coordinatorSessionId: coordinatorId,
        route,
        category,
        ...(resetAt !== undefined ? { resetAt } : {}),
        requestIds: requestIdsFrom(open, coordinatorId),
        ...(anchor ? { anchor } : {}),
        failedAt,
      };
    },
  );
  return inDbTransaction(() => {
    const written = delegationFailureNoticeStore.record(inputs, now);
    peerPromptStore.interruptAsTold(
      inTurn.filter((m) => routes.has(m.senderSessionId)).map((m) => m.id),
      PEER_FAILURE_REASONS[category],
      now,
    );
    return written;
  });
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

/* --------------------------------- boot ---------------------------------- */

/**
 * What an interrupted run's own log says about how it ended: the failure, if
 * it failed. The tail follows the run's open `run.started`; an aborted message
 * in it means the turn was stopped, not failed.
 */
function failureInTail(
  entries: readonly SessionLogEntry[],
): Omit<RunFailureReport, "sessionId" | "runId"> | undefined {
  let origin: PromptOrigin | undefined;
  let failure: Omit<RunFailureReport, "sessionId" | "runId"> | undefined;
  for (const raw of entries) {
    const e = raw as unknown as Record<string, unknown>;
    const entryOrigin = e.origin as PromptOrigin | undefined;
    const written =
      typeof e.createdAt === "string" ? Date.parse(e.createdAt) : NaN;
    const at = Number.isFinite(written) ? written : Date.now();
    if (e.type === "message" && e.role === "user" && !origin && !e.hidden)
      origin = entryOrigin;
    if (e.type === "message" && e.role === "assistant") {
      origin ??= entryOrigin;
      if (e.stopReason === "aborted") return undefined;
      if (e.stopReason === "error")
        failure = {
          origin,
          errorMessage: typeof e.error === "string" ? e.error : undefined,
          failure: undefined,
          at,
        };
    }
    if (e.type === "provider.notice" && e.severity === "error") {
      const info = e.providerError as
        { kind?: unknown; resetAt?: unknown } | undefined;
      failure = {
        origin,
        errorMessage: typeof e.message === "string" ? e.message : undefined,
        failure:
          typeof info?.kind === "string"
            ? {
                kind: info.kind as RunFailureFacts["kind"],
                ...(typeof info.resetAt === "number"
                  ? { resetAtMs: info.resetAt * 1000 }
                  : {}),
              }
            : undefined,
        at,
      };
    }
  }
  return failure ? { ...failure, origin } : undefined;
}

/**
 * Record what a failure the previous process saw but never finished recording
 * is owed. Called once at boot, before peer recovery reclassifies the rows of
 * runs the restart cut off.
 *
 * The runtime names every failed run whose notice it could not write on each
 * run marker it writes until it can, and a run the process died inside leaves
 * its bracket open. So this reads, per working-set session, the NEWEST marker
 * and only the runs it points at, each from one bounded read of the log's end.
 * A run already recorded is recognized by its incident key and writes nothing.
 */
export function recoverRunFailureNoticesOnBoot(): number {
  let recorded = 0;
  for (const meta of sessionStore.list()) {
    if (meta.archivedAt !== undefined || sessionStore.isSettled(meta.id))
      continue;
    for (const run of sessionRuntime.runsToRecheck(meta.id)) {
      const failure = failureInTail(run.entries);
      if (!failure) continue;
      recorded += recordRunFailureNotices({
        sessionId: meta.id,
        runId: run.runId,
        ...failure,
      }).length;
    }
  }
  return recorded;
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
