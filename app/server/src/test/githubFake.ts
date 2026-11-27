/**
 * A loopback stand-in for `github.com` and `api.github.com` (Task-1444): one
 * HTTPS server presenting a CA-issued certificate for each host by SNI,
 * reached through the vault's connect override (`GithubEndpoint`), so the TLS
 * name and `Host` stay the real ones and are recorded per request. It imports
 * nothing from `gateway/` (`workerBoundary.test.ts`).
 *
 * By default it answers as GitHub did in spike S1a (Task-1443): the OAuth
 * code exchange and refresh with rotating user tokens (`expires_in` 28800,
 * `refresh_token_expires_in` 15638400, errors as HTTP 200 `{error}`), `GET
 * /user`, a repository's permission view for the user its token belongs to,
 * the App's installation of a repository, a narrowed installation-token mint
 * (201, `permissions` and `repositories` as asked), the token's repository
 * list, and the revoke (204). A test scripts a route otherwise; `hold` parks
 * the next request on a route and `delayMs` slows every answer.
 *
 * Every token, code, secret and id here is fake, and none is shaped like a
 * real GitHub token.
 */
import {
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import type { ServerResponse } from "node:http";
import https from "node:https";
import type net from "node:net";
import { createSecureContext, type TLSSocket } from "node:tls";
import {
  issueLeafCertificate,
  loadOrCreateCa,
} from "../packageProxy/certificateAuthority.ts";

export const FAKE_GITHUB_CLIENT = {
  clientId: "fake-github-client-id",
  clientSecret: "fake-github-client-secret-sentinel",
};
export const FAKE_GITHUB_APP_ID = 4242;
export const FAKE_GITHUB_CODE = "fake-github-auth-code";
export const FAKE_GITHUB_REDIRECT =
  "https://gateway.example.test/auth/github/callback";
export const FAKE_INSTALLATION_ID = 7001;

let testAppKey: KeyObject | undefined;
/**
 * The GitHub App client a test vault holds: the fake client, and a signer
 * over an RSA key generated at test time (never a fixture), with its public
 * half to verify the JWT.
 */
export function fakeGithubApp(): {
  client: {
    appId: number;
    clientId: string;
    clientSecret: string;
    sign(data: string): Buffer;
  };
  publicKey: KeyObject;
} {
  testAppKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const key = testAppKey;
  return {
    client: {
      appId: FAKE_GITHUB_APP_ID,
      ...FAKE_GITHUB_CLIENT,
      sign: (data) => sign("sha256", Buffer.from(data, "utf8"), key),
    },
    publicKey: createPublicKey(key),
  };
}

/** A GitHub identity the fake hands tokens out for. */
export interface FakeGithubUser {
  login: string;
  id: number;
}
export const FAKE_GITHUB_USER: FakeGithubUser = { login: "fake-user", id: 501 };
export const FAKE_GITHUB_OTHER: FakeGithubUser = {
  login: "fake-other",
  id: 502,
};

/** A repository the fake knows, and who may pull it. */
export interface FakeRepository {
  id: number;
  fullName: string;
  pullers: Set<string>;
  /** Off the App's installation: its installation lookup is 404. */
  noApp?: boolean;
}

export type GithubRoute =
  | "token"
  | "user"
  | "repo"
  | "installation"
  | "mint"
  | "installationRepos"
  | "revoke"
  | "other";

export interface SeenGithubRequest {
  route: GithubRoute;
  method: string;
  path: string;
  host: string | undefined;
  /** The TLS server name the client asked for. */
  servername: string | false | null;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** The form body's fields (the OAuth token route). */
  form: Record<string, string>;
  /** The bearer credential, if any. */
  bearer: string | undefined;
}

export type GithubResponder = (
  seen: SeenGithubRequest,
  res: { status(code: number, body?: unknown): void; raw: ServerResponse },
) => void;

export interface GithubFake {
  /** The vault's `githubEndpoint`: where to connect and the CA. */
  readonly endpoint: {
    connect: { host: string; port: number };
    ca: string;
    timeoutMs?: number;
  };
  readonly seen: SeenGithubRequest[];
  /** Scripted answers by route; unset routes answer as GitHub. */
  readonly script: Partial<Record<GithubRoute, GithubResponder>>;
  /** Whose tokens the next code exchange hands out. */
  identity: FakeGithubUser;
  /** The repositories the fake knows, by lowercase `owner/repo`. */
  readonly repositories: Map<string, FakeRepository>;
  /** The user tokens' `expires_in`; 28800. */
  expiresInS: number;
  /** Every answer waits this long first; 0. */
  delayMs: number;
  /** User and refresh tokens issued, in order. */
  readonly issuedAccess: string[];
  readonly issuedRefresh: string[];
  /** Installation tokens minted, in order. */
  readonly minted: string[];
  hold(route: GithubRoute): { arrived: Promise<void>; release(): void };
  /**
   * A mint responder that issues a token as the default does, then answers
   * `status` with its body's members replaced, or (as `undefined`) dropped,
   * by `overrides`.
   */
  mintWith(
    overrides: Record<string, unknown>,
    status?: number,
  ): GithubResponder;
  on(route: GithubRoute): SeenGithubRequest[];
  /** Adds a repository `owner/name` with id `id` that `pullers` may pull. */
  addRepository(fullName: string, id: number, pullers: string[]): void;
  /**
   * Revokes the user token `token`: the default `user` and `repo` routes
   * answer 401 to it from now on, as GitHub does to a revoked grant's token.
   */
  revokeAccess(token: string): void;
  /** Back to the default answers, forgetting what was seen. */
  reset(): void;
  close(): Promise<void>;
}

/**
 * A user-token answer in S1a's shape (`a3`, `a9`), its fake token values
 * tagged `tag`; `overrides` replace or (as `undefined`) drop members.
 */
export function githubTokenAnswer(
  tag: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    access_token: `fake-gh-user-access-${tag}`,
    expires_in: 28_800,
    refresh_token: `fake-gh-refresh-${tag}`,
    refresh_token_expires_in: 15_638_400,
    scope: "",
    token_type: "bearer",
    ...overrides,
  };
}

