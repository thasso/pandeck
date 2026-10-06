import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_SDK_PROVIDER } from "@assistant/shared";

vi.mock("./piSdk/oneShot.ts", () => ({
  runPiOneShot: vi.fn(),
  selectPiModelWithFallback: vi.fn(),
}));
vi.mock("./claudeSdk/oneShot.ts", () => ({
  runClaudeSdkOneShot: vi.fn(),
}));

const tmp = mkdtempSync(join(tmpdir(), "settings-account-routing-test-"));
process.env.HOME = join(tmp, "home");
process.env.DATA_DIR = join(tmp, "data");

const { runClaudeSdkOneShot } = await import("./claudeSdk/oneShot.ts");
const { runPiOneShot, selectPiModelWithFallback } =
  await import("./piSdk/oneShot.ts");
const { createCredentialProfile, setCredentialProfileEnabled } =
  await import("./credentialProfiles.ts");
const { updateSettings } = await import("./settings.ts");
const { generateCommitMessageJson } = await import("./commitAgent.ts");
const { refinePromptText } = await import("./promptRefinement.ts");

const dataDir = process.env.DATA_DIR;
let primaryOpenAiId: string;
let primaryClaudeId: string;
const commitJson = JSON.stringify({
  status: "commit",
  subject: "Do the thing",
  body: "",
});

beforeEach(() => {
  vi.resetAllMocks();
  rmSync(join(dataDir, "credential-profiles"), {
    recursive: true,
    force: true,
  });
  rmSync(join(dataDir, "settings"), { recursive: true, force: true });
  primaryOpenAiId = createCredentialProfile({ provider: "openai-codex" }).id;
  primaryClaudeId = createCredentialProfile({ provider: "claude" }).id;
});

test("a Claude helper agent authenticates as its pinned account", async () => {
  const claude = createCredentialProfile({
    name: "Claude work",
    provider: "claude",
  });
  updateSettings({
    commitAgent: {
      provider: CLAUDE_SDK_PROVIDER,
      modelId: "sonnet",
      thinkingLevel: "off",
      credentialProfileId: claude.id,
    },
  });
  vi.mocked(runClaudeSdkOneShot).mockResolvedValue({
    text: commitJson,
    usage: {},
  } as never);

  await generateCommitMessageJson("diff", {
    provider: CLAUDE_SDK_PROVIDER,
    modelId: "sonnet",
    thinkingLevel: "off",
    credentialProfileId: claude.id,
  });

  assert.equal(
    vi.mocked(runClaudeSdkOneShot).mock.calls[0]?.[0]?.credentialProfileId,
    claude.id,
  );
});

test("a disabled pin degrades to the automatic account instead of failing the run", async () => {
  const claude = createCredentialProfile({
    name: "Claude work",
    provider: "claude",
  });
  setCredentialProfileEnabled(claude.id, false);
  vi.mocked(runClaudeSdkOneShot).mockResolvedValue({
    text: commitJson,
    usage: {},
  } as never);

  await generateCommitMessageJson("diff", {
    provider: CLAUDE_SDK_PROVIDER,
    modelId: "sonnet",
    thinkingLevel: "off",
    credentialProfileId: claude.id,
  });

  assert.equal(
    vi.mocked(runClaudeSdkOneShot).mock.calls[0]?.[0]?.credentialProfileId,
    primaryClaudeId,
  );
});

test("a pi helper agent resolves its model IN the account it will run on", async () => {
  const openai = createCredentialProfile({
    name: "Second OpenAI",
    provider: "openai-codex",
  });
  vi.mocked(selectPiModelWithFallback).mockResolvedValue({
    id: "gpt-4.1",
  } as never);
  vi.mocked(runPiOneShot).mockResolvedValue({
    text: "refined",
    usage: {},
  } as never);

  await refinePromptText({
    text: "make this better",
    settings: {
      provider: "github-copilot",
      modelId: "gpt-4.1",
      thinkingLevel: "off",
      credentialProfileId: openai.id,
    },
  });

  // The model handle and the runtime must come from the SAME account: a handle
  // from another account's registry is not usable by this run.
  assert.equal(
    vi.mocked(selectPiModelWithFallback).mock.calls[0]?.[1],
    openai.id,
  );
  assert.equal(
    vi.mocked(runPiOneShot).mock.calls[0]?.[0]?.credentialProfileId,
    openai.id,
  );
});

test("an unpinned agent follows the automatic account", async () => {
  vi.mocked(selectPiModelWithFallback).mockResolvedValue({
    id: "gpt-4.1",
  } as never);
  vi.mocked(runPiOneShot).mockResolvedValue({
    text: "refined",
    usage: {},
  } as never);

  await refinePromptText({
    text: "make this better",
    settings: {
      provider: "github-copilot",
      modelId: "gpt-4.1",
      thinkingLevel: "off",
    },
  });

  assert.equal(
    vi.mocked(runPiOneShot).mock.calls[0]?.[0]?.credentialProfileId,
    primaryOpenAiId,
  );
});

test("a refinement cut short by an error does not replace the draft", async () => {
  vi.mocked(selectPiModelWithFallback).mockResolvedValue({
    id: "gpt-4.1",
  } as never);
  vi.mocked(runPiOneShot).mockResolvedValue({
    text: "partial refin",
    usage: {},
    stopReason: "aborted",
    errorMessage: "aborted by provider",
  } as never);

  await assert.rejects(
    () =>
      refinePromptText({
        text: "make this better",
        settings: {
          provider: "github-copilot",
          modelId: "gpt-4.1",
          thinkingLevel: "off",
        },
      }),
    /aborted by provider/,
  );
});
