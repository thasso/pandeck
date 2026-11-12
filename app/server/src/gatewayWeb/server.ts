/**
 * The gateway's own browser listener (Task-1402, `docs/workers.md` "The
 * gateway's sign-in and UI"): HTTPS with the deployment's certificate, OIDC
 * sign-in, in-memory sessions, `/api/me`, the user's accounts and logins
 * (`/api/accounts*`, `/api/logins*`, over the injected `GatewayWebAccounts`),
 * the Atlassian credential (`/api/integrations/*`, `GatewayWebIntegrations`),
 * clients and MCP tokens (`/api/clients*`, `GatewayWebClients`) and the
 * gateway page's built files. An enrollment code or MCP token is only in the
 * answer that creates it; the Atlassian token is in no answer.
 *
 * A session is the actor of the logins it starts: it alone reads, feeds and
 * cancels them, and when it ends (sign-out, expiry, eviction) they are
 * cancelled. Expired sessions are swept on every request and every 60 s.
 *
 * The user comes only from the session, the session only from a validated
 * callback. Mutations need `Origin` equal to the public origin and the
 * `x-gateway-ui: 1` header. Refusals and log lines are fixed: no email, code,
 * state, nonce, verifier, token, cookie, secret or query reaches either, nor a
 * redirect the gateway sends back to itself.
 */
import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import { join } from "node:path";
import {
  GATEWAY_UI_CSRF_HEADER,
  type GatewayUiAccounts,
  type GatewayUiAtlassian,
  type GatewayUiClients,
  type GatewayUiEnrollmentCode,
  type GatewayUiError,
  type GatewayUiLogin,
  type GatewayUiLoginStart,
  type GatewayUiMcpToken,
  type GatewayUiMe,
  type GatewayUiSigninCode,
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
  type GatewayWebClients,
} from "./clients.ts";
import { admittedEmail, type GatewayWebConfig } from "./config.ts";
import {
  decodeAtlassianSet,
  IntegrationsRefusal,
  type GatewayWebIntegrations,
  type IntegrationsRefusalCode,
} from "./integrations.ts";
import { createOidcClient, OidcFailure, type OidcTestOptions } from "./oidc.ts";
import {
  ABSOLUTE_MS,
  PENDING_TTL_MS,
  PendingSignins,
  Sessions,
  type SessionRef,
} from "./sessions.ts";
import type { GatewayWebUsers } from "./users.ts";

const SESSION_COOKIE = "__Host-pgw_session";
const SIGNIN_COOKIE = "__Host-pgw_signin";
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

const INTEGRATION_STATUS: Record<IntegrationsRefusalCode, number> = {
  integration_invalid: 400,
  integration_rejected: 422,
  integration_unreachable: 502,
  vault_locked: 503,
  vault_unavailable: 503,
  tools_unavailable: 503,
  integration_busy: 409,
};

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
  log: (line: string) => void;
  /** Where the port binds; `127.0.0.1` unless given. */
  bindHost?: string;
  now?: () => number;
  /** Tests only; never read from the config file. */
  oidcTestOptions?: OidcTestOptions;
  /** Tests only, as `oidcTestOptions`: shorter socket idle bounds. */
  testIdleMs?: { idle: number; integration: number };
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
  const { config, users, accounts, integrations, clients, log } = options;
  const idleMs = options.testIdleMs?.idle ?? IDLE_MS;
  const integrationIdleMs =
    options.testIdleMs?.integration ?? INTEGRATION_IDLE_MS;
  const now = options.now ?? Date.now;
  const files = staticFiles(config.distDir);
  const pending = new PendingSignins(now);
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
      | GatewayUiError
      | GatewayUiAccounts
      | GatewayUiLoginStart
      | GatewayUiLogin
      | GatewayUiAtlassian
      | GatewayUiClients
      | GatewayUiEnrollmentCode
      | GatewayUiMcpToken,
  ): void =>
    send(
      res,
      status,
      {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
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
    const signinId = pending.add(begun.request);
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
      claims = await oidc.finish(url, taken.request);
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
        if (method === "GET" && path === "/api/integrations/atlassian")
          return json(res, 200, await held(() => integrations.status(userId)));
        if (method !== "POST") return text(res, 404, "not found");
        if (path === ATLASSIAN_SET_PATH) {
          const input = decodeAtlassianSet(parseJson(body));
          if (!input) return badRequest();
          const answer = await held(() => integrations.set(userId, input));
          log(`ui integration atlassian: set user=${userId}`);
          return json(res, 200, answer);
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
