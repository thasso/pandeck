/**
 * The vault's `github.token` (Task-1444, Task-1440 plan v06 AC5, AC5b, AC8):
 * a READ installation token for one repository, only after the user's own
 * token proves, on this call, that GitHub lets them pull it. The steps are in
 * `vaultGithub.ts`; this module orders, caches and bounds them.
 *
 * 1. `owner` and `repo` are GitHub names and the request has no other member
 *    (an `access`, say): else `invalid`, before any call.
 * 2. The user's access view, as a get answers it, noting the record's
 *    generation first; absent, rejected and locked pass through.
 * 3. The repository check with the user's token (`denied` or the id, rid).
 * 4. A cached token for (installation, rid) with over 10 minutes left is
 *    answered, if the generation still holds.
 * 5. The App's JWT (reused until a minute before its expiry), the
 *    installation (cached per rid for an hour), the mint, and the proof. A
 *    token that fails the proof is revoked if it is one at all (F13).
 * 6. Before answering, the generation must still hold, the budget be unspent
 *    and the vault open; else the proven token is dropped, neither cached nor
 *    revoked. Only then is it cached.
 *
 * The fence is checked after the user check and the installation lookup,
 * before their outcome is read, so a check against a record that has since
 * moved answers unavailable, never `denied`. A mint answer is always proven:
 * the fence decides only delivery and caching, never cleanup, so a token that
 * passes `isToken` and fails the proof is revoked whatever the generation, and
 * a proven token for a stale generation is dropped (step 6). Step 2's own
 * negative answers (absent, rejected) come from that read itself, so they pass
 * through.
 *
 * The whole call has 25 s; each GitHub call keeps its own 8 s. A spent
 * budget, `close()` or the caller's signal answers unavailable at once and
 * leaves whatever runs to finish unread: a late token is never cached. The
 * access view's refresh runs in the record's lane and is never cancelled.
 *
 * Log lines hold the record's directory id and fixed words only.
 */
import type { GithubAppClient } from "./integrationClients.ts";
import {
  JWT_RENEW_MARGIN_MS,
  githubAppJwt,
  githubInstallation,
  githubRepo,
  mintReadToken,
  proveReadToken,
  revokeInstallationToken,
  type GithubEndpoint,
} from "./vaultGithub.ts";
import { isGithubTokenRequest } from "./vaultMethods.ts";
import type {
  GithubToken,
  GithubTokenRequest,
  IntegrationRecord,
} from "./vaultPort.ts";

/** The whole call's budget inside the vault. */
const GITHUB_TOKEN_BUDGET_MS = 25_000;
/** A cached token with less left than this is not handed out. */
const CACHED_TOKEN_MIN_LEFT_MS = 10 * 60_000;
/** How long a repository's installation id is believed. */
const INSTALLATION_CACHE_MS = 60 * 60_000;

const UNAVAILABLE = { ok: false, unavailable: true } as const;
const INVALID = { ok: false, invalid: true } as const;
const DENIED = { ok: false, denied: true } as const;

/** The user's token, with whether the record is still the one it came from. */
export type GithubAccess =
  | { ok: true; dirId: string; accessToken: string; current(): boolean }
  | Exclude<IntegrationRecord, { ok: true }>;

export interface GithubTokenDeps {
  client: GithubAppClient | undefined;
  endpoint: GithubEndpoint | undefined;
  /** Step 2: notes the generation, then reads the access view. */
  access(userId: string, signal: AbortSignal): Promise<GithubAccess>;
  log(line: string): void;
  now(): number;
  /** Test seam: the whole call's budget; 25 s. */
  budgetMs?: number | undefined;
}

export interface GithubTokens {
  token(
    userId: string,
    request: GithubTokenRequest,
    options?: { signal?: AbortSignal },
  ): Promise<GithubToken>;
  /** Answers every call in flight unavailable and every later one too. */
  close(): void;
}

const CUT = Symbol("cut");

