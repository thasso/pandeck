/**
 * The one place that knows which engine holds a session: it routes our session
 * id to the pi or Claude SDK store, lists what both hold resident, and wires
 * both stores to the hub's behaviour (`docs/agent-harnesses.md`). App code asks
 * here instead of dispatching on a harness id itself.
 */
import { existsSync } from "node:fs";
import type { BrowserRuntimeInfo } from "@assistant/shared";
import { claudeSdkStore } from "../claudeSdk/claudeSdkStore.ts";
import { defaultClaudeProfileId } from "../credentialProfiles.ts";
import { sessionStore } from "../db/sessionStore.ts";
import type { LiveSession } from "../harness.ts";
import { PiSessionDeletedError, piStore } from "../piSdk/piStore.ts";
import { canonicalPiSessionPath } from "../sessionStorage.ts";

/** The hub behaviour both engines' sessions reach without importing `hub.ts`. */
export interface HarnessHost {
  /** Recompute the merged session list and push it to every connected tab. */
  broadcastSessions(): Promise<void>;
  /** A run just started; cancel any idle-settle countdown for a queued reload. */
  noteRunStarted(): void;
  /** Re-check after a run ends whether a deferred dev reload can now proceed. */
  checkPendingReload(): void;
  /** True while a requested dev reload is pending or already exiting. */
  isReloadQueued(): boolean;
  /** Browser runtimes visible to `sessionId`, for coding session state. */
  browserRuntimesFor(sessionId: string): BrowserRuntimeInfo[];
}

/** What a browser runtime's listing says about the session that owns it. */
interface BrowserRuntimeOwner {
  agentKind: LiveSession["agentType"];
  agentStatus: "running" | "idle";
  sessionFile?: string;
  sessionTitle?: string;
}

export const harnessRegistry = {
  /** Wire both stores to the hub. */
  setHost(host: HarnessHost): void {
    piStore.setHost(host);
    // A Claude session created, updated or removed changes the list, and may
    // unblock a queued dev reload (its turn just finished).
    claudeSdkStore.setOnChange(() => {
      void host.broadcastSessions();
      host.checkPendingReload();
    });
    claudeSdkStore.setBrowserRuntimesProvider((sessionId) =>
      host.browserRuntimesFor(sessionId),
    );
  },

  /** Every session resident in memory, across both engines. */
  resident(): LiveSession[] {
    return [...piStore.list(), ...claudeSdkStore.list()];
  },

  /**
   * The resident session for our id, without loading or reopening anything.
   * The metadata row decides the engine; a session not yet persisted is looked
   * for in both.
   */
  residentById(id: string): LiveSession | undefined {
    const record = sessionStore.get(id);
    if (!record) {
      const sdk = claudeSdkStore.get(id);
      if (sdk) return sdk;
    }
    if (record?.harness === "claude-sdk") return claudeSdkStore.get(id);
    return piStore.getLiveById(id);
  },

  /**
   * The session for our id, opening it from disk when it is not resident: the
   * one id-only entry point. A resident session gets a full idle grace first,
   * since the caller is about to drive it. The metadata row decides the
   * engine:
   *   - `pi` reopens from its canonical native path (derived from the id), the
   *     persona coming from the row and the id guarding the open;
   *   - `claude-sdk` rehydrates its record on its default account.
   * Undefined when there is no row (or it was tombstoned), or when a pi
   * session has no native transcript to reopen from.
   */
  async acquireById(id: string): Promise<LiveSession | undefined> {
    // A fresh pi session may be resident before its first prompt creates a
    // transcript or metadata row, so a singleton or system session can be
    // viewed as soon as it is created.
    const resident = piStore.getForDrive(id) ?? claudeSdkStore.getForDrive(id);
    if (resident) return resident;
    const record = sessionStore.get(id);
    // A pi reopen the delete beat to registration is a session that no longer
    // exists — the same answer as a tombstoned row, not a failure.
    const unlessDeleted = (err: unknown): undefined => {
      if (err instanceof PiSessionDeletedError) return undefined;
      throw err;
    };
    const acquireClaude = () =>
      claudeSdkStore.acquire(id, {
        credentialProfileId: defaultClaudeProfileId(),
      });
    if (!record) {
      if (claudeSdkStore.exists(id)) return acquireClaude();
      // Recovery for pi transcripts that predate a valid metadata row (notably
      // developer sessions created before the database allowed that persona).
      return existsSync(canonicalPiSessionPath(id))
        ? piStore.acquireByRecordId(id, "developer").catch(unlessDeleted)
        : undefined;
    }
    switch (record.harness) {
      case "pi":
        return piStore
          .acquireByRecordId(id, record.agentType)
          .catch(unlessDeleted);
      case "claude-sdk":
        return acquireClaude();
    }
  },

  /** The resident session that owns a browser runtime, as its listing shows it. */
  browserRuntimeOwner(sessionId: string): BrowserRuntimeOwner | undefined {
    const pi = piStore.getLiveById(sessionId);
    if (pi) {
      const title = pi.title ?? pi.session.sessionName;
      return {
        agentKind: pi.kind,
        agentStatus: pi.isRunning ? "running" : "idle",
        ...(pi.session.sessionFile !== undefined
          ? { sessionFile: pi.session.sessionFile }
          : {}),
        ...(title !== undefined ? { sessionTitle: title } : {}),
      };
    }
    const sdk = claudeSdkStore.get(sessionId);
    if (!sdk) return undefined;
    return {
      agentKind: sdk.agentType,
      agentStatus: sdk.isRunning ? "running" : "idle",
      ...(sdk.sessionFile !== undefined
        ? { sessionFile: sdk.sessionFile }
        : {}),
      ...(sdk.title !== undefined ? { sessionTitle: sdk.title } : {}),
    };
  },
};
