import { isSubscriptionAccountKind } from "@assistant/shared";
import { isSubscriptionAccountModel } from "@assistant/shared/accountHealth";
import { pickAccount } from "./accountRouter.ts";
import { formatLocalDateTime } from "./googleTime.ts";
import { markUsageProfileDirty } from "./usageCache.ts";
import { readAccountBench, readAccountHealth } from "./accountHealth.ts";
import { gatewayServesProfile } from "./gatewayLink.ts";
import { loginEnded } from "./providerErrors.ts";
import {
  credentialProfileById,
  credentialProfileHasCredential,
  type CredentialProfile,
} from "./credentialProfiles.ts";
import { assertSessionAccountSwitch } from "./sessionAccount.ts";
import { sessionClaudePin } from "./harnesses/curatedModels.ts";
import { sessionStore } from "./db/sessionStore.ts";
import type { RuntimePromptDriver } from "./session/runtimePrompt.ts";
import type {
  LiveRuntimeSession,
  RunFailureReport,
  SessionRunEvent,
  RunOutcome,
} from "./session/runtime/liveSession.ts";

import {
  AutomaticTurnsHeldError,
  automaticTurnsHeld,
} from "./automaticTurnHold.ts";
import { RunFailedError } from "./session/runtime/errors.ts";
import {
  assertAccountRecoveryAdmission,
  AccountSwitchBlockedError,
  reserveAccountRecovery,
  releaseAccountRecovery,
  ownsAccountRecovery,
  type AccountRecoveryTicket,
} from "./session/runtime/accountRecoveryAdmission.ts";

type Failure = RunFailureReport & {
  failure: NonNullable<RunFailureReport["failure"]>;
};
type Selection = NonNullable<
  ReturnType<NonNullable<RuntimePromptDriver["modelSelection"]>>
>;
interface Attempt {
  runId: string;
  profileId: string | undefined;
  provider: string | undefined;
  stopGeneration: number;
  failure?: RunFailureReport;
}
interface Recovery {
  ticket: AccountRecoveryTicket;
  attempt: Attempt & { profileId: string; failure: Failure };
  selection: Selection;
  signature: string;
  releaseAdmission: () => void;
}
interface Controller {
  driver: RuntimePromptDriver;
  dispose: () => void;
  prepare: (ticket?: AccountRecoveryTicket) => void;
}
const controllers = new WeakMap<LiveRuntimeSession, Controller>();
/** A model selection's identity: a move is refused once it changes. */
export function selectionSignature(selection: Selection | undefined): string {
  return JSON.stringify({
    model: selection?.model
      ? { provider: selection.model.provider, id: selection.model.id }
      : null,
    thinkingLevel: selection?.thinkingLevel,
  });
}

/**
 * Sessions moved before their turn (off a disabled account, or onto the
 * enterprise account they require) whose next run has not started yet. That
 * run is a cross-account move like failover's, even when the turn that moved
 * it was refused, so the controller consumes the entry when it starts.
 */
const movedBeforeTurn = new Map<string, string>();

/**
 * A turn starting on a disabled account, or on a non-enterprise account while
 * the session requires enterprise, first moves the idle session to the next
 * eligible account within its enterprise requirement, through the same engine
 * switch as limit failover. `admit` is the caller's side-effect-free turn
 * admission, rechecked at every switch step with the target's health, bench
 * and the model selection. Answers the display-only marker for the caller to
 * append once the turn is admitted, and `usable`, the target-bound check the
 * caller repeats right before that admission; with no eligible account the
 * turn is refused. A running turn is never interrupted.
 */
