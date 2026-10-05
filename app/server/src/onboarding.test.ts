import { afterAll, beforeEach, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  sessions: [] as object[],
  profiles: [] as {
    id: string;
    provider: "claude" | "openai-codex";
    enabled: boolean;
    status: string;
  }[],
  models: [] as { provider: string; id: string }[],
  save: vi.fn(async (_patch: unknown) => ({})),
}));
vi.mock("./db/sessionStore.ts", () => ({
  sessionStore: { list: () => mocks.sessions },
}));
vi.mock("./credentialProfiles.ts", () => ({
  credentialProfileById: (id: string) =>
    mocks.profiles.find((item) => item.id === id),
  listCredentialProfiles: () => mocks.profiles,
}));
vi.mock("./harnesses/models.ts", () => ({
  modelsForAccount: async () => mocks.models,
}));
vi.mock("./settings.ts", () => ({
  getSettings: () => ({
    permanentAssistant: {
      name: "Personal Assistant",
      provider: "openai-codex",
      modelId: "gpt-6-luna",
      thinkingLevel: "off",
      additionalInstructions: "",
    },
  }),
}));
vi.mock("./settingsService.ts", () => ({ saveSettings: mocks.save }));

const previousDataDir = process.env.DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "onboarding-test-"));
process.env.DATA_DIR = dataDir;
const { beginOnboarding, completeOnboarding, onboardingState } =
  await import("./onboarding.ts");
const pending = join(dataDir, "onboarding-pending");
const complete = join(dataDir, "onboarding-complete");
const appSettings = join(dataDir, "settings", "app.json");

beforeEach(() => {
  rmSync(pending, { force: true });
  rmSync(complete, { force: true });
  rmSync(join(dataDir, "settings"), { recursive: true, force: true });
  mocks.sessions = [];
  mocks.profiles = [];
  mocks.models = [];
  mocks.save.mockClear();
});
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
});

test("fresh detection is read-only; an explicit start survives partial settings and reloads", () => {
  expect(onboardingState()).toEqual({ required: true, guidedSetup: false });
  expect(existsSync(pending)).toBe(false);
  beginOnboarding();
  expect(existsSync(pending)).toBe(true);
  mkdirSync(join(dataDir, "settings"));
  writeFileSync(appSettings, "{}");
  expect(onboardingState()).toEqual({ required: true, guidedSetup: false });
});

test("existing settings or a stored session skip onboarding without writing markers", () => {
  mkdirSync(join(dataDir, "settings"));
  writeFileSync(appSettings, "{}");
  expect(onboardingState()).toEqual({ required: false, guidedSetup: false });
  expect(existsSync(pending)).toBe(false);
  expect(existsSync(complete)).toBe(false);
  rmSync(appSettings);
  mocks.sessions = [{}];
  expect(onboardingState().required).toBe(false);
  expect(existsSync(pending)).toBe(false);
});

test("protected defaults and unsigned accounts cannot finish setup", async () => {
  beginOnboarding();
  mocks.profiles = [
    { id: "default", provider: "openai-codex", enabled: true, status: "ready" },
    {
      id: "claude-default",
      provider: "claude",
      enabled: true,
      status: "ready",
    },
    { id: "named", provider: "claude", enabled: true, status: "disconnected" },
  ];
  await expect(completeOnboarding("default")).rejects.toThrow("new account");
  await expect(completeOnboarding("claude-default")).rejects.toThrow(
    "new account",
  );
  await expect(completeOnboarding("named")).rejects.toThrow(
    "Finish signing in",
  );
  expect(mocks.save).not.toHaveBeenCalled();
  expect(existsSync(complete)).toBe(false);
});

test("signed-in Claude enables its harness and pins the isolated account", async () => {
  beginOnboarding();
  mocks.profiles = [
    { id: "named", provider: "claude", enabled: true, status: "ready" },
  ];
  await completeOnboarding("named");
  expect(mocks.save).toHaveBeenCalledWith(
    expect.objectContaining({
      claudeSdk: { enabled: true },
      permanentAssistant: expect.objectContaining({
        provider: "claude-sdk",
        modelId: "sonnet",
        credentialProfileId: "named",
      }),
    }),
  );
  expect(onboardingState()).toEqual({ required: false, guidedSetup: true });
  await expect(completeOnboarding("named")).rejects.toThrow("already complete");
});

test("signed-in OpenAI chooses an offered model and does not mark complete after a failed save", async () => {
  beginOnboarding();
  mocks.profiles = [
    {
      id: "openai-named",
      provider: "openai-codex",
      enabled: true,
      status: "ready",
    },
  ];
  mocks.models = [{ provider: "openai-codex", id: "some-model" }];
  mocks.save.mockRejectedValueOnce(new Error("write failed"));
  await expect(completeOnboarding("openai-named")).rejects.toThrow(
    "write failed",
  );
  expect(onboardingState().required).toBe(true);
  await completeOnboarding("openai-named");
  expect(mocks.save).toHaveBeenLastCalledWith(
    expect.objectContaining({
      permanentAssistant: expect.objectContaining({
        provider: "openai-codex",
        modelId: "some-model",
        credentialProfileId: "openai-named",
      }),
    }),
  );
  expect(onboardingState()).toEqual({ required: false, guidedSetup: true });
});
