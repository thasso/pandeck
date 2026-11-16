/**
 * Approval enrollment end to end on a started edge (Task-1410): a relay opens
 * a request at the enrollment port, the signed-in user looks it up and
 * approves (or denies) it through the gateway page's API, the relay collects
 * its certificate and keeps key, certificate, CA, ports and its own MCP token
 * 0600; `relay run` then reaches the edge with that identity and the token
 * opens `/mcp`. The typed-code path gets its token the same way. Every value
 * is fake and stays in this process.
 */
import assert from "node:assert/strict";
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { decodeGatewayUiEnrollmentRequest } from "@assistant/shared/gatewayUi";
import { DATA_DIR } from "./config.ts";
import type { EdgeTools } from "./gateway/edgeTools.ts";
import { edgeTlsFor } from "./gateway/x509.ts";
import { startEdge } from "./gatewayEdge.ts";
import {
  ApprovalEnrollmentError,
  enrollRelay,
  enrollRelayByApproval,
  startRelay,
  type ApprovalPrompt,
  type EnrollClock,
} from "./relay/relay.ts";
import {
  CLIENT_ID,
  CLIENT_PW,
  PUBLIC_ORIGIN,
  startFakeIssuer,
} from "./test/gatewayUiIssuer.ts";

const EDGE_ISSUER = "https://issuer.test";
const uiTls = edgeTlsFor(["localhost", "127.0.0.1"], undefined);
const agent = new https.Agent({ ca: uiTls.caCertPem, keepAlive: true });
const relayRoot = mkdtempSync(join(tmpdir(), "enroll-approval-"));
let distDir: string;
const logs: string[] = [];
const open: { close(): unknown }[] = [];
/** Values that may reach no log line. */
const secrets: string[] = [];

beforeAll(() => {
  distDir = mkdtempSync(join(tmpdir(), "gateway-dist-"));
  writeFileSync(
    join(distDir, "gateway.html"),
    "<!doctype html><title>g</title>",
  );
});

afterEach(async () => {
  while (open.length) await open.pop()!.close();
  vi.restoreAllMocks();
});

afterAll(() => {
  agent.destroy();
  rmSync(distDir, { recursive: true, force: true });
  rmSync(relayRoot, { recursive: true, force: true });
  for (const secret of secrets)
    for (const line of logs)
      assert.ok(!line.includes(secret), "a log line holds a secret");
});

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
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
        port,
        path,
        method: options.method ?? "GET",
        agent,
        headers: {
          ...options.headers,
          ...(options.body === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(options.body)) }),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

function cookieValue(answer: Answer, name: string): string | undefined {
  for (const line of answer.headers["set-cookie"] ?? [])
    if (line.startsWith(`${name}=`))
      return line.slice(name.length + 1).split(";")[0];
  return undefined;
}

/** Tools whose `/mcp` answers 200 once the edge's gate let the call in. */
const TOOLS: EdgeTools = {
  handleMcp: (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("mcp-ok");
  },
  host: { list: () => [], call: () => Promise.reject(new Error("unused")) },
  integrations: {
    atlassian: {
      parse: () => ({ ok: false }),
      check: () => Promise.resolve({ ok: false, problem: "rejected" }),
      describe: () => undefined,
    },
  },
};

