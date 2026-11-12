#!/usr/bin/env bun
/**
 * The packaged standalone gateway under the packaged Bun (Task-1383 AC8):
 * `gateway.js` starts on a temp `DATA_DIR`, answers a control handshake and
 * hello on its socket, refuses a lease-less request on its model port, its
 * Codex child (`codex-renew.js`) answers `failed` for a missing file, and
 * SIGTERM exits 0. Fakes only: no credential, no upstream.
 *
 * The packaged vault (Task-1387 AC10): `vault.js`, paired with a temp edge by
 * `gateway-admin.js`, runs a Claude login through `claude-login.js` and a fake
 * CLI, ends a cancelled login's whole process group, starts a Codex login in
 * `codex-login.js`, and on SIGTERM during a login exits 0 once its group is
 * gone. Run it WITHOUT provider network (Nix's build sandbox, or a container
 * with `--network none`): the Codex login reaches for OpenAI as soon as it
 * starts.
 *
 * The packaged edge (Task-1401): `gateway-edge.js` refuses to start without
 * `--vault-host` or unpaired, links to a paired `vault.js`, serves an enrolled
 * relay's client protocol and `/mcp` (whose Jira tool answers "not
 * connected"), refuses peers without a certificate of its CA on the model and
 * client ports, serves the packaged gateway UI from `gateway-web/` with
 * `--ui-config`, and exits 0 on SIGTERM. No provider is reached.
 *
 * `test-bun-server-bundle.mjs` runs all three on the package. Run alone, it
 * checks a runtime directory holding the bundles beside the Bun executable:
 * `bun scripts/bun-gateway-check.mjs <runtime dir> [gateway command]`.
 */
import { spawn, sleep } from "bun";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { connect, createServer } from "node:net";
import tls from "node:tls";
import { join, resolve } from "node:path";
import {
  CLIENT_METHODS,
  GATEWAY_CLIENT_PROTOCOL,
  encodeClientMessage,
} from "../app/server/src/gateway/clientMethods.ts";
import {
  CONTROL_METHODS,
  GATEWAY_CONTROL_PROTOCOL,
  decodeLeasesRevoked,
  encodeControlRequest,
} from "../app/server/src/gateway/controlMethods.ts";
import { processStartTime } from "../app/server/src/gateway/processIdentity.ts";
import { GATEWAY_REFUSAL_MARKER } from "../app/server/src/gateway/refusals.ts";
import { createRemoteVault } from "../app/server/src/gateway/remoteVault.ts";
import { readEdgeVaultLink } from "../app/server/src/gateway/vaultMethods.ts";
import {
  edgeTlsFor,
  selfSignedIdentity,
} from "../app/server/src/gateway/x509.ts";
import { enrollRelay, startRelay } from "../app/server/src/relay/relay.ts";
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

/** `/proc/<pid>/stat`'s state and process group, or undefined once reaped. */
function procStat(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], pgrp: Number(fields[2]) };
  } catch {
    return undefined;
  }
}

/** Live (non-zombie) processes matching `test(pid, stat)`. */
function liveProcesses(test) {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .filter((name) => {
      const stat = procStat(name);
      return (
        stat && stat.state !== "Z" && stat.state !== "X" && test(name, stat)
      );
    });
}

const runningEntry = (entry) =>
  liveProcesses((pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(entry);
    } catch {
      return false;
    }
  });

async function eventually(check, ms, what) {
  const until = Date.now() + ms;
  while (!check()) {
    assert(Date.now() < until, `Timed out after ${ms} ms: ${what}.`);
    await sleep(25);
  }
}

/**
 * A fake official CLI as a shell script; `cli-mode` in `dir` picks how it
 * behaves: `ok` takes a pasted code and writes a fake credential, `stubborn`
 * ignores SIGTERM and forks a sleeper, `wait` waits on stdin.
 */
/** The fake CLI's synthetic access value; not a real credential. */
const FAKE_ACCESS = "fake-bundle-access";

