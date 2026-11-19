/**
 * A loopback stand-in for `slack.com`'s Web API (Task-1452): one HTTPS server
 * presenting a CA-issued `slack.com` certificate, reached through the vault's
 * connect override (`SlackEndpoint`), so the TLS name and `Host` stay the
 * real ones and are recorded per request. It imports nothing from `gateway/`
 * (`workerBoundary.test.ts`). By default it answers `POST
 * /api/oauth.v2.access` as Slack documents for user tokens with rotation (the
 * exchange nests the tokens under `authed_user`, a refresh answers them at
 * the top level), and `POST /api/auth.test` with the fake user and workspace;
 * a test scripts otherwise. `hold` parks the next request on a route.
 *
 * Every token, code, secret and id here is fake, and none is shaped like a
 * real Slack token.
 */
import type { ServerResponse } from "node:http";
import https from "node:https";
import type net from "node:net";
import type { TLSSocket } from "node:tls";
import {
  issueLeafCertificate,
  loadOrCreateCa,
} from "../packageProxy/certificateAuthority.ts";

export const FAKE_SLACK_CLIENT = {
  clientId: "fake-slack-client-id",
  clientSecret: "fake-slack-client-secret-sentinel",
};
export const FAKE_SLACK_CODE = "fake-slack-auth-code";
export const FAKE_SLACK_REDIRECT =
  "https://gateway.example.test/auth/slack/callback";
export const FAKE_TEAM_ID = "TFAKE0001";
export const FAKE_TEAM_NAME = "Fake Workspace";
export const FAKE_USER_ID = "UFAKE0001";
export const FAKE_WORKSPACE_HOST = "fake-workspace.slack.com";
export const FAKE_SLACK_SCOPE = "search:read,channels:history";
/** Fixed token values tests script answers or records with; all fake. */
export const FAKE_SLACK_TOKENS = {
  storedRefresh: "fake-slack-refresh-stored",
  directAccess: "fake-slack-access-direct",
  scriptedAccess: "fake-slack-access-scripted",
  scriptedRefresh: "fake-slack-refresh-scripted",
  botAccess: "fake-slack-access-bot",
  plantedRefresh: "fake-slack-refresh-planted",
  nestedAccess: "fake-slack-access-nested",
  nestedRefresh: "fake-slack-refresh-nested",
  apiToken: "fake-slack-api-token",
} as const;

export type SlackRoute = "access" | "authTest" | "other";

export interface SeenSlackRequest {
  route: SlackRoute;
  method: string;
  path: string;
  /** The TLS server name the client asked for. */
  servername: string | false | null;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** The form body's fields. */
  form: Record<string, string>;
}

export type SlackResponder = (
  seen: SeenSlackRequest,
  res: { status(code: number, body: unknown): void; raw: ServerResponse },
) => void;

export interface SlackFake {
  /** The vault's `slackEndpoint`: where to connect and the CA. */
  readonly endpoint: {
    connect: { host: string; port: number };
    ca: string;
    timeoutMs?: number;
  };
  readonly seen: SeenSlackRequest[];
  /** What `oauth.v2.access` answers; default rotating fake user tokens. */
  access: SlackResponder;
  /** What `auth.test` answers; default the fake user and workspace. */
  authTest: SlackResponder;
  /** The `expires_in` the default token answers carry; 43200. */
  expiresInS: number;
  /** Refresh tokens the default access route issued, in order. */
  readonly issuedRefresh: string[];
  /** Access tokens the default access route issued, in order. */
  readonly issuedAccess: string[];
  /**
   * Parks the next request on `route` until `release()`: `arrived` settles
   * when it is parked.
   */
  hold(route: SlackRoute): { arrived: Promise<void>; release(): void };
  /** Requests on one route. */
  on(route: SlackRoute): SeenSlackRequest[];
  /** The refresh tokens the vault sent, in order. */
  refreshesSent(): string[];
  /** Back to the default answers, forgetting what was seen. */
  reset(): void;
  close(): Promise<void>;
}

export function slackJson(status: number, body: unknown): SlackResponder {
  return (_seen, res) => res.status(status, body);
}

