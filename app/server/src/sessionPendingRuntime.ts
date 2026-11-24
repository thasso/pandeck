/**
 * A started session's pending runtime selection
 * (`docs/session-runtime-switching.md`): the model, effort and account its
 * NEXT turn starts on. Setting one refuses another engine for now; applying
 * one that names another engine moves the session there
 * (`harnesses/engineSwitch.ts`).
 *
 * Setting or clearing it changes only the session row: no native model
 * change, no account move. The next turn's admission (`runtimePrompt.ts`)
 * applies it through the same seams a direct change used (the engines'
 * `switchAccount`, then the runtime adapter's `setModel` / `setReasoning`) and
 * clears it only once the turn is admitted on it. When the target cannot run,
 * at any point up to that admission, the turn is HELD, not
 * failed: nothing runs and nothing falls back to the old engine, every lane
 * keeps its work as it does for a Stop, the reason shows on the session, and a
 * change or reset of the selection offers the session its turn again.
 */
import {
  ACCOUNT_KINDS,
  accountServesModel,
  clampThinkingLevelForModel,
  harnessForModelProvider,
  isSubscriptionAccountKind,
  samePendingRuntime,
  type ModelOption,
  type SessionPendingRuntime,
  type SessionRuntimeChange,
  type SessionRuntimeChooser,
} from "@assistant/shared";
import { activeEngine } from "./harnesses/activeEngine.ts";
import { pickAccount } from "./accountRouter.ts";
import { AutomaticTurnsHeldError } from "./automaticTurnHold.ts";
import {
  credentialProfileById,
  type CredentialProfile,
} from "./credentialProfiles.ts";
import { sessionStore, type SessionMeta } from "./db/sessionStore.ts";
import { wakeSessionDelivery } from "./deliveryWake.ts";
import type { PreparedEngineSwitch } from "./harnesses/engineSwitch.ts";
import { pickerModels } from "./harnesses/models.ts";
import { AccountSwitchBlockedError } from "./session/runtime/accountRecoveryAdmission.ts";
import type { SessionRuntime } from "./session/runtime/runtime.ts";
import type { RuntimePromptDriver } from "./session/runtimePrompt.ts";
import {
  accountOffersSelection,
  accountRulesRefusal,
  assertStillEligible,
  boundAccountRulesRefusal,
  modelRefusal,
  sessionSelection,
} from "./sessionAccountMove.ts";
import { switchIdleSessionAccount } from "./sessionAccountSwitch.ts";

/**
 * A turn held because the pending selection cannot apply yet. A Stop's hold
 * class, so every lane already puts its work back as it was, spending no
 * attempt; its message is the reason the session shows.
 */
export class PendingRuntimeHeldError extends AutomaticTurnsHeldError {
  constructor(sessionId: string, message: string) {
    super(sessionId, message);
    this.name = "PendingRuntimeHeldError";
  }
}

/** Viewers and the session list; injected by tests. */
interface PendingRuntimeHost {
  /** Everyone showing the session sees its new state. */
  stateChanged(sessionId: string): Promise<void>;
  /** Publish the changed row now. */
  publishRows(): Promise<void>;
  /** Offer the session its turn again (held work). */
  wake(sessionId: string): void;
}

const defaultHost: PendingRuntimeHost = {
  async stateChanged(sessionId) {
    const { hub } = await import("./hub.ts");
    hub.getLiveById(sessionId)?.broadcastState();
    hub.sessionStateChanged(sessionId);
  },
  async publishRows() {
    const { publishSessionRowsNow } = await import("./stateTopics.ts");
    publishSessionRowsNow();
  },
  wake(sessionId) {
    wakeSessionDelivery(sessionId);
  },
};

let hostOverride: PendingRuntimeHost | undefined;

/** Test-only seam: substitute the hub and scheduler. Undefined restores them. */
export function setPendingRuntimeHostForTests(
  host: PendingRuntimeHost | undefined,
): void {
  hostOverride = host;
}

