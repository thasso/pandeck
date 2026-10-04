import assert from "node:assert/strict";
import type { AppSettings, ModelOption } from "@assistant/shared";
import { beforeEach, test, vi } from "vitest";
import {
  findModel,
  findModelForProfile,
  listModels,
  listModelsForProfile,
  toModelOption,
} from "../piSdk/models.ts";
import { curatedModelOption } from "./curatedModels.ts";
import {
  accountOffersModel,
  modelsForAccount,
  pickerModels,
  storedSessionModelOption,
} from "./models.ts";

let claudeEnabled = true;

vi.mock("../piSdk/models.ts", () => ({
  findModel: vi.fn(),
  findModelForProfile: vi.fn(),
  listModels: vi.fn(),
  listModelsForProfile: vi.fn(),
  toModelOption: vi.fn(),
}));
vi.mock("../settings.ts", () => ({
  getSettings: () => ({ claudeSdk: { enabled: claudeEnabled } }),
}));

const piModel: ModelOption = {
  provider: "github-copilot",
  id: "gpt-test",
  name: "GPT Test",
  reasoning: false,
  contextWindow: 128_000,
};

beforeEach(() => {
  vi.resetAllMocks();
  claudeEnabled = true;
  vi.mocked(listModels).mockReturnValue([piModel]);
  vi.mocked(listModelsForProfile).mockResolvedValue([piModel]);
});

test("the pickers offer pi's models plus the curated Claude list while it is enabled", () => {
  const models = pickerModels({
    claudeSdk: { enabled: true },
  } as AppSettings);
  assert.deepEqual(models[0], piModel);
  assert.ok(models.some((m) => m.provider === "claude-sdk" && m.id === "opus"));
  assert.ok(models.every((m) => !("sdkModelId" in m)));

  assert.deepEqual(
    pickerModels({ claudeSdk: { enabled: false } } as AppSettings),
    [piModel],
  );
});

test("an account lists the models of the engine it signs in to", async () => {
  const claude = await modelsForAccount({ id: "c1", provider: "claude" });
  assert.ok(claude.length > 0);
  assert.ok(claude.every((m) => m.provider === "claude-sdk"));
  assert.equal(vi.mocked(listModelsForProfile).mock.calls.length, 0);

  claudeEnabled = false;
  assert.deepEqual(
    await modelsForAccount({ id: "c1", provider: "claude" }),
    [],
  );

  assert.deepEqual(
    await modelsForAccount({ id: "o1", provider: "openai-codex" }),
    [piModel],
  );
  assert.deepEqual(vi.mocked(listModelsForProfile).mock.calls[0], ["o1"]);
});

test("a pi registry failure reaches the caller", async () => {
  vi.mocked(listModelsForProfile).mockRejectedValue(new Error("no registry"));
  await assert.rejects(
    () => modelsForAccount({ id: "o1", provider: "openai-codex" }),
    /no registry/,
  );
});

test("an account offers exactly the model it can run", async () => {
  assert.equal(await accountOffersModel("c1", "claude-sdk", "opus"), true);
  assert.equal(await accountOffersModel("c1", "claude-sdk", "gpt-4"), false);
  claudeEnabled = false;
  assert.equal(await accountOffersModel("c1", "claude-sdk", "opus"), false);

  vi.mocked(findModelForProfile).mockResolvedValue(undefined);
  assert.equal(
    await accountOffersModel("o1", "github-copilot", "gpt-test"),
    false,
  );
  vi.mocked(findModelForProfile).mockResolvedValue({ id: "gpt-test" } as never);
  assert.equal(
    await accountOffersModel("o1", "github-copilot", "gpt-test"),
    true,
  );
  assert.deepEqual(vi.mocked(findModelForProfile).mock.calls[0], [
    "o1",
    "github-copilot",
    "gpt-test",
  ]);
});

test("only a curated harness resolves a model id to its option", () => {
  assert.equal(curatedModelOption("claude-sdk", "opus")?.id, "opus");
  assert.equal(
    curatedModelOption("claude-sdk", "not-a-claude-model"),
    undefined,
  );
  assert.equal(curatedModelOption("pi", "opus"), undefined);
});

test("a stored session's model renders from the harness that ran it", () => {
  // A Claude row stores the account kind as its provider; the alias decides.
  assert.equal(
    storedSessionModelOption("claude-sdk", "claude", "sonnet")?.id,
    "sonnet",
  );
  assert.equal(
    storedSessionModelOption("claude-sdk", "claude", undefined),
    undefined,
  );

  vi.mocked(findModel).mockReturnValue({ id: "gpt-test" } as never);
  vi.mocked(toModelOption).mockReturnValue(piModel);
  assert.deepEqual(
    storedSessionModelOption("pi", "github-copilot", "gpt-test"),
    piModel,
  );
  assert.deepEqual(vi.mocked(findModel).mock.calls[0], [
    "github-copilot",
    "gpt-test",
  ]);
  assert.equal(
    storedSessionModelOption("pi", undefined, "gpt-test"),
    undefined,
  );

  vi.mocked(findModel).mockReturnValue(undefined);
  assert.equal(
    storedSessionModelOption("pi", "github-copilot", "gone"),
    undefined,
  );
});
