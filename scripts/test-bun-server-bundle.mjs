#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import {
  build as bunBuild,
  connect as connectTcp,
  file,
  serve,
  sleep,
  spawn,
  which,
  write,
} from "bun";
import {
  BUN_CJS_PRAGMA,
  BUN_PRAGMA,
  SERVER_BUNDLE_DEFINE,
  bundle,
  serverBundlePlugins,
} from "./bun-bundle.mjs";
import * as childProcessShim from "./bun-shims/node-child-process.mjs";
import { DatabaseSync } from "./bun-shims/node-sqlite.mjs";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverRequire = createRequire(
  new URL("../app/server/package.json", import.meta.url),
);
const { Client } = serverRequire("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = serverRequire(
  "@modelcontextprotocol/sdk/client/stdio.js",
);

const runtimeRoot = resolve(process.argv[2] ?? "");
const directExecutable = join(runtimeRoot, "personal-assistant-server");
const serverModule = join(runtimeRoot, "server.js");
const command = resolve(process.argv[3] ?? directExecutable);
const commandArguments =
  command === directExecutable ? [command, serverModule] : [command];
if (!existsSync(command))
  throw new Error(`Server executable not found: ${command}`);
const runtimeManifest = await file(join(runtimeRoot, "package.json")).json();
const expectedVersion = runtimeManifest.version;
if (typeof expectedVersion !== "string" || !expectedVersion)
  throw new Error("Packaged root manifest has no version.");
const migrationLock = await file(
  join(runtimeRoot, "migrations.lock.json"),
).json();
const expectedMigrationCount = Object.keys(migrationLock).length;
if (expectedMigrationCount === 0)
  throw new Error("Packaged migration lock is empty.");
const browserMcpManifest = await file(
  join(runtimeRoot, "browser-mcp", "package.json"),
).json();
const expectedBrowserMcpVersion = browserMcpManifest.version;
if (typeof expectedBrowserMcpVersion !== "string" || !expectedBrowserMcpVersion)
  throw new Error("Packaged Playwright MCP manifest has no version.");

const temp = mkdtempSync(join(tmpdir(), "pa-bun-runtime-"));
const work = join(temp, "unrelated-workspace");
const data = join(temp, "data");
const token = "bun-bundle-runtime-test-token";
const port = 19000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
mkdirSync(work, { recursive: true });
await write(join(work, ".keep"), "");

function assert(value, message) {
  if (!value) throw new Error(message);
}

/**
 * Every process the check starts, each leading its own process group, so a
 * failed check never leaves a server or its fake Claude CLI running: see
 * {@link terminateChildren}. A spawn broker leads a group of its own and exits
 * when its server's pipe closes.
 */
const children = new Set();

function launch(command, options) {
  const child = spawn(command, { ...options, detached: true });
  children.add(child);
  void child.exited.then(() => children.delete(child));
  return child;
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is gone already.
  }
}

/** SIGTERM every group still running, then SIGKILL what outlives 5 s. */
async function terminateChildren() {
  const running = [...children];
  for (const child of running) signalGroup(child, "SIGTERM");
  const exited = Promise.all(running.map((child) => child.exited));
  if ((await Promise.race([exited, sleep(5000).then(() => "late")])) === "late")
    for (const child of running) signalGroup(child, "SIGKILL");
  await exited;
}

function packageFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = join(prefix, entry.name);
    return entry.isDirectory()
      ? packageFiles(join(directory, entry.name), relative)
      : [relative];
  });
}

const serverEnv = () => ({
  ...process.env,
  ASSISTANT_RUNTIME_DIR: runtimeRoot,
  ASSISTANT_CWD: work,
  ASSISTANT_HOST: "127.0.0.1",
  ASSISTANT_PORT: String(port),
  ASSISTANT_TOKEN: token,
  ASSISTANT_STT_DISABLED: "1",
  ASSISTANT_SLACK_APP_DISABLED: "1",
  DATA_DIR: data,
  NODE_ENV: "production",
});

function start() {
  return launch(commandArguments, {
    cwd: work,
    env: serverEnv(),
    stdout: "inherit",
    stderr: "inherit",
  });
}

async function waitForHealth(child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Server exited during boot (${child.exitCode}).`);
    try {
      const response = await globalThis.fetch(`${baseUrl}/api/health`);
      if (response.ok && (await response.json()).ok === true) return;
    } catch {
      // The listener is not ready yet.
    }
    await sleep(50);
  }
  throw new Error("Timed out waiting for Bun server health.");
}

async function checkWebAndSocket() {
  const web = await globalThis.fetch(baseUrl);
  assert(web.ok, `Web root returned ${web.status}`);
  assert(
    (await web.text()).includes('<div id="root"></div>'),
    "Web root did not serve the packaged Vite shell.",
  );

  await new Promise((accept, reject) => {
    const socket = new globalThis.WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${token}`,
    );
    let ready = false;
    let taskList = false;
    const timer = globalThis.setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for packaged WebSocket round-trip."));
    }, 5000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", topics: ["tasks"] }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "ready") {
        assert(
          message.serverBuild?.version === expectedVersion,
          `Packaged server reported build version ${String(message.serverBuild?.version)} instead of ${expectedVersion}.`,
        );
        const stampedCommit = process.env.ASSISTANT_BUILD_COMMIT?.trim();
        if (stampedCommit && /^[0-9a-f]{40}$/.test(stampedCommit))
          assert(
            message.serverBuild.commit === stampedCommit,
            "Packaged server did not report its stamped build commit.",
          );
        ready = true;
      }
      if (message.type === "taskList") taskList = true;
      if (!ready || !taskList) return;
      globalThis.clearTimeout(timer);
      socket.close();
      accept();
    });
    socket.addEventListener("error", () => {
      globalThis.clearTimeout(timer);
      reject(new Error("Packaged WebSocket upgrade failed."));
    });
  });
}

