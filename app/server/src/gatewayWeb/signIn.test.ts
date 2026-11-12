/**
 * The gateway's own sign-in (`gatewayWeb/`, Task-1402) end to end: the HTTPS
 * listener on a test CA, a fake OIDC issuer on loopback HTTP reached through
 * the test-only `allowInsecureRequests`, a real `ClientRegistry` in a temp
 * state directory and an injected clock. The issuer checks PKCE, the client's
 * basic auth and the redirect URI, and signs RS256 ID tokens whose claims each
 * test can change.
 */
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { ClientRegistry } from "../gateway/clientRegistry.ts";
import { edgeTlsFor } from "../gateway/x509.ts";
import type { GatewayWebConfig } from "./config.ts";
import type { OidcTestOptions } from "./oidc.ts";
import { startGatewayWeb, type RunningGatewayWeb } from "./server.ts";

const CLIENT_ID = "gateway-ui-test-client";
const CLIENT_PW = "fake-client-pw-for-tests-only";
const PUBLIC_ORIGIN = "https://gateway.test";
const REDIRECT_URI = `${PUBLIC_ORIGIN}/auth/callback`;
const EMAIL = "person@example.org";
const MINUTE = 60_000;

type Claims = Record<string, unknown>;

/** How the issuer answers one authorization's token request. */
interface TokenCase {
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
interface KeySet {
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

interface FakeIssuer {
  url: string;
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

const tls = edgeTlsFor(["localhost", "127.0.0.1"], undefined);
let issuer: FakeIssuer;
let clock = Date.now();
let distDir: string;
const logs: string[] = [];
/** Refusal bodies and self-redirect locations, checked for leaks. */
const exposed: string[] = [];
const open: { close(): Promise<void> }[] = [];
const agent = new https.Agent({ ca: tls.caCertPem, keepAlive: true });

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function startFakeIssuer(): Promise<FakeIssuer> {
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
      const at = Math.floor(clock / 1000);
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
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return {
    url: base,
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

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  gateway: RunningGatewayWeb,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port: gateway.port,
        path,
        method: options.method ?? "GET",
        headers: {
          ...options.headers,
          ...(options.body === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(options.body)) }),
        },
        agent,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          const answer = {
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          };
          if (answer.status >= 400) exposed.push(body);
          const location = res.headers.location;
          if (location?.startsWith("/")) exposed.push(location);
          resolve(answer);
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

function setCookie(answer: Answer, name: string): string | undefined {
  for (const line of answer.headers["set-cookie"] ?? [])
    if (line.startsWith(`${name}=`)) return line;
  return undefined;
}

function cookieValue(answer: Answer, name: string): string | undefined {
  const line = setCookie(answer, name);
  return line?.slice(name.length + 1).split(";")[0];
}

interface Gateway {
  web: RunningGatewayWeb;
  registry: ClientRegistry;
}

async function startUi(
  allow: Partial<GatewayWebConfig["allow"]> = {},
  provider: {
    issuer?: string;
    oidcTestOptions?: OidcTestOptions;
  } = {},
): Promise<Gateway> {
  mkdirSync(DATA_DIR, { recursive: true });
  const stateDir = mkdtempSync(join(DATA_DIR, "gateway-web-"));
  const registry = new ClientRegistry(stateDir, () => clock);
  const web = await startGatewayWeb({
    config: {
      port: 0,
      publicOrigin: PUBLIC_ORIGIN,
      certPem: tls.serverCertPem,
      keyPem: tls.serverKeyPem,
      distDir,
      oidc: {
        issuer: provider.issuer ?? issuer.url,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_PW,
      },
      allow: {
        emailDomains: ["example.org"],
        emails: [],
        claims: {},
        ...allow,
      },
    },
    users: {
      signIn: (identity) => registry.signIn(identity),
      user: (id) => registry.user(id),
    },
    log: (line) => logs.push(line),
    now: () => clock,
    oidcTestOptions: provider.oidcTestOptions ?? {
      allowInsecureRequests: true,
    },
  });
  open.push(web);
  return { web, registry };
}

interface Flow {
  testCase?: TokenCase;
  /** Replaces the state the callback names. */
  state?: string;
  /** Replaces the sign-in cookie; null sends none. */
  signinCookie?: string | null;
  /** Clock advance between login and callback. */
  waitMs?: number;
}

/** One browser sign-in; answers the callback. */
async function signIn(gateway: Gateway, flow: Flow = {}): Promise<Answer> {
  return (await startSignIn(gateway, flow))();
}

/** A browser sign-in up to the provider's answer; the callback is returned. */
async function startSignIn(
  gateway: Gateway,
  flow: Flow = {},
): Promise<() => Promise<Answer>> {
  const login = await request(gateway.web, "/auth/login");
  assert.equal(login.status, 302);
  const provider = new URL(login.headers.location!);
  const signin = cookieValue(login, "__Host-pgw_signin")!;
  issuer.secrets.add(signin);
  const code = issuer.authorize(provider, flow.testCase);
  clock += flow.waitMs ?? 0;
  const state = flow.state ?? provider.searchParams.get("state")!;
  const cookie =
    flow.signinCookie === null
      ? undefined
      : `__Host-pgw_signin=${flow.signinCookie ?? signin}`;
  return async () => {
    const answer = await request(
      gateway.web,
      `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      cookie ? { headers: { cookie } } : {},
    );
    const session = cookieValue(answer, "__Host-pgw_session");
    if (session) issuer.secrets.add(session);
    return answer;
  };
}

function sessionOf(answer: Answer): string {
  const value = cookieValue(answer, "__Host-pgw_session");
  assert.ok(value, "a session cookie was set");
  return `__Host-pgw_session=${value}`;
}

async function me(gateway: Gateway, cookie?: string, path = "/api/me") {
  const answer = await request(
    gateway.web,
    path,
    cookie ? { headers: { cookie } } : {},
  );
  return {
    status: answer.status,
    body: JSON.parse(answer.body) as Record<string, unknown>,
  };
}

function logout(
  gateway: Gateway,
  cookie: string,
  headers: Record<string, string> = {
    origin: PUBLIC_ORIGIN,
    "x-gateway-ui": "1",
  },
): Promise<Answer> {
  return request(gateway.web, "/auth/logout", {
    method: "POST",
    headers: { cookie, ...headers },
  });
}

/** The refusal a failed callback answers: back to the page, no session. */
function assertRefused(answer: Answer, code: string): void {
  assert.equal(answer.status, 303);
  assert.equal(answer.headers.location, `/?signin=${code}`);
  assert.equal(cookieValue(answer, "__Host-pgw_session"), undefined);
  assert.match(setCookie(answer, "__Host-pgw_signin") ?? "", /Max-Age=0/);
}

beforeAll(async () => {
  issuer = await startFakeIssuer();
  distDir = mkdtempSync(join(tmpdir(), "gateway-dist-"));
  writeFileSync(
    join(distDir, "gateway.html"),
    "<!doctype html><title>g</title>",
  );
  mkdirSync(join(distDir, "assets"));
  writeFileSync(join(distDir, "assets", "gateway-abc123.js"), "export {};");
  writeFileSync(join(distDir, "clients.json"), "{}");
});

afterEach(async () => {
  vi.useRealTimers();
  Object.assign(issuer.keySet, {
    kids: ["k1"],
    status: 200,
    padding: 0,
    delayMs: 0,
    raw: undefined,
  });
  while (open.length) await open.pop()!.close();
  clock = Date.now();
  logs.length = 0;
});

afterAll(async () => {
  agent.destroy();
  await issuer.close();
  rmSync(distDir, { recursive: true, force: true });
  // AC11 over the whole file: nothing secret in a log line, a refusal body or
  // a redirect back to the gateway.
  for (const secret of issuer.secrets)
    for (const text of exposed)
      assert.ok(!text.includes(secret), `a refusal or redirect leaked a value`);
});

test("AC1/AC4: a first sign-in creates an opaque user; the same subject reaches it again", async () => {
  const gateway = await startUi();
  const login = await request(gateway.web, "/auth/login");
  assert.equal(login.status, 302);
  const provider = new URL(login.headers.location!);
  const p = provider.searchParams;
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.equal(p.get("redirect_uri"), REDIRECT_URI);
  assert.equal(p.get("scope"), "openid email");
  assert.ok(p.get("state") && p.get("nonce") && p.get("code_challenge"));
  assert.match(
    setCookie(login, "__Host-pgw_signin")!,
    /; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/,
  );

  const first = await signIn(gateway);
  assert.equal(first.status, 303);
  assert.equal(first.headers.location, "/");
  assert.match(
    setCookie(first, "__Host-pgw_session")!,
    /^__Host-pgw_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200$/,
  );
  const users = gateway.registry.users();
  assert.equal(users.length, 1);
  const [user] = users;
  assert.match(user!.id, /^u_[A-Za-z0-9_-]{16}$/);
  assert.deepEqual(user!.oidc, { issuer: issuer.url, subject: "subject-1" });
  assert.equal(user!.email, EMAIL);
  assert.deepEqual(await me(gateway, sessionOf(first)), {
    status: 200,
    body: { userId: user!.id, email: EMAIL, label: EMAIL },
  });
  assert.deepEqual(logs.at(-1), `ui sign-in: ok user=${user!.id} (created)`);

  // The same subject with a new email: the same user, its email updated.
  const again = await signIn(gateway, {
    testCase: { claims: (c) => ({ ...c, email: "renamed@example.org" }) },
  });
  assert.equal(again.status, 303);
  assert.equal(gateway.registry.users().length, 1);
  assert.equal(gateway.registry.user(user!.id)!.email, "renamed@example.org");
  assert.equal(gateway.registry.user(user!.id)!.label, "renamed@example.org");
  assert.equal(logs.at(-1), `ui sign-in: ok user=${user!.id} (existing)`);

  // Another subject with the first email: a second user.
  await signIn(gateway, {
    testCase: { claims: (c) => ({ ...c, sub: "subject-2" }) },
  });
  assert.equal(gateway.registry.users().length, 2);
});

test("AC3: only a verified email the rule admits gets a session or a user", async () => {
  const gateway = await startUi({ claims: { hd: "example.org" } });
  const withHd = (c: Claims): Claims => ({ ...c, hd: "example.org" });
  const refusals: [string, (c: Claims) => Claims][] = [
    ["unverified", (c) => withHd({ ...c, email_verified: false })],
    ["verified as a string", (c) => withHd({ ...c, email_verified: "true" })],
    ["verified missing", (c) => withHd({ ...c, email_verified: undefined })],
    ["email missing", (c) => withHd({ ...c, email: undefined })],
    [
      "email not a string",
      (c) => withHd({ ...c, email: ["person@example.org"] }),
    ],
    ["another domain", (c) => withHd({ ...c, email: "person@example.net" })],
    [
      "a suffix of the domain",
      (c) => withHd({ ...c, email: "p@badexample.org" }),
    ],
    ["claim missing", (c) => c],
    ["claim mismatch", (c) => ({ ...c, hd: "example.net" })],
  ];
  for (const [name, claims] of refusals) {
    const answer = await signIn(gateway, { testCase: { claims } });
    assertRefused(answer, "denied");
    assert.equal(gateway.registry.users().length, 0, name);
    assert.equal(logs.at(-1), "ui sign-in: denied", name);
  }
  assert.equal(
    (await signIn(gateway, { testCase: { claims: withHd } })).status,
    303,
  );
  assert.equal(gateway.registry.users().length, 1);
});

test("AC3: an exact address is admitted outside the domains", async () => {
  const gateway = await startUi({
    emailDomains: [],
    emails: ["guest@example.net"],
  });
  assertRefused(await signIn(gateway), "denied");
  const answer = await signIn(gateway, {
    testCase: { claims: (c) => ({ ...c, email: "Guest@Example.net" }) },
  });
  assert.equal(answer.headers.location, "/");
  assert.equal(gateway.registry.users()[0]!.email, "guest@example.net");
});

test("AC8/AC14: a callback not for this browser's sign-in, or a token the library refuses, fails", async () => {
  const gateway = await startUi();
  const now = (): number => Math.floor(clock / 1000);
  const failures: [string, Flow, string, string][] = [
    ["wrong state", { state: "not-the-state" }, "failed", "state"],
    [
      "foreign signin cookie",
      { signinCookie: "someone-else" },
      "failed",
      "state",
    ],
    ["missing signin cookie", { signinCookie: null }, "expired", ""],
    ["pending expired", { waitMs: 11 * MINUTE }, "expired", ""],
    [
      "wrong verifier",
      { testCase: { wrongChallenge: true } },
      "failed",
      "exchange",
    ],
    ["no id_token", { testCase: { noIdToken: true } }, "failed", "claims"],
    [
      "nonce missing",
      { testCase: { claims: (c) => ({ ...c, nonce: undefined }) } },
      "failed",
      "claims",
    ],
    [
      "nonce mismatch",
      { testCase: { claims: (c) => ({ ...c, nonce: "other" }) } },
      "failed",
      "claims",
    ],
    [
      "aud another client",
      { testCase: { claims: (c) => ({ ...c, aud: "other" }) } },
      "failed",
      "claims",
    ],
    [
      "aud array without azp",
      { testCase: { claims: (c) => ({ ...c, aud: [CLIENT_ID, "other"] }) } },
      "failed",
      "claims",
    ],
    [
      "azp another client",
      {
        testCase: {
          claims: (c) => ({ ...c, aud: [CLIENT_ID, "other"], azp: "other" }),
        },
      },
      "failed",
      "claims",
    ],
    [
      "wrong iss",
      { testCase: { claims: (c) => ({ ...c, iss: "http://127.0.0.1:1" }) } },
      "failed",
      "claims",
    ],
    [
      "exp past",
      { testCase: { claims: (c) => ({ ...c, exp: now() - 60 }) } },
      "failed",
      "claims",
    ],
    [
      "iat missing",
      { testCase: { claims: (c) => ({ ...c, iat: undefined }) } },
      "failed",
      "claims",
    ],
    [
      "iat a string",
      { testCase: { claims: (c) => ({ ...c, iat: "now" }) } },
      "failed",
      "claims",
    ],
    [
      "iat 1 h ahead",
      { testCase: { claims: (c) => ({ ...c, iat: now() + 3600 }) } },
      "failed",
      "claims",
    ],
    [
      "sub missing",
      { testCase: { claims: (c) => ({ ...c, sub: undefined }) } },
      "failed",
      "claims",
    ],
  ];
  for (const [name, flow, code, stage] of failures) {
    logs.length = 0;
    const answer = await signIn(gateway, flow);
    assertRefused(answer, code);
    assert.equal(gateway.registry.users().length, 0, name);
    assert.deepEqual(
      logs,
      stage ? [`ui sign-in: failed (${stage})`] : [],
      name,
    );
  }
  // An iat within the 30 s tolerance still signs in.
  const ahead = await signIn(gateway, {
    testCase: { claims: (c) => ({ ...c, iat: now() + 20 }) },
  });
  assert.equal(ahead.headers.location, "/");
});

test("AC8: a state is used once", async () => {
  const gateway = await startUi();
  const login = await request(gateway.web, "/auth/login");
  const provider = new URL(login.headers.location!);
  const cookie = `__Host-pgw_signin=${cookieValue(login, "__Host-pgw_signin")!}`;
  const state = provider.searchParams.get("state")!;
  const first = issuer.authorize(provider);
  const ok = await request(
    gateway.web,
    `/auth/callback?code=${first}&state=${state}`,
    { headers: { cookie } },
  );
  assert.equal(ok.headers.location, "/");
  const second = issuer.authorize(provider);
  assertRefused(
    await request(gateway.web, `/auth/callback?code=${second}&state=${state}`, {
      headers: { cookie },
    }),
    "failed",
  );
});

test("AC8: at most 256 sign-ins wait; expired ones make room", async () => {
  const gateway = await startUi();
  for (let i = 0; i < 256; i++)
    assert.equal((await request(gateway.web, "/auth/login")).status, 302);
  const full = await request(gateway.web, "/auth/login");
  assert.equal(full.status, 303);
  assert.equal(full.headers.location, "/?signin=busy");
  clock += 10 * MINUTE;
  assert.equal((await request(gateway.web, "/auth/login")).status, 302);
});

test("AC14: an ID token whose signature fails is refused", async () => {
  const gateway = await startUi();
  const answer = await signIn(gateway, { testCase: { tamperSignature: true } });
  assertRefused(answer, "failed");
  assert.equal(logs.at(-1), "ui sign-in: failed (signature)");
  assert.equal(gateway.registry.users().length, 0);
  // The flipped byte really breaks the signature (not just base64 padding).
  const token = issuer.idTokens.at(-1)!;
  const [head, body, signature] = token.split(".");
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${head}.${body}`),
      issuer.publicKey,
      Buffer.from(signature!, "base64url"),
    ),
    false,
  );
});

test("AC14: an unknown kid refetches the key set at most once a minute, then refuses", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
  const gateway = await startUi();
  assert.equal((await signIn(gateway)).headers.location, "/");
  const fetched = issuer.keyRequests();
  // The issuer rotates to k2 but does not publish it yet.
  for (let i = 0; i < 3; i++) {
    assertRefused(await signIn(gateway, { testCase: { kid: "k2" } }), "failed");
    assert.equal(logs.at(-1), "ui sign-in: failed (signature)");
  }
  assert.equal(
    issuer.keyRequests(),
    fetched,
    "a fresh key set is not refetched",
  );
  vi.setSystemTime((clock += 61_000));
  assertRefused(await signIn(gateway, { testCase: { kid: "k2" } }), "failed");
  assert.equal(issuer.keyRequests(), fetched + 1, "one refetch, then refused");
  assertRefused(await signIn(gateway, { testCase: { kid: "k2" } }), "failed");
  assert.equal(issuer.keyRequests(), fetched + 1);
  // Once published, a minute later the rotated key signs in.
  issuer.keySet.kids = ["k1", "k2"];
  vi.setSystemTime((clock += 61_000));
  assert.equal(
    (await signIn(gateway, { testCase: { kid: "k2" } })).headers.location,
    "/",
  );
  assert.equal(issuer.keyRequests(), fetched + 2);
  assert.equal(gateway.registry.users().length, 1);
});

