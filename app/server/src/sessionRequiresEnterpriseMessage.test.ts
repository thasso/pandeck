import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { ServerMessage } from "@assistant/shared";
const { Connection } = await import("./connection.ts");
const { hub } = await import("./hub.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { validateClientMessage } = await import("./validateClientMessage.ts");
const { sessionRowIn, sessionTopicViewer } =
  await import("./test/sessionListClient.ts");

const idle = { isRunning: () => false };

test("inspector command makes a session enterprise-only and refuses deleted and internal sessions", async () => {
  const id = "requires-enterprise-command";
  const internal = "requires-enterprise-internal";
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    messageCount: 2,
  });
  sessionStore.upsert({
    id: internal,
    harness: "pi",
    agentType: "assistant",
    scope: "internal",
  });
  const sent: ServerMessage[] = [];
  const other: ServerMessage[] = [];
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  } as never);
  const viewer = sessionTopicViewer(other);
  hub.register(viewer);
  try {
    await connection.handle({
      type: "setSessionRequiresEnterprise",
      sessionId: id,
    });
    assert.equal(sessionStore.get(id)?.requiresEnterprise, true);
    assert.equal(sessionRowIn(other, id)?.requiresEnterprise, true);
    // Repeating it is harmless.
    await connection.handle({
      type: "setSessionRequiresEnterprise",
      sessionId: id,
    });
    assert.equal(sent.filter((msg) => msg.type === "error").length, 0);

    await connection.handle({
      type: "setSessionRequiresEnterprise",
      sessionId: internal,
    });
    assert.equal(sessionStore.get(internal)?.requiresEnterprise, undefined);
    assert.ok(
      sent.some(
        (msg) =>
          msg.type === "error" && /Only a user session/.test(msg.message),
      ),
    );

    const deleted = "requires-enterprise-deleted";
    sessionStore.upsert({ id: deleted, harness: "pi", agentType: "assistant" });
    sessionStore.markDeleted(deleted);
    await connection.handle({
      type: "setSessionRequiresEnterprise",
      sessionId: deleted,
    });
    assert.ok(
      sent.some(
        (msg) =>
          msg.type === "error" &&
          /deleted/.test(msg.message) &&
          msg.target?.type === "session" &&
          msg.target.id === deleted,
      ),
    );
    sessionStore.remove(deleted);
  } finally {
    hub.unregister(viewer as never);
    connection.dispose();
    sessionStore.remove(id);
    sessionStore.remove(internal);
  }
});

test("inspector command refuses a running session and leaves it unmarked until its turn ends", async () => {
  const { FakeRuntimeDriver } = await import("./test/fakeRuntimeDriver.ts");
  const { promptRuntimeSession } = await import("./session/runtimePrompt.ts");
  const { sessionRuntime } = await import("./session/runtimeInstance.ts");
  const id = "requires-enterprise-running";
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    messageCount: 2,
  });
  const driver = new FakeRuntimeDriver(id);
  const release = driver.holdTurns();
  const sent: ServerMessage[] = [];
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  } as never);
  try {
    const turn = promptRuntimeSession(driver, "long turn");
    await vi.waitFor(() => assert.equal(sessionRuntime.isRunning(id), true));
    await connection.handle({
      type: "setSessionRequiresEnterprise",
      sessionId: id,
    });
    assert.equal(sessionStore.get(id)?.requiresEnterprise, undefined);
    assert.ok(
      sent.some(
        (msg) =>
          msg.type === "error" &&
          msg.message ===
            `Session ${id} is running; require an enterprise account once its turn ends.` &&
          msg.target?.type === "session" &&
          msg.target.id === id,
      ),
    );

    release();
    await turn;
    assert.equal(sessionRuntime.isRunning(id), false);
    await connection.handle({
      type: "setSessionRequiresEnterprise",
      sessionId: id,
    });
    assert.equal(sessionStore.get(id)?.requiresEnterprise, true);
  } finally {
    release();
    connection.dispose();
    await sessionRuntime.disposeSession(id);
    sessionStore.remove(id);
  }
});

test("a session bound to a personal endpoint account is refused, since it could never move", async () => {
  const { createCredentialProfile, patchCredentialProfile } =
    await import("./credentialProfiles.ts");
  const { requireSessionEnterprise } = await import("./sessionAccount.ts");
  const { assertSessionEnterpriseAccount } =
    await import("./session/runtimePrompt.ts");
  const personal = createCredentialProfile({
    name: "Personal endpoint",
    provider: "openai-compatible",
  });
  const enterprise = createCredentialProfile({
    name: "Enterprise endpoint",
    provider: "openai-compatible",
  });
  patchCredentialProfile(enterprise.id, { enterprise: true });
  const login = createCredentialProfile({
    name: "Personal login",
    provider: "claude",
  });
  const onPersonal = "requires-enterprise-personal-endpoint";
  const onEnterprise = "requires-enterprise-enterprise-endpoint";
  const onLogin = "requires-enterprise-personal-login";
  for (const [id, profile] of [
    [onPersonal, personal],
    [onEnterprise, enterprise],
    [onLogin, login],
  ] as const)
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "assistant",
      credentialProfileId: profile.id,
    });
  const sent: ServerMessage[] = [];
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  } as never);
  try {
    await connection.handle({
      type: "setSessionRequiresEnterprise",
      sessionId: onPersonal,
    });
    assert.equal(sessionStore.get(onPersonal)?.requiresEnterprise, undefined);
    assert.ok(
      sent.some(
        (msg) =>
          msg.type === "error" &&
          /Personal endpoint is the only account that serves this session's model/.test(
            msg.message,
          ),
      ),
    );
    // Its turns keep running as before.
    assertSessionEnterpriseAccount({
      sessionId: onPersonal,
      credentialProfileId: personal.id,
    });

    // An endpoint already enterprise, or a subscription login, may be marked.
    assert.equal(requireSessionEnterprise(onEnterprise, idle), false);
    assertSessionEnterpriseAccount({
      sessionId: onEnterprise,
      credentialProfileId: enterprise.id,
    });
    assert.equal(requireSessionEnterprise(onLogin, idle), false);
    assert.throws(
      () =>
        assertSessionEnterpriseAccount({
          sessionId: onLogin,
          credentialProfileId: login.id,
        }),
      /its bound account Personal login is not marked as enterprise\.$/,
    );
    assert.throws(
      () =>
        assertSessionEnterpriseAccount({
          sessionId: onLogin,
          credentialProfileId: "cp_missing",
        }),
      /its bound account is missing\.$/,
    );
  } finally {
    connection.dispose();
    for (const id of [onPersonal, onEnterprise, onLogin])
      sessionStore.remove(id);
  }
});

test("wire validation accepts only a session id", () => {
  assert.equal(
    validateClientMessage({
      type: "setSessionRequiresEnterprise",
      sessionId: "id",
    }).ok,
    true,
  );
  for (const bad of [
    { type: "setSessionRequiresEnterprise" },
    { type: "setSessionRequiresEnterprise", sessionId: 3 },
  ])
    assert.equal(validateClientMessage(bad).ok, false, JSON.stringify(bad));
});
