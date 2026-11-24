/**
 * The inspector's account picker: `listSessionAccountMoveTargets` answers the
 * eligible accounts, `moveSessionAccount` moves the idle session and answers
 * once, with the refusal as its error.
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
  };
});

const { Connection } = await import("./connection.ts");
const profiles = await import("./credentialProfiles.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { validateClientMessage } = await import("./validateClientMessage.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { FakeRuntimeDriver } = await import("./test/fakeRuntimeDriver.ts");
const { setAccountMoveHostForTests } = await import("./sessionAccountMove.ts");
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
  let bound = from;
  driver.modelSelection = () => ({
    model: offers.get(from)!,
    thinkingLevel: "off",
  });
  driver.switchAccount = async (next, admit) => {
    admit();
    sessionStore.switchCredentialProfile(id, bound, next);
    bound = next;
  };
  setAccountMoveHostForTests({
    runtime: sessionRuntime,
    resident: async () => driver,
    acquire: async () => driver,
    publishRows: async () => {},
  });
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

test("lists the eligible accounts and moves the session to the one picked", async () => {
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
      type: "moveSessionAccount",
      sessionId: id,
      credentialProfileId: work,
      requestId: "move-1",
    });
    assert.deepEqual(answers(sent, "sessionAccountMoveAnswer"), [
      { type: "sessionAccountMoveAnswer", requestId: "move-1", sessionId: id },
    ]);
    assert.equal(sessionStore.get(id)?.credentialProfileId, work);
    assert.equal(answers(sent, "error").length, 0);
  } finally {
    connection.dispose();
  }
});

test("answers a refusal as the move's error, binding unchanged", async () => {
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
      [internal, off, "Only a user session can move to another account."],
      [deleted, off, "Session does not exist or was deleted."],
    ] as const) {
      await connection.handle({
        type: "moveSessionAccount",
        sessionId,
        credentialProfileId: target,
        requestId: `refuse-${sessionId}`,
      });
      assert.deepEqual(answers(sent, "sessionAccountMoveAnswer").at(-1), {
        type: "sessionAccountMoveAnswer",
        requestId: `refuse-${sessionId}`,
        sessionId,
        error,
      });
    }
    assert.equal(sessionStore.get(id)?.credentialProfileId, a);
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

function claudeAccount(name: string): string {
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
}

test("a Claude account whose listing lacks the session's model is no target and refuses the move", async () => {
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
  driver.switchAccount = async (next, admit) => {
    admit();
    sessionStore.switchCredentialProfile(id, from, next);
  };
  setAccountMoveHostForTests({
    runtime: sessionRuntime,
    resident: async () => driver,
    acquire: async () => driver,
    publishRows: async () => {},
  });
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
      type: "moveSessionAccount",
      sessionId: id,
      credentialProfileId: lacking,
      requestId: "claude-move",
    });
    assert.deepEqual(answers(sent, "sessionAccountMoveAnswer").at(-1), {
      type: "sessionAccountMoveAnswer",
      requestId: "claude-move",
      sessionId: id,
      error: "Claude Private can't run Claude Haiku.",
    });
    assert.equal(sessionStore.get(id)?.credentialProfileId, from);
  } finally {
    connection.dispose();
    resetClaudeAccountModelsForTests();
    updateSettings({ claudeSdk: before });
  }
});

/** PRIVATE minus `claude-fable-5-2`: the evidence file's Y listing. */
const Y_LISTING = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
];