test("AC14: an unreadable key set fails the sign-in with no session or user", async () => {
  for (const change of [
    () => (issuer.keySet.status = 500),
    () => (issuer.keySet.padding = 70 * 1024),
  ]) {
    const gateway = await startUi();
    change();
    assertRefused(await signIn(gateway), "failed");
    assert.equal(logs.at(-1), "ui sign-in: failed (keys)");
    assert.equal(gateway.registry.users().length, 0);
    issuer.keySet.status = 200;
    issuer.keySet.padding = 0;
  }
});

test("AC14: concurrent callbacks with an unknown kid share one refetch", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
  const gateway = await startUi();
  assert.equal((await signIn(gateway)).headers.location, "/");
  const fetched = issuer.keyRequests();
  vi.setSystemTime((clock += 61_000));
  const callbacks = await Promise.all(
    Array.from({ length: 8 }, () =>
      startSignIn(gateway, { testCase: { kid: "k2" } }),
    ),
  );
  issuer.keySet.delayMs = 500;
  logs.length = 0;
  const answers = await Promise.all(callbacks.map((callback) => callback()));
  for (const answer of answers) assertRefused(answer, "failed");
  assert.deepEqual(logs, Array(8).fill("ui sign-in: failed (signature)"));
  assert.equal(issuer.keyRequests(), fetched + 1, "exactly one refetch");
});