function host(): PendingRuntimeHost {
  return hostOverride ?? defaultHost;
}

/** The model option behind a provider/id pair, when any account offers it. */
function modelOption(model: {
  provider: string;
  id: string;
}): ModelOption | undefined {
  return pickerModels().find(
    (option) => option.provider === model.provider && option.id === model.id,
  );
}

function modelName(model: { provider: string; id: string }): string {
  return modelOption(model)?.name ?? model.id;
}

/** "Claude Opus · Work" — what the next turn would run on, for messages. */
function targetText(
  pending: SessionPendingRuntime,
  account?: CredentialProfile,
): string {
  return account
    ? `${modelName(pending.model)} · ${account.name}`
    : modelName(pending.model);
}

function boundAccount(
  row: SessionMeta,
  driver?: Pick<RuntimePromptDriver, "credentialProfileId">,
): CredentialProfile | undefined {
  const id = driver?.credentialProfileId ?? row.credentialProfileId;
  return id ? credentialProfileById(id) : undefined;
}

/** The engine rules a model must pass to be a same-engine target. */
function modelEngineRefusal(
  row: SessionMeta,
  source: CredentialProfile | undefined,
  model: { provider: string; id: string },
): string | undefined {
  const name = modelName(model);
  if (harnessForModelProvider(model.provider) !== activeEngine(row).harness)
    return `${name} runs on another harness; moving a session between harnesses is not available yet.`;
  if (source && !accountServesModel(source, model.provider))
    return `${name} needs another kind of account than ${source.name}; moving a session there is not available yet.`;
  return undefined;
}

function sameModel(
  a: { provider: string; id: string } | undefined,
  b: { provider: string; id: string } | undefined,
): boolean {
  return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

/**
 * Every set and reset of one session's selection, one at a time in request
 * order. Each computes from the row as the previous one left it, so two
 * partial changes both land and a reset is never undone by a setter that
 * started before it.
 */
const selectionWrites = new Map<string, Promise<void>>();

function serialized<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  const previous = selectionWrites.get(sessionId) ?? Promise.resolve();
  const run = previous.then(work);
  const settled = run.then(
    () => {},
    () => {},
  );
  selectionWrites.set(sessionId, settled);
  void settled.then(() => {
    if (selectionWrites.get(sessionId) === settled)
      selectionWrites.delete(sessionId);
  });
  return run;
}

/** How often a set recomputes after a turn's admission spent the selection under it. */
const SET_ATTEMPTS = 3;

/** Who may write the selection, asked again synchronously right before the write. */
interface PendingRuntimeWriteOptions {
  /** Throws when the caller lost its authority over the session meanwhile. */
  authorize?: () => void;
}

/**
 * Set the pending selection from a change, completing it from the current
 * pending selection, else the session's current runtime. Refuses a target
 * outside the session's engine, an unknown model, and an account that could
 * never run it; the effort is clamped to the target model. A target equal to
 * what the session runs now clears the selection. Allowed at any time, during
 * a turn too. Answers what is now pending.
 *
 * Linearizable per session: sets and resets run in request order, and a set
 * recomputes when a turn's admission spent the selection while it read the
 * session. `authorize` is checked with the write, after every await.
 */
export async function setSessionPendingRuntime(
  sessionId: string,
  change: SessionRuntimeChange,
  setBy: SessionRuntimeChooser,
  options: PendingRuntimeWriteOptions = {},
): Promise<SessionPendingRuntime | undefined> {
  const stored = await serialized(sessionId, async () => {
    for (let attempt = 1; ; attempt++) {
      options.authorize?.();
      const row = sessionStore.get(sessionId);
      if (!row) throw new Error("Session does not exist or was deleted.");
      const next = await pendingTarget(row, change, setBy);
      // Admission (`applyPendingRuntime`) is the one writer outside this
      // queue. When it spent the selection meanwhile, the session now runs
      // that target: compute again from there.
      const latest = sessionStore.get(sessionId);
      if (!latest) throw new Error("Session does not exist or was deleted.");
      if (!samePendingRuntime(latest.pendingRuntime, row.pendingRuntime)) {
        if (attempt < SET_ATTEMPTS) continue;
        throw new Error(
          "The session's next-turn selection kept changing; try again.",
        );
      }
      options.authorize?.();
      if (!samePendingRuntime(next, latest.pendingRuntime))
        sessionStore.setPendingRuntime(sessionId, next ?? null);
      return next;
    }
  });
  await announce(sessionId);
  return stored;
}

