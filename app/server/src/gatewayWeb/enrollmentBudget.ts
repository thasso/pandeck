/**
 * The page's budget for calls that carry an enrollment user code (Task-1410,
 * `docs/workers.md` "The gateway's sign-in and UI"). Lookup and decide share
 * one budget per user, whichever session sends them: 10 a minute and 60 an
 * hour. Misses (an unknown code) across all users are capped at 120 an hour;
 * past that every code-bearing call is refused for everyone until the oldest
 * miss is an hour old. That bounds guessing the 20^8 code space at the cost of
 * availability: signed-in users spending their misses can block approvals for
 * an hour.
 *
 * In memory only, so a restart resets it. Windows slide; each user holds at
 * most `USER_PER_HOUR` times, the miss list at most `MISSES_PER_HOUR`, and
 * users with no call in the last hour are dropped, so storage is bounded by
 * the users who called in the last hour, at most `MAX_USERS`.
 */

export const USER_PER_MINUTE = 10;
export const USER_PER_HOUR = 60;
export const MISSES_PER_HOUR = 120;
/** Past this many users with calls in the last hour, new users wait. */
const MAX_USERS = 4_096;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** A refused call: whose limit, and the whole seconds until it may pass. */
export interface BudgetRefusal {
  scope: "user" | "global";
  retryAfterSeconds: number;
}

const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

export class EnrollmentBudget {
  /** Each user's admitted calls in the last hour, oldest first. */
  private readonly calls = new Map<string, number[]>();
  /** Misses across all users in the last hour, oldest first. */
  private misses: number[] = [];

  constructor(private readonly now: () => number) {}

  /**
   * Admits and counts one code-bearing call of the user, or answers why
   * not; a refused call is not counted.
   */
  admit(userId: string): BudgetRefusal | undefined {
    const at = this.now();
    this.prune(at);
    if (this.misses.length >= MISSES_PER_HOUR)
      return {
        scope: "global",
        retryAfterSeconds: seconds(this.misses[0]! + HOUR_MS - at),
      };
    let times = this.calls.get(userId);
    if (!times) {
      if (this.calls.size >= MAX_USERS)
        return { scope: "global", retryAfterSeconds: 60 };
      times = [];
      this.calls.set(userId, times);
    }
    if (times.length >= USER_PER_HOUR)
      return {
        scope: "user",
        retryAfterSeconds: seconds(times[0]! + HOUR_MS - at),
      };
    const recent = times.filter((time) => at - time < MINUTE_MS);
    if (recent.length >= USER_PER_MINUTE)
      return {
        scope: "user",
        retryAfterSeconds: seconds(recent[0]! + MINUTE_MS - at),
      };
    times.push(at);
    return undefined;
  }

  /** Counts an admitted call that named no open request; true when it filled the cap. */
  miss(): boolean {
    const at = this.now();
    this.prune(at);
    this.misses.push(at);
    return this.misses.length === MISSES_PER_HOUR;
  }

  /** Users held; for tests. */
  get users(): number {
    return this.calls.size;
  }

  private prune(at: number): void {
    const live = (time: number) => at - time < HOUR_MS;
    this.misses = this.misses.filter(live);
    for (const [userId, times] of this.calls) {
      const kept = times.filter(live);
      if (kept.length === 0) this.calls.delete(userId);
      else this.calls.set(userId, kept);
    }
  }
}
