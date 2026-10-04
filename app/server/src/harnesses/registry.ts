/**
 * The one place that knows which engine holds a session: it routes our session
 * id to the pi or Claude SDK store, lists what both hold resident, and wires
 * both stores to the hub's behaviour (`docs/agent-harnesses.md`). App code asks
 * here instead of dispatching on a harness id itself.
 */
import { existsSync } from "node:fs";
import type { AgentType, Harness } from "@assistant/shared";
import { claudeSdkStore } from "../claudeSdk/claudeSdkStore.ts";
import { defaultClaudeProfileId } from "../credentialProfiles.ts";
import { sessionStore } from "../db/sessionStore.ts";
import type { HarnessHost, LiveSession } from "../harness.ts";
import { PiSessionDeletedError, piStore } from "../piSdk/piStore.ts";
import { canonicalPiSessionPath } from "../sessionStorage.ts";

/** One engine's sessions, as the registry routes to them. */
interface HarnessSessions {
  /** Every session the engine holds resident. */
  list(): LiveSession[];
  /** The resident session with our id, from memory only. */
  get(id: string): LiveSession | undefined;
  /** The same, its idle clock restarted for a caller about to drive it. */
  getForDrive(id: string): LiveSession | undefined;
  /** Whether the engine has the session on disk without a metadata row. */
  storedWithoutRow(id: string): boolean;
  /** Open the session from disk as the persona its row names. */
  open(id: string, agentType: AgentType): Promise<LiveSession | undefined>;
}

const sessions: Record<Harness, HarnessSessions> = {
  pi: {
    list: () => piStore.list(),
    get: (id) => piStore.getLiveById(id),
    getForDrive: (id) => piStore.getForDrive(id),
    // Recovery for pi transcripts that predate a valid metadata row.
    storedWithoutRow: (id) => existsSync(canonicalPiSessionPath(id)),
    // The pi session reopens from its canonical native path, derived from the
    // id, which also guards the open. A reopen the delete beat to registration
    // is a session that no longer exists, not a failure.
    open: (id, agentType) =>
      piStore.acquireByRecordId(id, agentType).catch((err: unknown) => {
        if (err instanceof PiSessionDeletedError) return undefined;
        throw err;
      }),
  },
  "claude-sdk": {
    list: () => claudeSdkStore.list(),
    get: (id) => claudeSdkStore.get(id),
    getForDrive: (id) => claudeSdkStore.getForDrive(id),
    storedWithoutRow: (id) => claudeSdkStore.exists(id),
    // Rehydrated on the account its record names, else the default one.
    open: async (id) =>
      claudeSdkStore.acquire(id, {
        credentialProfileId: defaultClaudeProfileId(),
      }),
  },
};

/**
 * Pi first, as the session list and every fan-out have always run. An id
 * belongs to one engine, so the order decides nothing else.
 */
const HARNESS_ORDER: readonly Harness[] = ["pi", "claude-sdk"];

/** The resident session for our id, from memory only. */
function residentInMemory(id: string): LiveSession | undefined {
  for (const harness of HARNESS_ORDER) {
    const session = sessions[harness].get(id);
    if (session) return session;
  }
  return undefined;
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
    return HARNESS_ORDER.flatMap((harness) => sessions[harness].list());
  },

  /**
   * The resident session for our id, without loading or reopening anything
   * and without reading the metadata row: what a message for its viewers
   * needs.
   */
  residentById(id: string): LiveSession | undefined {
    return residentInMemory(id);
  },

  /**
   * The session for our id, opening it from disk when it is not resident: the
   * one id-only entry point. A resident session gets a full idle grace first,
   * since the caller is about to drive it. Otherwise the metadata row names the
   * engine that opens it; a session without one is opened by the engine that
   * has it on disk (a pi transcript as a developer session, the persona those
   * predate the row for). Undefined when nothing holds the session or the row
   * is tombstoned, or when a pi session has no transcript to reopen from.
   */
  async acquireById(id: string): Promise<LiveSession | undefined> {
    // A fresh pi session may be resident before its first prompt creates a
    // transcript or metadata row, so a singleton or system session can be
    // viewed as soon as it is created.
    for (const harness of HARNESS_ORDER) {
      const resident = sessions[harness].getForDrive(id);
      if (resident) return resident;
    }
    const record = sessionStore.get(id);
    if (record) return sessions[record.harness].open(id, record.agentType);
    const holder = (["claude-sdk", "pi"] as const).find((harness) =>
      sessions[harness].storedWithoutRow(id),
    );
    return holder ? sessions[holder].open(id, "developer") : undefined;
  },

  /** The resident session that owns a browser runtime, as its listing shows it. */
  browserRuntimeOwner(sessionId: string): BrowserRuntimeOwner | undefined {
    const session = residentInMemory(sessionId);
    if (!session) return undefined;
    const { sessionFile, sessionTitle } = session;
    return {
      agentKind: session.agentType,
      agentStatus: session.isRunning ? "running" : "idle",
      ...(sessionFile !== undefined ? { sessionFile } : {}),
      ...(sessionTitle !== undefined ? { sessionTitle } : {}),
    };
  },
};
