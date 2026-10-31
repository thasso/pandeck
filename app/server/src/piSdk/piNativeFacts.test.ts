/** Pi's single state contract pins native extraction and owner delegation. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import type { SessionState } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "pi-native-facts-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { PiLiveSession } = await import("./PiLiveSession.ts");
const { localPiEngine } = await import("./piEngine.ts");
const { createPiToolActivation } = await import("./toolActivation.ts");
const { agentToolsFor, eagerToolNamesFor } =
  await import("../tools/catalog.ts");
const { toModelOption } = await import("./models.ts");
const { SKILLS_RUNTIME_DIR } = await import("../config.ts");
const { skillSetHash } = await import("../skills/skillRuntimeMaterializer.ts");
const { closeDb } = await import("../db/index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("pi hands the owner native identity, live limits, tool loading and the committed branch", () => {
  const id = "native-pi";
  const path = join(
    SKILLS_RUNTIME_DIR,
    skillSetHash(["review"]),
    "skills",
    "review",
    "SKILL.md",
  );
  const getBranch = vi.fn(() => [
    {
      type: "message",
      message: {
        role: "user",
        timestamp: 100,
        content: [
          {
            type: "text",
            text: `<skill name="review" location="${path}">\nReview`,
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        timestamp: 200,
        content: [
          {
            type: "toolCall",
            id: "success",
            name: "read",
            arguments: { path },
          },
          { type: "toolCall", id: "failed", name: "read", arguments: { path } },
          {
            type: "toolCall",
            id: "pending",
            name: "read",
            arguments: { path },
          },
        ],
      },
    },
    { type: "message", message: { role: "toolResult", toolCallId: "success" } },
    {
      type: "message",
      message: { role: "toolResult", toolCallId: "failed", isError: true },
    },
  ]);
  const model = {
    provider: "openai-codex",
    id: "gpt-6-sol",
    name: "Sol",
    contextWindow: 200_000,
    reasoning: true,
  };
  const native = {
    sessionId: id,
    sessionFile: join(tmp, "native.jsonl"),
    model,
    thinkingLevel: "high",
    sessionManager: {
      getBranch,
      getEntries: () => [
        {
          type: "custom",
          customType: "web.fork_origin",
          data: {
            harness: "pi",
            agentType: "developer",
            parentSessionFile: "parent.jsonl",
            parentSessionId: "parent",
            parentEntryId: "cut",
          },
        },
      ],
      getHeader: () => undefined,
    },
    subscribe: () => () => {},
    getSessionStats: () => ({ totalMessages: 0 }),
    dispose() {},
  };
  const buildSessionState = vi.fn(
    (_id: string, _facts: unknown) => ({ sessionId: id }) as SessionState,
  );
  const live = new PiLiveSession(
    "developer",
    localPiEngine(native as never),
    {
      sessionRowsChanged() {},
      noteRunStarted() {},
      checkPendingReload() {},
      isReloadQueued: () => false,
      buildSessionState,
    },
    () => {},
    [],
    tmp,
    "plan",
  );
  const activation = createPiToolActivation({
    sessionId: id,
    agentType: "developer",
    agentTools: agentToolsFor("developer"),
    eagerToolNames: eagerToolNamesFor("developer"),
    deferToolLoading: true,
    mode: () => "plan",
    applyActiveToolNames() {},
  });
  activation.initialize(["worktree_commit"], ["task_read"]);
  const window = {
    contextWindow: 200_000,
    underlyingReserve: 10_000,
    live: { applied: "confirmed" as const, appliedTokens: 100_000 },
  };
  vi.spyOn(live, "compactionWindowStatus").mockReturnValue(window);
  try {
    const facts = live.nativeFacts();
    expect(facts).toEqual({
      harness: "pi",
      kind: "developer",
      agentType: "developer",
      sessionFile: native.sessionFile,
      model: toModelOption(model as never),
      thinkingLevel: "high",
      mode: "plan",
      forkOrigin: {
        harness: "pi",
        agentType: "developer",
        parentSessionFile: "parent.jsonl",
        parentSessionId: "parent",
        parentEntryId: "cut",
      },
      live: {
        canSteer: true,
        compactionWindow: window,
        toolLoading: activation.loading(),
        skillInvocationTranscript: expect.any(Function),
      },
    });
    expect(
      facts.live!.toolLoading!.loadedToolNames.has("worktree_commit"),
    ).toBe(true);
    expect(facts.live!.toolLoading!.usedToolNames).toEqual(
      new Set(["task_read"]),
    );
    expect(
      facts.live!.toolLoading!.definitionCharsByName!.get("find_tools"),
    ).toBeGreaterThan(0);
    expect(facts.live!.toolLoading!.loadEvents).toEqual([
      { at: expect.any(Number), via: "reopen", names: ["worktree_commit"] },
    ]);
    expect(getBranch).not.toHaveBeenCalled();
    const transcript = facts.live!.skillInvocationTranscript;
    if (typeof transcript !== "function")
      throw new Error("Expected lazy pi transcript");
    expect(transcript(["review"])).toEqual({
      calls: [
        {
          toolCallId: "success",
          toolName: "read",
          input: { path },
          at: 200,
          turn: "1",
        },
        {
          toolCallId: "failed",
          toolName: "read",
          input: { path },
          at: 200,
          turn: "1",
        },
        {
          toolCallId: "pending",
          toolName: "read",
          input: { path },
          at: 200,
          turn: "1",
        },
      ],
      succeeded: new Set(["success"]),
      commands: [{ name: "review", at: 100, turn: "1" }],
    });
    live.broadcastState();
    expect(buildSessionState).not.toHaveBeenCalled();
    const viewer = { send: vi.fn() };
    live.addViewer(viewer);
    live.broadcastState();
    expect(viewer.send).toHaveBeenCalledExactlyOnceWith({
      type: "state",
      state: { sessionId: id },
    });
    live.removeViewer(viewer);
    const [sessionId, supplied] = buildSessionState.mock.calls.at(-1)!;
    expect(sessionId).toBe(id);
    expect(supplied).toEqual({
      ...facts,
      live: { ...facts.live!, skillInvocationTranscript: expect.any(Function) },
    });
    expect(buildSessionState).toHaveBeenCalledTimes(1);
  } finally {
    activation.dispose();
    live.dispose();
    vi.restoreAllMocks();
  }
});
