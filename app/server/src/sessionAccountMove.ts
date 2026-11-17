/**
 * Moving an idle session to an account the user (session inspector) or its
 * owning coordinator (`session_control` `move_account`) picked, right away.
 *
 * One predicate decides which accounts qualify: the picker's list, the move
 * and the tool's error text all use it. The move loads a session whose harness
 * is not resident, excludes every turn while it runs (run lease, account
 * recovery reservation, harness admission), rechecks the caller's authority up
 * to the binding commit, and goes through the engines' existing
 * `switchAccount` (history copy on Claude, staged reopen on pi, binding CAS).
 * It never sets or clears the enterprise requirement (`docs/account-routing.md`).
 */
import {
  accountServesModel,
  isSubscriptionAccountKind,
  type SessionAccountMoveTarget,
  type ThinkingLevel,
} from "@assistant/shared";
import { isSubscriptionAccountModel } from "@assistant/shared/accountHealth";
import { gatherAccountCandidate } from "./accountRouter.ts";
import { readAccountBench, readAccountHealth } from "./accountHealth.ts";
import {
  credentialProfileById,
  credentialProfileHasCredential,
  listCredentialProfiles,
  type CredentialProfile,
} from "./credentialProfiles.ts";
import { sessionStore, type SessionMeta } from "./db/sessionStore.ts";
import { formatLocalDateTime } from "./googleTime.ts";
import { storedSessionModelOption } from "./harnesses/models.ts";
import {
  assertAccountRecoveryAdmission,
  ownsAccountRecovery,
  releaseAccountRecovery,
  reserveAccountRecovery,
} from "./session/runtime/accountRecoveryAdmission.ts";
import type { SessionRuntime } from "./session/runtime/runtime.ts";
import { sessionRuntime } from "./session/runtimeInstance.ts";
import {
  ensureRuntimeSessionWithRuntime,
  type RuntimePromptDriver,
} from "./session/runtimePrompt.ts";
import { beginPromptRun } from "./session/sessionRunLease.ts";
import {
  selectionSignature,
  switchIdleSessionAccount,
} from "./sessionAccountSwitch.ts";

interface MoveSelection {
  model?: { provider: string; id: string } | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
}

/**
 * The runtime and the session lookups the move needs; a narrow seam so tests
 * substitute a fake hub and runtime instead of module-mocking singletons.
 */
interface AccountMoveHost {
  runtime: SessionRuntime;
  /** The resident driver, without opening a harness (the list's read). */
  resident(sessionId: string): Promise<RuntimePromptDriver | undefined>;
  /** The resident driver, or the harness opened for the move. */
  acquire(sessionId: string): Promise<RuntimePromptDriver | undefined>;
  /** Publish the rebound row ahead of the move's answer. */
  publishRows(): Promise<void>;
}

let hostOverride: AccountMoveHost | undefined;

/** Test-only seam: substitute the runtime and hub. Undefined restores them. */
export function setAccountMoveHostForTests(
  host: AccountMoveHost | undefined,
): void {
  hostOverride = host;
}

function asDriver(candidate: unknown): RuntimePromptDriver | undefined {
  return candidate &&
    typeof candidate === "object" &&
    "createRuntimeAdapter" in candidate &&
    "canSteer" in candidate
    ? (candidate as RuntimePromptDriver)
    : undefined;
}

const defaultHost: AccountMoveHost = {
  runtime: sessionRuntime,
  async resident(sessionId) {
    const { hub } = await import("./hub.ts");
    return asDriver(hub.getLiveById(sessionId));
  },
  async acquire(sessionId) {
    const { hub } = await import("./hub.ts");
    return asDriver(
      hub.getLiveById(sessionId) ?? (await hub.acquireById(sessionId)),
    );
  },
  async publishRows() {
    const { publishSessionRowsNow } = await import("./stateTopics.ts");
    publishSessionRowsNow();
  },
};

function host(): AccountMoveHost {
  return hostOverride ?? defaultHost;
}

/** The session and the subscription login it may move off. Throws otherwise. */
function moveSource(sessionId: string): {
  row: SessionMeta;
  source: CredentialProfile;
} {
  const row = sessionStore.get(sessionId);
  if (!row) throw new Error("Session does not exist or was deleted.");
  if (row.scope !== "user")
    throw new Error("Only a user session can move to another account.");
  const source = row.credentialProfileId
    ? credentialProfileById(row.credentialProfileId)
    : undefined;
  if (!source) throw new Error("This session has no account to move from.");
  // Any account that is no subscription login alone serves its models.
  if (!isSubscriptionAccountKind(source.provider))
    throw new Error(
      `${source.name} is the only account that serves this session's model, so the session cannot move.`,
    );
  return { row, source };
}

