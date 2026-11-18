#!/usr/bin/env bun

// Native package smoke for CI and local builds. No provider requests or logins.
// The more extensive Linux install check remains test-bun-server-bundle.mjs.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { sleep, spawn } from "bun";
import {
  assertNativeBinary,
  bunPackageTarget,
} from "./bun-package-platform.mjs";

assert(
  process.argv[2],
  "usage: smoke-bun-server-package.mjs <runtime-directory>",
);
const runtime = resolve(process.argv[2]);
const executable = join(runtime, "personal-assistant-server");
const target = bunPackageTarget();
// FSEvents reports canonical /private/var paths on macOS, not /var aliases.
const temp = realpathSync(mkdtempSync(join(tmpdir(), "pandeck-smoke-")));
const home = join(temp, "home");
const work = join(temp, "work");
const data = join(temp, "data");
for (const path of [home, work]) mkdirSync(path);
const children = new Set();
// Deliberately do not inherit provider credentials, gateway config or real HOME.
const env = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  TMPDIR: temp,
  LANG: "en_US.UTF-8",
  NODE_ENV: "production",
  DATA_DIR: data,
  ASSISTANT_CWD: work,
  ASSISTANT_HOST: "127.0.0.1",
  ASSISTANT_RUNTIME_DIR: runtime,
  ASSISTANT_STT_DISABLED: "1",
  ASSISTANT_SLACK_APP_DISABLED: "1",
};

async function within(promise, label, ms = 30_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          ms,
        );
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

