/**
 * The approved peer-runtime roster ([Task-595](pa://task/595)): the server side
 * of the small set of exact account/model/thinking options a human pre-approved
 * for agents to start ordinary peer sessions on.
 *
 * It answers three questions and nothing else:
 *
 * - what the roster currently looks like, with each row's real availability,
 *   inferred family, and user-owned cost/selection guidance (`peerRuntimeRoster`);
 * - whether ONE named row can run RIGHT NOW, exactly as approved
 *   (`resolveApprovedPeerRuntime`) — there is no fallback, no nearest model and
 *   no automatic account, because a substitution is a runtime the human never
 *   approved;
 * - whether a coordinator may start another direct peer turn at this moment
 *   (`admitDirectPeerTurns`), a fixed server policy rather than a setting.
 *
 * It knows nothing about the subagent registry and must never import it: what
 * this roster starts is an ordinary `scope = "user"` session.
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
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { modelsForAccount } from "./harnesses/models.ts";
import { getSettings } from "./settings.ts";
import { runtimeStateFor } from "./tools/sessions/sessionInspection.ts";

/**
 * How many peer turns one coordinator may have RUNNING at once through the
 * direct path. Fixed policy, not a setting: the point is that a coordinator
 * cannot turn a pre-approval into unbounded parallel spend, and a number the
 * user could raise would not be that.
 */
export const MAX_CONCURRENT_DIRECT_PEER_TURNS = 4;

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
async function accountModelOptions(): Promise<AccountModelOption[]> {
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
      option.credentialProfileId === row.credentialProfileId &&
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
    ...(model?.accountName ? { accountName: model.accountName } : {}),
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
 * ask for. The check is exact — this account, this model, this thinking level —
 * and it runs per row at spawn time, because Settings edits take effect on the
 * next start and a roster read may be minutes old.
 */
export async function resolveApprovedPeerRuntime(
  profileId: string,
): Promise<ApprovedPeerRuntime> {
  const wanted = profileId.trim();
  // Discover account/model availability first, then take the roster snapshot.
  // Discovery awaits provider state, so reading Settings before it would let a
  // user edit during that await authorize the runtime from the stale row.
  const options = await accountModelOptions();
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
  const reason = peerRuntimeUnavailableReason(row, options);
  if (reason)
    throw new PeerRuntimeRefusedError(
      `Approved runtime "${peerRuntimeDisplayName(row)}" cannot run right now: ${reason}`,
    );
  const model = options.find(
    (option) =>
      option.credentialProfileId === row.credentialProfileId &&
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
    credentialProfileId: row.credentialProfileId,
    ...(model.accountName ? { accountName: model.accountName } : {}),
    thinkingLevel: row.thinkingLevel,
    family: peerRuntimeFamilyOf(row.provider, row.modelId),
    relativeCost: row.relativeCost,
    ...(description ? { description } : {}),
  };
}

/* ------------------------- concurrency admission -------------------------- */

/**
 * Which sessions each coordinator started through the direct path, this
 * process's lifetime. In memory on purpose: the limit bounds what is running
 * NOW, and a restart has by definition left nothing of those turns running.
 */
const directChildren = new Map<string, Set<string>>();

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

/** Record a session the direct path just created for this coordinator. */
export function recordDirectPeerChild(
  coordinatorSessionId: string,
  sessionId: string,
): void {
  const set = directChildren.get(coordinatorSessionId) ?? new Set<string>();
  set.add(sessionId);
  directChildren.set(coordinatorSessionId, set);
}

/** The direct children of one coordinator, oldest first. */
function directPeerChildren(coordinatorSessionId: string): string[] {
  return [...(directChildren.get(coordinatorSessionId) ?? [])];
}

/** Test seam: forget the recorded children and claims of every coordinator. */
export function resetDirectPeerChildrenForTests(): void {
  directChildren.clear();
  reservedTurns.clear();
  admissionLocks.clear();
}

/**
 * Turns this coordinator is currently accountable for.
 *
 * A child counts while its runtime is RUNNING **or** while a prompt this
 * coordinator sent it is still queued or being dispatched. Both halves are
 * needed and neither is sufficient:
 *
 * - runtime state alone misses the whole create-to-first-turn window. Delivery
 *   only ENQUEUES the opening prompt and drains it in the background, so a
 *   child that is certainly about to cost money reads as `idle`/`not_loaded`,
 *   and the next call would be handed a full fresh quota.
 * - the queue alone misses a turn already under way, since a delivered prompt
 *   leaves the unfinished statuses the moment the turn completes.
 *
 * The queue is a durable, self-clearing signal rather than a timer: every
 * delivery ends in a terminal or post-turn status (a retry re-enters as
 * `queued`), so nothing can leak a slot for a start that never happens. And
 * because the count is state, not a ledger, a child that answered and went idle
 * releases its slot and one the coordinator forgot about never blocks the cap
 * permanently.
 */
async function directPeerTurnsHeld(
  coordinatorSessionId: string,
): Promise<number> {
  let held = 0;
  for (const child of directPeerChildren(coordinatorSessionId)) {
    const queued = peerPromptStore.unfinishedTurnCount(
      coordinatorSessionId,
      child,
    );
    if (queued > 0 || (await runtimeStateFor(child)) === "running") held += 1;
  }
  return held + (reservedTurns.get(coordinatorSessionId) ?? 0);
}

/** A batch's claim on the coordinator's concurrency budget. */
export interface DirectPeerTurnClaim {
  /** Give the claimed slots back. Idempotent; call it in a `finally`. */
  release(): void;
}

/**
 * Claim `rows` concurrent turns for this coordinator, or refuse the batch.
 *
 * The decision and the claim happen inside one critical section per
 * coordinator, so two overlapping batches cannot both be told the same slots
 * are free. The claim is held for the whole batch and released by the caller;
 * from then on the children's own runtime state is what occupies the budget.
 */
export async function admitDirectPeerTurns(
  coordinatorSessionId: string,
  rows: number,
): Promise<DirectPeerTurnClaim> {
  return withAdmissionLock(coordinatorSessionId, async () => {
    const held = await directPeerTurnsHeld(coordinatorSessionId);
    const available = Math.max(0, MAX_CONCURRENT_DIRECT_PEER_TURNS - held);
    if (rows > available)
      throw new PeerRuntimeRefusedError(
        `You already have ${MAX_CONCURRENT_DIRECT_PEER_TURNS - available} directly spawned peer turn(s) running or starting; at most ${MAX_CONCURRENT_DIRECT_PEER_TURNS} may run at once, so this batch of ${rows} was not started. Wait for results from the sessions you started, then spawn the rest.`,
      );
    reservedTurns.set(
      coordinatorSessionId,
      (reservedTurns.get(coordinatorSessionId) ?? 0) + rows,
    );
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        const remaining = (reservedTurns.get(coordinatorSessionId) ?? 0) - rows;
        if (remaining > 0) reservedTurns.set(coordinatorSessionId, remaining);
        else reservedTurns.delete(coordinatorSessionId);
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
 * The return route, appended by the SERVER to every direct child's opening
 * prompt.
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
