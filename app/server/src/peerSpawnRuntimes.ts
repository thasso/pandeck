/**
 * The approved peer-runtime roster ([Task-595](pa://task/595)): the server side
 * of the small set of model/thinking options and account policies a human
 * pre-approved for agents to start ordinary peer sessions on.
 *
 * It answers three questions and nothing else:
 *
 * - what the roster currently looks like, with each row's real availability,
 *   inferred family, and user-owned cost/selection guidance (`peerRuntimeRoster`);
 * - whether ONE named row can run RIGHT NOW, exactly as approved
 *   (`resolveApprovedPeerRuntime`) — model and thinking never substitute; an
 *   account is routed only when the human approved Automatic, never for a pin;
 * - whether a coordinator's next direct peer turns start now or wait for a slot
 *   (`admitDirectPeerTurns`), a per-session cap excluding user-marked low-cost turns.
 *
 * What this roster starts is an ordinary `scope = "user"` session.
 */
import type {
  AccountModelOption,
  ModelOption,
  PeerRuntimeFamily,
  PeerRuntimeRelativeCost,
  PeerSpawnRuntime,
  StoredThinkingLevel,
  ThinkingLevel,
} from "@assistant/shared";
import {
  DEFAULT_SESSION_PEER_TURN_CAP,
  isThinkingLevel,
  peerRuntimeDisplayName,
  peerRuntimeFamilyOf,
  peerRuntimeUnavailableReason,
  supportedThinkingLevelsForModel,
} from "@assistant/shared";
import {
  credentialProfileById,
  listCredentialProfiles,
} from "./credentialProfiles.ts";
import { pickAccount } from "./accountRouter.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { touchSessionRows } from "./db/sessionListChanges.ts";
import {
  directPeerChildStore,
  type DirectPeerChild,
} from "./db/directPeerChildStore.ts";
import { modelsForAccount } from "./harnesses/models.ts";
import { getSettings } from "./settings.ts";
import { runtimeStateReader } from "./tools/sessions/sessionInspection.ts";

/**
 * How many counted peer turns one coordinator may have RUNNING at once through
 * the direct path. User-marked low-cost runtimes are exempt, with no bound.
 */
export function directPeerTurnCapOf(sessionId: string): number {
  return (
    sessionStore.get(sessionId)?.peerTurnCap ?? DEFAULT_SESSION_PEER_TURN_CAP
  );
}

/**
 * User/approval-only domain writer, never an agent tool. Validation and persistence
 * do not yield: approval executors can compare and set in one synchronous step.
 * The caller owns session-list notification, so this writer never loads the hub.
 *
 * A raised cap applies at once: the coordinator's waiting children start, in
 * order, through the ordinary start pass — scheduled here through
 * {@link setPeerTurnCapChangedHook}, never awaited. A lowered one stops
 * nothing; it only gates the next starts.
 */
export function setSessionPeerTurnCap(
  sessionId: string,
  cap: number | null,
): void {
  sessionStore.setPeerTurnCap(sessionId, cap);
  capChanged?.(sessionId);
}

let capChanged: ((sessionId: string) => void) | undefined;

/**
 * What a successful cap write schedules: the held-start pass
 * (`heldDirectPeers.ts`), installed at boot. A hook rather than an import,
 * since that module admits through this one. Synchronous; it must not await.
 */
export function setPeerTurnCapChangedHook(
  hook: ((sessionId: string) => void) | undefined,
): void {
  capChanged = hook;
}

/** Every model one account can actually run, mirroring the settings projection. */
export async function modelsForProfile(
  profileId: string,
): Promise<ModelOption[]> {
  const profile = credentialProfileById(profileId);
  if (!profile) return [];
  return modelsForAccount(profile).catch(() => []);
}

/**
 * The account/model combinations that exist right now, including those of a
 * DISABLED account: a roster row pinned to one must read as "that account is
 * disabled" rather than as "that model is gone".
 */
export async function accountModelOptions(): Promise<AccountModelOption[]> {
  const out: AccountModelOption[] = [];
  for (const profile of listCredentialProfiles()) {
    for (const model of await modelsForProfile(profile.id))
      out.push({
        ...model,
        credentialProfileId: profile.id,
        accountName: profile.name,
        ...(profile.enabled ? {} : { accountDisabled: true }),
      });
  }
  return out;
}

