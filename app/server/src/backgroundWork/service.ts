/**
 * Admission: the single door background work enters through
 * ([Task-483](pa://task/483)).
 *
 * Everything happens BEFORE anything executes. A retry of a request identity
 * that already reserved something is answered first, from durable state alone;
 * otherwise the settings card is resolved once, eligibility is decided, and the
 * store reserves the item and — when the owner does not already hold one — the
 * owner slot, in ONE transaction. The last free slot is therefore decided by
 * the database: two admissions racing for it produce exactly one winner and
 * exactly one row.
 *
 * A denial creates NO row. That is the difference between this and the store's
 * degraded `observeItem` path, which exists for work already running that
 * nobody admitted.
 *
 * The values that governed an admission are frozen onto its row here and never
 * re-read: lowering the cap or shortening the lifetime governs later admissions
 * only, and never reaches back into work that is already running — which is
 * also why a retry is decided before any of those values is consulted.
 */
import type {
  BackgroundWorkBackend,
  BackgroundWorkKind,
} from "@assistant/shared";
import {
  BackgroundWorkCapacityError,
  BackgroundWorkOverCapEpochError,
  BackgroundWorkValidationError,
  backgroundWorkStore,
  type BackgroundWorkItem,
} from "../db/backgroundWorkStore.ts";
import { backgroundWorkBootEpoch } from "../backgroundWorkBoot.ts";
import { backgroundWorkOwnerEligibility } from "./policy.ts";
import { resolveBackgroundWorkSettings } from "./settings.ts";

/** What a caller asks to run, before anything about it exists. */
export interface BackgroundWorkAdmissionRequest {
  ownerSessionId: string;
  backend: BackgroundWorkBackend;
  kind: BackgroundWorkKind;
  /** Bounded human title (`title.ts`): description, else the command's first line. */
  label: string;
  /** The agent's own description of the job, when it gave one. */
  description?: string;
  /** The command line or monitor URL; the store cuts it at its cap. */
  command?: string;
  /** The caller's request identity; repeating it re-answers with the same row. */
  sourceRequestId: string;
  /**
   * The retained host epoch this work executes in. Required for `claude-query`
   * work and rejected for anything else — a Claude task means nothing outside
   * the query that issued it.
   */
  hostEpochKey?: string;
  /**
   * Degraded reconciliation for provider work first seen after it started.
   * It still enters through this admission door, but cannot be denied after the
   * side effect already happened. The store adopts capacity or records the
   * epoch over cap without evicting another owner.
   */
  observed?: boolean;
  /** Optional caller lifetime, clamped to the Settings lifetime and frozen once. */
  requestedLifetimeMs?: number;
  now?: number;
}

/**
 * Why an admission was refused. Bounded and enumerated so a caller can branch
 * on it — an agent-facing tool says something different for "the user turned
 * this off" than for "every slot is busy right now".
 */
export type BackgroundWorkDenialReason =
  | "disabled"
  | "draining"
  | "ineligible-owner"
  | "at-capacity"
  | "host-over-cap"
  | "invalid-request";

let admissionsOpen = true;

/** Close the admission door before deployment drain samples active work. */
export function closeBackgroundWorkAdmissions(): void {
  admissionsOpen = false;
}

/** Test seam. Production only closes admissions; the next process starts open. */
export function setBackgroundWorkAdmissionsOpenForTests(open: boolean): void {
  admissionsOpen = open;
}

/**
 * The values FROZEN on an admitted row — everything a backend needs to launch
 * it. Read back from the row and its host epoch, never from live settings, so
 * the same admission answers with the same numbers however often it is retried.
 *
 * Deliberately NOT the settings snapshot: `enabled` and the owner cap are
 * admission-time policy that nothing freezes, and handing them to a launch
 * would invite a backend to act on a value that never governed this work.
 */
export interface BackgroundWorkFrozenPolicy {
  lifetimeMs: number;
  deadlineAt: number;
  settingsGeneration: number;
  /** The retained host epoch's frozen grace; absent when the item has no host. */
  claudeEmptyHostGraceMs?: number;
}

export type BackgroundWorkAdmission =
  | {
      admitted: true;
      item: BackgroundWorkItem;
      /** The values frozen onto the row, for the backend that launches it. */
      frozen: BackgroundWorkFrozenPolicy;
      /**
       * True when this call reserved nothing: an earlier admission with the
       * same request identity already created the row being returned.
       */
      reused: boolean;
    }
  | {
      admitted: false;
      reason: BackgroundWorkDenialReason;
      /** One bounded sentence explaining the refusal. */
      message: string;
    };

function denied(
  reason: BackgroundWorkDenialReason,
  message: string,
): BackgroundWorkAdmission {
  return { admitted: false, reason, message };
}

function frozenLifetimeMs(
  requestedLifetimeMs: number | undefined,
  settingsLifetimeMs: number,
): number {
  if (requestedLifetimeMs === undefined) return settingsLifetimeMs;
  if (!Number.isSafeInteger(requestedLifetimeMs) || requestedLifetimeMs <= 0)
    throw new BackgroundWorkValidationError(
      "requestedLifetimeMs must be a positive safe integer",
    );
  return Math.min(requestedLifetimeMs, settingsLifetimeMs);
}

