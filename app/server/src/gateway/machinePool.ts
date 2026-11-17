/**
 * Machine pools (`docs/workers.md` "Credentials"): the accounts a client's
 * user may spend from that client's machine without a lease token, by
 * (client's user, provider). A harness session is pinned to one account,
 * keyed by (client, provider, SHA-256 of its session-key header), and stays
 * there while the account can serve it (Task-1424 plan v03 with amendments
 * A1-A3):
 *
 * - A pin moves only when its account is unusable (removed, disabled, needs a
 *   login, no longer the user's) or has a long limit. A short limit, at most
 *   `MACHINE_SHORT_LIMIT_MS` away, passes through and keeps the pin, so the
 *   provider's prompt cache stays on one account.
 * - A session's tried set holds the accounts it left and an account it stayed
 *   on after a long 429 with no replacement. A long-limit move never targets
 *   it; only recovery from an unusable pin may return to a tried account, and
 *   only an eligible one.
 * - Benches are per profile and in memory, fed only by model-run responses.
 *
 * The ranking is Pandeck's (`accountRanking.ts`) with usage unknown. Pins and
 * tried sets persist through `persist`; the raw session key never leaves
 * `pinKeyOf`. A save that throws leaves memory in force and is retried by the
 * next change, so a recorded failover is never undone.
 */
import { createHash } from "node:crypto";
import {
  rankCandidates,
  type RankingCandidate,
} from "../../../shared/accountRanking.ts";
import type { LeaseProvider, LeaseTable, LoginBinding } from "./leases.ts";
import {
  isLeaseProvider,
  isLoginProfile,
  isProfileId,
  type GatewayProfile,
  type LoginProfile,
} from "./profiles.ts";

/** A reset at most this far away is short: the pin stays. */
export const MACHINE_SHORT_LIMIT_MS = 60_000;
/** A 429 without a valid reset benches for this long (Pandeck's fallback). */
export const RATE_LIMIT_BENCH_MS = 5 * 60_000;
/** A pin unused this long is dropped. */
export const PIN_IDLE_MS = 7 * 24 * 60 * 60_000;
/** A client's most pins; the least recently used goes first. */
export const MAX_PINS_PER_CLIENT = 1024;
/** A use alone saves at most this often. */
const LAST_USE_SAVE_MS = 10 * 60_000;
/** How often a selection sweeps idle pins and their machine leases. */
const SWEEP_EVERY_MS = 60 * 60_000;
const MAX_SESSION_KEY_CHARS = 256;
const KEY_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Session-key headers per provider route, in order: the first present wins.
 * Claude Code sends `x-claude-code-session-id`; Codex and pi `session-id`;
 * OpenCode `x-opencode-session-id`.
 */
const SESSION_KEY_HEADERS: Record<LeaseProvider, readonly string[]> = {
  claude: ["x-claude-code-session-id"],
  "openai-codex": ["session-id", "x-opencode-session-id"],
};

/** Codex's reset headers (`providerErrors.ts`), read on `/chatgpt` only. */
const CODEX_RESET_AT = [
  "x-codex-secondary-reset-at",
  "x-codex-primary-reset-at",
];
const CODEX_RESET_AFTER = [
  "x-codex-secondary-reset-after-seconds",
  "x-codex-primary-reset-after-seconds",
];

/** Usage is unknown to the gateway, so these thresholds never apply. */
const NO_USAGE_THRESHOLDS = {
  fiveHourUsedThreshold: 100,
  weeklyUsedThreshold: 100,
};

/**
 * The model-run routes: their responses are the only evidence for benches.
 * Usage, credit, consume and `count_tokens` responses never are.
 */
export function isModelRun(
  provider: LeaseProvider,
  method: string | undefined,
  pathname: string,
): boolean {
  return (
    method === "POST" &&
    pathname ===
      (provider === "claude" ? "/v1/messages" : "/backend-api/codex/responses")
  );
}

/** A header's values in Node's flat `rawHeaders` form, case-insensitive. */
function rawValues(rawHeaders: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (rawHeaders[i]!.toLowerCase() === name) values.push(rawHeaders[i + 1]!);
  return values;
}

