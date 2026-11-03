/**
 * Login holds and the per-profile writer lane (`docs/workers.md`
 * "Credentials"). A profile's token file has one writer at a time: a lane
 * item (G5's renewal, G4's usage child) or a login, which holds the lane from
 * the moment its hold is saved until evidence says the login's processes are
 * gone.
 *
 * A hold ends only on its owning boot's release, the observed exit of its
 * owner and, for a Claude hold, its registered writer (`processState`; an
 * uncertain observation is alive), or the operator's force release. Elapsed
 * time only makes it login-stuck; a lost connection, a gateway restart, a sync
 * and a profile's removal never touch it. Each check observes only holds
 * whose owner is not the current connection's boot.
 *
 * With `persist`, an acquire or a writer registration is saved before it
 * answers and undone in memory when saving throws; a release, a stuck
 * transition or a fence takes effect in memory first and stays in force when
 * saving throws, and the next change saves again.
 */
import { randomBytes } from "node:crypto";
import type { LeaseProvider } from "./leases.ts";
import { processState, type ProcessProbe } from "./processIdentity.ts";

/** How long a hold runs before it becomes login-stuck without evidence. */
const HOLD_DEADLINE_MS = 30 * 60 * 1000;

const HOLD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isHoldId(value: unknown): value is string {
  return typeof value === "string" && HOLD_ID_RE.test(value);
}

/** A process named by its pid and start time (`processIdentity.ts`). */
export interface HoldProcess {
  pid: number;
  startTime: string | null;
}

/** The boot that took a hold, as its `control.hello` named it. */
export interface HoldOwner extends HoldProcess {
  serverBootId: string;
}

export interface HoldRecord {
  holdId: string;
  profileId: string;
  provider: LeaseProvider;
  /** Null only for a fence hold, which no boot owns. */
  owner: HoldOwner | null;
  /** A Claude hold's `claude auth login` child, once registered. */
  writer?: HoldProcess;
  /** Epoch milliseconds, as are the next two. */
  acquiredAt: number;
  deadline: number;
  /** When it became login-stuck. */
  stuckAt?: number;
}

/** What `profiles.loginHold` answers. */
export type HoldAcquired =
  | { held: true }
  | {
      held: false;
      refusal: "hold_exists" | "login_stuck";
      /** The hold that stands; absent only before a fence knows the registry. */
      holdId?: string;
    };

/** What `profiles.status` reports. */
export interface HoldStatus {
  profileId: string;
  loginStuck: boolean;
  holdId: string;
}

/**
 * A memory-first change: the statuses it changed, and the save's failure
 * when the file is now behind memory.
 */
export interface HoldUpdate {
  statuses: HoldStatus[];
  saveError?: Error;
}

/** What `registerWriter` did; see there. */
export type WriterOutcome =
  | "registered"
  | "unchanged"
  | "unknown"
  | "not_owner"
  | "not_claude"
  | "conflict";

/** What `release` did; see there. */
export type ReleaseOutcome =
  | { released: false; reason: "unknown" | "not_owner" }
  | ({ released: true } & HoldUpdate);

export interface HoldTableOptions {
  /** Epoch milliseconds; the clock tests inject. */
  now?: (() => number) | undefined;
  /** Saves every record, throwing when it cannot. Without it, memory only. */
  persist?: ((records: HoldRecord[]) => void) | undefined;
  /** How owners and writers are observed; tests inject one. */
  probe?: ProcessProbe | undefined;
  /**
   * `holds.json` was unreadable: every profile is fenced, first with no hold
   * at all, then with one fence hold each once `fence` names the registry.
   */
  fenced?: boolean | undefined;
}

const copy = (record: HoldRecord): HoldRecord => ({
  ...record,
  owner: record.owner && { ...record.owner },
  ...(record.writer ? { writer: { ...record.writer } } : {}),
});

const statusOf = (hold: HoldRecord, loginStuck: boolean): HoldStatus => ({
  profileId: hold.profileId,
  loginStuck,
  holdId: hold.holdId,
});

/** The login holds, at most one per profile. */
export class HoldTable {
  private readonly byProfile = new Map<string, HoldRecord>();
  private readonly now: () => number;
  private readonly persist: ((records: HoldRecord[]) => void) | undefined;
  private readonly probe: ProcessProbe | undefined;
  /** Fenced, and no fence hold is made yet: every profile's lane is closed. */
  private fencePending: boolean;
  /** Whether the last save threw, so memory may be ahead of the file. */
  private unsaved = false;

  constructor(options: HoldTableOptions = {}) {
    this.now = options.now ?? Date.now;
    this.persist = options.persist;
    this.probe = options.probe;
    this.fencePending = options.fenced ?? false;
  }