/** `auth.test`'s answer for the fake user and workspace. */
export const AUTH_TEST_OK = {
  ok: true,
  url: `https://${FAKE_WORKSPACE_HOST}/`,
  team: FAKE_TEAM_NAME,
  user: "fake.user",
  team_id: FAKE_TEAM_ID,
  user_id: FAKE_USER_ID,
};

export async function startSlackFake(): Promise<SlackFake> {
  const ca = await loadOrCreateCa();
  const leaf = issueLeafCertificate(ca, "slack.com");
  const seen: SeenSlackRequest[] = [];
  const issuedRefresh: string[] = [];
  const issuedAccess: string[] = [];
  const holds = new Map<
    SlackRoute,
    { arrived: () => void; released: Promise<void> }
  >();
  let issued = 0;

  const issue = (): { access: string; refresh: string } => {
    issued += 1;
    const access = `fake-slack-access-${issued}`;
    const refresh = `fake-slack-refresh-${issued}`;
    issuedAccess.push(access);
    issuedRefresh.push(refresh);
    return { access, refresh };
  };

  const defaultAccess: SlackResponder = (request, res) => {
    const { access, refresh } = issue();
    if (request.form.grant_type === "refresh_token") {
      res.status(200, {
        ok: true,
        app_id: "AFAKE0001",
        scope: FAKE_SLACK_SCOPE,
        token_type: "user",
        access_token: access,
        refresh_token: refresh,
        expires_in: fake.expiresInS,
        team: { id: FAKE_TEAM_ID, name: FAKE_TEAM_NAME },
        enterprise: null,
        is_enterprise_install: false,
      });
      return;
    }
    res.status(200, {
      ok: true,
      app_id: "AFAKE0001",
      authed_user: {
        id: FAKE_USER_ID,
        scope: FAKE_SLACK_SCOPE,
        access_token: access,
        expires_in: fake.expiresInS,
        refresh_token: refresh,
        token_type: "user",
      },
      team: { id: FAKE_TEAM_ID, name: FAKE_TEAM_NAME },
      enterprise: null,
      is_enterprise_install: false,
    });
  };
  const defaultAuthTest = slackJson(200, AUTH_TEST_OK);

  const fake: SlackFake = {
    endpoint: { connect: { host: "127.0.0.1", port: 0 }, ca: ca.certPem },
    seen,
    issuedRefresh,
    issuedAccess,
    expiresInS: 43_200,
    access: defaultAccess,
    authTest: defaultAuthTest,
    hold(route) {
      let arrived!: () => void;
      let release!: () => void;
      const arrivedP = new Promise<void>((resolve) => (arrived = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      holds.set(route, { arrived, released });
      return { arrived: arrivedP, release };
    },
    on: (route) => seen.filter((request) => request.route === route),
    refreshesSent: () =>
      fake
        .on("access")
        .filter((request) => request.form.grant_type === "refresh_token")
        .map((request) => request.form.refresh_token ?? ""),
    reset() {
      seen.length = 0;
      fake.access = defaultAccess;
      fake.authTest = defaultAuthTest;
      fake.expiresInS = 43_200;
      holds.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  const server = https.createServer(
    { key: leaf.keyPem, cert: leaf.certPem },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const path = req.url ?? "";
        const route: SlackRoute =
          req.method !== "POST"
            ? "other"
            : path === "/api/oauth.v2.access"
              ? "access"
              : path === "/api/auth.test"
                ? "authTest"
                : "other";
        const body = Buffer.concat(chunks).toString("utf8");
        const request: SeenSlackRequest = {
          route,
          method: req.method ?? "",
          path,
          servername: (req.socket as TLSSocket).servername,
          headers: req.headers,
          body,
          form: Object.fromEntries(new URLSearchParams(body)),
        };
        seen.push(request);
        const answer = {
          raw: res,
          status(code: number, payload: unknown) {
            if (res.destroyed) return;
            res.writeHead(code, { "content-type": "application/json" });
            res.end(
              typeof payload === "string" ? payload : JSON.stringify(payload),
            );
          },
        };
        const respond = (): void => {
          if (route === "access") fake.access(request, answer);
          else if (route === "authTest") fake.authTest(request, answer);
          else answer.status(404, { ok: false, error: "unknown_method" });
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