/** The complete target `change` makes of the row's selection; undefined = none. */
async function pendingTarget(
  row: SessionMeta,
  change: SessionRuntimeChange,
  setBy: SessionRuntimeChooser,
): Promise<SessionPendingRuntime | undefined> {
  if (row.scope !== "user")
    throw new Error("Only a user session can change its model or account.");
  if (!change.model && !change.thinkingLevel && !change.account)
    throw new Error("Nothing to change.");
  const current = await sessionSelection(row);
  if (!current?.model)
    throw new Error("This session has no model to change from yet.");
  const source = boundAccount(row);
  const base: SessionPendingRuntime = row.pendingRuntime ?? {
    model: current.model,
    thinkingLevel: current.thinkingLevel ?? "off",
    account: { kind: "automatic" },
    setBy,
  };

  const model = change.model ?? base.model;
  const refusal = modelEngineRefusal(row, source, model);
  if (refusal) throw new Error(refusal);
  // The model the session runs now stays choosable even when the picker's
  // catalog does not list it; its own adapter clamps the effort.
  const option = modelOption(model);
  if (!option && !sameModel(model, current.model))
    throw new Error(`${model.id} is not an available model.`);
  const requested = change.thinkingLevel ?? base.thinkingLevel;
  const thinkingLevel = option
    ? clampThinkingLevelForModel(option, requested)
    : requested;
  const account = change.account ?? base.account;
  if (account.kind === "account") {
    const target = credentialProfileById(account.id);
    if (!target) throw new Error("The chosen account no longer exists.");
    if (
      !source ||
      (target.id !== source.id && !isSubscriptionAccountKind(source.provider))
    )
      throw new Error(
        source
          ? `${source.name} is the only account that serves this session's model, so the session cannot move.`
          : "This session has no account to move from.",
      );
    const rules =
      target.id === source.id
        ? undefined
        : accountRulesRefusal(row, source, target);
    if (rules) throw new Error(rules);
    if (!accountServesModel(target, model.provider))
      throw new Error(`${target.name} cannot run ${option?.name ?? model.id}.`);
    if (!(await accountOffersSelection(target, { model, thinkingLevel })))
      throw new Error(
        `${target.name} does not offer ${option?.name ?? model.id}.`,
      );
  }

  const next: SessionPendingRuntime = { model, thinkingLevel, account, setBy };
  const unchanged =
    sameModel(next.model, current.model) &&
    next.thinkingLevel === current.thinkingLevel &&
    (next.account.kind === "automatic" || next.account.id === source?.id);
  return unchanged ? undefined : next;
}

/**
 * Drop the pending selection. No native call, no move: no trace at all. In
 * the same order as sets, so a set asked for before it cannot restore what it
 * dropped.
 */
export async function clearSessionPendingRuntime(
  sessionId: string,
): Promise<void> {
  await serialized(sessionId, async () => {
    const row = sessionStore.get(sessionId);
    if (!row) throw new Error("Session does not exist or was deleted.");
    if (row.pendingRuntime) sessionStore.setPendingRuntime(sessionId, null);
  });
  await announce(sessionId);
}

/**
 * Viewers and the list see the change, and work a held selection kept waiting
 * is offered its turn again: under the new selection, or none.
 */
async function announce(sessionId: string): Promise<void> {
  const { stateChanged, publishRows, wake } = host();
  await publishRows().catch(() => {});
  await stateChanged(sessionId).catch(() => {});
  wake(sessionId);
}

