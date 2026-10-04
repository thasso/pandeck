import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { runOneShot } from "../harnesses/oneShot.ts";
import { installDaySynthesizer } from "./synthesisModel.ts";
import { setDaySynthesizer } from "./synthesisRunner.ts";

vi.mock("../harnesses/oneShot.ts", () => ({ runOneShot: vi.fn() }));
vi.mock("./synthesisRunner.ts", () => ({ setDaySynthesizer: vi.fn() }));
vi.mock("../settingsModelSlots.ts", () => ({
  accountForSlot: () => "profile-1",
}));
vi.mock("../settings.ts", () => ({
  getSettings: () => ({
    calendarDaySession: {
      provider: "openai-codex",
      modelId: "gpt-test",
      thinkingLevel: "medium",
    },
  }),
}));
vi.mock("../tools/knowledge/knowledgeBaseTools.ts", () => ({
  kbReadAssetTool: { name: "kb_read_asset" },
}));

type Synthesizer = (input: { prompt: string }) => Promise<unknown>;

function synthesizer(): Synthesizer {
  installDaySynthesizer();
  const installed = vi.mocked(setDaySynthesizer).mock.calls[0]?.[0];
  assert.ok(installed);
  return installed as unknown as Synthesizer;
}

beforeEach(() => {
  vi.resetAllMocks();
});

test("the synthesis runs on the day-session model with the asset reader", async () => {
  vi.mocked(runOneShot).mockResolvedValue({
    text: '```json\n{"ok": true}\n```',
    usage: {},
  });

  assert.deepEqual(await synthesizer()({ prompt: "day" }), { ok: true });
  const request = vi.mocked(runOneShot).mock.calls[0]?.[0];
  assert.equal(request?.model.modelId, "gpt-test");
  assert.equal(request?.credentialProfileId, "profile-1");
  assert.equal(request?.maxTurns, 12);
  assert.deepEqual(
    request?.tools?.map((tool) => tool.name),
    ["kb_read_asset"],
  );
});

test("partial output from a failed run is not a synthesis", async () => {
  vi.mocked(runOneShot).mockResolvedValue({
    text: '{"ok": true}',
    usage: {},
    failure: "The model stopped with error.",
  });

  await assert.rejects(
    () => synthesizer()({ prompt: "day" }),
    /The model stopped with error\./,
  );
});
