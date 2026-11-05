/**
 * The former single endpoint (`settings/openai-compatible.json`) moves to the
 * account `openai-compatible` (`docs/settings.md`): verified, committed by its
 * registry entry, and only then deleted. A crash at any step converges on the
 * next boot; nothing it logs carries the key or the URL.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@assistant/shared";
import {
  credentialProfileById,
  deleteCredentialProfile,
  DEFAULT_OPENAI_PROFILE_ID,
  ensureDefaultPiProfile,
  LEGACY_OPENAI_COMPATIBLE_SETTINGS_PATH,
  listCredentialProfiles,
  migrateOpenAiCompatibleSettingsToAccount,
  patchCredentialProfile,
  type OpenAiCompatibleMigrationStep,
} from "./credentialProfiles.ts";
import {
  openAiCompatibleEndpointPath,
  readOpenAiCompatibleEndpoint,
  writeOpenAiCompatibleEndpoint,
} from "./openAiCompatibleAccounts.ts";

const settingsFile = await import("./appSettingsFile.ts");
const { normalizeCompatibleSettingsPins } =
  await import("./compatibleSettingsPins.ts");
const { getSettings } = await import("./settings.ts");
const { listSettingsModelSlots } = await import("./settingsModelSlots.ts");

const ID = OPENAI_COMPATIBLE_PROVIDER_ID;
/** Synthetic: only that it never reaches a log or summary is under test. */
const FAKE_API_KEY = "fake-migration-key";
const BASE_URL = "https://fixture-llm.example.invalid/v1";

const LEGACY = {
  enabled: true,
  name: "  Team   LLM ",
  baseUrl: `${BASE_URL}/`,
  apiKey: FAKE_API_KEY,
  thinkingFormat: "qwen-chat-template",
  models: [
    {
      id: "qwen3-32b",
      name: "Qwen 3",
      input: ["text"],
      contextWindow: 32_768,
      maxTokens: 8192,
      reasoning: true,
    },
  ],
};

let warnings: string[];

function writeLegacy(content: unknown): void {
  mkdirSync(dirname(LEGACY_OPENAI_COMPATIBLE_SETTINGS_PATH), {
    recursive: true,
  });
  writeFileSync(
    LEGACY_OPENAI_COMPATIBLE_SETTINGS_PATH,
    typeof content === "string" ? content : JSON.stringify(content),
    { mode: 0o600 },
  );
}

function legacyExists(): boolean {
  return existsSync(LEGACY_OPENAI_COMPATIBLE_SETTINGS_PATH);
}

/** The migrated account as a crash-free run leaves it. */
function assertMigrated(): void {
  assert.equal(legacyExists(), false);
  const account = credentialProfileById(ID);
  assert.ok(account);
  assert.equal(account.provider, "openai-compatible");
  assert.equal(account.name, "Team LLM");
  assert.equal(account.enabled, true);
  const endpoint = readOpenAiCompatibleEndpoint(ID);
  assert.equal(endpoint.baseUrl, BASE_URL);
  assert.equal(endpoint.apiKey, FAKE_API_KEY);
  assert.equal(endpoint.thinkingFormat, "qwen-chat-template");
  assert.deepEqual(
    endpoint.models.map((model) => model.id),
    ["qwen3-32b"],
  );
  assert.equal(statSync(openAiCompatibleEndpointPath(ID)).mode & 0o777, 0o600);
}

beforeEach(() => {
  ensureDefaultPiProfile();
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  // No log line, whatever the outcome, names the key or the endpoint.
  for (const line of warnings) {
    assert.equal(line.includes(FAKE_API_KEY), false, line);
    assert.equal(line.includes("fixture-llm"), false, line);
  }
  vi.restoreAllMocks();
  rmSync(LEGACY_OPENAI_COMPATIBLE_SETTINGS_PATH, { force: true });
  if (credentialProfileById(ID)) deleteCredentialProfile(ID);
  rmSync(dirname(openAiCompatibleEndpointPath(ID)), {
    recursive: true,
    force: true,
  });
  patchCredentialProfile(DEFAULT_OPENAI_PROFILE_ID, { enterprise: false });
});

test("no old file is a no-op", () => {
  migrateOpenAiCompatibleSettingsToAccount();
  assert.equal(credentialProfileById(ID), undefined);
  assert.deepEqual(warnings, []);
});