/** One roster row as an agent or the Settings surface reads it. */
export interface PeerRuntimeRosterEntry {
  profileId: string;
  name: string;
  family: PeerRuntimeFamily;
  relativeCost: PeerRuntimeRelativeCost;
  /** User-authored selection hint, when one was provided. */
  description?: string;
  provider: string;
  modelId: string;
  modelName?: string;
  /** As STORED: an unrecognized level is reported, never repaired away. */
  thinkingLevel: StoredThinkingLevel;
  accountName?: string;
  /** Usable for a spawn right now: enabled AND runnable exactly as approved. */
  available: boolean;
  /** Why not, when it is not. Present for a disabled row too. */
  unavailableReason?: string;
}

/**
 * The current roster in the user's order, bounded by the settings normalizer.
 * Unavailable rows are INCLUDED with their reason: hiding a broken row would
 * make a coordinator guess why the option it was told about vanished.
 */
export async function peerRuntimeRoster(): Promise<PeerRuntimeRosterEntry[]> {
  const rows = getSettings().peerSpawnRuntimes;
  if (rows.length === 0) return [];
  const options = await accountModelOptions();
  return rows.map((row) => rosterEntry(row, options));
}

/** One safe model-facing line from the user-authored selection hint. */
function selectionDescriptionOf(
  row: Pick<PeerSpawnRuntime, "description">,
): string | undefined {
  const description = row.description?.trim().replace(/\s+/g, " ");
  return description || undefined;
}

function rosterEntry(
  row: PeerSpawnRuntime,
  options: readonly AccountModelOption[],
): PeerRuntimeRosterEntry {
  const model = options.find(
    (option) =>
      (row.credentialProfileId
        ? option.credentialProfileId === row.credentialProfileId
        : !option.accountDisabled) &&
      option.provider === row.provider &&
      option.id === row.modelId,
  );
  const reason = row.enabled
    ? peerRuntimeUnavailableReason(row, options)
    : "Disabled in Settings.";
  const description = selectionDescriptionOf(row);
  return {
    profileId: row.id,
    name: peerRuntimeDisplayName(row),
    provider: row.provider,
    modelId: row.modelId,
    ...(model?.name ? { modelName: model.name } : {}),
    thinkingLevel: row.thinkingLevel,
    ...(!row.credentialProfileId
      ? { accountName: "Automatic" }
      : model?.accountName
        ? { accountName: model.accountName }
        : {}),
    available: !reason,
    ...(reason ? { unavailableReason: reason } : {}),
    family: peerRuntimeFamilyOf(row.provider, row.modelId),
    relativeCost: row.relativeCost,
    ...(description ? { description } : {}),
  };
}

/** A named runtime that cannot be used as approved. Never falls back. */
export class PeerRuntimeRefusedError extends Error {}

/** One approved row, proven runnable exactly as the human approved it. */
export interface ApprovedPeerRuntime {
  profileId: string;
  name: string;
  provider: string;
  modelId: string;
  modelName?: string;
  credentialProfileId: string;
  accountName?: string;
  thinkingLevel: ThinkingLevel;
  family: PeerRuntimeFamily;
  relativeCost: PeerRuntimeRelativeCost;
  description?: string;
}

/**
 * Resolve one roster id immediately before it is used.
 *
 * Every failure THROWS {@link PeerRuntimeRefusedError} rather than degrading:
 * an unknown id (a typo, or a row the user deleted) must not quietly become an
 * approval card either, or a mistyped id would silently widen what an agent may
 * ask for. The check is exact: this model and thinking level, on the pinned
 * account or one picked by Automatic. It runs per row at spawn time, because
 * Settings edits take effect on the next start and a roster read may be minutes old.
 */