  /** Loads saved records into an empty table, without saving. */
  restore(records: readonly HoldRecord[]): void {
    for (const record of records)
      if (!this.byProfile.has(record.profileId))
        this.byProfile.set(record.profileId, copy(record));
  }

  records(): HoldRecord[] {
    return [...this.byProfile.values()].map(copy);
  }

  get(holdId: string): HoldRecord | undefined {
    const hold = this.find(holdId);
    return hold && copy(hold);
  }

  /** Whether a fence still waits for the registry. */
  get fencing(): boolean {
    return this.fencePending;
  }

  /** Whether the profile's lane is held: by a hold, or a pending fence. */
  isHeld(profileId: string): boolean {
    return this.fencePending || this.byProfile.has(profileId);
  }

  /**
   * The answer to an acquire that cannot wait for the lane: `login_stuck` for
   * a stuck or fence hold or another boot's, `held` for this boot's own
   * `holdId` again (a retried request), `hold_exists` for its other hold.
   * Undefined when the profile is not held.
   */
  refusal(
    profileId: string,
    holdId: string,
    serverBootId: string,
  ): HoldAcquired | undefined {
    if (this.fencePending) return { held: false, refusal: "login_stuck" };
    const hold = this.byProfile.get(profileId);
    if (!hold) return undefined;
    if (hold.owner?.serverBootId !== serverBootId || hold.stuckAt !== undefined)
      return { held: false, refusal: "login_stuck", holdId: hold.holdId };
    if (hold.holdId === holdId) return { held: true };
    return { held: false, refusal: "hold_exists", holdId: hold.holdId };
  }

  /** Saves a new hold; nothing stands when saving throws. */
  add(
    profileId: string,
    provider: LeaseProvider,
    holdId: string,
    owner: HoldOwner,
  ): void {
    const acquiredAt = this.now();
    this.byProfile.set(profileId, {
      holdId,
      profileId,
      provider,
      owner: { ...owner },
      acquiredAt,
      deadline: acquiredAt + HOLD_DEADLINE_MS,
    });
    try {
      this.save();
    } catch (err) {
      this.byProfile.delete(profileId);
      throw err;
    }
  }

  /**
   * Names a Claude hold's writer, from its owning boot only. The same writer
   * again changes nothing; another one is a conflict. Saved before it returns.
   */
  registerWriter(
    holdId: string,
    serverBootId: string,
    writer: HoldProcess,
  ): WriterOutcome {
    const hold = this.find(holdId);
    if (!hold) return "unknown";
    if (hold.owner?.serverBootId !== serverBootId) return "not_owner";
    if (hold.provider !== "claude") return "not_claude";
    if (hold.writer)
      return hold.writer.pid === writer.pid &&
        hold.writer.startTime === writer.startTime
        ? "unchanged"
        : "conflict";
    hold.writer = { ...writer };
    try {
      this.save();
    } catch (err) {
      delete hold.writer;
      throw err;
    }
    return "registered";
  }

  /** Evidence (a): the owning boot says its login settled. */
  release(holdId: string, serverBootId: string): ReleaseOutcome {
    const hold = this.find(holdId);
    if (!hold) return { released: false, reason: "unknown" };
    if (hold.owner?.serverBootId !== serverBootId)
      return { released: false, reason: "not_owner" };
    return { released: true, ...this.drop(hold) };
  }

  /** The operator's assertion that no login runs; undefined for an unknown id. */
  forceRelease(holdId: string): HoldUpdate | undefined {
    const hold = this.find(holdId);
    return hold ? this.drop(hold) : undefined;
  }

  /**
   * Ends a pending fence with one stuck fence hold per profile in
   * `profileIds`; nothing while that is empty.
   */
  fence(profileIds: readonly string[]): HoldUpdate {
    if (!this.fencePending || profileIds.length === 0) return { statuses: [] };
    this.fencePending = false;
    const now = this.now();
    const statuses: HoldStatus[] = [];
    for (const profileId of profileIds) {
      const hold: HoldRecord = {
        holdId: randomBytes(16).toString("base64url"),
        profileId,
        // Never read for a fence hold, which no evidence releases.
        provider: "claude",
        owner: null,
        acquiredAt: now,
        deadline: now,
        stuckAt: now,
      };
      this.byProfile.set(profileId, hold);
      statuses.push(statusOf(hold, true));
    }
    return this.saveKept(true, statuses);
  }

