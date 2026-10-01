import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "pi-fork-profile-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { hub } = await import("../hub.ts");
const { createCredentialProfile } = await import("../credentialProfiles.ts");
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

test("a pi fork persists its inherited profile and reopens through that runtime", async () => {
  const profile = createCredentialProfile({
    name: "Fork account",
    provider: "openai-codex",
  });
  const parentId = "fork-profile-parent";
  const entryId = "fork-profile-entry";
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
      "",
    ].join("\n"),
  );
  sessionStore.upsert({
    id: parentId,
    harness: "pi",
    agentType: "assistant",
    credentialProfileId: profile.id,
  });

  const internals = piStore as unknown as StoreInternals;
  const originalCreate = internals.create;
  const originalTrack = internals.track;
  const originalBroadcastSessions = hub.broadcastSessions;
  let childFile: string | undefined;
  let reopenedProfileId: string | undefined;

  internals.create = async (...args: unknown[]) => {
    const manager = args[1] as FakeSessionManager;
    const session = {
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      sessionManager: manager,
    };
    childFile = session.sessionFile;
    reopenedProfileId = args[5] as string;
    return { session, notices: [] };
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
      "assistant",
      parentFile,
      entryId,
      "at",
      "app-entry-1",
    );
    const childId = forked.sessionId;
    assert.notEqual(childId, parentId);
    assert.equal(sessionStore.get(childId)?.credentialProfileId, profile.id);

    // Simulate the first post-fork flush before process restart. The cold-open
    // path must recover the runtime profile from metadata, not live state.
    childFile = canonicalPiSessionPath(childId);
    mkdirSync(dirname(childFile), { recursive: true });
    writeFileSync(
      childFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: childId,
          timestamp: new Date().toISOString(),
          cwd: tmp,
          parentSession: parentFile,
        }),
        JSON.stringify({
          type: "message",
          id: entryId,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "user",
            content: "fork here",
            timestamp: Date.now(),
          },
        }),
        "",
      ].join("\n"),
    );

    reopenedProfileId = undefined;
    await piStore.acquireExisting("assistant", childFile, childId);
    assert.equal(
      reopenedProfileId,
      profile.id,
      "cold reopen resolves the persisted child binding",
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
