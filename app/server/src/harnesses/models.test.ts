import assert from "node:assert/strict";
import type {
  AppSettings,
  CredentialProfileSummary,
  ModelOption,
} from "@assistant/shared";
import { beforeEach, test, vi } from "vitest";
import {
  credentialProfileById,
  listCredentialProfiles,
  subscribeCredentialProfileChanges,
  subscribeCredentialProfileDeleted,
} from "../credentialProfiles.ts";
import {
  findModel,
  findModelForProfile,
  listModels,
  listModelsForProfile,
  subscribePickerModelsChanged as subscribePiPickerModelsChanged,
  toModelOption,
} from "../piSdk/models.ts";
import { CLAUDE_SDK_MODELS } from "../claudeSdk/modelSettings.ts";
import { resetClaudeAccountModelsForTests } from "./claudeAccountModels.ts";
import { curatedModelOption } from "./curatedModels.ts";
import {
  accountLacksModel,
  accountOffersModel,
  modelsForAccount,
  pickerModels,
  storedSessionModelOption,
  subscribePickerModelsChanged,
} from "./models.ts";

let claudeEnabled = true;

vi.mock("../piSdk/models.ts", () => ({
  findModel: vi.fn(),
  findModelForProfile: vi.fn(),
  listModels: vi.fn(),
  listModelsForProfile: vi.fn(),
  subscribePickerModelsChanged: vi.fn(),
  toModelOption: vi.fn(),
}));
vi.mock("../settings.ts", () => ({
  getSettings: () => ({ claudeSdk: { enabled: claudeEnabled } }),
}));
vi.mock("../credentialProfiles.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../credentialProfiles.ts")>()),
  credentialProfileById: vi.fn(),
  listCredentialProfiles: vi.fn(),
  subscribeCredentialProfileChanges: vi.fn(),
  subscribeCredentialProfileDeleted: vi.fn(),
}));

/** The registry these tests see: Claude accounts by id. */
let profiles: CredentialProfileSummary[] = [];
const profileChanged: ((id: string) => void)[] = [];
const profileDeleted: ((id: string) => void)[] = [];
let piPickerChanged: (() => void) | undefined;

function claudeAccount(id: string, enabled = true): CredentialProfileSummary {
  return {
    id,
    name: id,
    provider: "claude",
    enabled,
  } as CredentialProfileSummary;
}

/** The curated alias ids, in curated order. */
const CURATED = CLAUDE_SDK_MODELS.map((model) => model.id);
const ALL_IDS = CLAUDE_SDK_MODELS.map((model) => model.sdkModelId);
const NO_HAIKU = ALL_IDS.filter((id) => id !== "claude-haiku-5-5");

/** Give each listed account its snapshot, as a successful gateway read would. */
async function listings(byAccount: Record<string, string[]>): Promise<void> {
  const cache = resetClaudeAccountModelsForTests({
    read: async (id) => byAccount[id],
    readable: (id) => id in byAccount,
  });
  await cache.refresh({ profileIds: Object.keys(byAccount), force: true });
}

const claudeIds = (models: ModelOption[]): string[] =>
  models.filter((m) => m.provider === "claude-sdk").map((m) => m.id);

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
  profiles = [];
  profileChanged.length = 0;
  profileDeleted.length = 0;
  piPickerChanged = undefined;
  vi.mocked(listCredentialProfiles).mockImplementation(() => profiles);
  vi.mocked(credentialProfileById).mockImplementation((id) =>
    profiles.find((profile) => profile.id === id),
  );
  vi.mocked(subscribeCredentialProfileChanges).mockImplementation((fn) => {
    profileChanged.push(fn);
    return () => {};
  });
  vi.mocked(subscribeCredentialProfileDeleted).mockImplementation((fn) => {
    profileDeleted.push(fn);
    return () => {};
  });
  vi.mocked(subscribePiPickerModelsChanged).mockImplementation((fn) => {
    piPickerChanged = fn;
    return () => true;
  });
  // Every account unknown, and nothing read: no gateway.
  resetClaudeAccountModelsForTests({
    read: async () => undefined,
    readable: () => false,
  });
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
  // Exact ids only: display normalization never widens what an account offers.
  for (const id of ["claude-sonnet-5", "not-a-sonnet-model", "OPUS"])
    assert.equal(await accountOffersModel("c1", "claude-sdk", id), false, id);
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

