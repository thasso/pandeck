/**
 * The harness table (`docs/agent-harnesses.md`): for each engine that runs a
 * session, which account kind signs it in, which model-picker provider it
 * owns, and what it can do. Server and web read these instead of
 * repeating the mapping between the three names a harness goes by.
 */
import {
  compactionWindowRange,
  spawnCompactionWindow,
  type CompactionWindowCapability,
  type SpawnCompactionWindowRequest,
  type CompactionWindowEstimate,
} from "./compactionWindow.ts";
import type {
  BackgroundWorkBackend,
  CredentialProfileProvider,
} from "./protocol.ts";

/**
 * Which engine actually runs a session. Persisted on the session row and fixed
 * for the session's lifetime.
 */
export type Harness = "pi" | "claude-sdk";

/** The model-picker provider every Claude SDK model carries. */
export const CLAUDE_SDK_PROVIDER = "claude-sdk";

export interface HarnessDescriptor {
  readonly id: Harness;
  /** The credential-profile kind a session on this harness signs in with. */
  readonly accountProvider: CredentialProfileProvider;
  /**
   * The one picker provider every model of this harness carries, when there is
   * one. pi models keep their upstream provider (`github-copilot`, …).
   */
  readonly modelProvider?: string;
  /**
   * Which background-work backends a session on this harness may own, as a
   * capability rather than an engine name. Claude background work executes
   * inside the retained query that issued it and is addressed through that
   * vendor's task controls; pi background work is supervised by PA itself.
   * Neither can run the other's work, so an admission whose backend is not
   * listed is a mismatch, not a preference. Widening a harness to a second
   * backend is a deliberate act: it means that runtime really can supervise
   * both, and the admission service will then let it. Both list `server-task`
   * second: that work runs in PA's own server, not in either engine, so any
   * session may own it. The FIRST entry is the harness's native backend, the
   * one its own tools admit under.
   */
  readonly backgroundWorkBackends: readonly BackgroundWorkBackend[];
  /**
   * Whether a session on this harness can take a compaction window, and how
   * the harness maps it (`docs/compaction-window.md`). Absent: it cannot.
   */
  readonly compactionWindow?: CompactionWindowCapability;
}

export const HARNESSES: Readonly<Record<Harness, HarnessDescriptor>> = {
  pi: {
    id: "pi",
    accountProvider: "openai-codex",
    backgroundWorkBackends: ["host-process", "server-task"],
    compactionWindow: {
      mapping: "reserve",
      summaryCostNote: true,
      defaultReserve: 16_384,
    },
  },
  "claude-sdk": {
    id: "claude-sdk",
    accountProvider: "claude",
    modelProvider: CLAUDE_SDK_PROVIDER,
    backgroundWorkBackends: ["claude-query", "server-task"],
    // The CLI's `autoCompactWindow` schema and env clamp.
    compactionWindow: { mapping: "window", min: 100_000, max: 1_000_000 },
  },
};

/** Pre-creation estimate only. A live session reconciles with its actual reserve. */
export function estimateSpawnCompactionWindow(
  model: { provider: string; contextWindow?: number },
  request: SpawnCompactionWindowRequest,
): (CompactionWindowEstimate & { estimated?: true }) | { refused: string } {
  const capability =
    HARNESSES[harnessForModelProvider(model.provider)].compactionWindow;
  if (!capability) return { refused: "This harness has no compaction window." };
  const decision = spawnCompactionWindow(
    compactionWindowRange(capability, {
      ...(model.contextWindow !== undefined
        ? { contextWindow: model.contextWindow }
        : {}),
      ...(capability.mapping === "reserve"
        ? { underlyingReserve: capability.defaultReserve }
        : {}),
    }),
    request,
  );
  if ("refused" in decision)
    return {
      refused:
        decision.refused +
        (capability.mapping === "reserve"
          ? " This estimate assumes pi's default reserve."
          : ""),
    };
  return {
    ...decision,
    ...(capability.mapping === "reserve" ? { estimated: true as const } : {}),
  };
}

/** Whether an untrusted value names a harness this app runs. */
export function isHarness(value: string): value is Harness {
  return Object.hasOwn(HARNESSES, value);
}

/** The harness that runs a model of this picker provider. */
export function harnessForModelProvider(provider: string | undefined): Harness {
  return provider === CLAUDE_SDK_PROVIDER ? "claude-sdk" : "pi";
}

/** The harness a credential profile of this kind signs in to. */
export function harnessForAccountProvider(
  provider: CredentialProfileProvider,
): Harness {
  return provider === HARNESSES["claude-sdk"].accountProvider
    ? "claude-sdk"
    : "pi";
}

/** The credential-profile kind that can run a model of this picker provider. */
export function accountProviderForModelProvider(
  provider: string,
): CredentialProfileProvider {
  return HARNESSES[harnessForModelProvider(provider)].accountProvider;
}

export function backgroundWorkBackendsForHarness(
  harness: Harness,
): readonly BackgroundWorkBackend[] {
  return HARNESSES[harness].backgroundWorkBackends;
}

export function harnessSupportsBackgroundWorkBackend(
  harness: Harness,
  backend: BackgroundWorkBackend,
): boolean {
  return backgroundWorkBackendsForHarness(harness).includes(backend);
}