export function githubJson(status: number, body?: unknown): GithubResponder {
  return (_seen, res) => res.status(status, body);
}

/** `expires_at` as GitHub writes it: whole seconds, `Z`. */
export function githubTime(epochMs: number): string {
  return new Date(Math.floor(epochMs / 1000) * 1000)
    .toISOString()
    .replace(".000Z", "Z");
}

const API_HOST = "api.github.com";
const WEB_HOST = "github.com";

function routeOf(host: string | undefined, method: string, path: string) {
  const bare = path.split("?")[0] ?? "";
  if (host === WEB_HOST)
    return method === "POST" && bare === "/login/oauth/access_token"
      ? "token"
      : "other";
  if (host !== API_HOST) return "other";
  if (method === "GET" && bare === "/user") return "user";
  if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(bare)) return "repo";
  if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(bare))
    return "installation";
  if (
    method === "POST" &&
    /^\/app\/installations\/\d+\/access_tokens$/.test(bare)
  )
    return "mint";
  if (method === "GET" && bare === "/installation/repositories")
    return "installationRepos";
  if (method === "DELETE" && bare === "/installation/token") return "revoke";
  return "other";
}

export async function startGithubFake(): Promise<GithubFake> {
  const ca = await loadOrCreateCa();
  const contexts = new Map(
    [WEB_HOST, API_HOST].map((host) => {
      const leaf = issueLeafCertificate(ca, host);
      return [host, { key: leaf.keyPem, cert: leaf.certPem }] as const;
    }),
  );
  const seen: SeenGithubRequest[] = [];
  const issuedAccess: string[] = [];
  const issuedRefresh: string[] = [];
  const minted: string[] = [];
  const repositories = new Map<string, FakeRepository>();
  /** Live user tokens and live refresh tokens, by value, to their user. */
  const accessUsers = new Map<string, FakeGithubUser>();
  const refreshUsers = new Map<string, FakeGithubUser>();
  /** Each minted token's repository ids. */
  const mintedRepos = new Map<string, number[]>();
  /** User tokens `revokeAccess` revoked. */
  const revoked = new Set<string>();
  const holds = new Map<
    GithubRoute,
    { arrived: () => void; released: Promise<void> }
  >();
  let issued = 0;

  const issueUserTokens = (user: FakeGithubUser) => {
    issued += 1;
    const answer = githubTokenAnswer(String(issued), {
      expires_in: fake.expiresInS,
    });
    const access = answer.access_token as string;
    const refresh = answer.refresh_token as string;
    accessUsers.set(access, user);
    refreshUsers.set(refresh, user);
    issuedAccess.push(access);
    issuedRefresh.push(refresh);
    return answer;
  };

  /** A default mint's answer: the asked permissions and repositories. */
  const mintAnswer = (request: SeenGithubRequest): Record<string, unknown> => {
    const asked = JSON.parse(request.body) as {
      repository_ids: number[];
      permissions: Record<string, string>;
    };
    const token = `fake-gh-install-${minted.length + 1}`;
    minted.push(token);
    mintedRepos.set(token, asked.repository_ids);
    return {
      token,
      expires_at: githubTime(Date.now() + 3_600_000),
      permissions: asked.permissions,
      repository_selection: "selected",
      repositories: asked.repository_ids.map((id) => ({
        id,
        full_name: `fake-owner/repo-${id}`,
      })),
    };
  };

  const defaults: Record<GithubRoute, GithubResponder> = {
    token(request, res) {
      if (request.form.grant_type === "refresh_token") {
        const user = refreshUsers.get(request.form.refresh_token ?? "");
        if (!user) {
          res.status(200, {
            error: "bad_refresh_token",
            error_description: "The refresh token passed is incorrect.",
            error_uri: "https://docs.github.com/fake",
          });
          return;
        }
        refreshUsers.delete(request.form.refresh_token!);
        res.status(200, issueUserTokens(user));
        return;
      }
      if (request.form.code !== FAKE_GITHUB_CODE) {
        res.status(200, {
          error: "bad_verification_code",
          error_description: "The code passed is incorrect or expired.",
          error_uri: "https://docs.github.com/fake",
        });
        return;
      }
      res.status(200, issueUserTokens(fake.identity));
    },
    user(request, res) {
      const user = revoked.has(request.bearer ?? "")
        ? undefined
        : accessUsers.get(request.bearer ?? "");
      if (!user) res.status(401, { message: "Bad credentials" });
      else
        res.status(200, {
          login: user.login,
          id: user.id,
          node_id: "FAKE_NODE",
          type: "User",
          site_admin: false,
        });
    },
    repo(request, res) {
      const user = revoked.has(request.bearer ?? "")
        ? undefined
        : accessUsers.get(request.bearer ?? "");
      const key = request.path.slice("/repos/".length).toLowerCase();
      const repo = repositories.get(key);
      if (!user) {
        res.status(401, { message: "Bad credentials" });
        return;
      }
      if (!repo) {
        res.status(404, { message: "Not Found" });
        return;
      }
      res.status(200, {
        id: repo.id,
        full_name: repo.fullName,
        default_branch: "main",
        permissions: {
          admin: false,
          maintain: false,
          push: false,
          triage: false,
          pull: repo.pullers.has(user.login),
        },
      });
    },
    installation(request, res) {
      const key = request.path
        .slice("/repos/".length, -"/installation".length)
        .toLowerCase();
      const repo = repositories.get(key);
      if (!repo || repo.noApp) res.status(404, { message: "Not Found" });
      else
        res.status(200, {
          id: FAKE_INSTALLATION_ID,
          app_id: FAKE_GITHUB_APP_ID,
          repository_selection: "selected",
        });
    },
    mint: (request, res) => res.status(201, mintAnswer(request)),
    installationRepos(request, res) {
      const ids = mintedRepos.get(request.bearer ?? "");
      if (!ids) {
        res.status(401, { message: "Bad credentials" });
        return;
      }
      res.status(200, {
        total_count: ids.length,
        repository_selection: "selected",
        repositories: ids.map((id) => ({ id })),
      });
    },
    revoke(_request, res) {
      res.status(204);
    },
    other(_request, res) {
      res.status(404, { message: "Not Found" });
    },
  };

  const script: Partial<Record<GithubRoute, GithubResponder>> = {};
  const fake: GithubFake = {
    endpoint: { connect: { host: "127.0.0.1", port: 0 }, ca: ca.certPem },
    seen,
    script,
    identity: FAKE_GITHUB_USER,
    repositories,
    expiresInS: 28_800,
    delayMs: 0,
    issuedAccess,
    issuedRefresh,
    minted,
    hold(route) {
      let arrived!: () => void;
      let release!: () => void;
      const arrivedP = new Promise<void>((resolve) => (arrived = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      holds.set(route, { arrived, released });
      return { arrived: arrivedP, release };
    },
    mintWith:
      (overrides, status = 201) =>
      (request, res) =>
        res.status(status, { ...mintAnswer(request), ...overrides }),
    on: (route) => seen.filter((request) => request.route === route),
    addRepository(fullName, id, pullers) {
      repositories.set(fullName.toLowerCase(), {
        id,
        fullName,
        pullers: new Set(pullers),
      });
    },
    revokeAccess(token) {
      revoked.add(token);
    },
    reset() {
      seen.length = 0;
      for (const route of Object.keys(script) as GithubRoute[])
        delete script[route];
      fake.identity = FAKE_GITHUB_USER;
      fake.expiresInS = 28_800;
      fake.delayMs = 0;
      delete fake.endpoint.timeoutMs;
      repositories.clear();
      revoked.clear();
      holds.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  const server = https.createServer(
    {
      ...contexts.get(API_HOST)!,
      SNICallback: (name, done) => {
        const context = contexts.get(name);
        done(null, context ? createSecureContext(context) : undefined);
      },
    },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const path = req.url ?? "";
        const method = req.method ?? "";
        const host = req.headers.host;
        const route: GithubRoute = routeOf(host, method, path);
        const body = Buffer.concat(chunks).toString("utf8");
        const authorization = req.headers.authorization;
        const request: SeenGithubRequest = {
          route,
          method,
          path,
          host,
          servername: (req.socket as TLSSocket).servername,
          headers: req.headers,
          body,
          form:
            route === "token"
              ? Object.fromEntries(new URLSearchParams(body))
              : {},
          bearer:
            typeof authorization === "string" &&
            authorization.startsWith("Bearer ")
              ? authorization.slice("Bearer ".length)
              : undefined,
        };
        seen.push(request);
        const answer = {
          raw: res,
          status(code: number, payload?: unknown) {
            if (res.destroyed) return;
            if (payload === undefined) {
              res.writeHead(code);
              res.end();
              return;
            }
            res.writeHead(code, { "content-type": "application/json" });
            res.end(
              typeof payload === "string" ? payload : JSON.stringify(payload),
            );
          },
        };
        const respond = (): void => {
          const responder = script[route] ?? defaults[route];
          if (fake.delayMs > 0)
            setTimeout(() => responder(request, answer), fake.delayMs);
          else responder(request, answer);
        };
        const held = holds.get(route);
        if (held) {
          holds.delete(route);
          held.arrived();
          void held.released.then(respond);
        } else respond();
      });
    },
  );
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  fake.endpoint.connect.port = (server.address() as net.AddressInfo).port;
  return fake;
}