test("AC14: callbacks during a failing key fetch all fail as keys after one fetch; the failure starts the wait", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
  const gateway = await startUi();
  const callbacks = await Promise.all(
    Array.from({ length: 8 }, () => startSignIn(gateway)),
  );
  Object.assign(issuer.keySet, { status: 500, delayMs: 500 });
  const before = issuer.keyRequests();
  logs.length = 0;
  const answers = await Promise.all(callbacks.map((callback) => callback()));
  for (const answer of answers) assertRefused(answer, "failed");
  assert.deepEqual(logs, Array(8).fill("ui sign-in: failed (keys)"));
  const fetched = issuer.keyRequests();
  assert.equal(fetched, before + 1, "exactly one fetch");
  assert.equal(gateway.registry.users().length, 0);
  // Within the minute after the failed fetch: no fetch, fails as keys.
  Object.assign(issuer.keySet, { status: 200, delayMs: 0 });
  assertRefused(await signIn(gateway), "failed");
  assert.equal(logs.at(-1), "ui sign-in: failed (keys)");
  assert.equal(issuer.keyRequests(), fetched);
  vi.setSystemTime((clock += 61_000));
  assert.equal((await signIn(gateway)).headers.location, "/");
  assert.equal(issuer.keyRequests(), fetched + 1);
});

