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
import { existsSync } from "node:fs";
import {
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
import { sessionStore, type SessionMeta } from "../db/sessionStore.ts";
import type { SessionEngineBinding } from "../db/sessionEngineBinding.ts";
import type { LiveSession } from "../harness.ts";
import { piSessionFile } from "../piSessionFile.ts";
import { piStore } from "../piSdk/piStore.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";
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

/** The newest earlier binding of `harness`, and whether its native session can resume. */
async function planResume(
  row: SessionMeta,
  target: EngineSwitchTarget,
): Promise<{ resumed?: SessionEngineBinding; transfer?: Transfer }> {
  const earlier = sessionStore
    .bindings(row.id)
    .filter((binding) => binding.harness === target.harness)
    .at(-1);
  if (target.harness === "pi")
    // Every pi binding uses the app id; pi reopens its transcript when there
    // is one (`piStore.openForBinding`).
    return existsSync(piSessionFile(row.id)) && earlier
      ? { resumed: earlier }
      : {};
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

/** Open the session on the target engine, on the binding the switch starts. */
async function open(
  row: SessionMeta,
  target: EngineSwitchTarget,
  resumed: SessionEngineBinding | undefined,
  cwd: string | undefined,
): Promise<LiveSession> {
  const mode = sessionModeOrDefault(row.mode);
  if (target.harness === "pi")
    return piStore.openForBinding(row.id, {
      kind: row.agentType,
      model: target.model,
      thinkingLevel: target.thinkingLevel,
      credentialProfileId: target.credentialProfileId,
      mode,
      ...(cwd !== undefined ? { cwd } : {}),
    });
  return withCheckedCheckout(row.id, undefined, (checkout) =>
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
  const row = sessionStore.get(sessionId);
  const active = sessionStore.activeBinding(sessionId);
  if (!row || !active)
    throw new Error("Session does not exist or was deleted.");
  if (active.harness === target.harness)
    throw new Error(
      "The session already runs on that engine; no switch is needed.",
    );
  // Read before anything moves: a session without a worktree edge keeps the
  // directory its old engine ran in.
  const cwd = harnessRegistry.cwdForSession(sessionId);
  const { resumed, transfer } = await planResume(row, target);
  const rollback = async () => {
    await transfer?.rollback().catch(() => {
      console.warn(
        `[engine-switch] ${sessionId}: rolling back the Claude transcript copy failed; session deletion will retry.`,
      );
    });
  };
  let lift: ((committed: boolean) => void) | undefined;
  let driver: LiveSession;
  try {
    admit();
    lift = raiseEngineSwitchFence(sessionId);
    await release(active.harness, sessionId, admit);
    admit();
    driver = await open(row, target, resumed, cwd);
  } catch (error) {
    await rollback();
    lift?.(false);
    throw error;
  }
  const lifted = lift;

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

  const residentOnTarget = () =>
    target.harness === "pi"
      ? piStore.getLiveById(sessionId)
      : claudeSdkStore.get(sessionId);
  const usable = () => {
    if (ended) throw new Error("The engine switch already ended.");
    if (!isSwitchingEngines(sessionId))
      throw new Error("The engine switch lost its fence.");
    if (!sessionStore.get(sessionId))
      throw new Error("The session was deleted while it switched.");
    if (sessionStore.activeBinding(sessionId)?.seq !== active.seq)
      throw new Error("The session's engine changed while it switched.");
    if (residentOnTarget() !== driver)
      throw new Error("The new engine let the session go while it switched.");
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
        expectSeq: active.seq,
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
