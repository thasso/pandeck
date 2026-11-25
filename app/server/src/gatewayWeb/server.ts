/**
 * The gateway's own browser listener (Task-1402, `docs/workers.md` "The
 * gateway's sign-in and UI"): HTTPS with the deployment's certificate, OIDC
 * sign-in, in-memory sessions, `/api/me`, the user's accounts and logins
 * (`/api/accounts*`, `/api/logins*`, over the injected `GatewayWebAccounts`),
 * the Atlassian credential (`/api/integrations/*`, `GatewayWebIntegrations`;
 * with an Atlassian OAuth client, "Sign in with Atlassian": a POST start
 * answering the authorize URL and `/auth/atlassian/callback`, Task-1411), the
 * Slack record (with `slack.clientId`, "Sign in with Slack" the same way,
 * `/auth/slack/callback`, its status and clear; Task-1453), the GitHub record
 * (with `github.clientId`, "Connect GitHub" the same way,
 * `/auth/github/callback`, its status, clear and a repository check that
 * answers a read token's expiry, never the token; Task-1445),
 * clients and MCP tokens (`/api/clients*`, `GatewayWebClients`), the user's
 * clients' requests (`GET /api/requests`, `GatewayWebRequests`), machines'
 * enrollment requests (`/api/enrollments/*`, Task-1410: looked up and decided
 * by user code under a per-user and global budget, `enrollmentBudget.ts`) and
 * the gateway page's built files. An enrollment code or MCP token is only in
 * the answer that creates it; no integration token is in any answer.
 *
 * A session is the actor of the logins it starts: it alone reads, feeds and
 * cancels them, and when it ends (sign-out, expiry, eviction) they are
 * cancelled. Expired sessions are swept on every request and every 60 s.
 *
 * The user comes only from the session, the session only from a validated
 * callback, the integration callbacks included. Mutations need `Origin` equal
 * to the public origin and the `x-gateway-ui: 1` header. Refusals and log
 * lines are fixed: no email, code, state, nonce, verifier, token, cookie,
 * secret, provider text, workspace name or query reaches either, nor a
 * redirect the gateway sends back to itself. An integration connect's state
 * appears only in the `authorizeUrl` of its start's answer; a checked
 * repository's names only in the check's own successful answer.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import { join } from "node:path";
import {
  GATEWAY_UI_CSRF_HEADER,
  type GatewayUiAccounts,
  type GatewayUiAtlassian,
  type GatewayUiAtlassianConnectCode,
  type GatewayUiAtlassianConnectStart,
  type GatewayUiAtlassianPreset,
  type GatewayUiClients,
  type GatewayUiEnrollmentCode,
  type GatewayUiEnrollmentRequest,
  type GatewayUiError,
  type GatewayUiGithub,
  type GatewayUiGithubCheck,
  type GatewayUiGithubConnectCode,
  type GatewayUiLogin,
  type GatewayUiLoginStart,
  type GatewayUiMcpToken,
  type GatewayUiMe,
  type GatewayUiRequests,
  type GatewayUiSigninCode,
  type GatewayUiSlack,
  type GatewayUiSlackConnectCode,
  decodeGatewayUiGithubCheckRequest,
  isGatewayUiDisplayText,
  isGatewayUiGithubLogin,
} from "@assistant/shared/gatewayUi";
import { contentTypeFor } from "../webStatic.ts";
import {
  AccountsRefusal,
  browserLogin,
  decodeAccountRequest,
  decodeCursor,
  decodeInputRequest,
  decodeLoginRequest,
  decodeStartRequest,
  parseJson,
  type GatewayWebAccounts,
  type GatewayWebActor,
} from "./accounts.ts";
import {
  ClientsRefusal,
  decodeClientRequest,
  decodeCodeRequest,
  decodeEnrollmentDecision,
  decodeEnrollmentLookup,
  type GatewayWebClients,
} from "./clients.ts";
import { EnrollmentBudget } from "./enrollmentBudget.ts";
import { decodeRequestsQuery, type GatewayWebRequests } from "./requests.ts";
import { admittedEmail, type GatewayWebConfig } from "./config.ts";
import {
  atlassianAuthorizeUrl,
  decodeAtlassianSet,
  githubAuthorizeUrl,
  IntegrationsRefusal,
  slackAuthorizeUrl,
  type GatewayWebIntegrations,
  type IntegrationsRefusalCode,
} from "./integrations.ts";
import {
  createOidcClient,
  OidcFailure,
  type AuthorizationRequest,
  type OidcTestOptions,
} from "./oidc.ts";
import {
  ABSOLUTE_MS,
  PENDING_TTL_MS,
  PendingRedirects,
  Sessions,
  type SessionRef,
} from "./sessions.ts";
import type { GatewayWebUsers } from "./users.ts";

const SESSION_COOKIE = "__Host-pgw_session";
const SIGNIN_COOKIE = "__Host-pgw_signin";
/** Binds a "Sign in with Atlassian" start to its browser (Task-1411). */
const ATLASSIAN_COOKIE = "__Host-pgw_atlassian";
const ATLASSIAN_CONNECT_PATH = "/api/integrations/atlassian/connect";
const ATLASSIAN_CALLBACK_PATH = "/auth/atlassian/callback";
/** Binds a "Sign in with Slack" start to its browser (Task-1453). */
const SLACK_COOKIE = "__Host-pgw_slack";
const SLACK_CONNECT_PATH = "/api/integrations/slack/connect";
const SLACK_CALLBACK_PATH = "/auth/slack/callback";
/** Binds a "Connect GitHub" start to its browser (Task-1445). */
const GITHUB_COOKIE = "__Host-pgw_github";
const GITHUB_CONNECT_PATH = "/api/integrations/github/connect";
const GITHUB_CALLBACK_PATH = "/auth/github/callback";
const GITHUB_CHECK_PATH = "/api/integrations/github/check";
/**
 * A provider's authorization code, printable ASCII only. Atlassian's grows with
 * the scopes granted (2,581 characters for the 29-scope list), so the bound is
 * the vault's token bound.
 */
