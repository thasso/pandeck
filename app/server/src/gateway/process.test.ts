import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { dialUnixSocket } from "../workerProtocol/unixSocketTransport.ts";
import { runGatewayProcess } from "./process.ts";
import { WorkerConnection } from "../workerProtocol/connection.ts";
import {
  CONTROL_METHODS,
  GATEWAY_CONTROL_PROTOCOL,
  encodeControlRequest,
} from "./controlMethods.ts";
import { processStartTime } from "./processIdentity.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gp-"));
  dirs.push(dir);
  return dir;
}

/** Loopback's discard port: a renewal fails there at once. */
const NO_TOKEN_ENDPOINT = { connect: { host: "127.0.0.1", port: 9 } };

test("the process serves control on its socket, refuses a second gateway on it and removes it on stop", async () => {
  const dir = tempDir();
  const socketPath = join(dir, "c.sock");
  const options = {
    stateDir: join(dir, "state"),
    port: 0,
    socketPath,
    log: () => {},
    claudeTokenEndpoint: NO_TOKEN_ENDPOINT,
    drainMs: 0,
  };
  const running = await runGatewayProcess(options);
  try {
    assert.equal(running.clients, undefined, "no client listener by default");
    await assert.rejects(
      runGatewayProcess({ ...options, stateDir: join(dir, "other") }),
      /Another process listens on/,
    );
    assert.equal(
      existsSync(join(dir, "other")),
      false,
      "the refused gateway opened no state",
    );
    (await dialUnixSocket(socketPath)).close();
  } finally {
    await running.stop();
  }
  assert.equal(existsSync(socketPath), false);
});

test("overlapping stale-socket starts leave exactly one model and control listener reachable", async () => {
  const dir = tempDir();
  const socketPath = join(dir, "c.sock");
  writeFileSync(socketPath, "");
  const reservation = net.createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const { port } = reservation.address() as net.AddressInfo;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const options = {
    stateDir: join(dir, "state"),
    port,
    socketPath,
    log() {},
    drainMs: 0,
  };
  const starts = await Promise.allSettled([
    runGatewayProcess(options),
    runGatewayProcess(options),
  ]);
  try {
    assert.equal(
      starts.filter((start) => start.status === "fulfilled").length,
      1,
    );
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`, {
          method: "POST",
          body: "{}",
        })
      ).status,
      401,
    );
    const endpoint = await dialUnixSocket(socketPath);
    endpoint.close();
  } finally {
    for (const start of starts)
      if (start.status === "fulfilled") await start.value.stop();
  }
  assert.equal(existsSync(socketPath), false);
});

test("a failed model-port bind releases control ownership for a later start", async () => {
  const dir = tempDir();
  const socketPath = join(dir, "c.sock");
  const reservation = net.createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const { port } = reservation.address() as net.AddressInfo;
  const options = {
    stateDir: join(dir, "state"),
    port,
    socketPath,
    log() {},
    drainMs: 0,
  };
  try {
    await assert.rejects(runGatewayProcess(options), /EADDRINUSE/);
    assert.equal(existsSync(socketPath), false);
  } finally {
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
  }
  const running = await runGatewayProcess(options);
  try {
    (await dialUnixSocket(socketPath)).close();
  } finally {
    await running.stop();
  }
});

test("stop waits for an aborted Codex renewal to finish reaping its child", async () => {
  const dir = tempDir();
  const authFile = join(dir, "auth.json");
  const FAKE_ACCESS = "fake-process-renewal-access";
  const FAKE_REFRESH = "fake-process-renewal-refresh";
  writeFileSync(
    authFile,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: FAKE_ACCESS,
        refresh: `${FAKE_REFRESH}`,
        expires: Date.now() + 1000,
        accountId: "fake-process-account",
      },
    }),
  );
  let started!: () => void;
  const renewing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted!: () => void;
  const abortSeen = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  let reaped!: () => void;
  const childReaped = new Promise<void>((resolve) => {
    reaped = resolve;
  });
  const running = await runGatewayProcess({
    stateDir: join(dir, "state"),
    port: 0,
    socketPath: join(dir, "c.sock"),
    log: () => {},
    drainMs: 0,
    claudeTokenEndpoint: NO_TOKEN_ENDPOINT,
    renewCodex: async (_file, _validity, signal) => {
      signal.addEventListener("abort", aborted, { once: true });
      started();
      await childReaped;
      return { ok: false, kind: "failed", code: "aborted" };
    },
  });
  const control = new WorkerConnection(
    await dialUnixSocket(join(dir, "c.sock")),
    {
      handshake: { role: "worker", workerId: "process-stop-test" },
      protocol: GATEWAY_CONTROL_PROTOCOL,
    },
  );
  try {
    await control.request(
      CONTROL_METHODS.hello,
      encodeControlRequest({
        serverBootId: "process-stop-boot",
        pid: process.pid,
        startTime: processStartTime(process.pid),
      }),
    );
    await control.request(
      CONTROL_METHODS.syncProfiles,
      encodeControlRequest({
        profiles: [
          {
            id: "renewal",
            provider: "openai-codex",
            name: "Fake renewal",
            enabled: true,
            tokenFile: authFile,
          },
        ],
      }),
    );
    await control.request(
      CONTROL_METHODS.grant,
      encodeControlRequest({
        kind: "engine",
        workerId: "local",
        profileId: "renewal",
      }),
    );
    const tick = running.gateway.renewDue();
    await renewing;
    let stopped = false;
    const stopping = running.stop().then(() => {
      stopped = true;
    });
    await abortSeen;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      stopped,
      false,
      "a renewal writer must settle before process exit",
    );
    reaped();
    await stopping;
    await tick;
  } finally {
    reaped();
    control.end("done");
    await running.stop();
  }
});

test("with client options the process runs the client listener (A5)", async () => {
  const dir = tempDir();
  const running = await runGatewayProcess({
    stateDir: join(dir, "state"),
    port: 0,
    socketPath: join(dir, "c.sock"),
    log: () => {},
    claudeTokenEndpoint: NO_TOKEN_ENDPOINT,
    clients: {},
    loginDrivers: {
      claude: () => {
        throw new Error("No fake login was requested.");
      },
    },
    drainMs: 0,
  });
  try {
    assert.ok(running.clients);
  } finally {
    await running.stop();
  }
});
