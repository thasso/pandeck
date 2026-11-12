/**
 * The OIDC authorization-code flow with PKCE against the configured issuer
 * (Task-1402), on `oauth4webapi` 3.8.8 as measured by the plan's spike. The
 * library checks state, iss, aud, azp, exp, the presence and type of iat and
 * sub, the nonce and that an ID token came. This module adds what it leaves
 * out: the ID token's signature against the discovered `jwks_uri`, and an
 * `iat` more than 30 s ahead. `admittedEmail` (`config.ts`) owns
 * `email_verified` and `email`.
 *
 * Discovery must name the configured issuer exactly, and every endpoint the
 * flow uses (authorization, token, key set) must be `https`. The key set is
 * read within 10 s and 64 KiB through one fetch at a time per issuer, and the
 * network is asked at most once a minute: a waiting callback shares the fetch
 * in flight, and within the minute after a fetch, success or failure, the
 * last good set answers (or the sign-in fails as `keys` when there is none).
 * So no number of forged `kid`s can make the gateway hammer the issuer.
 * `OidcTestOptions` (HTTP endpoints, a fetch) come only from tests, never
 * from the config file.
 */
import * as oauth from "oauth4webapi";

/** Every provider call gives up after this long. */
const PROVIDER_TIMEOUT_MS = 10_000;
/** How long a discovery answer is reused. */
const DISCOVERY_TTL_MS = 60 * 60_000;
/** How far ahead of the clock an `iat` may be, as the library allows `exp`. */
const IAT_TOLERANCE_S = 30;
/** The largest key set the gateway reads. */
const MAX_JWKS_BYTES = 64 * 1024;
/** The least time between two fetches of the issuer's key set. */
const KEYS_REFETCH_MS = 60_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Only tests start the server with these. */
export interface OidcTestOptions {
  /** Lets the provider's endpoints use `http://`. */
  allowInsecureRequests?: boolean;
  /** Answers every provider request instead of the network. */
  fetch?: Fetch;
}

/** Where a failed sign-in failed; a fixed word for the log line. */
export type OidcFailureStage =
  "discovery" | "exchange" | "keys" | "signature" | "claims" | "state";

export class OidcFailure extends Error {
  constructor(readonly stage: OidcFailureStage) {
    super(`OIDC sign-in failed (${stage})`);
  }
}

/** The issuer's key set could not be read: unreachable, refused or too big. */
class KeysUnavailable extends Error {}

/** The library's request as `fetch` options; absent fields stay absent. */
function requestInit(
  init: oauth.CustomFetchOptions<string, unknown>,
): RequestInit {
  return {
    method: init.method,
    headers: init.headers,
    redirect: init.redirect,
    ...(init.body === undefined ? {} : { body: init.body as BodyInit }),
    ...(init.signal ? { signal: init.signal } : {}),
  };
}

interface KeySet {
  /** The JSON text. */
  body: string;
  type: string;
}

/** One read of the key set, its body bounded; any failure is `KeysUnavailable`. */
async function readKeySet(
  fetcher: Fetch,
  url: string,
  init: RequestInit,
): Promise<KeySet> {
  try {
    const response = await fetcher(url, init);
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new KeysUnavailable();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JWKS_BYTES) {
        await reader.cancel();
        throw new KeysUnavailable();
      }
      chunks.push(value);
    }
    return {
      body: Buffer.concat(chunks).toString("utf8"),
      type: response.headers.get("content-type") ?? "",
    };
  } catch {
    throw new KeysUnavailable();
  }
}

/**
 * The library's key-set fetch for one issuer: a single fetch in flight that
 * every caller shares, and at most one fetch per `KEYS_REFETCH_MS`, whatever
 * the library asks. A failed fetch starts the wait too; meanwhile the last
 * good set answers, or `KeysUnavailable` when there is none.
 */
function keySetFetch(
  fetcher: Fetch,
  now: () => number,
): (url: string, init: oauth.CustomFetchOptions<"GET">) => Promise<Response> {
  let held: (KeySet & { url: string }) | undefined;
  let lastFetch: { url: string; at: number } | undefined;
  let inFlight: { url: string; keys: Promise<KeySet> } | undefined;
  const answer = (keys: KeySet): Response =>
    new Response(keys.body, {
      status: 200,
      headers: { "content-type": keys.type },
    });
  return async (url, init) => {
    if (inFlight?.url === url) return answer(await inFlight.keys);
    if (lastFetch?.url === url && now() - lastFetch.at < KEYS_REFETCH_MS) {
      if (held?.url === url) return answer(held);
      throw new KeysUnavailable();
    }
    lastFetch = { url, at: now() };
    const keys = readKeySet(fetcher, url, requestInit(init));
    inFlight = { url, keys };
    try {
      const read = await keys;
      held = { url, ...read };
      return answer(read);
    } finally {
      if (inFlight?.keys === keys) inFlight = undefined;
    }
  };
}

