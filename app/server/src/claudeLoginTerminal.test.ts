import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { WebSocket } from "ws";
import { afterAll, afterEach, beforeEach, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "claude-login-terminal-test-"));
const previousDataDir = process.env.DATA_DIR;
const previousHome = process.env.HOME;
const previousNodeEnv = process.env.NODE_ENV;
process.env.DATA_DIR = join(tmp, "data");
process.env.HOME = join(tmp, "home");

const profiles = await import("./credentialProfiles.ts");
const terminal = await import("./claudeLoginTerminal.ts");
const { setChildProcessEnvOverlay } = await import("./subprocessEnv.ts");

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedWith: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.killedWith.push(signal);
    return true;
  }
}

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: unknown[] = [];
  // A capture record: it stores the arguments `close` was called with, so an
  // argument that WAS undefined has to be storable as undefined.
  closed?: { code?: number | undefined; reason?: string | undefined };
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit("close");
  }
}

function request(profileId: string) {
  return {
    url: `/ws/claude-login?profileId=${encodeURIComponent(profileId)}`,
    headers: { host: "localhost" },
  } as never;
}

function childProcess(child: FakeChild): ChildProcessWithoutNullStreams {
  return child as unknown as ChildProcessWithoutNullStreams;
}

beforeEach(() => {
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
  rmSync(process.env.HOME!, { recursive: true, force: true });
});

afterEach(() => {
  terminal.stopClaudeLoginTerminals();
  terminal.setClaudeLoginSpawnForTests(null);
  terminal.setClaudeLoginTimeoutForTests(null);
  terminal.setClaudeAuthStatusVerifierForTests(null);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ASSISTANT_TOKEN;
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  rmSync(tmp, { recursive: true, force: true });
});

test("production resolves the native CLI bundled with the Agent SDK", () => {
  process.env.NODE_ENV = "production";
  try {
    const path = terminal.bundledClaudeCliPath();
    assert.equal(existsSync(path), true);
    assert.match(path, /claude-agent-sdk-.*\/claude(?:\.exe)?$/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("streams the official profile-isolated CLI flow and never echoes the submitted authorization code", () => {
  const profile = profiles.createCredentialProfile({
    name: "Mobile Claude",
    provider: "claude",
  });
  const child = new FakeChild();
  // A capture record — see FakeSocket.closed.
  let invocation:
    | {
        executable: string;
        args: string[];
        env?: NodeJS.ProcessEnv | undefined;
      }
    | undefined;
  process.env.ANTHROPIC_API_KEY = "ambient-secret";
  process.env.ASSISTANT_TOKEN = "app-secret";
  terminal.setClaudeLoginSpawnForTests((executable, args, options) => {
    invocation = { executable, args, env: options.env };
    return childProcess(child);
  });
  const socket = new FakeSocket();
  setChildProcessEnvOverlay({ HTTPS_PROXY: "http://127.0.0.1:9/login" });
  try {
    terminal.attachClaudeLoginSocket(
      socket as unknown as WebSocket,
      request(profile.id),
    );
  } finally {
    setChildProcessEnvOverlay(null);
  }
  assert.equal(invocation?.env?.HTTPS_PROXY, "http://127.0.0.1:9/login");

  assert.deepEqual(invocation?.args, ["auth", "login", "--claudeai"]);
  assert.equal(
    invocation?.env?.CLAUDE_CONFIG_DIR,
    profiles.claudeConfigDir(profile.id),
  );
  assert.equal(invocation?.env?.ANTHROPIC_API_KEY, undefined);
  assert.equal(invocation?.env?.ASSISTANT_TOKEN, undefined);
  assert.match(String(invocation?.executable), /claude/);
  assert.equal((socket.sent[0] as { type?: string }).type, "snapshot");

  const loginUrl = "https://claude.com/cai/oauth/authorize?state=short-lived";
  child.stdout.write(`Open ${loginUrl}\nPaste code here > `);
  assert.match(
    JSON.stringify(socket.sent),
    /claude\.com\/cai\/oauth\/authorize/,
  );

  let stdin = "";
  child.stdin.on("data", (chunk) => {
    stdin += chunk.toString();
  });
  const authorizationCode = "secret-authorization-code";
  socket.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "input", data: authorizationCode })),
  );
  assert.equal(stdin, `${authorizationCode}\n`);
  assert.doesNotMatch(
    JSON.stringify(socket.sent),
    new RegExp(authorizationCode),
  );

  mkdirSync(profiles.claudeConfigDir(profile.id), { recursive: true });
  writeFileSync(
    join(profiles.claudeConfigDir(profile.id), ".credentials.json"),
    '{"oauth":"provider-owned"}',
  );
  child.emit("close", 0, null);
  assert.equal((socket.sent.at(-1) as { status?: string }).status, "ready");
  assert.equal(
    profiles.listCredentialProfiles().find((item) => item.id === profile.id)
      ?.status,
    "ready",
  );
});

