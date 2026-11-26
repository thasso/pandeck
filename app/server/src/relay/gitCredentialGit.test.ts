/**
 * The documented gitconfig block against a real git (Task-1446 plan v03 V5,
 * AC7): the empty `helper =` drops helpers from files git read earlier, so
 * an earlier store helper never sees the token, while the relay's helper
 * answers `get` and ignores `store`. Positive controls prove the sentinels
 * are live, so the assertions cannot pass vacuously. Git's whole
 * configuration is the test's own two files; every value is fake.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, test } from "vitest";
import {
  CLIENT_METHODS,
  GATEWAY_CLIENT_PROTOCOL,
} from "../gateway/clientMethods.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerConnection,
  WorkerMethodError,
} from "../workerProtocol/connection.ts";
import { socketEndpoint } from "../workerProtocol/unixSocketTransport.ts";
import { GIT_CREDENTIAL_LINES } from "./gitCredential.ts";

const run = promisify(execFile);
const TOKEN = "fake-install-token-git";
const URL_INPUT = "url=https://github.com/fake-owner/fake-repo.git\n\n";

let dir: string;
let marker: string;
let systemFile: string;
let globalFile: string;
const servers: net.Server[] = [];
const connections: WorkerConnection[] = [];
let skipReason: string | undefined;

/** A fake edge answering every `git.credential` with `answer`. */
function fakeEdge(
  name: string,
  answer: () => Promise<Payload>,
): Promise<string> {
  const path = join(dir, `${name}.sock`);
  const server = net.createServer((socket) => {
    connections.push(
      new WorkerConnection(socketEndpoint(socket), {
        protocol: GATEWAY_CLIENT_PROTOCOL,
        handshake: { role: "server", admit: () => undefined },
        handlers: { [CLIENT_METHODS.gitCredential]: () => answer() },
      }),
    );
  });
  servers.push(server);
  return new Promise((ready) => server.listen(path, () => ready(path)));
}

function script(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** The relay's helper for `socket`, as the docs' `!<command>` runs it. */
function relayShim(name: string, socket: string): string {
  const tsx = import.meta.resolve("tsx");
  return script(
    name,
    `exec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(tsx)} ${JSON.stringify(resolve("src", "relay/main.ts"))} git-credential --socket ${JSON.stringify(socket)} "$@"`,
  );
}

const env = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: join(dir, "home"),
  XDG_CONFIG_HOME: join(dir, "xdg"),
  GIT_CONFIG_SYSTEM: systemFile,
  GIT_CONFIG_GLOBAL: globalFile,
  GIT_TERMINAL_PROMPT: "0",
});

function git(
  args: string[],
  input: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn("git", args, { cwd: join(dir, "home"), env: env() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => done({ code, stdout, stderr }));
    // Git may exit without reading stdin (`git config` never does); the
    // write then fails with EPIPE, which says nothing about the answer.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const markers = (): string[] =>
  existsSync(marker)
    ? readFileSync(marker, "utf8").split("\n").filter(Boolean)
    : [];

/** The block as `docs/workers.md` gives it, then sentinel L after it. */
function writeGlobal(block: string[]): void {
  writeFileSync(
    globalFile,
    [
      '[credential "https://github.com"]',
      ...block.map((line) => `\t${line}`),
      '[credential "https://github.com"]',
      `\thelper = "!${join(dir, "sentinel-l")}"`,
      "",
    ].join("\n"),
  );
  rmSync(marker, { force: true });
}

let okSocket: string;
let deniedSocket: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "relay-gitcfg-"));
  for (const sub of ["home", "xdg"]) mkdirSync(join(dir, sub));
  marker = join(dir, "marker");
  systemFile = join(dir, "system.gitconfig");
  globalFile = join(dir, "global.gitconfig");
  script(
    "sentinel-s",
    `echo "S $1" >> ${JSON.stringify(marker)}\ncat >/dev/null`,
  );
  script(
    "sentinel-l",
    `echo "L $1" >> ${JSON.stringify(marker)}\ncat >/dev/null\nif [ "$1" = get ]; then printf 'username=sentinel\\npassword=sentinel\\n'; fi`,
  );
  script("silent", "cat >/dev/null");
  writeFileSync(
    systemFile,
    `[credential]\n\thelper = "!${join(dir, "sentinel-s")}"\n`,
  );
  okSocket = await fakeEdge("ok", () =>
    Promise.resolve({
      json: { token: TOKEN, expiresAt: Date.now() + 3_600_000 },
    }),
  );
  deniedSocket = await fakeEdge("denied", () => {
    throw new WorkerMethodError("git_denied", "SENTINEL-EDGE-TEXT");
  });
  relayShim("relay-ok", okSocket);
  relayShim("relay-denied", deniedSocket);

  // Precondition: git is there, new enough for GIT_CONFIG_GLOBAL/SYSTEM, and
  // reads credential settings from the test's two files only.
  try {
    const { stdout } = await run("git", ["--version"]);
    const [, major, minor] = /(\d+)\.(\d+)/.exec(stdout) ?? [];
    if (Number(major) < 2 || (Number(major) === 2 && Number(minor) < 32))
      skipReason = `git too old: ${stdout.trim()}`;
  } catch {
    skipReason = "git is not installed";
  }
  if (!skipReason) {
    writeGlobal([
      "helper =",
      `helper = "!${join(dir, "relay-ok")}"`,
      "useHttpPath = true",
    ]);
    const listed = await git(
      ["config", "--show-origin", "--get-regexp", "^credential\\."],
      "",
    );
    const origins = new Set(
      listed.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t")[0]),
    );
    const expected = new Set([`file:${systemFile}`, `file:${globalFile}`]);
    const other = [...origins].filter((origin) => !expected.has(origin!));
    if (other.length > 0 || origins.size !== 2)
      skipReason = `unexpected git config origins: ${[...origins].join(", ")}`;
  }
  if (skipReason) console.log(`[gitCredentialGit] skipped: ${skipReason}`);
});