/** What one sign-in keeps until its callback. */
export interface AuthorizationRequest {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcClient {
  /** A fresh request and the provider URL that starts it. */
  begin(): Promise<{ request: AuthorizationRequest; url: URL }>;
  /**
   * The validated ID token claims of the callback at `callbackUrl` for
   * `request`; throws `OidcFailure`.
   */
  finish(
    callbackUrl: URL,
    request: AuthorizationRequest,
  ): Promise<Record<string, unknown>>;
}

export function createOidcClient(options: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  now: () => number;
  test?: OidcTestOptions;
}): OidcClient {
  const { clientId, clientSecret, redirectUri, now } = options;
  const issuer = new URL(options.issuer);
  const insecure = options.test?.allowInsecureRequests === true;
  const testFetch = options.test?.fetch;
  const http = () => ({
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    ...(insecure ? { [oauth.allowInsecureRequests]: true } : {}),
    ...(testFetch
      ? {
          [oauth.customFetch]: (
            url: string,
            init: oauth.CustomFetchOptions<string, unknown>,
          ) => testFetch(url, requestInit(init)),
        }
      : {}),
  });
  const keysFetch = keySetFetch(testFetch ?? fetch, now);
  /** An endpoint the flow may use: `https`, or `http` in tests only. */
  const usable = (value: unknown): boolean => {
    if (typeof value !== "string") return false;
    try {
      const { protocol } = new URL(value);
      return protocol === "https:" || (insecure && protocol === "http:");
    } catch {
      return false;
    }
  };
  // The library times on its own clock; align it with the injected one.
  const client = (): oauth.Client => ({
    client_id: clientId,
    [oauth.clockSkew]: Math.round((now() - Date.now()) / 1000),
  });

  let discovered: { as: oauth.AuthorizationServer; at: number } | undefined;
  const server = async (): Promise<oauth.AuthorizationServer> => {
    if (discovered && now() - discovered.at < DISCOVERY_TTL_MS)
      return discovered.as;
    try {
      const as = await oauth.processDiscoveryResponse(
        issuer,
        await oauth.discoveryRequest(issuer, http()),
      );
      if (
        as.issuer !== options.issuer ||
        ![as.authorization_endpoint, as.token_endpoint, as.jwks_uri].every(
          usable,
        )
      )
        throw new Error("unusable discovery document");
      discovered = { as, at: now() };
      return as;
    } catch {
      throw new OidcFailure("discovery");
    }
  };

  return {
    async begin() {
      const as = await server();
      const request: AuthorizationRequest = {
        state: oauth.generateRandomState(),
        nonce: oauth.generateRandomNonce(),
        codeVerifier: oauth.generateRandomCodeVerifier(),
      };
      const url = new URL(as.authorization_endpoint!);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", "openid email");
      url.searchParams.set(
        "code_challenge",
        await oauth.calculatePKCECodeChallenge(request.codeVerifier),
      );
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", request.state);
      url.searchParams.set("nonce", request.nonce);
      return { request, url };
    },

    async finish(callbackUrl, request) {
      const as = await server();
      let parameters: URLSearchParams;
      try {
        parameters = oauth.validateAuthResponse(
          as,
          client(),
          callbackUrl,
          request.state,
        );
      } catch (err) {
        // The provider's own refusal (the person declined, say) is the
        // exchange failing; anything else is a response not for this state.
        throw new OidcFailure(
          err instanceof oauth.AuthorizationResponseError
            ? "exchange"
            : "state",
        );
      }
      let response: Response;
      try {
        response = await oauth.authorizationCodeGrantRequest(
          as,
          client(),
          oauth.ClientSecretBasic(clientSecret),
          parameters,
          redirectUri,
          request.codeVerifier,
          http(),
        );
      } catch {
        throw new OidcFailure("exchange");
      }
      let answer: oauth.TokenEndpointResponse;
      try {
        answer = await oauth.processAuthorizationCodeResponse(
          as,
          client(),
          response,
          { expectedNonce: request.nonce, requireIdToken: true },
        );
      } catch (err) {
        throw new OidcFailure(
          err instanceof oauth.ResponseBodyError ||
            err instanceof oauth.WWWAuthenticateChallengeError
            ? "exchange"
            : "claims",
        );
      }
      try {
        await oauth.validateApplicationLevelSignature(as, response, {
          ...http(),
          [oauth.customFetch]: keysFetch,
        });
      } catch (err) {
        throw new OidcFailure(
          err instanceof KeysUnavailable ? "keys" : "signature",
        );
      }
      const claims = oauth.getValidatedIdTokenClaims(answer);
      if (!claims) throw new OidcFailure("claims");
      if (
        typeof claims.iat !== "number" ||
        claims.iat > Math.floor(now() / 1000) + IAT_TOLERANCE_S
      )
        throw new OidcFailure("claims");
      return claims as Record<string, unknown>;
    },
  };
}
