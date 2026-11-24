/**
 * The cross-harness switch's store move (`docs/session-runtime-switching.md`
 * "Store move"): a session leaves the engine its active binding names and
 * opens on the other one under the same app id. Everything before the commit
 * can be undone; the commit is one transaction (`sessionStore.switchEngineBinding`)
 * that the turn's admission runs once the turn is admitted on the target, as
 * it spends a same-engine pending selection.
 *
 * The switching fence (`engineSwitchFence.ts`) is up from the release until
 * the commit or the abandon, so nothing reopens the engine the session leaves
 * or drives the one it moves to before its binding commits.
 */
import {
  accountServesModel,
  sessionModeOrDefault,
  type Harness,
  type SessionPendingRuntime,
  type ThinkingLevel,
} from "@assistant/shared";
import { claudeSdkStore } from "../claudeSdk/claudeSdkStore.ts";
import {
  claudeTranscriptResumable,
  copyClaudeSessionForAccount,
} from "../claudeSdk/profileSessionStore.ts";
import { existsSync } from "node:fs";
import { credentialProfileById } from "../credentialProfiles.ts";
import { sessionStore, type SessionMeta } from "../db/sessionStore.ts";
import type { SessionEngineBinding } from "../db/sessionEngineBinding.ts";
import type { LiveSession } from "../harness.ts";
import { piStore } from "../piSdk/piStore.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";
import { piNativeFile } from "../sessionStorage.ts";
import { subscribeSessionRunStarted } from "../session/runtime/liveSession.ts";
import { withCheckedCheckout } from "../worktrees/sessionCwd.ts";
import {
  isSwitchingEngines,
  raiseEngineSwitchFence,
} from "./engineSwitchFence.ts";
import { harnessRegistry } from "./registry.ts";

/** What the session runs on after the switch. */
export interface EngineSwitchTarget {
  harness: Harness;
  model: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  credentialProfileId: string;
}

/** A store move done up to its commit. */
export interface PreparedEngineSwitch {
  /** The session on its new engine; the turn runs on it once committed. */
  driver: LiveSession;
  /**
   * The earlier binding of the target engine whose native session the open
   * resumed (a return); undefined for a fresh native session.
   */
  resumed?: SessionEngineBinding;
  /**
   * Synchronously, at the turn's final admission boundary: throws when the
   * switch can no longer commit (the session's binding moved, the session was
   * deleted, the new engine let it go, or the switch already ended).
   */
  usable(): void;
  /**
   * The turn was admitted on the new engine: commit its binding and the
   * selection's compare-and-clear in one transaction, and lift the fence.
   * Run right after {@link usable}, with nothing awaited between.
   */
  commit(): void;
  /**
   * Undo the move before its commit: the new engine lets the session go, an
   * account copy is rolled back and the fence lifts. The row still names the
   * old binding, so the old engine reopens the session on its next use. Does
   * nothing after a commit or a previous abandon.
   */
  abandon(): Promise<void>;
}