/**
 * Offer every session with a pending selection its turn again. Wired to the
 * account changes a held selection may wait on (enabled, enterprise, login,
 * bench): the held work then runs, or is held again with the current reason.
 * The scheduler starts nothing for a session with nothing waiting.
 */
export function wakePendingRuntimeSessions(): void {
  const { wake } = host();
  for (const id of sessionStore.sessionIdsWithPendingRuntime()) wake(id);
}

/**
 * What a turn whose admission applied the pending selection still owes. The
 * selection stays stored until `commit`: a refusal anywhere before it keeps it.
 */
export interface AppliedPendingRuntime {
  /** The display-only account-move marker, appended once the turn is admitted. */
  notice?: string;
  /**
   * The whole target again, synchronously, at the final admission boundary:
   * unchanged selection, model and effort, binding, account enabled,
   * enterprise, login and bench. Throws a hold that keeps the selection.
   */
  usable: () => void;
  /** The turn was admitted on the target: the selection is spent. */
  commit: () => void;
  /**
   * A switch to another engine (`harnesses/engineSwitch.ts`): the session's
   * driver there. The turn runs on it once `commit` ran; the driver the turn
   * was admitted with is released.
   */
  driver?: RuntimePromptDriver;
  /**
   * Undo a switch to another engine the turn refused before `commit`: the
   * session stays on its old binding with the selection pending.
   */
  abandon?: () => Promise<void>;
}

/**
 * Hold the turn with `reason`: kept pending, shown on the session, nothing
 * runs and nothing falls back to the old engine.
 */
function hold(sessionId: string, reason: string): PendingRuntimeHeldError {
  sessionStore.recordRunFailure(sessionId, reason);
  void host()
    .publishRows()
    .catch(() => {});
  return new PendingRuntimeHeldError(sessionId, reason);
}

/**
 * The synchronous account rules for running the target on `target`: kind,
 * enabled, enterprise requirement, login and bench.
 */
function targetRulesRefusal(
  row: Pick<SessionMeta, "requiresEnterprise">,
  source: CredentialProfile | undefined,
  target: CredentialProfile,
  pending: SessionPendingRuntime,
): string | undefined {
  const rules = !source
    ? undefined
    : target.id === source.id
      ? boundAccountRulesRefusal(row, target)
      : accountRulesRefusal(row, source, target);
  if (rules) return rules;
  if (row.requiresEnterprise && !target.enterprise)
    return `This session requires an enterprise account, and ${target.name} is not one.`;
  try {
    assertStillEligible(target, pending.model.id);
  } catch (error) {
    return errorText(error);
  }
  return undefined;
}

/**
 * Every rule for running the target on `target`: the synchronous ones, then
 * the account's model listing (offers the model at the target effort).
 */
async function targetRefusal(
  row: Pick<SessionMeta, "requiresEnterprise">,
  source: CredentialProfile | undefined,
  target: CredentialProfile,
  pending: SessionPendingRuntime,
): Promise<string | undefined> {
  return (
    targetRulesRefusal(row, source, target, pending) ??
    (await modelRefusal(target, {
      model: pending.model,
      thinkingLevel: pending.thinkingLevel,
    }))
  );
}

/**
 * Which account the target runs on: the chosen one when it passes every rule
 * now, or for Automatic the bound account when it can run the target, else
 * the router's non-degraded pick within the session's kind and enterprise
 * requirement. Answers a refusal reason instead when none can.
 */
