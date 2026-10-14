import assert from "node:assert/strict";
import { afterAll, beforeEach, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The registry resolves DATA_DIR during import, so isolate it before loading the
// module and avoid sharing any provider state with the normal test runtime.
const tmp = mkdtempSync(join(tmpdir(), "credential-profiles-test-"));
const previousHome = process.env.HOME;
process.env.HOME = join(tmp, "home");
process.env.DATA_DIR = join(tmp, "data");

const {
  claudeConfigDir,
  claudeProfileEnvironment,
  createCredentialProfile,
  deleteCredentialProfile,
  defaultOpenAiProfileId,
  ensureDefaultPiProfile,
  listCredentialProfiles,
  migrateLegacyDefaultPiProfile,
  piAgentDir,
  renameCredentialProfile,
  patchCredentialProfile,
  setCredentialProfileEnabled,
  subscribeCredentialProfileChanges,
  subscribeCredentialProfileDeleted,
  credentialProfileHasCredential,
  clearCredentialProfileLoginState,
  completeCredentialProfileLogin,
  credentialProfileSummaryById,
} = await import("./credentialProfiles.ts");
const { setChildProcessEnvOverlay } = await import("./subprocessEnv.ts");

const root = join(process.env.DATA_DIR, "credential-profiles");
const mode = (path: string) => statSync(path).mode & 0o777;

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(process.env.HOME!, { recursive: true, force: true });
});

test("keeps profile metadata and provider directories private without exposing auth", () => {
  const defaultProfile = ensureDefaultPiProfile();
  const openai = createCredentialProfile({
    name: "  Work   OpenAI ",
    provider: "openai-codex",
  });
  const claude = createCredentialProfile({
    name: "Claude work",
    provider: "claude",
  });
  const authPath = join(piAgentDir(openai.id), "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({ "openai-codex": { access: "secret-token" } }),
    { mode: 0o600 },
  );
  mkdirSync(claudeConfigDir(claude.id), { recursive: true });
  writeFileSync(
    join(claudeConfigDir(claude.id), ".credentials.json"),
    '{"token":"secret-token"}',
    { mode: 0o600 },
  );

  const profiles = listCredentialProfiles();
  assert.deepEqual(
    profiles.map((profile) => profile.name),
    ["Default OpenAI", "Default Claude", "Work OpenAI", "Claude work"],
  );
  assert.equal(
    profiles.find((profile) => profile.id === openai.id)?.status,
    "ready",
  );
  assert.equal(
    profiles.every((profile) => profile.enabled),
    true,
  );
  assert.equal(
    profiles.every((profile) => !profile.enterprise),
    true,
  );
  assert.equal(
    profiles.find((profile) => profile.id === claude.id)?.status,
    "ready",
  );
  assert.doesNotMatch(JSON.stringify(profiles), /secret-token/);
  assert.equal(mode(root), 0o700);
  assert.equal(mode(join(root, "profiles.json")), 0o600);
  assert.equal(mode(piAgentDir(defaultProfile.id)), 0o700);
  assert.equal(mode(piAgentDir(openai.id)), 0o700);
  assert.equal(mode(claudeConfigDir(claude.id)), 0o700);
  assert.equal(mode(authPath), 0o600);
});

test("allows the protected default account to be disabled in favor of a secondary profile", () => {
  ensureDefaultPiProfile();
  const secondary = createCredentialProfile({
    name: "Secondary",
    provider: "openai-codex",
  });

  const disabled = setCredentialProfileEnabled("default", false);
  assert.equal(disabled.enabled, false);
  assert.equal(defaultOpenAiProfileId(), secondary.id);
  assert.equal(
    listCredentialProfiles().find((profile) => profile.id === "default")
      ?.enabled,
    false,
  );

  setCredentialProfileEnabled("default", true);
  assert.equal(defaultOpenAiProfileId(), "default");
});

test("enterprise metadata is explicit, durable, and change-notified", () => {
  const profile = createCredentialProfile({
    name: "Enterprise",
    provider: "claude",
  });
  assert.equal(profile.enterprise, false);
  let changed = "";
  const unsubscribe = subscribeCredentialProfileChanges((id) => {
    changed = id;
  });
  const enterprise = patchCredentialProfile(profile.id, { enterprise: true });
  assert.equal(enterprise.enterprise, true);
  assert.equal(changed, profile.id);
  assert.equal(
    listCredentialProfiles().find((item) => item.id === profile.id)?.enterprise,
    true,
  );
  assert.equal(
    patchCredentialProfile(profile.id, { enterprise: false }).enterprise,
    false,
  );
  unsubscribe();
  assert.throws(
    () => patchCredentialProfile("missing-profile", { enterprise: true }),
    /not found/i,
  );
});