const AUTHORIZATION_CODE = /^[\x21-\x7e]{1,8192}$/;
const MAX_CONNECTIONS = 64;
const MAX_BODY_BYTES = 1_024;
/** Claude's pasted code: up to 8,192 characters, JSON-quoted. */
const MAX_INPUT_BODY_BYTES = 16 * 1_024;
const INPUT_PATH = "/api/logins/input";
/** A parser-valid Atlassian credential exceeds 1 KiB once JSON-escaped. */
const MAX_ATLASSIAN_BODY_BYTES = 4 * 1_024;
const ATLASSIAN_SET_PATH = "/api/integrations/atlassian/set";
const SWEEP_MS = 60_000;
/** An idle socket is destroyed after this. */
const IDLE_MS = 10_000;
/**
 * The idle bound while an integration adapter runs: a set's check (15 s)
 * then the vault's write (10 s). The baseline is back before its response.
 */
const INTEGRATION_IDLE_MS = 30_000;
/**
 * The idle bound while an integration callback's connect, or the GitHub
 * check's `github.token`, runs: above the remote vault's 30 s bound on each
 * (`gateway/remoteVault.ts`), so the edge answers before the socket is cut.
 */
const CONNECT_IDLE_MS = 40_000;

const INTEGRATION_STATUS: Record<IntegrationsRefusalCode, number> = {
  integration_invalid: 400,
  integration_rejected: 422,
  integration_unreachable: 502,
  vault_locked: 503,
  vault_unavailable: 503,
  tools_unavailable: 503,
  integration_busy: 409,
  integration_sign_in_required: 409,
  integration_site_missing: 422,
  integration_site_ambiguous: 422,
  integration_not_configured: 503,
  integration_team_mismatch: 422,
  integration_denied: 403,
};

/** A connect refusal as the callback's `?atlassian=` code. */
const ATLASSIAN_CONNECT_CODE: Partial<
  Record<IntegrationsRefusalCode, GatewayUiAtlassianConnectCode>
> = {
  integration_rejected: "rejected",
  integration_unreachable: "unreachable",
  integration_site_missing: "site_missing",
  integration_site_ambiguous: "site_ambiguous",
  integration_not_configured: "not_configured",
  vault_locked: "vault_locked",
  vault_unavailable: "vault_unavailable",
  integration_busy: "busy",
  tools_unavailable: "tools_unavailable",
};

/** A connect refusal as the callback's `?slack=` code. */
const SLACK_CONNECT_CODE: Partial<
  Record<IntegrationsRefusalCode, GatewayUiSlackConnectCode>
> = {
  integration_rejected: "rejected",
  integration_unreachable: "unreachable",
  integration_team_mismatch: "team_mismatch",
  integration_not_configured: "not_configured",
  vault_locked: "vault_locked",
  vault_unavailable: "vault_unavailable",
  integration_busy: "busy",
  tools_unavailable: "tools_unavailable",
};

/** A connect refusal as the callback's `?github=` code. */
const GITHUB_CONNECT_CODE: Partial<
  Record<IntegrationsRefusalCode, GatewayUiGithubConnectCode>
> = {
  integration_rejected: "rejected",
  integration_unreachable: "unreachable",
  integration_not_configured: "not_configured",
  vault_locked: "vault_locked",
  vault_unavailable: "vault_unavailable",
  integration_busy: "busy",
};

/** The callback codes every provider's sign-in answers itself. */
type SignInCode = "signed_out" | "expired" | "failed" | "denied";

/**
 * One provider's "Sign in with …" (Task-1411, Task-1453, Task-1445): its pending cookie,
 * callback path and `?<queryKey>=` codes, the authorize URL for a state, and
 * the connect the callback's code goes to. Each gets its own pending table.
 */
interface OAuthSignIn<Code extends string> {
  /** As log lines name it: `ui <name> connect: …`. */
  name: "atlassian" | "slack" | "github";
  cookie: string;
  callbackPath: string;
  queryKey: "atlassian" | "slack" | "github";
  /** A connect refusal as a callback code; anything else is `failed`. */
  codes: Partial<Record<IntegrationsRefusalCode, Code>>;
  authorizeUrl(state: string, redirectUri: string): string;
  connect(userId: string, code: string, redirectUri: string): Promise<unknown>;
}

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export interface GatewayWebOptions {
  config: GatewayWebConfig;
  users: GatewayWebUsers;
  accounts: GatewayWebAccounts;
  integrations: GatewayWebIntegrations;
  clients: GatewayWebClients;
  requests: GatewayWebRequests;
  log: (line: string) => void;
  /** Where the port binds; `127.0.0.1` unless given. */
  bindHost?: string;
  now?: () => number;
  /** Tests only; never read from the config file. */
  oidcTestOptions?: OidcTestOptions;
  /** Tests only, as `oidcTestOptions`: shorter socket idle bounds. */
  testIdleMs?: { idle: number; integration: number; connect?: number };
}

