/**
 * The ONE writer of a session's compaction window (`docs/compaction-window.md`).
 * Every source goes through {@link setSessionCompactionWindow} with its actor:
 *
 * - `user` (the inspector): any value in the session's range, or clear.
 *   Persisted first, then applied to a live harness; a live failure is
 *   reported in place and the stored value applies at the next start.
 * - `agent` (a session lowering its own window, `session_compaction_window`):
 *   the live harness runs the checks and persists only once they pass; there
 *   is no clearing.
 * - `spawn` (creation): a row value an agent wrote must be at least the agent
 *   floor and at most the native trigger; a definition default is clamped into
 *   the range, or dropped with the reason when there is none.
 *
 * Calls for one session run one at a time. Nothing here opens a harness:
 * a session with none gets the value when its next process starts.
 */
import {
  HARNESSES,
  compactionWindowRange,
  compactionWindowUserRefusal,
  spawnCompactionWindow,
  compactionWindowEstimateNote,
  type CompactionWindowEstimate,
  type CompactionWindowPendingReason,
} from "@assistant/shared";
import { sessionStore } from "./db/sessionStore.ts";
import { isLiveSession, type LiveSession } from "./harness.ts";
import {
  serializedCompactionWindow,
  storedCompactionWindowInputs,
} from "./harnesses/compactionWindow.ts";
import { hub } from "./hub.ts";

export type CompactionWindowActor =
  | "user"
  | "agent"
  | { spawn: "row" | "definition"; estimate?: CompactionWindowEstimate };

export type SetCompactionWindowResult =
  | {
      ok: true;
      /** The value now stored; `null` is the provider default. */
      tokens: number | null;
      /** The agent path: what was confirmed before. */
      previous?: number | null;
      pendingReason?: CompactionWindowPendingReason;
      applyError?: string;
      disabled?: true;
      /** A definition default that was clamped or dropped, and why. */
      note?: string;
    }
  | { ok: false; message: string; largestAcceptable?: number };

function refused(message: string): SetCompactionWindowResult {
  return { ok: false, message };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function residentLive(sessionId: string): LiveSession | undefined {
  const driver = hub.getLiveById(sessionId);
  return isLiveSession(driver) ? driver : undefined;
}

/** Everyone showing the session sees its new state, fresh from the row. */
function broadcast(sessionId: string, live: LiveSession | undefined): void {
  live?.broadcastState();
  hub.sessionStateChanged(sessionId);
}

export function setSessionCompactionWindow(
  sessionId: string,
  tokens: number | null,
  actor: CompactionWindowActor,
): Promise<SetCompactionWindowResult> {
  return serializedCompactionWindow(sessionId, () =>
    setNow(sessionId, tokens, actor),
  );
}

async function setNow(
  sessionId: string,
  tokens: number | null,
  actor: CompactionWindowActor,
): Promise<SetCompactionWindowResult> {
  if (
    tokens === null
      ? actor === "agent"
      : !Number.isSafeInteger(tokens) || tokens <= 0
  )
    return refused(
      actor === "agent"
        ? "An agent cannot clear the compaction window; ask the user."
        : "The compaction window must be a whole number of tokens.",
    );
  const meta = sessionStore.get(sessionId);
  if (!meta) return refused("The session was not found.");
  const capability = HARNESSES[meta.harness].compactionWindow;
  if (!capability)
    return refused("This session's harness has no compaction window.");
  const live = residentLive(sessionId);

  if (actor === "agent") {
    if (!live?.lowerCompactionWindow || tokens === null)
      return refused(
        "Only a running session can lower its own compaction window.",
      );
    const result = await live.lowerCompactionWindow(tokens, (value) =>
      sessionStore.setCompactionWindow(sessionId, value),
    );
    broadcast(sessionId, live);
    return result.ok
      ? {
          ok: true,
          tokens: result.applied,
          previous: result.previous,
          ...(result.pendingReason !== undefined
            ? { pendingReason: result.pendingReason }
            : {}),
        }
      : result;
  }

  const status = live?.compactionWindowStatus?.();
  const available = compactionWindowRange(
    capability,
    status
      ? {
          ...(status.contextWindow !== undefined
            ? { contextWindow: status.contextWindow }
            : {}),
          ...(status.underlyingReserve !== undefined
            ? { underlyingReserve: status.underlyingReserve }
            : {}),
        }
      : storedCompactionWindowInputs(meta),
  );
  let value = tokens;
  let note: string | undefined;
  if (actor === "user") {
    const refusal = compactionWindowUserRefusal(available, tokens);
    if (refusal) return refused(refusal);
  } else if (tokens !== null) {
    const decision = spawnCompactionWindow(available, {
      tokens,
      source: actor.spawn,
      rowAbove: "clamp",
      ...(typeof actor.estimate?.tokens === "number"
        ? { ceiling: actor.estimate.tokens }
        : {}),
    });
    if ("refused" in decision) return refused(decision.refused);
    value = decision.tokens;
    note = compactionWindowEstimateNote(actor.estimate, value, decision.note);
  }

  try {
    sessionStore.setCompactionWindow(sessionId, value, note);
  } catch (error) {
    return refused(`Saving the compaction window failed: ${errorText(error)}`);
  }
  const applied = live?.applyCompactionWindow
    ? await live.applyCompactionWindow(value)
    : { pendingReason: "next-turn" as const };
  broadcast(sessionId, live);
  return {
    ok: true,
    tokens: value,
    ...applied,
    ...(note !== undefined ? { note } : {}),
  };
}
