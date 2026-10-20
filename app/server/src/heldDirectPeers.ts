/**
 * Directly spawned children waiting for a slot ([Task-966](pa://task/966)).
 *
 * Over its coordinator's concurrency cap a `session_spawn` row is still
 * created, but its opening prompt is stored `held` (`peerSpawnRuntimes.ts`
 * decides, `sessionSpawn.ts` creates). This module starts those prompts:
 *
 * - in admission order per coordinator, never ahead of an older row whose
 *   session is still being created (the hold tickets);
 * - inside the same admission critical section as every batch, so a start and
 *   an overlapping spawn cannot both take one free slot;
 * - only after re-checking the approval the child was spawned under against
 *   the CURRENT Settings or agent definition. One no longer allowed is refused
 *   (`failed`) and its coordinator gets a notice saying why, in the same
 *   transaction;
 * - on events, never on a timer: a child going idle, a coordinator's row to its
 *   child leaving the statuses that hold a slot (including a cancellation),
 *   the end of a batch or of a row's creation, a raised cap, and boot.
 *
 * A held row whose child was deleted or archived, or whose coordinator was
 * deleted, is cancelled silently; that never needs a free slot.
 */
import {
  peerRuntimeUnavailableReason,
  type AccountModelOption,
  type ModelOption,
} from "@assistant/shared";
import {
  AgentSpawnRefusedError,
  agentDefinitionBlob,
  resolveAgentRole,
} from "./agents/agentSpawn.ts";
import { credentialProfileById } from "./credentialProfiles.ts";
import type { HeldStartCategory } from "./db/delegationFailureNoticeStore.ts";
import {
  directPeerChildStore,
  type DirectPeerChild,
} from "./db/directPeerChildStore.ts";
import {
  peerPromptStore,
  type PeerPromptRecord,
} from "./db/peerPromptStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import {
  HELD_START_REASONS,
  recordHeldStartNotice,
} from "./delegationFailureNotice.ts";
import {
  broadcastPeerPromptChanges,
  drainRecipient,
  RESPONSE_TTL_MS,
  wakeForNotice,
} from "./peerPrompt.ts";
import {
  accountModelOptions,
  inFlightHoldsBefore,
  modelsForProfile,
  oldestInFlightHold,
  setPeerTurnCapChangedHook,
  withDirectAdmission,
  directSlotCounter,
} from "./peerSpawnRuntimes.ts";
import { getSettings } from "./settings.ts";

const DELETED_REASON = "Cancelled: a session it involves was deleted.";
const ARCHIVED_REASON =
  "Cancelled: the session was archived before it started.";

/* ------------------------------ the re-check ------------------------------ */

/**
 * The re-check's ASYNCHRONOUS half: what account discovery and the agent
 * definition answered. {@link heldStartVerdict} judges it against the current
 * Settings and account, synchronously, in the same step as the start.
 */
interface HeldStartDiscovery {
  child: DirectPeerChild;
  options: AccountModelOption[];
  models: ModelOption[];
  /** An agent child's definition as checked, or why it could not be. */
  agent?:
    { role: Awaited<ReturnType<typeof resolveAgentRole>> } | { refused: true };
}

async function discoverHeldStart(
  child: DirectPeerChild,
): Promise<HeldStartDiscovery> {
  if (child.source.kind === "profile")
    return { child, options: await accountModelOptions(), models: [] };
  const models = await modelsForProfile(child.credentialProfileId);
  try {
    return {
      child,
      options: [],
      models,
      agent: { role: await resolveAgentRole(child.source.agentName) },
    };
  } catch (err) {
    if (err instanceof AgentSpawnRefusedError)
      return { child, options: [], models, agent: { refused: true } };
    throw err;
  }
}

/**
 * The definition's source blob read again after every other await, the LAST
 * await before the verdict: an edit while its models were checked, or while
 * slots were counted, makes it differ from the blob checked.
 */
async function currentDefinitionBlob(
  discovery: HeldStartDiscovery,
): Promise<string | undefined> {
  return discovery.child.source.kind === "agent"
    ? agentDefinitionBlob(discovery.child.source.agentName)
    : undefined;
}

/**
 * Why this child may no longer start, or undefined when it may: the roster row
 * it was spawned on must still exist, be enabled and approve its exact
 * provider/model/thinking (a pin must be its account), and its account must
 * still run it; a definition must still resolve, keep its persona and list its
 * model at its effort, and be the definition that was checked.
 *
 * Synchronous on purpose: Settings, the account and the session are read here,
 * after every await, so an approval revoked during discovery or while slots
 * were counted is the one this sees.
 */
