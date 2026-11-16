/**
 * The relay's enrollment against a fake enrollment port (Task-1410): the MCP
 * token made on the machine and sent only as its hash on both paths, the
 * approval poll's timing (interval, `slow_down`, 503 and network backoff, the
 * 15 s request deadline, the request's expiry plus 30 s, cancel) and that no
 * file is written before a 200. Every value is fake; nothing is printed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test } from "vitest";
import { edgeTlsFor } from "../gateway/x509.ts";
import {
  ApprovalEnrollmentError,
  enrollRelay,
  enrollRelayByApproval,
  type ApprovalPrompt,
  type EnrollClock,
} from "./relay.ts";

const edgeTls = edgeTlsFor(["127.0.0.1"], undefined);
const root = mkdtempSync(join(tmpdir(), "relay-enroll-"));
const open: { close(): unknown }[] = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const FAKE_REQUEST_ID = "fake-request-id-0000000000000000000000000000";
const FAKE_USER_CODE = "BCDF-GHJK";
const CERT = "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n";
const ENROLLED = {
  clientId: "c_fake",
  certificatePem: CERT,
  caPem: edgeTls.caCertPem,
  modelPort: 4101,
  clientPort: 4102,
};
const STARTED = {
  requestId: FAKE_REQUEST_ID,
  userCode: FAKE_USER_CODE,
  verificationUri: `https://gateway.test/#enroll=${FAKE_USER_CODE}`,
  expiresInSeconds: 600,
  intervalSeconds: 5,
};

/** How the fake port answers one request. */
type Reply =
  { status: number; body?: unknown; retryAfter?: number } | "stall" | "drop";

interface FakePort {
  port: number;
  /** Every request's path and parsed body, in order. */
  seen: { path: string; body: Record<string, unknown> }[];
  /** Resolves once the port has received `count` polls. */
  polled(count: number): Promise<void>;
}