async function edgeWithUi() {
  const issuer = await startFakeIssuer({
    advertised: EDGE_ISSUER,
    now: () => Date.now(),
  });
  open.push({ close: () => issuer.close() });
  mkdirSync(DATA_DIR, { recursive: true });
  const dir = mkdtempSync(join(DATA_DIR, "gateway-enroll-"));
  writeFileSync(join(dir, "cert.pem"), uiTls.serverCertPem);
  writeFileSync(join(dir, "key.pem"), uiTls.serverKeyPem, { mode: 0o600 });
  const uiConfig = join(dir, "ui.json");
  writeFileSync(
    uiConfig,
    JSON.stringify({
      port: 0,
      publicOrigin: PUBLIC_ORIGIN,
      certFile: join(dir, "cert.pem"),
      keyFile: join(dir, "key.pem"),
      distDir,
      oidc: {
        issuer: EDGE_ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_PW,
      },
      allow: { emailDomains: ["example.org"] },
    }),
    { mode: 0o600 },
  );
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  const stateDir = join(dir, "state");
  const edge = await startEdge(
    {
      stateDir,
      port: 0,
      modelPort: 0,
      clientPort: 0,
      enrollPort: 0,
      uiConfig,
    },
    {
      log: (line) => logs.push(line),
      oidcTestOptions: {
        fetch: (url, init) =>
          fetch(url.replace(EDGE_ISSUER, issuer.listening), init),
      },
      tools: TOOLS,
    },
  );
  open.push(edge);
  const uiPort = edge.uiPort!;
  const listener = edge.gateway.clients!;

  const signIn = async (sub: string): Promise<string> => {
    const login = await request(uiPort, "/auth/login");
    const provider = new URL(login.headers.location!);
    const code = issuer.authorize(provider, {
      claims: (claims) => ({ ...claims, sub }),
    });
    const answer = await request(
      uiPort,
      `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(provider.searchParams.get("state")!)}`,
      {
        headers: {
          cookie: `__Host-pgw_signin=${cookieValue(login, "__Host-pgw_signin")}`,
        },
      },
    );
    const session = cookieValue(answer, "__Host-pgw_session");
    assert.ok(session);
    secrets.push(session);
    return `__Host-pgw_session=${session}`;
  };
  const post = (cookie: string, path: string, body: unknown) =>
    request(uiPort, path, {
      method: "POST",
      headers: {
        cookie,
        origin: PUBLIC_ORIGIN,
        "x-gateway-ui": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const get = (cookie: string, path: string) =>
    request(uiPort, path, { headers: { cookie } });
  return {
    stateDir,
    get,
    registry: listener.registry,
    signIn,
    post,
    target: {
      host: "127.0.0.1",
      enrollPort: listener.enrollPort,
      caPem: listener.caPem,
    },
  };
}

/** Polls wait until the page decided, so the first poll collects. */
function afterDecision(): {
  clock: EnrollClock;
  decided: (decision: Promise<void>) => void;
} {
  let decision: Promise<void> = Promise.resolve();
  return {
    clock: {
      now: () => Date.now(),
      sleep: async (_ms, signal) => {
        signal?.throwIfAborted();
        await decision;
      },
    },
    decided: (next) => {
      decision = next;
    },
  };
}

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** A POST to the relay's `/mcp`, as an agent on the machine sends it. */
function mcp(url: string, token: string | undefined): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${url}/mcp`,
      {
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

/** The relay's files, each 0600, and what they say. */
function relayState(stateDir: string) {
  assert.deepEqual(readdirSync(stateDir).sort(), [
    "client-cert.pem",
    "client-key.pem",
    "edge.json",
    "gateway-ca.pem",
    "mcp-token",
  ]);
  for (const name of readdirSync(stateDir))
    assert.equal(statSync(join(stateDir, name)).mode & 0o777, 0o600, name);
  const token = readFileSync(join(stateDir, "mcp-token"), "utf8").trim();
  secrets.push(token, sha256(token));
  return {
    token,
    key: readFileSync(join(stateDir, "client-key.pem"), "utf8"),
    cert: readFileSync(join(stateDir, "client-cert.pem"), "utf8"),
  };
}

test("approve in the page: the relay collects a certificate for its key, runs, and its own token opens /mcp", async () => {
  const edge = await edgeWithUi();
  const cookie = await edge.signIn("subject-a");
  const { clock, decided } = afterDecision();
  const prompts: ApprovalPrompt[] = [];
  const lookups: unknown[] = [];
  const stateDir = join(relayRoot, "approved");
  const clientId = await enrollRelayByApproval({
    ...edge.target,
    stateDir,
    name: "devbox-7",
    kind: "devbox",
    clock,
    onPrompt: (prompt) => {
      prompts.push(prompt);
      secrets.push(prompt.userCode, prompt.userCode.replace("-", ""));
      decided(
        (async () => {
          const found = await edge.post(cookie, "/api/enrollments/lookup", {
            userCode: prompt.userCode,
          });
          assert.equal(found.status, 200);
          lookups.push(JSON.parse(found.body));
          const approved = await edge.post(cookie, "/api/enrollments/decide", {
            userCode: prompt.userCode,
            approve: true,
          });
          assert.equal(approved.status, 204);
        })(),
      );
    },
  });

  // The link points at the page with the code in its fragment only.
  const [prompt] = prompts;
  assert.match(
    prompt!.userCode,
    /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
  );
  assert.equal(
    prompt!.verificationUri,
    `${PUBLIC_ORIGIN}/#enroll=${prompt!.userCode}`,
  );
  assert.equal(new URL(prompt!.verificationUri).search, "");
  assert.equal(prompt!.expiresInSeconds, 600);
  // The page saw the machine's claims, the source and the times.
  const shown = decodeGatewayUiEnrollmentRequest(lookups[0]);
  assert.ok(shown);
  assert.equal(shown.name, "devbox-7");
  assert.equal(shown.kind, "devbox");
  assert.match(shown.from, /127\.0\.0\.1/);
  assert.equal(shown.expiresAt - shown.createdAt, 600_000);

  // Key, certificate and token stay on the machine, 0600; the certificate
  // is for this key and this client, and the gateway holds the token's hash.
  const files = relayState(stateDir);
  const certificate = new X509Certificate(files.cert);
  assert.ok(certificate.checkPrivateKey(createPrivateKey(files.key)));
  assert.match(certificate.subject, new RegExp(clientId));
  const client = edge.registry.clients().find((c) => c.id === clientId);
  assert.ok(client);
  assert.equal(client.label, "devbox-7");
  assert.equal(client.mcpTokenHash, sha256(files.token));
  const stored = readFileSync(join(edge.stateDir, "clients.json"), "utf8");
  assert.ok(!stored.includes(files.token), "no token in state");
  assert.ok(
    !stored.includes(prompt!.userCode.replace("-", "")),
    "no code in state",
  );

  // The page lists the machine, with a token.
  const listed = await edge.get(cookie, "/api/clients");
  assert.deepEqual(JSON.parse(listed.body), {
    clients: [
      {
        id: clientId,
        label: "devbox-7",
        createdAt: client.createdAt,
        mcpToken: true,
      },
    ],
  });

  // `relay run` reaches the edge with this identity; the token opens /mcp.
  const relay = await startRelay({
    stateDir,
    port: 0,
    socketPath: join(relayRoot, "approved.sock"),
    log: (line) => logs.push(line),
  });
  open.push(relay);
  const allowed = await mcp(relay.url, files.token);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body, "mcp-ok");
  assert.equal((await mcp(relay.url, undefined)).status, 401);
  assert.equal((await mcp(relay.url, `pgmcp_${"A".repeat(43)}`)).status, 401);
});