export async function resolveApprovedPeerRuntime(
  profileId: string,
  options: { requiresEnterprise?: boolean } = {},
): Promise<ApprovedPeerRuntime> {
  const wanted = profileId.trim();
  // Discover account/model availability first, then take the roster snapshot.
  // Discovery awaits provider state, so reading Settings before it would let a
  // user edit during that await authorize the runtime from the stale row.
  let modelOptions = await accountModelOptions();
  const rows = getSettings().peerSpawnRuntimes;
  const row = rows.find((candidate) => candidate.id === wanted);
  if (!row)
    throw new PeerRuntimeRefusedError(
      rows.length === 0
        ? `profileId "${wanted}" is not an approved peer runtime: the user has approved none. Use operation "propose" so they can approve this batch.`
        : `profileId "${wanted}" is not an approved peer runtime. Call operation "profiles" for the current roster, or "propose" to ask the user.`,
    );
  if (!row.enabled)
    throw new PeerRuntimeRefusedError(
      `Approved runtime "${peerRuntimeDisplayName(row)}" is disabled in Settings.`,
    );
  const reason = peerRuntimeUnavailableReason(row, modelOptions);
  if (reason)
    throw new PeerRuntimeRefusedError(
      `Approved runtime "${peerRuntimeDisplayName(row)}" cannot run right now: ${reason}`,
    );
  let credentialProfileId = row.credentialProfileId;
  if (!credentialProfileId) {
    // The model/effort are authorization, not suggestions for the router.
    if (!isThinkingLevel(row.thinkingLevel))
      throw new PeerRuntimeRefusedError(
        "The approved thinking level is invalid.",
      );
    const picked = await pickAccount({
      model: { provider: row.provider, modelId: row.modelId },
      thinkingLevel: row.thinkingLevel,
      requiresEnterprise: options.requiresEnterprise === true,
    });
    if (!picked.profileId)
      throw new PeerRuntimeRefusedError(
        options.requiresEnterprise
          ? "This session requires an enterprise account, but no enabled enterprise account is available for this peer runtime."
          : "No enabled account is available for this peer runtime.",
      );
    credentialProfileId = picked.profileId;
    const models = await modelsForProfile(credentialProfileId);
    const profile = credentialProfileById(credentialProfileId);
    modelOptions = profile
      ? models.map((model) => ({
          ...model,
          credentialProfileId: profile.id,
          accountName: profile.name,
          ...(profile.enabled ? {} : { accountDisabled: true }),
        }))
      : [];
    // Routing and discovery await provider state. An approval revoked or edited
    // during either await must not authorize a session from the stale row.
    const current = getSettings().peerSpawnRuntimes.find(
      (candidate) => candidate.id === wanted,
    );
    if (JSON.stringify(current) !== JSON.stringify(row))
      throw new PeerRuntimeRefusedError(
        "The approved peer runtime changed while selecting its account. Read the current roster and try again.",
      );
    const pickedReason = peerRuntimeUnavailableReason(
      { ...row, credentialProfileId },
      modelOptions,
    );
    if (pickedReason)
      throw new PeerRuntimeRefusedError(
        `Approved runtime "${peerRuntimeDisplayName(row)}" cannot run right now: ${pickedReason}`,
      );
  }
  const model = modelOptions.find(
    (option) =>
      option.credentialProfileId === credentialProfileId &&
      option.provider === row.provider &&
      option.id === row.modelId,
  );
  // Availability already proved all three, so this is defensive rather than a
  // path — and it is what narrows the STORED level to one this build can run.
  if (
    !model ||
    !isThinkingLevel(row.thinkingLevel) ||
    !supportedThinkingLevelsForModel(model).includes(row.thinkingLevel)
  )
    throw new PeerRuntimeRefusedError(
      `Approved runtime "${peerRuntimeDisplayName(row)}" is no longer available exactly as approved.`,
    );
  const description = selectionDescriptionOf(row);
  return {
    profileId: row.id,
    name: peerRuntimeDisplayName(row),
    provider: row.provider,
    modelId: row.modelId,
    ...(model.name ? { modelName: model.name } : {}),
    credentialProfileId,
    ...(model.accountName ? { accountName: model.accountName } : {}),
    thinkingLevel: row.thinkingLevel,
    family: peerRuntimeFamilyOf(row.provider, row.modelId),
    relativeCost: row.relativeCost,
    ...(description ? { description } : {}),
  };
}

/* ------------------------- concurrency admission -------------------------- */

export type DirectPeerCostClass = "low" | "counted";

type DirectPeerCostTarget =
  | { profileId: string }
  | { provider: string; modelId: string; thinkingLevel: StoredThinkingLevel };