/** The enrollment port: `/enroll/start`, then `polls` in order (the last repeats). */
async function fakePort(
  polls: Reply[],
  start: Reply = { status: 200, body: STARTED },
  enroll: Reply = { status: 200, body: ENROLLED },
): Promise<FakePort> {
  const seen: FakePort["seen"] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  let pollCount = 0;
  const stalled: http.ServerResponse[] = [];
  const server = https.createServer(
    { key: edgeTls.serverKeyPem, cert: edgeTls.serverCertPem },
    (req, res) => {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (raw += chunk));
      req.on("end", () => {
        const path = req.url ?? "";
        seen.push({ path, body: JSON.parse(raw) as Record<string, unknown> });
        let reply: Reply;
        if (path === "/enroll/start") reply = start;
        else if (path === "/enroll") reply = enroll;
        else {
          reply = polls[Math.min(pollCount, polls.length - 1)]!;
          pollCount++;
          for (const waiter of waiters.splice(0))
            if (pollCount >= waiter.count) waiter.resolve();
            else waiters.push(waiter);
        }
        if (reply === "stall") return void stalled.push(res);
        if (reply === "drop") return void req.socket.destroy();
        res.writeHead(reply.status, {
          "content-type": "application/json",
          ...(reply.retryAfter
            ? { "retry-after": String(reply.retryAfter) }
            : {}),
        });
        res.end(JSON.stringify(reply.body ?? {}));
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push({
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of stalled) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return {
    port: (server.address() as { port: number }).port,
    seen,
    polled: (count) =>
      pollCount >= count
        ? Promise.resolve()
        : new Promise((resolve) => waiters.push({ count, resolve })),
  };
}

/** A virtual clock: each sleep is recorded and moves time at once. */
function virtualClock(): EnrollClock & { sleeps: number[] } {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: (ms, signal) => {
      signal?.throwIfAborted();
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function approval(
  port: number,
  extra: Partial<Parameters<typeof enrollRelayByApproval>[0]> = {},
) {
  const stateDir = join(mkdtempSync(join(root, "s-")), "state");
  const prompts: ApprovalPrompt[] = [];
  const clock = virtualClock();
  const run = enrollRelayByApproval({
    stateDir,
    host: "127.0.0.1",
    enrollPort: port,
    caPem: edgeTls.caCertPem,
    name: "devbox-7",
    kind: "devbox",
    onPrompt: (prompt) => prompts.push(prompt),
    clock,
    ...extra,
  });
  return { stateDir, prompts, clock, run };
}

/** The relay's state files, each 0600; the token matches the sent hash. */
function assertEnrolled(stateDir: string, sentHash: unknown): string {
  assert.deepEqual(readdirSync(stateDir).sort(), [
    "client-cert.pem",
    "client-key.pem",
    "edge.json",
    "gateway-ca.pem",
    "mcp-token",
  ]);
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);
  for (const name of readdirSync(stateDir))
    assert.equal(statSync(join(stateDir, name)).mode & 0o777, 0o600, name);
  const token = readFileSync(join(stateDir, "mcp-token"), "utf8").trim();
  assert.match(token, /^pgmcp_[A-Za-z0-9_-]{43}$/);
  assert.equal(sha256(token), sentHash);
  assert.equal(readFileSync(join(stateDir, "client-cert.pem"), "utf8"), CERT);
  assert.deepEqual(
    JSON.parse(readFileSync(join(stateDir, "edge.json"), "utf8")),
    {
      host: "127.0.0.1",
      clientId: "c_fake",
      modelPort: 4101,
      clientPort: 4102,
    },
  );
  return token;
}

/** No request body held the token; only its hash went out. */
function assertTokenStayed(port: FakePort, token: string): void {
  for (const { body } of port.seen)
    assert.ok(!JSON.stringify(body).includes(token), "a body held the token");
}

test("approval: start sends key, hash, name and kind; prompt once; polls at the interval; files after the 200", async () => {
  const port = await fakePort([
    { status: 202, body: { status: "pending" } },
    { status: 202, body: { status: "pending" } },
    { status: 200, body: ENROLLED },
  ]);
  const { stateDir, prompts, clock, run } = approval(port.port);
  assert.equal(await run, "c_fake");
  assert.deepEqual(prompts, [
    {
      verificationUri: STARTED.verificationUri,
      userCode: FAKE_USER_CODE,
      expiresInSeconds: 600,
    },
  ]);
  const [start, ...polls] = port.seen;
  assert.equal(start!.path, "/enroll/start");
  assert.deepEqual(Object.keys(start!.body).sort(), [
    "kind",
    "mcpTokenHash",
    "name",
    "publicKeyPem",
  ]);
  assert.equal(start!.body.name, "devbox-7");
  assert.equal(start!.body.kind, "devbox");
  assert.match(String(start!.body.publicKeyPem), /BEGIN PUBLIC KEY/);
  assert.deepEqual(
    polls.map((poll) => [poll.path, poll.body]),
    Array(3).fill(["/enroll/poll", { requestId: FAKE_REQUEST_ID }]),
  );
  assert.deepEqual(clock.sleeps, [5_000, 5_000, 5_000]);
  const token = assertEnrolled(stateDir, start!.body.mcpTokenHash);
  assertTokenStayed(port, token);
});

test("approval: each 429 slow_down adds 5 s to the interval, kept after", async () => {
  const port = await fakePort([
    { status: 429, body: { error: "slow_down" }, retryAfter: 5 },
    { status: 429, body: { error: "slow_down" }, retryAfter: 5 },
    { status: 202, body: { status: "pending" } },
    { status: 200, body: ENROLLED },
  ]);
  const { clock, run, stateDir } = approval(port.port);
  assert.equal(await run, "c_fake");
  assert.deepEqual(clock.sleeps, [5_000, 10_000, 15_000, 15_000]);
  assertEnrolled(stateDir, port.seen[0]!.body.mcpTokenHash);
});

test("approval: a 429 with a longer retry-after waits that long", async () => {
  const port = await fakePort([
    { status: 429, body: { error: "too many" }, retryAfter: 60 },
    { status: 200, body: ENROLLED },
  ]);
  const { clock, run } = approval(port.port);
  await run;
  assert.deepEqual(clock.sleeps, [5_000, 60_000]);
});

test("approval: 503s and dropped connections back off 5 s doubling to 60 s, reset by an answer", async () => {
  const port = await fakePort([
    { status: 503, body: { error: "client registry unavailable" } },
    "drop",
    { status: 503 },
    "drop",
    { status: 503 },
    { status: 503 },
    { status: 202, body: { status: "pending" } },
    { status: 503 },
    { status: 200, body: ENROLLED },
  ]);
  const { clock, run, stateDir } = approval(port.port);
  assert.equal(await run, "c_fake");
  assert.deepEqual(
    clock.sleeps,
    [5_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 5_000, 5_000],
  );
  assertEnrolled(stateDir, port.seen[0]!.body.mcpTokenHash);
});

test("approval: a stalled poll times out at the request deadline and is retried after the backoff", async () => {
  const port = await fakePort(["stall", { status: 200, body: ENROLLED }]);
  const began = Date.now();
  const { clock, run, stateDir } = approval(port.port, {
    requestTimeoutMs: 300,
  });
  assert.equal(await run, "c_fake");
  assert.ok(Date.now() - began >= 250, "waited for the request deadline");
  assert.deepEqual(clock.sleeps, [5_000, 5_000]);
  assertEnrolled(stateDir, port.seen[0]!.body.mcpTokenHash);
});

test("approval: gives up 630 s after the start of a 600 s request, writing nothing", async () => {
  const port = await fakePort([{ status: 202, body: { status: "pending" } }]);
  const { clock, run, stateDir } = approval(port.port);
  await assert.rejects(
    run,
    (err) => err instanceof ApprovalEnrollmentError && err.reason === "expired",
  );
  assert.equal(
    clock.sleeps.reduce((sum, ms) => sum + ms, 0),
    630_000,
  );
  assert.equal(port.seen.length - 1, 630_000 / 5_000 - 1);
  assert.ok(!existsSync(stateDir), "nothing written");
});

test("approval: stalled polls back off until the deadline, the last wait cut to the time left", async () => {
  const port = await fakePort(["stall"]);
  const { clock, run, stateDir } = approval(port.port, {
    // The first stalled poll ends at this deadline, then the backoff runs on.
    requestTimeoutMs: 50,
  });
  await assert.rejects(
    run,
    (err) => err instanceof ApprovalEnrollmentError && err.reason === "expired",
  );
  // 5 s, then backoff 5, 10, 20, 40, 60 … until 630 s are spent.
  assert.equal(
    clock.sleeps.reduce((sum, ms) => sum + ms, 0),
    630_000,
  );
  assert.ok(!existsSync(stateDir));
});

test("approval: denied, expired, revoked and unknown end the wait with their reason and no files", async () => {
  const cases: [Reply, ApprovalEnrollmentError["reason"]][] = [
    [{ status: 403, body: { error: "denied" } }, "denied"],
    [{ status: 410, body: { error: "expired" } }, "expired"],
    [{ status: 410, body: { error: "revoked" } }, "revoked"],
    [{ status: 404, body: { error: "unknown request" } }, "unknown"],
    [{ status: 400, body: { error: "requestId needed" } }, "refused"],
  ];
  for (const [reply, reason] of cases) {
    const port = await fakePort([reply]);
    const { run, stateDir } = approval(port.port);
    await assert.rejects(
      run,
      (err) => err instanceof ApprovalEnrollmentError && err.reason === reason,
    );
    assert.ok(!existsSync(stateDir), reason);
  }
});

test("approval: a refused or malformed start, or a malformed 200, writes nothing", async () => {
  const starts: [Reply, Reply[]][] = [
    [{ status: 429, body: { error: "too many" }, retryAfter: 60 }, []],
    [{ status: 503, body: { error: "enrollment requests full" } }, []],
    [{ status: 404, body: { error: "not found" } }, []],
    [{ status: 200, body: { ...STARTED, requestId: 7 } }, []],
    [
      { status: 200, body: STARTED },
      [{ status: 200, body: { ...ENROLLED, clientPort: "x" } }],
    ],
  ];
  for (const [start, polls] of starts) {
    const port = await fakePort(
      polls.length ? polls : [{ status: 500 }],
      start,
    );
    const { run, stateDir, prompts } = approval(port.port);
    await assert.rejects(run);
    assert.ok(!existsSync(stateDir));
    if (!polls.length) assert.deepEqual(prompts, []);
  }
});

test("approval: aborting while a poll is in flight or while waiting stops at once and writes nothing", async () => {
  // In flight: the poll stalls; the real 15 s deadline would be far later.
  const stalling = await fakePort(["stall"]);
  const stop = new AbortController();
  const inFlight = approval(stalling.port, { signal: stop.signal });
  await stalling.polled(1);
  const began = Date.now();
  stop.abort();
  await assert.rejects(inFlight.run, { name: "AbortError" });
  assert.ok(Date.now() - began < 2_000);
  assert.ok(!existsSync(inFlight.stateDir));

  // Waiting: the real clock's sleep of the 5 s interval.
  const pending = await fakePort([
    { status: 202, body: { status: "pending" } },
  ]);
  const stop2 = new AbortController();
  const stateDir = join(mkdtempSync(join(root, "s-")), "state");
  const waiting = enrollRelayByApproval({
    stateDir,
    host: "127.0.0.1",
    enrollPort: pending.port,
    caPem: edgeTls.caCertPem,
    name: "devbox-7",
    onPrompt: () => setTimeout(() => stop2.abort(), 50),
    signal: stop2.signal,
  });
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(pending.seen.length, 1, "no poll after the cancel");
  assert.ok(!existsSync(stateDir));
});

test("typed: the code goes with the token's hash; files only after the 200, mcp-token among them", async () => {
  const port = await fakePort([]);
  const stateDir = join(mkdtempSync(join(root, "s-")), "state");
  const clientId = await enrollRelay({
    stateDir,
    host: "127.0.0.1",
    enrollPort: port.port,
    caPem: edgeTls.caCertPem,
    code: "fake-typed-code",
  });
  assert.equal(clientId, "c_fake");
  const [sent] = port.seen;
  assert.equal(sent!.path, "/enroll");
  assert.deepEqual(Object.keys(sent!.body).sort(), [
    "code",
    "mcpTokenHash",
    "publicKeyPem",
  ]);
  const token = assertEnrolled(stateDir, sent!.body.mcpTokenHash);
  assertTokenStayed(port, token);

  // Two enrollments, two different tokens.
  const again = join(mkdtempSync(join(root, "s-")), "state");
  await enrollRelay({
    stateDir: again,
    host: "127.0.0.1",
    enrollPort: port.port,
    caPem: edgeTls.caCertPem,
    code: "fake-typed-code",
  });
  assert.notEqual(
    readFileSync(join(again, "mcp-token"), "utf8"),
    readFileSync(join(stateDir, "mcp-token"), "utf8"),
  );
});

test("typed: a refusal writes nothing", async () => {
  const port = await fakePort([], undefined, {
    status: 403,
    body: { error: "unknown, used or expired code" },
  });
  const stateDir = join(mkdtempSync(join(root, "s-")), "state");
  await assert.rejects(
    enrollRelay({
      stateDir,
      host: "127.0.0.1",
      enrollPort: port.port,
      caPem: edgeTls.caCertPem,
      code: "fake-typed-code",
    }),
    /refused the enrollment \(403\)/,
  );
  assert.ok(!existsSync(stateDir));
});

// --- the command line ---------------------------------------------------------

function cli(args: string[]) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      new URL("./main.ts", import.meta.url).pathname,
      ...args,
    ],
    { stdio: "pipe" },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  const done = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve(status));
  });
  return { child, done, out: () => out, err: () => err };
}