function heldStartVerdict(
  discovery: HeldStartDiscovery,
  blobNow: string | undefined,
): HeldStartCategory | undefined {
  const { child } = discovery;
  const meta = sessionStore.get(child.childSessionId);
  const requiresEnterprise = meta?.requiresEnterprise === true;
  const profile = credentialProfileById(child.credentialProfileId);
  if (child.source.kind === "profile") {
    const profileId = child.source.profileId;
    const row = getSettings().peerSpawnRuntimes.find((r) => r.id === profileId);
    if (!row) return "held_runtime_removed";
    if (!row.enabled) return "held_runtime_disabled";
    if (
      row.provider !== child.provider ||
      row.modelId !== child.modelId ||
      row.thinkingLevel !== child.thinkingLevel ||
      (row.credentialProfileId !== undefined &&
        row.credentialProfileId !== "" &&
        row.credentialProfileId !== child.credentialProfileId)
    )
      return "held_runtime_changed";
    // Discovery's account flags are from before its await; the account is
    // read again here.
    if (
      !profile?.enabled ||
      peerRuntimeUnavailableReason(
        { ...row, credentialProfileId: child.credentialProfileId },
        discovery.options,
      ) ||
      (requiresEnterprise && !profile.enterprise)
    )
      return "held_account_unavailable";
    return undefined;
  }
  const agent = discovery.agent;
  if (!agent || "refused" in agent || blobNow === undefined)
    return "held_agent_removed";
  const { role, listed } = agent.role;
  if (
    blobNow !== role.blob ||
    role.persona !== meta?.agentType ||
    !listed.some(
      (choice) =>
        choice.runtime?.model.provider === child.provider &&
        choice.runtime.model.id === child.modelId &&
        choice.runtime.thinkingLevel === child.thinkingLevel,
    )
  )
    return "held_agent_changed";
  if (
    !profile?.enabled ||
    (requiresEnterprise && !profile.enterprise) ||
    !discovery.models.some(
      (model) =>
        model.provider === child.provider && model.id === child.modelId,
    )
  )
    return "held_account_unavailable";
  return undefined;
}

/** The whole re-check, for a start that needs no slot (the user's Send now). */
async function heldStartRefusal(
  child: DirectPeerChild,
): Promise<HeldStartCategory | undefined> {
  const discovery = await discoverHeldStart(child);
  return heldStartVerdict(discovery, await currentDefinitionBlob(discovery));
}

/**
 * Refuse a held row with its category and the coordinator's notice, together.
 * A failure to write leaves the row held for the next pass.
 */
function refuse(row: PeerPromptRecord, category: HeldStartCategory): boolean {
  let refused: PeerPromptRecord | undefined;
  try {
    refused = peerPromptStore.refuseHeld(
      row.id,
      HELD_START_REASONS[category],
      (held) => {
        recordHeldStartNotice(held, category);
      },
    );
  } catch {
    console.error("[held-start] could not refuse a waiting opening prompt");
    return false;
  }
  if (!refused) return false;
  broadcastPeerPromptChanges([refused]);
  wakeForNotice([refused.senderSessionId]);
  // Whatever was queued behind the opener is deliverable now.
  void drainRecipient(refused.recipientSessionId).catch(() => {});
  return true;
}

/**
 * The user's Send now on a held row: it goes past the cap and FIFO, never past
 * the re-check. A refusal fails the row with the coordinator's notice and
 * throws the reason for the user.
 */
export async function assertHeldStartAllowed(
  row: PeerPromptRecord,
): Promise<void> {
  const child = directPeerChildStore.get(row.recipientSessionId);
  if (!child) return;
  const category = await heldStartRefusal(child);
  if (!category) return;
  refuse(row, category);
  throw new Error(HELD_START_REASONS[category]);
}

/* ------------------------------ the start pass ---------------------------- */

interface PassState {
  promise: Promise<void>;
  rerun: boolean;
}

/** One pass per coordinator at a time; a trigger meanwhile runs it again. */
const passes = new Map<string, PassState>();

/**
 * Start what this coordinator's free slots allow, oldest first, and cancel
 * what can no longer start. Idempotent and cheap when nothing is held.
 *
 * Resolves once the pass has DECIDED and SCHEDULED: deliveries and notice
 * turns run in the background. A call while a pass runs resolves with the
 * rerun it requested.
 */
export function startHeldDirectPeers(spawnerId: string): Promise<void> {
  const current = passes.get(spawnerId);
  if (current) {
    current.rerun = true;
    return current.promise;
  }
  const state: PassState = { promise: Promise.resolve(), rerun: true };
  passes.set(spawnerId, state);
  state.promise = (async () => {
    try {
      while (state.rerun) {
        state.rerun = false;
        try {
          await runPass(spawnerId);
        } catch {
          console.error("[held-start] a start pass failed");
        }
      }
    } finally {
      passes.delete(spawnerId);
    }
  })();
  return state.promise;
}