/** Unknown cost counts. Agent runtimes require unanimous enabled low matches. */
function classifyDirectPeerCost(
  rows: readonly PeerSpawnRuntime[],
  target: DirectPeerCostTarget,
): DirectPeerCostClass {
  if ("profileId" in target)
    return rows.find((row) => row.id === target.profileId.trim())
      ?.relativeCost === "low"
      ? "low"
      : "counted";
  const matches = rows.filter(
    (row) =>
      row.enabled &&
      row.provider === target.provider &&
      row.modelId === target.modelId &&
      row.thinkingLevel === target.thinkingLevel,
  );
  return matches.length > 0 &&
    matches.every((row) => row.relativeCost === "low")
    ? "low"
    : "counted";
}

/** Classify against current Settings, ignoring accounts for agent runtimes. */
export function directPeerCostClass(
  target: DirectPeerCostTarget,
): DirectPeerCostClass {
  return classifyDirectPeerCost(getSettings().peerSpawnRuntimes, target);
}

/**
 * Slots a batch has claimed while its sessions do not exist yet.
 *
 * A cap counted purely from observed state is not a cap: admission awaits the
 * runtime state of every child, and a second batch that arrives during that
 * await sees the same free capacity — so two overlapping calls could each start
 * a full quota of PAID turns. A claim is therefore recorded before the batch
 * runs and released when it ends; from then on the children's own queued and
 * running turns are what occupy the budget.
 */
const reservedTurns = new Map<string, number>();

/**
 * Hold tickets: queue positions admission handed to a held row whose `held`
 * peer prompt is not inserted yet, per coordinator. A start pass stops at the
 * oldest one, so a younger batch can never start ahead of an older batch whose
 * child is still being created. Per process, like {@link reservedTurns}: after
 * a restart only inserted rows exist.
 */
const inFlightHolds = new Map<string, Set<number>>();

/**
 * Per-coordinator serialization of the count-then-reserve pair. Node runs one
 * task at a time, but `await` is exactly where another call gets in, so the
 * decision and the claim have to be one critical section.
 */
const admissionLocks = new Map<string, Promise<unknown>>();