test("an old file holding nothing is deleted and creates no account", () => {
  writeLegacy({ enabled: false, name: "", baseUrl: "", models: [] });
  migrateOpenAiCompatibleSettingsToAccount();
  assert.equal(legacyExists(), false);
  assert.equal(credentialProfileById(ID), undefined);
});

test("the endpoint moves to the account, verified, and the old file goes", () => {
  writeLegacy(LEGACY);
  migrateOpenAiCompatibleSettingsToAccount();
  assertMigrated();
  // The summary says a key is set, never what it is.
  const summary = listCredentialProfiles().find((p) => p.id === ID);
  assert.equal(summary?.status, "ready");
  assert.equal(summary?.endpoint?.apiKeyConfigured, true);
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(FAKE_API_KEY));
  // A second boot finds nothing to do.
  migrateOpenAiCompatibleSettingsToAccount();
  assertMigrated();
  assert.deepEqual(warnings, []);
});

test("the account copies Default OpenAI's enterprise flag and the file's enabled", () => {
  patchCredentialProfile(DEFAULT_OPENAI_PROFILE_ID, { enterprise: true });
  writeLegacy({ ...LEGACY, enabled: false, name: "" });
  migrateOpenAiCompatibleSettingsToAccount();
  const account = credentialProfileById(ID);
  assert.equal(account?.enterprise, true);
  assert.equal(account?.enabled, false);
  assert.equal(account?.name, "OpenAI-compatible");
});

for (const step of [
  "endpoint-written",
  "endpoint-verified",
  "registry-committed",
] as const satisfies readonly OpenAiCompatibleMigrationStep[]) {
  test(`a crash after ${step} keeps the old file, and the next boot converges`, () => {
    writeLegacy(LEGACY);
    migrateOpenAiCompatibleSettingsToAccount({
      afterStep: (reached) => {
        if (reached === step) throw new Error(`crash at ${step}`);
      },
    });
    assert.equal(legacyExists(), true);
    assert.equal(
      credentialProfileById(ID) !== undefined,
      step === "registry-committed",
    );
    migrateOpenAiCompatibleSettingsToAccount();
    assertMigrated();
  });
}

test("a write that does not verify commits nothing", () => {
  writeLegacy(LEGACY);
  migrateOpenAiCompatibleSettingsToAccount({
    afterStep: (reached) => {
      if (reached === "endpoint-written")
        chmodSync(openAiCompatibleEndpointPath(ID), 0o644);
    },
  });
  assert.equal(legacyExists(), true);
  assert.equal(credentialProfileById(ID), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /did not read back unchanged/);
  migrateOpenAiCompatibleSettingsToAccount();
  assertMigrated();
});

test("an account edited since is left alone, and so is the old file", () => {
  writeLegacy(LEGACY);
  migrateOpenAiCompatibleSettingsToAccount({
    afterStep: (reached) => {
      if (reached === "registry-committed") throw new Error("crash");
    },
  });
  writeOpenAiCompatibleEndpoint(ID, {
    ...readOpenAiCompatibleEndpoint(ID),
    thinkingFormat: "openai",
  });
  migrateOpenAiCompatibleSettingsToAccount();
  assert.equal(legacyExists(), true);
  assert.equal(readOpenAiCompatibleEndpoint(ID).thinkingFormat, "openai");
  assert.match(warnings.at(-1)!, /left for manual review/);
});