function fakeClaudeCli(dir) {
  const file = join(dir, "claude");
  writeFileSync(
    file,
    `#!/bin/sh
echo $$ > ${dir}/cli.pid
case "$(cat ${dir}/cli-mode)" in
ok)
  printf 'Open https://claude.example/oauth?x=1\nPaste code here: '
  read code
  printf '{"claudeAiOauth":{"accessToken":"${FAKE_ACCESS}-%s","expiresAt":${Date.now() + 3_600_000}}}' "$code" > "$CLAUDE_CONFIG_DIR/.credentials.json"
  ;;
stubborn)
  trap '' TERM
  sleep 1000 &
  echo $! > ${dir}/sleeper.pid
  printf 'Open https://claude.example/oauth?x=2\n'
  wait
  ;;
*)
  printf 'Open https://claude.example/oauth?x=3\n'
  read code
  ;;
esac
`,
  );
  chmodSync(file, 0o755);
  return file;
}

/** @param {string} runtimeRoot the directory with `vault.js` and its children */
export async function checkVaultEntry(runtimeRoot) {
  const bunExecutable = join(runtimeRoot, "personal-assistant-server");
  for (const bundled of [
    "vault.js",
    "claude-login.js",
    "codex-login.js",
    "gateway-admin.js",
    "pivHelper.py",
  ])
    assert(
      existsSync(join(runtimeRoot, bundled)),
      `The package has no ${bundled}.`,
    );
  const temp = mkdtempSync("/tmp/");
  const vaultDir = join(temp, "v");
  const edgeDir = join(temp, "e");
  for (const name of ["v", "e", "h", "t"])
    mkdirSync(join(temp, name), { mode: 0o700 });
  // The vault's whole environment.
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: join(temp, "h"),
    TMPDIR: join(temp, "t"),
    NODE_ENV: "production",
    ASSISTANT_RUNTIME_DIR: runtimeRoot,
  };
  const admin = async (dir, ...args) => {
    const run = spawn(
      [
        bunExecutable,
        join(runtimeRoot, "gateway-admin.js"),
        "--state-dir",
        dir,
        ...args,
      ],
      { env, stdout: "pipe", stderr: "inherit" },
    );
    const [code, output] = await within(
      Promise.all([run.exited, new globalThis.Response(run.stdout).text()]),
      30_000,
      `gateway-admin ${args[0]}`,
    );
    assert(code === 0, `gateway-admin ${args[0]} exited with ${code}.`);
    return output;
  };
  // Pairing: the vault's certificate to the edge, the edge's back.
  writeFileSync(join(temp, "vault.pem"), await admin(vaultDir, "vault-init"));
  writeFileSync(
    join(temp, "edge.pem"),
    await admin(edgeDir, "vault-pair", "--vault-cert", join(temp, "vault.pem")),
  );
  await admin(vaultDir, "vault-init", "--edge-cert", join(temp, "edge.pem"));
  const link = readEdgeVaultLink(edgeDir);
  assert(typeof link !== "string", `The edge is not paired: ${link}.`);

  const mode = (value) => writeFileSync(join(temp, "cli-mode"), value);
  mode("ok");
  const port = await freePort();
  const vault = spawn(
    [
      bunExecutable,
      join(runtimeRoot, "vault.js"),
      "--state-dir",
      vaultDir,
      "--port",
      String(port),
    ],
    {
      env: { ...env, ASSISTANT_CLAUDE_CLI_BIN: fakeClaudeCli(temp) },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const accounts = new Map();
  const deps = {
    profiles: () => [],
    liveLeases: () => [],
    report: () => {},
    log: () => {},
  };
  let remote;
  const connectRemote = () =>
    createRemoteVault(
      { host: "127.0.0.1", port, tls: link },
      {
        profiles: () =>
          [...accounts].map(([id, { kind, tokenFile }]) => ({
            id,
            provider: kind,
            name: id,
            enabled: true,
            tokenFile,
          })),
        liveLeases: () => [],
        report: () => {},
        log: () => {},
      },
    );
  const start = (kind, accountId) => {
    const tokenFile = remote.newTokenFile(kind, accountId);
    accounts.set(accountId, { kind, tokenFile });
    remote.inputsChanged();
    const seen = [];
    const run = remote.login(
      { kind, accountId, tokenFile, commit: () => true },
      {
        output: (text) => seen.push(`output:${text}`),
        url: (url) => seen.push(`url:${url}`),
        code: (code) => seen.push(`code:${code}`),
      },
    );
    assert(run, `The vault runs no ${kind} login.`);
    run.done.catch(() => {});
    return { run, seen, tokenFile };
  };
  const loginTmp = join(vaultDir, "login-tmp");
  const settled = (run, what) =>
    within(
      run.done.then(
        () => true,
        () => false,
      ),
      30_000,
      what,
    );
  try {
    for (let listening = false; !listening;) {
      assert(
        vault.exitCode === null,
        `vault.js exited during start (${vault.exitCode}).`,
      );
      listening = await new Promise((done) => {
        const probe = connect(port, "127.0.0.1", () => {
          probe.destroy();
          done(true);
        });
        probe.on("error", () => done(false));
      });
      if (!listening) await sleep(50);
    }

    // The link's pin under Bun, both ends, before the real edge connects (a
    // newer edge replaces the older): no client certificate gets no byte
    // back, and a same-subject stranger edge or an edge pinning another vault
    // never links.
    const bare = tls.connect({
      host: "127.0.0.1",
      port,
      ca: link.peerCertPem,
      checkServerIdentity: () => undefined,
    });
    let answered = 0;
    bare.on("data", (chunk) => (answered += chunk.length));
    bare.on("error", () => {});
    await within(
      new Promise((done) => bare.once("close", done)),
      10_000,
      "the vault to drop a peer without a certificate",
    );
    assert(answered === 0, "vault.js answered a peer without a certificate.");
    const stranger = selfSignedIdentity("pandeck-gateway-edge", "client");
    const otherVault = selfSignedIdentity("pandeck-gateway-vault", "server", [
      "127.0.0.1",
    ]);
    const unpinned = [
      createRemoteVault(
        {
          host: "127.0.0.1",
          port,
          tls: { ...link, keyPem: stranger.keyPem, certPem: stranger.certPem },
        },
        deps,
      ),
      createRemoteVault(
        {
          host: "127.0.0.1",
          port,
          tls: { ...link, peerCertPem: otherVault.certPem },
        },
        deps,
      ),
    ];
    await sleep(1_500);
    for (const peer of unpinned) {
      assert(!peer.connected(), "An unpinned link came up.");
      peer.close();
    }

    remote = connectRemote();
    await eventually(
      () => {
        assert(
          vault.exitCode === null,
          `vault.js exited during start (${vault.exitCode}).`,
        );
        return remote.connected();
      },
      20_000,
      "the vault link",
    );

    // (1) A Claude login through claude-login.js and the fake CLI.
    const claude = start("claude", "claude-a");
    await eventually(
      () => claude.seen.includes("url:https://claude.example/oauth?x=1"),
      30_000,
      "the Claude login's URL",
    );
    claude.run.input("fake-bundle-code");
    assert(
      await settled(claude.run, "the Claude login"),
      "The Claude login failed.",
    );
    assert(
      readFileSync(claude.tokenFile, "utf8").includes(
        `${FAKE_ACCESS}-fake-bundle-code`,
      ),
      "The Claude login left no credential in the vault's accounts.",
    );
    assert(readdirSync(loginTmp).length === 0, "A login directory was left.");

    // (2) A cancelled login whose CLI ignores SIGTERM and forks: the whole
    // group ends.
    mode("stubborn");
    const stubborn = start("claude", "claude-b");
    await eventually(
      () =>
        stubborn.seen.some((event) => event.startsWith("url:")) &&
        existsSync(join(temp, "sleeper.pid")),
      30_000,
      "the stubborn login",
    );
    const group = procStat(
      readFileSync(join(temp, "cli.pid"), "utf8").trim(),
    )?.pgrp;
    assert(group, "The fake CLI has no process group.");
    stubborn.run.cancel();
    assert(
      !(await settled(stubborn.run, "the cancelled login")),
      "A cancelled login succeeded.",
    );
    await eventually(
      () => liveProcesses((_pid, stat) => stat.pgrp === group).length === 0,
      5_000,
      "the cancelled login's group to end",
    );

    // (3) A Codex login: codex-login.js loads pi and starts; cancelled (or
    // failed offline), its child is gone.
    const codex = start("openai-codex", "codex-a");
    await eventually(
      () =>
        codex.seen.some((event) =>
          event.startsWith("output:Starting the OpenAI device-code login"),
        ),
      30_000,
      "the Codex login's first output",
    );
    codex.run.cancel();
    assert(
      !(await settled(codex.run, "the Codex login")),
      "An offline Codex login succeeded.",
    );
    await eventually(
      () => runningEntry("codex-login.js").length === 0,
      5_000,
      "the Codex login child to end",
    );

    // (4) SIGTERM during a login: exit 0 once the login's group is gone.
    mode("wait");
    const waiting = start("claude", "claude-c");
    await eventually(
      () => waiting.seen.some((event) => event.startsWith("url:")),
      30_000,
      "the waiting login",
    );
    const cliPid = readFileSync(join(temp, "cli.pid"), "utf8").trim();
    vault.kill("SIGTERM");
    const exit = await within(vault.exited, 30_000, "vault.js's stop");
    assert(exit === 0, `vault.js's stop exited with ${exit}.`);
    assert(
      procStat(cliPid) === undefined || procStat(cliPid).state === "Z",
      "vault.js exited with its login's CLI still running.",
    );
    assert(
      runningEntry("claude-login.js").length === 0,
      "vault.js exited with a login child running.",
    );
    return `vault paired, unpinned peers refused, Claude login done, cancelled group ended, Codex login started, SIGTERM exit 0 after the login`;
  } finally {
    remote?.close();
    if (vault.exitCode === null) vault.kill("SIGKILL");
    await vault.exited;
    for (const pidFile of ["cli.pid", "sleeper.pid"])
      if (existsSync(join(temp, pidFile)))
        try {
          process.kill(
            Number(readFileSync(join(temp, pidFile), "utf8")),
            "SIGKILL",
          );
        } catch {
          // Gone, as it should be.
        }
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Whether a TCP connection to `port` on loopback is accepted. */
function accepts(port) {
  return new Promise((done) => {
    const probe = connect(port, "127.0.0.1", () => {
      probe.destroy();
      done(true);
    });
    probe.on("error", () => done(false));
  });
}

/**
 * A TLS peer that `identity` (or no certificate) cannot get past: the edge
 * closes it within 10 s without one application byte.
 */
async function assertRefusedPeer(port, caPem, identity, what) {
  const peer = tls.connect({
    host: "127.0.0.1",
    port,
    ca: caPem,
    checkServerIdentity: () => undefined,
    ...(identity ? { key: identity.keyPem, cert: identity.certPem } : {}),
  });
  let answered = 0;
  peer.on("secureConnect", () =>
    peer.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n"),
  );
  peer.on("data", (chunk) => (answered += chunk.length));
  peer.on("error", () => {});
  try {
    await within(
      new Promise((done) => peer.once("close", done)),
      10_000,
      `the edge to close ${what}`,
    );
  } finally {
    peer.destroy();
  }
  assert(answered === 0, `The edge answered ${what}.`);
}

/** One request; answers status, headers and the body's bytes. */
function fetchBytes(url, options = {}) {
  const { body, ...rest } = options;
  return within(
    new Promise((done, fail) => {
      const request = (url.startsWith("https:") ? https : http).request(
        url,
        { agent: false, ...rest },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            done({
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
          response.on("error", fail);
        },
      );
      request.on("error", fail);
      request.end(body);
    }),
    15_000,
    `${options.method ?? "GET"} ${new URL(url).pathname}`,
  );
}

/** The text the edge's Jira tool answers a user with no credential. */
const JIRA_NOT_CONNECTED =
  "Jira is not connected for this user; connect it in Pandeck's Settings.";

/**
 * @param {string} runtimeRoot the directory with `gateway-edge.js`,
 *   `gateway-web/`, `vault.js` and `gateway-admin.js`
 */
export async function checkEdgeEntry(runtimeRoot) {
  const bunExecutable = join(runtimeRoot, "personal-assistant-server");
  for (const bundled of [
    "gateway-edge.js",
    "gateway-web/gateway.html",
    "vault.js",
    "gateway-admin.js",
  ])
    assert(
      existsSync(join(runtimeRoot, bundled)),
      `The package has no ${bundled}.`,
    );
  // Short: the relay's Unix socket path holds at most 108 bytes.
  const temp = mkdtempSync("/tmp/");
  const vaultDir = join(temp, "v");
  const edgeDir = join(temp, "e");
  for (const name of ["v", "e", "h", "t", "r"])
    mkdirSync(join(temp, name), { mode: 0o700 });
  // The edge's and the vault's whole environment: no DATA_DIR.
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: join(temp, "h"),
    TMPDIR: join(temp, "t"),
    NODE_ENV: "production",
    ASSISTANT_RUNTIME_DIR: runtimeRoot,
  };
  const admin = async (dir, ...args) => {
    const run = spawn(
      [
        bunExecutable,
        join(runtimeRoot, "gateway-admin.js"),
        "--state-dir",
        dir,
        ...args,
      ],
      { env, stdout: "pipe", stderr: "inherit" },
    );
    const [code, output] = await within(
      Promise.all([run.exited, new globalThis.Response(run.stdout).text()]),
      30_000,
      `gateway-admin ${args[0]}`,
    );
    assert(code === 0, `gateway-admin ${args[0]} exited with ${code}.`);
    return output;
  };
  /** Starts the edge; `lines` collects its stdout, echoed. */
  const startEdge = (args) => {
    const run = spawn(
      [bunExecutable, join(runtimeRoot, "gateway-edge.js"), ...args],
      { env, stdout: "pipe", stderr: "inherit" },
    );
    const lines = [];
    void (async () => {
      const decoder = new globalThis.TextDecoder();
      let rest = "";
      for await (const chunk of run.stdout) {
        const text = rest + decoder.decode(chunk, { stream: true });
        const parts = text.split("\n");
        rest = parts.pop();
        for (const line of parts) {
          console.log(line);
          lines.push(line);
        }
      }
    })();
    return { run, lines };
  };
  const exitOf = (run, what) => within(run.exited, 10_000, what);

  // (1) Refusals: no --vault-host, and an unpaired state directory.
  const fresh = join(temp, "f");
  for (const [args, what] of [
    [["--state-dir", fresh], "without --vault-host"],
    [["--state-dir", fresh, "--vault-host", "127.0.0.1"], "unpaired"],
  ]) {
    const { run } = startEdge(args);
    const code = await exitOf(run, `gateway-edge ${what}`);
    assert(code === 2, `gateway-edge ${what} exited with ${code}, not 2.`);
  }

  // (2) A paired vault, a user and an enrollment code.
  writeFileSync(join(temp, "vault.pem"), await admin(vaultDir, "vault-init"));
  writeFileSync(
    join(temp, "edge.pem"),
    await admin(edgeDir, "vault-pair", "--vault-cert", join(temp, "vault.pem")),
  );
  await admin(vaultDir, "vault-init", "--edge-cert", join(temp, "edge.pem"));
  await admin(edgeDir, "user", "add", "u1");
  const code = (
    await admin(edgeDir, "enroll-code", "--user", "u1", "--label", "check")
  ).trim();
  const vaultPort = await freePort();
  const vault = spawn(
    [
      bunExecutable,
      join(runtimeRoot, "vault.js"),
      "--state-dir",
      vaultDir,
      "--port",
      String(vaultPort),
    ],
    { env, stdout: "inherit", stderr: "inherit" },
  );
  const [modelPort, clientPort, enrollPort] = [
    await freePort(),
    await freePort(),
    await freePort(),
  ];
  const flags = [
    "--state-dir",
    edgeDir,
    "--port",
    "0",
    "--model-port",
    String(modelPort),
    "--client-port",
    String(clientPort),
    "--enroll-port",
    String(enrollPort),
    "--bind-host",
    "127.0.0.1",
    "--host",
    "127.0.0.1",
    "--vault-host",
    "127.0.0.1",
    "--vault-port",
    String(vaultPort),
  ];
  const linkUp = (edge) =>
    eventually(
      () => {
        assert(
          edge.run.exitCode === null,
          `gateway-edge.js exited during start (${edge.run.exitCode}).`,
        );
        assert(vault.exitCode === null, `vault.js exited (${vault.exitCode}).`);
        return edge.lines.some((line) =>
          line.includes(`vault link up at 127.0.0.1:${vaultPort}`),
        );
      },
      30_000,
      "the edge's vault link",
    );
  const portsLine = (edge) =>
    edge.lines.find((line) => line.startsWith("[gateway-edge] state "));
  let edge;
  let relay;
  let link;
  try {
    // (3) Boot A, without --ui-config.
    edge = startEdge(flags);
    await linkUp(edge);
    assert(
      portsLine(edge) &&
        portsLine(edge).includes(`model ${modelPort}`) &&
        !portsLine(edge).includes(", ui "),
      `Boot A's ports line is wrong: ${portsLine(edge)}.`,
    );
    const caPem = await admin(edgeDir, "ca");

    // (4) An enrolled relay and its MCP token.
    const relayDir = join(temp, "r");
    const clientId = await within(
      enrollRelay({
        stateDir: relayDir,
        host: "127.0.0.1",
        enrollPort,
        caPem,
        code,
      }),
      15_000,
      "the relay's enrollment",
    );
    relay = await startRelay({
      stateDir: relayDir,
      port: 0,
      socketPath: join(temp, "r.sock"),
      log: () => {},
    });
    const mcpToken = (
      await admin(edgeDir, "clients", "mcp-token", clientId)
    ).trim();

    // (5) Gateway client 1.0 through the relay's socket (the client port).
    link = new WorkerConnection(await dialUnixSocket(relay.socketPath), {
      handshake: { role: "worker", workerId: "edge-check" },
      protocol: GATEWAY_CLIENT_PROTOCOL,
      handlers: Object.fromEntries(
        [CLIENT_METHODS.accountsChanged, CLIENT_METHODS.loginEvent].map(
          (method) => [method, async () => encodeClientMessage({})],
        ),
      ),
    });
    const call = async (method, json) =>
      (
        await within(
          link.request(method, encodeClientMessage(json)),
          15_000,
          method,
        )
      ).json;
    const accounts = await call(CLIENT_METHODS.listAccounts, {});
    assert(
      Array.isArray(accounts.accounts) && accounts.accounts.length === 0,
      "accounts.list answered accounts for a new user.",
    );
    const tools = await call(CLIENT_METHODS.toolsList, {});
    assert(
      tools.tools.some((tool) => tool.name === "jira_get_issue"),
      "tools.list names no jira_get_issue.",
    );
    const called = await call(CLIENT_METHODS.toolsCall, {
      name: "jira_get_issue",
      args: { issue: "OPS-1" },
    });
    assert(
      called.ok === false && called.message === JIRA_NOT_CONNECTED,
      `tools.call answered ${JSON.stringify(called)}.`,
    );

    // (6) /mcp through the relay's HTTP (the model port).
    const mcp = (body, token = mcpToken) =>
      fetchBytes(`${relay.url}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
      });
    const init = await mcp({
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "edge-check", version: "1" },
      },
    });
    assert(init.status === 200, `/mcp initialize answered ${init.status}.`);
    const listed = await mcp({ method: "tools/list", params: {} });
    assert(
      listed.status === 200 &&
        JSON.parse(listed.body).result.tools.some(
          (tool) => tool.name === "jira_get_issue",
        ),
      `/mcp tools/list answered ${listed.status}.`,
    );
    const toolCall = await mcp({
      method: "tools/call",
      params: { name: "jira_get_issue", arguments: { issue: "OPS-1" } },
    });
    const result = JSON.parse(toolCall.body).result;
    assert(
      toolCall.status === 200 &&
        result.isError === true &&
        result.content.map((part) => part.text).join("") === JIRA_NOT_CONNECTED,
      `/mcp tools/call answered ${toolCall.status} ${toolCall.body}.`,
    );
    const wrong = await mcp({ method: "tools/list" }, "wrong-token");
    assert(wrong.status === 401, `A wrong MCP token got ${wrong.status}.`);

    // (7) Mutual TLS: no certificate, and one the edge's CA did not issue.
    const stranger = selfSignedIdentity("stranger", "client");
    for (const [port, name] of [
      [modelPort, "model"],
      [clientPort, "client"],
    ]) {
      await assertRefusedPeer(
        port,
        caPem,
        undefined,
        `a ${name}-port peer without a certificate`,
      );
      await assertRefusedPeer(port, caPem, stranger, `a ${name}-port stranger`);
    }

    // (8) Boot B, with --ui-config and the packaged gateway-web/.
    edge.run.kill("SIGTERM");
    const stopA = await exitOf(edge.run, "boot A's stop");
    assert(stopA === 0, `Boot A's SIGTERM exited with ${stopA}.`);
    const uiPort = await freePort();
    const closedPort = await freePort();
    // A CA-issued certificate, as a deployment's is: Bun 1.4.2's client does
    // not accept a self-signed leaf as its own trust root.
    const uiTls = edgeTlsFor(["127.0.0.1"], undefined);
    writeFileSync(join(temp, "ui-cert.pem"), uiTls.serverCertPem);
    writeFileSync(join(temp, "ui-key.pem"), uiTls.serverKeyPem, {
      mode: 0o600,
    });
    const uiConfig = join(temp, "ui.json");
    writeFileSync(
      uiConfig,
      JSON.stringify({
        port: uiPort,
        publicOrigin: `https://127.0.0.1:${uiPort}`,
        certFile: join(temp, "ui-cert.pem"),
        keyFile: join(temp, "ui-key.pem"),
        oidc: {
          issuer: `https://127.0.0.1:${closedPort}`,
          clientId: "fake-check-client",
          clientSecret: "fake-check-secret",
        },
        allow: { emailDomains: ["example.org"] },
      }),
      { mode: 0o600 },
    );
    edge = startEdge([...flags, "--ui-config", uiConfig]);
    await linkUp(edge);
    assert(
      portsLine(edge)?.includes(`, ui ${uiPort}`),
      `Boot B's ports line is wrong: ${portsLine(edge)}.`,
    );
    const ui = (path) =>
      fetchBytes(`https://127.0.0.1:${uiPort}${path}`, { ca: uiTls.caCertPem });
    const page = await ui("/");
    const html = readFileSync(join(runtimeRoot, "gateway-web", "gateway.html"));
    assert(
      page.status === 200 &&
        page.body.equals(html) &&
        page.headers["content-security-policy"],
      `GET / answered ${page.status}, not the packaged gateway.html.`,
    );
    const assets = [
      ...new Set(
        [
          ...html.toString("utf8").matchAll(/["'](\/assets\/[^"'?#]+)["']/g),
        ].map((match) => match[1]),
      ),
    ];
    assert(assets.length > 0, "gateway.html references no asset.");
    for (const asset of assets) {
      const served = await ui(asset);
      assert(
        served.status === 200 &&
          served.body.equals(
            readFileSync(join(runtimeRoot, "gateway-web", asset.slice(1))),
          ),
        `${asset} is not served as packaged (${served.status}).`,
      );
    }
    const me = await ui("/api/me");
    assert(
      me.status === 401 &&
        JSON.stringify(JSON.parse(me.body.toString("utf8"))) ===
          '{"error":"signed_out"}',
      `/api/me signed out answered ${me.status}.`,
    );
    const login = await ui("/auth/login");
    assert(
      login.status === 303 && login.headers.location === "/?signin=failed",
      `/auth/login with an unreachable issuer answered ${login.status} ${login.headers.location}.`,
    );

    // (9) SIGTERM: exit 0, the ports close, no credential file on the edge.
    edge.run.kill("SIGTERM");
    const stopB = await exitOf(edge.run, "boot B's stop");
    assert(stopB === 0, `Boot B's SIGTERM exited with ${stopB}.`);
    for (const port of [modelPort, clientPort, enrollPort, uiPort])
      assert(!(await accepts(port)), `Port ${port} still accepts.`);
    const accountsDir = join(edgeDir, "accounts");
    assert(
      !existsSync(accountsDir) || readdirSync(accountsDir).length === 0,
      "The edge holds files under accounts/.",
    );
    link.end("check done");
    link = undefined;
    await relay.close();
    relay = undefined;
    vault.kill("SIGTERM");
    const stopVault = await within(vault.exited, 30_000, "vault.js's stop");
    assert(stopVault === 0, `vault.js's stop exited with ${stopVault}.`);
    return `refused unpaired and vault-less starts, vault link up, client protocol and /mcp through a relay (Jira not connected), no-cert and stranger peers refused on both ports, gateway-web served with --ui-config, SIGTERM exit 0`;
  } finally {
    link?.end("check done");
    await relay?.close();
    if (edge && edge.run.exitCode === null) edge.run.kill("SIGKILL");
    await edge?.run.exited;
    if (vault.exitCode === null) vault.kill("SIGKILL");
    await vault.exited;
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
  console.log(await checkVaultEntry(runtimeRoot));
  console.log(await checkEdgeEntry(runtimeRoot));
}
