/**
 * A live pi session's state carries the registry's direct-spawn identity, as
 * the stored view and the Claude SDK state do: the browser keeps a waiting
 * child's page on that evidence before the child has a message or a list row.
 *
 *   pnpm --filter @assistant/server test src/piSdk/piDirectSpawnState.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "pi-direct-spawn-state-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { PiLiveSession } = await import("./PiLiveSession.ts");
const { directPeerChildStore } = await import("../db/directPeerChildStore.ts");
const { closeDb } = await import("../db/index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function liveSession(sessionId: string) {
  return new PiLiveSession(
    "developer" as never,
    {
      sessionId,
      sessionName: "Child",
      isStreaming: false,
      sessionManager: {
        getBranch: () => [],
        getEntries: () => [],
        getHeader: () => undefined,
      },
      subscribe: () => () => {},
      getSessionStats: () => ({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        contextSize: 0,
      }),
      dispose: () => {},
    } as never,
    {
      broadcastSessions: () => Promise.resolve(),
      noteRunStarted: () => {},
      checkPendingReload: () => {},
      isReloadQueued: () => false,
      browserRuntimesFor: () => [],
    } as never,
    () => {},
  );
}

test("a directly spawned child's state names its spawner; no other session's does", () => {
  directPeerChildStore.record({
    childSessionId: "pi-child",
    spawnerSessionId: "pi-spawner",
    costClass: "counted",
    source: { kind: "profile", profileId: "pr_test" },
    provider: "openai-codex",
    modelId: "gpt-6-sol",
    thinkingLevel: "high",
    credentialProfileId: "acct",
    createdAt: Date.now(),
  });
  expect(liveSession("pi-child").state().directSpawnedBy).toBe("pi-spawner");
  expect(liveSession("pi-plain").state()).not.toHaveProperty("directSpawnedBy");
});