for (const failure of [
  "endpoint-written",
  "endpoint-verified",
  "registry-committed",
  "verify",
  "verify-content",
  "write",
  "mismatch",
] as const) {
  test(`all eleven settings slots and peers converge independently of migration ${failure}`, () => {
    const seed = structuredClone(getSettings());
    const slots = listSettingsModelSlots(seed);
    assert.equal(slots.length, 11);
    for (const { slot } of slots)
      Object.assign(slot, {
        provider: ID,
        modelId: "qwen3-32b",
        credentialProfileId: "default",
      });
    seed.peerSpawnRuntimes = [
      {
        id: "legacy-peer",
        provider: ID,
        modelId: "qwen3-32b",
        credentialProfileId: "cp_carrier",
      },
      {
        id: "subscription-peer",
        provider: "openai-codex",
        modelId: "gpt",
        credentialProfileId: "cp_exact",
      },
    ] as never;
    const stored = {
      ...seed,
      unrelatedFixture: { keep: [1, "unchanged", { nested: true }] },
      nonCompatibleFixture: {
        provider: "openai-codex",
        modelId: "gpt",
        credentialProfileId: "cp_exact",
      },
    };
    const expected = structuredClone(stored);
    for (const { slot } of listSettingsModelSlots(expected))
      slot.credentialProfileId = ID;
    expected.peerSpawnRuntimes[0]!.credentialProfileId = ID;
    settingsFile.writeStoredAppSettings(stored);
    writeLegacy(LEGACY);
    if (failure === "write")
      mkdirSync(openAiCompatibleEndpointPath(ID), { recursive: true });
    migrateOpenAiCompatibleSettingsToAccount({
      afterStep: (step) => {
        if (
          step === failure ||
          (failure === "mismatch" && step === "registry-committed")
        )
          throw new Error("fixture crash");
        if (failure === "verify" && step === "endpoint-written")
          chmodSync(openAiCompatibleEndpointPath(ID), 0o644);
        if (failure === "verify-content" && step === "endpoint-written")
          writeOpenAiCompatibleEndpoint(ID, {
            ...readOpenAiCompatibleEndpoint(ID),
            thinkingFormat: "openai",
          });
      },
    });
    // models.ts runs this even when migration fails. Rule P needs no account.
    normalizeCompatibleSettingsPins();
    assert.equal(legacyExists(), true);
    assert.deepEqual(settingsFile.readStoredAppSettings(), expected);
    if (failure === "write")
      rmSync(openAiCompatibleEndpointPath(ID), { recursive: true });
    if (failure === "mismatch")
      writeOpenAiCompatibleEndpoint(ID, {
        ...readOpenAiCompatibleEndpoint(ID),
        thinkingFormat: "openai",
      });
    migrateOpenAiCompatibleSettingsToAccount();
    normalizeCompatibleSettingsPins();
    assert.deepEqual(settingsFile.readStoredAppSettings(), expected);
    if (failure === "mismatch") {
      assert.equal(legacyExists(), true);
      assert.equal(readOpenAiCompatibleEndpoint(ID).thinkingFormat, "openai");
    } else assertMigrated();
    const bytes = readFileSync(settingsFile.APP_SETTINGS_PATH, "utf8");
    const mtime = statSync(settingsFile.APP_SETTINGS_PATH).mtimeMs;
    const stableFiles = [
      settingsFile.APP_SETTINGS_PATH,
      openAiCompatibleEndpointPath(ID),
      join(dirname(dirname(openAiCompatibleEndpointPath(ID))), "profiles.json"),
      LEGACY_OPENAI_COMPATIBLE_SETTINGS_PATH,
    ].filter(existsSync);
    const identities = () =>
      stableFiles.map((path) => ({
        path,
        bytes: readFileSync(path, "utf8"),
        ino: statSync(path).ino,
        mtimeMs: statSync(path).mtimeMs,
      }));
    const before = identities();
    const writes = vi.spyOn(settingsFile, "writeStoredAppSettings");
    migrateOpenAiCompatibleSettingsToAccount();
    normalizeCompatibleSettingsPins();
    assert.equal(writes.mock.calls.length, 0);
    assert.equal(readFileSync(settingsFile.APP_SETTINGS_PATH, "utf8"), bytes);
    assert.equal(statSync(settingsFile.APP_SETTINGS_PATH).mtimeMs, mtime);
    assert.deepEqual(
      identities(),
      before,
      "second boot rewrites none of the settings, endpoint, registry or retained legacy files",
    );
  });
}

test("an unreadable old file is left for review without quoting it", () => {
  writeLegacy(`{"apiKey":"${FAKE_API_KEY}","baseUrl":"${BASE_URL}"`);
  migrateOpenAiCompatibleSettingsToAccount();
  assert.equal(legacyExists(), true);
  assert.equal(credentialProfileById(ID), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /unreadable/);
  assert.equal(
    readFileSync(LEGACY_OPENAI_COMPATIBLE_SETTINGS_PATH, "utf8").includes(
      FAKE_API_KEY,
    ),
    true,
  );
});
