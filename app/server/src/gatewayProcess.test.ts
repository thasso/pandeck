/** Standalone gateway and disposable link owners, fake TLS upstreams only.
 * Task-1383 AC3-AC5: reconnect, the uncapped snapshot barrier, settled login
 * release replay, live local reconciliation and owner-exit evidence.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import * as profiles from "./credentialProfiles.ts";
import {
  startGatewayLink,
  GatewayUnavailableError,
  type GatewayLink,
  type GatewayLinkOptions,
} from "./gatewayLink.ts";
import {
  startFakeCompatEndpoint,
  startFakeUpstreams,
  type FakeUpstreams,
} from "./test/gatewayFixtures.ts";
import { WorkerConnection } from "./workerProtocol/connection.ts";
import { listenUnixSocket } from "./workerProtocol/unixSocketTransport.ts";

const FAKE_ACCESS = "fake-process-codex-access";
const FAKE_REFRESH = "fake-process-codex-refresh";
const FAKE_KEY = "fake-process-compat-key";
let upstreams: FakeUpstreams;
const children = new Set<ChildProcess>();
const dirs: string[] = [];
const links: GatewayLink[] = [];
const ids: string[] = [];
const lines: string[] = [];

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
});
afterEach(async () => {
  for (const link of links.splice(0)) await link.close();
  for (const child of children) await stop(child, "SIGKILL");
  children.clear();
  for (const id of ids.splice(0))
    if (profiles.credentialProfileById(id))
      profiles.deleteCredentialProfile(id);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  lines.length = 0;
  upstreams.reset();
});
afterAll(async () => {
  await upstreams.close();
});

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "gp-"));
  dirs.push(dir);
  return dir;
}

function codex(name: string): string {
  const id = profiles.createCredentialProfile({
    provider: "openai-codex",
    name,
  }).id;
  ids.push(id);
  writeFileSync(
    join(profiles.piAgentDir(id), "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: FAKE_ACCESS,
        refresh: `${FAKE_REFRESH}`,
        expires: Date.now() + 86_400_000,
        accountId: "fake-process-account",
      },
    }),
  );
  return id;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function fixture(
  path: string,
  options: object,
): Promise<{ child: ChildProcess; ready: string }> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL(path, import.meta.url)),
      JSON.stringify(options),
    ],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`Fixture start timed out: ${output}`)),
      20_000,
    );
    const failed = (error: Error): void => {
      clearTimeout(timer);
      reject(error);
    };
    child.once("error", failed);
    child.once("exit", (code, signal) =>
      failed(new Error(`Fixture exited ${code ?? signal}: ${output}`)),
    );
    child.stderr!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const ready = /^ready (.+)$/m.exec(output)?.[1];
      if (ready !== undefined) {
        clearTimeout(timer);
        resolve({ child, ready });
      }
    });
  });
}

async function stop(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  await exited;
}

async function gateway(dir: string, port: number): Promise<ChildProcess> {
  return (
    await fixture("./gateway/processFixture.ts", {
      stateDir: join(dir, "state"),
      socketPath: join(dir, "c.sock"),
      port,
      upstreams: upstreams.overrides,
      claudeTokenEndpoint: upstreams.tokenEndpoint,
      drainMs: 0,
    })
  ).child;
}

function link(
  dir: string,
  port: number,
  options: Partial<GatewayLinkOptions> = {},
): GatewayLink {
  const running = startGatewayLink({
    stateDir: join(dir, "state"),
    socketPath: join(dir, "c.sock"),
    port,
    retryDelays: [10, 20],
    log: (line) => lines.push(line),
    ...options,
  });
  links.push(running);
  return running;
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      `Condition not reached: ${lines.join("\n")}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function request(
  port: number,
  token: string,
  path = "/chatgpt/backend-api/codex/responses",
): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: "{}",
  });
  await response.text();
  return response.status;
}

function owner(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, "state", "holds.json"), "utf8"));
}

test("AC3/AC4: socket reconnect preserves live leases and boot, replays a settled release, pushes changed compat and waits for all four racing profile changes", async () => {
  const dir = directory();
  const port = await freePort();
  let child = await gateway(dir, port);
  const login = codex("Process login");
  const removed = codex("Process removed in fourth pass");
  const first = await startFakeCompatEndpoint(["m"], "first");
  const second = await startFakeCompatEndpoint(["m"], "second");
  let racing = false;
  let passes = 0;
  try {
    const compatible = profiles.createCredentialProfile({
      provider: "openai-compatible",
      name: "Process compatible",
    }).id;
    ids.push(compatible);
    profiles.patchOpenAiCompatibleEndpoint(compatible, {
      baseUrl: first.baseUrl,
      apiKey: FAKE_KEY,
    });
    assert.equal(
      (await profiles.testOpenAiCompatibleProfile(compatible)).status.ok,
      true,
    );
    const running = link(dir, port, {
      beforeSync: async (pass) => {
        if (!racing) return;
        passes = pass;
        if (pass <= 3)
          profiles.patchCredentialProfile(login, {
            name: `Process change ${pass}`,
          });
        else if (pass === 4) profiles.deleteCredentialProfile(removed);
      },
    });
    assert.equal(await running.ready, true);
    assert.equal(
      running.gateway,
      undefined,
      "socket mode never starts a gateway",
    );
    assert.equal(running.baseUrl, `http://127.0.0.1:${port}`);
    const hold = await running.acquireLoginHold(login);
    const beforeOwner = owner(dir);
    const live = await running.grantEngineLease({
      workerId: "local",
      profileId: login,
    });
    const dead = await running.grantEngineLease({
      workerId: "local",
      profileId: login,
    });
    const removedLease = await running.grantEngineLease({
      workerId: "ext-1",
      profileId: removed,
    });
    const compat = await running.grantEngineLease({
      workerId: "local",
      profileId: compatible,
    });
    assert.equal(await request(port, live.token), 200);
    assert.equal(
      upstreams.chatgpt.at(-1)?.headers.authorization,
      `Bearer ${FAKE_ACCESS}`,
    );
    assert.equal(
      await request(port, compat.token, "/compat/v1/chat/completions"),
      200,
    );
    assert.equal(first.seen.at(-1)?.authorization, `Bearer ${FAKE_KEY}`);
    await stop(child);
    await until(() => running.connectionState() !== "connected");
    const started = Date.now();
    await assert.rejects(
      running.grantEngineLease({ workerId: "local", profileId: login }),
      GatewayUnavailableError,
    );
    assert.ok(
      Date.now() - started < 10_500,
      "an unavailable grant is bounded at 10 s",
    );
    await running.releaseLoginHold(hold);
    await running.revokeLease(dead.leaseId, "session-ended");
    profiles.patchOpenAiCompatibleEndpoint(compatible, {
      baseUrl: second.baseUrl,
      apiKey: FAKE_KEY,
    });
    assert.equal(
      (await profiles.testOpenAiCompatibleProfile(compatible)).status.ok,
      true,
    );
    racing = true;
    child = await gateway(dir, port);
    await until(() => running.connectionState() === "connected");
    assert.equal(
      passes,
      5,
      "ready follows four changed passes and one unchanged pass",
    );
    assert.equal(await request(port, live.token), 200);
    assert.equal(
      await request(port, dead.token),
      401,
      "reconnect reconciles a revoke lost during the outage",
    );
    assert.equal(
      await request(port, removedLease.token),
      401,
      "fourth-pass deletion is synced before ready",
    );
    assert.equal(
      await request(port, compat.token, "/compat/v1/chat/completions"),
      200,
    );
    assert.equal(second.seen.at(-1)?.authorization, `Bearer ${FAKE_KEY}`);
    const reacquired = await running.acquireLoginHold(login);
    const afterOwner = owner(dir);
    // IDs differ but this is the same boot's hold owner across the reconnect.
    const holdsOf = (value: unknown): { owner: unknown }[] =>
      (value as { holds: { owner: unknown }[] }).holds;
    assert.deepEqual(
      holdsOf(afterOwner)[0]!.owner,
      holdsOf(beforeOwner)[0]!.owner,
    );
    await running.releaseLoginHold(reacquired);
    await running.close();
    assert.equal(
      child.exitCode,
      null,
      "closing a link does not stop the gateway",
    );
  } finally {
    await stop(child, "SIGKILL");
    await first.close();
    await second.close();
  }
}, 40_000);

test("AC6: an absent socket becomes unreachable, a major mismatch incompatible, and a recovered gateway connected", async () => {
  const dir = directory();
  const port = await freePort();
  const running = link(dir, port, { unreachableMs: 30 });
  const states: string[] = [];
  running.onConnectionState((state) => states.push(state));
  await until(() => running.connectionState() === "unreachable");
  const listener = await listenUnixSocket(join(dir, "c.sock"), (endpoint) => {
    new WorkerConnection(endpoint, {
      handshake: { role: "server", admit: () => undefined },
      protocol: { version: "gateway-control/2.0", compatible: () => true },
    });
  });
  try {
    await until(() => running.connectionState() === "incompatible");
  } finally {
    await listener.close();
  }
  await gateway(dir, port);
  assert.equal(await running.ready, true);
  assert.equal(running.connectionState(), "connected");
  assert.ok(states.includes("unreachable"));
  assert.ok(states.includes("incompatible"));
  assert.equal(states.at(-1), "connected");
}, 30_000);

test("AC5: a killed server owner releases its Codex hold by evidence, revokes its server lease and leaves the gateway and external engine alive", async () => {
  const dir = directory();
  const port = await freePort();
  const child = await gateway(dir, port);
  const pid = child.pid;
  const profileId = codex("Process owner exit");
  const server = await fixture("./test/gatewayLinkFixture.ts", {
    stateDir: join(dir, "state"),
    socketPath: join(dir, "c.sock"),
    port,
    profileId,
  });
  const held = JSON.parse(server.ready) as {
    holdId: string;
    server: { leaseToken: string };
    external: { token: string };
  };
  assert.equal(await request(port, held.external.token), 200);
  await stop(server.child, "SIGKILL");
  assert.equal(child.pid, pid);
  assert.equal(child.exitCode, null);
  assert.equal(await request(port, held.external.token), 200);
  const next = link(dir, port);
  assert.equal(await next.ready, true);
  assert.equal(await request(port, held.server.leaseToken), 401);
  const newHold = await next.acquireLoginHold(profileId);
  await next.releaseLoginHold(newHold);
  assert.equal(await request(port, held.external.token), 200);
  await next.close();
  assert.equal(child.pid, pid);
  assert.equal(child.exitCode, null);
  assert.equal(await request(port, held.external.token), 200);
}, 30_000);