export async function moveOffDisabledAccount(
  driver: RuntimePromptDriver,
  admit: () => void,
): Promise<{ notice: string; usable: () => void } | undefined> {
  const source = driver.credentialProfileId
    ? credentialProfileById(driver.credentialProfileId)
    : undefined;
  const selected = driver.modelSelection?.();
  // An account that is no subscription login serves its models alone, so a
  // turn on it while disabled has nowhere to move: it is refused.
  if (
    source &&
    !source.enabled &&
    !driver.isRunning &&
    !isSubscriptionAccountKind(source.provider)
  )
    throw new Error(
      `${source.name} is disabled and no other eligible account is available. Enable it to continue this session.`,
    );
  const requiresEnterprise =
    sessionStore.get(driver.id)?.requiresEnterprise === true;
  // An enabled account that is not enterprise, on a session that requires
  // one (set after creation, or the account lost its flag), moves as well.
  const disabled = source !== undefined && !source.enabled;
  if (
    !source ||
    (!disabled && (!requiresEnterprise || source.enterprise)) ||
    driver.isRunning ||
    !driver.switchAccount ||
    !selected?.model ||
    !isSubscriptionAccountModel(source.provider, selected.model.provider)
  )
    return undefined;
  const model = selected.model;
  const pick = await pickAccount({
    model: { provider: model.provider, modelId: model.id },
    ...(selected.thinkingLevel
      ? { thinkingLevel: selected.thinkingLevel }
      : {}),
    requiresEnterprise,
    // A pinned session moves only where its exact version runs.
    ...sessionClaudePin(driver.id, model.provider, model.id),
  });
  const target =
    pick.profileId && !pick.degraded
      ? credentialProfileById(pick.profileId)
      : undefined;
  if (!target)
    throw new Error(
      disabled
        ? `${source.name} is disabled and no other eligible account is available. Enable an account to continue this session.`
        : `This session requires an enterprise account, and no eligible enterprise account is available. It remains on ${source.name}.`,
    );
  const unavailable = () =>
    new Error(
      disabled
        ? `${target.name} became unavailable while this session was moving off the disabled ${source.name}.`
        : `${target.name} became unavailable while this session was moving to an enterprise account.`,
    );
  const eligible = () => {
    if (
      selectionSignature(driver.modelSelection?.()) !==
        selectionSignature(selected) ||
      readAccountHealth(target.id, credentialProfileHasCredential(target.id))
        .state === "needs-login" ||
      readAccountBench(target.id, model.id)
    )
      throw unavailable();
  };
  await switchIdleSessionAccount(driver, {
    source,
    targetId: target.id,
    requiresEnterprise,
    admit,
    eligible,
  });
  const usable = () => {
    const profile = credentialProfileById(target.id);
    const row = sessionStore.get(driver.id);
    if (
      !profile?.enabled ||
      driver.credentialProfileId !== target.id ||
      row?.credentialProfileId !== target.id ||
      (row.requiresEnterprise && !profile.enterprise)
    )
      throw unavailable();
    eligible();
  };
  usable();
  return {
    notice: disabled
      ? `Switched from ${source.name} to ${target.name} — ${source.name} is disabled.`
      : `Switched from ${source.name} to ${target.name} — this session requires an enterprise account.`,
    usable,
  };
}

/**
 * The engine switch of an idle session whose next turn has not started: the
 * pre-turn move and the user's or a coordinator's explicit move. `admit` is
 * the caller's authority and admission, `eligible` its target check; both run
 * at every engine step up to the binding commit. Only such a move may rebind
 * a session with no native history, since nothing has run on the source
 * account yet. The next run that starts counts as moved.
 */
export async function switchIdleSessionAccount(
  driver: RuntimePromptDriver,
  move: {
    source: Pick<CredentialProfile, "id" | "provider">;
    targetId: string;
    requiresEnterprise: boolean;
    admit: () => void;
    eligible: () => void;
  },
): Promise<void> {
  if (!driver.switchAccount)
    throw new Error("This session cannot switch accounts.");
  const enterprise = move.requiresEnterprise
    ? { requireEnterprise: true as const }
    : {};
  await driver.switchAccount(
    move.targetId,
    () => {
      move.admit();
      assertSessionAccountSwitch(
        driver.id,
        move.source.id,
        move.targetId,
        move.source.provider,
        enterprise,
      );
      move.eligible();
    },
    { allowWithoutHistory: true, ...enterprise },
  );
  movedBeforeTurn.set(driver.id, move.source.id);
}

