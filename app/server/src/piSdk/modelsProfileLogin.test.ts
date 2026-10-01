import assert from "node:assert/strict";
import { afterAll, afterEach, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "pi-profile-login-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const {
  createCredentialProfile,
  deleteCredentialProfile,
  listCredentialProfiles,
  piAgentDir,
} = await import("../credentialProfiles.ts");
const {
  setOpenAiProfileLoginForTests,
  setOpenAiProfileLoginTimeoutForTests,
  startOpenAiProfileLogin,
} = await import("./models.ts");

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 40; i += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for profile login state.");
}

test("OpenAI device-code login exposes only transient verification guidance and ready state", async () => {
  const profile = createCredentialProfile({
    name: "OAuth test",
    provider: "openai-codex",
  });
  let release!: () => void;
  const complete = new Promise<void>((resolve) => {
    release = resolve;
  });
  setOpenAiProfileLoginForTests(async (_runtime, interaction) => {
    interaction.notify({
      type: "device_code",
      verificationUri: "https://auth.example/verify",
      userCode: "ABCD-EFGH",
    });
    await complete;
    writeFileSync(
      join(piAgentDir(profile.id), "auth.json"),
      '{"openai-codex":{}}',
      { mode: 0o600 },
    );
  });

  startOpenAiProfileLogin(profile.id);
  const connecting = await waitFor(() =>
    listCredentialProfiles().find(
      (item) =>
        item.id === profile.id &&
        item.status === "connecting" &&
        item.setup?.userCode === "ABCD-EFGH",
    ),
  );
  assert.equal(
    connecting.setup?.verificationUri,
    "https://auth.example/verify",
  );
  assert.equal(connecting.setup?.userCode, "ABCD-EFGH");
  assert.doesNotMatch(JSON.stringify(connecting), /access|token/i);

  release();
  const ready = await waitFor(() =>
    listCredentialProfiles().find(
      (item) => item.id === profile.id && item.status === "ready",
    ),
  );
  assert.equal(ready.setup, undefined);
});

test("persisted OAuth completes the UI while pi's post-login refresh is still settling", async () => {
  const profile = createCredentialProfile({
    name: "OAuth slow refresh",
    provider: "openai-codex",
  });
  let persist!: () => void;
  let settle!: () => void;
  let calls = 0;
  const credentialReady = new Promise<void>((resolve) => {
    persist = resolve;
  });
  const refreshSettled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  setOpenAiProfileLoginForTests(async (_runtime, interaction) => {
    calls += 1;
    interaction.notify({
      type: "device_code",
      verificationUri: "https://auth.example/verify",
      userCode: "SLOW-REFRESH",
    });
    await credentialReady;
    writeFileSync(
      join(piAgentDir(profile.id), "auth.json"),
      '{"openai-codex":{}}',
      { mode: 0o600 },
    );
    await refreshSettled;
  });

  startOpenAiProfileLogin(profile.id);
  await waitFor(() =>
    listCredentialProfiles().find(
      (item) =>
        item.id === profile.id &&
        item.status === "connecting" &&
        item.setup?.userCode === "SLOW-REFRESH",
    ),
  );
  persist();

  const ready = await waitFor(() =>
    listCredentialProfiles().find(
      (item) => item.id === profile.id && item.status === "ready",
    ),
  );
  assert.equal(ready.setup, undefined);
  startOpenAiProfileLogin(profile.id);
  assert.equal(
    calls,
    1,
    "the settling SDK operation must still serialize reconnect attempts",
  );
  settle();
});

test("a post-persistence refresh failure does not undo a completed login", async () => {
  const profile = createCredentialProfile({
    name: "OAuth refresh failure",
    provider: "openai-codex",
  });
  setOpenAiProfileLoginForTests(async (_runtime, interaction) => {
    interaction.notify({
      type: "device_code",
      verificationUri: "https://auth.example/verify",
      userCode: "REFRESH-FAIL",
    });
    writeFileSync(
      join(piAgentDir(profile.id), "auth.json"),
      '{"openai-codex":{}}',
      { mode: 0o600 },
    );
    throw new Error("model refresh failed after persistence");
  });

  startOpenAiProfileLogin(profile.id);
  const ready = await waitFor(() =>
    listCredentialProfiles().find(
      (item) => item.id === profile.id && item.status === "ready",
    ),
  );
  assert.equal(ready.error, undefined);
});

test("OpenAI device-code login records a safe failure state", async () => {
  const profile = createCredentialProfile({
    name: "OAuth failure",
    provider: "openai-codex",
  });
  setOpenAiProfileLoginForTests(async () => {
    throw new Error("provider denied the device code");
  });

  startOpenAiProfileLogin(profile.id);
  const failed = await waitFor(() =>
    listCredentialProfiles().find(
      (item) => item.id === profile.id && item.status === "error",
    ),
  );
  assert.match(failed.error ?? "", /provider denied/i);
  assert.doesNotMatch(JSON.stringify(failed), /access|token/i);
});

test("a timed-out login remains authoritative until the provider operation settles", async () => {
  const profile = createCredentialProfile({
    name: "OAuth timeout",
    provider: "openai-codex",
  });
  let calls = 0;
  let release!: () => void;
  const complete = new Promise<void>((resolve) => {
    release = resolve;
  });
  setOpenAiProfileLoginTimeoutForTests(15);
  setOpenAiProfileLoginForTests(async () => {
    calls += 1;
    await complete;
    writeFileSync(
      join(piAgentDir(profile.id), "auth.json"),
      '{"openai-codex":{}}',
      { mode: 0o600 },
    );
  });

  startOpenAiProfileLogin(profile.id);
  await waitFor(() =>
    listCredentialProfiles().find(
      (item) =>
        item.id === profile.id &&
        item.status === "error" &&
        /active login/i.test(item.error ?? ""),
    ),
  );
  startOpenAiProfileLogin(profile.id);
  assert.equal(
    calls,
    1,
    "retry must not overlap the provider operation that timed out locally",
  );

  release();
  await waitFor(() =>
    listCredentialProfiles().find(
      (item) => item.id === profile.id && item.status === "ready",
    ),
  );
});

test("deleting a profile invalidates and cleans up a late login completion", async () => {
  const profile = createCredentialProfile({
    name: "OAuth deleted",
    provider: "openai-codex",
  });
  const agentDir = piAgentDir(profile.id);
  const root = dirname(agentDir);
  let release!: () => void;
  let markStarted!: () => void;
  const complete = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  setOpenAiProfileLoginForTests(async () => {
    markStarted();
    await complete;
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), '{"openai-codex":{}}', {
      mode: 0o600,
    });
  });

  startOpenAiProfileLogin(profile.id);
  await started;
  deleteCredentialProfile(profile.id);
  release();

  await waitFor(() => (existsSync(root) ? undefined : true));
  assert.equal(
    listCredentialProfiles().some((item) => item.id === profile.id),
    false,
  );
});

afterEach(() => {
  setOpenAiProfileLoginTimeoutForTests(null);
});

afterAll(() => {
  setOpenAiProfileLoginForTests(null);
  setOpenAiProfileLoginTimeoutForTests(null);
  rmSync(tmp, { recursive: true, force: true });
});
