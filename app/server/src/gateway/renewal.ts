/**
 * The gateway's token renewal (U8, `docs/workers.md` "Renewal"): it keeps
 * every leased login profile's upstream token valid, the only refresher with
 * the switch on. An OpenAI-compatible profile has no token: every entry point
 * skips it before any read, the tick, `renew` (`skipped`, the lane never
 * entered) and `recheck`, and the request paths take only a login binding.
 *
 * A login profile is renewable while it is registered and holds a live lease,
 * whatever its `enabled` flag. A renewal runs in the profile's writer lane, so
 * a login hold fences it (`held`), and is single-flight per profile. Claude
 * renews by the CLI's own request, locks and compare-and-swap save
 * (`claudeRenewal.ts`, `refreshLock.ts`); Codex through the injected pi port,
 * whose store commits under pi's lock. This module imports no package.
 *
 * Triggers: a 60 s tick inside the margin (Claude 10 min, Codex 30 min); a
 * request whose token has at most 60 s left waits for one (bounded), one
 * inside the margin starts one; an upstream 401 for the file's current token
 * forces one, at most every 5 min. A failure backs off from 30 s, doubling to
 * 10 min. A rejected refresh is retried once if the file changed meanwhile,
 * else the profile needs a login until its file changes: requests are refused
 * with U7's text and `report` tells the server. A missing or malformed file
 * is a non-sticky needs-login, cleared by the first good read. A 401 never
 * marks a login dead. When a login hold ends the file is re-read at once
 * (`recheck`), and a due token is renewed.
 *
 * A log line names the profile, provider, outcome and a code, never a token,
 * body, scope or path.
 */
import { dirname } from "node:path";
import {
  refreshClaude,
  saveClaude,
  type TokenEndpoint,
} from "./claudeRenewal.ts";
import { LaneHeldError, type WriterLane } from "./holds.ts";
import type { LeaseTable, LoginBinding } from "./leases.ts";
import {
  readCredential,
  sameIdentity,
  type CredentialRead,
  type FileIdentity,
} from "./profileCredential.ts";
import {
  isLoginProfile,
  type LoginProfile,
  type ProfileRegistry,
} from "./profiles.ts";
import {
  withClaudeRefreshLock,
  type RefreshLockOptions,
} from "./refreshLock.ts";
import type { Refusal } from "./refusals.ts";

/**
 * pi's Codex refresh, injected (`piSdk/codexRenewal.ts`): it renews
 * `authFile`'s `openai-codex` login unless it is valid for `minValidityMs`
 * more. It answers no token and no message.
 */
export type CodexRenewPort = (
  authFile: string,
  minValidityMs: number,
  signal: AbortSignal,
) => Promise<
  { ok: true } | { ok: false; kind: "rejected" | "failed"; code: string }
>;

export const RENEW_TICK_MS = 60_000;
const CLAUDE_MARGIN_MS = 10 * 60_000;
export const CODEX_MARGIN_MS = 30 * 60_000;
/** A request whose token has this little left waits for the renewal. */
const REQUEST_WAIT_MARGIN_MS = 60_000;
/** How long a request waits for that renewal before it goes on. */
const REQUEST_WAIT_MS = 30_000;
const FORCED_INTERVAL_MS = 5 * 60_000;
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
/** Bounds the pi port's lock wait (its refresh has its own timeout). */
const CODEX_SIGNAL_MS = 60_000;

type RenewalOutcome =
  | { kind: "renewed" | "fresh" | "adopted" | "rejected" | "no-login" }
  | { kind: "held" | "skipped" }
  | { kind: "failed"; code: string };

interface ProfileState {
  inFlight?: Promise<RenewalOutcome> | undefined;
  /** Sticky: a rejected refresh, until the file's identity changes. */
  needsLogin?: { identity: FileIdentity | undefined } | undefined;
  /** Non-sticky: no file, or nothing usable in it. */
  noLogin: boolean;
  /** What `report` last said. */
  reported: boolean;
  backoffUntil: number;
  backoffMs: number;
  /** The file as it was when the backoff began; a change ends it. */
  backoffIdentity?: FileIdentity | undefined;
  last401RenewAt?: number | undefined;
}