async function runPass(spawnerId: string): Promise<void> {
  if (peerPromptStore.heldFrom(spawnerId).length === 0) return;
  await withDirectAdmission(spawnerId, async () => {
    const spawnerDeleted = isDeleted(spawnerId);
    for (const row of peerPromptStore.heldFrom(spawnerId)) {
      const child = row.recipientSessionId;
      if (
        spawnerDeleted ||
        isDeleted(child) ||
        sessionStore.get(child)?.archivedAt !== undefined
      ) {
        const cancelled = peerPromptStore.cancelOne(
          row.id,
          spawnerDeleted || isDeleted(child) ? DELETED_REASON : ARCHIVED_REASON,
        );
        if (cancelled) broadcastPeerPromptChanges([cancelled]);
      }
    }
    if (spawnerDeleted) return;
    if ((await directSlotCounter(spawnerId))() === 0) return;
    const barrier = oldestInFlightHold(spawnerId);
    for (const row of peerPromptStore.heldFrom(spawnerId)) {
      if (barrier !== undefined && row.queueSeq > barrier) break;
      const child = directPeerChildStore.get(row.recipientSessionId);
      // Every await first — discovery, the slot count's runtime states, the
      // definition's source — then the verdict, the count and the promotion
      // in ONE synchronous step: an approval revoked, a cap lowered or a slot
      // taken (the user's Send now) during any of them is what decides.
      const discovery = child ? await discoverHeldStart(child) : undefined;
      const free = await directSlotCounter(spawnerId);
      const blobNow = discovery
        ? await currentDefinitionBlob(discovery)
        : undefined;
      const category = discovery
        ? heldStartVerdict(discovery, blobNow)
        : undefined;
      // A refused row frees nothing and blocks nothing.
      if (category) {
        refuse(row, category);
        continue;
      }
      if (free() === 0) break;
      const outcome = peerPromptStore.promoteHeld(
        row.id,
        row.responseRequested ? Date.now() + RESPONSE_TTL_MS : null,
      );
      if (!outcome) continue;
      broadcastPeerPromptChanges([outcome]);
      void drainRecipient(outcome.recipientSessionId).catch(() => {});
    }
  });
}

function isDeleted(sessionId: string): boolean {
  return sessionStore.getIncludingDeleted(sessionId)?.deletedAt !== undefined;
}

/** A direct child went idle: its coordinator may have a slot again. */
export function nudgeHeldStartsForChild(childSessionId: string): void {
  const spawner = directPeerChildStore.spawnerOf(childSessionId);
  if (spawner) void startHeldDirectPeers(spawner);
}

/** Boot wiring: a cap write wakes its coordinator's waiting children. */
export function installHeldDirectPeerStarts(): void {
  setPeerTurnCapChangedHook((spawnerId) => {
    void startHeldDirectPeers(spawnerId);
  });
}

/** Boot: every coordinator with a held row gets one pass. */
export function startHeldDirectPeersOnBoot(): void {
  for (const spawner of peerPromptStore.heldSenderIds())
    void startHeldDirectPeers(spawner);
}

/**
 * 1-based position of this child's held opening prompt among its
 * coordinator's waiting rows (inserted, or admitted and still being created);
 * undefined when it is not waiting.
 */
export function waitingPositionOf(
  spawnerId: string,
  childSessionId: string,
): number | undefined {
  const held = peerPromptStore.heldFrom(spawnerId);
  const index = held.findIndex((r) => r.recipientSessionId === childSessionId);
  if (index < 0) return undefined;
  return index + 1 + inFlightHoldsBefore(spawnerId, held[index]!.queueSeq);
}

/* -------------------------------- removal --------------------------------- */

/** A deleted session's held rows, sent or received, are cancelled silently. */
export function cancelHeldForDeletedSession(sessionId: string): void {
  broadcastPeerPromptChanges(
    peerPromptStore.cancelHeldInvolving(sessionId, DELETED_REASON),
  );
}

/**
 * An archived session's waiting opening prompt is cancelled with it, silently;
 * a restore resurrects nothing. What it spawned keeps waiting.
 */
export function cancelHeldForArchivedSessions(
  sessionIds: readonly string[],
): void {
  for (const id of sessionIds)
    broadcastPeerPromptChanges(
      peerPromptStore.cancelHeldTo(id, ARCHIVED_REASON),
    );
}
