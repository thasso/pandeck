/**
 * A loopback stand-in for Atlassian's OAuth hosts (Task-1411): one HTTPS
 * server presenting one CA-issued `*.atlassian.com` certificate for both
 * `auth.atlassian.com` and `api.atlassian.com`, reached through the vault's
 * connect override (`AtlassianEndpoint`), so the TLS name and `Host` stay the
 * real ones and are recorded per request. It imports nothing from `gateway/`
 * (`workerBoundary.test.ts`). It answers `POST /oauth/token` with rotating fake
 * tokens and `GET /oauth/token/accessible-resources` with one fake site,
 * unless a test scripts otherwise; `hold` parks the next request on a route.
 *
 * Every token, code, secret and cloud id here is fake.
 */
import type { ServerResponse } from "node:http";
import https from "node:https";
import type net from "node:net";
import type { TLSSocket } from "node:tls";
import {
  issueLeafCertificate,
  loadOrCreateCa,
} from "../packageProxy/certificateAuthority.ts";

export const FAKE_CLIENT = {
  clientId: "fake-atlassian-client-id",
  clientSecret: "fake-atlassian-client-secret-sentinel",
};
export const FAKE_SITE = "fake-site.atlassian.net";
/** A UUID, as Atlassian's are; visibly not a real one. */
export const FAKE_CLOUD_ID = "00000000-0000-4000-8000-00000000fa4e";
export const FAKE_CODE = "fake-atlassian-auth-code";
/** A stored refresh token and an access token for direct client calls. */
export const FAKE_STORED_REFRESH = "fake-atl-refresh-stored";
export const FAKE_ACCESS = "fake-atl-access-direct";
/** A refresh token an edge might try to plant through a put; never real. */
export const FAKE_PLANTED_REFRESH = "fake-atl-refresh-planted";
/** An API-token record as the edge puts one today; every field fake. */
export const FAKE_API_TOKEN_RECORD = JSON.stringify({
  site: FAKE_SITE,
  email: "me@example.test",
  token: "fake-atl-api-token",
});
export const FAKE_REDIRECT =
  "https://gateway.example.test/auth/atlassian/callback";

export type AtlassianRoute = "token" | "resources" | "other";

export interface SeenAtlassianRequest {
  route: AtlassianRoute;
  method: string;
  path: string;
  /** The TLS server name the client asked for. */
  servername: string | false | null;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export type AtlassianResponder = (
  seen: SeenAtlassianRequest,
  res: { status(code: number, body: unknown): void; raw: ServerResponse },
) => void;

export interface AtlassianFake {
  /** The vault's `atlassianEndpoint`: where to connect and the CA. */
  readonly endpoint: {
    connect: { host: string; port: number };
    ca: string;
    timeoutMs?: number;
  };
  readonly seen: SeenAtlassianRequest[];
  /** What the token route answers; default rotating fake tokens. */
  token: AtlassianResponder;
  /** What the site list answers; default one fake site. */
  resources: AtlassianResponder;
  /** The `expires_in` the default token answers carry; 3600. */
  expiresInS: number;
  /** Refresh tokens the default token route issued, in order. */
  readonly issuedRefresh: string[];
  /**
   * Parks the next request on `route` until `release()`: `arrived` settles
   * when it is parked.
   */
  hold(route: AtlassianRoute): { arrived: Promise<void>; release(): void };
  /** Requests on one route. */
  on(route: AtlassianRoute): SeenAtlassianRequest[];
  close(): Promise<void>;
}

export function jsonResponder(
  status: number,
  body: unknown,
): AtlassianResponder {
  return (_seen, res) => res.status(status, body);
}

/** One site listed twice, for Jira and for Confluence, as Atlassian does. */
export const ONE_SITE = [
  {
    id: FAKE_CLOUD_ID,
    name: "fake-site",
    url: `https://${FAKE_SITE}`,
    scopes: ["read:jira-work"],
  },
  {
    id: FAKE_CLOUD_ID,
    name: "fake-site",
    url: `https://${FAKE_SITE}`,
    scopes: ["read:confluence-content.all"],
  },
];

export async function startAtlassianFake(): Promise<AtlassianFake> {
  const ca = await loadOrCreateCa();
  // Bun's https.Server ignores SNICallback; one leaf must cover both names.
  const leaf = issueLeafCertificate(ca, "*.atlassian.com");
  const seen: SeenAtlassianRequest[] = [];
  const issuedRefresh: string[] = [];
  const holds = new Map<
    AtlassianRoute,
    { arrived: () => void; released: Promise<void> }
  >();
  let issued = 0;

  const fake: AtlassianFake = {
    endpoint: { connect: { host: "127.0.0.1", port: 0 }, ca: ca.certPem },
    seen,
    issuedRefresh,
    expiresInS: 3600,
    token: (_request, res) => {
      issued += 1;
      const refresh = `fake-atl-refresh-${issued}`;
      issuedRefresh.push(refresh);
      res.status(200, {
        access_token: `fake-atl-access-${issued}`,
        refresh_token: refresh,
        expires_in: fake.expiresInS,
        scope: "read:jira-work offline_access",
        token_type: "Bearer",
      });
    },
    resources: jsonResponder(200, ONE_SITE),
    hold(route) {
      let arrived!: () => void;
      let release!: () => void;
      const arrivedP = new Promise<void>((resolve) => (arrived = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      holds.set(route, { arrived, released });
      return { arrived: arrivedP, release };
    },
    on: (route) => seen.filter((request) => request.route === route),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  const server = https.createServer(
    {
      key: leaf.keyPem,
      cert: leaf.certPem,
    },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const path = req.url ?? "";
        const route: AtlassianRoute =
          req.method === "POST" && path === "/oauth/token"
            ? "token"
            : req.method === "GET" &&
                path === "/oauth/token/accessible-resources"
              ? "resources"
              : "other";
        const request: SeenAtlassianRequest = {
          route,
          method: req.method ?? "",
          path,
          servername: (req.socket as TLSSocket).servername,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        seen.push(request);
        const answer = {
          raw: res,
          status(code: number, body: unknown) {
            if (res.destroyed) return;
            res.writeHead(code, { "content-type": "application/json" });
            res.end(typeof body === "string" ? body : JSON.stringify(body));
          },
        };
        const respond = (): void => {
          if (route === "token") fake.token(request, answer);
          else if (route === "resources") fake.resources(request, answer);
          else answer.status(404, { error: "not_found" });
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
