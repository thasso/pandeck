/**
 * A pi fork carries the parent's Build/Plan mode (Task 332): the fork's create
 * call requests the parent's mode and the forked session's durable record
 * persists it, so a fork of a Plan session opens in Plan.
 *
 * Run: pnpm --filter @assistant/server test src/piSdk/piForkMode.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "pi-fork-mode-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { hub } = await import("../hub.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { piStore } = await import("./piStore.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");

interface FakeSessionManager {
  getSessionId(): string;
  getSessionFile(): string | undefined;
}

interface StoreInternals {
  create: (
    ...args: unknown[]
  ) => Promise<{ session: unknown; notices: unknown[] }>;
  track: (
    _kind: string,
    session: { sessionId: string; sessionFile?: string },
    _notices: unknown[],
    _cwd: string,
  ) => { sessionId: string; sessionFile?: string };
}

test("a fork of a Plan session opens (and persists) in Plan", async () => {
  const parentId = "fork-mode-parent";
  const entryId = "fork-mode-entry";
  const assistantEntryId = "fork-mode-assistant";
  const parentFile = canonicalPiSessionPath(parentId);
  mkdirSync(dirname(parentFile), { recursive: true });
  writeFileSync(
    parentFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: parentId,
        timestamp: new Date().toISOString(),
        cwd: tmp,
      }),
      JSON.stringify({
        type: "message",
        id: entryId,
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "fork here", timestamp: Date.now() },
      }),
      JSON.stringify({
        type: "message",
        id: assistantEntryId,
        parentId: entryId,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "forkable" }],
          timestamp: Date.now(),
        },
      }),
      "",
    ].join("\n"),
  );
  sessionStore.upsert({
    id: parentId,
    harness: "pi",
    agentType: "workshop",
    mode: "plan",
  });
  sessionStore.freezeSkills(parentId, '["parent-skill"]');

  const internals = piStore as unknown as StoreInternals;
  const originalCreate = internals.create;
  const originalTrack = internals.track;
  const originalBroadcastSessions = hub.broadcastSessions;
  let requestedMode: unknown;
  let inheritedSkills: unknown;

  internals.create = async (...args: unknown[]) => {
    const manager = args[1] as FakeSessionManager;
    inheritedSkills = (args[6] as { inheritSkills?: unknown } | undefined)
      ?.inheritSkills;
    requestedMode = args[7];
    return {
      session: {
        sessionId: manager.getSessionId(),
        get sessionFile() {
          return manager.getSessionFile();
        },
        sessionManager: manager,
      },
      notices: [],
    };
  };
  internals.track = (_kind, session) => ({
    sessionId: session.sessionId,
    ...(session.sessionFile !== undefined
      ? { sessionFile: session.sessionFile }
      : {}),
  });
  (
    hub as unknown as { broadcastSessions: () => Promise<void> }
  ).broadcastSessions = async () => {};

  try {
    const forked = await piStore.forkSession(
      "workshop",
      parentFile,
      assistantEntryId,
      "at",
      "app-entry-1",
    );
    const childId = forked.sessionId;
    assert.notEqual(childId, parentId);
    assert.equal(
      forked.sessionFile,
      canonicalPiSessionPath(childId),
      "the fork immediately points at its canonical native transcript",
    );
    assert.equal(
      existsSync(canonicalPiSessionPath(childId)),
      true,
      "the fork's native transcript is recoverable by id after restart",
    );
    assert.deepEqual(
      inheritedSkills,
      ["parent-skill"],
      "the create call receives the parent's exact frozen skill list",
    );
    assert.equal(requestedMode, "plan", "create() is asked for Plan");
    assert.equal(
      sessionStore.get(childId)?.mode,
      "plan",
      "the fork's durable record starts in Plan",
    );
  } finally {
    internals.create = originalCreate;
    internals.track = originalTrack;
    (
      hub as unknown as { broadcastSessions: typeof originalBroadcastSessions }
    ).broadcastSessions = originalBroadcastSessions;
    rmSync(tmp, { recursive: true, force: true });
  }
});
