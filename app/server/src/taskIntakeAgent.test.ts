import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import {
  curateTaskIntake,
  parseCuratedTask,
  taskIntakeResearchTools,
} from "./taskIntakeAgent.ts";
import type { AgentTool } from "./mcp/tool.ts";
import { runClaudeSdkOneShot } from "./claudeSdk/oneShot.ts";
import { runPiOneShot, selectPiModelWithFallback } from "./piSdk/oneShot.ts";

vi.mock("./piSdk/oneShot.ts", () => ({
  runPiOneShot: vi.fn(),
  selectPiModelWithFallback: vi.fn(),
}));
vi.mock("./claudeSdk/oneShot.ts", () => ({
  runClaudeSdkOneShot: vi.fn(),
}));

const curatedJson = JSON.stringify({
  title: "Curated task",
  description:
    "## Action\n\nComplete the concrete follow-up.\n\n## Context\n\nRelevant evidence.",
});
const input = {
  title: "Raw Slack title",
  description: "Raw Slack context",
  sourceUrl: "https://example.slack.com/archives/C1/p1",
  projectId: "personal-assistant",
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Task Intake Agent output", () => {
  test("accepts the exact title/description JSON schema and normalizes title whitespace", () => {
    assert.deepEqual(
      parseCuratedTask(
        '```json\n{"title":"  Investigate\\n playback   failure ","description":"## Action\\n\\nCheck the trace."}\n```',
      ),
      {
        title: "Investigate playback failure",
        description: "## Action\n\nCheck the trace.",
      },
    );
  });

  test("rejects non-JSON, extra fields, incomplete fields, and schema boundaries", () => {
    assert.throws(() => parseCuratedTask("A useful task"), /invalid JSON/);
    assert.throws(
      () =>
        parseCuratedTask(
          '{"title":"Task","description":"## Action\\n\\nAct.","priority":"high"}',
        ),
      /exactly string title and description/,
    );
    assert.throws(
      () => parseCuratedTask('{"title":"Task"}'),
      /exactly string title and description/,
    );
    assert.throws(
      () =>
        parseCuratedTask('{"title":"   ","description":"## Action\\n\\nAct."}'),
      /invalid title/,
    );
    assert.throws(
      () =>
        parseCuratedTask(
          `{"title":"${"x".repeat(201)}","description":"## Action\\n\\nAct."}`,
        ),
      /invalid title/,
    );
    assert.throws(
      () => parseCuratedTask('{"title":"Task","description":"   "}'),
      /invalid description/,
    );
    assert.throws(
      () =>
        parseCuratedTask(
          `{"title":"Task","description":"${"x".repeat(50_001)}"}`,
        ),
      /invalid description/,
    );
    assert.throws(
      () =>
        parseCuratedTask(
          '{"title":"Task","description":"## Context\\n\\nBackground."}',
        ),
      /must begin with "## Action"/,
    );
    assert.throws(
      () =>
        parseCuratedTask(
          '{"title":"Task","description":"## Action\\n\\nAct.\\n\\nSource: Slack"}',
        ),
      /must not duplicate source metadata/,
    );
  });

  test("sends configured pi model, thinking, and additive guidance behind the fixed contract", async () => {
    const model = { id: "configured-pi-model" };
    vi.mocked(selectPiModelWithFallback).mockReturnValue(model as never);
    vi.mocked(runPiOneShot).mockResolvedValue({
      text: curatedJson,
      usage: {},
    } as never);

    const result = await curateTaskIntake(input, {
      provider: "custom-provider",
      modelId: "curator-v1",
      thinkingLevel: "high",
      projectId: "personal-assistant",
      additionalInstructions: "Prefer terse engineering titles.",
    });

    assert.deepEqual(result, {
      title: "Curated task",
      description:
        "## Action\n\nComplete the concrete follow-up.\n\n## Context\n\nRelevant evidence.",
    });
    assert.deepEqual(vi.mocked(selectPiModelWithFallback).mock.calls[0]?.[0], {
      provider: "custom-provider",
      modelId: "curator-v1",
    });
    const call = vi.mocked(runPiOneShot).mock.calls[0]?.[0];
    assert.equal(call?.model, model);
    assert.equal(call?.thinkingLevel, "high");
    assert.match(call?.systemPrompt ?? "", /You curate one imported Task/);
    assert.match(
      call?.systemPrompt ?? "",
      /Additional owner guidance[\s\S]*Prefer terse engineering titles/,
    );
    assert.match(call?.systemPrompt ?? "", /read-only Pandeck tools/);
    assert.ok(
      call?.tools?.every(
        (tool) => !/mutate|manage|write|edit|reply|send/.test(tool.name),
      ),
    );
    assert.match(
      call?.prompt ?? "",
      /applicationManagedMetadata[\s\S]*linkedProjectId[\s\S]*personal-assistant[\s\S]*already stored outside the description/,
    );
  });

  test("sends configured Claude model, thinking, and additive guidance behind the fixed contract", async () => {
    vi.mocked(runClaudeSdkOneShot).mockResolvedValue({
      text: curatedJson,
      usage: {},
    } as never);

    await curateTaskIntake(input, {
      provider: "claude-sdk",
      modelId: "sonnet",
      thinkingLevel: "medium",
      projectId: "personal-assistant",
      additionalInstructions: "Keep file references visible.",
    });

    const call = vi.mocked(runClaudeSdkOneShot).mock.calls[0]?.[0];
    assert.equal(call?.modelId, "sonnet");
    assert.equal(call?.thinkingLevel, "medium");
    assert.match(call?.systemPrompt ?? "", /You curate one imported Task/);
    assert.match(
      call?.systemPrompt ?? "",
      /Additional owner guidance[\s\S]*Keep file references visible/,
    );
    assert.equal(call?.maxTurns, 12);
    assert.ok((call?.tools?.length ?? 0) > 0);
  });

  test("exposes only allow-listed research tools and enforces a shared call budget", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const candidates = [
      {
        name: "slack_search",
        label: "Read",
        description: "",
        parameters: { type: "object" },
        execute,
      },
      {
        name: "slack_huddle_history",
        label: "Browser-backed read",
        description: "",
        parameters: { type: "object" },
        execute,
      },
      {
        name: "jira_mutate_issue",
        label: "Write",
        description: "",
        parameters: { type: "object" },
        execute,
      },
    ] as AgentTool[];
    const tools = taskIntakeResearchTools(candidates);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["slack_search"],
    );
    const ctx = {
      toolCallId: "call",
      session: {
        sessionId: "s",
        harness: "pi" as const,
        agentType: "assistant" as const,
      },
    };
    for (let index = 0; index < 10; index += 1)
      await tools[0]!.execute({}, ctx);
    await assert.rejects(
      () => tools[0]!.execute({}, ctx),
      /limited to 10 tool calls/,
    );
  });
});