/** The one value of a header sent exactly once, else undefined. */
function onlyValue(
  rawHeaders: readonly string[],
  name: string,
): string | undefined {
  const values = rawValues(rawHeaders, name);
  return values.length === 1 ? values[0]!.trim() : undefined;
}

/**
 * The pin key's hash for a request, or null for the client's per-provider pin.
 * The first listed header present decides: repeated, empty or over 256
 * characters is no key. Takes the request's `rawHeaders`, so a repeat that
 * Node would collapse is still seen.
 */
export function pinKeyOf(
  provider: LeaseProvider,
  rawHeaders: readonly string[],
): string | null {
  for (const name of SESSION_KEY_HEADERS[provider]) {
    const values = rawValues(rawHeaders, name);
    if (values.length === 0) continue;
    const key = values.length === 1 ? values[0]!.trim() : "";
    return key !== "" && key.length <= MAX_SESSION_KEY_CHARS
      ? createHash("sha256").update(key, "utf8").digest("hex")
      : null;
  }
  return null;
}

/** How a 429's stated reset classifies (amendment A3). */
export interface ResetClass {
  /** Long moves the pin; an unknown reset is long. */
  long: boolean;
  /** The bench's end, or undefined when the reset is now or past. */
  benchUntil: number | undefined;
}

const SECONDS_RE = /^\d+$/;
const DECIMAL_RE = /^\d+(?:\.\d+)?$/;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTH_RE = `(${MONTHS.join("|")})`;
/**
 * RFC 9110's three HTTP-date forms, each matched strictly: the preferred
 * IMF-fixdate, then the obsolete RFC 850 and asctime forms. `Date.parse` is
 * never given the raw value, since it also reads numbers and other text.
 */
const IMF_FIXDATE_RE = new RegExp(
  `^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\\d{2}) ${MONTH_RE} (\\d{4}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
);
const RFC850_DATE_RE = new RegExp(
  `^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d{2})-${MONTH_RE}-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
);
const ASCTIME_DATE_RE = new RegExp(
  `^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ${MONTH_RE} ( \\d|\\d{2}) (\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$`,
);

/**
 * The instant an HTTP-date names, in any of its three forms, or undefined
 * when the value is not one. RFC 850's two-digit year is the most recent
 * year not more than 50 years ahead of `now` (RFC 9110 section 5.6.7).
 */
function httpDate(value: string, now: number): number | undefined {
  const imf = IMF_FIXDATE_RE.exec(value);
  if (imf)
    return utcInstant(
      Number(imf[3]),
      imf[2]!,
      Number(imf[1]),
      imf.slice(4, 7).map(Number),
    );
  const rfc850 = RFC850_DATE_RE.exec(value);
  if (rfc850)
    return utcInstant(
      twoDigitYear(rfc850[3]!, now),
      rfc850[2]!,
      Number(rfc850[1]),
      rfc850.slice(4, 7).map(Number),
    );
  const asctime = ASCTIME_DATE_RE.exec(value);
  if (asctime)
    return utcInstant(
      Number(asctime[6]),
      asctime[1]!,
      Number(asctime[2]),
      asctime.slice(3, 6).map(Number),
    );
  return undefined;
}

function twoDigitYear(digits: string, now: number): number {
  const nowYear = new Date(now).getUTCFullYear();
  const year = Math.floor(nowYear / 100) * 100 + Number(digits);
  return year - nowYear > 50 ? year - 100 : year;
}

/**
 * The UTC instant of an HTTP-date's fields, or undefined when they name no
 * such time: a second past 59, an hour past 23, or a day the month lacks.
 * `clock` is hour, minute, second; the regexes guarantee a month name.
 */
function utcInstant(
  year: number,
  month: string,
  day: number,
  clock: readonly number[],
): number | undefined {
  const [hour = NaN, minute = NaN, second = NaN] = clock;
  if (!(hour <= 23 && minute <= 59 && second <= 59)) return undefined;
  const instant = Date.UTC(
    year,
    MONTHS.indexOf(month),
    day,
    hour,
    minute,
    second,
  );
  // Date.UTC rolls an impossible day over (31 Nov becomes 1 Dec): reject it.
  return new Date(instant).getUTCDate() === day ? instant : undefined;
}

