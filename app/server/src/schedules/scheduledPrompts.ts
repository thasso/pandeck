/**
 * The `scheduled prompts` delivery of a claimed Schedule occurrence
 * (`docs/schedules.md`, "Delivering into an existing session" and "Admission
 * and crash safety").
 *
 * A pass walks the occurrences owed to one session, oldest due first, and
 * delivers at most one as a NEW turn. Each is sent from its frozen input with
 * the admission key `schedule:<occurrence id>`. The final synchronous check
 * (`admit`) asks the scheduler, marks the attempt (only while the occurrence
 * is still `claimed`, so a supersede, withdrawal or Stop that committed first
 * prevents the append) and unarchives the target, with no await before the
 * append.
 *
 * Only typed hold evidence keeps an occurrence `claimed`: the scheduler's own
 * refusal, a running turn (`SessionBusyError`) and a Stop or a pending runtime
 * selection that cannot apply (`AutomaticTurnsHeldError`). Anything else that
 * ends without an append is terminal, so later owed work is never stranded.
 *
 * Whether an attempted occurrence reached the session is read from evidence,
 * never from how the prompt resolved: first this process's own record of the
 * append, then the parsed canonical transcript. The same resolver serves the
 * lane, boot recovery and the store's admission-aware ends, and is registered
 * when this module loads.
 */
import { formatScheduleDue } from "@assistant/shared/schedules";
import {
  scheduleStore,
  type ScheduleAdmissionEvidence,
  type ScheduleOccurrenceRecord,
} from "../db/scheduleStore.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { errorText } from "../errors.ts";
import { findAdmittedUserEntry } from "../session/log/admittedUserEntry.ts";
import { SessionBusyError } from "../session/runtime/errors.ts";
import {
  promptRuntimeSession,
  type RuntimePromptDriver,
} from "../session/runtimePrompt.ts";

/** D10: the target's transcript could not be read, so admission is unknown. */
const DELIVERY_UNCERTAIN =
  "delivery uncertain: the target session's transcript could not be read";
/** D10a: the runtime returned with no append and no hold to explain it. */
const DELIVERY_NOT_ADMITTED =
  "delivery failed: the target runtime returned without admitting the scheduled prompt";
/** D10: a concrete failure reason is clipped to this many characters. */
const REASON_LIMIT = 500;

/**
 * The model-only header line a delivered occurrence's prompt follows, from its
 * frozen input: the name as one line, the due time in the frozen zone.
 * `⏰ Scheduled prompt "PR CI check" · schedule \`sch_12\` · due Wed 25 Nov 15:45 Europe/Berlin`.
 * It travels as the turn's context block, never in the durable prompt text.
 */
export function scheduledPromptHeader(
  occurrence: Pick<
    ScheduleOccurrenceRecord,
    "scheduleId" | "name" | "dueAtMs" | "timeZone"
  >,
): string {
  const name = occurrence.name.replace(/\s+/g, " ").trim();
  const due = formatScheduleDue(occurrence.dueAtMs, occurrence.timeZone);
  return `⏰ Scheduled prompt "${name}" · schedule \`${occurrence.scheduleId}\` · due ${due} ${occurrence.timeZone}`;
}

/** The admission key: the `clientRequestId` of the occurrence's append. */
export function scheduledPromptKey(occurrenceId: string): string {
  return `schedule:${occurrenceId}`;
}

/**
 * Occurrences this process saw appended whose row may still read `claimed`:
 * written first in the append observer, before any store call, and dropped
 * only once the row is read terminal outside any transaction. The resolver
 * only reads it, so evidence survives a rolled-back end. Lost on restart,
 * where the canonical log decides.
 */
const appendedInProcess = new Set<string>();

/** Test seam: forget this process's append records, as a restart does. */
export function forgetScheduledAppendsForTests(): void {
  appendedInProcess.clear();
}

/** Test seam: whether this process still holds an append record. */
export function scheduledAppendRecordedForTests(occurrenceId: string): boolean {
  return appendedInProcess.has(occurrenceId);
}

/**
 * What a target's transcript says about an occurrence's admission key.
 * Synchronous, read-only and total: it never writes, never awaits and never
 * throws, so a store transaction may call it.
 */
export function resolveScheduledAdmission(
  occurrence: ScheduleOccurrenceRecord,
): ScheduleAdmissionEvidence {
  const sessionId = occurrence.target.sessionId;
  try {
    if (appendedInProcess.has(occurrence.id))
      return { kind: "present", sessionId };
    const found = findAdmittedUserEntry(
      sessionId,
      scheduledPromptKey(occurrence.id),
    );
    if (found === "present") return { kind: "present", sessionId };
    if (found === "absent") return { kind: "absent" };
  } catch {
    // An unreadable transcript is unknown, the same as an unreadable file.
  }
  return { kind: "unknown", error: DELIVERY_UNCERTAIN };
}

scheduleStore.setAdmissionResolver(resolveScheduledAdmission);