export interface RunningGatewayWeb {
  readonly port: number;
  close(): Promise<void>;
}

interface StaticFile {
  body: Buffer;
  type: string;
  cache: string;
}

/**
 * `gateway.html` and the files directly in `assets/`, read once at start.
 * Nothing from a request is ever joined into a path.
 */
function staticFiles(distDir: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  files.set("/", {
    body: readFileSync(join(distDir, "gateway.html")),
    type: contentTypeFor("gateway.html"),
    cache: "no-cache",
  });
  let assets: string[] = [];
  try {
    assets = readdirSync(join(distDir, "assets"), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    // A build without assets serves the page alone.
  }
  for (const name of assets)
    files.set(`/assets/${name}`, {
      body: readFileSync(join(distDir, "assets", name)),
      type: contentTypeFor(name),
      cache: "public, max-age=31536000, immutable",
    });
  return files;
}

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name)
      return part.slice(at + 1).trim() || undefined;
  }
  return undefined;
}

function cookie(name: string, value: string, maxAgeS: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}`;
}

/**
 * Reads a body of at most `limit` bytes; undefined when larger. The limit is
 * the route's, decided from method and path before any byte is read.
 */
function readBody(
  req: IncomingMessage,
  limit: number,
): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    if (Number(req.headers["content-length"] ?? 0) > limit)
      return resolve(undefined);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(undefined);
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(undefined));
  });
}

export async function startGatewayWeb(
  options: GatewayWebOptions,
): Promise<RunningGatewayWeb> {
  const { config, users, accounts, integrations, clients, requests, log } =
    options;
  const idleMs = options.testIdleMs?.idle ?? IDLE_MS;
  const integrationIdleMs =
    options.testIdleMs?.integration ?? INTEGRATION_IDLE_MS;
  const connectIdleMs = options.testIdleMs?.connect ?? CONNECT_IDLE_MS;
  const now = options.now ?? Date.now;
  const files = staticFiles(config.distDir);
  const enrollmentBudget = new EnrollmentBudget(now);
  const pending = new PendingRedirects<AuthorizationRequest>(now);
  // A session that leaves the table, however, ends its logins.
  const sessions = new Sessions(now, (actorId) => {
    try {
      accounts.endActor(actorId);
    } catch {
      log("ui session end: login cancel failed");
    }
  });
  const oidc = createOidcClient({
    ...config.oidc,
    redirectUri: `${config.publicOrigin}/auth/callback`,
    now,
    ...(options.oidcTestOptions ? { test: options.oidcTestOptions } : {}),
  });

  const send = (
    res: ServerResponse,
    status: number,
    headers: Record<string, string | string[]> = {},
    body?: string | Buffer,
  ): void => {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  };
  const json = (
    res: ServerResponse,
    status: number,
    value:
      | GatewayUiMe
      | GatewayUiAtlassianConnectStart
      | GatewayUiError
      | GatewayUiAccounts
      | GatewayUiLoginStart
      | GatewayUiLogin
      | GatewayUiAtlassian
      | GatewayUiClients
      | GatewayUiEnrollmentCode
      | GatewayUiEnrollmentRequest
      | GatewayUiMcpToken
      | GatewayUiRequests
      | GatewayUiSlack
      | GatewayUiGithub
      | GatewayUiGithubCheck,
    headers: Record<string, string> = {},
  ): void =>
    send(
      res,
      status,
      {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...headers,
      },
      JSON.stringify(value),
    );
  const text = (res: ServerResponse, status: number, body: string): void =>
    send(res, status, { "content-type": "text/plain; charset=utf-8" }, body);
  /** Back to the page; the sign-in cookie cleared, a session cookie set. */
  const toPage = (
    res: ServerResponse,
    outcome: { signin: GatewayUiSigninCode } | { session: string },
  ): void =>
    send(res, 303, {
      location: "signin" in outcome ? `/?signin=${outcome.signin}` : "/",
      "cache-control": "no-store",
      "set-cookie": [
        cookie(SIGNIN_COOKIE, "", 0),
        ...("session" in outcome
          ? [cookie(SESSION_COOKIE, outcome.session, ABSOLUTE_MS / 1000)]
          : []),
      ],
    });

  const login = async (res: ServerResponse): Promise<void> => {
    let begun;
    try {
      begun = await oidc.begin();
    } catch (err) {
      log(
        `ui sign-in: failed (${err instanceof OidcFailure ? err.stage : "discovery"})`,
      );
      return toPage(res, { signin: "failed" });
    }
    const signinId = pending.add(begun.request.state, begun.request);
    if (signinId === undefined) return toPage(res, { signin: "busy" });
    send(res, 302, {
      location: begun.url.href,
      "cache-control": "no-store",
      "set-cookie": cookie(SIGNIN_COOKIE, signinId, PENDING_TTL_MS / 1000),
    });
  };

  const callback = async (
    req: IncomingMessage,
    url: URL,
    res: ServerResponse,
  ): Promise<void> => {
    const taken = pending.take(
      url.searchParams.get("state"),
      cookieOf(req, SIGNIN_COOKIE),
    );
    if (taken.kind === "expired") return toPage(res, { signin: "expired" });
    if (taken.kind === "failed") {
      log("ui sign-in: failed (state)");
      return toPage(res, { signin: "failed" });
    }
    let claims: Record<string, unknown>;
    try {
      claims = await oidc.finish(url, taken.value);
    } catch (err) {
      log(
        `ui sign-in: failed (${err instanceof OidcFailure ? err.stage : "exchange"})`,
      );
      return toPage(res, { signin: "failed" });
    }
    // The allow rule runs before the registry sees the identity.
    const email = admittedEmail(config.allow, claims);
    if (email === undefined) {
      log("ui sign-in: denied");
      return toPage(res, { signin: "denied" });
    }
    if (sessions.full()) return toPage(res, { signin: "busy" });
    let signedIn: ReturnType<GatewayWebUsers["signIn"]>;
    try {
      signedIn = users.signIn({
        issuer: claims.iss as string,
        subject: claims.sub as string,
        email,
      });
    } catch {
      log("ui sign-in: failed (registry)");
      return toPage(res, { signin: "failed" });
    }
    const session = sessions.create(signedIn.userId);
    if (session === undefined) return toPage(res, { signin: "busy" });
    log(`ui sign-in: ok user=${signedIn.userId} (${signedIn.outcome})`);
    toPage(res, { session });
  };

  /**
   * One provider's sign-in, with its own pending table, so a state is only
   * ever taken by the callback of the provider that issued it.
   */
  const oauthSignIn = <Code extends string>(provider: OAuthSignIn<Code>) => {
    /** Starts, each bound to the user who started it. */
    const pendingConnects = new PendingRedirects<{ userId: string }>(now);
    const redirectUri = `${config.publicOrigin}${provider.callbackPath}`;
    /**
     * Back to the page after the provider's redirect: `/` on success, else a
     * fixed `?<queryKey>=` code; the pending cookie cleared either way.
     */
    const toPageFor = (res: ServerResponse, code?: Code | SignInCode): void =>
      send(res, 303, {
        location: code === undefined ? "/" : `/?${provider.queryKey}=${code}`,
        "cache-control": "no-store",
        "set-cookie": cookie(provider.cookie, "", 0),
      });
    return {
      /**
       * `POST <connect path>`, behind the session and the mutation gate: a
       * fresh state bound to this browser's new pending cookie and to the
       * session's user, answered only inside the authorize URL.
       */
      start: (userId: string, res: ServerResponse): void => {
        const state = randomBytes(32).toString("base64url");
        const cookieId = pendingConnects.add(state, { userId });
        if (cookieId === undefined) {
          log(`ui ${provider.name} connect: refused, busy user=${userId}`);
          return json(res, 503, { error: "unavailable" });
        }
        log(`ui ${provider.name} connect: started user=${userId}`);
        json(
          res,
          200,
          { authorizeUrl: provider.authorizeUrl(state, redirectUri) },
          {
            "set-cookie": cookie(
              provider.cookie,
              cookieId,
              PENDING_TTL_MS / 1000,
            ),
          },
        );
      },
      /**
       * `GET <callback path>`: the state is taken (one use) before anything
       * else, then the session, the pending cookie and the user are checked;
       * only then does the code go to the vault, under the longer connect
       * bound. The provider's `error` text is never read past its code.
       */
      callback: async (
        req: IncomingMessage,
        url: URL,
        res: ServerResponse,
      ): Promise<void> => {
        const taken = pendingConnects.take(
          url.searchParams.get("state"),
          cookieOf(req, provider.cookie),
        );
        const session = sessions.lookup(cookieOf(req, SESSION_COOKIE));
        const failed = (code: Code | SignInCode, reason: string = code) => {
          log(
            `ui ${provider.name} connect: failed (${reason})${session ? ` user=${session.userId}` : ""}`,
          );
          toPageFor(res, code);
        };
        if (!session) return failed("signed_out");
        if (taken.kind === "expired") return failed("expired");
        if (taken.kind === "failed" || taken.value.userId !== session.userId)
          return failed("failed", "state");
        const error = url.searchParams.get("error");
        if (error !== null)
          return failed(error === "access_denied" ? "denied" : "failed");
        const code = url.searchParams.get("code");
        if (code === null || !AUTHORIZATION_CODE.test(code))
          return failed("failed");
        req.socket.setTimeout(connectIdleMs);
        try {
          await provider.connect(session.userId, code, redirectUri);
        } catch (err) {
          return failed(
            (err instanceof IntegrationsRefusal
              ? provider.codes[err.code]
              : undefined) ?? "failed",
          );
        } finally {
          req.socket.setTimeout(idleMs);
        }
        log(`ui ${provider.name} connect: ok user=${session.userId}`);
        toPageFor(res);
      },
    };
  };

  const atlassianClientId = config.atlassian?.clientId;
  /** "Sign in with Atlassian" (Task-1411): with an Atlassian OAuth client. */
  const atlassianSignIn =
    atlassianClientId === undefined
      ? undefined
      : oauthSignIn({
          name: "atlassian",
          cookie: ATLASSIAN_COOKIE,
          callbackPath: ATLASSIAN_CALLBACK_PATH,
          queryKey: "atlassian",
          codes: ATLASSIAN_CONNECT_CODE,
          authorizeUrl: (state, redirectUri) =>
            atlassianAuthorizeUrl({
              clientId: atlassianClientId,
              scopes: config.atlassian?.scopes ?? [],
              redirectUri,
              state,
            }),
          connect: (userId, code, redirectUri) => {
            const site = config.atlassian?.site;
            return integrations.connect(userId, {
              code,
              redirectUri,
              ...(site !== undefined ? { site } : {}),
            });
          },
        });
  const slack = config.slack;
  const slackClientId = slack?.clientId;
  /**
   * "Sign in with Slack" (Task-1453): with `slack.clientId`. The `team` hint
   * and the connect's `team` come only from the deployment's config.
   */
  const slackSignIn =
    slack === undefined || slackClientId === undefined
      ? undefined
      : oauthSignIn({
          name: "slack",
          cookie: SLACK_COOKIE,
          callbackPath: SLACK_CALLBACK_PATH,
          queryKey: "slack",
          codes: SLACK_CONNECT_CODE,
          authorizeUrl: (state, redirectUri) =>
            slackAuthorizeUrl({
              clientId: slackClientId,
              userScopes: slack.userScopes,
              redirectUri,
              state,
              team: slack.teamId,
            }),
          connect: (userId, code, redirectUri) =>
            integrations.connectSlack(userId, {
              code,
              redirectUri,
              ...(slack.teamId !== undefined ? { team: slack.teamId } : {}),
            }),
        });

  const githubClientId = config.github?.clientId;
  /**
   * "Connect GitHub" (Task-1445): with `github.clientId`. The App's secret
   * and key are the vault's; the authorize URL carries the id, the callback
   * and the state only.
   */
  const githubSignIn =
    githubClientId === undefined
      ? undefined
      : oauthSignIn({
          name: "github",
          cookie: GITHUB_COOKIE,
          callbackPath: GITHUB_CALLBACK_PATH,
          queryKey: "github",
          codes: GITHUB_CONNECT_CODE,
          authorizeUrl: (state, redirectUri) =>
            githubAuthorizeUrl({
              clientId: githubClientId,
              redirectUri,
              state,
            }),
          connect: (userId, code, redirectUri) =>
            integrations.connectGithub(userId, { code, redirectUri }),
        });

  const me = (req: IncomingMessage, res: ServerResponse): void => {
    const userId = sessions.lookup(cookieOf(req, SESSION_COOKIE))?.userId;
    if (userId === undefined) return json(res, 401, { error: "signed_out" });
    let user;
    try {
      user = users.user(userId);
    } catch {
      return json(res, 503, { error: "unavailable" });
    }
    if (!user) return json(res, 401, { error: "signed_out" });
    json(res, 200, {
      userId: user.id,
      email: user.email ?? "",
      label: user.label,
    });
  };

  const logout = (req: IncomingMessage, res: ServerResponse): void => {
    const userId = sessions.end(cookieOf(req, SESSION_COOKIE));
    if (userId !== undefined) log(`ui sign-out: user=${userId}`);
    send(res, 204, {
      "cache-control": "no-store",
      "set-cookie": cookie(SESSION_COOKIE, "", 0),
    });
  };

  const noContent = (res: ServerResponse): void =>
    send(res, 204, { "cache-control": "no-store" });

  /**
   * `/api/accounts*` and `/api/logins*`, behind the session; the user and
   * the actor come only from it, never from the body or query.
   */
  const accountsApi = (
    method: string,
    path: string,
    url: URL,
    body: Buffer,
    session: SessionRef,
    res: ServerResponse,
  ): void => {
    const { userId, actorId } = session;
    const actor: GatewayWebActor = {
      actorId,
      userId,
      active: () => sessions.live(actorId),
    };
    const badRequest = () => json(res, 400, { error: "bad_request" });
    try {
      if (method === "GET" && path === "/api/accounts")
        return json(res, 200, { accounts: accounts.list(userId) });
      if (method === "GET" && path === "/api/logins/read") {
        const loginId = url.searchParams.get("login");
        const cursor = decodeCursor(url.searchParams.get("cursor"));
        if (!loginId || loginId.length > 128 || cursor === undefined)
          return badRequest();
        return json(
          res,
          200,
          browserLogin(accounts.read(actor, loginId, cursor)),
        );
      }
      if (method !== "POST") return text(res, 404, "not found");
      const value = parseJson(body);
      if (path === "/api/accounts/remove") {
        const accountId = decodeAccountRequest(value);
        if (accountId === undefined) return badRequest();
        accounts.remove(userId, accountId);
        return noContent(res);
      }
      if (path === "/api/logins/start") {
        const start = decodeStartRequest(value);
        if (!start) return badRequest();
        return json(res, 200, accounts.start(actor, start));
      }
      if (path === INPUT_PATH) {
        const input = decodeInputRequest(value);
        if (!input) return badRequest();
        accounts.input(actor, input.loginId, input.text);
        return noContent(res);
      }
      if (path === "/api/logins/cancel") {
        const loginId = decodeLoginRequest(value);
        if (loginId === undefined) return badRequest();
        accounts.cancel(actor, loginId);
        return noContent(res);
      }
      return text(res, 404, "not found");
    } catch (err) {
      if (err instanceof AccountsRefusal)
        return json(res, err.code === "login_unavailable" ? 503 : 404, {
          error: err.code,
        });
      return json(res, 503, { error: "unavailable" });
    }
  };

  /**
   * The deployment's fixed Atlassian site and, when it binds the credential
   * to the sign-in, the user's email; undefined when it fixes neither. A
   * user record without an email throws, so a bound deployment never falls
   * back to what the request says.
   */
  const atlassianPreset = (
    userId: string,
  ): GatewayUiAtlassianPreset | undefined => {
    const fixed = config.atlassian;
    if (!fixed) return undefined;
    const preset: GatewayUiAtlassianPreset = {};
    if (fixed.site !== undefined) preset.site = fixed.site;
    if (fixed.emailFromSignIn) {
      const email = users.user(userId)?.email;
      if (!email) throw new Error("no sign-in email");
      preset.email = email;
    }
    return preset.site !== undefined || preset.email !== undefined
      ? preset
      : undefined;
  };

  /**
   * `POST /api/integrations/github/check`: exactly `{owner, repo}`, else
   * `bad_request` with no vault call. The vault's `github.token` runs under
   * the connect bound; the answer is the checked repository, built from the
   * request, and the token's expiry. A refusal is logged by its fixed code
   * and rethrown to `settingsApi`'s catch; no log line holds the names, the
   * expiry or any error text.
   */
  const githubCheck = async (
    req: IncomingMessage,
    body: Buffer,
    userId: string,
    res: ServerResponse,
  ): Promise<void> => {
    const request = decodeGatewayUiGithubCheckRequest(parseJson(body));
    if (!request) return json(res, 400, { error: "bad_request" });
    req.socket.setTimeout(connectIdleMs);
    let expiresAt: number;
    try {
      ({ expiresAt } = await integrations.checkGithub(userId, request));
    } catch (err) {
      log(
        err instanceof IntegrationsRefusal
          ? `ui integration github: check refused (${err.code}) user=${userId}`
          : `ui integration github: check failed user=${userId}`,
      );
      throw err;
    } finally {
      req.socket.setTimeout(idleMs);
    }
    log(`ui integration github: check ok user=${userId}`);
    const answer: GatewayUiGithubCheck = {
      repository: `${request.owner}/${request.repo}`,
      expiresAt,
    };
    return json(res, 200, answer);
  };

  /**
   * `/api/integrations/*` and `/api/clients*`, behind the session; the user
   * comes only from it. Log lines name the user and client ids only.
   */
  const settingsApi = async (
    req: IncomingMessage,
    method: string,
    path: string,
    body: Buffer,
    userId: string,
    res: ServerResponse,
  ): Promise<void> => {
    const badRequest = () => json(res, 400, { error: "bad_request" });
    try {
      if (path.startsWith("/api/integrations/")) {
        if (path === ATLASSIAN_CONNECT_PATH) {
          if (method !== "POST" || atlassianSignIn === undefined)
            return text(res, 404, "not found");
          return atlassianSignIn.start(userId, res);
        }
        if (path === SLACK_CONNECT_PATH) {
          if (method !== "POST" || slackSignIn === undefined)
            return text(res, 404, "not found");
          return slackSignIn.start(userId, res);
        }
        if (path === GITHUB_CONNECT_PATH) {
          if (method !== "POST" || githubSignIn === undefined)
            return text(res, 404, "not found");
          return githubSignIn.start(userId, res);
        }
        // Atlassian and the vault may take longer than the idle bound: the
        // socket has the longer one while the adapter runs, and the baseline
        // back before the response, so keep-alive handling is as for any route.
        const held = async <T>(run: () => Promise<T>): Promise<T> => {
          req.socket.setTimeout(integrationIdleMs);
          try {
            return await run();
          } finally {
            req.socket.setTimeout(idleMs);
          }
        };
        if (path === "/api/integrations/slack" && method === "GET") {
          // Answered without a vault or tools call where Slack is not offered.
          if (slackSignIn === undefined)
            return json(res, 200, { offered: false, connected: false });
          const status = await held(() => integrations.slackStatus(userId));
          // F004: a workspace name the page could not show safely is dropped.
          return json(res, 200, {
            offered: true,
            connected: status.connected,
            ...(isGatewayUiDisplayText(status.teamName)
              ? { teamName: status.teamName }
              : {}),
            ...(status.problem !== undefined
              ? { problem: status.problem }
              : {}),
          });
        }
        if (path === "/api/integrations/slack/clear" && method === "POST") {
          if (slackSignIn === undefined) return text(res, 404, "not found");
          await held(() => integrations.clearSlack(userId));
          log(`ui integration slack: cleared user=${userId}`);
          return noContent(res);
        }
        if (
          path === "/api/integrations/slack" ||
          path.startsWith("/api/integrations/slack/")
        )
          return text(res, 404, "not found");
        if (path === "/api/integrations/github" && method === "GET") {
          // Answered without a vault call where GitHub is not offered.
          if (githubSignIn === undefined)
            return json(res, 200, { offered: false, connected: false });
          const status = await held(() => integrations.githubStatus(userId));
          // A login the page could not show safely is dropped.
          const answer: GatewayUiGithub = {
            offered: true,
            connected: status.connected,
            ...(isGatewayUiGithubLogin(status.login)
              ? { login: status.login }
              : {}),
            ...(status.problem !== undefined
              ? { problem: status.problem }
              : {}),
          };
          return json(res, 200, answer);
        }
        if (path === "/api/integrations/github/clear" && method === "POST") {
          if (githubSignIn === undefined) return text(res, 404, "not found");
          await held(() => integrations.clearGithub(userId));
          log(`ui integration github: cleared user=${userId}`);
          return noContent(res);
        }
        if (path === GITHUB_CHECK_PATH && method === "POST") {
          if (githubSignIn === undefined) return text(res, 404, "not found");
          return await githubCheck(req, body, userId, res);
        }
        if (
          path === "/api/integrations/github" ||
          path.startsWith("/api/integrations/github/")
        )
          return text(res, 404, "not found");
        // The deployment's fixed site and sign-in email win over the request.
        const preset = atlassianPreset(userId);
        const withPreset = (answer: GatewayUiAtlassian): GatewayUiAtlassian =>
          preset ? { ...answer, preset } : answer;
        if (method === "GET" && path === "/api/integrations/atlassian")
          return json(
            res,
            200,
            withPreset(await held(() => integrations.status(userId))),
          );
        if (method !== "POST") return text(res, 404, "not found");
        if (path === ATLASSIAN_SET_PATH) {
          const input = decodeAtlassianSet(parseJson(body));
          if (!input) return badRequest();
          const fixed = { ...input, ...preset };
          const answer = await held(() => integrations.set(userId, fixed));
          log(`ui integration atlassian: set user=${userId}`);
          return json(res, 200, withPreset(answer));
        }
        if (path === "/api/integrations/atlassian/clear") {
          await held(() => integrations.clear(userId));
          log(`ui integration atlassian: cleared user=${userId}`);
          return noContent(res);
        }
        return text(res, 404, "not found");
      }
      if (method === "GET" && path === "/api/clients")
        return json(res, 200, { clients: clients.list(userId) });
      if (method !== "POST") return text(res, 404, "not found");
      const value = parseJson(body);
      if (path === "/api/clients/code") {
        const label = decodeCodeRequest(value);
        if (label === undefined) return badRequest();
        const answer = clients.createCode(userId, label);
        log(`ui clients: code created user=${userId}`);
        return json(res, 200, answer);
      }
      const clientRoutes: Record<string, (clientId: string) => void> = {
        "/api/clients/revoke": (clientId) => {
          clients.revoke(userId, clientId);
          log(`ui clients: client ${clientId} revoked user=${userId}`);
          noContent(res);
        },
        "/api/clients/mcp-token": (clientId) => {
          const answer = clients.mintMcpToken(userId, clientId);
          log(`ui clients: client ${clientId} mcp token minted user=${userId}`);
          json(res, 200, answer);
        },
        "/api/clients/mcp-token/revoke": (clientId) => {
          clients.revokeMcpToken(userId, clientId);
          log(
            `ui clients: client ${clientId} mcp token revoked user=${userId}`,
          );
          noContent(res);
        },
      };
      const route = Object.hasOwn(clientRoutes, path)
        ? clientRoutes[path]
        : undefined;
      if (!route) return text(res, 404, "not found");
      const clientId = decodeClientRequest(value);
      if (clientId === undefined) return badRequest();
      return route(clientId);
    } catch (err) {
      if (err instanceof IntegrationsRefusal)
        return json(res, INTEGRATION_STATUS[err.code], { error: err.code });
      if (err instanceof ClientsRefusal)
        return json(res, err.code === "unknown_client" ? 404 : 409, {
          error: err.code,
        });
      return json(res, 503, { error: "unavailable" });
    }
  };

  /**
   * `/api/enrollments/lookup` and `/decide`, behind the session: the user
   * code only in the body, the user only from the session. Each well-formed
   * call spends the user's budget first; an unknown code also spends the
   * global miss budget. Log lines name the user only, never the code.
   */
  const enrollmentsApi = (
    method: string,
    path: string,
    body: Buffer,
    userId: string,
    res: ServerResponse,
  ): void => {
    const lookup = path === "/api/enrollments/lookup";
    if (method !== "POST" || (!lookup && path !== "/api/enrollments/decide"))
      return text(res, 404, "not found");
    const value = parseJson(body);
    const decision = lookup ? undefined : decodeEnrollmentDecision(value);
    const userCode = lookup
      ? decodeEnrollmentLookup(value)
      : decision?.userCode;
    if (userCode === undefined) return json(res, 400, { error: "bad_request" });
    const refused = enrollmentBudget.admit(userId);
    if (refused) {
      log(
        refused.scope === "global"
          ? `ui enrollments: refused, miss cap reached user=${userId}`
          : `ui enrollments: refused, budget spent user=${userId}`,
      );
      res.setHeader("retry-after", String(refused.retryAfterSeconds));
      return json(res, 429, { error: "rate_limited" });
    }
    try {
      if (lookup) return json(res, 200, clients.enrollment(userId, userCode));
      clients.decideEnrollment(userId, userCode, decision!.approve);
      log(
        `ui enrollments: request ${decision!.approve ? "approved" : "denied"} user=${userId}`,
      );
      return noContent(res);
    } catch (err) {
      if (err instanceof ClientsRefusal) {
        if (err.code === "unknown_request" && enrollmentBudget.miss())
          log("ui enrollments: miss cap reached");
        return json(res, err.code === "limit_reached" ? 409 : 404, {
          error: err.code,
        });
      }
      return json(res, 503, { error: "unavailable" });
    }
  };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", config.publicOrigin);
    const path = url.pathname;
    const read = method === "GET" || method === "HEAD";
    if (!read) {
      if (
        req.headers.origin !== config.publicOrigin ||
        req.headers[GATEWAY_UI_CSRF_HEADER] !== "1"
      ) {
        req.resume();
        return json(res, 403, { error: "forbidden" });
      }
    }
    sessions.sweep();
    const body = await readBody(
      req,
      method === "POST" && path === INPUT_PATH
        ? MAX_INPUT_BODY_BYTES
        : method === "POST" && path === ATLASSIAN_SET_PATH
          ? MAX_ATLASSIAN_BODY_BYTES
          : MAX_BODY_BYTES,
    );
    if (!body) {
      res.setHeader("connection", "close");
      return text(res, 413, "request body too large");
    }
    if (method === "POST" && path === "/auth/logout") return logout(req, res);
    if (method === "GET" && path === "/auth/login") return login(res);
    if (method === "GET" && path === "/auth/callback")
      return callback(req, url, res);
    if (method === "GET" && path === ATLASSIAN_CALLBACK_PATH) {
      if (atlassianSignIn === undefined) return text(res, 404, "not found");
      return atlassianSignIn.callback(req, url, res);
    }
    if (method === "GET" && path === SLACK_CALLBACK_PATH) {
      if (slackSignIn === undefined) return text(res, 404, "not found");
      return slackSignIn.callback(req, url, res);
    }
    if (method === "GET" && path === GITHUB_CALLBACK_PATH) {
      if (githubSignIn === undefined) return text(res, 404, "not found");
      return githubSignIn.callback(req, url, res);
    }
    if (method === "GET" && path === "/api/me") return me(req, res);
    if (
      path === "/api/accounts" ||
      path.startsWith("/api/accounts/") ||
      path.startsWith("/api/logins/")
    ) {
      const session = sessions.lookup(cookieOf(req, SESSION_COOKIE));
      if (!session) return json(res, 401, { error: "signed_out" });
      return accountsApi(method, path, url, body, session, res);
    }
    if (
      path.startsWith("/api/integrations/") ||
      path === "/api/clients" ||
      path.startsWith("/api/clients/")
    ) {
      const session = sessions.lookup(cookieOf(req, SESSION_COOKIE));
      if (!session) return json(res, 401, { error: "signed_out" });
      return settingsApi(req, method, path, body, session.userId, res);
    }
    if (path === "/api/requests") {
      const session = sessions.lookup(cookieOf(req, SESSION_COOKIE));
      if (!session) return json(res, 401, { error: "signed_out" });
      if (method !== "GET") return text(res, 404, "not found");
      const cursor = decodeRequestsQuery(url.searchParams);
      if (!cursor) return json(res, 400, { error: "bad_request" });
      try {
        return json(
          res,
          200,
          requests.since(session.userId, cursor.epoch, cursor.after),
        );
      } catch {
        return json(res, 503, { error: "unavailable" });
      }
    }
    if (path.startsWith("/api/enrollments/")) {
      const session = sessions.lookup(cookieOf(req, SESSION_COOKIE));
      if (!session) return json(res, 401, { error: "signed_out" });
      return enrollmentsApi(method, path, body, session.userId, res);
    }
    const file = read ? files.get(path) : undefined;
    if (!file) return text(res, 404, "not found");
    send(
      res,
      200,
      { "content-type": file.type, "cache-control": file.cache },
      method === "HEAD" ? undefined : file.body,
    );
  };

  const server = https.createServer(
    {
      key: config.keyPem,
      cert: config.certPem,
      handshakeTimeout: 10_000,
      headersTimeout: 5_000,
      requestTimeout: 10_000,
      connectionsCheckingInterval: 1_000,
    },
    (req, res) => {
      req.on("error", () => {});
      handle(req, res).catch(() => {
        if (!res.headersSent) text(res, 500, "internal error");
        else res.destroy();
      });
    },
  );
  server.maxConnections = MAX_CONNECTIONS;
  server.setTimeout(idleMs, (socket) => socket.destroy());

  const bindHost = options.bindHost ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  log(`ui listener on ${bindHost}:${port}`);

  // Ends expired sessions' logins without waiting for a request.
  const sweeper = setInterval(() => sessions.sweep(), SWEEP_MS);
  sweeper.unref();

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweeper);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