test("C3: a malformed 200 key set never replaces the last good one", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
  const gateway = await startUi();
  assert.equal((await signIn(gateway)).headers.location, "/");
  let fetched = issuer.keyRequests();
  for (const raw of [
    { type: "text/html", body: "<html>maintenance</html>" },
    { type: "application/json", body: "{not json" },
    { type: "application/json", body: '{"keys":"none"}' },
    { type: "application/json", body: '{"keys":[1]}' },
  ]) {
    vi.setSystemTime((clock += 61_000));
    issuer.keySet.raw = raw;
    // An unknown kid asks for a newer set, which comes back malformed.
    assertRefused(await signIn(gateway, { testCase: { kid: "k2" } }), "failed");
    assert.equal(logs.at(-1), "ui sign-in: failed (signature)", raw.body);
    assert.equal(issuer.keyRequests(), ++fetched, raw.body);
    // The known key still signs in, from the kept set, without a fetch.
    assert.equal((await signIn(gateway)).headers.location, "/", raw.body);
    assert.equal(issuer.keyRequests(), fetched, raw.body);
  }
  issuer.keySet.raw = undefined;
  issuer.keySet.kids = ["k1", "k2"];
  vi.setSystemTime((clock += 61_000));
  assert.equal(
    (await signIn(gateway, { testCase: { kid: "k2" } })).headers.location,
    "/",
  );
  assert.equal(issuer.keyRequests(), fetched + 1);
});