function retryAfterReset(
  rawHeaders: readonly string[],
  now: number,
): number | undefined {
  const value = onlyValue(rawHeaders, "retry-after");
  if (value === undefined) return undefined;
  if (SECONDS_RE.test(value)) {
    const reset = now + Number(value) * 1000;
    return Number.isFinite(reset) ? reset : undefined;
  }
  return httpDate(value, now);
}

function codexReset(
  rawHeaders: readonly string[],
  now: number,
): number | undefined {
  const resets: number[] = [];
  const read = (name: string, toReset: (value: number) => number): void => {
    const value = onlyValue(rawHeaders, name);
    if (value === undefined || !DECIMAL_RE.test(value)) return;
    const reset = toReset(Number(value));
    if (Number.isFinite(reset)) resets.push(reset);
  };
  for (const name of CODEX_RESET_AT) read(name, (seconds) => seconds * 1000);
  for (const name of CODEX_RESET_AFTER)
    read(name, (seconds) => now + seconds * 1000);
  // The account serves again only once every stated window has reset.
  return resets.length ? Math.max(...resets) : undefined;
}

/**
 * Classifies a model-run 429 by its stated reset: `retry-after` sent once,
 * else on `/chatgpt` the latest valid Codex reset. A reset now or past is
 * short with no bench; up to `MACHINE_SHORT_LIMIT_MS` short; beyond, long.
 * No valid reset is long, benched `RATE_LIMIT_BENCH_MS`.
 */
export function classifyReset(
  provider: LeaseProvider,
  rawHeaders: readonly string[],
  now: number,
): ResetClass {
  const reset =
    retryAfterReset(rawHeaders, now) ??
    (provider === "openai-codex" ? codexReset(rawHeaders, now) : undefined);
  if (reset === undefined)
    return { long: true, benchUntil: now + RATE_LIMIT_BENCH_MS };
  const remaining = reset - now;
  if (remaining <= 0) return { long: false, benchUntil: undefined };
  return { long: remaining > MACHINE_SHORT_LIMIT_MS, benchUntil: reset };
}

/** A pin's address: the client, the route's provider and the key's hash. */
export interface PinRef {
  clientId: string;
  provider: LeaseProvider;
  /** Hex SHA-256 of the session key; null for the client's provider pin. */
  keyHash: string | null;
}

/** A pin as saved in `machinePins.json`: hashes, ids and times only. */
export interface MachinePinRecord extends PinRef {
  profileId: string;
  /** Profile ids, in the order the session left them. */
  tried: string[];
  /** Epoch milliseconds. */
  lastUsedAt: number;
}

/** What a request is served on, captured for the final validation. */
export interface MachineSelection {
  userId: string;
  pin: PinRef;
  binding: LoginBinding;
  /** The client's machine lease on the profile. */
  leaseId: string;
}

export type MachineSelectOutcome =
  | { ok: true; selection: MachineSelection }
  /** The user has no usable account of the provider. */
  | { ok: false; refusal: "machine-pool-empty" }
  /** Every usable account is tried and benched; retry after the first ends. */
  | {
      ok: false;
      refusal: "machine-session-limited";
      retryAfterSeconds: number;
    };

export interface MachinePoolOptions {
  /** Grants, finds and revokes the clients' machine leases. */
  leases: LeaseTable;
  /** The registry's accounts of a user (`ClientRegistry.accountsOf`). */
  accountsOf: (userId: string) => readonly string[];
  /** The edge's profile table. */
  profile: (profileId: string) => GatewayProfile | undefined;
  /** The vault's needs-login set. */
  needsLogin: () => readonly string[];
  now?: (() => number) | undefined;
  /** Saves every pin, throwing when it cannot. Without it, memory only. */
  persist?: ((records: MachinePinRecord[]) => void) | undefined;
  log?: ((line: string) => void) | undefined;
}

