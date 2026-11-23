/**
 * The inspector's Runtime section: `listSessionAccountMoveTargets` answers the
 * eligible accounts; `setPendingRuntime` and `clearPendingRuntime` change the
 * selection the next turn starts on and answer once, with a refusal as the
 * error. Neither moves the session nor touches its engine.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { ServerMessage } from "@assistant/shared";

const offers = vi.hoisted(
  () => new Map<string, { provider: string; id: string }>(),
);
vi.mock("./harnesses/models.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./harnesses/models.ts")>();
  return {
    ...original,
    // Claude accounts answer from the real port and its listing snapshots.
    modelsForAccount: async (account: { id: string; provider: string }) =>
      account.provider === "claude"
        ? original.modelsForAccount(account as never)
        : offers.has(account.id)
          ? [
              {
                ...offers.get(account.id),
                name: "Test model",
                reasoning: false,
              },
            ]
          : [],
    pickerModels: () => [
      ...original.pickerModels(),
      ...[...offers.values()].map((model) => ({
        ...model,
        name: "Test model",
        reasoning: false,
      })),
    ],
  };
});

const { Connection } = await import("./connection.ts");
const profiles = await import("./credentialProfiles.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { validateClientMessage } = await import("./validateClientMessage.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { FakeRuntimeDriver } = await import("./test/fakeRuntimeDriver.ts");
const { setAccountMoveHostForTests } = await import("./sessionAccountMove.ts");
const { setPendingRuntimeHostForTests } =
  await import("./sessionPendingRuntime.ts");
setPendingRuntimeHostForTests({
  stateChanged: async () => {},
  publishRows: async () => {},
  wake: () => {},
});
const { resetClaudeAccountModelsForTests } =
  await import("./harnesses/claudeAccountModels.ts");
const { getSettings, updateSettings } = await import("./settings.ts");

const sessions: string[] = [];
const accounts: string[] = [];
let sequence = 0;

function account(name: string, enterprise = false): string {
  const p = profiles.createCredentialProfile({
    name,
    provider: "openai-codex",
  });
  writeFileSync(
    join(profiles.piAgentDir(p.id), "auth.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "test-token",
        refresh: "test-refresh",
        expires: Date.now() + 86400_000,
      },
    }),
  );
  profiles.patchCredentialProfile(p.id, { enterprise });
  offers.set(p.id, { provider: "openai-codex", id: "gpt-5.5" });
  accounts.push(p.id);
  return p.id;
}

function session(from: string, scope: "user" | "internal" = "user") {
  const id = `account-move-message-${sequence++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    scope,
    credentialProfileId: from,
  });
  sessions.push(id);
  const driver = new FakeRuntimeDriver(id) as InstanceType<
    typeof FakeRuntimeDriver
  > & {
    modelSelection(): {
      model: { provider: string; id: string };
      thinkingLevel: "off";
    };
    switchAccount(profileId: string, admit: () => void): Promise<void>;
  };
  driver.modelSelection = () => ({
    model: offers.get(from)!,
    thinkingLevel: "off",
  });
  driver.switchAccount = async () => {
    throw new Error("setting a pending account never switches");
  };
  setAccountMoveHostForTests({ resident: async () => driver });
  return id;
}

function connect() {
  const sent: ServerMessage[] = [];
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  } as never);
  return { sent, connection };
}

const answers = <T extends ServerMessage["type"]>(
  sent: ServerMessage[],
  type: T,
) =>
  sent.filter((msg) => msg.type === type) as Extract<
    ServerMessage,
    { type: T }
  >[];

afterEach(async () => {
  setAccountMoveHostForTests(undefined);
  for (const id of sessions.splice(0)) {
    await sessionRuntime.disposeSession(id);
    sessionStore.remove(id);
  }
  for (const id of accounts.splice(0))
    profiles.setCredentialProfileEnabled(id, false);
});

test("lists the eligible accounts; picking one makes it pending, a reset drops it", async () => {
  const a = account("Picker A");
  const b = account("Picker B");
  const work = account("Picker Work", true);
  const off = account("Picker Off");
  profiles.setCredentialProfileEnabled(off, false);
  const id = session(a);
  const { sent, connection } = connect();
  try {
    await connection.handle({
      type: "listSessionAccountMoveTargets",
      sessionId: id,
      requestId: "list-1",
    });
    const [list] = answers(sent, "sessionAccountMoveTargets");
    assert.equal(list?.requestId, "list-1");
    assert.equal(list?.sessionId, id);
    const listed = list?.accounts ?? [];
    assert.deepEqual(
      listed.filter((target) => [a, b, work, off].includes(target.id)),
      [
        { id: b, name: "Picker B", enterprise: false },
        { id: work, name: "Picker Work", enterprise: true },
      ],
    );

    await connection.handle({
      type: "setPendingRuntime",
      sessionId: id,
      account: { kind: "account", id: work },
      requestId: "move-1",
    });
    assert.deepEqual(answers(sent, "pendingRuntimeAnswer"), [
      { type: "pendingRuntimeAnswer", requestId: "move-1", sessionId: id },
    ]);
    // Pending until the next turn starts: the binding is unchanged.
    assert.equal(sessionStore.get(id)?.credentialProfileId, a);
    assert.deepEqual(sessionStore.get(id)?.pendingRuntime, {
      model: { provider: "openai-codex", id: "gpt-5.5" },
      thinkingLevel: "off",
      account: { kind: "account", id: work },
      setBy: "user",
    });
    await connection.handle({
      type: "clearPendingRuntime",
      sessionId: id,
      requestId: "reset-1",
    });
    assert.deepEqual(answers(sent, "pendingRuntimeAnswer").at(-1), {
      type: "pendingRuntimeAnswer",
      requestId: "reset-1",
      sessionId: id,
    });
    assert.equal(sessionStore.get(id)?.pendingRuntime, undefined);
    assert.equal(answers(sent, "error").length, 0);
  } finally {
    connection.dispose();
  }
});

test("answers a refusal as the change's error, nothing pending", async () => {
  const a = account("Refuse A");
  const off = account("Refuse Off");
  profiles.setCredentialProfileEnabled(off, false);
  const id = session(a);
  const internal = session(a, "internal");
  const deleted = session(a);
  sessionStore.markDeleted(deleted);
  const { sent, connection } = connect();
  try {
    for (const [sessionId, target, error] of [
      [id, off, "Refuse Off is disabled."],
      [internal, off, "Only a user session can change its model or account."],
      [deleted, off, "Session does not exist or was deleted."],
    ] as const) {
      await connection.handle({
        type: "setPendingRuntime",
        sessionId,
        account: { kind: "account", id: target },
        requestId: `refuse-${sessionId}`,
      });
      assert.deepEqual(answers(sent, "pendingRuntimeAnswer").at(-1), {
        type: "pendingRuntimeAnswer",
        requestId: `refuse-${sessionId}`,
        sessionId,
        error,
      });
    }
    assert.equal(sessionStore.get(id)?.credentialProfileId, a);
    assert.equal(sessionStore.get(id)?.pendingRuntime, undefined);
    await connection.handle({
      type: "listSessionAccountMoveTargets",
      sessionId: internal,
      requestId: "list-internal",
    });
    assert.deepEqual(answers(sent, "sessionAccountMoveTargets").at(-1), {
      type: "sessionAccountMoveTargets",
      requestId: "list-internal",
      sessionId: internal,
      error: "Only a user session can move to another account.",
    });
    assert.equal(answers(sent, "error").length, 0);
  } finally {
    connection.dispose();
  }
});

test("a Claude account whose listing lacks the session's model is no target and is refused", async () => {
  const claudeAccount = (name: string): string => {
    const p = profiles.createCredentialProfile({ name, provider: "claude" });
    // A fake credential file: only its presence keeps the login healthy.
    mkdirSync(profiles.claudeConfigDir(p.id), { recursive: true });
    writeFileSync(
      join(profiles.claudeConfigDir(p.id), ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "fake-access",
          refreshToken: "fake-refresh",
          expiresAt: Date.now() + 86400_000,
        },
      }),
    );
    accounts.push(p.id);
    return p.id;
  };
  const before = getSettings().claudeSdk;
  updateSettings({ claudeSdk: { ...before, enabled: true } });
  const from = claudeAccount("Claude From");
  const team = claudeAccount("Claude Team");
  const lacking = claudeAccount("Claude Private");
  resetClaudeAccountModelsForTests({
    read: async (id) =>
      id === lacking
        ? ["claude-opus-5-5", "claude-sonnet-5-5"]
        : ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  });
  const id = `account-move-message-${sequence++}`;
  sessionStore.upsert({
    id,
    harness: "claude-sdk",
    agentType: "assistant",
    credentialProfileId: from,
  });
  sessions.push(id);
  const driver = new FakeRuntimeDriver(id) as InstanceType<
    typeof FakeRuntimeDriver
  > & {
    modelSelection(): {
      model: { provider: string; id: string };
      thinkingLevel: "high";
    };
    switchAccount(profileId: string, admit: () => void): Promise<void>;
  };
  driver.modelSelection = () => ({
    model: { provider: "claude-sdk", id: "haiku" },
    thinkingLevel: "high",
  });
  driver.switchAccount = async () => {
    throw new Error("setting a pending account never switches");
  };
  setAccountMoveHostForTests({ resident: async () => driver });
  const { sent, connection } = connect();
  try {
    await connection.handle({
      type: "listSessionAccountMoveTargets",
      sessionId: id,
      requestId: "claude-list",
    });
    const listed = answers(sent, "sessionAccountMoveTargets").at(-1)?.accounts;
    assert.ok(listed?.some((target) => target.id === team));
    assert.ok(!listed?.some((target) => target.id === lacking));

    await connection.handle({
      type: "setPendingRuntime",
      sessionId: id,
      account: { kind: "account", id: lacking },
      requestId: "claude-move",
    });
    assert.deepEqual(answers(sent, "pendingRuntimeAnswer").at(-1), {
      type: "pendingRuntimeAnswer",
      requestId: "claude-move",
      sessionId: id,
      error: "Claude Private does not offer Claude Haiku.",
    });
    assert.equal(sessionStore.get(id)?.credentialProfileId, from);
    assert.equal(sessionStore.get(id)?.pendingRuntime, undefined);
  } finally {
    connection.dispose();
    resetClaudeAccountModelsForTests();
    updateSettings({ claudeSdk: before });
  }
});

test("validates the messages before any effect", () => {
  for (const valid of [
    { type: "listSessionAccountMoveTargets", sessionId: "s", requestId: "r" },
    {
      type: "setPendingRuntime",
      sessionId: "s",
      requestId: "r",
      account: { kind: "account", id: "cp" },
    },
    {
      type: "setPendingRuntime",
      sessionId: "s",
      requestId: "r",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      thinkingLevel: "high",
      account: { kind: "automatic" },
    },
    { type: "clearPendingRuntime", sessionId: "s", requestId: "r" },
  ])
    assert.ok(validateClientMessage(valid).ok, JSON.stringify(valid));
  for (const invalid of [
    { type: "listSessionAccountMoveTargets", sessionId: "s" },
    { type: "listSessionAccountMoveTargets", sessionId: 1, requestId: "r" },
    { type: "setPendingRuntime", sessionId: "s", requestId: "r" },
    {
      type: "setPendingRuntime",
      sessionId: "s",
      requestId: "r",
      account: { kind: "account" },
    },
    {
      type: "setPendingRuntime",
      sessionId: "s",
      requestId: "r",
      account: { kind: "endpoint", id: "x" },
    },
    {
      type: "setPendingRuntime",
      sessionId: "s",
      requestId: "r",
      model: { provider: "openai-codex" },
    },
    {
      type: "setPendingRuntime",
      sessionId: "s",
      requestId: "r",
      thinkingLevel: "maximal",
    },
    { type: "clearPendingRuntime", sessionId: "s" },
    {
      type: "moveSessionAccount",
      sessionId: "s",
      credentialProfileId: "cp",
      requestId: "r",
    },
  ])
    assert.equal(
      validateClientMessage(invalid).ok,
      false,
      JSON.stringify(invalid),
    );
});
