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
  /**
   * Whether the engine can reopen the session from disk without a metadata row.
   * Asked only after residency and the row, so it may also answer for those.
   */
  storedWithoutRow(id: string): boolean;
  /**
   * Whether anything the engine could still reopen holds the id on disk,
   * reopenable by id or not (a legacy pi transcript a continuation reopens by
   * file): what decides that the id is the engine's.
   */
  holdsOnDisk(id: string): boolean;
  /** Make the engine refuse to register an id `check` says another holds. */
  setHeldElsewhere(check: (id: string) => boolean): void;
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
    holdsOnDisk: (id) => piStore.hasTranscript(id),
    setHeldElsewhere: (check) => piStore.setHeldElsewhere(check),
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
    holdsOnDisk: (id) => claudeSdkStore.exists(id),
    setHeldElsewhere: (check) => claudeSdkStore.setHeldElsewhere(check),
    // Rehydrated on the account its record names, else the default one.
    open: async (id) =>
      claudeSdkStore.acquire(id, {
        credentialProfileId: defaultClaudeProfileId(),
      }),
  },
};

/**
 * Every engine, pi first as the session list and every fan-out have always
 * run; derived from the entries, so a new engine cannot be skipped.
 */
const HARNESS_ORDER = Object.keys(sessions) as Harness[];

/**
 * Who opens a session without a metadata row: a Claude record first, as it
 * always has been, then the rest; when both have the id on disk, Claude's
 * record wins.
 */
const ROWLESS_ORDER: readonly Harness[] = [
  "claude-sdk",
  ...HARNESS_ORDER.filter((harness) => harness !== "claude-sdk"),
];

/** The engine other than `harness` that holds `id` resident, if any. */
function residentElsewhere(id: string, harness: Harness): Harness | undefined {
  return HARNESS_ORDER.find(
    (other) => other !== harness && sessions[other].get(id) !== undefined,
  );
}

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
  /** Wire both stores to the hub, and to each other's residency. */
  setHost(host: HarnessHost): void {
    piStore.setHost(host);
    // Registration is the last word on ownership: neither store takes an id
    // the other holds resident, whichever path asks.
    for (const harness of HARNESS_ORDER)
      sessions[harness].setHeldElsewhere(
        (id) => residentElsewhere(id, harness) !== undefined,
      );
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
   * The engine other than `harness` that already holds `id`: resident, on
   * record, or, without a row, on disk as anything an engine could still
   * reopen, by id or by file; undefined when `harness` may bring it live. An
   * id belongs to one engine: a client-supplied id is checked here before
   * anything is created for it, which is what lets {@link residentById} answer
   * from memory alone. `onDisk: false` skips the disk scan for an id the
   * server minted, which no transcript can hold.
   */
  otherHolder(
    id: string,
    harness: Harness,
    { onDisk = true }: { onDisk?: boolean } = {},
  ): Harness | undefined {
    const resident = residentElsewhere(id, harness);
    if (resident) return resident;
    const row = sessionStore.get(id);
    if (row) return row.harness !== harness ? row.harness : undefined;
    if (!onDisk) return undefined;
    // Without a row, the disk decides as `acquireById` would: Claude's record
    // first.
    const holder = ROWLESS_ORDER.find((other) =>
      sessions[other].holdsOnDisk(id),
    );
    return holder !== harness ? holder : undefined;
  },

  /**
   * The resident session for our id, without loading or reopening anything
   * and without reading the metadata row: what a message for its viewers
   * needs. Ids are unique across engines ({@link otherHolder}).
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
    const holder = ROWLESS_ORDER.find((harness) =>
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