test("accepts a verified isolated CLI login without a legacy credentials file", async () => {
  const profile = profiles.createCredentialProfile({
    name: "Claude newer CLI",
    provider: "claude",
  });
  const child = new FakeChild();
  terminal.setClaudeLoginSpawnForTests(() => childProcess(child));
  terminal.setClaudeAuthStatusVerifierForTests(async (id) => id === profile.id);
  const socket = new FakeSocket();
  terminal.attachClaudeLoginSocket(
    socket as unknown as WebSocket,
    request(profile.id),
  );
  writeFileSync(
    join(profiles.claudeConfigDir(profile.id), ".claude.json"),
    "{}",
  );
  child.stdout.write("Login successful.\n");
  child.emit("close", 0, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal((socket.sent.at(-1) as { status?: string }).status, "ready");
  assert.equal(
    profiles.listCredentialProfiles().find((item) => item.id === profile.id)
      ?.status,
    "ready",
  );
  assert.equal(
    existsSync(join(profiles.claudeConfigDir(profile.id), ".credentials.json")),
    false,
  );
});

test("recovers a previously successful isolated login without starting OAuth again", async () => {
  const profile = profiles.createCredentialProfile({
    name: "Claude recovered",
    provider: "claude",
  });
  writeFileSync(
    join(profiles.claudeConfigDir(profile.id), ".claude.json"),
    "{}",
  );
  let checks = 0;
  terminal.setClaudeAuthStatusVerifierForTests(async (id) => {
    assert.equal(id, profile.id);
    checks += 1;
    return true;
  });

  await terminal.reconcileIsolatedClaudeLogins();
  assert.equal(checks, 1);
  assert.equal(
    profiles.credentialProfileSummaryById(profile.id)?.status,
    "ready",
  );
  await terminal.reconcileIsolatedClaudeLogins();
  assert.equal(checks, 1);
});

test("does not mark an unverified CLI exit as a completed sign-in", async () => {
  const profile = profiles.createCredentialProfile({
    name: "Claude unverified",
    provider: "claude",
  });
  const child = new FakeChild();
  terminal.setClaudeLoginSpawnForTests(() => childProcess(child));
  terminal.setClaudeAuthStatusVerifierForTests(async () => false);
  const socket = new FakeSocket();
  terminal.attachClaudeLoginSocket(
    socket as unknown as WebSocket,
    request(profile.id),
  );
  child.emit("close", 0, null);
  await new Promise((resolve) => setImmediate(resolve));

  const last = socket.sent.at(-1) as { status?: string; error?: string };
  assert.equal(last.status, "error");
  assert.match(last.error ?? "", /could not be verified/i);
  assert.equal(
    profiles.credentialProfileSummaryById(profile.id)?.status,
    "error",
  );
});

test("keeps one active process per profile across browser reconnects and supports cancellation", () => {
  const profile = profiles.createCredentialProfile({
    name: "Mobile Claude",
    provider: "claude",
  });
  const child = new FakeChild();
  let spawns = 0;
  terminal.setClaudeLoginSpawnForTests(() => {
    spawns += 1;
    return childProcess(child);
  });
  const first = new FakeSocket();
  const second = new FakeSocket();
  terminal.attachClaudeLoginSocket(
    first as unknown as WebSocket,
    request(profile.id),
  );
  terminal.attachClaudeLoginSocket(
    second as unknown as WebSocket,
    request(profile.id),
  );
  assert.equal(spawns, 1);

  second.emit("message", Buffer.from("null"));
  second.emit("message", Buffer.from(JSON.stringify({ type: "cancel" })));
  assert.deepEqual(child.killedWith, ["SIGTERM"]);
  assert.equal((first.sent.at(-1) as { status?: string }).status, "cancelled");
  assert.equal((second.sent.at(-1) as { status?: string }).status, "cancelled");
});

test("profile deletion cancels an in-flight login before its private directory is removed", () => {
  const profile = profiles.createCredentialProfile({
    name: "Delete me",
    provider: "claude",
  });
  const child = new FakeChild();
  terminal.setClaudeLoginSpawnForTests(() => childProcess(child));
  terminal.attachClaudeLoginSocket(
    new FakeSocket() as unknown as WebSocket,
    request(profile.id),
  );

  profiles.deleteCredentialProfile(profile.id);
  assert.deepEqual(child.killedWith, ["SIGKILL"]);
  assert.equal(profiles.credentialProfileById(profile.id), undefined);
});

test("rejects a non-Claude profile without spawning a process", () => {
  let spawned = false;
  terminal.setClaudeLoginSpawnForTests(() => {
    spawned = true;
    return childProcess(new FakeChild());
  });
  const socket = new FakeSocket();
  terminal.attachClaudeLoginSocket(
    socket as unknown as WebSocket,
    request("default"),
  );
  assert.equal(spawned, false);
  assert.equal(socket.closed?.code, 1008);
  assert.equal((socket.sent[0] as { status?: string }).status, "error");
});