/** The synchronous target rules: kind, current account, enabled, enterprise. */
function targetRefusal(
  row: SessionMeta,
  source: CredentialProfile,
  target: CredentialProfile | undefined,
): string | undefined {
  if (!target) return "The chosen account no longer exists.";
  if (target.id === source.id)
    return `This session already runs on ${source.name}.`;
  if (target.provider !== source.provider)
    return `${target.name} is not the same kind of account as ${source.name}.`;
  if (!target.enabled) return `${target.name} is disabled.`;
  if (row.requiresEnterprise && !target.enterprise)
    return `This session requires an enterprise account, and ${target.name} is not one.`;
  return undefined;
}

/** A session moves only with a model its subscription login runs. */
function selectionRefusal(
  source: CredentialProfile,
  selection: MoveSelection | undefined,
): string | undefined {
  if (!selection?.model) return "This session has no model to move with.";
  if (!isSubscriptionAccountModel(source.provider, selection.model.provider))
    return `This session's model is not one ${source.name}'s subscription runs, so the session cannot move.`;
  return undefined;
}

function benchText(name: string, modelId: string, until: number): string {
  return `${name} has reached its ${modelId} limit until ${formatLocalDateTime(new Date(until).toISOString())}.`;
}

/**
 * The model, health and bench rules, judged on the same per-account facts as
 * Automatic (`gatherAccountCandidate`): the account serves and offers the
 * session's model at its thinking level, needs no login, and has no bench on
 * that model.
 */
async function modelRefusal(
  target: CredentialProfile,
  selection: MoveSelection & { model: { provider: string; id: string } },
): Promise<string | undefined> {
  const model = selection.model;
  if (!accountServesModel(target, model.provider))
    return `${target.name} cannot run this session's model.`;
  const profile = listCredentialProfiles().find(({ id }) => id === target.id);
  if (!profile) return "The chosen account no longer exists.";
  const candidate = await gatherAccountCandidate(profile, {
    model: { provider: model.provider, modelId: model.id },
    ...(selection.thinkingLevel
      ? { thinkingLevel: selection.thinkingLevel }
      : {}),
  });
  if (!candidate.offersModel)
    return `${target.name} does not offer ${model.id} at this session's effort.`;
  if (candidate.profile.health.state === "needs-login")
    return `${target.name} needs login.`;
  if (candidate.limited)
    return benchText(target.name, model.id, candidate.limited.until);
  return undefined;
}

/** Health and bench again, synchronously, at every engine step. */
function assertStillEligible(target: CredentialProfile, modelId: string): void {
  if (
    readAccountHealth(target.id, credentialProfileHasCredential(target.id))
      .state === "needs-login"
  )
    throw new Error(`${target.name} needs login.`);
  const bench = readAccountBench(target.id, modelId);
  if (bench) throw new Error(benchText(target.name, modelId, bench.until));
}

/** Why `target` cannot take the session right now; undefined when it can. */
async function accountMoveRefusal(
  row: SessionMeta,
  source: CredentialProfile,
  target: CredentialProfile | undefined,
  selection: MoveSelection | undefined,
): Promise<string | undefined> {
  const refusal =
    targetRefusal(row, source, target) ?? selectionRefusal(source, selection);
  if (refusal || !target || !selection?.model) return refusal;
  return modelRefusal(target, { ...selection, model: selection.model });
}

/**
 * The selection a session would move with: its resident harness's, else its
 * stored model, normalized as a view reads it. Never opens a harness.
 */
async function sessionSelection(
  row: SessionMeta,
): Promise<MoveSelection | undefined> {
  const driver = await host().resident(row.id);
  if (driver?.modelSelection) return driver.modelSelection();
  const model = storedSessionModelOption(row.harness, row.provider, row.model);
  return model
    ? {
        model: { provider: model.provider, id: model.id },
        ...(row.thinkingLevel
          ? { thinkingLevel: row.thinkingLevel as ThinkingLevel }
          : {}),
      }
    : undefined;
}

/**
 * The accounts the session could move to right now, for the inspector's
 * picker and the coordinator tool's error text. Throws when the session
 * itself cannot move.
 */