async function resolveAccount(
  row: SessionMeta,
  source: CredentialProfile | undefined,
  pending: SessionPendingRuntime,
): Promise<{
  target?: CredentialProfile;
  refusal?: string;
  /** The chosen account a refusal names. */
  named?: CredentialProfile;
}> {
  const eligible = (target: CredentialProfile) =>
    targetRefusal(row, source, target, pending);

  if (pending.account.kind === "account") {
    const target = credentialProfileById(pending.account.id);
    if (!target) return { refusal: "The chosen account no longer exists." };
    if (!source)
      return { refusal: "This session has no account to move from." };
    if (target.id !== source.id && !isSubscriptionAccountKind(source.provider))
      return {
        refusal: `${source.name} is the only account that serves this session's model.`,
      };
    const refusal = await eligible(target);
    return refusal ? { refusal, named: target } : { target };
  }
  if (!source) return {};
  const keep = await eligible(source);
  if (!keep) return { target: source };
  if (!isSubscriptionAccountKind(source.provider)) return { refusal: keep };
  const pick = await pickAccount({
    model: { provider: pending.model.provider, modelId: pending.model.id },
    thinkingLevel: pending.thinkingLevel,
    requiresEnterprise: row.requiresEnterprise === true,
  });
  const picked =
    pick.profileId && !pick.degraded
      ? credentialProfileById(pick.profileId)
      : undefined;
  if (!picked || picked.provider !== source.provider)
    return { refusal: `no eligible account can run it (${keep})` };
  const refusal = await eligible(picked);
  return refusal ? { refusal } : { target: picked };
}

/**
 * Apply the pending selection to the turn being admitted, or throw a
 * {@link PendingRuntimeHeldError}. The caller (`runtimePrompt.ts`) calls this
 * only for a new turn that may change engine: never for a steer into a
 * running turn, a steer-only message, an account-recovery continuation or a
 * turn the provider already started. `admit` is the caller's side-effect-free
 * admission, rechecked at every engine step. Account first (the move a user
 * or coordinator picked), then model and effort through the runtime adapter,
 * then the whole target once more. The caller runs `usable` at its final
 * admission boundary and `commit` once the turn is admitted there; the
 * selection is cleared only then, so every refusal before it keeps it.
 * Answers undefined when nothing is pending.
 */
