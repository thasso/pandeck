/**
 * Logins in the gateway end to end (plan Task-1385): a client-mode server
 * adds and logs in accounts through relay and edge (`remoteLogins.ts`,
 * `gatewayClientLink.ts`, `gateway/logins.ts`), with fake login drivers in
 * place of the Claude CLI and pi's device-code login, and fake upstreams that
 * show which token a model request carried, and deletes one. Every value is
 * fake.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";
import type { WebSocket } from "ws";

const home = mkdtempSync(join(tmpdir(), "gateway-logins-home-"));
process.env.HOME = home;

const profiles = await import("./credentialProfiles.ts");
const { attachAccountLoginSocket } = await import("./accountLoginSocket.ts");
const { createRemoteAccount, deleteRemoteAccount, remoteLoginsActive } =
  await import("./remoteLogins.ts");
const {
  homeTranscriptImportStartupRefusal,
  importDefaultClaudeHomeTranscripts,
} = await import("./claudeSdk/homeTranscriptImport.ts");
const { startGatewayClientLink } = await import("./gatewayClientLink.ts");
const { startGateway } = await import("./gateway/gateway.ts");
const { enrollRelay, startRelay } = await import("./relay/relay.ts");
const { DATA_DIR } = await import("./config.ts");
const {
  CLAUDE_PATH,
  CODEX_PATH,
  fakeClaudeStream,
  fakeCodexStream,
  modelRequest,
  startFakeUpstreams,
  writeTokenFiles,
} = await import("./test/gatewayFixtures.ts");
type LoginDriver = NonNullable<
  import("./gateway/vaultPort.ts").LoginDrivers["claude"]
>;

const open: { close(): unknown }[] = [];
afterAll(async () => {
  while (open.length) await open.pop()!.close();
  rmSync(home, { recursive: true, force: true });
});

const expires = () => Date.now() + 3_600_000;

/** Claude's fake CLI: prints a URL, takes the pasted code, writes a token. */
const claudeLoginDirs: string[] = [];
const fakeClaude: LoginDriver = (configDir, events) => {
  claudeLoginDirs.push(configDir);
  let settle!: { resolve: () => void; reject: (err: Error) => void };
  const done = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject };
  });
  events.output(
    "Open https://claude.example/oauth/authorize?x=1\nPaste code: ",
  );
  return {
    input(text) {
      writeFileSync(
        join(configDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: `claude-${text}`,
            expiresAt: expires(),
          },
        }),
      );
      settle.resolve();
    },
    cancel: () => settle.reject(new Error("Claude login stopped (SIGTERM).")),
    done,
  };
};

/** pi's fake device-code login: URL and code, then a token once approved; cancel rejects it, as pi's abort does. */
let approveCodex!: () => void;
const fakeCodex: LoginDriver = (configDir, events) => {
  events.url("https://auth.example/device");
  events.code("ABCD-1234");
  let abort!: (err: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    abort = reject;
    approveCodex = () => {
      writeFileSync(
        join(configDir, "auth.json"),
        JSON.stringify({
          "openai-codex": {
            type: "oauth",
            access: "codex-new-access",
            accountId: "acct-new",
            expires: expires(),
          },
        }),
      );
      resolve();
    };
  });
  return {
    input: () => {},
    cancel: () => abort(new Error("This operation was aborted")),
    done,
  };
};

/** A browser on the login dialog's socket. */
function viewer(profileId: string) {
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    messages: [] as { type: string; [key: string]: unknown }[],
    send(text: string) {
      socket.messages.push(JSON.parse(text) as { type: string });
    },
    close() {
      socket.readyState = 3;
    },
  });
  attachAccountLoginSocket(
    socket as unknown as WebSocket,
    {
      url: `/ws/account-login?profileId=${profileId}&intent=start`,
      headers: { host: "localhost" },
    } as IncomingMessage,
  );
  const output = () =>
    socket.messages
      .map((m) =>
        m.type === "output" ? m.chunk : m.type === "snapshot" ? m.output : "",
      )
      .join("");
  const status = () =>
    socket.messages.filter((m) => m.type === "status").at(-1)?.status;
  const type = (message: object) =>
    socket.emit("message", Buffer.from(JSON.stringify(message)));
  const device = () =>
    socket.messages
      .map((m) =>
        m.type === "device" || m.type === "snapshot" ? m.device : undefined,
      )
      .filter((d) => d !== undefined)
      .at(-1) as { verificationUri: string; userCode: string } | undefined;
  return { output, status, type, device };
}

