import assert from "node:assert/strict";
import { afterAll, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "pi-profile-models-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

interface FakeModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow: number;
}

const modelsByAuthPath = new Map<string, FakeModel[]>();
const staleAvailableAuthPaths = new Set<string>();

vi.mock("@earendil-works/pi-coding-agent", () => {
  class FakeModelRuntime {
    readonly authPath: string;
    readonly models: FakeModel[];

    constructor(options: { authPath: string }) {
      this.authPath = options.authPath;
      this.models = modelsByAuthPath.get(options.authPath) ?? [];
    }

    static async create(options: { authPath: string }) {
      return new FakeModelRuntime(options);
    }

    async refresh() {}
    getError() {
      return undefined;
    }
    async login() {}
  }

  class FakeModelRegistry {
    constructor(private readonly runtime: FakeModelRuntime) {}
    getAvailable() {
      return staleAvailableAuthPaths.has(this.runtime.authPath)
        ? []
        : this.runtime.models;
    }
    getAll() {
      return this.runtime.models;
    }
    find(provider: string, id: string) {
      return this.runtime.models.find(
        (model) => model.provider === provider && model.id === id,
      );
    }
    registerProvider() {}
    unregisterProvider() {}
  }

  return { ModelRegistry: FakeModelRegistry, ModelRuntime: FakeModelRuntime };
});

const { createCredentialProfile, piAgentDir } =
  await import("../credentialProfiles.ts");
const primary = createCredentialProfile({
  name: "Primary",
  provider: "openai-codex",
});
const secondary = createCredentialProfile({
  name: "Secondary",
  provider: "openai-codex",
});
const defaultModel: FakeModel = {
  id: "default-only",
  name: "Default only",
  provider: "openai-codex",
  reasoning: true,
  contextWindow: 100_000,
};
const secondaryModel: FakeModel = {
  id: "secondary-only",
  name: "Secondary only",
  provider: "openai-codex",
  reasoning: true,
  contextWindow: 100_000,
};
modelsByAuthPath.set(join(piAgentDir(primary.id), "auth.json"), [defaultModel]);
modelsByAuthPath.set(join(piAgentDir(secondary.id), "auth.json"), [
  secondaryModel,
]);

const { findModelForProfile, listModelsForProfile } =
  await import("./models.ts");

test("profile model projection and lookup use the selected isolated runtime", async () => {
  assert.deepEqual(
    (await listModelsForProfile(primary.id)).map((model) => model.id),
    ["default-only"],
  );
  assert.deepEqual(
    (await listModelsForProfile(secondary.id)).map((model) => model.id),
    ["secondary-only"],
  );
  assert.equal(
    await findModelForProfile(secondary.id, "openai-codex", "default-only"),
    undefined,
  );
  assert.equal(
    (await findModelForProfile(secondary.id, "openai-codex", "secondary-only"))
      ?.id,
    "secondary-only",
  );
});

test("persisted OpenAI auth projects models before the SDK availability refresh settles", async () => {
  const authPath = join(piAgentDir(secondary.id), "auth.json");
  writeFileSync(authPath, '{"openai-codex":{}}', { mode: 0o600 });
  staleAvailableAuthPaths.add(authPath);

  assert.deepEqual(
    (await listModelsForProfile(secondary.id)).map((model) => model.id),
    ["secondary-only"],
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
