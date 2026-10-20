/**
 * Compaction-window range inputs for a session NO harness is open for
 * (`docs/compaction-window.md`): the stored model's window, and for the
 * `reserve` mapping the engine's default reserve. A live harness reports its
 * own (`LiveSession.compactionWindowStatus`) and re-checks when it applies.
 */
import {
  HARNESSES,
  sessionCompactionWindowState,
  type SessionCompactionWindow,
} from "@assistant/shared";
import { sessionStore, type SessionMeta } from "../db/sessionStore.ts";
import type { LiveSession } from "../harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../piSdk/compactionWindow.ts";
import { storedSessionModelOption } from "./models.ts";

export function storedCompactionWindowInputs(
  meta: Pick<SessionMeta, "harness" | "provider" | "model">,
): { contextWindow?: number; underlyingReserve?: number } {
  const capability = HARNESSES[meta.harness].compactionWindow;
  const contextWindow = storedSessionModelOption(
    meta.harness,
    meta.provider,
    meta.model,
  )?.contextWindow;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(capability?.mapping === "reserve"
      ? { underlyingReserve: DEFAULT_COMPACTION_SETTINGS.reserveTokens }
      : {}),
  };
}

/** The `SessionState.compactionWindow` of a session shown from storage. */
export function storedCompactionWindowState(
  meta: Pick<
    SessionMeta,
    "harness" | "provider" | "model" | "compactionWindow"
  >,
): SessionCompactionWindow | undefined {
  return sessionCompactionWindowState(
    HARNESSES[meta.harness].compactionWindow,
    {
      stored: meta.compactionWindow,
      ...storedCompactionWindowInputs(meta),
    },
  );
}

const locks = new Map<string, Promise<unknown>>();

/**
 * Run one compaction-window change for a session after every earlier one has
 * finished (`sessionCompactionWindow.ts` and fork inheritance share it).
 */
export function serializedCompactionWindow<T>(
  sessionId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(sessionId) ?? Promise.resolve();
  const next = previous.then(run, run);
  const tail = next.catch(() => undefined);
  locks.set(sessionId, tail);
  void tail.then(() => {
    if (locks.get(sessionId) === tail) locks.delete(sessionId);
  });
  return next;
}

/**
 * A fork inherits its parent's stored window verbatim, applied by the child's
 * own harness. Best-effort: a failed copy leaves the child on its default.
 */
export async function inheritCompactionWindow(
  parentId: string,
  child: LiveSession,
): Promise<void> {
  const tokens = sessionStore.get(parentId)?.compactionWindow;
  if (tokens === undefined) return;
  await serializedCompactionWindow(child.sessionId, async () => {
    try {
      sessionStore.setCompactionWindow(child.sessionId, tokens);
    } catch (error) {
      console.warn(
        `[compaction-window] fork ${child.sessionId} kept its default: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    await child.applyCompactionWindow?.(tokens);
    child.broadcastState();
  });
}
