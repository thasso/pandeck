/**
 * `session_control` `move_account`: an owning coordinator sets its child's
 * pending account, the same selection the session inspector sets, applied
 * when the child's next turn starts; it loses that authority the moment the
 * user takes the child over.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";

const offers = vi.hoisted(
  () => new Map<string, { provider: string; id: string }>(),
);
vi.mock("../../harnesses/models.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../harnesses/models.ts")>()),
  modelsForAccount: async ({ id }: { id: string }) =>
    offers.has(id)
      ? [{ ...offers.get(id), name: "Test model", reasoning: false }]
      : [],
}));

const profiles = await import("../../credentialProfiles.ts");
const { sessionStore } = await import("../../db/sessionStore.ts");
const { sessionRuntime } = await import("../../session/runtimeInstance.ts");
const { FakeRuntimeDriver } = await import("../../test/fakeRuntimeDriver.ts");
const { setAccountMoveHostForTests } =
  await import("../../sessionAccountMove.ts");
const { setPendingRuntimeHostForTests } =
  await import("../../sessionPendingRuntime.ts");
setPendingRuntimeHostForTests({
  stateChanged: async () => {},
  publishRows: async () => {},
  wake: () => {},
});
const { sessionControlTools, setSessionControlRuntimeForTests } =
  await import("./sessionControlTool.ts");

let sequence = 0;
const sessions: string[] = [];
const accounts: string[] = [];

function account(name: string): string {
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
  offers.set(p.id, { provider: "openai-codex", id: "gpt-5.5" });
  accounts.push(p.id);
  return p.id;
}

function seed(title: string, credentialProfileId?: string): string {
  const id = `move-account-${sequence++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title,
    ...(credentialProfileId ? { credentialProfileId } : {}),
  });
  sessions.push(id);
  return id;
}

/** A loaded child; setting its pending account never switches its engine. */
function child(coordinator: string, from: string) {
  const id = seed("Child", from);
  sessionStore.linkSpawned(coordinator, id);
  const driver = new FakeRuntimeDriver(id) as InstanceType<
    typeof FakeRuntimeDriver
  > & {
    modelSelection(): {
      model: { provider: string; id: string };
      thinkingLevel: "off";
    };
    switchAccount(): Promise<void>;
  };
  driver.modelSelection = () => ({
    model: offers.get(from)!,
    thinkingLevel: "off",
  });
  driver.switchAccount = async () => {
    throw new Error("a pending account never switches when it is set");
  };
  setAccountMoveHostForTests({ resident: async () => driver });
  return { id, driver };
}

const tool = () => sessionControlTools()[0]!;
const context = (sessionId: string) => ({
  toolCallId: "tool-call",
  session: {
    sessionId,
    harness: "pi" as const,
    agentType: "assistant" as const,
    title: "Coordinator",
  },
});
const move = (caller: string, target: string, accountName: unknown) =>
  tool().execute(
    {
      operation: "move_account",
      targetSessionId: target,
      account: accountName,
    },
    context(caller),
  );
const text = (result: Awaited<ReturnType<typeof move>>) =>
  (result.content[0] as { type: "text"; text: string }).text;
const boundTo = (id: string) => sessionStore.get(id)?.credentialProfileId;
const pendingTo = (id: string) => {
  const account = sessionStore.get(id)?.pendingRuntime?.account;
  return account?.kind === "account" ? account.id : account?.kind;
};

afterEach(async () => {
  setSessionControlRuntimeForTests(undefined);
  setAccountMoveHostForTests(undefined);
  for (const id of sessions.splice(0)) {
    await sessionRuntime.disposeSession(id);
    sessionStore.remove(id);
  }
  for (const id of accounts.splice(0))
    profiles.setCredentialProfileEnabled(id, false);
});

describe("session_control move_account", () => {
  it("sets an owned child's pending account by name or id, and says so", async () => {
    const a = account("Move A");
    const b = account("Move B");
    const caller = seed("Coordinator");
    const c = child(caller, a);
    assert.equal(
      text(await move(caller, c.id, "move b")),
      `${c.id} moves to Move B when its next turn starts.`,
    );
    assert.equal(boundTo(c.id), a, "nothing moves before the next turn");
    assert.equal(pendingTo(c.id), b);
    assert.equal(sessionStore.get(c.id)?.pendingRuntime?.setBy, "coordinator");
    assert.equal(
      text(await move(caller, c.id, a)),
      `${c.id} stays on Move A; no account move is pending.`,
    );
    assert.equal(boundTo(c.id), a);
    assert.equal(sessionStore.get(c.id)?.pendingRuntime, undefined);
  });

  it("refuses a session it does not own or the caller itself; a running child takes it for its next turn", async () => {
    const a = account("Owner A");
    account("Owner B");
    const caller = seed("Coordinator");
    const other = seed("Other parent");
    const unrelated = seed("Unrelated", a);
    sessionStore.linkSpawned(other, unrelated);
    const taken = seed("Taken over", a);
    sessionStore.linkSpawned(caller, taken, 123, "taken-over");
    const grandparent = seed("Child of caller", a);
    sessionStore.linkSpawned(caller, grandparent);
    const grandchild = seed("Grandchild", a);
    sessionStore.linkSpawned(grandparent, grandchild);
    for (const [target, error] of [
      [caller, /current session/],
      [unrelated, /not spawned by the current session/],
      [grandchild, /not spawned by the current session/],
      [taken, /no longer owned.*cannot be moved here/],
    ] as const) {
      await assert.rejects(() => move(caller, target, "Owner B"), error);
      assert.equal(boundTo(target), target === caller ? undefined : a);
    }
    const running = child(caller, a);
    setSessionControlRuntimeForTests({
      isRunning: (id) => id === running.id,
      abort: () => assert.fail("no abort"),
    });
    assert.match(
      text(await move(caller, running.id, "Owner B")),
      /moves to Owner B when its next turn starts\.$/,
    );
    assert.equal(boundTo(running.id), a);
  });

  it("names the eligible accounts for an unknown name, and refuses an ambiguous one", async () => {
    const a = account("Named A");
    account("Named B");
    const disabled = account("Named Off");
    profiles.setCredentialProfileEnabled(disabled, false);
    const caller = seed("Coordinator");
    const c = child(caller, a);
    await assert.rejects(
      () => move(caller, c.id, "Nobody"),
      (error: Error) => {
        assert.match(error.message, /^No account is named "Nobody"\./);
        assert.match(error.message, /Eligible accounts: .*Named B/);
        assert.doesNotMatch(error.message, /Named Off|Named A,/);
        return true;
      },
    );
    await assert.rejects(() => move(caller, c.id, "Named Off"), {
      message: /^Named Off is disabled\. Eligible accounts: .*Named B/,
    });
    const twin = account("Twin");
    const twin2 = account("twin");
    await assert.rejects(() => move(caller, c.id, "TWIN"), {
      message: new RegExp(
        `^More than one account is named "TWIN" \\(${twin}, ${twin2}\\); name it by id\\.$`,
      ),
    });
    await move(caller, c.id, twin2);
    assert.equal(pendingTo(c.id), twin2);
    await assert.rejects(
      () => move(caller, c.id, " "),
      /requires an account name or id/,
    );
    assert.equal(pendingTo(c.id), twin2);
    assert.equal(boundTo(c.id), a);
  });
});
