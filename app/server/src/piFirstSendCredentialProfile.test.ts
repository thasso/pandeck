import assert from "node:assert/strict";
import { afterAll, beforeEach, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate profile metadata and session persistence before loading server modules.
const tmp = mkdtempSync(join(tmpdir(), "pi-first-send-profile-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

vi.mock("./session/runtimePrompt.ts", () => ({
  subscribeHarnessOpened: () => () => {},
  promptRuntimeSession: async () => {},
}));

const { Connection } = await import("./connection.ts");
const { hub } = await import("./hub.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { createCredentialProfile, setCredentialProfileEnabled } =
  await import("./credentialProfiles.ts");
const { sessionStore } = await import("./db/sessionStore.ts");

const originalAcquireNew = piStore.acquireNew;
const originalBroadcastSessions = hub.broadcastSessions;

function makeConnection() {
  const sent: unknown[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(JSON.parse(payload)),
  };
  const conn = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs);
  // Keep the test focused on admission/binding rather than runtime viewing.
  conn.resolveWorktreeContext = async () => null;
  conn.guardDeveloperWorktree = () => true;
  conn.view = () => {};
  return {
    conn: conn as unknown as {
      handleFirstSend: (message: Record<string, unknown>) => Promise<void>;
    },
    sent,
  };
}

beforeEach(() => {
  (
    hub as unknown as { broadcastSessions: () => Promise<void> }
  ).broadcastSessions = async () => {};
});

test("pi first send validates and persists the selected OpenAI profile", async () => {
  const profile = createCredentialProfile({
    name: "Pi account",
    provider: "openai-codex",
  });
  let captured: unknown;
  (
    piStore as unknown as {
      acquireNew: (...args: unknown[]) => Promise<{ sessionId: string }>;
    }
  ).acquireNew = async (...args) => {
    captured = args[3];
    return { sessionId: "profile-pi-session" };
  };
  const { conn } = makeConnection();

  await conn.handleFirstSend({
    harness: "pi",
    id: "profile-pi-session",
    agentType: "assistant",
    text: "hello",
    credentialProfileId: profile.id,
  });

  assert.deepEqual(captured, {
    credentialProfileId: profile.id,
    // Session-start prompt conditions ride the creation call (Task 287).
    promptEvidence: { hasAttachments: false },
  });
  assert.equal(
    sessionStore.get("profile-pi-session")?.credentialProfileId,
    profile.id,
  );
});

test("pi first send freezes coding-session skills before its first prompt", async () => {
  const profile = createCredentialProfile({
    name: "Pi coding account",
    provider: "openai-codex",
  });
  (
    piStore as unknown as {
      acquireNew: (...args: unknown[]) => Promise<{ sessionId: string }>;
    }
  ).acquireNew = async () => ({ sessionId: "coding-pi-session" });
  const { conn } = makeConnection();

  await conn.handleFirstSend({
    harness: "pi",
    id: "coding-pi-session",
    agentType: "developer",
    text: "inspect this repository",
    credentialProfileId: profile.id,
  });

  assert.equal(sessionStore.getSkills("coding-pi-session"), "[]");
});

test("pi first send carries and persists its starting mode", async () => {
  const profile = createCredentialProfile({
    name: "Pi Plan account",
    provider: "openai-codex",
  });
  let captured: unknown;
  (
    piStore as unknown as {
      acquireNew: (...args: unknown[]) => Promise<{
        sessionId: string;
        sessionMode: "plan";
      }>;
    }
  ).acquireNew = async (...args) => {
    captured = args[3];
    return { sessionId: "plan-pi-session", sessionMode: "plan" };
  };
  const { conn } = makeConnection();

  await conn.handleFirstSend({
    harness: "pi",
    id: "plan-pi-session",
    agentType: "assistant",
    text: "inspect this repository",
    credentialProfileId: profile.id,
    mode: "plan",
  });

  assert.deepEqual(captured, {
    credentialProfileId: profile.id,
    promptEvidence: { hasAttachments: false },
    mode: "plan",
  });
  assert.equal(sessionStore.get("plan-pi-session")?.mode, "plan");
});

test("pi first send rejects a disabled profile before acquisition", async () => {
  const profile = createCredentialProfile({
    name: "Paused account",
    provider: "openai-codex",
  });
  setCredentialProfileEnabled(profile.id, false);
  let acquired = false;
  (
    piStore as unknown as {
      acquireNew: (...args: unknown[]) => Promise<{ sessionId: string }>;
    }
  ).acquireNew = async () => {
    acquired = true;
    return { sessionId: "unexpected" };
  };
  const { conn, sent } = makeConnection();

  await conn.handleFirstSend({
    harness: "pi",
    id: "disabled-profile",
    agentType: "assistant",
    text: "hello",
    credentialProfileId: profile.id,
  });

  assert.equal(acquired, false);
  assert.ok(
    sent.some(
      (message) =>
        (message as { type?: string; message?: string }).type === "error",
    ),
  );
});

test("pi first send rejects a profile from the wrong provider before acquisition", async () => {
  const profile = createCredentialProfile({
    name: "Claude account",
    provider: "claude",
  });
  let acquired = false;
  (
    piStore as unknown as {
      acquireNew: (...args: unknown[]) => Promise<{ sessionId: string }>;
    }
  ).acquireNew = async () => {
    acquired = true;
    return { sessionId: "unexpected" };
  };
  const { conn, sent } = makeConnection();

  await conn.handleFirstSend({
    harness: "pi",
    id: "wrong-profile",
    agentType: "assistant",
    text: "hello",
    credentialProfileId: profile.id,
  });

  assert.equal(acquired, false);
  assert.ok(
    sent.some(
      (message) =>
        (message as { type?: string; message?: string }).type === "error" &&
        /select an openai credential profile/i.test(
          (message as { message?: string }).message ?? "",
        ),
    ),
  );
});

afterAll(() => {
  (piStore as unknown as { acquireNew: typeof originalAcquireNew }).acquireNew =
    originalAcquireNew;
  (
    hub as unknown as { broadcastSessions: typeof originalBroadcastSessions }
  ).broadcastSessions = originalBroadcastSessions;
  rmSync(tmp, { recursive: true, force: true });
});