function launch(args, overrides = {}, binary = executable) {
  const child = spawn([binary, ...args], {
    cwd: work,
    env: { ...env, ...overrides },
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  children.add(child);
  const output = Promise.all([
    new globalThis.Response(child.stdout).text(),
    new globalThis.Response(child.stderr).text(),
  ]).then((parts) => parts.join("\n"));
  return { child, output };
}

function signal(child, value) {
  try {
    process.kill(-child.pid, value);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function stop(run) {
  signal(run.child, "SIGTERM");
  assert.equal(await within(run.child.exited, "SIGTERM exit", 10_000), 0);
}

async function refuses(overrides, diagnostic) {
  const run = launch([join(runtime, "server.js")], overrides);
  const code = await within(run.child.exited, "expected boot refusal");
  assert.notEqual(code, 0, "Invalid boot unexpectedly succeeded");
  assert.match(await run.output, diagnostic);
}

async function freePort() {
  const listener = createServer();
  await new Promise((done) => listener.listen(0, "127.0.0.1", done));
  const { port } = listener.address();
  await new Promise((done) => listener.close(done));
  return port;
}

async function boot(port) {
  const run = launch([join(runtime, "server.js")], {
    ASSISTANT_PORT: String(port),
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (run.child.exitCode !== null)
      throw new Error(`Packaged boot failed: ${await run.output}`);
    try {
      const response = await globalThis.fetch(
        `http://127.0.0.1:${port}/api/health`,
        {
          signal: globalThis.AbortSignal.timeout(1000),
        },
      );
      if (response.ok && (await response.json()).ok === true) return run;
    } catch {
      // Listener not ready yet. A child exit is checked on the next pass.
    }
    await sleep(100);
  }
  throw new Error("Timed out: packaged server health");
}

function filesAt(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    assert.notEqual(entry.name, "node_modules");
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesAt(path) : [path];
  });
}

function migrationCount() {
  const database = new Database(join(data, "app.sqlite3"), { readonly: true });
  try {
    return database.query("SELECT COUNT(*) AS n FROM schema_migrations").get()
      .n;
  } finally {
    database.close();
  }
}

try {
  for (const path of [
    executable,
    join(runtime, "claude/claude"),
    join(runtime, "native/watcher.node"),
  ])
    assertNativeBinary(path, target);
  for (const path of [executable, join(runtime, "claude/claude")])
    assert(
      statSync(path).mode & 0o111,
      `Executable permission missing: ${path}`,
    );
  const files = filesAt(runtime);
  for (const path of [
    "LICENSE",
    "NOTICE",
    "server.js",
    "gateway.js",
    "gateway-edge.js",
    "vault.js",
    "codex-renew.js",
    "claude-login.js",
    "codex-login.js",
    "gateway-admin.js",
    "relay.js",
    "config/app.json",
    "config/host-tools.json",
    "config/prompts/assistant.md",
    "web/index.html",
    "gateway-web/gateway.html",
    "web/licenses/third-party-web.md",
    "workers/licenses/elkjs/LICENSE.md",
    "workers/licenses/elkjs/NOTICE.md",
    "workers/initiative-layout-worker.js",
    "workers/xhr-sync-worker.js",
  ])
    assert(
      files.includes(join(runtime, path)),
      `Missing package asset: ${path}`,
    );

  const version = launch(["--version"]);
  assert.equal(await within(version.child.exited, "packaged Bun version"), 0);
  console.log(`Packaged Bun: ${(await version.output).trim()}`);
  // A Bun-compiled CLI must execute directly, not as a JS module.
  const claude = launch(["--version"], {}, join(runtime, "claude/claude"));
  assert.equal(
    await within(claude.child.exited, "native Claude CLI version"),
    0,
  );
  assert.match(await claude.output, /Claude Code/);

  const require = createRequire(import.meta.url);
  const photon = require(join(runtime, "native/photon/photon_rs.js"));
  const image = new photon.PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1);
  assert.equal(image.get_width(), 1);
  image.free();
  const watcher = require(
    join(runtime, "native/watcher-wrapper.js"),
  ).createWrapper(require(join(runtime, "native/watcher.node")));
  const watchDir = join(temp, "watch");
  mkdirSync(watchDir);
  let notify, rejectEvent;
  const event = new Promise((done, reject) => {
    notify = done;
    rejectEvent = reject;
  });
  const subscription = await watcher.subscribe(watchDir, (error, events) => {
    if (error) rejectEvent(error);
    else if (
      events.some((event) => event.path === join(watchDir, "changed.txt"))
    )
      notify();
  });
  try {
    writeFileSync(join(watchDir, "changed.txt"), "native watcher smoke");
    await within(event, "native watcher change", 10_000);
  } finally {
    await subscription.unsubscribe();
  }

  await refuses(
    { ASSISTANT_RUNTIME_DIR: "" },
    /ASSISTANT_RUNTIME_DIR is required/,
  );
  const emptyPath = join(temp, "empty-path");
  mkdirSync(emptyPath);
  await refuses(
    { DATA_DIR: join(temp, "missing-tools"), PATH: emptyPath },
    /Required host tools are missing or too old/,
  );

  const port = await freePort();
  const first = await boot(port);
  const base = `http://127.0.0.1:${port}`;
  const tokenFile = join(data, ".assistant-token");
  const token = readFileSync(tokenFile, "utf8").trim();
  assert(token.length >= 32);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  assert(
    (await (await globalThis.fetch(base)).text()).includes(
      '<div id="root"></div>',
    ),
  );
  assert.equal(
    (await globalThis.fetch(`${base}/api/package-smoke`)).status,
    401,
  );
  assert.equal(
    (
      await globalThis.fetch(`${base}/api/package-smoke`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://hostile.invalid",
        },
      })
    ).status,
    403,
  );
  const socket = new globalThis.WebSocket(
    `ws://127.0.0.1:${port}/ws?token=${token}`,
  );
  try {
    await within(
      new Promise((done, reject) => {
        socket.addEventListener("open", done, { once: true });
        socket.addEventListener("error", reject, { once: true });
      }),
      "authenticated WebSocket",
      10_000,
    );
  } finally {
    socket.close();
  }

  await refuses(
    { ASSISTANT_PORT: String(await freePort()) },
    /Another Pandeck server/,
  );
  await refuses(
    { DATA_DIR: join(temp, "busy-port"), ASSISTANT_PORT: String(port) },
    /EADDRINUSE/,
  );
  const count = migrationCount();
  assert.equal(
    count,
    Object.keys(
      JSON.parse(readFileSync(join(runtime, "migrations.lock.json"), "utf8")),
    ).length,
  );
  await stop(first);
  const second = await boot(port);
  assert.equal(readFileSync(tokenFile, "utf8").trim(), token);
  assert.equal(migrationCount(), count);
  await stop(second);
  assert(
    !existsSync(join(work, "assistant-data")),
    "Boot wrote data under CWD",
  );
  console.log(
    `${target.platform}-${target.arch} package smoke passed: native CLI, watcher, Photon, assets/notices, runtime-root and host-tool gates, loopback boot, auth/origin, WebSocket, data lock, busy port, ${count} migrations, SIGTERM and restart. No provider requests.`,
  );
} finally {
  // Include process groups whose leaders already exited, to reap child processes.
  for (const child of children) signal(child, "SIGTERM");
  try {
    await within(
      Promise.all([...children].map((child) => child.exited)),
      "smoke cleanup",
      5000,
    );
  } catch {
    for (const child of children) signal(child, "SIGKILL");
    await Promise.all([...children].map((child) => child.exited));
  }
  rmSync(temp, { recursive: true, force: true });
}
