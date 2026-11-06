#!/usr/bin/env bun
/**
 * The packaged standalone gateway under the packaged Bun (Task-1383 AC8):
 * `gateway.js` starts on a temp `DATA_DIR`, answers a control handshake and
 * hello on its socket, refuses a lease-less request on its model port, its
 * Codex child (`codex-renew.js`) answers `failed` for a missing file, and
 * SIGTERM exits 0. Fakes only: no credential, no upstream.
 *
 * `test-bun-server-bundle.mjs` runs it on the package. Run alone, it checks
 * a runtime directory holding the two bundles beside the Bun executable:
 * `bun scripts/bun-gateway-check.mjs <runtime dir> [gateway command]`.
 */
import { spawn, sleep } from "bun";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import {
  CONTROL_METHODS,
  GATEWAY_CONTROL_PROTOCOL,
  decodeLeasesRevoked,
  encodeControlRequest,
} from "../app/server/src/gateway/controlMethods.ts";
import { processStartTime } from "../app/server/src/gateway/processIdentity.ts";
import { GATEWAY_REFUSAL_MARKER } from "../app/server/src/gateway/refusals.ts";
import { WorkerConnection } from "../app/server/src/workerProtocol/connection.ts";
import { dialUnixSocket } from "../app/server/src/workerProtocol/unixSocketTransport.ts";

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

async function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = globalThis.setTimeout(
      () => reject(new Error(`Timed out after ${ms} ms: ${what}.`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/**
 * @param {string} runtimeRoot the directory with `gateway.js`, `codex-renew.js`
 *   and `personal-assistant-server`
 * @param {string[]} gatewayCommand how the package starts the gateway
 */
export async function checkGatewayEntries(runtimeRoot, gatewayCommand) {
  const bunExecutable = join(runtimeRoot, "personal-assistant-server");
  for (const bundled of ["gateway.js", "codex-renew.js"])
    assert(
      existsSync(join(runtimeRoot, bundled)),
      `The package has no ${bundled}.`,
    );
  // Short: a Unix socket path holds at most 108 bytes.
  const temp = mkdtempSync("/tmp/");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: join(temp, "h"),
    DATA_DIR: join(temp, "d"),
    TMPDIR: join(temp, "t"),
    CLAUDE_CONFIG_DIR: join(temp, "c"),
    PI_CODING_AGENT_DIR: join(temp, "p"),
    NODE_ENV: "production",
  };
  for (const name of [
    "HOME",
    "DATA_DIR",
    "TMPDIR",
    "CLAUDE_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
  ])
    mkdirSync(env[name]);
  writeFileSync(
    join(env.HOME, ".gitconfig"),
    "[user]\n name = Bundle Test\n email = bundle-test@example.invalid\n",
  );
  const socketPath = join(temp, "c.sock");
  const port = await freePort();
  const gateway = spawn(gatewayCommand, {
    cwd: temp,
    env: {
      ...env,
      ASSISTANT_RUNTIME_DIR: runtimeRoot,
      ASSISTANT_GATEWAY_PORT: String(port),
      ASSISTANT_GATEWAY_SOCKET: socketPath,
      NODE_ENV: "production",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  let child;
  try {
    for (let attempt = 0; !existsSync(socketPath); attempt += 1) {
      assert(
        gateway.exitCode === null,
        `The gateway exited during start (${gateway.exitCode}).`,
      );
      assert(attempt < 400, "The gateway's control socket never appeared.");
      await sleep(50);
    }

    // Control: the handshake and a hello as a fresh server boot.
    const control = new WorkerConnection(await dialUnixSocket(socketPath), {
      handshake: { role: "worker", workerId: "bundle-check" },
      protocol: GATEWAY_CONTROL_PROTOCOL,
    });
    const { revoked } = decodeLeasesRevoked(
      await within(
        control.request(
          CONTROL_METHODS.hello,
          encodeControlRequest({
            serverBootId: "bundle-check-boot",
            pid: process.pid,
            startTime: processStartTime(process.pid),
          }),
        ),
        10_000,
        "control hello",
      ),
    );
    assert(revoked.length === 0, "A fresh gateway revoked leases.");
    control.end("bundle check done");

    // The model port refuses a request without a lease, locally.
    const refused = await globalThis.fetch(
      `http://127.0.0.1:${port}/anthropic/v1/messages`,
      { method: "POST", body: "{}" },
    );
    const refusal = await refused.text();
    assert(
      refused.status === 401 && refusal.includes(GATEWAY_REFUSAL_MARKER),
      `The model port answered ${refused.status} without the gateway's refusal.`,
    );

    // The Codex child: one line in, one result line out, exit 0.
    child = spawn([bunExecutable, join(runtimeRoot, "codex-renew.js")], {
      cwd: temp,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    child.stdin.write(
      `${JSON.stringify({ authFile: join(temp, "absent", "auth.json"), minValidityMs: 1 })}\n`,
    );
    child.stdin.flush();
    const [code, output] = await within(
      Promise.all([child.exited, new globalThis.Response(child.stdout).text()]),
      30_000,
      "the Codex child",
    );
    child.stdin.end();
    const answer = JSON.parse(output.split("\n")[0]);
    assert(
      code === 0 && answer.ok === false && answer.kind === "failed",
      `The Codex child answered ${output.trim()} with exit ${code}.`,
    );

    gateway.kill("SIGTERM");
    const exit = await within(gateway.exited, 15_000, "the gateway's stop");
    assert(exit === 0, `The gateway's stop exited with ${exit}.`);
    assert(!existsSync(socketPath), "The gateway left its control socket.");
    return `gateway handshake and refusal on port ${port}, Codex child ${answer.code}, SIGTERM exit 0`;
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    if (gateway.exitCode === null) gateway.kill("SIGKILL");
    await gateway.exited;
    rmSync(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const runtimeRoot = resolve(process.argv[2] ?? "");
  const command = process.argv[3]
    ? [resolve(process.argv[3])]
    : [
        join(runtimeRoot, "personal-assistant-server"),
        join(runtimeRoot, "gateway.js"),
      ];
  console.log(await checkGatewayEntries(runtimeRoot, command));
}
