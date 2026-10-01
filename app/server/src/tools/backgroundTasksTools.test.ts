import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type {
  BackgroundWorkBackendPort,
  BackgroundWorkLaunchRequest,
  BackgroundWorkStopAllRequest,
  BackgroundWorkStopRequest,
} from "../backgroundWork/backends.ts";
import type { ReserveBackgroundWorkInput } from "../db/backgroundWorkStore.ts";
import type { ToolCallContext } from "../mcp/tool.ts";

const dataDir = mkdtempSync(join(tmpdir(), "background-tasks-tool-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const { backgroundTasksTool } = await import("./backgroundTasksTools.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { backgroundWorkStore } = await import("../db/backgroundWorkStore.ts");
const { backgroundWorkSupervisor } =
  await import("../backgroundWork/supervisor.ts");
const { getSettings, updateSettings } = await import("../settings.ts");

const stopAllRequests: BackgroundWorkStopAllRequest[] = [];
const testPort: BackgroundWorkBackendPort = {
  backend: "host-process",
  launch: async (_request: BackgroundWorkLaunchRequest) => ({
    launched: true,
  }),
  stop: async (_request: BackgroundWorkStopRequest) => ({
    acknowledged: true,
  }),
  stopAll: async (request) => {
    stopAllRequests.push(request);
    const itemIds = backgroundWorkStore
      .listItems({
        ownerSessionId: request.ownerSessionId,
        state: "active",
        limit: 200,
      })
      .map((item) => item.id);
    return { acknowledgedItemIds: itemIds, unconfirmedItemIds: [] };
  },
};
backgroundWorkSupervisor.registerBackend(testPort);

let serial = 0;
function makeSession(
  harness: "pi" | "claude-sdk" = "pi",
  scope: "user" | "internal" = "user",
) {
  serial += 1;
  const id = `background-tool-${serial}`;
  sessionStore.upsert({
    id,
    scope,
    harness,
    agentType: "developer",
  });
  return id;
}

function context(
  sessionId: string,
  harness: "pi" | "claude-sdk" = "pi",
  toolCallId = `call-${++serial}`,
): ToolCallContext {
  return {
    toolCallId,
    session: { sessionId, harness, agentType: "developer" },
  };
}

function reserve(
  ownerSessionId: string,
  harness: "pi" | "claude-sdk" = "pi",
): string {
  serial += 1;
  const input: ReserveBackgroundWorkInput = {
    ownerSessionId,
    backend: harness === "pi" ? "host-process" : "claude-query",
    kind: "shell",
    label: `owned task ${serial}`,
    sourceRequestId: `source-${serial}`,
    lifetimeMs: 60_000,
    settingsGeneration: 1,
    bootEpoch: "boot-test",
    ownerLimit: 100,
    ...(harness === "claude-sdk"
      ? { host: { epochKey: `epoch-${serial}`, emptyGraceMs: 100 } }
      : {}),
  };
  return backgroundWorkStore.reserveItem(input).id;
}

function details(
  result: Awaited<ReturnType<typeof backgroundTasksTool.execute>>,
) {
  return result.details as Record<string, unknown>;
}

describe("background_tasks", () => {
  test("lists deterministically with bounded cursor pagination and reads both harness owners", async () => {
    const piOwner = makeSession("pi");
    const claudeOwner = makeSession("claude-sdk");
    const piTasks = [reserve(piOwner), reserve(piOwner), reserve(piOwner)];
    const claudeTask = reserve(claudeOwner, "claude-sdk");

    const first = details(
      await backgroundTasksTool.execute(
        { operation: "list", limit: 2 },
        context(piOwner),
      ),
    );
    expect((first.items as unknown[]).length).toBe(2);
    expect(typeof first.nextCursor).toBe("string");
    for (const sensitive of [
      "providerTaskId",
      "pid",
      "processGroup",
      "outputPath",
      "environment",
      "credentials",
      "artifactBody",
    ])
      expect(JSON.stringify(first)).not.toContain(sensitive);
    // A row touched after page one must remain traversable: keyset ordering
    // uses immutable creation/id keys, not the mutable updated-at timestamp.
    const oldestTask = piTasks[0]!;
    backgroundWorkStore.markRunning({ itemId: oldestTask });
    const second = details(
      await backgroundTasksTool.execute(
        {
          operation: "list",
          limit: 2,
          cursor: first.nextCursor as string,
        },
        context(piOwner),
      ),
    );
    expect((second.items as unknown[]).length).toBe(1);
    expect((second.items as Array<{ taskId: string }>)[0]?.taskId).toBe(
      oldestTask,
    );
    await expect(
      backgroundTasksTool.execute(
        { operation: "list", cursor: "not-a-cursor" },
        context(piOwner),
      ),
    ).rejects.toThrow("cursor is invalid");

    const status = details(
      await backgroundTasksTool.execute(
        { operation: "status", taskId: claudeTask },
        context(claudeOwner, "claude-sdk"),
      ),
    );
    expect((status.item as { taskId: string }).taskId).toBe(claudeTask);
  });

  test("denies foreign and excluded ownership without metadata", async () => {
    const owner = makeSession();
    const foreign = makeSession();
    const taskId = reserve(foreign);
    const foreignError = await backgroundTasksTool
      .execute({ operation: "status", taskId }, context(owner))
      .catch((error: Error) => error);
    expect(foreignError).toEqual(
      new Error("Background task not found or not owned by this session."),
    );
    const excluded = makeSession("pi", "internal");
    await expect(
      backgroundTasksTool.execute({ operation: "list" }, context(excluded)),
    ).rejects.toThrow("not available to this session");
  });

  test("keeps reads available when admission is disabled and omits terminal time remaining", async () => {
    const owner = makeSession();
    const taskId = reserve(owner);
    backgroundWorkStore.terminalize({
      itemId: taskId,
      state: "completed",
      now: Date.now() + 1_000,
    });
    const previous = getSettings().backgroundWork;
    updateSettings({
      backgroundWork: { ...previous, enabled: false },
    });
    try {
      const status = details(
        await backgroundTasksTool.execute(
          { operation: "status", taskId },
          context(owner),
        ),
      );
      expect("remainingMs" in (status.item as object)).toBe(false);
    } finally {
      updateSettings({ backgroundWork: previous });
    }
  });

  test("passes the owner caller identity through a running Stop-all", async () => {
    const owner = makeSession();
    const taskId = reserve(owner);
    backgroundWorkStore.markRunning({ itemId: taskId });
    stopAllRequests.length = 0;
    const result = details(
      await backgroundTasksTool.execute(
        { operation: "stop_all", reason: "stop the current work" },
        context(owner, "pi", "running-stop-all"),
      ),
    );
    expect(result.result).toBe("accepted; finish your turn");
    expect(stopAllRequests).toHaveLength(1);
    expect(stopAllRequests[0]?.callerSessionId).toBe(owner);
    expect(stopAllRequests[0]?.protectOrdinaryTurn).toBe(true);
  });

  test("routes Stop and Stop-all through the supervisor and keeps repeated requests idempotent", async () => {
    const owner = makeSession();
    const taskId = reserve(owner);
    const first = details(
      await backgroundTasksTool.execute(
        { operation: "stop", taskId, reason: "cleanup" },
        context(owner, "pi", "same-request"),
      ),
    );
    expect(first.result).toBe("stopped");
    const second = details(
      await backgroundTasksTool.execute(
        { operation: "stop", taskId, reason: "cleanup" },
        context(owner, "pi", "same-request"),
      ),
    );
    expect(second.result).toBe("already-terminal");

    const rest = reserve(owner);
    const all = details(
      await backgroundTasksTool.execute(
        { operation: "stop_all", reason: "stop the rest" },
        context(owner, "pi", "stop-all-request"),
      ),
    );
    expect(all.result).toBe("accepted; finish your turn");
    expect(backgroundWorkStore.getItem(rest)?.state).toBe("not-started");
  });
});