test("CLI: enroll --approve prints the link and code, and SIGINT stops it with nothing written", async () => {
  const port = await fakePort([{ status: 202, body: { status: "pending" } }]);
  const dir = mkdtempSync(join(root, "cli-"));
  const caFile = join(dir, "ca.pem");
  writeFileSync(caFile, edgeTls.caCertPem);
  const stateDir = join(dir, "state");
  const run = cli([
    "enroll",
    "--approve",
    "--name",
    "devbox-7",
    "--kind",
    "devbox",
    "--state-dir",
    stateDir,
    "--gateway",
    `127.0.0.1:${port.port}`,
    "--ca",
    caFile,
  ]);
  const deadline = Date.now() + 20_000;
  while (!run.out().includes("Waiting for approval") && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(run.out().includes(STARTED.verificationUri), "the link is shown");
  assert.ok(run.out().includes(FAKE_USER_CODE), "the code is shown");
  assert.ok(!run.out().includes(FAKE_REQUEST_ID), "the request id is not");
  run.child.kill("SIGINT");
  assert.equal(await run.done, 130);
  assert.match(run.err(), /nothing was written/);
  assert.ok(!existsSync(stateDir));
  assert.deepEqual(port.seen[0]!.body.kind, "devbox");
});

test("CLI: --approve needs --name, refuses a code file and an unknown kind", async () => {
  const base = ["enroll", "--approve", "--state-dir", "/unused"];
  const target = ["--gateway", "127.0.0.1:1", "--ca", "/unused"];
  for (const args of [
    [...base, ...target],
    [...base, ...target, "--name", "x", "--code-file", "/unused"],
    [...base, ...target, "--name", "x", "--kind", "server"],
  ]) {
    const run = cli(args);
    assert.equal(await run.done, 2, args.join(" "));
    assert.match(run.err(), /usage:/);
  }
});
