/**
 * Client mode's login relay at its edges (Task-1402 B1, AC4a, AC11): a fake
 * gateway port whose `start` the test answers, and browsers on the login
 * dialog's socket. A cancel before the answer is latched and forwarded once;
 * a close before it only detaches; a rejected start ends its viewers. Every
 * value is fake.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, test } from "vitest";
import type { WebSocket } from "ws";

const tmp = mkdtempSync(join(tmpdir(), "remote-logins-test-"));
process.env.DATA_DIR = join(tmp, "data");
process.env.HOME = join(tmp, "home");

const profiles = await import("./credentialProfiles.ts");
const { attachAccountLoginSocket } = await import("./accountLoginSocket.ts");
const { installRemoteLoginPort, remoteLoginEvent } =
  await import("./remoteLogins.ts");
const { deferred } = await import("./test/fakeLoginHoldLink.ts");

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: { type: string; [key: string]: unknown }[] = [];
  closed?: number | undefined;
  send(value: string) {
    this.sent.push(JSON.parse(value) as { type: string });
  }
  close(code?: number) {
    this.closed = code;
    this.readyState = 3;
    this.emit("close");
  }
  type(raw: string) {
    this.emit("message", Buffer.from(raw));
  }
  statuses() {
    return this.sent.filter((m) => m.type === "status").map((m) => m.status);
  }
}

/** A fake port: every start waits for the test; calls land in `calls`. */
function fakePort() {
  const calls: string[] = [];
  const starts: ReturnType<
    typeof deferred<{ loginId: string; accountId: string }>
  >[] = [];
  const uninstall = installRemoteLoginPort({
    start(start) {
      calls.push(`start ${start.kind} ${start.accountId ?? "new"}`);
      const answer = deferred<{ loginId: string; accountId: string }>();
      starts.push(answer);
      return answer.promise;
    },
    input: async (loginId, text) => {
      calls.push(`input ${loginId} ${text}`);
    },
    cancel: async (loginId) => {
      calls.push(`cancel ${loginId}`);
    },
    remove: async () => {},
  });
  return { calls, starts, uninstall };
}

let port: ReturnType<typeof fakePort> | undefined;
afterEach(() => port?.uninstall());
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function open(profileId: string, intent = "start") {
  const socket = new FakeSocket();
  attachAccountLoginSocket(
    socket as unknown as WebSocket,
    {
      url: `/ws/account-login?profileId=${profileId}&intent=${intent}`,
      headers: { host: "localhost" },
    } as IncomingMessage,
  );
  return socket;
}

const ticks = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe.each(["claude", "openai-codex"] as const)(
  "AC4a: a %s login's start in client mode",
  (kind) => {
    const account = () =>
      profiles.createCredentialProfile({
        name: `Remote ${kind}`,
        provider: kind,
      });

    test("(a) a cancel before the answer is forwarded once with its login id, and the gateway's cancelled ends the dialog", async () => {
      port = fakePort();
      const { id } = account();
      const viewer = open(id);
      assert.equal(viewer.sent[0]?.type, "snapshot");
      viewer.type(JSON.stringify({ type: "cancel" }));
      viewer.type(JSON.stringify({ type: "cancel" }));
      viewer.type(JSON.stringify({ type: "input", data: "early" }));
      assert.deepEqual(port.calls, [`start ${kind} ${id}`]);

      port.starts[0]!.resolve({ loginId: "login-a", accountId: id });
      await ticks();
      assert.deepEqual(port.calls, [`start ${kind} ${id}`, "cancel login-a"]);
      remoteLoginEvent("login-a", { type: "state", state: "cancelled" });
      assert.deepEqual(viewer.statuses(), ["cancelled"]);
      assert.notEqual(
        profiles.credentialProfileSummaryById(id)?.status,
        "connecting",
      );
    });

    test("(b) a close before the answer only detaches: no cancel, nothing sent later", async () => {
      port = fakePort();
      const { id } = account();
      const viewer = open(id);
      viewer.close(1000);
      port.starts[0]!.resolve({ loginId: "login-b", accountId: id });
      await ticks();
      remoteLoginEvent("login-b", { type: "output", text: "Paste code: " });
      remoteLoginEvent("login-b", { type: "url", url: "https://x.example" });
      remoteLoginEvent("login-b", { type: "code", code: "CODE-B" });
      assert.deepEqual(port.calls, [`start ${kind} ${id}`]);
      assert.deepEqual(
        viewer.sent.map((m) => m.type),
        ["snapshot"],
      );
      // The login still runs for the next viewer.
      assert.equal(
        profiles.credentialProfileSummaryById(id)?.status,
        "connecting",
      );
      remoteLoginEvent("login-b", { type: "state", state: "cancelled" });
    });

    test("(c) a rejected start drops the latched cancel and ends its viewers with the error", async () => {
      port = fakePort();
      const { id } = account();
      const viewer = open(id);
      viewer.type(JSON.stringify({ type: "cancel" }));
      port.starts[0]!.reject(new Error("The gateway refused the login."));
      await ticks();
      assert.deepEqual(port.calls, [`start ${kind} ${id}`]);
      assert.equal(viewer.sent.at(-1)?.status, "error");
      assert.equal(viewer.sent.at(-1)?.error, "The gateway refused the login.");
      assert.equal(viewer.closed, 1011);
      // The next start asks the gateway again.
      open(id);
      assert.equal(port.calls.length, 2);
    });
  },
);

