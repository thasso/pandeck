/**
 * Adaptive observation scheduling + automatic maintenance (Task 91). Populates
 * and cleans memory automatically WITHOUT a processor call after every ordinary
 * turn. Task 96 owns pre-prompt selection/delivery; this module owns post-turn
 * observation, keyed off the SAME accepted user-turn id.
 *
 * Modes: `off` (no processor calls, no retained observation text), `adaptive`
 * (immediate for high-signal turns, otherwise batched on a turn threshold / idle
 * period / before rotation-compaction) and `every-turn` (one bounded run per
 * eligible exchange, still under the global ceilings).
 *
 * Only Personal Assistant and ordinary Assistant turns are capture-eligible in
 * v1; Developer/Workshop ordinary turns enqueue nothing (explicit authorized
 * `memory_manage` remains independent). All processing goes through the bounded
 * processor, so the global call/cost ceilings cover every trigger and mode.
 */
import type { SessionAgentType } from "@assistant/shared";
import { looksSecretLike } from "@assistant/shared";
import { getSettings } from "../settings.ts";
import { userTimeZone } from "../userProfile.ts";
import { memoryObservationStore } from "../db/memoryObservationStore.ts";
import { memoryOperationStore } from "../db/memoryOperationStore.ts";
import { resolveSessionProject } from "../sessionProjectContext.ts";
import { expireDueMemories, onMemoryChange } from "./memoryService.ts";
import { runConsolidation, runMemoryProcessor } from "./memoryProcessor.ts";

/* -------------------------------- config --------------------------------- */

const FLUSH_TURN_THRESHOLD = 5;
const IDLE_FLUSH_MS = 10 * 60_000;
const BATCH_SIZE = 20;
const CONSOLIDATION_MUTATION_THRESHOLD = 25;
const STALE_CLAIM_MS = 10 * 60_000;
const OBSERVATION_TEXT_CAP = 4_000;
/** Durable queue bounds (count + age + chars) so unprocessed observations cannot grow without limit. */
const MAX_PENDING = 500;
const MAX_PENDING_AGE_MS = 7 * 86_400_000;
const MAX_PENDING_CHARS = 1_000_000;
/** Operation-idempotency ledger retention — far beyond any realistic retry window. */
const OPERATION_LEDGER_RETENTION_MS = 30 * 86_400_000;

let clock: () => number = () => Date.now();
export function setMemorySchedulerClockForTests(now: () => number): void {
  clock = now;
}

/** Personas whose ordinary turns are captured automatically in v1. */
function isCaptureEligiblePersona(
  persona: SessionAgentType | undefined,
): boolean {
  return persona === "assistant" || persona === "personal-assistant";
}

/* --------------------------- high-signal detect -------------------------- */