interface Pin {
  profileId: string;
  tried: Set<string>;
  lastUsedAt: number;
}

interface Bench {
  until: number;
  long: boolean;
}

type StoredPin = Pin & PinRef;

type Candidate = RankingCandidate & { login: LoginProfile };

function pinKey({ clientId, provider, keyHash }: PinRef): string {
  return `${clientId}\n${provider}\n${keyHash ?? ""}`;
}

export class MachinePool {
  private readonly pins = new Map<string, StoredPin>();
  private readonly benches = new Map<string, Bench>();
  private readonly options: MachinePoolOptions;
  private readonly now: () => number;
  /** Whether memory may be ahead of the file. */
  private unsaved = false;
  private lastSaveAt = -Infinity;
  private lastSweepAt: number;

  constructor(options: MachinePoolOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.lastSweepAt = this.now();
  }

  /**
   * The account a request is served on, and its machine lease, or a refusal.
   * May pin, move a pin or grant the lease; a lease save that throws
   * propagates and nothing is served.
   */
  select(userId: string, ref: PinRef): MachineSelectOutcome {
    const now = this.now();
    if (now - this.lastSweepAt >= SWEEP_EVERY_MS) this.sweep();
    const usable = this.usable(userId, ref.provider);
    if (usable.length === 0)
      return { ok: false, refusal: "machine-pool-empty" };
    const key = pinKey(ref);
    const pin = this.pins.get(key);
    if (!pin) {
      // The best eligible account, else the best usable (benched) one.
      const target = this.best(usable, false)!;
      this.pins.set(key, {
        ...ref,
        profileId: target.login.id,
        tried: new Set(),
        lastUsedAt: now,
      });
      this.evictOverCap(ref.clientId);
      this.save();
      return this.served(userId, ref, target.login);
    }
    pin.lastUsedAt = now;
    const pinned = usable.find(({ login }) => login.id === pin.profileId);
    if (pinned) {
      // Eligible or short-benched: the pin stays, always.
      if (this.bench(pinned.login.id)?.long) this.leaveLong(pin, userId);
      else this.touched();
      const current =
        usable.find(({ login }) => login.id === pin.profileId) ?? pinned;
      return this.served(userId, ref, current.login);
    }
    // The pinned account cannot serve: a forced move (amendment A1).
    const untried = usable.filter(({ login }) => !pin.tried.has(login.id));
    const tried = usable.filter(({ login }) => pin.tried.has(login.id));
    const target =
      this.best(untried, true) ??
      this.best(tried, true) ??
      this.best(untried, false);
    if (!target) {
      this.touched();
      const firstEnd = Math.min(
        ...usable.map(({ login }) => this.bench(login.id)?.until ?? now),
      );
      return {
        ok: false,
        refusal: "machine-session-limited",
        retryAfterSeconds: Math.max(1, Math.ceil((firstEnd - now) / 1000)),
      };
    }
    this.move(pin, target.login.id);
    this.save();
    return this.served(userId, ref, target.login);
  }

  /**
   * Records a model-run response from any lease kind, once its headers
   * arrive. A 429 benches the profile; a long one also moves the session's
   * pin, if it still names the profile, to the best eligible untried account.
   * A 2xx clears the bench. Never throws for a failed save.
   */
  observe(
    evidence: {
      provider: LeaseProvider;
      profileId: string;
      /** The machine request's selection; absent on the lease path. */
      selection?: MachineSelection | undefined;
    },
    status: number,
    rawHeaders: readonly string[],
  ): void {
    const now = this.now();
    const { profileId, selection } = evidence;
    if (status >= 200 && status < 300) {
      this.benches.delete(profileId);
      return;
    }
    if (status !== 429) return;
    const reset = classifyReset(evidence.provider, rawHeaders, now);
    if (reset.benchUntil !== undefined) {
      const active = this.bench(profileId);
      this.benches.set(
        profileId,
        active
          ? {
              until: Math.max(active.until, reset.benchUntil),
              long: active.long || reset.long,
            }
          : { until: reset.benchUntil, long: reset.long },
      );
    }
    if (!reset.long || !selection) return;
    const pin = this.pins.get(pinKey(selection.pin));
    if (!pin) return;
    if (pin.profileId === profileId) this.leaveLong(pin, selection.userId);
    else if (!pin.tried.has(profileId)) {
      pin.tried.add(profileId);
      this.save();
    }
  }