export function createGithubTokens(deps: GithubTokenDeps): GithubTokens {
  const closing = new AbortController();
  /** Proven tokens by `${installationId}/${rid}`; memory only. */
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  const installations = new Map<
    number,
    { installationId: number; until: number }
  >();
  let appJwt: { jwt: string; expiresAt: number } | undefined;

  const jwtOf = (client: GithubAppClient): string => {
    const at = deps.now();
    if (!appJwt || appJwt.expiresAt - at <= JWT_RENEW_MARGIN_MS)
      appJwt = githubAppJwt(client, at);
    return appJwt.jwt;
  };

  const cachedToken = (key: string) => {
    const cached = tokens.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt - deps.now() > CACHED_TOKEN_MIN_LEFT_MS) return cached;
    tokens.delete(key);
    return undefined;
  };

  const run = async (
    userId: string,
    name: GithubTokenRequest,
    client: GithubAppClient,
    within: <T>(work: () => Promise<T>) => Promise<T | typeof CUT>,
    stop: AbortSignal,
  ): Promise<GithubToken> => {
    const access = await within(() => deps.access(userId, stop));
    if (access === CUT) return UNAVAILABLE;
    if (!access.ok) return access;
    const { dirId } = access;
    const answerable = (): boolean => !stop.aborted && access.current();

    const repo = await within(() =>
      githubRepo(access.accessToken, name, deps.endpoint),
    );
    if (repo === CUT) return UNAVAILABLE;
    // A check against a record that has since moved proves nothing, either
    // way: the fence comes before any outcome, `denied` included.
    if (!answerable()) return UNAVAILABLE;
    if (repo.kind === "denied") return DENIED;
    if (repo.kind === "unavailable") {
      deps.log(`github.token ${dirId}: repository check failed (${repo.code})`);
      return UNAVAILABLE;
    }
    const { rid } = repo;

    let installation = installations.get(rid);
    if (installation && installation.until <= deps.now()) {
      installations.delete(rid);
      installation = undefined;
    }
    if (installation) {
      const cached = cachedToken(`${installation.installationId}/${rid}`);
      if (cached)
        return answerable()
          ? { ok: true, token: cached.token, expiresAt: cached.expiresAt }
          : UNAVAILABLE;
    }

    if (!installation) {
      const found = await within(() =>
        githubInstallation(jwtOf(client), name, deps.endpoint),
      );
      if (found === CUT || !answerable()) return UNAVAILABLE;
      if (found.kind === "denied") return DENIED;
      if (found.kind === "unavailable") {
        deps.log(
          `github.token ${dirId}: installation lookup failed (${found.code})`,
        );
        return UNAVAILABLE;
      }
      installation = {
        installationId: found.installationId,
        until: deps.now() + INSTALLATION_CACHE_MS,
      };
      installations.set(rid, installation);
      const cached = cachedToken(`${found.installationId}/${rid}`);
      if (cached)
        return answerable()
          ? { ok: true, token: cached.token, expiresAt: cached.expiresAt }
          : UNAVAILABLE;
    }
    const { installationId } = installation;
    if (!answerable()) return UNAVAILABLE;

    const minted = await within(() =>
      mintReadToken(jwtOf(client), installationId, rid, deps.endpoint),
    );
    if (minted === CUT) return UNAVAILABLE;
    if (minted.kind === "unavailable") {
      // The App may have lost the repository: look it up afresh next time.
      installations.delete(rid);
      deps.log(`github.token ${dirId}: mint failed (${minted.code})`);
      return UNAVAILABLE;
    }
    // No fence here: the proof decides cleanup whatever the generation, so a
    // stale token that fails it is revoked like any other (AC5 step 7).
    const proof = await within(() =>
      proveReadToken(minted.body, rid, deps.now, deps.endpoint),
    );
    if (proof === CUT) return UNAVAILABLE;
    if (proof.kind === "failed") {
      deps.log(
        `github.token ${dirId}: mint answer failed its proof (${proof.reason}); revoke ${proof.token !== undefined}`,
      );
      const { token } = proof;
      if (token !== undefined) {
        // Sent even past the budget; only the wait for it is bounded.
        const revoking = revokeInstallationToken(token, deps.endpoint);
        await within(() => revoking);
      }
      return UNAVAILABLE;
    }
    if (!answerable()) {
      deps.log(`github.token ${dirId}: proven token dropped`);
      return UNAVAILABLE;
    }
    tokens.set(`${installationId}/${rid}`, {
      token: proof.token,
      expiresAt: proof.expiresAt,
    });
    return { ok: true, token: proof.token, expiresAt: proof.expiresAt };
  };

  return {
    async token(userId, request, { signal } = {}) {
      if (!isGithubTokenRequest(request)) return INVALID;
      if (closing.signal.aborted || signal?.aborted) return UNAVAILABLE;
      const { client } = deps;
      if (!client) {
        deps.log("github.token: no GitHub App configured");
        return UNAVAILABLE;
      }
      // One stop for the call: the budget, close() or the caller's signal.
      const stop = new AbortController();
      const timer = setTimeout(
        () => stop.abort(),
        deps.budgetMs ?? GITHUB_TOKEN_BUDGET_MS,
      );
      const onStop = (): void => stop.abort();
      closing.signal.addEventListener("abort", onStop, { once: true });
      signal?.addEventListener("abort", onStop, { once: true });
      const cut = new Promise<typeof CUT>((resolve) => {
        stop.signal.addEventListener("abort", () => resolve(CUT), {
          once: true,
        });
      });
      /** Starts `work` only while the call may go on; cut short by `stop`. */
      const within = <T>(work: () => Promise<T>): Promise<T | typeof CUT> =>
        stop.signal.aborted
          ? Promise.resolve(CUT)
          : Promise.race([work(), cut]);
      try {
        return await run(
          userId,
          { owner: request.owner, repo: request.repo },
          client,
          within,
          stop.signal,
        );
      } finally {
        clearTimeout(timer);
        closing.signal.removeEventListener("abort", onStop);
        signal?.removeEventListener("abort", onStop);
      }
    },
    close() {
      closing.abort();
    },
  };
}
