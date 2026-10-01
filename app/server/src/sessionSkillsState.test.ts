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
const { PiLiveSession } = await import("./piSdk/PiLiveSession.ts");
const { SKILLS_RUNTIME_DIR } = await import("./config.ts");
const { skillRuntimePluginName, skillSetHash } =
  await import("./skills/skillRuntimeMaterializer.ts");

const host = {
  broadcastSessions: async () => {},
  noteRunStarted() {},
  checkPendingReload() {},
  isReloadQueued: () => false,
  browserRuntimesFor: () => [],
};

function piSession(
  id: string,
  agentType: "developer" | "assistant",
  branch: unknown[] = [],
) {
  const native = {
    sessionId: id,
    sessionFile: undefined,
    sessionName: undefined,
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => [],
      getHeader: () => undefined,
    },
    model: undefined,
    thinkingLevel: "off",
    subscribe: () => () => {},
    getSessionStats: () => ({ totalMessages: 0 }),
    dispose() {},
  };
  return new PiLiveSession(agentType, native as never, host, () => {});
}

test("both harness SessionState projections carry frozen coding skills", () => {
  sessionStore.freezeSkills("claude-coding", '["claude-skill"]');
  const claude = new ClaudeSdkSession("claude-coding", {
    seam: async () => {
      throw new Error("unused");
    },
    agentType: "developer",
  });
  assert.deepEqual(claude.state().activeSkills, ["claude-skill"]);
  assert.deepEqual(claude.state().skillInvocations, []);

  sessionStore.freezeSkills("pi-coding", '["pi-skill"]');
  const pi = piSession("pi-coding", "developer");
  try {
    assert.deepEqual(pi.state().activeSkills, ["pi-skill"]);
  } finally {
    pi.dispose();
  }
});

test("both harness projections derive skill loads from their transcripts", () => {
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

  sessionStore.freezeSkills("pi-loaded", '["pi-skill"]');
  const skillFile = join(
    SKILLS_RUNTIME_DIR,
    skillSetHash(["pi-skill"]),
    "skills",
    "pi-skill",
    "SKILL.md",
  );
  const pi = piSession("pi-loaded", "developer", [
    {
      type: "message",
      message: {
        role: "assistant",
        timestamp: 5_000,
        content: [
          {
            type: "toolCall",
            id: "r1",
            name: "read",
            arguments: { path: skillFile },
          },
          {
            type: "toolCall",
            id: "r2",
            name: "read",
            arguments: { path: join(tmp, "elsewhere", "SKILL.md") },
          },
          {
            type: "toolCall",
            id: "r3",
            name: "read",
            arguments: { path: skillFile },
          },
          {
            type: "toolCall",
            id: "r4",
            name: "read",
            arguments: { path: skillFile },
          },
        ],
      },
    },
    { type: "message", message: { role: "toolResult", toolCallId: "r1" } },
    { type: "message", message: { role: "toolResult", toolCallId: "r2" } },
    // r3 failed; r4 is still running.
    {
      type: "message",
      message: { role: "toolResult", toolCallId: "r3", isError: true },
    },
  ]);
  try {
    assert.deepEqual(pi.state().skillInvocations, [
      { at: 5_000, name: "pi-skill", via: "read" },
    ]);
  } finally {
    pi.dispose();
  }
});

test("both harness SessionState projections omit skills for non-coding personas", () => {
  const claude = new ClaudeSdkSession("claude-assistant", {
    seam: async () => {
      throw new Error("unused");
    },
    agentType: "assistant",
  });
  assert.equal(Object.hasOwn(claude.state(), "activeSkills"), false);
  assert.equal(Object.hasOwn(claude.state(), "skillInvocations"), false);

  const pi = piSession("pi-assistant", "assistant");
  try {
    assert.equal(Object.hasOwn(pi.state(), "activeSkills"), false);
    assert.equal(Object.hasOwn(pi.state(), "skillInvocations"), false);
  } finally {
    pi.dispose();
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