/** `shouldStart` refused at the final check: the scheduler's own hold. */
class ScheduledPromptHeldError extends Error {
  constructor() {
    super("The scheduled prompt's target cannot start a turn now");
    this.name = "ScheduledPromptHeldError";
  }
}

/** The occurrence ended or vanished before its attempt could be marked. */
class ScheduledPromptClaimLostError extends Error {
  constructor() {
    super("The scheduled occurrence is no longer claimed");
    this.name = "ScheduledPromptClaimLostError";
  }
}

/** Marking the attempt failed: our own write, so the occurrence stays owed. */
class ScheduledPromptStoreError extends Error {
  constructor(override readonly cause: unknown) {
    super(errorText(cause));
    this.name = "ScheduledPromptStoreError";
  }
}

/** Unarchiving the target failed after the attempt was marked: no append. */
class ScheduledPromptRestoreError extends Error {
  constructor(override readonly cause: unknown) {
    super(errorText(cause));
    this.name = "ScheduledPromptRestoreError";
  }
}

/**
 * How one occurrence's turn went, for the walk: `appended` ends the pass
 * with the turn, `terminal` moves on, `hold` and `storeFailure` end the pass
 * with the occurrence still owed and no self-wake.
 */
type ScheduledStep = "appended" | "terminal" | "hold" | "storeFailure";

function boundedReason(err: unknown): string {
  return [...errorText(err)].slice(0, REASON_LIMIT).join("");
}

function warn(what: string, err: unknown): void {
  console.warn(`[schedules] ${what}: ${boundedReason(err)}`);
}

/** Drop the append record of an occurrence read terminal (or gone) now. */
function forgetIfEnded(occurrenceId: string): void {
  if (!appendedInProcess.has(occurrenceId)) return;
  try {
    if (scheduleStore.getOccurrence(occurrenceId)?.state !== "claimed")
      appendedInProcess.delete(occurrenceId);
  } catch (err) {
    warn(`reading ${occurrenceId} back failed`, err);
  }
}

/** Settle a still-claimed occurrence; a row already ended stays as it is. */
function settle(
  occurrence: ScheduleOccurrenceRecord,
  state: "delivered" | "failed",
  details: { sessionId?: string; error?: string },
): "terminal" | "storeFailure" {
  try {
    scheduleStore.settleOccurrence(occurrence.id, state, details);
  } catch (err) {
    warn(`settling ${occurrence.id} ${state} failed`, err);
    return "storeFailure";
  }
  forgetIfEnded(occurrence.id);
  return "terminal";
}

/** Settle from evidence; `absent` is the caller's to decide. */
function settleFromEvidence(
  occurrence: ScheduleOccurrenceRecord,
  evidence: ScheduleAdmissionEvidence,
): "terminal" | "storeFailure" | undefined {
  if (evidence.kind === "present")
    return settle(occurrence, "delivered", { sessionId: evidence.sessionId });
  if (evidence.kind === "unknown")
    return settle(occurrence, "failed", { error: evidence.error });
  return undefined;
}

/**
 * Unarchive and unsettle the target strictly, after the attempt was marked.
 * True when that wrote, including a write whose post-commit hand-off threw:
 * the durable flags, read back, tell it from a rollback.
 */
function restoreTarget(sessionId: string): boolean {
  try {
    return sessionStore.restoreForScheduledDelivery(sessionId);
  } catch (err) {
    let flags: ReturnType<typeof sessionStore.archiveFlags>;
    try {
      flags = sessionStore.archiveFlags(sessionId);
    } catch {
      flags = undefined;
    }
    if (flags && flags.archivedAtMs === null && flags.settledAtMs === null)
      return true;
    throw new ScheduledPromptRestoreError(err);
  }
}

