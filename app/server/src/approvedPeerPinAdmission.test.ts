/** Rule P must not depend on the nonblocking boot settings write succeeding. */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  supportedThinkingLevelsForModel,
  type PeerSpawnRuntime,
} from "@assistant/shared";

const root = mkdtempSync(join(tmpdir(), "approved-peer-pin-"));
process.env.HOME = join(root, "home");
process.env.ASSISTANT_CWD = root;
process.env.DATA_DIR = join(root, "data");
// Make a non-compatible built-in available without a login or any request.
process.env.OPENAI_API_KEY = "fixture-admission-openai-key";
mkdirSync(process.env.HOME);
const settingsDir = join(process.env.DATA_DIR, "settings");
mkdirSync(settingsDir, { recursive: true });
const legacyRow: PeerSpawnRuntime = {
  id: "legacy-endpoint",
  provider: "openai-compatible",
  modelId: "fixture-m",
  thinkingLevel: "off",
  credentialProfileId: "default",
  enabled: true,
  relativeCost: "low",
};
writeFileSync(
  join(settingsDir, "openai-compatible.json"),
  JSON.stringify({
    enabled: true,
    name: "Fixture endpoint",
    baseUrl: "http://127.0.0.1:9/v1",
    models: [
      {
        id: "fixture-m",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 32000,
        maxTokens: 4096,
      },
    ],
  }),
  { mode: 0o600 },
);
const appFile = join(settingsDir, "app.json");
const originalBytes = JSON.stringify({ peerSpawnRuntimes: [legacyRow] });
writeFileSync(appFile, originalBytes);
let expectedBytes = originalBytes;
let expectedStat = statSync(appFile);

// Inject EACCES only at the actual boot pin-rewrite leaf, not the resolver or
// final guard. The real normalizeCompatibleSettingsPins catches it and boot
// continues, leaving readable legacy settings on disk and in the settings API.
const settingsFile = await import("./appSettingsFile.ts");
const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
const pinWrite = vi
  .spyOn(settingsFile, "writeStoredAppSettings")
  .mockImplementation(() => {
    throw Object.assign(
      new Error("EACCES: fixture pin-normalization write denied"),
      { code: "EACCES" },
    );
  });
await import("./piSdk/models.ts");
const attemptedWrites = pinWrite.mock.calls.map(([value]) => value);
const bootWarnings = warnings.mock.calls.map(
  ([message, detail]) => `${String(message)} ${String(detail)}`,
);
pinWrite.mockRestore();
warnings.mockRestore();

const profiles = await import("./credentialProfiles.ts");
const { getSettings } = await import("./settings.ts");
const { resolveApprovedPeerRuntime, resetDirectPeerChildrenForTests } =
  await import("./peerSpawnRuntimes.ts");
const { spawnApprovedPeers, setSessionSpawnDepsForTests } =
  await import("./sessionSpawn.ts");