test("C3: a rotated key is found within a minute of the last fetch, not two", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
  const gateway = await startUi();
  assert.equal((await signIn(gateway)).headers.location, "/");
  vi.setSystemTime((clock += 61_000));
  // A refresh that still lacks k2.
  assertRefused(await signIn(gateway, { testCase: { kid: "k2" } }), "failed");
  const fetched = issuer.keyRequests();
  // k2 is published 30 s later; within the wait the kept set answers.
  issuer.keySet.kids = ["k1", "k2"];
  vi.setSystemTime((clock += 30_000));
  assertRefused(await signIn(gateway, { testCase: { kid: "k2" } }), "failed");
  assert.equal(issuer.keyRequests(), fetched);
  // Once the minute since the last fetch is over, the next k2 sign-in fetches.
  vi.setSystemTime((clock += 31_000));
  assert.equal(
    (await signIn(gateway, { testCase: { kid: "k2" } })).headers.location,
    "/",
  );
  assert.equal(issuer.keyRequests(), fetched + 1);
});

/** A provider served by a fetch stub, with production (https-only) options. */
function stubProvider(document: Record<string, unknown>): OidcTestOptions {
  return {
    fetch: async (url) => {
      if (url === "https://issuer.test/.well-known/openid-configuration")
        return new Response(JSON.stringify(document), {
          headers: { "content-type": "application/json" },
        });
      return new Response("{}", { status: 404 });
    },
  };
}

