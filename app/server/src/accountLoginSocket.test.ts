/**
 * The login dialog's socket lifecycle (Task-1402 B1, AC6, AC11), through the
 * dispatcher, for each of its three runs: the local Claude CLI login (a fake
 * child), pi's local OpenAI login (an injected provider login) and the
 * gateway's login in client mode (a fake port). `start` joins or starts;
 * `attach` only rejoins; a finished run is kept two minutes, and a `start`
 * after it begins a new login. Every value is fake.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, afterEach, describe, test, vi } from "vitest";
import type { WebSocket } from "ws";

const tmp = mkdtempSync(join(tmpdir(), "account-login-socket-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
process.env.HOME = join(tmp, "home");

const profiles = await import("./credentialProfiles.ts");
const { attachAccountLoginSocket, LOGIN_NOT_RUNNING_TEXT } =
  await import("./accountLoginSocket.ts");
const claudeTerminal = await import("./claudeLoginTerminal.ts");
const { setOpenAiProfileLoginForTests } = await import("./piSdk/models.ts");
const { installRemoteLoginPort, remoteLoginEvent } =
  await import("./remoteLogins.ts");
const { deferred } = await import("./test/fakeLoginHoldLink.ts");
const health = await import("./accountHealth.ts");
health.initializeAccountHealth({
  profiles: profiles.listCredentialProfiles,
  hasCredential: profiles.credentialProfileHasCredential,
  broadcast: () => {},
  push: async () => {},
  subscribeChanges: profiles.subscribeCredentialProfileChanges,
  subscribeDeleted: profiles.subscribeCredentialProfileDeleted,
});

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
}

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() {
    return true;
  }
}

/** One kind of run, with a provider the test drives. */
interface Harness {
  profileId: string;
  /** How many provider logins started. */
  starts(): number;
  /** Lets the latest provider login fail; its run then finishes. */
  fail(): void;
  /** What a snapshot of a running login shows of it. */
  progress(snapshot: Record<string, unknown>): boolean;
  /** Lets the latest provider login produce something new for its viewers. */
  emit(): void;
  cleanup(): void;
}

