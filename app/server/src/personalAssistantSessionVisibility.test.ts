/**
 * Task 280: the singleton Personal Assistant is never an ordinary session row.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/personalAssistantSessionVisibility.test.ts
 *
 * Asserts the wire projection every session row passes through on its way to a
 * browser: the singleton is dropped from EVERY sessions-carrying message (not
 * just `ready`/`sessions` — `permanentAssistantOpened` is what put it back in
 * the sidebar), a one-row update about it is dropped outright, and the internal
 * `file` handle never leaves the process.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, SessionListItem } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "pa-session-visibility-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { Connection } = await import("./connection.ts");
const { permanentAssistantStore } =
  await import("./db/permanentAssistantStore.ts");

interface WireSessionRow extends SessionListItem {
  file?: string;
}

function row(
  id: string,
  agentType: SessionListItem["agentType"],
): WireSessionRow {
  return {
    id,
    file: `/sessions/${id}/native.jsonl`,
    harness: "pi",
    agentType,
    title: id,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 3,
  };
}

function connectionWithSink(): {
  send: (message: ServerMessage) => void;
  sent: ServerMessage[];
} {
  const sent: ServerMessage[] = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(JSON.parse(payload) as ServerMessage),
  };
  const connection = new (
    Connection as unknown as new (ws: unknown) => {
      send: (message: ServerMessage) => void;
    }
  )(ws);
  return { send: (message) => connection.send(message), sent };
}

function sessionsOf(message: ServerMessage): WireSessionRow[] {
  assert.ok(
    "sessions" in message && Array.isArray(message.sessions),
    `${message.type} carries session rows`,
  );
  return (message as { sessions: WireSessionRow[] }).sessions;
}

test("every sessions-carrying message drops the singleton and the internal file handle", () => {
  const singleton = row("pa-singleton", "personal-assistant");
  const ordinary = row("ordinary-chat", "assistant");
  const { send, sent } = connectionWithSink();

  // Every shape that carries a session list: the `sessions` topic snapshot
  // (the boot path, where the row would be the first thing painted) and the
  // archived read. Topic events are built public by `sessionsTopic.ts`
  // (`sessionListForcedRefresh.test.ts`: the singleton travels only as a
  // delete).
  const lists: ServerMessage[] = [
    {
      type: "sessionList",
      seq: 0,
      sessions: [singleton, ordinary],
      revisions: [],
      archivedSessionCount: 0,
    },
    {
      type: "archivedSessions",
      requestId: "archived-1",
      sessions: [singleton, ordinary],
      archivedSessionCount: 0,
    },
  ];
  for (const message of lists) send(message);

  assert.equal(sent.length, lists.length, "every list message is delivered");
  for (const message of sent) {
    const sessions = sessionsOf(message);
    assert.deepEqual(
      sessions.map((session) => session.id),
      [ordinary.id],
      `${message.type} keeps only ordinary rows`,
    );
    assert.equal(
      sessions.some((session) => session.file !== undefined),
      false,
      `${message.type} strips the provider-native file handle`,
    );
  }
});

test("the currently bound singleton stays hidden even under a legacy persona", () => {
  // A binding made before the dedicated persona existed points at an ordinary
  // `assistant` session. While it IS the singleton it must not be listed; the
  // row becomes ordinary history again once the binding is abandoned.
  const legacy = row("legacy-binding", "assistant");
  permanentAssistantStore.setSessionId(legacy.id);
  try {
    const { send, sent } = connectionWithSink();
    send({
      type: "sessionList",
      seq: 0,
      sessions: [legacy, row("ordinary-3", "assistant")],
      revisions: [],
      archivedSessionCount: 0,
    });
    assert.deepEqual(
      sessionsOf(sent[0]!).map((session) => session.id),
      ["ordinary-3"],
    );
  } finally {
    permanentAssistantStore.clearSessionId();
  }

  const { send, sent } = connectionWithSink();
  send({
    type: "sessionList",
    seq: 0,
    sessions: [legacy],
    revisions: [],
    archivedSessionCount: 0,
  });
  assert.deepEqual(
    sessionsOf(sent[0]!).map((session) => session.id),
    [legacy.id],
    "an abandoned legacy binding is ordinary history again",
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