afterAll(async () => {
  for (const connection of connections) connection.end("test done");
  await Promise.all(
    servers.map((server) => new Promise((done) => server.close(done))),
  );
  rmSync(dir, { recursive: true, force: true });
});

const BLOCK = (helper: string, useHttpPath = true) => [
  "helper =",
  `helper = "!${join(dir, helper)}"`,
  ...(useHttpPath ? ["useHttpPath = true"] : []),
];

test("P1 control: without the empty helper line, the earlier store helper gets the approved credential", async (context) => {
  if (skipReason) return context.skip();
  writeGlobal(BLOCK("relay-ok").slice(1));
  const filled = await git(["credential", "fill"], URL_INPUT);
  assert.equal(filled.code, 0, filled.stderr);
  await git(["credential", "approve"], filled.stdout);
  assert.ok(markers().includes("S store"), markers().join(";"));
}, 60_000);

test("P2 control: with a helper that answers nothing, git asks the later helper", async (context) => {
  if (skipReason) return context.skip();
  writeGlobal(BLOCK("silent"));
  await git(["credential", "fill"], URL_INPUT);
  assert.ok(markers().includes("L get"), markers().join(";"));
}, 60_000);

test("the documented block: fill gets the relay's token; approve never reaches the earlier store helper", async (context) => {
  if (skipReason) return context.skip();
  writeGlobal(BLOCK("relay-ok"));
  const filled = await git(["credential", "fill"], URL_INPUT);
  assert.equal(filled.code, 0, filled.stderr);
  assert.match(filled.stdout, /^username=x-access-token$/m);
  assert.match(filled.stdout, new RegExp(`^password=${TOKEN}$`, "m"));
  const approved = await git(["credential", "approve"], filled.stdout);
  assert.equal(approved.code, 0, approved.stderr);
  const seen = markers();
  assert.ok(!seen.some((line) => line.startsWith("S ")), seen.join(";"));
  assert.ok(!seen.includes("L get"), "the relay answered first");
  assert.ok(seen.includes("L store"), "the later helper is still called");
}, 60_000);

test("a refusal stops git: no password, no later helper asked, the relay's denied line on stderr", async (context) => {
  if (skipReason) return context.skip();
  writeGlobal(BLOCK("relay-denied"));
  const filled = await git(["credential", "fill"], URL_INPUT);
  assert.notEqual(filled.code, 0);
  assert.ok(!filled.stdout.includes("password="));
  assert.ok(!markers().includes("L get"), markers().join(";"));
  assert.ok(
    filled.stderr.includes(GIT_CREDENTIAL_LINES.git_denied),
    filled.stderr,
  );
  assert.ok(!filled.stderr.includes("SENTINEL-EDGE-TEXT"));
}, 60_000);

test("without useHttpPath the relay refuses with the hint", async (context) => {
  if (skipReason) return context.skip();
  writeGlobal(BLOCK("relay-ok", false));
  const filled = await git(["credential", "fill"], URL_INPUT);
  assert.notEqual(filled.code, 0);
  assert.ok(!filled.stdout.includes("password="));
  assert.match(filled.stderr, /set credential\.useHttpPath = true/);
}, 60_000);