const KINDS: Record<string, () => Harness> = {
  "local Claude": () => {
    const { id } = profiles.createCredentialProfile({
      name: "Claude",
      provider: "claude",
    });
    const children: FakeChild[] = [];
    claudeTerminal.setClaudeLoginSpawnForTests(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    return {
      profileId: id,
      starts: () => children.length,
      fail: () => children.at(-1)!.emit("close", 1, null),
      progress: (s) =>
        /Starting the official Claude login/.test(String(s.output)),
      emit: () => children.at(-1)!.stdout.write("more output\n"),
      cleanup: () => claudeTerminal.setClaudeLoginSpawnForTests(null),
    };
  },
  "local OpenAI": () => {
    const { id } = profiles.createCredentialProfile({
      name: "OpenAI",
      provider: "openai-codex",
    });
    const logins: ReturnType<typeof deferred<void>>[] = [];
    const notifiers: (() => void)[] = [];
    setOpenAiProfileLoginForTests(async (_runtime, interaction) => {
      const login = deferred<void>();
      logins.push(login);
      // As pi's login: an abort rejects it.
      interaction.signal!.addEventListener("abort", () =>
        login.reject(new Error("This operation was aborted")),
      );
      const notify = () =>
        interaction.notify({
          type: "device_code",
          verificationUri: "https://auth.example/verify",
          userCode: `CODE-${logins.length}`,
        });
      notifiers.push(notify);
      notify();
      await login.promise;
    });
    return {
      profileId: id,
      starts: () => logins.length,
      fail: () => logins.at(-1)!.reject(new Error("The provider refused.")),
      progress: (s) =>
        (s.device as { userCode?: string } | undefined)?.userCode === "CODE-1",
      emit: () => notifiers.at(-1)!(),
      cleanup: () => setOpenAiProfileLoginForTests(null),
    };
  },
  "remote Claude": () => {
    const { id } = profiles.createCredentialProfile({
      name: "Remote",
      provider: "claude",
    });
    let started = 0;
    const uninstall = installRemoteLoginPort({
      start: async () => ({ loginId: `remote-${++started}`, accountId: id }),
      input: async () => {},
      cancel: async () => {},
      remove: async () => {},
    });
    return {
      profileId: id,
      starts: () => started,
      fail: () =>
        remoteLoginEvent(`remote-${started}`, {
          type: "state",
          state: "error",
          error: "The provider refused.",
        }),
      progress: (s) => s.status === "connecting",
      emit: () =>
        remoteLoginEvent(`remote-${started}`, {
          type: "output",
          text: "Paste code: ",
        }),
      cleanup: uninstall,
    };
  },
};

const sockets: FakeSocket[] = [];
function open(profileId: string, intent: string) {
  const socket = new FakeSocket();
  sockets.push(socket);
  attachAccountLoginSocket(
    socket as unknown as WebSocket,
    {
      url: `/ws/account-login?profileId=${profileId}&intent=${intent}`,
      headers: { host: "localhost" },
    } as IncomingMessage,
  );
  return socket;
}
const lastStatus = (socket: FakeSocket) =>
  socket.sent.filter((m) => m.type === "status").at(-1)?.status;
/** Settles the promise reactions and short I/O a provider's start needs. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

let current: Harness | undefined;
afterEach(() => {
  vi.useRealTimers();
  current?.cleanup();
  current = undefined;
});
afterAll(() => {
  claudeTerminal.stopClaudeLoginTerminals();
  rmSync(tmp, { recursive: true, force: true });
});

describe.each(Object.keys(KINDS))("AC6: the %s run", (kind) => {
  const setup = () => (current = KINDS[kind]!());

  test("(1) start, close, start joins the same run; its snapshot shows its progress; one provider login", async () => {
    const run = setup();
    open(run.profileId, "start").close(1000);
    await settle();
    const second = open(run.profileId, "start");
    await settle();
    assert.equal(run.starts(), 1);
    assert.equal(second.sent[0]?.type, "snapshot");
    assert.ok(run.progress(second.sent[0]!), JSON.stringify(second.sent[0]));
    run.fail();
    await settle();
  });

  test("(2) a run that finished with no viewer still answers an attach with its finished snapshot", async () => {
    const run = setup();
    open(run.profileId, "start").close(1000);
    await settle();
    run.fail();
    await settle();
    const viewer = open(run.profileId, "attach");
    assert.equal(viewer.sent[0]?.type, "snapshot");
    assert.equal(viewer.sent[0]?.status, "error");
    assert.equal(run.starts(), 1);
  });

  test("(3) a finished run answers an attach for two minutes, then the fixed error, and nothing starts", async () => {
    const run = setup();
    open(run.profileId, "start");
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    run.fail();
    await vi.waitFor(() =>
      assert.equal(
        profiles.credentialProfileSummaryById(run.profileId)?.status,
        "error",
      ),
    );
    await vi.advanceTimersByTimeAsync(119_000);
    assert.equal(open(run.profileId, "attach").sent[0]?.status, "error");
    assert.equal(open(run.profileId, "attach").sent[0]?.type, "snapshot");
    await vi.advanceTimersByTimeAsync(2_000);
    const late = open(run.profileId, "attach");
    assert.deepEqual(late.sent, [
      { type: "status", status: "error", error: LOGIN_NOT_RUNNING_TEXT },
    ]);
    assert.equal(run.starts(), 1);
  });

  test("(4) a start after a finished run begins a new login; the old viewer keeps its finished state and hears nothing of the new one", async () => {
    const run = setup();
    const first = open(run.profileId, "start");
    await settle();
    run.fail();
    await settle();
    assert.equal(lastStatus(first), "error");
    const seen = first.sent.length;
    const second = open(run.profileId, "start");
    await settle();
    assert.equal(run.starts(), 2);
    assert.equal(second.sent[0]?.status, "connecting");
    run.emit();
    await settle();
    assert.ok(second.sent.length > 1, "the new run's viewer hears it");
    assert.equal(first.sent.length, seen);
    run.fail();
    await settle();
    assert.equal(first.sent.length, seen);
  });

  test("(5) an attach with no run answers the fixed error, starts nothing and leaves the account alone", async () => {
    const run = setup();
    const before = profiles.credentialProfileSummaryById(run.profileId);
    const viewer = open(run.profileId, "attach");
    await settle();
    assert.deepEqual(viewer.sent, [
      { type: "status", status: "error", error: LOGIN_NOT_RUNNING_TEXT },
    ]);
    assert.equal(run.starts(), 0);
    assert.deepEqual(
      profiles.credentialProfileSummaryById(run.profileId),
      before,
    );
  });

  test("AC11: malformed messages change nothing and throw nothing", async () => {
    const run = setup();
    const viewer = open(run.profileId, "start");
    await settle();
    for (const raw of [
      "not json",
      "null",
      "[]",
      "42",
      '"cancel"',
      "{}",
      '{"type":"stop"}',
      '{"type":"input","data":7}',
      JSON.stringify({ type: "input", data: "x".repeat(8_193) }),
    ])
      assert.doesNotThrow(() => viewer.type(raw));
    await settle();
    assert.equal(lastStatus(viewer), undefined);
    assert.equal(run.starts(), 1);
    run.fail();
    await settle();
  });
});

test.each([
  ["no intent", ""],
  ["an unknown intent", "&intent=resume"],
])("%s is refused like an invalid profile", (_case, query) => {
  const { id } = profiles.createCredentialProfile({
    name: "Intent",
    provider: "claude",
  });
  const socket = new FakeSocket();
  attachAccountLoginSocket(
    socket as unknown as WebSocket,
    {
      url: `/ws/account-login?profileId=${id}${query}`,
      headers: { host: "localhost" },
    } as IncomingMessage,
  );
  assert.equal(socket.sent[0]?.status, "error");
  assert.equal(socket.closed, 1008);
  assert.equal(
    profiles.credentialProfileSummaryById(id)?.status,
    "disconnected",
  );
});

test("input on a local OpenAI login reaches no provider and ends nothing", async () => {
  current = KINDS["local OpenAI"]!();
  const viewer = open(current.profileId, "start");
  await settle();
  viewer.type(JSON.stringify({ type: "input", data: "not-a-code" }));
  await settle();
  assert.equal(lastStatus(viewer), undefined);
  viewer.type(JSON.stringify({ type: "cancel" }));
  await vi.waitFor(() => assert.equal(lastStatus(viewer), "cancelled"));
});