test("C1: discovery refuses an endpoint that is not https, or another issuer", async () => {
  const usable = {
    issuer: "https://issuer.test",
    authorization_endpoint: "https://issuer.test/authorize",
    token_endpoint: "https://issuer.test/token",
    jwks_uri: "https://issuer.test/jwks",
  };
  const ok = await startUi(
    {},
    { issuer: "https://issuer.test", oidcTestOptions: stubProvider(usable) },
  );
  const login = await request(ok.web, "/auth/login");
  assert.equal(login.status, 302);
  assert.match(login.headers.location!, /^https:\/\/issuer\.test\/authorize\?/);
  for (const [name, document] of [
    [
      "http authorization",
      { ...usable, authorization_endpoint: "http://issuer.test/authorize" },
    ],
    [
      "script authorization",
      { ...usable, authorization_endpoint: "javascript:alert(1)" },
    ],
    [
      "ftp authorization",
      { ...usable, authorization_endpoint: "ftp://issuer.test/authorize" },
    ],
    ["no authorization", { ...usable, authorization_endpoint: undefined }],
    ["http token", { ...usable, token_endpoint: "http://issuer.test/token" }],
    ["http keys", { ...usable, jwks_uri: "http://issuer.test/jwks" }],
    ["issuer with a slash", { ...usable, issuer: "https://issuer.test/" }],
  ] as const) {
    logs.length = 0;
    const gateway = await startUi(
      {},
      {
        issuer: "https://issuer.test",
        oidcTestOptions: stubProvider(document),
      },
    );
    const answer = await request(gateway.web, "/auth/login");
    assert.equal(answer.status, 303, name);
    assert.equal(answer.headers.location, "/?signin=failed", name);
    assert.equal(cookieValue(answer, "__Host-pgw_signin"), "", name);
    assert.deepEqual(logs.slice(-1), ["ui sign-in: failed (discovery)"], name);
  }
  // Tests may use http, never another scheme.
  const script = await startUi(
    {},
    {
      issuer: "https://issuer.test",
      oidcTestOptions: {
        ...stubProvider({
          ...usable,
          authorization_endpoint: "javascript:alert(1)",
        }),
        allowInsecureRequests: true,
      },
    },
  );
  assert.equal(
    (await request(script.web, "/auth/login")).headers.location,
    "/?signin=failed",
  );
});