/** One account's copy of a resumed Claude transcript, until the switch ends. */
interface Transfer {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * The newest earlier binding of the target's engine, and for Claude whether
 * its native session can resume (staging a copy for another account). Runs
 * behind the fence: a copy writes the destination account's transcript, which
 * only the switch holding the session's fence may touch. pi decides at its
 * open (`piStore.openForBinding`), whose answer is what the commit records.
 */
async function planResume(
  row: SessionMeta,
  target: EngineSwitchTarget,
): Promise<{
  earlier?: SessionEngineBinding;
  resumed?: SessionEngineBinding;
  transfer?: Transfer;
}> {
  const earlier = sessionStore
    .bindings(row.id)
    .filter((binding) => binding.harness === target.harness)
    .at(-1);
  if (target.harness === "pi") return earlier ? { earlier } : {};
  const native = earlier?.nativeSessionId;
  const from = earlier?.credentialProfileId;
  if (!earlier || !native || !from) return {};
  if (from === target.credentialProfileId)
    return (await claudeTranscriptResumable(from, native))
      ? { resumed: earlier }
      : {};
  try {
    const transfer = await copyClaudeSessionForAccount(
      from,
      target.credentialProfileId,
      native,
    );
    return { resumed: earlier, transfer };
  } catch (error) {
    console.warn(
      `[engine-switch] ${row.id}: the earlier Claude session cannot move to the new account; starting a new one (${error instanceof Error ? error.message : String(error)}).`,
    );
    return {};
  }
}

/**
 * Whether the target needs another kind of account than the active binding's:
 * within pi, OpenAI and OpenAI-compatible accounts are separate bindings of
 * one transcript, so a move between them is a switch like another harness.
 */
function changesAccountKind(
  active: SessionEngineBinding,
  target: EngineSwitchTarget,
): boolean {
  const from = active.credentialProfileId
    ? credentialProfileById(active.credentialProfileId)
    : undefined;
  return !!from && !accountServesModel(from, target.model.provider);
}

/**
 * The earlier binding whose native session a switch onto `harness` would
 * resume: the newest one on that engine, judged as {@link planResume} and the
 * open judge it but without touching native data. For the inspector's handoff
 * estimate (Q29). pi: the app id's transcript is there (D1). Claude: the same
 * account still holds it, or another account would get a copy.
 */
export async function bindingSwitchWouldResume(
  sessionId: string,
  harness: Harness,
  targetAccountId: string | undefined,
): Promise<SessionEngineBinding | undefined> {
  const earlier = sessionStore
    .bindings(sessionId)
    .filter((binding) => binding.harness === harness)
    .at(-1);
  if (!earlier) return undefined;
  if (earlier.harness === "pi")
    return existsSync(piNativeFile(sessionId, sessionId)) ? earlier : undefined;
  const native = earlier.nativeSessionId;
  const from = earlier.credentialProfileId;
  if (!native || !from) return undefined;
  if (targetAccountId && targetAccountId !== from) return earlier;
  return (await claudeTranscriptResumable(from, native)) ? earlier : undefined;
}

/** Let the session go from `harness`, inside the switching turn's admission. */
function release(
  harness: Harness,
  sessionId: string,
  admit: () => void,
): Promise<void> {
  return harness === "pi"
    ? piStore.releaseForSwitch(sessionId, admit)
    : claudeSdkStore.releaseForSwitch(sessionId, admit);
}

/**
 * Open the session on the target engine, on the binding the switch starts.
 * Answers the driver and the earlier binding whose native session the open
 * actually resumed: pi's transcript may be gone, and pi then starts over.
 */
async function open(
  row: SessionMeta,
  target: EngineSwitchTarget,
  plan: { earlier?: SessionEngineBinding; resumed?: SessionEngineBinding },
  cwd: string | undefined,
): Promise<{ driver: LiveSession; resumed?: SessionEngineBinding }> {
  const mode = sessionModeOrDefault(row.mode);
  if (target.harness === "pi") {
    const opened = await piStore.openForBinding(row.id, {
      kind: row.agentType,
      model: target.model,
      thinkingLevel: target.thinkingLevel,
      credentialProfileId: target.credentialProfileId,
      mode,
      ...(cwd !== undefined ? { cwd } : {}),
    });
    return {
      driver: opened.session,
      ...(opened.resumed && plan.earlier ? { resumed: plan.earlier } : {}),
    };
  }
  const { resumed } = plan;
  const driver = await withCheckedCheckout(row.id, undefined, (checkout) =>
    claudeSdkStore.openForBinding(
      row.id,
      {
        model: target.model.id,
        thinkingLevel: target.thinkingLevel,
        credentialProfileId: target.credentialProfileId,
        providerSessionId: resumed?.nativeSessionId,
        agentType: row.agentType,
        mode,
        title: row.title,
        createdAt: row.createdAt,
        ...(cwd !== undefined ? { cwd } : {}),
      },
      checkout,
    ),
  );
  return { driver, ...(resumed ? { resumed } : {}) };
}

/** The session as the engine `harness` holds it resident, if it does. */
function residentOn(
  harness: Harness,
  sessionId: string,
): LiveSession | undefined {
  return harness === "pi"
    ? piStore.getLiveById(sessionId)
    : claudeSdkStore.get(sessionId);
}

/**
 * Move the session to `target`'s engine, up to the commit. `admit` is the
 * switching turn's own side-effect-free admission, rechecked at every step;
 * `pending` is the selection being applied, which the commit clears only when
 * it is still the stored one. A throw leaves the session on its old binding,
 * fence lifted.
 */
export async function prepareEngineSwitch(
  sessionId: string,
  target: EngineSwitchTarget,
  pending: SessionPendingRuntime,
  admit: () => void,
): Promise<PreparedEngineSwitch> {
  // Read before anything moves: a session without a worktree edge keeps the
  // directory its old engine ran in.
  const cwd = harnessRegistry.cwdForSession(sessionId);
  // The fence goes up before ANY side effect, native data included: a
  // concurrent switch of the same session refuses here as busy, before it
  // could stage or roll back a transcript the winning switch owns.
  admit();
  const lifted = raiseEngineSwitchFence(sessionId);
  let transfer: Transfer | undefined;
  const rollback = async () => {
    await transfer?.rollback().catch(() => {
      console.warn(
        `[engine-switch] ${sessionId}: rolling back the Claude transcript copy failed; session deletion will retry.`,
      );
    });
  };
  let row: SessionMeta | undefined;
  let active: SessionEngineBinding | undefined;
  let driver: LiveSession;
  let resumed: SessionEngineBinding | undefined;
  try {
    // Read under the fence, so no other switch moves the binding meanwhile.
    row = sessionStore.get(sessionId);
    active = sessionStore.activeBinding(sessionId);
    if (!row || !active)
      throw new Error("Session does not exist or was deleted.");
    if (
      active.harness === target.harness &&
      !changesAccountKind(active, target)
    )
      throw new Error(
        "The session already runs on that engine; no switch is needed.",
      );
    const plan = await planResume(row, target);
    transfer = plan.transfer;
    admit();
    await release(active.harness, sessionId, admit);
    admit();
    ({ driver, resumed } = await open(row, target, plan, cwd));
  } catch (error) {
    await rollback();
    lifted(false);
    throw error;
  }
  const source = active;

  let ended = false;
  const abandon = async () => {
    if (ended) return;
    ended = true;
    await release(target.harness, sessionId, () => {}).catch(
      (error: unknown) => {
        console.warn(
          `[engine-switch] ${sessionId}: the new engine did not let the session go cleanly (${error instanceof Error ? error.message : String(error)}).`,
        );
      },
    );
    await rollback();
    lifted(false);
  };
  try {
    admit();
  } catch (error) {
    await abandon();
    throw error;
  }

  const usable = () => {
    if (ended) throw new Error("The engine switch already ended.");
    if (!isSwitchingEngines(sessionId))
      throw new Error("The engine switch lost its fence.");
    if (!sessionStore.get(sessionId))
      throw new Error("The session was deleted while it switched.");
    if (sessionStore.activeBinding(sessionId)?.seq !== source.seq)
      throw new Error("The session's engine changed while it switched.");
    if (residentOn(target.harness, sessionId) !== driver)
      throw new Error("The new engine let the session go while it switched.");
    // Within one store (pi's account kind change) the resident check above
    // already tells the new session from the old.
    if (
      source.harness !== target.harness &&
      residentOn(source.harness, sessionId)
    )
      throw new Error(
        "The old engine took the session back while it switched.",
      );
  };
  return {
    driver,
    ...(resumed ? { resumed } : {}),
    usable,
    commit: () => {
      usable();
      // The engine's own figures: Claude's curated model alias, pi's id.
      const selected = driver.modelSelection();
      const claudeNative =
        target.harness === "claude-sdk"
          ? (resumed?.nativeSessionId ?? null)
          : null;
      sessionStore.switchEngineBinding(sessionId, {
        expectSeq: source.seq,
        fields: {
          harness: target.harness,
          credentialProfileId: target.credentialProfileId,
          provider:
            target.harness === "claude-sdk" ? "claude" : target.model.provider,
          model: selected.model?.id ?? target.model.id,
          thinkingLevel: selected.thinkingLevel ?? target.thinkingLevel,
          providerSessionId: claudeNative,
        },
        nativeSessionId: target.harness === "pi" ? sessionId : claudeNative,
        startedSeq: sessionRuntime.logCursor(sessionId),
        ...(resumed ? { resumedSeq: resumed.seq } : {}),
        pending,
      });
      ended = true;
      lifted(true);
      void transfer?.commit().catch(() => {
        console.warn(
          `[engine-switch] ${sessionId}: removing the earlier account's Claude transcript failed; session deletion will retry.`,
        );
      });
    },
    abandon,
  };
}

/**
 * Stamp the run that began a switched-to binding (`started_run_id`): the
 * first run a session starts after its switch. Installed once at boot.
 */
export function stampSwitchedBindingRuns(): () => void {
  return subscribeSessionRunStarted((sessionId, runId) => {
    sessionStore.stampBindingRun(sessionId, runId);
  });
}
