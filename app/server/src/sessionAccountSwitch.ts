import { isSubscriptionAccountModel } from "@assistant/shared/accountHealth";
import { pickAccount } from "./accountRouter.ts";
import { formatLocalDateTime } from "./googleTime.ts";
import { markUsageProfileDirty } from "./usageCache.ts";
import { readAccountBench, readAccountHealth } from "./accountHealth.ts";
import {
  credentialProfileById,
  credentialProfileHasCredential,
} from "./credentialProfiles.ts";
import { assertSessionAccountSwitch } from "./sessionAccount.ts";
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
function signature(selection: Selection | undefined): string {
  return JSON.stringify({
    model: selection?.model
      ? { provider: selection.model.provider, id: selection.model.id }
      : null,
    thinkingLevel: selection?.thinkingLevel,
  });
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
      source &&
      selection?.model &&
      driver.credentialProfileId === ended.profileId &&
      sessionStore.get(driver.id)?.credentialProfileId === ended.profileId &&
      live.stopGeneration === ended.stopGeneration &&
      isSubscriptionAccountModel(source.provider, ended.provider) &&
      isSubscriptionAccountModel(source.provider, selection.model.provider) &&
      (facts.kind === "quota" ||
        facts.kind === "rate_limit" ||
        facts.loginDeath ||
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
      signature(driver.modelSelection?.()) !== recovery.signature
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
    if (failure.failure.loginDeath) return "login expired";
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
    const pick = await pickAccount({
      model: { provider: selected.provider, modelId: selected.id },
      ...(recovery.selection.thinkingLevel
        ? { thinkingLevel: recovery.selection.thinkingLevel }
        : {}),
      requiresEnterprise:
        sessionStore.get(driver.id)?.requiresEnterprise === true,
      excludeProfileIds: [...visited],
    });
    guard(recovery);
    if (!pick.profileId || pick.degraded || visited.has(pick.profileId)) {
      live.appendNotice(
        `No other eligible account is available. This session remains on ${source.name}.`,
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
    await driver.switchAccount!(target.id, () => {
      guard(recovery);
      assertSessionAccountSwitch(
        driver.id,
        profileId,
        target.id,
        source.provider,
      );
      if (
        readAccountHealth(target.id, credentialProfileHasCredential(target.id))
          .state === "needs-login" ||
        readAccountBench(target.id, selected.id)
      )
        throw new Error("The replacement account became unavailable.");
    });
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
        moved = false;
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
        signature: signature(selection),
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
