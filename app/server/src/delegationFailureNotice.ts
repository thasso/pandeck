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
 * the harness reported it as a structured field.
 */
import type { PromptOrigin } from "@assistant/shared/session";
import { automaticTurnsHeld } from "./automaticTurnHold.ts";
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

/**
 * Classify a failure into the fixed vocabulary. Structured facts win; prose is
 * classified in memory only and never stored or forwarded.
 */
function classify(
  errorMessage: string | undefined,
  facts: RunFailureFacts | undefined,
): { category: DelegationFailureCategory; resetAt?: number } {
  if (facts) {
    const category = categoryForKind(facts.kind);
    const resetAt =
      (category === "usage_limit" || category === "rate_limit") &&
      facts.resetAtMs !== undefined &&
      Number.isFinite(facts.resetAtMs)
        ? facts.resetAtMs
        : undefined;
    return { category, ...(resetAt !== undefined ? { resetAt } : {}) };
  }
  return {
    category: categoryForKind(analyzeProviderError(errorMessage ?? "").kind),
  };
}

/** The category of a stored peer failure reason, for the interruption notice. */
export function categoryForFailureReason(
  reason: string | undefined,
): DelegationFailureCategory {
  return classify(reason, undefined).category;
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
 * The notices one failed turn of `report.sessionId` owes, recorded before the
 * caller lets anything else learn of the failure. Returns the rows written.
 *
 * Who is told, and only them:
 * - `spawn` — the session that spawned the child and still owns it. Neither
 *   may be settled (the user put that delegation down), unless the
 *   coordinator has a request open in the child right now.
 * - `request` — a session whose requested reply the child still owes
 *   (`awaiting_response`). Not from a notice turn's failure: requests can form
 *   cycles, spawn edges cannot.
 *
 * Skipped: a sender whose requested reply was being answered IN the failed
 * turn — the peer interruption notice tells it, and two notices for one
 * failure would be noise. Nothing is recorded for a child the user stopped
 * (its Stop hold), one its coordinator is standing down, or one deleted,
 * archived or outside the user's scope.
 */
export function recordRunFailureNotices(
  report: RunFailureReport,
  now = Date.now(),
): DelegationFailureNotice[] {
  const childId = report.sessionId;
  const child = liveUserSession(childId);
  if (!child) return [];
  if (standingDown.has(childId) || automaticTurnsHeld(childId)) return [];

  const open = peerPromptStore.openForRecipient(childId);
  const answeredInTurn = new Set(
    open
      .filter(
        (m) =>
          m.responseRequested &&
          (m.status === "admitted" || m.status === "acknowledged"),
      )
      .map((m) => m.senderSessionId),
  );

  const routes = new Map<string, DelegationFailureRoute>();
  const spawn = sessionStore.spawnedParentsByChildIds([childId]).get(childId);
  if (spawn?.ownership === "coordinator") {
    const parentId = spawn.parentSessionId;
    const parent = liveUserSession(parentId);
    const asked = open.some((m) => m.senderSessionId === parentId);
    if (
      parent &&
      (asked ||
        (child.settledAt === undefined && parent.settledAt === undefined))
    )
      routes.set(parentId, "spawn");
  }
  if (!isNoticeTurn(report.origin))
    for (const m of open)
      if (
        m.status === "awaiting_response" &&
        !routes.has(m.senderSessionId) &&
        liveUserSession(m.senderSessionId)
      )
        routes.set(m.senderSessionId, "request");

  const { category, resetAt } = classify(report.errorMessage, report.failure);
  const inputs: DelegationFailureNoticeInput[] = [];
  for (const [coordinatorId, route] of routes) {
    if (coordinatorId === childId || answeredInTurn.has(coordinatorId))
      continue;
    const anchor = anchorBetween(coordinatorId, childId);
    inputs.push({
      incidentKey: `run:${childId}:${report.runId}`,
      childSessionId: childId,
      coordinatorSessionId: coordinatorId,
      route,
      category,
      ...(resetAt !== undefined ? { resetAt } : {}),
      requestIds: requestIdsFrom(open, coordinatorId),
      ...(anchor ? { anchor } : {}),
      failedAt: now,
    });
  }
  return delegationFailureNoticeStore.record(inputs, now);
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
  const spawn = sessionStore.spawnedParentsByChildIds([childId]).get(childId);
  const owns =
    spawn?.ownership === "coordinator" &&
    spawn.parentSessionId === coordinatorId;
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
 * The notices still deliverable to a coordinator. Ones whose child was deleted
 * or archived since, or whose coordinator was, are retired as dropped instead:
 * the user ended that delegation.
 */
export function deliverableNotices(
  coordinatorSessionId: string,
): DelegationFailureNotice[] {
  const pending = delegationFailureNoticeStore.pendingFor(coordinatorSessionId);
  if (pending.length === 0) return [];
  if (!liveUserSession(coordinatorSessionId)) {
    delegationFailureNoticeStore.drop(
      pending.map((n) => n.id),
      "coordinator no longer active",
    );
    return [];
  }
  const gone = pending.filter((n) => !liveUserSession(n.childSessionId));
  delegationFailureNoticeStore.drop(
    gone.map((n) => n.id),
    "child no longer active",
  );
  return pending.filter((n) => !gone.includes(n));
}

/* -------------------------------- wording -------------------------------- */

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function at(ms: number): string {
  return new Date(ms).toISOString();
}

/** One sentence per category: what happened, never the provider's words. */
export function failureSentence(
  category: DelegationFailureCategory,
  resetAt?: number,
): string {
  switch (category) {
    case "auth":
      return "The provider rejected its credentials (an expired or invalid sign-in).";
    case "usage_limit":
      return `Its account reached a usage, spend or billing limit.${
        resetAt !== undefined
          ? ` The provider reports the limit resets at ${at(resetAt)}.`
          : ""
      }`;
    case "rate_limit":
      return `The provider rate-limited it and the harness's retries ran out.${
        resetAt !== undefined
          ? ` The provider reports the limit resets at ${at(resetAt)}.`
          : ""
      }`;
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