const { piModelForAccount, modelsForAccount } =
  await import("./harnesses/models.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { closeDb } = await import("./db/index.ts");
const accountA = profiles.createCredentialProfile({
  provider: "openai-codex",
  name: "Exact A",
});
const accountB = profiles.createCredentialProfile({
  provider: "openai-codex",
  name: "Exact B",
});
const openAi = (await modelsForAccount(accountA)).find(
  (model) => model.provider === "openai",
);
assert.ok(
  openAi,
  "synthetic env auth makes an installed non-compatible model available",
);
const openAiLevel = supportedThinkingLevelsForModel(openAi)[0]!;
const CREATE_REACHED = "FIXTURE_CREATE_REACHED";
let afterLookup: (() => void) | undefined;
let lookups = 0;
let createdAccounts: string[] = [];
let sender = 0;
let resetNeeded = false;

beforeEach(() => {
  // The first regression keeps the original boot file untouched. Later control
  // cases reset only their own deliberate settings edits.
  if (resetNeeded) writeFileSync(appFile, originalBytes);
  resetNeeded = true;
  expectedBytes = originalBytes;
  expectedStat = statSync(appFile);
  for (const id of ["openai-compatible", accountA.id, accountB.id])
    profiles.setCredentialProfileEnabled(id, true);
  resetDirectPeerChildrenForTests();
  afterLookup = undefined;
  lookups = 0;
  createdAccounts = [];
  setSessionSpawnDepsForTests({
    findPiModel: async (profileId, provider, modelId) => {
      const model = await piModelForAccount(profileId, provider, modelId);
      lookups++;
      afterLookup?.();
      return model;
    },
    create: async (spec) => {
      createdAccounts.push(spec.credentialProfileId);
      // The production admission guard has completed. Never start an engine
      // or send a prompt; this sentinel is the actual creation dependency.
      throw new Error(CREATE_REACHED);
    },
  });
});

afterEach(() => {
  setSessionSpawnDepsForTests(null);
  assert.equal(
    readFileSync(appFile, "utf8"),
    expectedBytes,
    "admission never persists the pin repair or undoes an explicit settings edit",
  );
  assert.equal(statSync(appFile).ino, expectedStat.ino);
  assert.equal(statSync(appFile).mtimeMs, expectedStat.mtimeMs);
});
afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

function row(): PeerSpawnRuntime {
  return getSettings().peerSpawnRuntimes[0]!;
}
// Explicit user edits for controls only. The regression itself never calls it.
function writeRow(patch: Partial<PeerSpawnRuntime>): void {
  const stored = JSON.parse(readFileSync(appFile, "utf8")) as {
    peerSpawnRuntimes: PeerSpawnRuntime[];
  };
  Object.assign(stored.peerSpawnRuntimes[0]!, patch);
  expectedBytes = JSON.stringify(stored);
  writeFileSync(appFile, expectedBytes);
  expectedStat = statSync(appFile);
}
async function spawn() {
  const id = `pin-admission-parent-${++sender}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    requiresEnterprise: false,
  });
  return (
    await spawnApprovedPeers({
      senderSessionId: id,
      rows: [
        {
          title: "Fixture peer",
          agentType: "assistant",
          profileId: legacyRow.id,
          prompt: "No engine is started",
        },
      ],
    })
  )[0]!;
}

test("failed boot pin normalization still admits a legacy carrier row to actual creation without rewriting settings", async () => {
  expect(attemptedWrites).toHaveLength(1);
  expect(attemptedWrites[0]).toMatchObject({
    peerSpawnRuntimes: [{ credentialProfileId: "openai-compatible" }],
  });
  expect(
    bootWarnings.some(
      (line) =>
        line.includes("pins were not normalized") && line.includes("EACCES"),
    ),
  ).toBe(true);
  expect(row().credentialProfileId).toBe("default");
  expect(
    (await resolveApprovedPeerRuntime(legacyRow.id)).credentialProfileId,
  ).toBe("openai-compatible");
  const result = await spawn();
  expect(result.error).toBe(CREATE_REACHED);
  expect(lookups).toBe(1);
  expect(createdAccounts).toEqual(["openai-compatible"]);
  expect(row().credentialProfileId).toBe("default");
});

test("an unchanged already-normalized endpoint pin reaches creation too", async () => {
  writeRow({ credentialProfileId: "openai-compatible" });
  expect((await spawn()).error).toBe(CREATE_REACHED);
  expect(createdAccounts).toEqual(["openai-compatible"]);
});

for (const field of ["provider", "modelId", "thinkingLevel"] as const)
  test(`a final ${field} edit still refuses before creation`, async () => {
    writeRow({ credentialProfileId: "openai-compatible" });
    afterLookup = () =>
      writeRow({
        [field]: field === "thinkingLevel" ? "high" : "changed-fixture",
      });
    expect((await spawn()).error).toMatch(
      /approved peer runtime changed while starting/,
    );
    expect(lookups).toBe(1);
    expect(createdAccounts).toEqual([]);
  });

test("a final approval disable still refuses before creation", async () => {
  writeRow({ credentialProfileId: "openai-compatible" });
  afterLookup = () => writeRow({ enabled: false });
  expect((await spawn()).error).toMatch(/no longer approved or is disabled/);
  expect(lookups).toBe(1);
  expect(createdAccounts).toEqual([]);
});

test("a final account disable still refuses before creation", async () => {
  writeRow({ credentialProfileId: "openai-compatible" });
  afterLookup = () =>
    profiles.setCredentialProfileEnabled("openai-compatible", false);
  expect((await spawn()).error).toMatch(/account is no longer enabled/);
  expect(lookups).toBe(1);
  expect(createdAccounts).toEqual([]);
});

test("a final cost-label change still refuses before creation", async () => {
  writeRow({ credentialProfileId: "openai-compatible" });
  afterLookup = () => writeRow({ relativeCost: "high" });
  expect((await spawn()).error).toMatch(/cost label changed/);
  expect(lookups).toBe(1);
  expect(createdAccounts).toEqual([]);
});

for (const control of [
  "unchanged",
  "changed-pin",
  "disabled-pin",
  "wrong-kind-pin",
] as const)
  test(`non-compatible exact-pin control: ${control}`, async () => {
    writeRow({
      provider: openAi.provider,
      modelId: openAi.id,
      thinkingLevel: openAiLevel,
      credentialProfileId: accountA.id,
    });
    if (control === "changed-pin")
      afterLookup = () => writeRow({ credentialProfileId: accountB.id });
    if (control === "disabled-pin")
      afterLookup = () =>
        profiles.setCredentialProfileEnabled(accountA.id, false);
    if (control === "wrong-kind-pin")
      writeRow({ credentialProfileId: "openai-compatible" });
    const result = await spawn();
    if (control === "unchanged") {
      expect(result.error).toBe(CREATE_REACHED);
      expect(createdAccounts).toEqual([accountA.id]);
    } else {
      expect(result.error).toMatch(
        control === "changed-pin"
          ? /approved peer runtime changed while starting/
          : control === "disabled-pin"
            ? /account is no longer enabled/
            : /cannot run right now/,
      );
      expect(createdAccounts).toEqual([]);
    }
    expect(lookups).toBe(control === "wrong-kind-pin" ? 0 : 1);
  });
