/**
 * The gateway's own browser listener (Task-1402, `docs/workers.md` "The
 * gateway's sign-in and UI"): HTTPS with the deployment's certificate, OIDC
 * sign-in, in-memory sessions, `/api/me` and the gateway page's built files.
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
  type GatewayUiError,
  type GatewayUiMe,
  type GatewayUiSigninCode,
} from "@assistant/shared/gatewayUi";
import { contentTypeFor } from "../webStatic.ts";
import { admittedEmail, type GatewayWebConfig } from "./config.ts";
import { createOidcClient, OidcFailure, type OidcTestOptions } from "./oidc.ts";
import {
  ABSOLUTE_MS,
  PENDING_TTL_MS,
  PendingSignins,
  Sessions,
} from "./sessions.ts";
import type { GatewayWebUsers } from "./users.ts";

const SESSION_COOKIE = "__Host-pgw_session";
const SIGNIN_COOKIE = "__Host-pgw_signin";
const MAX_CONNECTIONS = 64;
const MAX_BODY_BYTES = 1_024;

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export interface GatewayWebOptions {
  config: GatewayWebConfig;
  users: GatewayWebUsers;
  log: (line: string) => void;
  /** Where the port binds; `127.0.0.1` unless given. */
  bindHost?: string;
  now?: () => number;
  /** Tests only; never read from the config file. */
  oidcTestOptions?: OidcTestOptions;
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

/** Reads and drops a body of at most `MAX_BODY_BYTES`; false when larger. */
function drain(req: IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES)
      return resolve(false);
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(false);
        req.pause();
      }
    });
    req.on("end", () => resolve(true));
    req.on("error", () => resolve(false));
  });
}

export async function startGatewayWeb(
  options: GatewayWebOptions,
): Promise<RunningGatewayWeb> {
  const { config, users, log } = options;
  const now = options.now ?? Date.now;
  const files = staticFiles(config.distDir);
  const pending = new PendingSignins(now);
  const sessions = new Sessions(now);
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
    value: GatewayUiMe | GatewayUiError,
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
    const userId = sessions.userOf(cookieOf(req, SESSION_COOKIE));
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
    if (!(await drain(req))) {
      res.setHeader("connection", "close");
      return text(res, 413, "request body too large");
    }
    if (method === "POST" && path === "/auth/logout") return logout(req, res);
    if (method === "GET" && path === "/auth/login") return login(res);
    if (method === "GET" && path === "/auth/callback")
      return callback(req, url, res);
    if (method === "GET" && path === "/api/me") return me(req, res);
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
  server.setTimeout(10_000, (socket) => socket.destroy());

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

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