test.each([
  {
    pinned: true,
    error:
      "Claude Y can't run claude-fable-5-2, the version this session is pinned to.",
  },
  { pinned: false, error: undefined },
])(
  "a 5-2-pinned fable session is refused a move to an account without 5-2 (pinned: $pinned)",
  async ({ pinned, error }) => {
    const before = getSettings().claudeSdk;
    updateSettings({ claudeSdk: { ...before, enabled: true } });
    const from = claudeAccount("Claude From");
    const y = claudeAccount("Claude Y");
    resetClaudeAccountModelsForTests({
      read: async (id) =>
        id === y ? Y_LISTING : [...Y_LISTING, "claude-fable-5-2"],
    });
    const id = `account-move-message-${sequence++}`;
    sessionStore.upsert({
      id,
      harness: "claude-sdk",
      agentType: "assistant",
      credentialProfileId: from,
    });
    sessions.push(id);
    if (pinned)
      sessionStore.freezeAgent(
        id,
        JSON.stringify({
          name: "pinned-fable",
          blob: "0".repeat(40),
          persona: "assistant",
          provider: "claude-sdk",
          model: "fable",
          pinnedModel: "claude-fable-5-2",
          effort: "high",
          runtimeSource: "definition",
          denyTools: [],
          skills: [],
          body: "",
        }),
      );
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
      model: { provider: "claude-sdk", id: "fable" },
      thinkingLevel: "high",
    });
    driver.switchAccount = async (next, admit) => {
      admit();
      sessionStore.switchCredentialProfile(id, from, next);
    };
    setAccountMoveHostForTests({
      runtime: sessionRuntime,
      resident: async () => driver,
      acquire: async () => driver,
      publishRows: async () => {},
    });
    const { sent, connection } = connect();
    try {
      await connection.handle({
        type: "moveSessionAccount",
        sessionId: id,
        credentialProfileId: y,
        requestId: "pin-move",
      });
      assert.deepEqual(answers(sent, "sessionAccountMoveAnswer").at(-1), {
        type: "sessionAccountMoveAnswer",
        requestId: "pin-move",
        sessionId: id,
        ...(error ? { error } : {}),
      });
      assert.equal(sessionStore.get(id)?.credentialProfileId, error ? from : y);
    } finally {
      connection.dispose();
      resetClaudeAccountModelsForTests();
      updateSettings({ claudeSdk: before });
    }
  },
);

test("an opus session pinned to claude-opus-5 lists and moves to an account offering that exact version", async () => {
  const before = getSettings().claudeSdk;
  updateSettings({ claudeSdk: { ...before, enabled: true } });
  const from = claudeAccount("Claude From");
  const legacy = claudeAccount("Claude Legacy");
  resetClaudeAccountModelsForTests({
    read: async (id) =>
      id === legacy
        ? ["claude-opus-5", "claude-sonnet-5-5"]
        : ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"],
  });
  const id = `account-move-message-${sequence++}`;
  sessionStore.upsert({
    id,
    harness: "claude-sdk",
    agentType: "assistant",
    credentialProfileId: from,
  });
  sessions.push(id);
  sessionStore.freezeAgent(
    id,
    JSON.stringify({
      name: "pinned-opus",
      blob: "0".repeat(40),
      persona: "assistant",
      provider: "claude-sdk",
      model: "opus",
      pinnedModel: "claude-opus-5",
      effort: "high",
      runtimeSource: "definition",
      denyTools: [],
      skills: [],
      body: "",
    }),
  );
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
    model: { provider: "claude-sdk", id: "opus" },
    thinkingLevel: "high",
  });
  driver.switchAccount = async (next, admit) => {
    admit();
    sessionStore.switchCredentialProfile(id, from, next);
  };
  setAccountMoveHostForTests({
    runtime: sessionRuntime,
    resident: async () => driver,
    acquire: async () => driver,
    publishRows: async () => {},
  });
  const { sent, connection } = connect();
  try {
    await connection.handle({
      type: "listSessionAccountMoveTargets",
      sessionId: id,
      requestId: "legacy-list",
    });
    const listed = answers(sent, "sessionAccountMoveTargets").at(-1)?.accounts;
    assert.ok(listed?.some((target) => target.id === legacy));

    await connection.handle({
      type: "moveSessionAccount",
      sessionId: id,
      credentialProfileId: legacy,
      requestId: "legacy-move",
    });
    assert.deepEqual(answers(sent, "sessionAccountMoveAnswer").at(-1), {
      type: "sessionAccountMoveAnswer",
      requestId: "legacy-move",
      sessionId: id,
    });
    assert.equal(sessionStore.get(id)?.credentialProfileId, legacy);
  } finally {
    connection.dispose();
    resetClaudeAccountModelsForTests();
    updateSettings({ claudeSdk: before });
  }
});

test("validates both messages before any effect", () => {
  assert.ok(
    validateClientMessage({
      type: "listSessionAccountMoveTargets",
      sessionId: "s",
      requestId: "r",
    }).ok,
  );
  assert.ok(
    validateClientMessage({
      type: "moveSessionAccount",
      sessionId: "s",
      credentialProfileId: "cp",
      requestId: "r",
    }).ok,
  );
  for (const invalid of [
    { type: "listSessionAccountMoveTargets", sessionId: "s" },
    { type: "listSessionAccountMoveTargets", sessionId: 1, requestId: "r" },
    { type: "moveSessionAccount", sessionId: "s", requestId: "r" },
    {
      type: "moveSessionAccount",
      sessionId: "s",
      credentialProfileId: 2,
      requestId: "r",
    },
  ])
    assert.equal(
      validateClientMessage(invalid).ok,
      false,
      JSON.stringify(invalid),
    );
});
