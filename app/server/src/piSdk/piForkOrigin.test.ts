/**
 * A pi fork records lineage in the id space the CLIENT holds.
 *
 * `piStore.forkSession` takes two ids that are easy to conflate: pi's native
 * entry id, the only thing its SessionManager can branch at, and OUR app log
 * entry id, the only thing a browser ever sees. The recorded
 * `forkOrigin.parentEntryId` is read back by the UI to focus the source message
 * in the parent's transcript ("Forked from …", and the branch panel's jump), so
 * storing the native id there produces a link that silently resolves to
 * nothing. The two ids also genuinely differ: a fork AT a tool-using turn
 * branches pi at the turn's last tool RESULT, which is not the row the user
 * clicked.
 *
 * Run: pnpm --filter @assistant/server test src/piSdk/piForkOrigin.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "pi-fork-origin-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { hub } = await import("../hub.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { piStore } = await import("./piStore.ts");
const { readForkOrigin } = await import("./forkOrigin.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");

type SessionManager = import("@earendil-works/pi-coding-agent").SessionManager;

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

/** A parent transcript whose turn ends on a tool RESULT, as pi orders them. */
function writeParent(id: string): string {
  const file = canonicalPiSessionPath(id);
  mkdirSync(dirname(file), { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(
    file,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: at,
        cwd: tmp,
      }),
      JSON.stringify({
        type: "message",
        id: "pi-user-1",
        parentId: null,
        timestamp: at,
        message: { role: "user", content: "read it", timestamp: Date.now() },
      }),
      JSON.stringify({
        type: "message",
        id: "pi-assistant-1",
        parentId: "pi-user-1",
        timestamp: at,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "on it" },
            { type: "toolCall", id: "call-1", name: "read", arguments: {} },
          ],
          timestamp: Date.now(),
        },
      }),
      JSON.stringify({
        type: "message",
        id: "pi-tool-1",
        parentId: "pi-assistant-1",
        timestamp: at,
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "file body" }],
          isError: false,
        },
      }),
      "",
    ].join("\n"),
  );
  return file;
}

test("the fork's recorded parent entry is OUR id, not pi's branch anchor", async () => {
  const parentId = "fork-origin-parent";
  const parentFile = writeParent(parentId);
  sessionStore.upsert({ id: parentId, harness: "pi", agentType: "developer" });

  const internals = piStore as unknown as StoreInternals;
  const originalCreate = internals.create;
  const originalTrack = internals.track;
  const originalBroadcastSessions = hub.broadcastSessions;
  let childManager: SessionManager | undefined;

  internals.create = async (...args: unknown[]) => {
    const manager = args[1] as SessionManager;
    childManager = manager;
    return {
      session: {
        sessionId: manager.getSessionId(),
        sessionFile: manager.getSessionFile(),
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
    // What `connection.ts` sends for a fork AT the assistant row: pi branches at
    // the tool result ending that turn, the user clicked our `app-entry-2`.
    await piStore.forkSession(
      "developer",
      parentFile,
      "pi-tool-1",
      "at",
      "app-entry-2",
    );

    const origin = readForkOrigin("developer", childManager!);
    assert.equal(
      origin?.parentEntryId,
      "app-entry-2",
      "lineage carries the app log id the client can resolve",
    );
    assert.notEqual(
      origin?.parentEntryId,
      "pi-tool-1",
      "and never pi's native anchor, which names nothing in a transcript",
    );
    assert.equal(origin?.parentSessionId, parentId);

    const branchIds = (childManager!.getBranch() as { id?: string }[]).map(
      (entry) => entry.id,
    );
    assert.ok(
      branchIds.includes("pi-tool-1"),
      "the native id still did its own job: the branch runs through the tool result",
    );
  } finally {
    internals.create = originalCreate;
    internals.track = originalTrack;
    hub.broadcastSessions = originalBroadcastSessions;
    rmSync(tmp, { recursive: true, force: true });
  }
});
