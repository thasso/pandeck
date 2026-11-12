/**
 * The gateway UI's fake OIDC issuer for tests (Task-1402): loopback HTTP,
 * reached through the test-only `allowInsecureRequests`. It checks PKCE, the
 * client's basic auth and the redirect URI, and signs RS256 ID tokens whose
 * claims each test can change. `signIn.test.ts` and `gatewayWeb/accounts.test.ts`
 * share it.
 */
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import http from "node:http";

export const CLIENT_ID = "gateway-ui-test-client";
export const CLIENT_PW = "fake-client-pw-for-tests-only";
export const PUBLIC_ORIGIN = "https://gateway.test";
export const REDIRECT_URI = `${PUBLIC_ORIGIN}/auth/callback`;
export const EMAIL = "person@example.org";

export type Claims = Record<string, unknown>;

/** How the issuer answers one authorization's token request. */
export interface TokenCase {
  claims?: (claims: Claims) => Claims;
  /** Store another challenge, so the verifier the gateway sends fails. */
  wrongChallenge?: boolean;
  noIdToken?: boolean;
  /** Flip one decoded byte of the ID token's signature. */
  tamperSignature?: boolean;
  /** Sign with the second key, under this `kid` (default `k1`, the first). */
  kid?: string;
}

/** What the issuer's `jwks_uri` answers. */
export interface KeySet {
  /** Which of the two keys it lists. */
  kids: string[];
  status: number;
  /** Bytes of padding, to exceed the gateway's size cap. */
  padding: number;
  /** How long it waits before answering. */
  delayMs: number;
  /** Answers 200 with this instead of the keys. */
  raw?: { type: string; body: string } | undefined;
}

interface Authorization {
  challenge: string;
  nonce: string;
  testCase: TokenCase;
}

export interface FakeIssuer {
  url: string;
  /** Its loopback HTTP URL. */
  listening: string;
  /** Approves the provider URL the gateway redirected to; answers the code. */
  authorize(provider: URL, testCase?: TokenCase): string;
  /** Every value the issuer saw that must never leak. */
  secrets: Set<string>;
  idTokens: string[];
  publicKey: KeyObject;
  keySet: KeySet;
  /** How often `jwks_uri` was asked. */
  keyRequests(): number;
  close(): Promise<void>;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * `advertised` is the issuer URL its documents and tokens name, for a client
 * that reaches the loopback listener through a fetch stub (`fetchVia`);
 * otherwise the loopback URL itself.
 */
export async function startFakeIssuer({
  advertised,
  now,
}: {
  advertised?: string;
  now: () => number;
}): Promise<FakeIssuer> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const second = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks: Record<string, unknown> = {
    k1: { ...publicKey.export({ format: "jwk" }), kid: "k1" },
    k2: { ...second.publicKey.export({ format: "jwk" }), kid: "k2" },
  };
  const keySet: KeySet = { kids: ["k1"], status: 200, padding: 0, delayMs: 0 };
  let keyRequests = 0;
  const pending = new Map<string, Authorization>();
  const secrets = new Set<string>([CLIENT_PW]);
  const idTokens: string[] = [];
  let base = "";
  let counter = 0;

  const idToken = (claims: Claims, testCase: TokenCase): string => {
    const kid = testCase.kid ?? "k1";
    const input = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode(claims)}`;
    const key = kid === "k1" ? privateKey : second.privateKey;
    const signature = sign("RSA-SHA256", Buffer.from(input), key);
    if (testCase.tamperSignature)
      signature.writeUInt8(signature.readUInt8(10) ^ 0xff, 10);
    return `${input}.${signature.toString("base64url")}`;
  };

  const server = http.createServer((req, res) => {
    const reply = (status: number, value: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const url = new URL(req.url ?? "/", base);
    if (url.pathname === "/.well-known/openid-configuration")
      return reply(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    if (url.pathname === "/jwks") {
      keyRequests++;
      const { status, kids, padding, delayMs, raw } = keySet;
      if (raw) {
        res.writeHead(200, { "content-type": raw.type });
        res.end(raw.body);
        return;
      }
      const body = {
        keys: kids.map((kid) => jwks[kid]),
        ...(padding ? { padding: "x".repeat(padding) } : {}),
      };
      setTimeout(() => reply(status, body), delayMs);
      return;
    }
    if (url.pathname !== "/token" || req.method !== "POST")
      return reply(404, { error: "not_found" });
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      const form = new URLSearchParams(raw);
      const basic = Buffer.from(
        (req.headers.authorization ?? "").replace(/^Basic /, ""),
        "base64",
      ).toString();
      const [id, pw] = basic.split(":").map(decodeURIComponent);
      const code = form.get("code") ?? "";
      const verifier = form.get("code_verifier") ?? "";
      secrets.add(verifier);
      const record = pending.get(code);
      pending.delete(code);
      if (
        form.get("grant_type") !== "authorization_code" ||
        form.get("redirect_uri") !== REDIRECT_URI ||
        id !== CLIENT_ID ||
        pw !== CLIENT_PW ||
        !record ||
        createHash("sha256").update(verifier).digest("base64url") !==
          record.challenge
      )
        return reply(400, {
          error: "invalid_grant",
          error_description: "provider-detail-must-not-leak",
        });
      if (record.testCase.noIdToken)
        return reply(200, { access_token: "at", token_type: "Bearer" });
      const at = Math.floor(now() / 1000);
      let claims: Claims = {
        iss: base,
        aud: CLIENT_ID,
        sub: "subject-1",
        email: EMAIL,
        email_verified: true,
        iat: at,
        exp: at + 300,
        nonce: record.nonce,
      };
      if (record.testCase.claims) claims = record.testCase.claims(claims);
      const token = idToken(claims, record.testCase);
      idTokens.push(token);
      secrets.add(token);
      reply(200, { access_token: "at", token_type: "Bearer", id_token: token });
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  const listening = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  base = advertised ?? listening;
  return {
    url: base,
    listening,
    secrets,
    idTokens,
    publicKey,
    keySet,
    keyRequests: () => keyRequests,
    authorize(provider, testCase = {}) {
      assert.equal(provider.origin + provider.pathname, `${base}/authorize`);
      const p = provider.searchParams;
      assert.equal(p.get("client_id"), CLIENT_ID);
      const code = `code-${++counter}-${Math.random().toString(36).slice(2)}`;
      for (const value of [code, p.get("state"), p.get("nonce")])
        secrets.add(value!);
      pending.set(code, {
        challenge: testCase.wrongChallenge
          ? createHash("sha256").update("another").digest("base64url")
          : p.get("code_challenge")!,
        nonce: p.get("nonce")!,
        testCase,
      });
      return code;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