const HIGH_SIGNAL_PATTERNS: RegExp[] = [
  /\b(remember|note that|keep in mind|don'?t forget|for future reference)\b/i,
  /\b(forget|no longer|stop (?:remembering|tracking)|disregard)\b/i,
  /\b(actually|correction|i was wrong|that'?s wrong|instead of|not .* but)\b/i,
  /\b(i (?:prefer|like|want|always|never|hate|use)|please always|please never|from now on)\b/i,
  /\b(must|must not|should not|never|do not|always)\b/i, // constraints
  /\b(today|tomorrow|tonight|yesterday|next (?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (?:week|weekend)|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|by \w+day|until|deadline|due)\b/i,
  /\b(we (?:decided|agreed)|the plan is|going with|standardize on|convention)\b/i,
];

/** Deterministic high-signal detection — a TRIGGER, not a rule to blindly store. */
function detectHighSignal(text: string): boolean {
  return HIGH_SIGNAL_PATTERNS.some((re) => re.test(text));
}

/* ------------------------------- scheduler ------------------------------- */

interface ObserveTurnInput {
  sessionId: string;
  userTurnId: string;
  persona: SessionAgentType;
  humanText: string;
  assistantText?: string;
  /**
   * Durable source timestamp of the exchange (channel-event time, not processor
   * time). Defaults to the scheduler clock for web/app turns.
   */
  sourceTimestampMs?: number;
  /**
   * IANA timezone snapshot used to interpret relative dates. Pass a trusted
   * source-channel timezone only when it is explicitly recorded at ingestion;
   * otherwise the app Memory timezone setting is snapshotted.
   */
  timezone?: string;
}

class MemoryScheduler {
  private readonly inFlight = new Set<string>();
  private readonly reflush = new Set<string>();
  private mutationsSinceConsolidation = 0;
  private lastConsolidationAt = 0;

  constructor() {
    // Count applied mutations to drive the consolidation cadence.
    onMemoryChange((event) => {
      if (event.change === "expired") return; // expiry is deterministic, not a learned mutation
      this.mutationsSinceConsolidation += 1;
    });
  }

  /**
   * Record a completed top-level human exchange. Enqueues a bounded observation
   * only when learning is enabled AND the persona is capture-eligible, then
   * processes immediately (high-signal / every-turn) or batches (adaptive).
   * Never throws — a scheduling failure must not affect the user response.
   */
  observeTurn(input: ObserveTurnInput): void {
    try {
      const settings = getSettings().memory;
      if (settings.learningMode === "off") return;
      if (!isCaptureEligiblePersona(input.persona)) return;
      const humanText = input.humanText.trim();
      if (!humanText) return;
      // The observation buffer must never retain secret/credential-like bodies.
      // A secret-like human turn is not captured at all; secret-like assistant
      // context is dropped rather than stored.
      if (looksSecretLike(humanText)) return;
      const assistantText =
        input.assistantText && !looksSecretLike(input.assistantText)
          ? input.assistantText
          : undefined;

      const highSignal = detectHighSignal(humanText);
      // Shared resolver so a Task-derived project (not just a standalone
      // session→project link) scopes the observation (Task 94).
      const projectId = resolveSessionProject(input.sessionId);
      memoryObservationStore.enqueue({
        sessionId: input.sessionId,
        userTurnId: input.userTurnId,
        persona: input.persona,
        ...(projectId ? { projectId } : {}),
        humanText: humanText.slice(0, OBSERVATION_TEXT_CAP),
        ...(assistantText
          ? { assistantText: assistantText.slice(0, OBSERVATION_TEXT_CAP) }
          : {}),
        // Never reinterpret an old observation with a later settings value: the
        // timezone is snapshotted here, at ingestion.
        sourceTimestampMs: input.sourceTimestampMs ?? clock(),
        timezone: input.timezone ?? userTimeZone(),
        highSignal,
        createdAt: clock(),
      });

      if (settings.learningMode === "every-turn") {
        void this.flushSession(input.sessionId, "every-turn");
      } else if (highSignal) {
        void this.flushSession(input.sessionId, "high-signal");
      } else if (
        memoryObservationStore.pendingCountForSession(input.sessionId) >=
        FLUSH_TURN_THRESHOLD
      ) {
        // Per-session threshold: a busy session cannot trigger (or starve) others.
        void this.flushSession(input.sessionId, "batch");
      }
    } catch {
      // scheduling is best-effort.
    }
  }

  /**
   * Claim and process this session's pending observations through the bounded
   * processor. Single-flight per session: a concurrent trigger coalesces into
   * one re-flush after the in-flight run completes.
   */
  async flushSession(sessionId: string, trigger: string): Promise<void> {
    if (this.inFlight.has(sessionId)) {
      this.reflush.add(sessionId);
      return;
    }
    this.inFlight.add(sessionId);
    try {
      const pending = memoryObservationStore.pendingForSession(
        sessionId,
        BATCH_SIZE,
      );
      if (pending.length === 0) return;
      const claimed = memoryObservationStore.claim(
        pending.map((o) => o.id),
        clock(),
      );
      if (claimed.length === 0) return;
      await runMemoryProcessor(claimed, { trigger });
    } catch {
      // the processor never throws; guard anyway.
    } finally {
      this.inFlight.delete(sessionId);
      if (this.reflush.delete(sessionId))
        void this.flushSession(sessionId, trigger);
    }
  }

  /**
   * Idle flush: process pending observations for sessions whose most recent
   * pending observation is older than the idle period. Deterministic — call it
   * from a periodic timer (production) or directly (tests).
   */
  async flushIdle(nowMs = clock()): Promise<void> {
    const settings = getSettings().memory;
    if (settings.learningMode === "off") return;
    const pending = memoryObservationStore.pending(500);
    const bySession = new Map<string, number>(); // session → newest pending createdAt
    for (const o of pending)
      bySession.set(
        o.sessionId,
        Math.max(bySession.get(o.sessionId) ?? 0, o.createdAt),
      );
    for (const [sessionId, newest] of bySession) {
      if (nowMs - newest >= IDLE_FLUSH_MS)
        await this.flushSession(sessionId, "idle");
    }
  }

  /** Flush a session's pending work before permanent-singleton rotation or compaction. */
  async flushBeforeReset(sessionId: string): Promise<void> {
    await this.flushSession(sessionId, "rotation");
  }

  /** Recover observations left `processing` by a crash so a restart can resume them. */
  recover(nowMs = clock()): number {
    return memoryObservationStore.recoverStale(nowMs - STALE_CLAIM_MS);
  }

  /**
   * Deterministic maintenance: always run model-free expiry; run model
   * consolidation cadence only after a mutation threshold or a daily idle, and
   * only when maintenance is enabled. Expiry works regardless of the processor
   * being disabled or budget-capped.
   */
  runMaintenance(nowMs = clock()): {
    expired: number;
    consolidationDue: boolean;
    pruned: number;
  } {
    // Bound the durable observation queue + idempotency ledger regardless of the
    // maintenance toggle.
    const pruned = memoryObservationStore.prunePending(
      nowMs,
      MAX_PENDING,
      MAX_PENDING_AGE_MS,
      MAX_PENDING_CHARS,
    );
    memoryOperationStore.prune(nowMs - OPERATION_LEDGER_RETENTION_MS);
    const settings = getSettings().memory;
    if (!settings.maintenanceEnabled)
      return { expired: 0, consolidationDue: false, pruned };
    const expired = expireDueMemories(nowMs).length;
    const dailyIdle = nowMs - this.lastConsolidationAt >= 86_400_000;
    const consolidationDue =
      this.mutationsSinceConsolidation >= CONSOLIDATION_MUTATION_THRESHOLD ||
      dailyIdle;
    // Trigger the async model consolidation pass; the cadence counters are reset
    // only when it actually runs (NOT when budget-blocked), so a blocked pass stays
    // due and retries on the next maintenance tick.
    if (consolidationDue) void this.runConsolidation(nowMs);
    return { expired, consolidationDue, pruned };
  }

  /** Model consolidation over existing memories, single-flight, via the bounded processor. */
  private consolidating = false;
  async runConsolidation(nowMs = clock()): Promise<void> {
    if (this.consolidating) return;
    this.consolidating = true;
    try {
      const outcome = await runConsolidation();
      // Reset cadence only on a SUCCESSFUL completed pass (ran with no failure
      // reason) or when there was nothing to consolidate. Budget/error/parse-error
      // outcomes retain the due state so it retries on the next tick.
      const succeeded = outcome.ran && outcome.reason === undefined;
      if (succeeded || outcome.reason === "no-input") {
        this.mutationsSinceConsolidation = 0;
        this.lastConsolidationAt = nowMs;
      }
    } catch {
      // consolidation never affects a user response; leave due state to retry.
    } finally {
      this.consolidating = false;
    }
  }

  /** Test helper: how many applied mutations since the last consolidation. */
  mutationCountForTests(): number {
    return this.mutationsSinceConsolidation;
  }
}

export const memoryScheduler = new MemoryScheduler();

let maintenanceTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Boot the periodic maintenance loop: recover crash-claimed observations once,
 * then on a modest cadence flush idle batches and run deterministic expiry (the
 * processor's own ceilings still gate any model call). Idempotent.
 */
export function startMemoryMaintenance(): void {
  if (maintenanceTimer) return;
  try {
    memoryScheduler.recover();
  } catch {
    // best-effort at boot.
  }
  maintenanceTimer = setInterval(() => {
    void memoryScheduler.flushIdle();
    memoryScheduler.runMaintenance();
  }, 60_000);
  // Do not keep the process alive solely for memory maintenance.
  maintenanceTimer.unref?.();
}

export function stopMemoryMaintenance(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = undefined;
  }
}