/** Recover an item's frozen policy from durable state alone. */
function frozenPolicyOf(item: BackgroundWorkItem): BackgroundWorkFrozenPolicy {
  const host = item.hostId
    ? backgroundWorkStore.getHost(item.hostId)
    : undefined;
  return {
    lifetimeMs: item.lifetimeMs,
    deadlineAt: item.deadlineAt,
    settingsGeneration: item.settingsGeneration,
    ...(host ? { claudeEmptyHostGraceMs: host.emptyGraceMs } : {}),
  };
}

/**
 * Admit one background work item, or say why not. Never throws for an ordinary
 * refusal: capacity, eligibility and a malformed request are all answers.
 */
export function admitBackgroundWork(
  request: BackgroundWorkAdmissionRequest,
): BackgroundWorkAdmission {
  // The WHOLE body sits inside the mapping, not just the reservation. The
  // store validates a malformed request wherever it first touches one — the
  // retry lookup below bounds the same request identity the insert would — so
  // a validation outside this catch is a THROW where the contract above
  // promises a bounded denial.
  try {
    // A RETRY is answered before any mutable policy is consulted. The store's
    // idempotency already returns the original row; judging that row against
    // today's settings would be the bug — the caller would be told "disabled"
    // about work that is still `pending-launch`, or handed the original row
    // carrying a generation and a grace that were never frozen on it. A retry
    // also never resurrects work that ended: whatever state the row reached,
    // it is the answer, and nothing new is reserved.
    const existing = backgroundWorkStore.getItemBySource(
      request.ownerSessionId,
      request.sourceRequestId,
    );
    if (existing)
      return {
        admitted: true,
        item: existing,
        frozen: frozenPolicyOf(existing),
        reused: true,
      };

    const settings = resolveBackgroundWorkSettings();
    const lifetimeMs = frozenLifetimeMs(
      request.requestedLifetimeMs,
      settings.taskLifetimeMs,
    );
    if (request.observed) {
      const item = backgroundWorkStore.observeItem({
        ownerSessionId: request.ownerSessionId,
        backend: request.backend,
        kind: request.kind,
        label: request.label,
        ...(request.description ? { description: request.description } : {}),
        ...(request.command ? { command: request.command } : {}),
        sourceRequestId: request.sourceRequestId,
        lifetimeMs,
        settingsGeneration: settings.generation,
        bootEpoch: backgroundWorkBootEpoch(),
        ownerLimit: settings.ownerSessionCap,
        ...(request.hostEpochKey !== undefined
          ? {
              host: {
                epochKey: request.hostEpochKey,
                emptyGraceMs: settings.claudeEmptyHostGraceMs,
              },
            }
          : {}),
        ...(request.now !== undefined
          ? { now: request.now, firstObservedAt: request.now }
          : {}),
      });
      return {
        admitted: true,
        item,
        frozen: frozenPolicyOf(item),
        reused: false,
      };
    }

    if (!admissionsOpen)
      return denied(
        "draining",
        "background work is not accepting new admissions while the server drains",
      );

    if (!settings.enabled)
      return denied(
        "disabled",
        "background processes are disabled in Settings → Background processes",
      );

    const eligibility = backgroundWorkOwnerEligibility(
      request.ownerSessionId,
      request.backend,
    );
    if (!eligibility.eligible)
      return denied("ineligible-owner", eligibility.reason);

    const item = backgroundWorkStore.reserveItem({
      ownerSessionId: request.ownerSessionId,
      backend: request.backend,
      kind: request.kind,
      label: request.label,
      ...(request.description ? { description: request.description } : {}),
      ...(request.command ? { command: request.command } : {}),
      sourceRequestId: request.sourceRequestId,
      // Frozen from THIS snapshot: the row's deadline is derived from it
      // inside the same transaction and is never recomputed from later
      // settings.
      lifetimeMs,
      settingsGeneration: settings.generation,
      bootEpoch: backgroundWorkBootEpoch(),
      // The store takes its limit from the caller; the cap lives in Settings,
      // not in the store.
      ownerLimit: settings.ownerSessionCap,
      ...(request.hostEpochKey !== undefined
        ? {
            host: {
              epochKey: request.hostEpochKey,
              emptyGraceMs: settings.claudeEmptyHostGraceMs,
            },
          }
        : {}),
      ...(request.now !== undefined ? { now: request.now } : {}),
    });
    // Read back from the row, not from `settings`: the store is what froze
    // them, and this is the same value a later retry will answer with.
    return {
      admitted: true,
      item,
      frozen: frozenPolicyOf(item),
      reused: false,
    };
  } catch (err) {
    // The over-cap epoch refusal is a capacity error too, so it is recognised
    // first: it means THIS epoch can never take admitted work, whatever
    // capacity is free now, and a caller that retried on a free slot would
    // loop.
    if (err instanceof BackgroundWorkOverCapEpochError)
      return denied("host-over-cap", err.message);
    if (err instanceof BackgroundWorkCapacityError)
      return denied("at-capacity", err.message);
    if (err instanceof BackgroundWorkValidationError)
      return denied("invalid-request", err.message);
    throw err;
  }
}
