import assert from "node:assert/strict";
import type { MeetingMinutesScannerSettings } from "@assistant/shared";
import { beforeEach, test, vi } from "vitest";
import {
  NoHelperModelError,
  OneShotError,
  runOneShot,
} from "../../harnesses/oneShot.ts";
import { extractMinutesActions } from "./meetingMinutesScannerTools.ts";

vi.mock("../../harnesses/oneShot.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../harnesses/oneShot.ts")>()),
  runOneShot: vi.fn(),
}));
vi.mock("../../settingsModelSlots.ts", () => ({
  accountForSlot: () => "profile-1",
}));
vi.mock("../../userProfile.ts", () => ({ userDisplayName: () => "Tester" }));

const settings = {
  provider: "claude-sdk",
  modelId: "sonnet",
  thinkingLevel: "low",
  timeoutMs: 60_000,
  maxSourceChars: 10_000,
} as unknown as MeetingMinutesScannerSettings;

const scan = () =>
  extractMinutesActions({ title: "Weekly sync", text: "Notes.", settings });

type ScannerFailure = Error & {
  usage: { input: number; cacheWrite: number; totalTokens: number };
};

beforeEach(() => {
  vi.resetAllMocks();
});

test("a run that failed without text is a model failure carrying its usage", async () => {
  vi.mocked(runOneShot).mockRejectedValue(
    new OneShotError("rate limited", {
      inputTokens: 5,
      outputTokens: 1,
      cacheCreationTokens: 4,
    }),
  );

  await assert.rejects(scan, (err: unknown) => {
    const failure = err as ScannerFailure;
    assert.equal(failure.name, "ScannerAgentRunError");
    assert.equal(
      failure.message,
      "Meeting-minutes scanner model failed: rate limited",
    );
    assert.equal(failure.usage.input, 5);
    assert.equal(failure.usage.cacheWrite, 4);
    assert.equal(failure.usage.totalTokens, 10);
    return true;
  });
});

test("partial output from a failed run is rejected", async () => {
  vi.mocked(runOneShot).mockResolvedValue({
    text: '{"actions": []}',
    usage: { inputTokens: 2 },
    failure: "stopped early",
  });

  await assert.rejects(
    scan,
    (err: unknown) =>
      (err as ScannerFailure).message ===
        "Meeting-minutes scanner model failed: stopped early" &&
      (err as ScannerFailure).usage.input === 2,
  );
});

test("a missing model is not a scanner run failure", async () => {
  vi.mocked(runOneShot).mockRejectedValue(
    new NoHelperModelError(
      "No model is available for meeting-minutes scanning.",
    ),
  );

  await assert.rejects(
    scan,
    (err: unknown) => err instanceof NoHelperModelError,
  );
});

test("a successful run returns the parsed actions", async () => {
  vi.mocked(runOneShot).mockResolvedValue({
    text: '{"meetingSummary": "Synced.", "actions": []}',
    usage: {},
  });

  assert.deepEqual(await scan(), { meetingSummary: "Synced.", actions: [] });
  const request = vi.mocked(runOneShot).mock.calls[0]?.[0];
  assert.equal(request?.credentialProfileId, "profile-1");
  assert.deepEqual(
    { provider: request?.model.provider, modelId: request?.model.modelId },
    { provider: "claude-sdk", modelId: "sonnet" },
  );
});