export interface RenewalOptions {
  profiles: Pick<ProfileRegistry, "get" | "ids">;
  leases: Pick<LeaseTable, "hasLiveLease">;
  lane: Pick<WriterLane, "run">;
  log: (line: string) => void;
  now?: (() => number) | undefined;
  /** Tests: where the Claude token endpoint is reached. */
  claudeEndpoint?: TokenEndpoint | undefined;
  renewCodex?: CodexRenewPort | undefined;
  /** Tells the server a profile's needs-login changed. */
  report: (profileId: string, needsLogin: boolean) => void;
  /** Tests: the Claude lock's clock and retry sleeps. */
  lockOptions?: RefreshLockOptions | undefined;
  /**
   * A sealing vault's seal-after-write (`sealedStore.ts`): called in the lane
   * after every attempt, before its outcome settles. Never throws.
   */
  written?: ((tokenFile: string) => void) | undefined;
}

/** What a forwarded request spends, or the refusal it gets. */
type RequestCredential =
  | { ok: true; read: Extract<CredentialRead, { ok: true }> }
  | { ok: false; refusal: Refusal };

export interface Renewal {
  /** The credential for one request, renewing first when it is nearly due. */
  credentialFor(binding: LoginBinding): Promise<RequestCredential>;
  /** The upstream answered 401 to a request that sent `sentToken`. */
  upstream401(binding: LoginBinding, sentToken: string): void;
  /** One tick: renews every renewable profile inside its margin. */
  tick(): Promise<void>;
  /**
   * A login hold on the profile ended: re-reads its file as a tick does, and
   * renews it when due. Never rejects.
   */
  recheck(profileId: string): Promise<void>;
  /** Renews now; single-flight per profile. */
  renew(
    profileId: string,
    options?: { force?: boolean; rejectedToken?: string },
  ): Promise<RenewalOutcome>;
  /** The profiles that need a login now. */
  needsLogin(): string[];
  /**
   * Admits no further renewal, aborts the ones in flight and resolves once
   * each has ended, its file sealed in the lane.
   */
  close(): Promise<void>;
}