  /**
   * Whether a selection still holds: its machine lease is live, its pin still
   * names its profile and that profile is still usable. The client's own
   * standing is the caller's to check.
   */
  isCurrent(selection: MachineSelection): boolean {
    const pin = this.pins.get(pinKey(selection.pin));
    const { profileId } = selection.binding;
    return (
      this.options.leases.isLive(selection.leaseId) &&
      pin?.profileId === profileId &&
      this.usable(selection.userId, selection.pin.provider).some(
        ({ login }) => login.id === profileId,
      )
    );
  }

  /** Drops a revoked client's pins; its leases are the revoke's. */
  dropClient(clientId: string): void {
    let dropped = false;
    for (const [key, pin] of this.pins)
      if (pin.clientId === clientId) {
        this.pins.delete(key);
        dropped = true;
      }
    if (dropped) this.save();
  }

  /**
   * Drops pins unused for `PIN_IDLE_MS`, then revokes each machine lease no
   * remaining pin of its client uses.
   */
  sweep(): void {
    const now = this.now();
    this.lastSweepAt = now;
    let dropped = false;
    for (const [key, pin] of this.pins)
      if (pin.lastUsedAt <= now - PIN_IDLE_MS) {
        this.pins.delete(key);
        dropped = true;
      }
    if (dropped) this.save();
    this.releaseUnpinnedLeases();
    for (const [profileId, bench] of this.benches)
      if (bench.until <= now) this.benches.delete(profileId);
  }

  /** Loads saved pins into an empty pool, without saving, then sweeps. */
  restore(records: readonly MachinePinRecord[]): void {
    for (const record of records)
      this.pins.set(pinKey(record), {
        clientId: record.clientId,
        provider: record.provider,
        keyHash: record.keyHash,
        profileId: record.profileId,
        tried: new Set(record.tried),
        lastUsedAt: record.lastUsedAt,
      });
    for (const clientId of new Set(records.map((r) => r.clientId)))
      this.evictOverCap(clientId);
    this.sweep();
  }

  records(): MachinePinRecord[] {
    return [...this.pins.values()].map((pin) => ({
      clientId: pin.clientId,
      provider: pin.provider,
      keyHash: pin.keyHash,
      profileId: pin.profileId,
      tried: [...pin.tried],
      lastUsedAt: pin.lastUsedAt,
    }));
  }

  /** The profile's active bench, if any. */
  private bench(profileId: string): Bench | undefined {
    const bench = this.benches.get(profileId);
    return bench && bench.until > this.now() ? bench : undefined;
  }

  /**
   * Usable: a login profile on the edge that the user owns in the registry,
   * of the provider, enabled and not needing a login. Eligible adds: not
   * benched, which the ranking reads as `limited`.
   */
  private usable(userId: string, provider: LeaseProvider): Candidate[] {
    const needsLogin = new Set(this.options.needsLogin());
    const candidates: Candidate[] = [];
    for (const id of new Set(this.options.accountsOf(userId))) {
      const profile = this.options.profile(id);
      if (
        !profile ||
        !isLoginProfile(profile) ||
        profile.provider !== provider ||
        !profile.enabled ||
        needsLogin.has(id)
      )
        continue;
      candidates.push({
        profile: { id, enabled: true, health: { state: "ok" } },
        offersModel: true,
        usage: null,
        limited: this.bench(id) !== undefined,
        login: profile,
      });
    }
    return candidates;
  }

  /** The ranking's best: an eligible one only, or any usable one. */
  private best(
    candidates: readonly Candidate[],
    eligibleOnly: boolean,
  ): Candidate | undefined {
    const ranked = rankCandidates(candidates, NO_USAGE_THRESHOLDS, this.now());
    return ranked && (ranked.eligible || !eligibleOnly)
      ? ranked.pick
      : undefined;
  }