/** Called immediately before runtime.prompt, after asynchronous admission. */
export function prepareAccountRecoveryTurn(
  live: LiveRuntimeSession,
  ticket?: AccountRecoveryTicket,
): void {
  controllers.get(live)?.prepare(ticket);
}

/** Watches both facade prompts and provider-initiated runs on the same live wrapper. */
export function installAccountRecovery(
  live: LiveRuntimeSession,
  driver: RuntimePromptDriver,
  admit: () => void,
  retainAdmission: () => () => void,
  resume: (ticket: AccountRecoveryTicket, admit: () => void) => Promise<void>,
): void {
  if (!driver.switchAccount || !driver.modelSelection) return;
  const previous = controllers.get(live);
  if (previous?.driver === driver) return;
  previous?.dispose();
  let attempt: Attempt | undefined;
  let nextTicket: AccountRecoveryTicket | undefined;
  let activeTicket: AccountRecoveryTicket | undefined;
  let candidate: Recovery | undefined;
  let pumping = false;
  let moved = false;
  const visited = new Set<string>();
  const stripped = new Set<string>();
  const settlements = new Map<
    string,
    ReturnType<LiveRuntimeSession["deferRunSettlement"]>
  >();
  let terminalOutcome: RunOutcome | undefined;
  let terminalFailure: RunFailureReport | undefined;

  function defer(runId: string): void {
    if (!settlements.has(runId))
      settlements.set(runId, live.deferRunSettlement(runId));
  }

  function settle(): void {
    if (!terminalOutcome) return;
    const pending = [...settlements.values()];
    settlements.clear();
    for (const [index, finish] of pending.entries())
      finish(terminalOutcome, terminalFailure, index === 0);
  }

  function recoverable(ended: Attempt): ended is Recovery["attempt"] {
    const facts = ended.failure?.failure;
    const source = ended.profileId
      ? credentialProfileById(ended.profileId)
      : undefined;
    const selection = driver.modelSelection?.();
    return !!(
      ended.profileId &&
      facts &&
      // A refusal PA made before any provider call is no account evidence.
      !facts.localPolicy &&
      source &&
      selection?.model &&
      driver.credentialProfileId === ended.profileId &&
      sessionStore.get(driver.id)?.credentialProfileId === ended.profileId &&
      live.stopGeneration === ended.stopGeneration &&
      isSubscriptionAccountModel(source.provider, ended.provider) &&
      isSubscriptionAccountModel(source.provider, selection.model.provider) &&
      (facts.kind === "quota" ||
        facts.kind === "rate_limit" ||
        loginEnded(facts, gatewayServesProfile(source)) ||
        // A cybersecurity refusal moves once, from a personal account to an
        // enterprise one; refused again on enterprise, the failure stands.
        (facts.cyberRefusal === true && !source.enterprise) ||
        (moved &&
          facts.encryptedReasoningRejected &&
          !stripped.has(ended.profileId)))
    );
  }

  function release(ticket: AccountRecoveryTicket): void {
    if (!releaseAccountRecovery(driver.id, ticket)) return;
    live.notifyIdle();
  }

  function guard(recovery: Recovery): void {
    assertAccountRecoveryAdmission(driver.id, recovery.ticket);
    admit();
    if (
      driver.released ||
      driver.isRunning ||
      live.isRunning ||
      live.stopGeneration !== recovery.attempt.stopGeneration ||
      !sessionStore.get(driver.id) ||
      selectionSignature(driver.modelSelection?.()) !== recovery.signature
    )
      throw new Error(
        "The session changed before account recovery could resume.",
      );
  }

  function admitContinuation(recovery: Recovery, profileId: string): void {
    guard(recovery);
    const profile = credentialProfileById(profileId);
    const row = sessionStore.get(driver.id);
    const modelId = recovery.selection.model?.id;
    if (
      !profile?.enabled ||
      driver.credentialProfileId !== profileId ||
      row?.credentialProfileId !== profileId ||
      (row.requiresEnterprise && !profile.enterprise) ||
      readAccountHealth(profileId, credentialProfileHasCredential(profileId))
        .state === "needs-login" ||
      (modelId && readAccountBench(profileId, modelId))
    )
      throw new Error(
        "The replacement account became unavailable before continuation.",
      );
  }

  function markerReason(
    failure: Failure,
    profileId: string,
    modelId: string,
  ): string {
    if (failure.failure.cyberRefusal)
      return "cybersecurity refusal. This session now requires an enterprise account";
    const source = credentialProfileById(profileId);
    if (
      loginEnded(
        failure.failure,
        source !== undefined && gatewayServesProfile(source),
      )
    )
      return "login expired";
    const limit = readAccountBench(profileId, modelId);
    const model = failure.failure.limitModel
      ? `${failure.failure.limitModel} `
      : "";
    const reason =
      failure.failure.kind === "rate_limit" ? "rate limit" : "usage limit";
    return `${model}${reason}${limit ? ` until ${formatLocalDateTime(new Date(limit.until).toISOString())}` : ""}`;
  }

  async function recover(recovery: Recovery): Promise<void> {
    const { profileId, failure } = recovery.attempt;
    guard(recovery);
    // A different account may reject opaque reasoning. Retry that same account
    // once, removing only those blocks and retaining the native physical history.
    if (
      moved &&
      failure.failure.encryptedReasoningRejected &&
      driver.dropEncryptedReasoning &&
      !stripped.has(profileId)
    ) {
      stripped.add(profileId);
      if (
        !(await driver.dropEncryptedReasoning(() =>
          admitContinuation(recovery, profileId),
        ))
      )
        return;
      admitContinuation(recovery, profileId);
      await resume(recovery.ticket, () =>
        admitContinuation(recovery, profileId),
      );
      return;
    }
    visited.add(profileId);
    const source = credentialProfileById(profileId);
    const selected = recovery.selection.model;
    if (!source || !selected) return;
    // A cybersecurity refusal moves only to an enterprise account, and the
    // commit makes the session enterprise-only with its new binding.
    const cyber = failure.failure.cyberRefusal === true;
    const enterprise = cyber ? { requireEnterprise: true as const } : {};
    const pick = await pickAccount({
      model: { provider: selected.provider, modelId: selected.id },
      ...(recovery.selection.thinkingLevel
        ? { thinkingLevel: recovery.selection.thinkingLevel }
        : {}),
      requiresEnterprise:
        cyber || sessionStore.get(driver.id)?.requiresEnterprise === true,
      excludeProfileIds: [...visited],
      // A pinned session moves only where its exact version runs.
      ...sessionClaudePin(driver.id, selected.provider, selected.id),
    });
    guard(recovery);
    if (!pick.profileId || pick.degraded || visited.has(pick.profileId)) {
      live.appendNotice(
        cyber
          ? `No enterprise account is available for this cybersecurity refusal. This session remains on ${source.name}.`
          : `No other eligible account is available. This session remains on ${source.name}.`,
      );
      return;
    }
    const target = credentialProfileById(pick.profileId);
    if (
      !target ||
      !target.enabled ||
      readAccountHealth(target.id, credentialProfileHasCredential(target.id))
        .state === "needs-login" ||
      readAccountBench(target.id, selected.id)
    ) {
      live.appendNotice(
        "The replacement account became unavailable. The session remains on its current account.",
      );
      return;
    }
    // Recovery never passes `allowWithoutHistory`: the failed turn ran, so a
    // session without native history cannot move without losing it.
    await driver.switchAccount!(
      target.id,
      () => {
        guard(recovery);
        assertSessionAccountSwitch(
          driver.id,
          profileId,
          target.id,
          source.provider,
          enterprise,
        );
        if (
          readAccountHealth(
            target.id,
            credentialProfileHasCredential(target.id),
          ).state === "needs-login" ||
          readAccountBench(target.id, selected.id)
        )
          throw new Error("The replacement account became unavailable.");
      },
      enterprise,
    );
    // The caller's deferred completion now belongs to the replacement. Keep
    // usage for every moved-from native attempt dirty as well.
    try {
      markUsageProfileDirty(profileId);
    } catch {
      console.warn(
        "[account-switch] Could not mark the source account usage dirty.",
      );
    }
    moved = true;
    visited.add(target.id);
    live.appendNotice(
      `Switched from ${source.name} to ${target.name} — ${markerReason(failure, profileId, selected.id)}.`,
    );
    admitContinuation(recovery, target.id);
    await resume(recovery.ticket, () => admitContinuation(recovery, target.id));
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (candidate) {
        const current = candidate;
        candidate = undefined;
        try {
          await recover(current);
        } catch (error) {
          // Native failures already have their normal diagnostic. A failed move
          // adds no provider prose, tokens, filesystem paths or hidden user turn.
          if (
            !(error instanceof AutomaticTurnsHeldError) &&
            !(error instanceof RunFailedError) &&
            !automaticTurnsHeld(driver.id) &&
            ownsAccountRecovery(driver.id, current.ticket) &&
            live.stopGeneration === current.attempt.stopGeneration
          ) {
            try {
              live.appendNotice(
                error instanceof AccountSwitchBlockedError
                  ? error.message
                  : "The account switch could not safely resume this session. Its last failure is unchanged.",
              );
            } catch {
              console.warn(
                "[account-switch] Could not append the recovery notice.",
              );
            }
          }
        } finally {
          current.releaseAdmission();
        }
      }
    } finally {
      try {
        settle();
      } finally {
        pumping = false;
        const ticket = activeTicket;
        activeTicket = undefined;
        if (ticket) release(ticket);
      }
    }
  }

  function observe(event: SessionRunEvent): void {
    if (event.type === "started") {
      const continuing =
        nextTicket && ownsAccountRecovery(driver.id, nextTicket);
      if (continuing && settlements.size) defer(event.runId);
      if (!continuing) {
        visited.clear();
        stripped.clear();
        const movedFrom = movedBeforeTurn.get(driver.id);
        movedBeforeTurn.delete(driver.id);
        moved = movedFrom !== undefined;
        if (movedFrom) visited.add(movedFrom);
      }
      nextTicket = undefined;
      attempt = {
        runId: event.runId,
        profileId: driver.credentialProfileId,
        provider: event.modelProvider,
        stopGeneration: live.stopGeneration,
      };
    } else if (event.type === "failed") {
      if (attempt?.runId === event.report.runId) {
        attempt.failure = event.report;
        if (recoverable(attempt)) defer(event.report.runId);
      }
    } else {
      const ended = attempt;
      attempt = undefined;
      terminalOutcome = event.outcome;
      terminalFailure = ended?.failure;
      if (
        !ended ||
        ended.runId !== event.outcome.runId ||
        event.outcome.stopReason !== "error" ||
        event.outcome.abortRequested ||
        !recoverable(ended)
      ) {
        if (!pumping) settle();
        return;
      }
      const facts = ended.failure.failure;
      const selection = driver.modelSelection?.();
      if (!selection?.model) {
        if (!pumping) settle();
        return;
      }
      let releaseAdmission: () => void;
      try {
        admit();
        releaseAdmission = retainAdmission();
      } catch {
        if (!pumping) settle();
        return;
      }
      defer(event.outcome.runId);
      const ticket = activeTicket ?? reserveAccountRecovery(driver.id);
      activeTicket = ticket;
      candidate = {
        ticket,
        attempt: {
          ...ended,
          profileId: ended.profileId,
          failure: { ...ended.failure, failure: facts },
        },
        selection,
        signature: selectionSignature(selection),
        releaseAdmission,
      };
      // Reservation is synchronous, before run waiters/idle queues. The native
      // driver is allowed to finish unwinding before any engine move begins.
      queueMicrotask(() => {
        void pump().catch(() => {
          console.warn("[account-switch] Recovery could not finish.");
        });
      });
    }
  }
  const unsubscribe = live.subscribeRuns(observe);
  controllers.set(live, {
    driver,
    dispose: unsubscribe,
    prepare: (ticket) => {
      if (!live.isRunning) nextTicket = ticket;
    },
  });
}