export async function accountMoveTargets(
  sessionId: string,
): Promise<SessionAccountMoveTarget[]> {
  const { row, source } = moveSource(sessionId);
  const selection = await sessionSelection(row);
  const refusal = selectionRefusal(source, selection);
  if (refusal) throw new Error(refusal);
  const profiles = listCredentialProfiles();
  const refusals = await Promise.all(
    profiles.map((target) =>
      accountMoveRefusal(row, source, target, selection),
    ),
  );
  return profiles
    .filter((_, index) => !refusals[index])
    .map((target) => ({
      id: target.id,
      name: target.name,
      enterprise: target.enterprise === true,
    }));
}

export interface AccountMoveRequest {
  sessionId: string;
  targetProfileId: string;
  /** Who chose the account, for the timeline marker. */
  by: "user" | "coordinator";
  /**
   * The caller's authority to move this session: run at preflight and in
   * every engine check up to the binding commit, so losing it refuses.
   */
  authorize: () => void;
}

function busy(sessionId: string): Error {
  return new Error(
    `Session ${sessionId} is running; move it once its turn ends.`,
  );
}

/**
 * Move an idle session to `targetProfileId` now. Answers both account names;
 * throws a host-owned reason, with the binding unchanged, when the session or
 * target does not qualify or anything changes before the commit.
 */
export async function moveSessionAccount(
  request: AccountMoveRequest,
): Promise<{ from: string; to: string }> {
  const { sessionId: id, authorize } = request;
  const { runtime, acquire, publishRows } = host();
  // Synchronous preflight: no await before every hold is taken, so no prompt
  // can be admitted in between.
  authorize();
  const { row, source } = moveSource(id);
  const target = credentialProfileById(request.targetProfileId);
  const refused = targetRefusal(row, source, target);
  if (refused || !target) throw new Error(refused);
  if (runtime.isBusy(id)) throw busy(id);
  assertAccountRecoveryAdmission(id);
  // Throws on a worktree hold, before anything is held.
  const releaseRun = beginPromptRun(id);
  let ticket: symbol | undefined;
  let releaseAdmission: (() => void) | undefined;
  let live: ReturnType<SessionRuntime["createSession"]> | undefined;
  try {
    ticket = reserveAccountRecovery(id);
    const owned = ticket;
    releaseAdmission = runtime.admitPrompt(id);
    let driver: RuntimePromptDriver | undefined;
    try {
      driver = await acquire(id);
    } catch {
      driver = undefined;
    }
    if (!driver || driver.released)
      throw new Error("This session could not be loaded for the move.");
    if (driver.isRunning) throw busy(id);
    if (!driver.switchAccount || !driver.modelSelection)
      throw new Error("This session cannot switch accounts.");
    const engine = driver;
    live = ensureRuntimeSessionWithRuntime(runtime, engine);
    const session = live;
    const selected = engine.modelSelection!();
    const refusal = await accountMoveRefusal(row, source, target, selected);
    if (refusal || !selected.model) throw new Error(refusal);
    const modelId = selected.model.id;
    const signature = selectionSignature(selected);
    const admit = () => {
      authorize();
      if (!ownsAccountRecovery(id, owned))
        throw new Error("Another account switch took over this session.");
      if (engine.released || engine.isRunning || session.isRunning)
        throw busy(id);
      if (!sessionStore.get(id))
        throw new Error("Session does not exist or was deleted.");
      if (selectionSignature(engine.modelSelection?.()) !== signature)
        throw new Error(
          "This session's model or effort changed during the move.",
        );
    };
    admit();
    await switchIdleSessionAccount(engine, {
      source,
      targetId: target.id,
      requiresEnterprise: sessionStore.get(id)?.requiresEnterprise === true,
      admit,
      eligible: () => assertStillEligible(target, modelId),
    });
    // The marker is display only: after the commit, its failure changes
    // nothing about the move.
    try {
      session.appendNotice(
        `Switched from ${source.name} to ${target.name} — chosen by ${request.by === "user" ? "you" : "its coordinating session"}.`,
      );
    } catch {
      console.warn("[account-move] Could not append the move marker.");
    }
    // The rebound row also reaches clients on the regular publish; this
    // only orders it ahead of the answer.
    await publishRows().catch(() => {});
    return { from: source.name, to: target.name };
  } finally {
    releaseAdmission?.();
    releaseRun();
    if (ticket) releaseAccountRecovery(id, ticket);
    live?.notifyIdle();
  }
}