test("the protected Claude default reflects the normal user login without an isolated terminal override", () => {
  ensureDefaultPiProfile();
  const defaultConfig = join(process.env.HOME!, ".claude");
  const disconnected = listCredentialProfiles().find(
    (profile) => profile.id === "claude-default",
  );
  assert.equal(disconnected?.status, "disconnected");
  assert.equal(disconnected?.setup?.path, defaultConfig);
  assert.equal(disconnected?.setup?.command, "claude");

  mkdirSync(defaultConfig, { recursive: true });
  writeFileSync(
    join(defaultConfig, ".credentials.json"),
    '{"token":"default-secret"}',
    { mode: 0o600 },
  );
  const ready = listCredentialProfiles().find(
    (profile) => profile.id === "claude-default",
  );
  assert.equal(ready?.status, "ready");
  assert.equal(ready?.setup, undefined);
  const environment = claudeProfileEnvironment("claude-default");
  assert.equal(
    environment.CLAUDE_CONFIG_DIR,
    undefined,
    "the SDK should use the ordinary ~/.claude resolution",
  );
  assert.doesNotMatch(JSON.stringify(ready), /default-secret/);
});

test("seeds a legacy pi agent directory once into the protected default profile", () => {
  const legacy = join(tmp, "legacy-pi-agent");
  mkdirSync(join(legacy, "extensions"), { recursive: true });
  mkdirSync(join(legacy, "sessions"), { recursive: true });
  writeFileSync(join(legacy, "auth.json"), '{"github-copilot":{}}', {
    mode: 0o644,
  });
  writeFileSync(join(legacy, "extensions", "example.ts"), "export {};", {
    mode: 0o644,
  });
  writeFileSync(
    join(legacy, "sessions", "old.jsonl"),
    "old terminal transcript",
    { mode: 0o644 },
  );

  migrateLegacyDefaultPiProfile(legacy);
  const destination = piAgentDir("default");
  assert.equal(
    readFileSync(join(destination, "auth.json"), "utf8"),
    '{"github-copilot":{}}',
  );
  assert.equal(mode(join(destination, "auth.json")), 0o600);
  assert.equal(mode(join(destination, "extensions")), 0o700);
  assert.equal(mode(join(destination, "extensions", "example.ts")), 0o600);
  assert.equal(
    existsSync(join(destination, "sessions")),
    false,
    "legacy transcripts are not imported",
  );

  writeFileSync(join(legacy, "models.json"), "stale");
  migrateLegacyDefaultPiProfile(legacy);
  assert.equal(
    existsSync(join(destination, "models.json")),
    false,
    "the completed seed never reads ~/.pi again",
  );
});