/**
 * An upgrade with the wrong token is closed within 5 s and never opens.
 * Returns the status line it was answered with, for the log: under Bun there
 * is none, since nothing written to a refused upgrade socket reaches the
 * client.
 */
async function checkRejectedUpgrade() {
  const reply = await new Promise((resolveReply, reject) => {
    let received = "";
    let socket;
    const timer = globalThis.setTimeout(() => {
      socket?.end();
      reject(
        new Error(
          `A wrong-token WebSocket upgrade was not closed within 5s: ${JSON.stringify(received)}`,
        ),
      );
    }, 5000);
    connectTcp({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(opened) {
          socket = opened;
          opened.write(
            "GET /ws?token=wrong HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
              "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
              "Sec-WebSocket-Version: 13\r\n" +
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
          );
        },
        data(_socket, chunk) {
          received += new globalThis.TextDecoder().decode(chunk);
        },
        close() {
          globalThis.clearTimeout(timer);
          resolveReply(received);
        },
      },
    }).catch((error) => {
      globalThis.clearTimeout(timer);
      reject(error);
    });
  });
  assert(
    !reply.includes(" 101 "),
    "The packaged server upgraded a WebSocket with the wrong token.",
  );
  return reply.split("\r\n", 1)[0] || "(connection closed without a status)";
}

/**
 * A granted `/ws/port-forward` session carries bytes both ways through Bun's
 * `ws` server socket, which has no pause/resume. The echo target's reply is
 * larger than one Bun TCP read so it must arrive re-framed within the
 * shell's 64 KiB message limit, and ending the target delivers everything it
 * sent before the normal close. A second session checks that the client's
 * close ends the target connection.
 */
async function checkPortForward() {
  const frameLimit = 64 * 1024;
  const payload = new Uint8Array(1024 * 1024).map((_, index) => index % 251);
  const targetClosed = [];
  const target = createTcpServer((socket) => {
    let received = 0;
    targetClosed.push(new Promise((closed) => socket.once("close", closed)));
    socket.on("data", (chunk) => {
      received += chunk.length;
      if (received < payload.length) socket.write(chunk);
      else socket.end(chunk);
    });
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  try {
    const mint = async () => {
      const response = await globalThis.fetch(
        `${baseUrl}/api/port-forward-grants`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ port: target.address().port }),
        },
      );
      assert(response.status === 201, `Grant mint returned ${response.status}`);
      return (await response.json()).token;
    };
    const open = async () => {
      const socket = new globalThis.WebSocket(
        `ws://127.0.0.1:${port}/ws/port-forward`,
        { headers: { Authorization: `Bearer ${await mint()}` } },
      );
      socket.binaryType = "arraybuffer";
      const frames = [];
      const closed = new Promise((resolveClose) =>
        socket.addEventListener("close", (event) => resolveClose(event.code)),
      );
      socket.addEventListener("message", (event) =>
        frames.push(new Uint8Array(event.data)),
      );
      await new Promise((opened, failed) => {
        socket.addEventListener("open", opened);
        socket.addEventListener("error", () =>
          failed(new Error("The port-forward upgrade failed.")),
        );
      });
      return { socket, frames, closed };
    };
    const within = (promise, what) =>
      Promise.race([
        promise,
        sleep(10_000).then(() => {
          throw new Error(`Timed out waiting for ${what}.`);
        }),
      ]);

    const echo = await open();
    for (let offset = 0; offset < payload.length; offset += 32 * 1024)
      echo.socket.send(payload.subarray(offset, offset + 32 * 1024));
    const code = await within(echo.closed, "the port-forward echo");
    const received = Buffer.concat(echo.frames);
    assert(
      code === 1000,
      `The port-forward target's end closed with ${code}, not 1000.`,
    );
    assert(
      Buffer.from(payload).equals(received),
      `The port-forward echo returned ${received.length} of ${payload.length} bytes, or reordered them.`,
    );
    assert(
      echo.frames.every((frame) => frame.length <= frameLimit),
      "The port-forward server sent a message over the shell's 64 KiB limit.",
    );

    const closing = await open();
    closing.socket.send(new Uint8Array([1, 2, 3]));
    await until(() => closing.frames.length > 0, "the second echo");
    closing.socket.close();
    await within(targetClosed[1], "the target to see the client close");
    return received.length;
  } finally {
    target.close();
  }
}

async function stop(child) {
  child.kill("SIGTERM");
  const code = await child.exited;
  assert(code === 0, `Server shutdown exited with ${code}.`);
}

async function checkMissingRuntimeRoot() {
  const executable = join(runtimeRoot, "personal-assistant-server");
  const env = { ...process.env };
  delete env.ASSISTANT_RUNTIME_DIR;
  const child = launch([executable, serverModule], {
    cwd: work,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new globalThis.Response(child.stdout).text(),
    new globalThis.Response(child.stderr).text(),
  ]);
  assert(code !== 0, "Packaged executable booted without its runtime root.");
  assert(
    `${stdout}\n${stderr}`.includes(
      "ASSISTANT_RUNTIME_DIR is required by the packaged server executable.",
    ),
    "Missing runtime root did not produce the packaged-server diagnostic.",
  );
}