export async function applyPendingRuntime(
  driver: RuntimePromptDriver,
  admit: () => void,
  ensureLive: () => ReturnType<SessionRuntime["createSession"]>,
): Promise<AppliedPendingRuntime | undefined> {
  const id = driver.sessionId;
  const row = sessionStore.get(id);
  const pending = row?.pendingRuntime;
  if (!row || !pending) return undefined;
  const source = boundAccount(row, driver);
  const unchanged = () => {
    if (!samePendingRuntime(sessionStore.get(id)?.pendingRuntime, pending))
      throw new PendingRuntimeHeldError(
        id,
        "The next turn's model or account changed while it was being applied.",
      );
  };
  const option = modelOption(pending.model);
  const couldNot = (reason: string, account?: CredentialProfile) =>
    hold(
      id,
      `Couldn't switch to ${targetText(pending, account)}: ${reason.replace(/\.$/, "")}. The change is still pending; change or reset it to continue.`,
    );
  if (
    harnessForModelProvider(pending.model.provider) !==
    activeEngine(row).harness
  )
    return applyEngineSwitch(row, source, pending, couldNot, () => {
      admit();
      unchanged();
    });
  const engineRefusal = modelEngineRefusal(row, source, pending.model);
  if (engineRefusal) throw couldNot(engineRefusal);
  const running = driver.modelSelection?.().model ?? {
    provider: row.provider ?? "",
    id: row.model ?? "",
  };
  if (!option && !sameModel(pending.model, running))
    throw couldNot(`${pending.model.id} is no longer available`);

  const { target, refusal, named } = await resolveAccount(row, source, pending);
  if (refusal || (source && !target))
    throw couldNot(refusal ?? "no eligible account can run it", named);
  admit();
  unchanged();

  let notice: string | undefined;
  if (source && target && target.id !== source.id) {
    try {
      await switchIdleSessionAccount(driver, {
        source,
        targetId: target.id,
        requiresEnterprise: row.requiresEnterprise === true,
        admit: () => {
          admit();
          unchanged();
        },
        eligible: () => assertStillEligible(target, pending.model.id),
      });
    } catch (error) {
      if (error instanceof AutomaticTurnsHeldError) throw error;
      if (error instanceof AccountSwitchBlockedError)
        throw hold(
          id,
          `Waiting for background work on ${ACCOUNT_KINDS[source.provider].label}; stop it to switch now.`,
        );
      throw couldNot(errorText(error), target);
    }
    notice = `Switched from ${source.name} to ${target.name} — chosen by ${pending.setBy === "coordinator" ? "its coordinating session" : "you"}.`;
  }

  const live = ensureLive();
  try {
    const selected = driver.modelSelection?.();
    if (!sameModel(selected?.model, pending.model)) {
      admit();
      await live.setModel(pending.model);
    }
    if (driver.modelSelection?.().thinkingLevel !== pending.thinkingLevel) {
      admit();
      await live.setReasoning(pending.thinkingLevel);
    }
  } catch (error) {
    if (error instanceof AutomaticTurnsHeldError) throw error;
    throw couldNot(errorText(error), target);
  }

  // The engine steps awaited: the account may have lost its login, been
  // disabled or benched, or stopped listing the model meanwhile. The whole
  // target again, its model listing last: nothing awaits after this.
  if (target) {
    const late = await targetRefusal(
      sessionStore.get(id) ?? row,
      source,
      credentialProfileById(target.id) ?? target,
      pending,
    );
    if (late) throw couldNot(late, target);
  }
  admit();
  unchanged();
  const boundTo = target?.id;
  return {
    ...(notice ? { notice } : {}),
    usable: () => {
      unchanged();
      const now = driver.modelSelection?.();
      if (
        now &&
        (!sameModel(now.model, pending.model) ||
          // An uncatalogued model's own adapter clamps its effort.
          (option && now.thinkingLevel !== pending.thinkingLevel))
      )
        throw couldNot("the session's model changed while it switched");
      if (!boundTo) return;
      const profile = credentialProfileById(boundTo);
      const latest = sessionStore.get(id);
      if (!profile || !latest)
        throw couldNot("The chosen account no longer exists", target);
      if (
        driver.credentialProfileId !== boundTo ||
        latest.credentialProfileId !== boundTo
      )
        throw couldNot(
          `${profile.name} became unavailable while the session switched to it`,
          profile,
        );
      const refusal = targetRulesRefusal(latest, source, profile, pending);
      if (refusal) throw couldNot(refusal, profile);
    },
    commit: () => {
      // Compare-and-clear: only the selection this turn applied is spent.
      if (!samePendingRuntime(sessionStore.get(id)?.pendingRuntime, pending))
        return;
      sessionStore.setPendingRuntime(id, null);
      void host()
        .publishRows()
        .catch(() => {});
      void host()
        .stateChanged(id)
        .catch(() => {});
    },
  };
}

/**
 * The account rules for running a model of another engine on `target`: it
 * serves the model, is enabled, meets the enterprise requirement, is logged
 * in and not benched for the model.
 */
function engineTargetRulesRefusal(
  row: Pick<SessionMeta, "requiresEnterprise">,
  target: CredentialProfile,
  pending: SessionPendingRuntime,
): string | undefined {
  if (!accountServesModel(target, pending.model.provider))
    return `${target.name} does not run ${modelName(pending.model)}.`;
  if (!target.enabled) return `${target.name} is disabled.`;
  if (row.requiresEnterprise && !target.enterprise)
    return `This session requires an enterprise account, and ${target.name} is not one.`;
  try {
    assertStillEligible(target, pending.model.id);
  } catch (error) {
    return errorText(error);
  }
  return undefined;
}

async function engineTargetRefusal(
  row: Pick<SessionMeta, "requiresEnterprise">,
  target: CredentialProfile,
  pending: SessionPendingRuntime,
): Promise<string | undefined> {
  return (
    engineTargetRulesRefusal(row, target, pending) ??
    (await modelRefusal(target, {
      model: pending.model,
      thinkingLevel: pending.thinkingLevel,
    }))
  );
}

/**
 * Which account runs a model of another engine: the chosen one when it passes
 * every rule now, or for Automatic the router's non-degraded pick of the
 * model's kind within the session's enterprise requirement. The session's
 * bound account serves another kind, so it is never kept.
 */