async function withAdmissionLock<T>(
  coordinatorSessionId: string,
  run: () => Promise<T>,
): Promise<T> {
  const prior = admissionLocks.get(coordinatorSessionId) ?? Promise.resolve();
  // Chained on settlement, not success: one refused batch must not wedge the
  // queue for every later one.
  const next = prior.then(run, run);
  admissionLocks.set(
    coordinatorSessionId,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

/**
 * Run `fn` inside this coordinator's admission critical section — the one a
 * held child's start shares with every batch (`heldDirectPeers.ts`). Not
 * re-entrant: `fn` must not admit or start for the same coordinator.
 */
export function withDirectAdmission<T>(
  coordinatorSessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withAdmissionLock(coordinatorSessionId, fn);
}

/** Record a session the direct path just created for this coordinator. */
export function recordDirectPeerChild(child: DirectPeerChild): void {
  directPeerChildStore.record(child);
}

/** Test seam: forget the recorded children, claims and tickets of every coordinator. */
export function resetDirectPeerChildrenForTests(): void {
  directPeerChildStore.clearForTests();
  reservedTurns.clear();
  inFlightHolds.clear();
  admissionLocks.clear();
}

/**
 * Turns this coordinator is currently accountable for.
 *
 * Low-cost children never count. Other children count while RUNNING or while
 * a prompt from this coordinator is still queued or being dispatched. Both
 * halves are needed and neither is sufficient:
 *
 * - runtime state alone misses the whole create-to-first-turn window. Delivery
 *   only ENQUEUES the opening prompt and drains it in the background, so a
 *   child that is certainly about to cost money reads as `idle`/`not_loaded`,
 *   and the next call would be handed a full fresh quota.
 * - the queue alone misses a turn already under way, since a delivered prompt
 *   leaves the unfinished statuses the moment the turn completes.
 *
 * A child whose opening prompt waits for a slot (`held`) costs nothing yet, and
 * neither do the messages queued behind it ({@link peerPromptStore.activeTurnCount}),
 * unless the user started a turn in it: a running child always counts.
 *
 * The queue is a durable, self-clearing signal rather than a timer: every
 * delivery ends in a terminal or post-turn status (a retry re-enters as
 * `queued`), so nothing can leak a slot for a start that never happens. And
 * because the count is state, not a ledger, a child that answered and went idle
 * releases its slot and one the coordinator forgot about never blocks the cap
 * permanently. The children themselves are durable (`direct_peer_children`), so
 * a restart counts the work that survived it.
 */
async function directPeerTurnsHeld(
  coordinatorSessionId: string,
): Promise<() => number> {
  const stateOf = await runtimeStateReader();
  // Everything is read when the count is called, by whoever uses it, in the
  // same step as its decision: a turn started, a row claimed, a cap lowered or
  // a batch's claim released before then is what that decision sees.
  return () => {
    let held = 0;
    for (const child of directPeerChildStore.childrenOf(coordinatorSessionId))
      if (
        child.costClass !== "low" &&
        (peerPromptStore.activeTurnCount(
          coordinatorSessionId,
          child.childSessionId,
        ) > 0 ||
          stateOf(child.childSessionId) === "running")
      )
        held += 1;
    return held + (reservedTurns.get(coordinatorSessionId) ?? 0);
  };
}

/**
 * Await the hub's runtime-state reader, then answer a SYNCHRONOUS count of the
 * counted slots free under the coordinator's CURRENT cap: runtime state, the
 * queue, reservations and cap are read when the count is called, so a caller that
 * decides in the same step as it counts sees every claim, cap edit or
 * released batch that landed during the awaits. Call it only inside
 * {@link withDirectAdmission}.
 */
export async function directSlotCounter(
  coordinatorSessionId: string,
): Promise<() => number> {
  const held = await directPeerTurnsHeld(coordinatorSessionId);
  return () => Math.max(0, directPeerTurnCapOf(coordinatorSessionId) - held());
}

/** The oldest queue position admitted to wait but not inserted yet. */
export function oldestInFlightHold(
  coordinatorSessionId: string,
): number | undefined {
  const seqs = inFlightHolds.get(coordinatorSessionId);
  return seqs && seqs.size > 0 ? Math.min(...seqs) : undefined;
}

/** In-flight hold tickets older than `queueSeq`, for a waiting row's position. */
export function inFlightHoldsBefore(
  coordinatorSessionId: string,
  queueSeq: number,
): number {
  let count = 0;
  for (const seq of inFlightHolds.get(coordinatorSessionId) ?? [])
    if (seq < queueSeq) count += 1;
  return count;
}

/** What admission decided for one row of a batch, in row order. */
type DirectPeerAdmission = { start: true } | { holdSeq: number };

/** A batch's claim on the coordinator's concurrency budget. */
export interface DirectPeerTurnClaim {
  rows: DirectPeerAdmission[];
  /** Give the claimed slots back. Idempotent; call it in a `finally`. */
  release(): void;
  /**
   * The held row with this position was inserted, or will never be: its
   * ticket stops blocking younger rows. Idempotent; call it in a `finally`.
   */
  settleHold(holdSeq: number): void;
}

/**
 * Decide, per row, whether a batch starts now or waits for a slot. Nothing is
 * refused for the cap.
 *
 * `low` rows always start and are unbounded. A `counted` row starts when a
 * slot is free AND nothing of this coordinator's is already waiting — not a
 * held row, not an admitted one still being created — so rows start in
 * admission order. Every other counted row is given its queue position now
 * ({@link peerPromptStore.allocateQueueSeq}) and is created with its opening
 * prompt `held`.
 *
 * The decision, the claim for the rows that start and the tickets for the rows
 * that wait happen inside one critical section per coordinator, so two
 * overlapping batches cannot both be told the same slots are free. The cap is
 * read inside it too: an edit landing while an earlier call holds the lock
 * applies to this one.
 */
export async function admitDirectPeerTurns(
  coordinatorSessionId: string,
  costs: readonly DirectPeerCostClass[],
): Promise<DirectPeerTurnClaim> {
  return withAdmissionLock(coordinatorSessionId, async () => {
    const counted = costs.filter((cost) => cost === "counted").length;
    let started = 0;
    const decideRows = (available: number): DirectPeerAdmission[] => {
      let free = available;
      let waiting =
        counted > 0 &&
        (oldestInFlightHold(coordinatorSessionId) !== undefined ||
          peerPromptStore.heldFrom(coordinatorSessionId).length > 0);
      const tickets =
        inFlightHolds.get(coordinatorSessionId) ?? new Set<number>();
      const decided = costs.map((cost): DirectPeerAdmission => {
        if (cost === "low") return { start: true };
        if (free > 0 && !waiting) {
          free -= 1;
          started += 1;
          return { start: true };
        }
        // Once one row waits, every later one waits behind it.
        waiting = true;
        const holdSeq = peerPromptStore.allocateQueueSeq();
        tickets.add(holdSeq);
        return { holdSeq };
      });
      if (tickets.size > 0) inFlightHolds.set(coordinatorSessionId, tickets);
      if (started > 0)
        reservedTurns.set(
          coordinatorSessionId,
          (reservedTurns.get(coordinatorSessionId) ?? 0) + started,
        );
      return decided;
    };
    const free =
      counted > 0 ? await directSlotCounter(coordinatorSessionId) : undefined;
    const rows = decideRows(free?.() ?? 0);
    let released = false;
    return {
      rows,
      release() {
        if (released) return;
        released = true;
        const remaining =
          (reservedTurns.get(coordinatorSessionId) ?? 0) - started;
        if (remaining > 0) reservedTurns.set(coordinatorSessionId, remaining);
        else reservedTurns.delete(coordinatorSessionId);
      },
      settleHold(holdSeq) {
        const current = inFlightHolds.get(coordinatorSessionId);
        if (!current?.delete(holdSeq)) return;
        if (current.size === 0) inFlightHolds.delete(coordinatorSessionId);
        // Every younger held child's `waitingForSlot.position` counts it.
        touchSessionRows(
          peerPromptStore
            .heldFrom(coordinatorSessionId)
            .map((held) => held.recipientSessionId),
        );
      },
    };
  });
}

/* --------------------------- the return route ----------------------------- */

/** Unambiguous boundary for the server-owned reporting block. */
const REPORT_MARKER = "<!-- pa:direct-peer-reporting -->";

/** Visible heading inside the server-owned block. */
const REPORT_HEADING = "Reporting back to your coordinator";

/**
 * The return route, appended by the SERVER to a coordinator-owned direct
 * child's opening prompt. A child born user-owned receives no return route.
 *
 * A directly spawned session is an ordinary session: nothing watches it, and
 * nothing reports for it. So the one thing it cannot be left to infer is who
 * asked and how to answer — a coordinator's own prompt text may omit it, and
 * then the work lands in a transcript nobody reads. It is appended rather than
 * prepended so the coordinator's own instructions still open the prompt.
 */
export function directSpawnReportingSuffix(
  coordinatorSessionId: string,
): string {
  return [
    ``,
    ``,
    REPORT_MARKER,
    `---`,
    `${REPORT_HEADING}: this session was started by session ${coordinatorSessionId}, which is waiting on you and cannot see your transcript.`,
    `- When you are done, or blocked, use session_send_prompt to send that session a concise result or blocker. Do not just end your turn silently.`,
    `- Name the exact Task, worktree, branch head or reviewed target your result is about.`,
    `- You are an ordinary session: the human can read, re-prompt and take you over at any time.`,
  ].join("\n");
}

/**
 * Attach THIS coordinator's return route, whatever the caller wrote.
 *
 * The route is server-owned, so nothing in the caller's text may suppress it.
 * Everything from the first unambiguous marker onward is discarded before one
 * current block is appended: that replaces stale, partial, duplicated or
 * caller-modified blocks rather than preserving contradictory trailing text.
 * Merely quoting the visible heading is harmless because it is not the marker.
 */
export function withReportingRoute(
  prompt: string,
  coordinatorSessionId: string,
): string {
  const markerIndex = prompt.indexOf(REPORT_MARKER);
  const stripped = (
    markerIndex >= 0 ? prompt.slice(0, markerIndex) : prompt
  ).trimEnd();
  return `${stripped}${directSpawnReportingSuffix(coordinatorSessionId)}`;
}
