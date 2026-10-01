import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "draft-session-profile-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { Connection } = await import("./connection.ts");
const { createCredentialProfile } = await import("./credentialProfiles.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { hub } = await import("./hub.ts");

interface SentMessage {
  type?: string;
  message?: string;
}

test("message-level draft sessions inherit and persist the source pi profile", async () => {
  const profile = createCredentialProfile({
    name: "Draft source",
    provider: "openai-codex",
  });
  const parentId = "draft-profile-parent";
  const childId = "draft-profile-child";
  sessionStore.upsert({
    id: parentId,
    harness: "pi",
    agentType: "assistant",
    credentialProfileId: profile.id,
  });

  const originalAcquireNew = hub.acquireNew;
  const originalListSessions = hub.listSessions;
  const originalBroadcastSessions = hub.broadcastSessions;
  let acquiredOptions: unknown;
  const fakeLive = {
    key: childId,
    sessionId: childId,
    state: () => ({ sessionId: childId }),
    contextInfo: () => ({ sessionId: childId }),
  };
  (
    hub as unknown as {
      acquireNew: (...args: unknown[]) => Promise<typeof fakeLive>;
    }
  ).acquireNew = async (...args) => {
    acquiredOptions = args[3];
    return fakeLive;
  };
  (hub as unknown as { listSessions: () => Promise<unknown[]> }).listSessions =
    async () => [];
  (
    hub as unknown as { broadcastSessions: () => Promise<void> }
  ).broadcastSessions = async () => {};

  const sent: SentMessage[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(JSON.parse(payload) as SentMessage),
  };
  const connection = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs) as unknown as {
    onCreateDraftSession: (
      agentType: string,
      draftText: string,
    ) => Promise<void>;
    viewing: { sessionId: string };
    view: () => void;
  };
  // The draft inherits from the session ON SHOW, whether or not its harness is
  // open: a session viewed from storage has no live pi session to read.
  connection.viewing = { sessionId: parentId };
  connection.view = () => {};

  try {
    await connection.onCreateDraftSession("assistant", "Review this draft");
    assert.deepEqual(acquiredOptions, { credentialProfileId: profile.id });
    assert.equal(sessionStore.get(childId)?.credentialProfileId, profile.id);
    assert.ok(sent.some((message) => message.type === "draftSession"));
    assert.equal(
      sent.some((message) => message.type === "error"),
      false,
    );
  } finally {
    (hub as unknown as { acquireNew: typeof originalAcquireNew }).acquireNew =
      originalAcquireNew;
    (
      hub as unknown as { listSessions: typeof originalListSessions }
    ).listSessions = originalListSessions;
    (
      hub as unknown as { broadcastSessions: typeof originalBroadcastSessions }
    ).broadcastSessions = originalBroadcastSessions;
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
