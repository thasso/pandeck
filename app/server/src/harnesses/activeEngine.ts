/**
 * The ONE accessor for what engine a session runs on now
 * (`docs/session-runtime-switching.md` "Engine bindings", design 19): its
 * active engine binding. Capability readers (what the running engine can do,
 * which models and accounts fit it) ask here instead of reading a session's
 * `harness` themselves, so the cross-harness switch changes one place.
 *
 * Every source this accepts carries the active binding already: a metadata row
 * holds its projection (`db/sessionEngineBinding.ts`), and a resident driver IS
 * the active engine. No query runs, so a list projection may call it per row.
 *
 * Ownership readers that hold only an id resolve through
 * `harnessRegistry.engineOf`; history readers use the engine a run recorded on
 * its `run.started` marker (`RunEngine`, `session/log/rawEntry.ts`).
 */
import type { Harness } from "@assistant/shared";
import { nativeSessionIdFor } from "../db/sessionEngineBinding.ts";

/** What the active binding says about the engine. */
export interface ActiveEngine {
  harness: Harness;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  credentialProfileId?: string;
}

/** A session row, resident driver, ref or wire state: anything naming it. */
type EngineSource = {
  readonly harness: Harness;
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly credentialProfileId?: string;
};

export function activeEngine(source: EngineSource): ActiveEngine {
  return {
    harness: source.harness,
    ...(typeof source.provider === "string"
      ? { provider: source.provider }
      : {}),
    ...(typeof source.model === "string" ? { model: source.model } : {}),
    ...(typeof source.thinkingLevel === "string"
      ? { thinkingLevel: source.thinkingLevel }
      : {}),
    ...(source.credentialProfileId
      ? { credentialProfileId: source.credentialProfileId }
      : {}),
  };
}

/** The engine's own id for a session, read off its active binding. */
export interface ActiveNativeRef {
  harness: Harness;
  /** Our id. */
  sessionId: string;
  /** The engine's id; absent for a Claude session before its first query. */
  nativeSessionId?: string;
}

/** The active binding's native ref, from a metadata row's projection. */
export function activeNativeRef(row: {
  id: string;
  harness: Harness;
  providerSessionId?: string;
}): ActiveNativeRef {
  const native = nativeSessionIdFor(row.id, {
    harness: row.harness,
    providerSessionId: row.providerSessionId ?? null,
  });
  return {
    harness: row.harness,
    sessionId: row.id,
    ...(native ? { nativeSessionId: native } : {}),
  };
}