  /**
   * Evidence (b) for every hold whose owner is not `currentBootId`'s, then
   * the deadline for every hold left: past it, a hold becomes login-stuck and
   * stays held.
   */
  check(currentBootId: string | undefined): HoldUpdate {
    const now = this.now();
    const statuses: HoldStatus[] = [];
    let changed = false;
    for (const hold of [...this.byProfile.values()]) {
      if (hold.owner?.serverBootId === currentBootId || !this.exited(hold))
        continue;
      this.byProfile.delete(hold.profileId);
      changed = true;
      if (hold.stuckAt !== undefined) statuses.push(statusOf(hold, false));
    }
    for (const hold of this.byProfile.values())
      if (hold.stuckAt === undefined && hold.deadline <= now) {
        hold.stuckAt = now;
        changed = true;
        statuses.push(statusOf(hold, true));
      }
    return this.saveKept(changed, statuses);
  }

  /** Every login-stuck hold, as its status. */
  stuck(): HoldStatus[] {
    return [...this.byProfile.values()]
      .filter((hold) => hold.stuckAt !== undefined)
      .map((hold) => statusOf(hold, true));
  }

  /** Whether evidence says the hold's processes are gone. */
  private exited(hold: HoldRecord): boolean {
    const gone = (process: HoldProcess): boolean =>
      processState(process.pid, process.startTime, this.probe) === "exited";
    if (!hold.owner) return false;
    if (hold.provider === "openai-codex") return gone(hold.owner);
    // A Claude login writes from its child: no writer, no evidence.
    return hold.writer !== undefined && gone(hold.owner) && gone(hold.writer);
  }

  private find(holdId: string): HoldRecord | undefined {
    for (const hold of this.byProfile.values())
      if (hold.holdId === holdId) return hold;
    return undefined;
  }

  private drop(hold: HoldRecord): HoldUpdate {
    this.byProfile.delete(hold.profileId);
    return this.saveKept(
      true,
      hold.stuckAt !== undefined ? [statusOf(hold, false)] : [],
    );
  }

  /** Saves a memory-first change, keeping it when saving throws. */
  private saveKept(changed: boolean, statuses: HoldStatus[]): HoldUpdate {
    if (!changed && !this.unsaved) return { statuses };
    try {
      this.save();
      return { statuses };
    } catch (err) {
      const saveError = err instanceof Error ? err : new Error(String(err));
      return { statuses, saveError };
    }
  }

  private save(): void {
    this.unsaved = true;
    this.persist?.(this.records());
    this.unsaved = false;
  }
}

/** The lane is held by a login: the item did not run. */
export class LaneHeldError extends Error {
  constructor(profileId: string) {
    super(`A login holds the writer lane of profile ${profileId}.`);
  }
}

/**
 * The per-profile writer lane: one item at a time, in arrival order, each a
 * `run` or a hold's `acquire`. A failing item frees the lane as a settling one
 * does. No item runs while the profile is held.
 */
export class WriterLane {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly holds: HoldTable,
    /** The profile's provider while it is registered. */
    private readonly provider: (profileId: string) => LeaseProvider | undefined,
  ) {}

  /**
   * Runs `work` once every earlier item of the profile has settled. Rejects
   * with {@link LaneHeldError}, without calling it, when the profile is held
   * now or at its turn.
   */
  run<T>(profileId: string, work: () => Promise<T>): Promise<T> {
    if (this.holds.isHeld(profileId))
      return Promise.reject(new LaneHeldError(profileId));
    return this.enqueue(profileId, () => {
      if (this.holds.isHeld(profileId)) throw new LaneHeldError(profileId);
      return work();
    });
  }

  /**
   * Takes the lane for a login. A held profile answers its refusal at once;
   * otherwise the hold is saved at its turn, unless `signal` aborted by then.
   * Resolves undefined when the profile is no longer registered at its turn.
   */
  acquire(
    profileId: string,
    holdId: string,
    owner: HoldOwner,
    signal: AbortSignal,
  ): Promise<HoldAcquired | undefined> {
    const refused = this.holds.refusal(profileId, holdId, owner.serverBootId);
    if (refused) return Promise.resolve(refused);
    return this.enqueue(profileId, () => {
      signal.throwIfAborted();
      const atTurn = this.holds.refusal(profileId, holdId, owner.serverBootId);
      if (atTurn) return atTurn;
      const provider = this.provider(profileId);
      if (!provider) return undefined;
      this.holds.add(profileId, provider, holdId, owner);
      return { held: true } as const;
    });
  }

  private enqueue<T>(
    profileId: string,
    item: () => T | Promise<T>,
  ): Promise<T> {
    const turn = (this.tails.get(profileId) ?? Promise.resolve()).then(item);
    const tail = turn.then(
      () => {},
      () => {},
    );
    this.tails.set(profileId, tail);
    void tail.then(() => {
      if (this.tails.get(profileId) === tail) this.tails.delete(profileId);
    });
    return turn;
  }
}