async function deliverOne(
  driver: RuntimePromptDriver,
  occurrence: ScheduleOccurrenceRecord,
  shouldStart: () => boolean,
): Promise<ScheduledStep> {
  const sessionId = driver.sessionId;
  // Tried before (a crash, or bookkeeping that failed): the transcript says
  // whether it is already there. Absent means it is safe to send again.
  if (occurrence.attemptedAtMs !== undefined) {
    const prior = settleFromEvidence(
      occurrence,
      resolveScheduledAdmission(occurrence),
    );
    if (prior) return prior;
  }
  let attemptMarked = false;
  let restored = false;
  let appended = false;
  let observerSettled = false;
  let thrown: unknown;
  let threw = false;
  try {
    const receipt = promptRuntimeSession(driver, occurrence.prompt, {
      origin: {
        kind: "schedule",
        scheduleId: occurrence.scheduleId,
        occurrenceId: occurrence.id,
        dueAtMs: occurrence.dueAtMs,
      },
      clientRequestId: scheduledPromptKey(occurrence.id),
      contextBlock: scheduledPromptHeader(occurrence),
      // The last synchronous check: nothing awaits between it and the append.
      admit: () => {
        if (!shouldStart()) throw new ScheduledPromptHeldError();
        attemptMarked = true;
        let marked: boolean;
        try {
          marked = scheduleStore.markAttempted(occurrence.id);
        } catch (err) {
          throw new ScheduledPromptStoreError(err);
        }
        if (!marked) throw new ScheduledPromptClaimLostError();
        restored = restoreTarget(sessionId);
      },
    });
    // Never throws into the runtime's emission: the fact first, then the
    // store, whose failure the reconcile below and every later end resolve.
    receipt.observe((event) => {
      if (event.type !== "appended") return;
      appended = true;
      appendedInProcess.add(occurrence.id);
      try {
        observerSettled = scheduleStore.settleOccurrence(
          occurrence.id,
          "delivered",
          { sessionId },
        );
      } catch {
        // Isolated: the row stays claimed and attempted, resolved below.
      }
    });
    await receipt;
  } catch (err) {
    threw = true;
    thrown = err;
  }
  if (restored)
    try {
      // Loaded on use, as `sessionPendingRuntime.ts` does: the topic registry
      // pulls in every published domain, which this lane does not need.
      const { publishSessionRowsNow } = await import("../stateTopics.ts");
      publishSessionRowsNow();
    } catch (err) {
      warn(`publishing ${sessionId} after unarchiving it failed`, err);
    }
  if (appended) {
    reconcileAppended(occurrence, sessionId, observerSettled);
    return "appended";
  }
  if (thrown instanceof ScheduledPromptHeldError) return "hold";
  if (thrown instanceof ScheduledPromptClaimLostError) return "terminal";
  if (thrown instanceof ScheduledPromptStoreError) {
    warn(`marking ${occurrence.id} attempted failed`, thrown.cause);
    return "storeFailure";
  }
  if (thrown instanceof ScheduledPromptRestoreError) {
    // Known not appended, but a session-row write failed: stop the walk.
    settle(occurrence, "failed", { error: boundedReason(thrown.cause) });
    return "storeFailure";
  }
  if (attemptMarked) {
    // Offered with no append observed: the transcript decides, never the
    // prompt's resolution or a duplicate answer.
    const known = settleFromEvidence(
      occurrence,
      resolveScheduledAdmission(occurrence),
    );
    if (known) return known;
  }
  // Refused before the final check, or known not appended after it. Only a
  // typed busy or Stop refusal is a hold; nothing was appended, so a later
  // retry is safe.
  if (threw && thrown instanceof SessionBusyError) return "hold";
  return settle(occurrence, "failed", {
    error: threw ? boundedReason(thrown) : DELIVERY_NOT_ADMITTED,
  });
}

/**
 * After the receipt: an append whose `delivered` settle did not commit is
 * settled once more while the row is still claimed. A row already terminal
 * was resolved from evidence by a store end. The record is dropped once the
 * row reads terminal, and kept while it does not.
 */
function reconcileAppended(
  occurrence: ScheduleOccurrenceRecord,
  sessionId: string,
  observerSettled: boolean,
): void {
  if (!observerSettled)
    try {
      if (scheduleStore.getOccurrence(occurrence.id)?.state === "claimed")
        scheduleStore.settleOccurrence(occurrence.id, "delivered", {
          sessionId,
        });
    } catch (err) {
      warn(`delivered settle failed for ${occurrence.id}`, err);
    }
  forgetIfEnded(occurrence.id);
}

/**
 * The lane's drain: the occurrences owed to this session, oldest due first,
 * until one is appended, a typed hold or a store failure ends the pass, or
 * the snapshot runs out. Items that end without an append are passed over, so
 * the walk always makes progress and never spins.
 */
export async function deliverScheduledPrompts(
  driver: RuntimePromptDriver,
  shouldStart: () => boolean,
): Promise<void> {
  for (const owed of scheduleStore.owedForTarget(driver.sessionId)) {
    const occurrence = scheduleStore.getOccurrence(owed.id);
    if (occurrence?.state !== "claimed") {
      forgetIfEnded(owed.id);
      continue;
    }
    if (!shouldStart()) return;
    if ((await deliverOne(driver, occurrence, shouldStart)) !== "terminal")
      return;
  }
}

/**
 * Boot: settle each attempted `claimed` occurrence from its target's
 * transcript (present → `delivered`, unreadable → `failed`, absent → still
 * owed), then offer delivery to every target still owed. A settle that fails
 * is logged and left `claimed`, where the next pass or any store end resolves
 * it from the same evidence.
 */
export function recoverScheduledPromptsOnBoot(
  offer: (sessionId: string) => void,
): void {
  for (const occurrence of scheduleStore.claimedOccurrences()) {
    if (occurrence.attemptedAtMs === undefined) continue;
    settleFromEvidence(occurrence, resolveScheduledAdmission(occurrence));
  }
  const targets = new Set(
    scheduleStore
      .claimedOccurrences()
      .map((occurrence) => occurrence.target.sessionId),
  );
  for (const target of targets) offer(target);
}
