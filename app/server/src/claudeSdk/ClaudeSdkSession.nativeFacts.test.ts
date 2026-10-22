import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import type { SessionState } from "@assistant/shared";
import type { SkillInvocationTranscript } from "../skills/skillInvocations.ts";

const tmp = mkdtempSync(join(tmpdir(), "claude-native-facts-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(process.env.DATA_DIR, { recursive: true });

const { ClaudeSdkSession } = await import("./ClaudeSdkSession.ts");
const owner = await import("../sessionState.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { closeDb } = await import("../db/index.ts");
const { eagerToolNamesFor } = await import("../tools/catalog.ts");
const { sessionPromptConditions } = await import("../promptConditions.ts");
const { externalToolName } = await import("../mcp/names.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("Claude hands native facts to the owner without projecting app state or opening the SDK", () => {
  const seam = vi.fn(() =>
    Promise.reject(new Error("facts must not open the SDK")),
  );
  const id = "claude-native-facts";
  const at = "2026-01-01T00:00:00.000Z";
  sessionStore.upsert({ id, harness: "claude-sdk", agentType: "developer" });
  sessionStore.setCompactionWindow(id, 100_000);
  const session = new ClaudeSdkSession(id, {
    agentType: "developer",
    seam,
    modelId: "opus",
    thinkingLevel: "high",
    mode: "plan",
    forkOrigin: { parentSessionId: "parent", parentEntryId: "fork-point" },
    entries: [
      {
        type: "message",
        id: "csu-0",
        seq: 0,
        createdAt: at,
        role: "user",
        origin: { kind: "human" },
        skillCommand: "review",
        content: [],
      },
      {
        type: "message",
        id: "csa-1",
        seq: 1,
        createdAt: at,
        role: "assistant",
        nativeResponse: true,
        content: [
          {
            type: "toolCall",
            toolCallId: "skill",
            name: "Skill",
            input: { skill: "plugin:review" },
          },
          {
            type: "toolCall",
            toolCallId: "failed",
            name: "Read",
            input: { file_path: "/missing/SKILL.md" },
          },
          {
            type: "toolCall",
            toolCallId: "task",
            name: externalToolName("task_read"),
            input: { id: "1" },
          },
        ],
      },
      {
        type: "message",
        id: "result-2",
        seq: 2,
        createdAt: at,
        role: "toolResult",
        toolCallId: "skill",
        content: [],
      },
      {
        type: "message",
        id: "result-3",
        seq: 3,
        createdAt: at,
        role: "toolResult",
        toolCallId: "failed",
        isError: true,
        content: [],
      },
    ],
  });
  // Seed the CLI observation cache, not app policy or catalog data.
  const native = session as unknown as {
    toolLoadState: Map<string, { loaded: boolean; tokens: number }>;
    committedToolCalls(): SkillInvocationTranscript;
  };
  const transcript = vi.spyOn(native, "committedToolCalls");
  const projection = vi
    .spyOn(owner, "buildSessionState")
    .mockReturnValue({ sessionId: id } as SessionState);
  try {
    const initial = session.nativeFacts();
    expect(initial.live!.toolLoading!.loadedToolNames).toEqual(
      eagerToolNamesFor("developer", sessionPromptConditions(id, "developer")),
    );
    native.toolLoadState.set("task_read", { loaded: true, tokens: 42 });
    native.toolLoadState.set("slack_search", { loaded: true, tokens: 17 });
    native.toolLoadState.set("read", { loaded: false, tokens: 5 });
    const facts = session.nativeFacts();
    expect(Object.keys(facts).sort()).toEqual(
      [
        "harness",
        "agentType",
        "kind",
        "sessionFile",
        "forkOrigin",
        "model",
        "thinkingLevel",
        "mode",
        "live",
      ].sort(),
    );
    expect(facts).toMatchObject({
      harness: "claude-sdk",
      agentType: "developer",
      kind: "developer",
      sessionFile: id,
      forkOrigin: { parentSessionId: "parent", parentEntryId: "fork-point" },
      model: { provider: "claude-sdk", id: "opus" },
      thinkingLevel: "high",
      mode: "plan",
      live: {
        canSteer: session.canSteer,
        compactionWindow: session.compactionWindowStatus(),
      },
    });
    expect(facts.live!.toolLoading).toMatchObject({
      usedToolNames: new Set(["Skill", "Read", "task_read"]),
      tokensByName: new Map([
        ["task_read", 42],
        ["slack_search", 17],
        ["read", 5],
      ]),
      definitionNamePrefix: externalToolName(""),
      loadEvents: [],
    });
    expect(facts.live!.toolLoading!.loadedToolNames.has("task_read")).toBe(
      true,
    );
    expect(facts.live!.toolLoading!.loadedToolNames.has("slack_search")).toBe(
      true,
    );
    expect(facts.live!.toolLoading!.loadedToolNames.has("read")).toBe(false);
    expect(facts.live!.toolLoading).not.toHaveProperty("usableToolNames");
    expect(facts.live!.toolLoading).not.toHaveProperty("definitionCharsByName");
    expect(transcript).not.toHaveBeenCalled();
    expect(facts.live!.skillInvocationTranscript(["review"])).toEqual({
      calls: [
        {
          toolCallId: "skill",
          toolName: "Skill",
          input: { skill: "plugin:review" },
          at: Date.parse(at),
          turn: "1",
        },
        {
          toolCallId: "failed",
          toolName: "Read",
          input: { file_path: "/missing/SKILL.md" },
          at: Date.parse(at),
          turn: "1",
        },
        {
          toolCallId: "task",
          toolName: externalToolName("task_read"),
          input: { id: "1" },
          at: Date.parse(at),
          turn: "1",
        },
      ],
      succeeded: new Set(["skill"]),
      commands: [{ name: "review", at: Date.parse(at), turn: "1" }],
    });
    const browserRuntimeOwner = vi.fn(() => undefined);
    session.browserRuntimeOwner = browserRuntimeOwner;
    expect(session.state()).toEqual({ sessionId: id });
    expect(projection).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ model: facts.model, live: expect.any(Object) }),
      expect.any(Function),
    );
    projection.mock.calls[0]![2]!("browser-owner");
    expect(browserRuntimeOwner).toHaveBeenCalledExactlyOnceWith(
      "browser-owner",
    );
    expect(transcript).toHaveBeenCalledTimes(1);
    expect(seam).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    session.dispose();
  }
});