test("AC5: a claim binds an existing user once, only on an admitted verified sign-in", async () => {
  const gateway = await startUi();
  const { registry } = gateway;
  registry.addUser("thasso");
  registry.addUser("other");
  registry.claimUser("thasso", "Person@Example.org", 60 * MINUTE);

  // An unverified sign-in with that email binds nothing and keeps the claim.
  assertRefused(
    await signIn(gateway, {
      testCase: { claims: (c) => ({ ...c, email_verified: false }) },
    }),
    "denied",
  );
  assert.equal(registry.user("thasso")!.oidc, undefined);

  const bound = await signIn(gateway);
  assert.equal(bound.headers.location, "/");
  assert.deepEqual(registry.user("thasso")!.oidc, {
    issuer: issuer.url,
    subject: "subject-1",
  });
  assert.equal(logs.at(-1), "ui sign-in: ok user=thasso (bound)");
  assert.equal((await me(gateway, sessionOf(bound))).body.userId, "thasso");

  // Used up: another identity with the same email becomes a new user.
  await signIn(gateway, {
    testCase: { claims: (c) => ({ ...c, sub: "subject-2" }) },
  });
  assert.equal(registry.users().length, 3);
  assert.throws(
    () => registry.claimUser("thasso", EMAIL, MINUTE),
    /already signs in/,
  );

  // An expired claim binds nothing.
  registry.claimUser("other", "late@example.org", MINUTE);
  clock += 2 * MINUTE;
  await signIn(gateway, {
    testCase: {
      claims: (c) => ({ ...c, sub: "subject-3", email: "late@example.org" }),
    },
  });
  assert.equal(registry.user("other")!.oidc, undefined);
  assert.equal(logs.at(-1)?.endsWith("(created)"), true);
});

test("AC5: a claim on a user that got an identity meanwhile does not bind", async () => {
  const gateway = await startUi();
  const { registry } = gateway;
  registry.addUser("thasso");
  registry.claimUser("thasso", "first@example.org", 60 * MINUTE);
  registry.claimUser("thasso", EMAIL, 60 * MINUTE);
  // The second claim replaced the first.
  await signIn(gateway, {
    testCase: { claims: (c) => ({ ...c, email: "first@example.org" }) },
  });
  assert.equal(registry.user("thasso")!.oidc, undefined);
  await signIn(gateway, {
    testCase: { claims: (c) => ({ ...c, sub: "subject-2" }) },
  });
  assert.equal(registry.user("thasso")!.oidc?.subject, "subject-2");
});

test("AC6/AC7: sign-out needs the Origin and header, and ends the session server-side", async () => {
  const gateway = await startUi();
  const session = sessionOf(await signIn(gateway));
  for (const headers of [
    { "x-gateway-ui": "1" },
    { origin: "https://evil.test", "x-gateway-ui": "1" },
    { origin: PUBLIC_ORIGIN },
    { origin: PUBLIC_ORIGIN, "x-gateway-ui": "true" },
  ]) {
    const refused = await logout(gateway, session, headers);
    assert.equal(refused.status, 403);
    assert.deepEqual(JSON.parse(refused.body), { error: "forbidden" });
    assert.equal((await me(gateway, session)).status, 200);
  }
  const userId = gateway.registry.users()[0]!.id;
  const out = await logout(gateway, session);
  assert.equal(out.status, 204);
  assert.match(setCookie(out, "__Host-pgw_session")!, /Max-Age=0/);
  assert.equal(logs.at(-1), `ui sign-out: user=${userId}`);
  assert.deepEqual(await me(gateway, session), {
    status: 401,
    body: { error: "signed_out" },
  });
});

test("AC6: sessions end after 2 h idle or 12 h in all", async () => {
  const gateway = await startUi();
  const idle = sessionOf(await signIn(gateway));
  const active = sessionOf(await signIn(gateway));
  clock += 2 * 60 * MINUTE - MINUTE;
  assert.equal((await me(gateway, active)).status, 200);
  clock += 2 * MINUTE;
  assert.equal((await me(gateway, idle)).status, 401);
  // Kept active every hour, it still ends 12 h after sign-in.
  for (let hour = 1; hour <= 10; hour++) {
    clock += 60 * MINUTE - 2 * MINUTE;
    assert.equal((await me(gateway, active)).status, 200, `hour ${hour}`);
  }
  clock += 30 * MINUTE;
  assert.equal((await me(gateway, active)).status, 401);
});

test("AC6: a user's 17th session drops the first; the table holds 1,024 in all", async () => {
  const gateway = await startUi();
  const first = sessionOf(await signIn(gateway));
  for (let i = 0; i < 15; i++) await signIn(gateway);
  assert.equal((await me(gateway, first)).status, 200);
  await signIn(gateway);
  assert.equal((await me(gateway, first)).status, 401);

  // 64 users with 16 sessions each fill the table.
  for (let user = 1; user < 64; user++)
    for (let i = 0; i < 16; i++)
      await signIn(gateway, {
        testCase: { claims: (c) => ({ ...c, sub: `filler-${user}` }) },
      });
  const users = gateway.registry.users().length;
  const busy = await signIn(gateway, {
    testCase: { claims: (c) => ({ ...c, sub: "one-too-many" }) },
  });
  assertRefused(busy, "busy");
  assert.equal(gateway.registry.users().length, users, "no user was created");
  clock += 2 * 60 * MINUTE;
  const later = await signIn(gateway, {
    testCase: { claims: (c) => ({ ...c, sub: "one-too-many" }) },
  });
  assert.equal(later.headers.location, "/");
}, 120_000);

