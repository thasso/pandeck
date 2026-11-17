/**
 * A loopback stand-in for Google's token info and userinfo hosts (Task-1410
 * PR2): one HTTPS server presenting one CA-issued `*.googleapis.com`
 * certificate for both `oauth2.googleapis.com` and
 * `openidconnect.googleapis.com`, reached through the verifier's connect
 * override (`DevboxEndpoints`), so the TLS name and `Host` stay the real ones
 * and are recorded per request. It imports nothing from `gateway/`
 * (`workerBoundary.test.ts`).
 *
 * By default it answers the shapes measured on IDB (2026-11-17): token info
 * with `email_verified` the STRING "true" and no `hd`; userinfo with a
 * boolean `email_verified` and `hd`. Every token, id and address is fake.
 */
import type { ServerResponse } from "node:http";
import https from "node:https";
import type net from "node:net";
import type { TLSSocket } from "node:tls";
import {
  issueLeafCertificate,
  loadOrCreateCa,
} from "../packageProxy/certificateAuthority.ts";

export const FAKE_CODER_CLIENT_ID =
  "FAKE_coder-client.apps.googleusercontent.test";
export const FAKE_OWNER_TOKEN = "FAKE_owner-google-access-token";
export const FAKE_OWNER_SUB = "FAKE_sub-100000000000000000001";
export const FAKE_OWNER_EMAIL = "owner@example.test";
export const FAKE_HD = "example.test";

export type GoogleRoute = "tokeninfo" | "userinfo" | "other";

export interface SeenGoogleRequest {
  route: GoogleRoute;
  method: string;
  /** The request target as sent, query included. */
  path: string;
  /** The TLS server name the client asked for. */
  servername: string | false | null;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** Settles when the client's connection for this request closes. */
  closed: Promise<void>;
}

export type GoogleResponder = (
  seen: SeenGoogleRequest,
  res: { status(code: number, body: unknown): void; raw: ServerResponse },
) => void;

export interface GoogleFake {
  /** The verifier's `endpoints`: where to connect and the CA. */
  readonly endpoints: { connect: { host: string; port: number }; ca: string };
  readonly seen: SeenGoogleRequest[];
  tokenInfo: GoogleResponder;
  userInfo: GoogleResponder;
  /**
   * Parks the next request on `route` until `release()` (never answering
   * unless released): `arrived` settles when it is parked.
   */
  hold(route: GoogleRoute): {
    arrived: Promise<SeenGoogleRequest>;
    release(): void;
  };
  on(route: GoogleRoute): SeenGoogleRequest[];
  close(): Promise<void>;
}

/** Token info as measured: string `expires_in` and `email_verified`, no `hd`. */
export function measuredTokenInfo(
  change: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    azp: FAKE_CODER_CLIENT_ID,
    aud: FAKE_CODER_CLIENT_ID,
    sub: FAKE_OWNER_SUB,
    scope:
      "https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/userinfo.profile",
    exp: "1700000000",
    expires_in: "3566",
    email: FAKE_OWNER_EMAIL,
    email_verified: "true",
    access_type: "offline",
    ...change,
  };
}

/** Userinfo as measured: boolean `email_verified` and `hd`. */
export function measuredUserInfo(
  change: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sub: FAKE_OWNER_SUB,
    name: "Fake Owner",
    email: FAKE_OWNER_EMAIL,
    email_verified: true,
    hd: FAKE_HD,
    ...change,
  };
}

export function jsonResponder(status: number, body: unknown): GoogleResponder {
  return (_seen, res) => res.status(status, body);
}

export async function startGoogleFake(): Promise<GoogleFake> {
  const ca = await loadOrCreateCa();
  // Bun's https.Server ignores SNICallback; one leaf must cover both names.
  const leaf = issueLeafCertificate(ca, "*.googleapis.com");
  const seen: SeenGoogleRequest[] = [];
  const holds = new Map<
    GoogleRoute,
    { arrived: (seen: SeenGoogleRequest) => void; released: Promise<void> }
  >();

  const fake: GoogleFake = {
    endpoints: { connect: { host: "127.0.0.1", port: 0 }, ca: ca.certPem },
    seen,
    tokenInfo: jsonResponder(200, measuredTokenInfo()),
    userInfo: jsonResponder(200, measuredUserInfo()),
    hold(route) {
      let arrived!: (seen: SeenGoogleRequest) => void;
      let release!: () => void;
      const arrivedP = new Promise<SeenGoogleRequest>(
        (resolve) => (arrived = resolve),
      );
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
    { key: leaf.keyPem, cert: leaf.certPem },
    (req, res) => {
      const closed = new Promise<void>((resolve) =>
        req.socket.once("close", () => resolve()),
      );
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const path = req.url ?? "";
        const route: GoogleRoute =
          req.method === "POST" && path === "/tokeninfo"
            ? "tokeninfo"
            : req.method === "GET" && path === "/v1/userinfo"
              ? "userinfo"
              : "other";
        const request: SeenGoogleRequest = {
          route,
          method: req.method ?? "",
          path,
          servername: (req.socket as TLSSocket).servername,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          closed,
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
          if (route === "tokeninfo") fake.tokenInfo(request, answer);
          else if (route === "userinfo") fake.userInfo(request, answer);
          else answer.status(404, { error: "not_found" });
        };
        const held = holds.get(route);
        if (held) {
          holds.delete(route);
          held.arrived(request);
          void held.released.then(respond);
        } else respond();
      });
    },
  );
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  fake.endpoints.connect.port = (server.address() as net.AddressInfo).port;
  return fake;
}