test("a client-mode server adds and logs in accounts through the gateway", async () => {
  // Import affects only this Pandeck's runtime/transcripts, before any gateway
  // connection. Its default account's credential will belong to the gateway.
  const projectKey = "-fixture-repo";
  const providerId = "fixture-default-session";
  const source = join(home, ".claude", "projects");
  // Startup creates DATA_DIR before the importer; its boundary must exist.
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(join(source, projectKey), { recursive: true });
  const transcript = '{"type":"user","text":"fixture transcript"}\n';
  writeFileSync(join(source, projectKey, `${providerId}.jsonl`), transcript);
  const profileRoot = join(
    DATA_DIR,
    "credential-profiles",
    profiles.DEFAULT_CLAUDE_PROFILE_ID,
  );
  assert.equal(
    await homeTranscriptImportStartupRefusal(() =>
      importDefaultClaudeHomeTranscripts({
        homeProjectsDir: source,
        profileRoot,
        dataDir: DATA_DIR,
        providerSessionIds: () => [providerId],
        freeBytes: async () => undefined,
      }),
    ),
    undefined,
  );
  const localConfig = join(profileRoot, "claude");
  const installed = join(
    localConfig,
    "projects",
    projectKey,
    `${providerId}.jsonl`,
  );
  assert.equal(readFileSync(installed, "utf8"), transcript);
  assert.equal(existsSync(join(localConfig, ".credentials.json")), false);
  assert.equal(remoteLoginsActive(), false);
  const upstreams = await startFakeUpstreams({
    claude: fakeClaudeStream("hi"),
    codex: fakeCodexStream("hello"),
  });
  open.push(upstreams);
  const gatewayDir = mkdtempSync(join(DATA_DIR, "edge-"));
  const gateway = await startGateway({
    stateDir: gatewayDir,
    upstreams: upstreams.overrides,
    log: () => {},
    clients: {},
    loginDrivers: { claude: fakeClaude, "openai-codex": fakeCodex },
  });
  open.push(gateway);
  const edge = gateway.clients!;
  edge.registry.addUser("thasso");
  const { claudeFile } = await writeTokenFiles();
  edge.putAccount({
    id: "claude-old",
    provider: "claude",
    name: "Old Claude",
    enabled: true,
    tokenFile: claudeFile,
    userId: "thasso",
  });

  const { claudeFile: defaultFile } = await writeTokenFiles();
  edge.putAccount({
    id: profiles.DEFAULT_CLAUDE_PROFILE_ID,
    provider: "claude",
    name: "Default Claude",
    enabled: true,
    tokenFile: defaultFile,
    userId: "thasso",
  });

  const relayDir = mkdtempSync(join(tmpdir(), "relay-"));
  open.push({
    close: () => rmSync(relayDir, { recursive: true, force: true }),
  });
  await enrollRelay({
    stateDir: relayDir,
    host: "127.0.0.1",
    enrollPort: edge.enrollPort,
    caPem: edge.caPem,
    code: edge.registry.createCode("thasso", "devbox"),
  });
  const relay = await startRelay({
    stateDir: relayDir,
    port: 0,
    socketPath: join(relayDir, "relay.sock"),
    log: () => {},
  });
  open.push(relay);
  const link = startGatewayClientLink({
    socketPath: relay.socketPath,
    relayPort: relay.port,
    log: () => {},
  });
  open.push(link);
  assert.equal(await link.ready, true);
  const status = (id: string) =>
    profiles.credentialProfileSummaryById(id)?.status;
  const tempDirs = () => readdirSync(join(gatewayDir, "login-tmp"));

  assert.equal(remoteLoginsActive(), true);
  assert.equal(
    profiles.claudeProfileRuntime(profiles.DEFAULT_CLAUDE_PROFILE_ID).configDir,
    localConfig,
  );
  const defaultLogin = viewer(profiles.DEFAULT_CLAUDE_PROFILE_ID);
  await vi.waitFor(() => assert.match(defaultLogin.output(), /Paste code/));
  assert.ok(
    claudeLoginDirs
      .at(-1)
      ?.startsWith(join(gatewayDir, "login-tmp", "claude-")),
  );
  assert.notEqual(claudeLoginDirs.at(-1), localConfig);
  defaultLogin.type({ type: "input", data: "default-fixture" });
  await vi.waitFor(() => assert.equal(defaultLogin.status(), "ready"));
  assert.match(readFileSync(defaultFile, "utf8"), /claude-default-fixture/);
  assert.equal(existsSync(join(localConfig, ".credentials.json")), false);
  assert.equal(readFileSync(installed, "utf8"), transcript);
  assert.equal(
    readFileSync(join(source, projectKey, `${providerId}.jsonl`), "utf8"),
    transcript,
  );
  assert.deepEqual(tempDirs(), []);

  // Claude: adding the account starts its login; the pasted code reaches the
  // driver and the account turns ready with the new token.
  const claudeId = await createRemoteAccount("claude", "Work Claude");
  assert.equal(status(claudeId), "connecting");
  const terminal = viewer(claudeId);
  await vi.waitFor(() => assert.match(terminal.output(), /oauth\/authorize/));
  terminal.type({ type: "input", data: "one" });
  await vi.waitFor(() => assert.equal(terminal.status(), "ready"));
  await vi.waitFor(() => assert.equal(status(claudeId), "ready"));
  const tokenFile = join(gatewayDir, "accounts", claudeId, ".credentials.json");
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  assert.deepEqual(tempDirs(), []);
  const lease = await link.grantEngineLease({
    workerId: undefined,
    profileId: claudeId,
  });
  assert.equal(
    (await modelRequest(relay.port, CLAUDE_PATH, lease.token)).status,
    200,
  );
  assert.equal(
    upstreams.anthropic.at(-1)!.headers.authorization,
    "Bearer claude-one",
  );

  // Codex: the login dialog joins the login adding the account started and
  // shows its device code; the account summary never carries it.
  const codexId = await createRemoteAccount("openai-codex", "Work Codex");
  const codexLogin = viewer(codexId);
  await vi.waitFor(() =>
    assert.deepEqual(codexLogin.device(), {
      verificationUri: "https://auth.example/device",
      userCode: "ABCD-1234",
    }),
  );
  assert.doesNotMatch(
    JSON.stringify(profiles.credentialProfileSummaryById(codexId)),
    /ABCD-1234|auth\.example/,
  );
  approveCodex();
  await vi.waitFor(() => assert.equal(codexLogin.status(), "ready"));
  await vi.waitFor(() => assert.equal(status(codexId), "ready"));
  const access = await link.serverAccess(codexId);
  assert.equal(
    (await modelRequest(relay.port, CODEX_PATH, access.leaseToken)).status,
    200,
  );
  assert.equal(
    upstreams.chatgpt.at(-1)!.headers.authorization,
    "Bearer codex-new-access",
  );

  // AC4: Cancel on a Codex login reaches the gateway's driver; the dialog
  // ends cancelled and the account keeps its credential, not connecting.
  const relogin = viewer(codexId);
  await vi.waitFor(() => assert.equal(relogin.device()?.userCode, "ABCD-1234"));
  assert.equal(status(codexId), "connecting");
  relogin.type({ type: "cancel" });
  await vi.waitFor(() => assert.equal(relogin.status(), "cancelled"));
  await vi.waitFor(() => assert.equal(status(codexId), "ready"));

  // A cancelled first Codex login removes its new account from the mirror.
  const shortCodex = await createRemoteAccount("openai-codex", "Short Codex");
  const shortLogin = viewer(shortCodex);
  await vi.waitFor(() => assert.ok(shortLogin.device()));
  shortLogin.type({ type: "cancel" });
  await vi.waitFor(() => assert.equal(shortLogin.status(), "cancelled"));
  await vi.waitFor(() =>
    assert.equal(profiles.credentialProfileById(shortCodex), undefined),
  );
  assert.deepEqual(tempDirs(), []);

  // Deleting an account removes it on the gateway, with its token file.
  await deleteRemoteAccount(codexId);
  assert.equal(profiles.credentialProfileById(codexId), undefined);
  assert.equal(existsSync(join(gatewayDir, "accounts", codexId)), false);
  assert.equal(
    (await modelRequest(relay.port, CODEX_PATH, access.leaseToken)).status,
    401,
  );

  // Logging in again replaces an existing account's token in its own file.
  const again = viewer("claude-old");
  await vi.waitFor(() => assert.match(again.output(), /Paste code/));
  again.type({ type: "input", data: "two" });
  await vi.waitFor(() => assert.equal(again.status(), "ready"));
  assert.match(readFileSync(claudeFile, "utf8"), /claude-two/);

  // A cancelled first login removes its account again.
  const tempId = await createRemoteAccount("claude", "Short-lived");
  const cancelled = viewer(tempId);
  await vi.waitFor(() => assert.match(cancelled.output(), /Paste code/));
  cancelled.type({ type: "cancel" });
  await vi.waitFor(() => assert.equal(cancelled.status(), "cancelled"));
  await vi.waitFor(() =>
    assert.equal(profiles.credentialProfileById(tempId), undefined),
  );
  assert.deepEqual(tempDirs(), []);
  assert.deepEqual(
    profiles
      .credentialProfilesOfKind("claude")
      .map((p) => p.id)
      .sort(),
    [claudeId, "claude-old", profiles.DEFAULT_CLAUDE_PROFILE_ID].sort(),
  );
});