test("deny in the page: the relay stops with `denied` and writes nothing; the code is then unknown", async () => {
  const edge = await edgeWithUi();
  const cookie = await edge.signIn("subject-a");
  const { clock, decided } = afterDecision();
  const stateDir = join(relayRoot, "denied");
  let code = "";
  await assert.rejects(
    enrollRelayByApproval({
      ...edge.target,
      stateDir,
      name: "stranger",
      clock,
      onPrompt: (prompt) => {
        code = prompt.userCode;
        secrets.push(code);
        decided(
          edge
            .post(cookie, "/api/enrollments/decide", {
              userCode: code,
              approve: false,
            })
            .then((answer) => assert.equal(answer.status, 204)),
        );
      },
    }),
    (err) => err instanceof ApprovalEnrollmentError && err.reason === "denied",
  );
  assert.ok(!existsSync(stateDir));
  assert.equal(edge.registry.clients().length, 0);
  const again = await edge.post(cookie, "/api/enrollments/decide", {
    userCode: code,
    approve: true,
  });
  assert.equal(again.status, 404);
  assert.deepEqual(JSON.parse(again.body), { error: "unknown_request" });
});

test("typed code: the relay sends its token's hash with the code; the token opens /mcp", async () => {
  const edge = await edgeWithUi();
  const cookie = await edge.signIn("subject-a");
  const coded = await edge.post(cookie, "/api/clients/code", {
    label: "laptop",
  });
  assert.equal(coded.status, 200);
  const { code } = JSON.parse(coded.body) as { code: string };
  secrets.push(code);
  const stateDir = join(relayRoot, "typed");
  const clientId = await enrollRelay({ ...edge.target, stateDir, code });
  const files = relayState(stateDir);
  assert.equal(
    edge.registry.clients().find((c) => c.id === clientId)?.mcpTokenHash,
    sha256(files.token),
  );
  const relay = await startRelay({
    stateDir,
    port: 0,
    socketPath: join(relayRoot, "typed.sock"),
    log: (line) => logs.push(line),
  });
  open.push(relay);
  assert.equal((await mcp(relay.url, files.token)).status, 200);
});