export function createRenewal(options: RenewalOptions): Renewal {
  const { profiles, leases, lane, log, report } = options;
  const now = options.now ?? Date.now;
  const states = new Map<string, ProfileState>();
  const closing = new AbortController();
  let closed = false;
  let noPortLogged = false;

  const stateOf = (profileId: string): ProfileState => {
    let state = states.get(profileId);
    if (!state) {
      state = {
        noLogin: false,
        reported: false,
        backoffUntil: 0,
        backoffMs: 0,
      };
      states.set(profileId, state);
    }
    return state;
  };

  const marginOf = (profile: Pick<LoginProfile, "provider">): number =>
    profile.provider === "claude" ? CLAUDE_MARGIN_MS : CODEX_MARGIN_MS;

  const sync = (profileId: string, state: ProfileState): void => {
    const needs = state.needsLogin !== undefined || state.noLogin;
    if (needs === state.reported) return;
    state.reported = needs;
    report(profileId, needs);
  };

  const resetBackoff = (state: ProfileState): void => {
    state.backoffUntil = 0;
    state.backoffMs = 0;
    state.backoffIdentity = undefined;
  };

  /**
   * Takes what a read says about the profile: a changed file ends a sticky
   * needs-login (and starts a renewal) and a backoff; a good read ends a
   * non-sticky one, and a missing or malformed file starts one.
   */
  const observe = (profileId: string, read: CredentialRead): void => {
    const state = stateOf(profileId);
    const identity = read.identity;
    if (
      state.backoffIdentity !== undefined &&
      !sameIdentity(state.backoffIdentity, identity)
    )
      resetBackoff(state);
    let kick = false;
    if (
      state.needsLogin &&
      (read.ok || read.problem !== "unreadable") &&
      !sameIdentity(state.needsLogin.identity, identity)
    ) {
      state.needsLogin = undefined;
      kick = true;
    }
    if (read.ok) state.noLogin = false;
    else if (read.problem !== "unreadable") state.noLogin = true;
    sync(profileId, state);
    if (kick && read.ok) void renew(profileId);
  };

  const logOutcome = (profile: LoginProfile, outcome: RenewalOutcome): void => {
    if (outcome.kind === "failed" && outcome.code === "no_port") {
      if (noPortLogged) return;
      noPortLogged = true;
    }
    log(
      `renewal ${profile.id} ${profile.provider}: ${outcome.kind}${outcome.kind === "failed" ? ` (${outcome.code})` : ""}`,
    );
  };

  /** One Claude renewal, from the first read to the save. */
  const renewClaude = async (
    profile: LoginProfile,
    first: Extract<CredentialRead, { ok: true }>,
    force: boolean,
    rejectedToken: string | undefined,
  ): Promise<RenewalOutcome> => {
    const locked = await withClaudeRefreshLock(
      dirname(profile.tokenFile),
      async (): Promise<RenewalOutcome> => {
        const current = await readCredential("claude", profile.tokenFile);
        observe(profile.id, current);
        if (!current.ok)
          return current.problem === "unreadable"
            ? { kind: "failed", code: "unreadable" }
            : { kind: "no-login" };
        const changed = current.token !== first.token;
        const outsideMargin =
          current.expiresAt !== undefined &&
          current.expiresAt - now() > CLAUDE_MARGIN_MS;
        if (
          (changed && outsideMargin) ||
          (force &&
            rejectedToken !== undefined &&
            current.token !== rejectedToken)
        )
          return { kind: "fresh" };
        if (!current.refreshToken) return { kind: "no-login" };
        const result = await refreshClaude(
          { refreshToken: current.refreshToken, scopes: current.scopes },
          options.claudeEndpoint,
          closing.signal,
        );
        if (result.kind !== "ok") return result;
        return saveClaude(
          profile.tokenFile,
          current.refreshToken,
          result.tokens,
          now(),
        );
      },
      options.lockOptions,
    );
    if (locked.ok) return locked.value;
    return locked.code === "gone"
      ? { kind: "no-login" }
      : { kind: "failed", code: locked.code };
  };

  /** One Codex renewal through the port; the file decides what happened. */
  const renewCodex = async (
    profile: LoginProfile,
    first: Extract<CredentialRead, { ok: true }> | undefined,
    force: boolean,
  ): Promise<RenewalOutcome> => {
    if (!options.renewCodex) return { kind: "failed", code: "no_port" };
    const minValidityMs =
      force && first?.expiresAt !== undefined
        ? Math.max(1, first.expiresAt - now() + 1)
        : CODEX_MARGIN_MS;
    const signal = AbortSignal.any([
      closing.signal,
      AbortSignal.timeout(CODEX_SIGNAL_MS),
    ]);
    let result: Awaited<ReturnType<CodexRenewPort>>;
    try {
      result = await options.renewCodex(
        profile.tokenFile,
        minValidityMs,
        signal,
      );
    } catch {
      result = { ok: false, kind: "failed", code: "error" };
    }
    const after = await readCredential("openai-codex", profile.tokenFile);
    observe(profile.id, after);
    // pi persists before its own checks, and another writer may have renewed.
    if (after.ok && after.token !== first?.token) return { kind: "renewed" };
    if (result.ok) return { kind: "fresh" };
    if (result.kind === "rejected") return { kind: "rejected" };
    return result.code === "no_credential" || result.code === "gone"
      ? { kind: "no-login" }
      : { kind: "failed", code: result.code };
  };

  /** One renewal attempt in the lane, from `began`, the file at its start. */
  const renewOnce = async (
    profile: LoginProfile,
    began: CredentialRead,
    force: boolean,
    rejectedToken: string | undefined,
  ): Promise<{ outcome: RenewalOutcome; began: CredentialRead }> => {
    observe(profile.id, began);
    if (profile.provider === "openai-codex") {
      if (!began.ok && began.problem === "missing")
        return { outcome: { kind: "no-login" }, began };
      return {
        outcome: await renewCodex(profile, began.ok ? began : undefined, force),
        began,
      };
    }
    if (!began.ok)
      return {
        outcome:
          began.problem === "unreadable"
            ? { kind: "failed", code: "unreadable" }
            : { kind: "no-login" },
        began,
      };
    return {
      outcome: await renewClaude(profile, began, force, rejectedToken),
      began,
    };
  };

  /**
   * Applies an outcome to the profile's state. A rejection or a backoff binds
   * to `examined`, the file the attempt started from, never to one read after
   * it: a login that lands meanwhile is a file the attempt never saw.
   */
  const settle = (
    profile: LoginProfile,
    outcome: RenewalOutcome,
    examined: FileIdentity | undefined,
  ): void => {
    const state = stateOf(profile.id);
    switch (outcome.kind) {
      case "renewed":
      case "fresh":
      case "adopted":
        resetBackoff(state);
        state.needsLogin = undefined;
        state.noLogin = false;
        break;
      case "failed": {
        state.backoffMs = Math.min(
          state.backoffMs ? state.backoffMs * 2 : BACKOFF_FIRST_MS,
          BACKOFF_MAX_MS,
        );
        state.backoffUntil = now() + state.backoffMs;
        state.backoffIdentity = examined;
        break;
      }
      case "rejected":
        state.needsLogin = { identity: examined };
        break;
      case "no-login":
        state.noLogin = true;
        break;
      default:
        break;
    }
    sync(profile.id, state);
  };

  /** One lane item; a sealing vault seals the file after it, in the lane. */
  const sealedRun = <T>(fn: () => Promise<T>, profileId: string): Promise<T> =>
    lane.run(profileId, async () => {
      try {
        return await fn();
      } finally {
        const profile = profiles.get(profileId);
        if (profile && isLoginProfile(profile))
          options.written?.(profile.tokenFile);
      }
    });

  const run = async (
    profileId: string,
    force: boolean,
    rejectedToken: string | undefined,
  ): Promise<RenewalOutcome> => {
    // No login, nothing to renew: the lane is never entered.
    const registered = profiles.get(profileId);
    if (registered && !isLoginProfile(registered)) return { kind: "skipped" };
    let profile: LoginProfile | undefined;
    let outcome: RenewalOutcome;
    // The file the attempt that decided `outcome` started from.
    let examined: FileIdentity | undefined;
    try {
      outcome = await sealedRun(async () => {
        const current = profiles.get(profileId);
        if (!current || !isLoginProfile(current))
          return { kind: "skipped" } as const;
        profile = current;
        const began = await readCredential(profile.provider, profile.tokenFile);
        examined = began.identity;
        const first = await renewOnce(profile, began, force, rejectedToken);
        if (first.outcome.kind !== "rejected") return first.outcome;
        // A login or another refresher may have changed the file meanwhile.
        const after = await readCredential(profile.provider, profile.tokenFile);
        const changed =
          !sameIdentity(first.began.identity, after.identity) ||
          (first.began.ok &&
            after.ok &&
            first.began.refreshToken !== after.refreshToken);
        if (!changed) return first.outcome;
        const again = await readCredential(profile.provider, profile.tokenFile);
        examined = again.identity;
        return (await renewOnce(profile, again, force, rejectedToken)).outcome;
      }, profileId);
    } catch (err) {
      if (err instanceof LaneHeldError) return { kind: "held" };
      outcome = { kind: "failed", code: "error" };
    }
    if (!profile || outcome.kind === "skipped") return outcome;
    settle(profile, outcome, examined);
    logOutcome(profile, outcome);
    return outcome;
  };

  function renew(
    profileId: string,
    {
      force = false,
      rejectedToken,
    }: { force?: boolean; rejectedToken?: string } = {},
  ): Promise<RenewalOutcome> {
    const state = stateOf(profileId);
    if (state.inFlight) return state.inFlight;
    // A closed renewal enters no lane: its stop awaits only what is in flight.
    if (closed) return Promise.resolve({ kind: "skipped" });
    const flight = run(profileId, force, rejectedToken).finally(() => {
      if (state.inFlight === flight) state.inFlight = undefined;
    });
    state.inFlight = flight;
    return flight;
  }

  const inBackoff = (state: ProfileState): boolean =>
    state.backoffUntil > now();

  const needsLoginRefusal = (profileId: string): Refusal | undefined => {
    const name = profiles.get(profileId)?.name;
    return name !== undefined ? { case: "needs-login", name } : undefined;
  };

  const credentialFor = async (
    binding: LoginBinding,
  ): Promise<RequestCredential> => {
    let read = await readCredential(binding.provider, binding.tokenFile);
    observe(binding.profileId, read);
    const state = stateOf(binding.profileId);
    if (state.needsLogin) {
      const refusal = needsLoginRefusal(binding.profileId);
      if (refusal) return { ok: false, refusal };
    }
    if (read.ok && read.expiresAt !== undefined && !inBackoff(state)) {
      const left = read.expiresAt - now();
      const margin =
        binding.provider === "claude" ? CLAUDE_MARGIN_MS : CODEX_MARGIN_MS;
      if (left <= REQUEST_WAIT_MARGIN_MS) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          renew(binding.profileId),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, REQUEST_WAIT_MS);
          }),
        ]);
        clearTimeout(timer);
        read = await readCredential(binding.provider, binding.tokenFile);
        observe(binding.profileId, read);
        if (state.needsLogin) {
          const refusal = needsLoginRefusal(binding.profileId);
          if (refusal) return { ok: false, refusal };
        }
      } else if (left <= margin) void renew(binding.profileId);
    }
    if (read.ok) return { ok: true, read };
    if (read.problem !== "unreadable") {
      const refusal = needsLoginRefusal(binding.profileId);
      if (refusal) return { ok: false, refusal };
    }
    return {
      ok: false,
      refusal: { case: "credential", problem: read.problem },
    };
  };

  const upstream401 = (binding: LoginBinding, sentToken: string): void => {
    const state = stateOf(binding.profileId);
    const at = now();
    if (
      state.last401RenewAt !== undefined &&
      at - state.last401RenewAt < FORCED_INTERVAL_MS
    )
      return;
    void (async () => {
      const current = await readCredential(binding.provider, binding.tokenFile);
      if (!current.ok || current.token !== sentToken) return;
      if (
        state.last401RenewAt !== undefined &&
        now() - state.last401RenewAt < FORCED_INTERVAL_MS
      )
        return;
      state.last401RenewAt = now();
      const outcome = await renew(binding.profileId, {
        force: true,
        rejectedToken: sentToken,
      });
      // A held lane renewed nothing: the next 401 may try again.
      if (outcome.kind === "held") state.last401RenewAt = undefined;
    })();
  };

  const tick = async (): Promise<void> => {
    if (closed) return;
    const due: Promise<RenewalOutcome>[] = [];
    for (const profileId of profiles.ids()) {
      const profile = profiles.get(profileId);
      if (
        !profile ||
        !isLoginProfile(profile) ||
        !leases.hasLiveLease(profileId)
      )
        continue;
      const state = stateOf(profileId);
      if (state.inFlight) continue;
      // Read first: a changed file ends a backoff or a sticky needs-login.
      const read = await readCredential(profile.provider, profile.tokenFile);
      observe(profileId, read);
      if (state.inFlight || state.needsLogin || inBackoff(state)) continue;
      if (
        read.ok &&
        read.expiresAt !== undefined &&
        read.expiresAt - now() <= marginOf(profile)
      )
        due.push(renew(profileId));
    }
    await Promise.all(due);
  };

  const recheck = async (profileId: string): Promise<void> => {
    if (closed) return;
    const profile = profiles.get(profileId);
    if (!profile || !isLoginProfile(profile)) return;
    const read = await readCredential(profile.provider, profile.tokenFile);
    observe(profileId, read);
    const state = stateOf(profileId);
    if (
      leases.hasLiveLease(profileId) &&
      read.ok &&
      read.expiresAt !== undefined &&
      read.expiresAt - now() <= marginOf(profile) &&
      !inBackoff(state) &&
      !state.needsLogin &&
      !state.inFlight
    )
      void renew(profileId);
  };

  return {
    credentialFor,
    upstream401,
    tick,
    recheck: (profileId) => recheck(profileId).catch(() => {}),
    renew,
    needsLogin: () =>
      [...states]
        .filter(([, state]) => state.reported)
        .map(([profileId]) => profileId),
    async close() {
      closed = true;
      closing.abort();
      // Each flight settles after its lane item, the seal included.
      await Promise.allSettled(
        [...states.values()].flatMap((state) => state.inFlight ?? []),
      );
    },
  };
}
