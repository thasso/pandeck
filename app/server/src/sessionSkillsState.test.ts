import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "session-skills-state-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { sessionStore } = await import("./db/sessionStore.ts");
const { ClaudeSdkSession } = await import("./claudeSdk/ClaudeSdkSession.ts");
const { skillRuntimePluginName, skillSetHash } =
  await import("./skills/skillRuntimeMaterializer.ts");

test("Claude SessionState carries frozen coding skills", () => {
  sessionStore.freezeSkills("claude-coding", '["claude-skill"]');
  const claude = new ClaudeSdkSession("claude-coding", {
    seam: async () => {
      throw new Error("unused");
    },
    agentType: "developer",
  });
  assert.deepEqual(claude.state().activeSkills, ["claude-skill"]);
  assert.deepEqual(claude.state().skillInvocations, []);
});

test("Claude derives skill loads from its transcript", () => {
  const plugin = skillRuntimePluginName(skillSetHash(["claude-skill"]));
  sessionStore.freezeSkills("claude-loaded", '["claude-skill"]');
  const claude = new ClaudeSdkSession("claude-loaded", {
    seam: async () => {
      throw new Error("unused");
    },
    agentType: "developer",
    entries: [
      {
        id: "a1",
        seq: 1,
        createdAt: "2026-09-21T10:00:00.000Z",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            toolCallId: "t1",
            name: "Skill",
            input: { skill: `${plugin}:claude-skill` },
          },
          {
            type: "toolCall",
            toolCallId: "t2",
            name: "Skill",
            input: { skill: "claude-skill" },
          },
          {
            type: "toolCall",
            toolCallId: "t3",
            name: "Skill",
            input: { skill: `${plugin}:claude-skill` },
          },
          {
            type: "toolCall",
            toolCallId: "t4",
            name: "Skill",
            input: { skill: `${plugin}:claude-skill` },
          },
        ],
      },
      {
        id: "r1",
        seq: 2,
        createdAt: "2026-09-21T10:00:01.000Z",
        type: "message",
        role: "toolResult",
        toolCallId: "t1",
        content: [{ type: "text", text: "Launching skill" }],
      },
      {
        id: "r2",
        seq: 3,
        createdAt: "2026-09-21T10:00:01.000Z",
        type: "message",
        role: "toolResult",
        toolCallId: "t2",
        content: [{ type: "text", text: "Launching skill" }],
      },
      // t3 failed; t4 has no result yet.
      {
        id: "r3",
        seq: 4,
        createdAt: "2026-09-21T10:00:02.000Z",
        type: "message",
        role: "toolResult",
        toolCallId: "t3",
        isError: true,
        content: [{ type: "text", text: "Unknown skill" }],
      },
    ],
  });
  assert.deepEqual(claude.state().skillInvocations, [
    {
      at: Date.parse("2026-09-21T10:00:00.000Z"),
      name: "claude-skill",
      via: "skill_tool",
    },
  ]);
});

test("Claude omits skills for non-coding personas", () => {
  const claude = new ClaudeSdkSession("claude-assistant", {
    seam: async () => {
      throw new Error("unused");
    },
    agentType: "assistant",
  });
  assert.equal(Object.hasOwn(claude.state(), "activeSkills"), false);
  assert.equal(Object.hasOwn(claude.state(), "skillInvocations"), false);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