function installedBrowserExecutable() {
  const candidates = [
    process.env.PA_BROWSER_EXECUTABLE_PATH,
    process.env.PLAYWRIGHT_CHROME_EXECUTABLE_PATH,
    which("google-chrome"),
    which("chromium"),
    "/opt/google/chrome/chrome",
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

async function checkBrowserMcpCli() {
  const cli = join(runtimeRoot, "browser-mcp", "cli.js");
  const homeDir = join(temp, "mcp-home");
  const cleanEnv = { HOME: homeDir, TMPDIR: temp, LANG: "C.UTF-8" };
  mkdirSync(homeDir, { recursive: true });

  const child = launch([directExecutable, cli, "--version"], {
    cwd: work,
    env: cleanEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new globalThis.Response(child.stdout).text(),
    new globalThis.Response(child.stderr).text(),
  ]);
  assert(code === 0, `Packaged Playwright MCP CLI failed: ${stderr}`);
  assert(
    stdout.trim() === `Version ${expectedBrowserMcpVersion}`,
    `Packaged Playwright MCP CLI reported an unexpected version: ${stdout}`,
  );

  const outputDir = join(temp, "mcp-output");
  mkdirSync(outputDir, { recursive: true });
  const browserExecutable = installedBrowserExecutable();
  const transport = new StdioClientTransport({
    command: directExecutable,
    args: [
      cli,
      "--output-dir",
      outputDir,
      "--isolated",
      "--headless",
      ...(browserExecutable ? ["--executable-path", browserExecutable] : []),
    ],
    cwd: work,
    env: cleanEnv,
    stderr: "pipe",
  });
  let stderrTail = "";
  transport.stderr?.on("data", (chunk) => {
    stderrTail = `${stderrTail}${String(chunk)}`.slice(-4000);
  });
  const client = new Client(
    { name: "personal-assistant-bun-install-check", version: "1" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert(
      listed.tools.some((tool) => tool.name === "browser_navigate"),
      "Packaged Playwright MCP tools/list omitted browser_navigate.",
    );

    if (!browserExecutable) {
      console.log(
        "Packaged Playwright MCP initialize + tools/list passed; browser launch skipped because the build environment has no Chrome/Chromium.",
      );
      return;
    }

    const pageServer = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new globalThis.Response("<main><h1>Bun browser probe</h1></main>", {
          headers: { "content-type": "text/html" },
        }),
    });
    try {
      const navigation = await client.callTool({
        name: "browser_navigate",
        arguments: { url: `http://127.0.0.1:${pageServer.port}` },
      });
      assert(!navigation.isError, "Packaged Playwright MCP navigation failed.");
      const snapshot = await client.callTool({
        name: "browser_snapshot",
        arguments: {},
      });
      const text = Array.isArray(snapshot.content)
        ? snapshot.content
            .map((block) => (typeof block.text === "string" ? block.text : ""))
            .join("\n")
        : "";
      assert(
        !snapshot.isError && text.includes("Bun browser probe"),
        "Packaged Playwright MCP did not return the navigated page snapshot.",
      );
    } finally {
      pageServer.stop(true);
    }
    console.log(
      "Packaged Playwright MCP initialize + tools/list + browser launch passed.",
    );
  } catch (error) {
    throw new Error(
      `Packaged Playwright MCP protocol check failed: ${error}${stderrTail ? `\n${stderrTail}` : ""}`,
      { cause: error },
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

function throwsMessage(run) {
  try {
    run();
  } catch (error) {
    return String(error);
  }
  return undefined;
}

/**
 * Every Node `node:sqlite` behavior the server relies on that bun:sqlite does
 * differently. `docs/deployment.md` names each; the runtime probe then runs
 * the server's own transaction paths through the bundled shim.
 */
function checkSqliteShim() {
  const location = join(temp, "shim.sqlite3");
  const database = new DatabaseSync(location);
  assert(
    database.prepare("PRAGMA foreign_keys").get().foreign_keys === 1,
    "Bun SQLite adapter did not preserve Node's foreign-key default.",
  );
  assert(
    database.prepare("SELECT 1 WHERE 0").get() === undefined,
    "Bun SQLite adapter did not normalize an absent row to undefined.",
  );
  assert(
    throwsMessage(() =>
      database.prepare("SELECT :id AS id").get({ id: 1 }),
    )?.includes("Bare named parameter"),
    "Bun SQLite adapter silently accepted a bare named parameter.",
  );
  assert(
    database.prepare("SELECT $id AS id").get({ $id: 7 }).id === 7 &&
      database.prepare("SELECT ? AS a, ? AS b").all(1, 2)[0].b === 2,
    "Bun SQLite adapter misbound a named or positional parameter.",
  );
  assert(
    throwsMessage(() =>
      database.prepare("SELECT :x AS a").get({ $x: 1 }),
    )?.includes("Unknown named parameter '$x'") &&
      throwsMessage(() =>
        database.prepare("SELECT :x AS a, ':y' AS s -- :z").get({ ":y": 1 }),
      )?.includes("Unknown named parameter ':y'"),
    "Bun SQLite adapter bound a named parameter the statement does not declare.",
  );
  // Names SQLite reads as one token beyond the supported ASCII grammar are
  // refused by name, not recorded as a shorter name that misreports binds.
  // `:a\u0301` is `a` plus a combining accent: SQLite reads it as one name,
  // so neither its full key nor the truncated `:a` may bind.
  for (const [name, key] of [
    ["$foo::bar"],
    ["$foo(bar)"],
    ["$foo::bar(baz)"],
    [":a$b"],
    [":\u00e1"],
    [":a\u0301"],
    [":a\u0301", ":a"],
    [":\u2603"],
  ])
    assert(
      throwsMessage(() =>
        database.prepare(`SELECT ${name} AS v`).get({ [key ?? name]: 1 }),
      )?.includes(`Unsupported named parameter syntax "${name}"`),
      `Bun SQLite adapter did not refuse the named parameter ${JSON.stringify(name)} bound as ${JSON.stringify(key ?? name)}.`,
    );
  assert(
    database
      .prepare("SELECT @x_1 AS a, $y AS b, ':a$b' AS s -- $foo::bar")
      .get({ "@x_1": 1, $y: 2 }).b === 2,
    "Bun SQLite adapter misread a supported name or one inside a string or comment.",
  );
  assert(
    database.prepare("SELECT :x AS a, :y AS b").get({ ":x": 1 }).b === null,
    "Bun SQLite adapter refused a named parameter left unbound, as Node binds NULL.",
  );
  assert(
    database.prepare("SELECT 9007199254740991 AS max").get().max ===
      Number.MAX_SAFE_INTEGER &&
      throwsMessage(() =>
        database.prepare("SELECT 9007199254740992 AS big").get(),
      )?.startsWith("RangeError: Value is too large") &&
      throwsMessage(() =>
        database.prepare("SELECT 9223372036854775807 AS big").all(),
      )?.startsWith("RangeError: Value is too large"),
    "Bun SQLite adapter read an integer past 2^53 instead of refusing it.",
  );
  assert(
    database.prepare("SELECT ? AS blob").get(new Uint8Array([1, 2])).blob
      .length === 2,
    "Bun SQLite adapter read a BLOB parameter as named parameters.",
  );
  database.exec("-- a comments-only script is a no-op, as in Node");

  database.exec(`
    CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE child (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parent (id) ON DELETE CASCADE
    );
    CREATE TABLE audit (parent_id INTEGER);
    CREATE TRIGGER parent_deleted AFTER DELETE ON parent
      BEGIN INSERT INTO audit (parent_id) VALUES (OLD.id); END;
    INSERT INTO parent (id, name) VALUES (1, 'a'), (2, 'b');
    INSERT INTO child (parent_id) VALUES (1), (1), (1);
  `);
  // Node reports the statement's own rows; Bun would add the three cascaded
  // children and the audit row (workflow run deletion checks for exactly 1).
  const removed = database.prepare("DELETE FROM parent WHERE id = ?").run(1);
  assert(
    removed.changes === 1,
    `Bun SQLite adapter counted ${removed.changes} changes for a one-row delete.`,
  );
  const inserted = database
    .prepare("INSERT INTO parent (name) VALUES (?)")
    .run("c");
  assert(
    inserted.changes === 1 && inserted.lastInsertRowid === 3,
    `Bun SQLite adapter reported ${JSON.stringify(inserted)} for an insert.`,
  );
  assert(
    database
      .prepare("UPDATE parent SET name = ? WHERE id = ? RETURNING id")
      .get("d", 3).id === 3,
    "Bun SQLite adapter lost a RETURNING row.",
  );
  assert(
    [...database.prepare("SELECT id FROM parent ORDER BY id").iterate()]
      .map((row) => row.id)
      .join() === "2,3",
    "Bun SQLite adapter iterated the wrong rows.",
  );

  assert(!database.isTransaction, "isTransaction is true outside one.");
  database.exec("BEGIN IMMEDIATE");
  assert(database.isTransaction, "isTransaction is false inside BEGIN.");
  database.exec("ROLLBACK");
  database.exec("SAVEPOINT probe");
  assert(database.isTransaction, "isTransaction is false inside a SAVEPOINT.");
  database.exec("RELEASE probe");
  assert(!database.isTransaction, "isTransaction stayed true after RELEASE.");

  // PRAGMA data_version moves when ANOTHER connection commits (#369).
  database.exec("PRAGMA journal_mode = WAL");
  const version = () =>
    database.prepare("PRAGMA data_version").get().data_version;
  const before = version();
  const other = new DatabaseSync(location);
  other.prepare("INSERT INTO parent (name) VALUES (?)").run("e");
  other.close();
  assert(version() !== before, "PRAGMA data_version ignored another commit.");

  for (const [member, run] of [
    ["DatabaseSync.function", () => database.function("f", () => 1)],
    ["StatementSync.columns", () => database.prepare("SELECT 1").columns()],
    ["option", () => new DatabaseSync(":memory:", { timeout: 1 })],
  ])
    assert(
      throwsMessage(run)?.includes("not supported by the Bun SQLite adapter"),
      `Bun SQLite adapter did not refuse an unsupported ${member}.`,
    );
  database.close();

  const readOnly = new DatabaseSync(location, { readOnly: true });
  assert(
    throwsMessage(() => readOnly.exec("DELETE FROM parent")),
    "A read-only Bun SQLite connection accepted a write.",
  );
  readOnly.close();
}

/** The child_process shim restores Node's live `process.env` default. */
function checkChildProcessShim() {
  process.env.PA_SHIM_ADDED = "added";
  const script = 'printf "%s" "${PA_SHIM_ADDED:-none}"';
  const { execFileSync, execSync, spawnSync } = childProcessShim;
  for (const [shape, run] of [
    ["spawnSync(file, args)", () => spawnSync("sh", ["-c", script]).stdout],
    [
      "spawnSync(file, options)",
      () => spawnSync("sh", { input: script }).stdout,
    ],
    [
      "execFileSync(file, null, options)",
      () => execFileSync("sh", null, { input: script }),
    ],
    ["execSync(command)", () => execSync(script)],
    [
      "spawnSync(file, args, { env: null })",
      () => spawnSync("sh", ["-c", script], { env: null }).stdout,
    ],
    [
      "execFileSync(file, args, { env: null })",
      () => execFileSync("sh", ["-c", script], { env: null }),
    ],
    ["execSync(command, { env: null })", () => execSync(script, { env: null })],
  ]) {
    const seen = String(run());
    assert(seen === "added", `The child_process shim broke ${shape}: ${seen}`);
  }
  for (const [env, expected] of [
    [{ PA_SHIM_ADDED: "explicit" }, "explicit"],
    [{}, "none"],
  ])
    assert(
      String(execFileSync("/bin/sh", ["-c", script], { env })) === expected,
      `The child_process shim overrode an explicit env ${JSON.stringify(env)}.`,
    );
  delete process.env.PA_SHIM_ADDED;
}

async function checkCompiledPhoton() {
  const entrypoint = join(temp, "compiled-photon-probe.mjs");
  const executable = join(temp, "compiled-photon-probe");
  const shim = fileURLToPath(
    new URL("./bun-shims/photon-node.mjs", import.meta.url),
  );
  await write(
    entrypoint,
    `import { PhotonImage } from ${JSON.stringify(shim)};\n` +
      "const image = new PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1);\n" +
      "if (image.get_width() !== 1) throw new Error('bad Photon width');\n" +
      "image.free();\n",
  );
  const result = await bunBuild({
    compile: { outfile: executable },
    entrypoints: [entrypoint],
    minify: true,
    target: "bun",
  });
  assert(result.success, "Could not compile the packaged Photon probe.");
  const probe = launch([executable], {
    env: { ...process.env, ASSISTANT_RUNTIME_DIR: runtimeRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    probe.exited,
    new globalThis.Response(probe.stderr).text(),
  ]);
  assert(code === 0, `Compiled Photon probe failed: ${stderr}`);
}

async function checkNativeAssets() {
  const photonBytes = await file(
    join(runtimeRoot, "native", "photon", "photon_rs_bg.wasm"),
  ).arrayBuffer();
  new globalThis.WebAssembly.Module(photonBytes);

  const require = createRequire(import.meta.url);
  const photon = require(join(runtimeRoot, "native", "photon", "photon_rs.js"));
  const image = new photon.PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1);
  assert(
    image.get_width() === 1,
    "Packaged Photon module did not load its WASM.",
  );
  image.free();

  const binding = require(join(runtimeRoot, "native", "watcher.node"));
  const wrapper = require(join(runtimeRoot, "native", "watcher-wrapper.js"));
  const watcher = wrapper.createWrapper(binding);
  const watchDir = join(temp, "watcher");
  mkdirSync(watchDir);
  const seen = [];
  let notify;
  const event = new Promise((resolveEvent) => {
    notify = resolveEvent;
  });
  const subscription = await watcher.subscribe(
    watchDir,
    (error, events) => {
      if (error) throw error;
      seen.push(...events.map((entry) => entry.path));
      if (events.length > 0) notify();
    },
    { ignore: ["**/*.ignored"] },
  );
  await write(join(watchDir, "noise.ignored"), "ignored");
  await sleep(100);
  await write(join(watchDir, "event.txt"), "watched");
  await Promise.race([
    event,
    sleep(5000).then(() => {
      throw new Error("Packaged watcher addon did not report a file change.");
    }),
  ]);
  await subscription.unsubscribe();
  assert(
    !seen.some((path) => path.endsWith("noise.ignored")),
    "Packaged watcher wrapper did not preserve glob ignores.",
  );
}

const AMBIENT_PROXY_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

/** Bun loads a bundle as it stands only under its pragma: see bun-bundle.mjs. */
async function checkBunPragma() {
  for (const [bundled, pragma] of [
    ["server.js", BUN_PRAGMA],
    ["workers/xhr-sync-worker.js", BUN_PRAGMA],
    ["native/watcher-wrapper.js", BUN_CJS_PRAGMA],
  ]) {
    const firstLine = (await file(join(runtimeRoot, bundled)).text()).split(
      "\n",
      1,
    )[0];
    assert(
      firstLine === pragma,
      `${bundled} starts with ${JSON.stringify(firstLine)}, not ${JSON.stringify(pragma)}.`,
    );
  }
}

/**
 * Parse and link `server.js` under the packaged Bun, and nothing more. An ES
 * module is parsed and linked whole before its first statement runs, so a copy
 * whose first statement after the banner reports the process's peak RSS and
 * exits measures exactly that. Without the pragma, Bun's runtime transpiler
 * peaked at about 1.6 GB here; with it, 130–180 MB.
 */
const PARSE_LINK_MAX_RSS_KB = 300 * 1024;

async function checkParseLinkMemory() {
  const source = await file(serverModule).text();
  const bannerEnd = source.indexOf("\n", source.indexOf("\n") + 1) + 1;
  const marker = "pa-parse-link-peak-kb";
  const report =
    `console.log(${JSON.stringify(marker)},` +
    '/VmHWM:\\s*(\\d+)/.exec(require("node:fs").readFileSync("/proc/self/status","utf8"))[1]);' +
    "process.exit(0);\n";
  const probe = join(temp, "server-parse-link.js");
  await write(
    probe,
    `${source.slice(0, bannerEnd)}${report}${source.slice(bannerEnd)}`,
  );
  const child = launch([directExecutable, probe], {
    cwd: work,
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new globalThis.Response(child.stdout).text(),
    new globalThis.Response(child.stderr).text(),
  ]);
  const peakKb = Number(
    new RegExp(`^${marker} (\\d+)$`, "m").exec(stdout)?.[1] ?? NaN,
  );
  assert(
    code === 0 && Number.isFinite(peakKb),
    `The parse+link copy of server.js did not report its peak RSS (${code}): ${stdout.slice(-500)}${stderr.slice(-2000)}`,
  );
  assert(
    peakKb < PARSE_LINK_MAX_RSS_KB,
    `Parsing and linking server.js peaked at ${Math.round(peakKb / 1024)} MB RSS (limit ${PARSE_LINK_MAX_RSS_KB / 1024} MB): is ${JSON.stringify(BUN_PRAGMA)} still its first line?`,
  );
  console.log(
    `server.js parse+link peak RSS: ${Math.round(peakKb / 1024)} MB.`,
  );
}

/**
 * Server code a booted server reaches only on demand (git through the spawn
 * broker, the watcher, the SQLite transaction paths), bundled with the
 * server's own plugins and run by the packaged Bun: see bun-runtime-probe.mjs.
 */
async function runRuntimeProbes() {
  assert(which("git"), "The runtime probe needs git on PATH.");
  const probe = join(temp, "runtime-probe.js");
  await write(
    probe,
    await bundle(
      fileURLToPath(new URL("./bun-runtime-probe.mjs", import.meta.url)),
      { define: SERVER_BUNDLE_DEFINE, plugins: serverBundlePlugins() },
    ),
  );
  for (const mode of ["broker", "in-process"]) {
    const probeData = join(temp, `probe-${mode}`);
    const home = join(probeData, "home");
    mkdirSync(home, { recursive: true });
    // A ChatGPT credential pi derives auth from offline: the probe's OAuth
    // check needs it in place before `piSdk/models.ts` loads.
    const piAgent = join(
      probeData,
      "credential-profiles",
      "default",
      "pi-agent",
    );
    mkdirSync(piAgent, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(piAgent, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "bun-probe-access",
          refresh: "bun-probe-refresh",
          expires: Date.now() + 24 * 60 * 60 * 1000,
          accountId: "bun-probe-account",
        },
      }),
      { mode: 0o600 },
    );
    const env = {
      ...process.env,
      ASSISTANT_RUNTIME_DIR: runtimeRoot,
      ASSISTANT_CWD: work,
      DATA_DIR: probeData,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      NODE_ENV: "production",
      PA_PROBE_SCRUBBED: "leaked",
    };
    // The probe tells its package proxy's traffic from direct traffic; a proxy
    // the check itself inherited would blur that.
    for (const key of AMBIENT_PROXY_VARIABLES) delete env[key];
    if (mode === "in-process") env.ASSISTANT_SPAWN_BROKER = "0";
    else delete env.ASSISTANT_SPAWN_BROKER;
    const child = launch([directExecutable, probe, mode], {
      cwd: work,
      env,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await child.exited;
    assert(code === 0, `Bun runtime probe (${mode}) exited with ${code}.`);
  }
}

const claudeProfile = "bun-check";

/**
 * What the lifecycle boot needs in its data directory: Claude sessions on and
 * one PA-isolated Claude credential profile.
 */
function seedDataDir() {
  const now = Date.now();
  mkdirSync(join(data, "settings"), { recursive: true });
  writeFileSync(
    join(data, "settings", "app.json"),
    JSON.stringify({ claudeSdk: { enabled: true } }),
  );
  mkdirSync(join(data, "credential-profiles"), { recursive: true });
  writeFileSync(
    join(data, "credential-profiles", "profiles.json"),
    JSON.stringify([
      {
        id: claudeProfile,
        name: "Bun check",
        provider: "claude",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ]),
  );
}

/** A JSON WebSocket client that waits for messages in arrival order. */
async function connect() {
  const socket = new globalThis.WebSocket(
    `ws://127.0.0.1:${port}/ws?token=${token}`,
  );
  const messages = [];
  const waiting = new Set();
  let cursor = 0;
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
    for (const check of waiting) check();
  });
  await new Promise((opened, failed) => {
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener(
      "error",
      () => failed(new Error("Packaged WebSocket upgrade failed.")),
      { once: true },
    );
  });
  const next = (predicate, what, timeoutMs = 20_000) =>
    new Promise((found, failed) => {
      const check = () => {
        const index = messages.findIndex(
          (message, at) => at >= cursor && predicate(message),
        );
        if (index < 0) return;
        cursor = index + 1;
        done();
        found(messages[index]);
      };
      const timer = globalThis.setTimeout(() => {
        done();
        failed(
          new Error(
            `Timed out waiting for ${what}; last messages: ${messages
              .slice(-8)
              .map((message) => message.type)
              .join(", ")}`,
          ),
        );
      }, timeoutMs);
      const done = () => {
        globalThis.clearTimeout(timer);
        waiting.delete(check);
      };
      waiting.add(check);
      check();
    });
  await next((message) => message.type === "ready", "ready");
  return {
    send: (message) => socket.send(JSON.stringify(message)),
    next,
    close: () => socket.close(),
  };
}

/** Collect a child's stdout line by line while still showing it. */
function collectLines(stream) {
  const lines = [];
  const decoder = new globalThis.TextDecoder();
  let pending = "";
  void (async () => {
    for await (const chunk of stream) {
      process.stdout.write(chunk);
      pending += decoder.decode(chunk, { stream: true });
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      lines.push(...parts);
    }
  })();
  return lines;
}

async function until(predicate, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what}.`);
    await sleep(50);
  }
}

function fakeClaudeRecords() {
  const path = join(
    data,
    "credential-profiles",
    claudeProfile,
    "claude",
    "fake-claude.jsonl",
  );
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

/** The CLI process that answered `prompt` exited; what it recorded. */
async function fakeTurnCompleted(prompt) {
  await until(
    () =>
      fakeClaudeRecords().some(
        (record) => record.exited && record.turns.includes(prompt),
      ),
    `the fake Claude CLI to answer "${prompt}" and exit`,
  );
  const records = fakeClaudeRecords();
  const { pid } = records.find((record) => record.turns?.includes(prompt));
  return Object.assign({}, ...records.filter((record) => record.pid === pid));
}

function textOf(entry) {
  return (entry.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

/**
 * The session as a NEW connection loading it gets it: a connection already
 * viewing a session is sent no second snapshot.
 */
async function loadSnapshot(sessionId, prompts) {
  const client = await connect();
  client.send({ type: "loadSession", id: sessionId });
  const { state, snapshot } = await client.next(
    (message) =>
      message.type === "snapshot" && message.state.sessionId === sessionId,
    `the snapshot of ${sessionId}`,
  );
  assert(
    state.harness === "claude-sdk" &&
      state.model?.id === "opus" &&
      state.thinkingLevel === "high",
    `The session opened as ${state.harness} with model ${state.model?.id} and thinking ${state.thinkingLevel}.`,
  );
  const replies = snapshot.timeline
    .filter((entry) => entry.role === "assistant")
    .map(textOf);
  for (const prompt of prompts)
    assert(
      replies.includes(`Fake reply to: ${prompt}`),
      `The opened timeline lacks the reply to "${prompt}": ${replies}`,
    );
  return client;
}

/**
 * One Claude session, start to delete, through the packaged server with the
 * fake Claude CLI: the first turn, its release from memory once nobody views
 * it, a reader reopening it from storage and then leaving (released again), a
 * resumed second turn, and the atomic delete. Every open must show the model
 * and thinking level the session was created with (#374).
 */
async function checkSessionLifecycle(output) {
  const sessionId = "bun-check-claude-session";
  const released = (why) =>
    output.filter((line) =>
      line.includes(`[sessions] released ${sessionId}: ${why}`),
    ).length;

  const creator = await connect();
  creator.send({
    type: "harnessSend",
    id: sessionId,
    harness: "claude-sdk",
    agentType: "workshop",
    text: "first turn",
    modelId: "opus",
    thinkingLevel: "high",
    credentialProfileId: claudeProfile,
  });
  const first = await fakeTurnCompleted("first turn");
  assert(!first.resumed, "The first Claude turn resumed a session.");
  const resident = await loadSnapshot(sessionId, ["first turn"]);
  creator.close();
  resident.close();
  await until(
    () => released("its harness went idle") === 1,
    "the idle Claude session to be released",
  );

  const reader = await loadSnapshot(sessionId, ["first turn"]);
  reader.close();
  await until(
    () => released("its last view closed") === 1,
    "the reader's detached view to be released",
  );

  const driver = await loadSnapshot(sessionId, ["first turn"]);
  driver.send({ type: "prompt", text: "second turn" });
  const second = await fakeTurnCompleted("second turn");
  assert(
    second.resumed && second.sessionId === first.sessionId,
    "The second Claude turn did not resume the first turn's session.",
  );
  (await loadSnapshot(sessionId, ["first turn", "second turn"])).close();
  driver.send({ type: "deleteSession", id: sessionId });
  await driver.next(
    (message) =>
      message.type === "sessionViewCleared" &&
      message.sessionId === sessionId &&
      message.reason === "deleted",
    "the session delete",
  );
  driver.close();
  return sessionId;
}

/**
 * Diagnostics the Bun package answers differently from Node: the memory line
 * names its runtime, and SIGUSR1 writes a private heap snapshot where Bun's
 * default action would end the process, but not twice within a minute.
 */
async function checkDiagnostics(child, output) {
  assert(
    output.some((line) => line.startsWith("[memory] runtime=bun-")),
    "The packaged server's memory line does not name the Bun runtime.",
  );
  process.kill(child.pid, "SIGUSR1");
  let written;
  await until(() => {
    written = output
      .map((line) => /^\[memory\] heap snapshot written to (\S+)/.exec(line))
      .find(Boolean)?.[1];
    return written !== undefined;
  }, "the SIGUSR1 heap snapshot");
  assert(child.exitCode === null, "SIGUSR1 ended the packaged server.");
  // A second signal inside the minimum interval writes nothing.
  process.kill(child.pid, "SIGUSR1");
  await until(
    () =>
      output.some((line) =>
        line.startsWith("[memory] heap snapshot skipped: the last one started"),
      ),
    "the second SIGUSR1 to be refused",
  );
  assert(
    readdirSync(dirname(written)).length === 1,
    "A refused SIGUSR1 still wrote a heap snapshot.",
  );
  assert(
    (statSync(written).mode & 0o777) === 0o600 &&
      (statSync(dirname(written)).mode & 0o777) === 0o700,
    "The heap snapshot is readable beyond its owner.",
  );
  assert(
    (await file(written).slice(0, 32).text()).startsWith('{"snapshot":{"meta"'),
    "The heap snapshot is not in the V8 format DevTools loads.",
  );
  const health = await globalThis.fetch(`${baseUrl}/api/health`);
  assert(health.ok, "The packaged server stopped answering after SIGUSR1.");
}

/** The packaged server marks a deleted session in the same database. */
function checkSessionDeleted(sessionId) {
  const database = new Database(join(data, "app.sqlite3"), { readonly: true });
  const row = database
    .query("SELECT deleted_at_ms FROM session_index WHERE id = ?")
    .get(sessionId);
  database.close();
  assert(
    row && row.deleted_at_ms !== null,
    "The deleted session is still live in session_index.",
  );
}

/**
 * The lifecycle boot runs the same server module through the packaged Bun,
 * with the check's grace preload and the fake Claude CLI in place of the
 * packaged one. Output is collected for the release lines.
 */
async function startLifecycleServer() {
  const serverTemp = join(temp, "server-tmp");
  mkdirSync(serverTemp, { recursive: true });
  const fakeCli = join(temp, "fake-claude");
  await write(
    fakeCli,
    `#!/bin/sh\nexec ${JSON.stringify(directExecutable)} ${JSON.stringify(
      fileURLToPath(new URL("./fake-claude-cli.mjs", import.meta.url)),
    )} "$@"\n`,
  );
  chmodSync(fakeCli, 0o755);
  const child = launch(
    [
      directExecutable,
      "--preload",
      fileURLToPath(new URL("./bun-check-short-graces.mjs", import.meta.url)),
      serverModule,
    ],
    {
      cwd: work,
      env: {
        ...serverEnv(),
        ASSISTANT_CLAUDE_CLI_BIN: fakeCli,
        TMPDIR: serverTemp,
      },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  return { child, output: collectLines(child.stdout) };
}

try {
  await checkMissingRuntimeRoot();
  await checkBrowserMcpCli();
  checkSqliteShim();
  checkChildProcessShim();
  await checkCompiledPhoton();

  const files = packageFiles(runtimeRoot);
  assert(
    !files.some((path) => path.includes("node_modules")),
    "node_modules shipped in Bun package.",
  );
  assert(
    !files.some((path) => basename(path) === "tsx"),
    "tsx shipped in Bun package.",
  );
  assert(
    !files.some((path) => basename(path) === "node"),
    "Node shipped in Bun package.",
  );
  for (const required of [
    "LICENSE",
    "NOTICE",
    "package.json",
    "server.js",
    "browser-mcp/cli.js",
    "browser-mcp/package.json",
    "browser-mcp/playwright-core/package.json",
    "claude/claude",
    "config/app.json",
    "config/host-tools.json",
    "config/prompts/assistant.md",
    "config/stt-models.json",
    "migrations.lock.json",
    "native/photon/photon_rs.js",
    "native/photon/photon_rs_bg.wasm",
    "native/watcher-wrapper.js",
    "native/watcher.node",
    "personal-assistant-server",
    "web/index.html",
    "workers/xhr-sync-worker.js",
  ])
    assert(
      files.includes(required),
      `Missing packaged runtime asset: ${required}`,
    );

  // Bun.spawnSync starts its child with the start-up environment whatever
  // process.env holds now, and no shim covers it. Server code cannot name it
  // (its types are Node's); this keeps it out of every bundled dependency.
  for (const bundled of ["server.js", "workers/xhr-sync-worker.js"])
    assert(
      !/\bBun\s*(?:\.\s*spawnSync\b|\[\s*["'`]spawnSync)/.test(
        await file(join(runtimeRoot, bundled)).text(),
      ),
      `${bundled} calls Bun.spawnSync, which leaks the start-up environment.`,
    );

  await checkBunPragma();
  await checkParseLinkMemory();
  await checkNativeAssets();
  await runRuntimeProbes();

  seedDataDir();
  const first = start();
  await waitForHealth(first);
  await checkWebAndSocket();
  console.log(
    `Wrong-token WebSocket upgrade answered: ${await checkRejectedUpgrade()}`,
  );
  console.log(
    `Port-forward echo round-tripped ${await checkPortForward()} bytes.`,
  );
  const processExe = realpathSync(readlinkSync(`/proc/${first.pid}/exe`));
  assert(
    processExe === realpathSync(join(runtimeRoot, "personal-assistant-server")),
    `Server process is not the Bun executable: ${processExe}`,
  );
  await stop(first);

  const database = new Database(join(data, "app.sqlite3"), { readonly: true });
  const firstMigrationCount = database
    .query("SELECT COUNT(*) AS count FROM schema_migrations")
    .get().count;
  database.close();
  assert(
    firstMigrationCount === expectedMigrationCount,
    `Fresh database applied ${firstMigrationCount} of ${expectedMigrationCount} packaged migrations.`,
  );

  const second = await startLifecycleServer();
  await waitForHealth(second.child);
  const deletedSession = await checkSessionLifecycle(second.output);
  await checkDiagnostics(second.child, second.output);
  await stop(second.child);
  checkSessionDeleted(deletedSession);
  const restarted = new Database(join(data, "app.sqlite3"), { readonly: true });
  const restartedMigrationCount = restarted
    .query("SELECT COUNT(*) AS count FROM schema_migrations")
    .get().count;
  restarted.close();
  assert(
    restartedMigrationCount === firstMigrationCount,
    "Restart changed the applied migration set.",
  );

  console.log(
    `Bun bundle runtime passed: fresh DB, web, WebSocket, restart, ${firstMigrationCount} migrations, Claude session lifecycle, SIGUSR1 heap snapshot, runtime probes, package-proxy env only for children, Bun pragma and parse+link RSS, Playwright MCP, native process identity, explicit assets only.`,
  );
} finally {
  await terminateChildren();
  rmSync(temp, { recursive: true, force: true });
}