test("the user comes only from the session, never from the request", async () => {
  const gateway = await startUi();
  const mine = sessionOf(await signIn(gateway));
  await signIn(gateway, { testCase: { claims: (c) => ({ ...c, sub: "s2" }) } });
  const [own, other] = gateway.registry.users();
  const asked = [`/api/me?userId=${other!.id}`, `/api/me?user=${other!.id}`];
  for (const path of asked) {
    assert.equal((await me(gateway, mine, path)).body.userId, own!.id);
    assert.equal((await me(gateway, undefined, path)).status, 401);
  }
  const viaHeader = await request(gateway.web, "/api/me", {
    headers: { cookie: mine, "x-user-id": other!.id },
  });
  assert.equal(JSON.parse(viaHeader.body).userId, own!.id);
  const viaBody = await request(gateway.web, "/api/me", {
    headers: { cookie: mine, "content-type": "application/json" },
    body: JSON.stringify({ userId: other!.id }),
  });
  assert.equal(JSON.parse(viaBody.body).userId, own!.id);
  const noSession = await request(gateway.web, "/api/me", {
    headers: { "x-user-id": other!.id },
  });
  assert.equal(noSession.status, 401);
});

test("/api/me answers 503 when the registry fails", async () => {
  const gateway = await startUi();
  const session = sessionOf(await signIn(gateway));
  gateway.registry.user = () => {
    throw new Error("registry down");
  };
  assert.deepEqual(await me(gateway, session), {
    status: 503,
    body: { error: "unavailable" },
  });
});

test("AC11: a provider error is never echoed, and logs hold no secret or email", async () => {
  const gateway = await startUi();
  const login = await request(gateway.web, "/auth/login");
  const provider = new URL(login.headers.location!);
  const declined = await request(
    gateway.web,
    `/auth/callback?error=access_denied&error_description=provider-detail-must-not-leak&state=${provider.searchParams.get("state")}`,
    {
      headers: {
        cookie: `__Host-pgw_signin=${cookieValue(login, "__Host-pgw_signin")!}`,
      },
    },
  );
  assertRefused(declined, "failed");
  await signIn(gateway, { testCase: { wrongChallenge: true } });
  await signIn(gateway);
  for (const line of logs) {
    assert.ok(!line.includes("provider-detail"), line);
    assert.ok(!line.includes("@"), line);
    for (const secret of issuer.secrets)
      assert.ok(!line.includes(secret), line);
  }
  for (const text of exposed) assert.ok(!text.includes("provider-detail"));
});

test("AC10: only the page and its enumerated assets are served, with the security headers", async () => {
  const gateway = await startUi();
  const page = await request(gateway.web, "/");
  assert.equal(page.status, 200);
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(page.headers["cache-control"], "no-cache");
  assert.equal(
    page.headers["content-security-policy"],
    "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  const asset = await request(gateway.web, "/assets/gateway-abc123.js");
  assert.equal(asset.status, 200);
  assert.equal(asset.body, "export {};");
  assert.match(asset.headers["cache-control"]!, /immutable/);
  for (const path of [
    "/assets/../clients.json",
    "/%2e%2e/clients.json",
    "/assets/%2e%2e/clients.json",
    "/clients.json",
    "/gateway.html",
    "/assets/",
    "/index.html",
  ])
    assert.equal((await request(gateway.web, path)).status, 404, path);
  const api = await request(gateway.web, "/api/me");
  assert.equal(api.headers["cache-control"], "no-store");
  assert.equal(api.headers["content-security-policy"] !== undefined, true);
  const post = await request(gateway.web, "/", {
    method: "POST",
    headers: { origin: PUBLIC_ORIGIN, "x-gateway-ui": "1" },
  });
  assert.equal(post.status, 404);
  const large = await request(gateway.web, "/auth/logout", {
    method: "POST",
    headers: { origin: PUBLIC_ORIGIN, "x-gateway-ui": "1" },
    body: "x".repeat(2_048),
  });
  assert.equal(large.status, 413);
});

test("AC9: the listener serves only TLS with the configured certificate", async () => {
  const gateway = await startUi();
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = https.request(
        { host: "127.0.0.1", port: gateway.web.port, path: "/", agent: false },
        resolve,
      );
      req.on("error", reject);
      req.end();
    }),
    /self-signed|unable to verify|certificate/i,
  );
});