test("AC11: malformed messages change nothing; input reaches only a Claude login", async () => {
  port = fakePort();
  const claude = profiles.createCredentialProfile({
    name: "Remote Claude input",
    provider: "claude",
  });
  const codex = profiles.createCredentialProfile({
    name: "Remote Codex input",
    provider: "openai-codex",
  });
  const claudeViewer = open(claude.id);
  const codexViewer = open(codex.id);
  port.starts[0]!.resolve({ loginId: "login-c", accountId: claude.id });
  port.starts[1]!.resolve({ loginId: "login-x", accountId: codex.id });
  await ticks();
  for (const viewer of [claudeViewer, codexViewer])
    for (const raw of [
      "not json",
      "null",
      "[]",
      "42",
      '"cancel"',
      "{}",
      '{"type":"stop"}',
      '{"type":"input"}',
      '{"type":"input","data":7}',
      JSON.stringify({ type: "input", data: "x".repeat(8_193) }),
    ])
      assert.doesNotThrow(() => viewer.type(raw));
  await ticks();
  assert.equal(port.calls.length, 2);
  codexViewer.type(JSON.stringify({ type: "input", data: "ignored" }));
  claudeViewer.type(JSON.stringify({ type: "input", data: "pasted" }));
  await ticks();
  assert.deepEqual(port.calls.slice(2), ["input login-c pasted"]);
  for (const loginId of ["login-c", "login-x"])
    remoteLoginEvent(loginId, { type: "state", state: "cancelled" });
});

test("Codex's device message goes out once both the URL and the code arrived, and its output is not forwarded", async () => {
  port = fakePort();
  const { id } = profiles.createCredentialProfile({
    name: "Remote Codex device",
    provider: "openai-codex",
  });
  const viewer = open(id);
  // An event before the start's answer waits for it.
  remoteLoginEvent("login-d", { type: "url", url: "https://auth.example/d" });
  port.starts[0]!.resolve({ loginId: "login-d", accountId: id });
  await ticks();
  remoteLoginEvent("login-d", { type: "output", text: "Open … CODE-D" });
  assert.deepEqual(
    viewer.sent.map((m) => m.type),
    ["snapshot"],
  );
  remoteLoginEvent("login-d", { type: "code", code: "CODE-D" });
  assert.deepEqual(viewer.sent.at(-1), {
    type: "device",
    device: { verificationUri: "https://auth.example/d", userCode: "CODE-D" },
  });
  // A later viewer's snapshot carries it.
  const later = open(id);
  assert.deepEqual(later.sent[0]?.device, {
    verificationUri: "https://auth.example/d",
    userCode: "CODE-D",
  });
  assert.equal(later.sent[0]?.output, "");
  assert.doesNotMatch(
    JSON.stringify(profiles.credentialProfileSummaryById(id)),
    /CODE-D|auth\.example/,
  );
  remoteLoginEvent("login-d", { type: "state", state: "cancelled" });
});