  /**
   * A long limit on the pinned account: it joins the tried set, and the pin
   * moves to the best eligible untried account if there is one. Saves.
   */
  private leaveLong(pin: StoredPin, userId: string): void {
    const left = pin.profileId;
    const target = this.best(
      this.usable(userId, pin.provider).filter(
        ({ login }) => login.id !== left && !pin.tried.has(login.id),
      ),
      true,
    );
    if (target) this.move(pin, target.login.id);
    else if (!pin.tried.has(left)) pin.tried.add(left);
    else return this.touched();
    this.save();
  }

  /** The left account joins the tried set; a returned-to one stays in it. */
  private move(pin: Pin, profileId: string): void {
    pin.tried.add(pin.profileId);
    pin.profileId = profileId;
  }

  private served(
    userId: string,
    ref: PinRef,
    login: LoginProfile,
  ): MachineSelectOutcome {
    const binding: LoginBinding = {
      profileId: login.id,
      provider: login.provider,
      tokenFile: login.tokenFile,
    };
    const { leases } = this.options;
    const leaseId =
      leases.liveMachineLease(ref.clientId, login.id) ??
      leases.grantMachine(binding, ref.clientId);
    return {
      ok: true,
      selection: { userId, pin: { ...ref }, binding, leaseId },
    };
  }

  /** Drops a client's least recently used pins over the cap. */
  private evictOverCap(clientId: string): void {
    const own = [...this.pins].filter(([, pin]) => pin.clientId === clientId);
    if (own.length <= MAX_PINS_PER_CLIENT) return;
    own.sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt);
    for (const [key] of own.slice(0, own.length - MAX_PINS_PER_CLIENT))
      this.pins.delete(key);
    this.releaseUnpinnedLeases();
  }

  /** Revokes each live machine lease no pin of its client names. */
  private releaseUnpinnedLeases(): void {
    const used = new Set(
      [...this.pins.values()].map((pin) => `${pin.clientId}\n${pin.profileId}`),
    );
    this.options.leases.revokeWhere(
      (record) =>
        record.kind === "machine" &&
        !used.has(`${record.owner.clientId}\n${record.profileId}`),
      "session-ended",
    );
  }

  /** A use alone saves at most every `LAST_USE_SAVE_MS`. */
  private touched(): void {
    if (this.unsaved || this.now() - this.lastSaveAt >= LAST_USE_SAVE_MS)
      this.save();
  }

  private save(): void {
    this.unsaved = true;
    if (!this.options.persist) return;
    this.lastSaveAt = this.now();
    try {
      this.options.persist(this.records());
      this.unsaved = false;
    } catch {
      this.options.log?.("machine pins: save failed; kept in memory");
    }
  }
}

/** One saved pin, or undefined when it does not validate. */
export function parsePinRecord(value: unknown): MachinePinRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const r = value as Record<string, unknown>;
  if (
    typeof r.clientId !== "string" ||
    r.clientId === "" ||
    r.clientId.length > 256 ||
    !isLeaseProvider(r.provider) ||
    (r.keyHash !== null &&
      (typeof r.keyHash !== "string" || !KEY_HASH_RE.test(r.keyHash))) ||
    !isProfileId(r.profileId) ||
    !Array.isArray(r.tried) ||
    !r.tried.every(isProfileId) ||
    typeof r.lastUsedAt !== "number" ||
    !Number.isSafeInteger(r.lastUsedAt) ||
    r.lastUsedAt < 0
  )
    return undefined;
  return {
    clientId: r.clientId,
    provider: r.provider,
    keyHash: r.keyHash,
    profileId: r.profileId,
    tried: [...new Set(r.tried as string[])],
    lastUsedAt: r.lastUsedAt,
  };
}

/** The key `machinePins.json` deduplicates records by. */
export const pinRecordKey = (record: MachinePinRecord): string =>
  pinKey(record);