async function resolveEngineAccount(
  row: SessionMeta,
  pending: SessionPendingRuntime,
): Promise<{
  target?: CredentialProfile;
  refusal?: string;
  named?: CredentialProfile;
}> {
  if (pending.account.kind === "account") {
    const target = credentialProfileById(pending.account.id);
    if (!target) return { refusal: "The chosen account no longer exists." };
    const refusal = await engineTargetRefusal(row, target, pending);
    return refusal ? { refusal, named: target } : { target };
  }
  const pick = await pickAccount({
    model: { provider: pending.model.provider, modelId: pending.model.id },
    thinkingLevel: pending.thinkingLevel,
    requiresEnterprise: row.requiresEnterprise === true,
  });
  const picked =
    pick.profileId && !pick.degraded
      ? credentialProfileById(pick.profileId)
      : undefined;
  if (!picked) return { refusal: "no eligible account can run it" };
  const refusal = await engineTargetRefusal(row, picked, pending);
  return refusal ? { refusal } : { target: picked };
}

/**
 * Apply a selection whose model runs on another engine: resolve its account,
 * then move the session there (`prepareEngineSwitch`) up to the commit, which
 * the turn runs once it is admitted on the new driver. Every refusal holds
 * the turn as on one engine; a refusal after the move undoes it.
 */
async function applyEngineSwitch(
  row: SessionMeta,
  source: CredentialProfile | undefined,
  pending: SessionPendingRuntime,
  couldNot: (reason: string, account?: CredentialProfile) => Error,
  recheck: () => void,
): Promise<AppliedPendingRuntime> {
  const id = row.id;
  if (!modelOption(pending.model))
    throw couldNot(`${pending.model.id} is no longer available`);
  const { target, refusal, named } = await resolveEngineAccount(row, pending);
  if (!target)
    throw couldNot(refusal ?? "no eligible account can run it", named);
  recheck();

  let prepared: PreparedEngineSwitch;
  try {
    // Loaded on use: the engine stores it drives sit above this module.
    const { prepareEngineSwitch } = await import("./harnesses/engineSwitch.ts");
    prepared = await prepareEngineSwitch(
      id,
      {
        harness: harnessForModelProvider(pending.model.provider),
        model: pending.model,
        thinkingLevel: pending.thinkingLevel,
        credentialProfileId: target.id,
      },
      pending,
      recheck,
    );
  } catch (error) {
    if (error instanceof AutomaticTurnsHeldError) throw error;
    if (error instanceof AccountSwitchBlockedError)
      throw hold(
        id,
        `Waiting for background work on ${source ? ACCOUNT_KINDS[source.provider].label : "the session's engine"}; stop it to switch now.`,
      );
    throw couldNot(errorText(error), target);
  }
  // The move awaited: the account may have lost its login, been disabled or
  // benched, or stopped listing the model meanwhile.
  try {
    const late = await engineTargetRefusal(
      sessionStore.get(id) ?? row,
      credentialProfileById(target.id) ?? target,
      pending,
    );
    if (late) throw couldNot(late, target);
    recheck();
  } catch (error) {
    await prepared.abandon();
    throw error;
  }
  return {
    driver: prepared.driver,
    abandon: prepared.abandon,
    usable: () => {
      recheck();
      try {
        prepared.usable();
      } catch (error) {
        throw couldNot(errorText(error), target);
      }
      const profile = credentialProfileById(target.id);
      if (!profile)
        throw couldNot("The chosen account no longer exists", target);
      const late = engineTargetRulesRefusal(
        sessionStore.get(id) ?? row,
        profile,
        pending,
      );
      if (late) throw couldNot(late, profile);
    },
    commit: () => {
      // One transaction: the new binding, its projection and the selection's
      // compare-and-clear.
      prepared.commit();
      void host()
        .publishRows()
        .catch(() => {});
      void host()
        .stateChanged(id)
        .catch(() => {});
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
