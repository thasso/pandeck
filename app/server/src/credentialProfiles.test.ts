import assert from "node:assert/strict";
import { afterAll, beforeEach, test } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "credential-profiles-test-"));
const previousHome = process.env.HOME;
process.env.HOME = join(tmp, "home");
const dataDir = join(tmp, "data");
process.env.DATA_DIR = dataDir;

const {
  automaticProfileIdFor,
  availableAutomaticProfileIdFor,
  claudeConfigDir,
  claudeProfileEnvironment,
  createCredentialProfile,
  credentialProfileById,
  deleteCredentialProfile,
  listCredentialProfiles,
  piAgentDir,
  renameCredentialProfile,
  setCredentialProfileEnabled,
} = await import("./credentialProfiles.ts");
const { setChildProcessEnvOverlay } = await import("./subprocessEnv.ts");

const root = join(dataDir, "credential-profiles");
const mode = (path: string) => statSync(path).mode & 0o777;

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("fresh installations have no accounts or ambient CLI fallbacks", () => {
  assert.deepEqual(listCredentialProfiles(), []);
  assert.equal(existsSync(join(root, "profiles.json")), false);
  assert.equal(availableAutomaticProfileIdFor("claude"), undefined);
  assert.throws(() => automaticProfileIdFor("openai-codex"), /Sign in/);
  assert.throws(() => piAgentDir("default"), /no longer supported/);
  assert.throws(() => claudeConfigDir("claude-default"), /no longer supported/);
});

test("explicit accounts are private, provider-labeled, and selected only when enabled", () => {
  const claude = createCredentialProfile({ provider: "claude" });
  const openai = createCredentialProfile({ provider: "openai-codex" });
  assert.deepEqual(
    listCredentialProfiles().map((profile) => profile.name),
    ["Claude", "OpenAI"],
  );
  const stored = JSON.parse(
    readFileSync(join(root, "profiles.json"), "utf8"),
  ) as Array<{ id: string; name?: string }>;
  assert.equal(stored.find((item) => item.id === claude.id)?.name, undefined);
  assert.equal(automaticProfileIdFor("claude"), claude.id);
  assert.equal(automaticProfileIdFor("openai-codex"), openai.id);
  assert.equal(mode(root), 0o700);
  assert.equal(mode(join(root, "profiles.json")), 0o600);
  assert.equal(mode(piAgentDir(openai.id)), 0o700);
  assert.equal(mode(claudeConfigDir(claude.id)), 0o700);
  assert.equal(
    renameCredentialProfile(claude.id, "Work Claude").name,
    "Work Claude",
  );
  setCredentialProfileEnabled(claude.id, false);
  assert.equal(availableAutomaticProfileIdFor("claude"), undefined);
  assert.throws(() => automaticProfileIdFor("claude"), /Sign in/);
  setCredentialProfileEnabled(claude.id, true);
  deleteCredentialProfile(claude.id);
  assert.equal(existsSync(join(root, claude.id)), false);
  assert.equal(credentialProfileById(claude.id), undefined);
});

test("retired records stay on disk but cannot be listed, used, or mutated", () => {
  const account = createCredentialProfile({ provider: "claude" });
  const path = join(root, "profiles.json");
  const profiles = JSON.parse(readFileSync(path, "utf8")) as object[];
  profiles.unshift(
    {
      id: "default",
      name: "Default OpenAI",
      provider: "openai-codex",
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: "claude-default",
      name: "Default Claude",
      provider: "claude",
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
  );
  writeFileSync(path, JSON.stringify(profiles));
  assert.deepEqual(
    listCredentialProfiles().map((profile) => profile.id),
    [account.id],
  );
  assert.equal(automaticProfileIdFor("claude"), account.id);
  assert.equal(credentialProfileById("default"), undefined);
  assert.equal(credentialProfileById("claude-default"), undefined);
  assert.throws(
    () => setCredentialProfileEnabled("default", true),
    /no longer supported/,
  );
  assert.throws(
    () => renameCredentialProfile("default", "New"),
    /no longer supported/,
  );
  assert.throws(() => deleteCredentialProfile("default"), /preserved/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).length, 3);
});

test("Claude always scrubs ambient credentials and runs in its isolated directory", () => {
  const profile = createCredentialProfile({ provider: "claude" });
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
    assert.equal(environment.HTTPS_PROXY, "http://127.0.0.1:9/profile");
  } finally {
    setChildProcessEnvOverlay(null);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(tmp, { recursive: true, force: true });
});