test("a Claude account offers the curated models its listing names; unknown keeps the curated list", async () => {
  await listings({ c1: ALL_IDS, c2: NO_HAIKU });
  assert.deepEqual(
    claudeIds(await modelsForAccount({ id: "c1", provider: "claude" })),
    CURATED,
  );
  assert.deepEqual(
    claudeIds(await modelsForAccount({ id: "c2", provider: "claude" })),
    CURATED.filter((id) => id !== "haiku"),
  );
  assert.deepEqual(
    claudeIds(await modelsForAccount({ id: "c3", provider: "claude" })),
    CURATED,
    "an unknown account keeps every existing model",
  );
  assert.equal(await accountOffersModel("c1", "claude-sdk", "haiku"), true);
  assert.equal(await accountOffersModel("c2", "claude-sdk", "haiku"), false);
  assert.equal(await accountOffersModel("c3", "claude-sdk", "haiku"), true);

  assert.equal(await accountLacksModel("c2", "claude-sdk", "haiku"), true);
  assert.equal(
    await accountLacksModel("c2", "claude-sdk", "claude-haiku-5-5"),
    true,
  );
  assert.equal(await accountLacksModel("c1", "claude-sdk", "haiku"), false);
  assert.equal(await accountLacksModel("c3", "claude-sdk", "haiku"), false);
  assert.equal(await accountLacksModel("c2", "claude-sdk", "opus"), false);
  assert.equal(
    await accountLacksModel("c2", "claude-sdk", "not-curated"),
    false,
    "only a curated model can be proven absent",
  );
  assert.equal(
    await accountLacksModel("o1", "github-copilot", "gpt-test"),
    false,
    "pi models are never lacking in PR A",
  );

  claudeEnabled = false;
  assert.deepEqual(
    await modelsForAccount({ id: "c1", provider: "claude" }),
    [],
  );
});

test("the port waits (bounded) for an account's first listing", async () => {
  let reads = 0;
  resetClaudeAccountModelsForTests({
    read: async () => {
      reads += 1;
      return NO_HAIKU;
    },
    readable: () => true,
  });
  assert.equal(await accountOffersModel("c9", "claude-sdk", "haiku"), false);
  assert.equal(await accountLacksModel("c9", "claude-sdk", "haiku"), true);
  assert.equal(reads, 1, "one read, then the snapshot answers");
});

test("the Claude picker is the union over enabled Claude accounts, in curated order", async () => {
  const settings = { claudeSdk: { enabled: true } } as AppSettings;
  assert.deepEqual(claudeIds(pickerModels(settings)), CURATED, "no account");

  profiles = [claudeAccount("c1"), claudeAccount("c2")];
  await listings({ c1: NO_HAIKU, c2: ["claude-haiku-5-5"] });
  assert.deepEqual(
    claudeIds(pickerModels(settings)),
    CURATED,
    "an alias offered by only one account is still offered",
  );

  await listings({ c1: NO_HAIKU, c2: NO_HAIKU });
  assert.deepEqual(
    claudeIds(pickerModels(settings)),
    CURATED.filter((id) => id !== "haiku"),
  );

  profiles = [claudeAccount("c1"), claudeAccount("c2", false)];
  await listings({ c1: NO_HAIKU });
  assert.deepEqual(
    claudeIds(pickerModels(settings)),
    CURATED.filter((id) => id !== "haiku"),
    "a disabled account adds nothing",
  );

  profiles = [claudeAccount("c1"), claudeAccount("c3")];
  assert.deepEqual(
    claudeIds(pickerModels(settings)),
    CURATED,
    "an unknown enabled account offers the curated list",
  );
});

test("picker change notification: a listing change with an unchanged union, and a Claude account's enable, disable or deletion", async () => {
  profiles = [claudeAccount("c1"), claudeAccount("c2")];
  const cache = resetClaudeAccountModelsForTests({
    read: async (id) => (id === "c1" ? ALL_IDS : NO_HAIKU),
    readable: () => true,
  });
  let pushes = 0;
  const stop = subscribePickerModelsChanged(() => {
    pushes += 1;
  });

  // c1 keeps haiku in the union, so the union is unchanged by c2's listing.
  await cache.refresh({ profileIds: ["c1", "c2"], force: true });
  assert.equal(pushes, 2, "each account's first listing is a change");
  await cache.refresh({ profileIds: ["c1", "c2"], force: true });
  assert.equal(pushes, 2, "an unchanged listing pushes nothing");

  piPickerChanged!();
  assert.equal(pushes, 3, "a pi catalog change still pushes");

  profiles = [claudeAccount("c1"), claudeAccount("c2", false)];
  for (const fn of profileChanged) fn("c2");
  assert.equal(pushes, 4, "disabling a Claude account pushes");
  for (const fn of profileChanged) fn("c2");
  assert.equal(pushes, 4, "a change that keeps it disabled does not");

  profiles = [claudeAccount("c1")];
  for (const fn of profileDeleted) fn("c2");
  for (const fn of profileChanged) fn("c2");
  assert.equal(pushes, 5, "deleting a Claude account pushes once here");

  profiles = [claudeAccount("c1"), claudeAccount("c4")];
  for (const fn of profileChanged) fn("c4");
  assert.equal(pushes, 6, "a new enabled Claude account pushes");
  stop();
});