test("scrubs ambient Claude credentials and manages non-default profile lifecycle", () => {
  const profile = createCredentialProfile({
    name: "Claude personal",
    provider: "claude",
  });
  const previous = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  process.env.ANTHROPIC_API_KEY = "ambient-api-key";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-oauth";
  process.env.CLAUDE_CONFIG_DIR = "/ambient/claude";
  try {
    setChildProcessEnvOverlay({ HTTPS_PROXY: "http://127.0.0.1:9/profile" });
    const environment = claudeProfileEnvironment(profile.id);
    assert.equal(environment.ANTHROPIC_API_KEY, undefined);
    assert.equal(environment.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(environment.CLAUDE_CONFIG_DIR, claudeConfigDir(profile.id));
    // One-shots, usage queries and the login terminal build on this env.
    assert.equal(environment.HTTPS_PROXY, "http://127.0.0.1:9/profile");
  } finally {
    setChildProcessEnvOverlay(null);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const renamed = renameCredentialProfile(profile.id, "  Claude  personal 2 ");
  assert.equal(renamed.name, "Claude personal 2");
  deleteCredentialProfile(profile.id);
  assert.equal(existsSync(join(root, profile.id)), false);
  assert.equal(
    listCredentialProfiles().some((item) => item.id === profile.id),
    false,
  );
  assert.throws(
    () => renameCredentialProfile("default", "Nope"),
    /default.*renamed/i,
  );
  assert.throws(() => deleteCredentialProfile("default"), /default.*deleted/i);
  assert.throws(
    () => renameCredentialProfile("claude-default", "Nope"),
    /default.*renamed/i,
  );
  assert.throws(
    () => deleteCredentialProfile("claude-default"),
    /default.*deleted/i,
  );
  assert.doesNotThrow(() => readFileSync(join(root, "profiles.json"), "utf8"));
});

test("metadata PATCH applies every field together and refuses invalid patches before effects", () => {
  const profile = createCredentialProfile({
    name: "Patch fixture",
    provider: "openai-codex",
  });
  const publications: Array<{ enabled: boolean; enterprise: boolean }> = [];
  const stop = subscribeCredentialProfileChanges((id) => {
    if (id !== profile.id) return;
    const current = credentialProfileSummaryById(id)!;
    publications.push({
      enabled: current.enabled,
      enterprise: current.enterprise,
    });
  });
  try {
    const patched = patchCredentialProfile(profile.id, {
      name: "  Enterprise  patch ",
      enabled: false,
      enterprise: true,
    });
    assert.equal(patched.name, "Enterprise patch");
    assert.equal(patched.enabled, false);
    assert.equal(patched.enterprise, true);
    assert.deepEqual(publications, [{ enabled: false, enterprise: true }]);
    const stored = readFileSync(join(root, "profiles.json"), "utf8");
    for (const invalid of [
      { enabled: true, enterprise: "true" },
      { enabled: "false", enterprise: false },
      { name: 10, enabled: true, enterprise: false },
      { name: " ", enabled: true, enterprise: false },
      {},
    ]) {
      assert.throws(() => patchCredentialProfile(profile.id, invalid));
      assert.equal(readFileSync(join(root, "profiles.json"), "utf8"), stored);
    }
    assert.equal(publications.length, 1);
    const reset = patchCredentialProfile(profile.id, {
      enabled: true,
      enterprise: false,
    });
    assert.equal(reset.enabled, true);
    assert.equal(reset.enterprise, false);
    assert.deepEqual(publications[1], { enabled: true, enterprise: false });
  } finally {
    stop();
  }
});

test("health follows registry deletion, disabling and completed login without leaking provider credentials", async () => {
  const {
    initializeAccountHealth,
    reportAccountRunFailure,
    readAccountHealth,
    sendAccountLoginAlertsTo,
  } = await import("./accountHealth.ts");
  initializeAccountHealth({
    profiles: listCredentialProfiles,
    hasCredential: credentialProfileHasCredential,
    broadcast: () => {},
    push: async () => {},
    subscribeChanges: subscribeCredentialProfileChanges,
    subscribeDeleted: subscribeCredentialProfileDeleted,
  });
  // A Claude-only installation has enabled defaults, but no OpenAI login alert.
  mkdirSync(claudeConfigDir("claude-default"), { recursive: true });
  writeFileSync(
    join(claudeConfigDir("claude-default"), ".credentials.json"),
    '{"token":"CLAUDE-SECRET"}',
  );
  const defaults = listCredentialProfiles();
  assert.equal(
    defaults.find((p) => p.id === "default")?.health.state,
    "needs-login",
  );
  let initialAlerts: string[] = [];
  sendAccountLoginAlertsTo({
    send: (message) => {
      if (message.type === "accountLoginAlerts")
        initialAlerts = message.accounts.map((a) => a.profileId);
    },
  });
  assert.deepEqual(initialAlerts, []);
  const profile = createCredentialProfile({
    name: "Private",
    provider: "openai-codex",
  });
  assert.equal(profile.health.state, "needs-login");
  writeFileSync(
    join(piAgentDir(profile.id), "auth.json"),
    JSON.stringify({ "openai-codex": { access: "SECRET" } }),
  );
  clearCredentialProfileLoginState(profile.id);
  assert.equal(
    credentialProfileSummaryById(profile.id)?.health.state,
    "unknown",
  );
  completeCredentialProfileLogin(profile.id);
  assert.equal(credentialProfileSummaryById(profile.id)?.health.state, "ok");
  reportAccountRunFailure(
    profile.id,
    { kind: "auth", loginDeath: true },
    "openai-codex",
  );
  assert.equal(
    credentialProfileSummaryById(profile.id)?.health.state,
    "needs-login",
  );
  const disabled = setCredentialProfileEnabled(profile.id, false);
  assert.equal(disabled.health.state, "needs-login");
  const accounts: string[] = [];
  sendAccountLoginAlertsTo({
    send: (message) => {
      if (message.type === "accountLoginAlerts")
        accounts.push(...message.accounts.map((a) => a.profileId));
    },
  });
  assert.equal(accounts.includes(profile.id), false);
  assert.doesNotMatch(JSON.stringify(disabled.health), /SECRET/);
  deleteCredentialProfile(profile.id);
  assert.equal(readAccountHealth(profile.id, true).state, "unknown");
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(tmp, { recursive: true, force: true });
});
