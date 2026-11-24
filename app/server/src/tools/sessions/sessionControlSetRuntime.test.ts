/**
 * `session_control` `set_runtime`: an owning coordinator sets its child's
 * pending account, model or effort, the same selection the session inspector
 * sets, applied when the child's next turn starts. A model the child's agent
 * definition does not list asks the user first. It loses that authority the
 * moment the user takes the child over.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";

const offers = vi.hoisted(
  () => new Map<string, { provider: string; id: string }>(),
);
/** What every test account offers, and the picker lists. */
const catalog = vi.hoisted(() => [
  { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5", reasoning: true },
  {
    provider: "openai-codex",
    id: "gpt-5.6-sol",
    name: "GPT Sol",
    reasoning: true,
  },
  {
    provider: "openai-codex",
    id: "gpt-5.4-mini",
    name: "GPT Mini",
    reasoning: true,
  },
]);
vi.mock("../../harnesses/models.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../harnesses/models.ts")>()),
  modelsForAccount: async ({ id }: { id: string }) =>
    offers.has(id) ? catalog : [],
  pickerModels: () => catalog,
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
const {
  approvalsForSession,
  resolveApproval,
  setApprovalBroadcastForTests,
  setAutoApprovalDrainForTests,
} = await import("../../pendingApprovals.ts");
const { freezeSessionAgent } = await import("../../agents/sessionAgent.ts");
setApprovalBroadcastForTests(
  () => {},
  () => {},
);
setAutoApprovalDrainForTests(async () => {});

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
      operation: "set_runtime",
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

describe("session_control set_runtime: account", () => {
  it("sets an owned child's pending account by name or id, and says so", async () => {
    const a = account("Move A");
    const b = account("Move B");
    const caller = seed("Coordinator");
    const c = child(caller, a);
    assert.equal(
      text(await move(caller, c.id, "move b")),
      `${c.id} switches to GPT-5.5, off effort · Move B when its next turn starts.`,
    );
    assert.equal(boundTo(c.id), a, "nothing moves before the next turn");
    assert.equal(pendingTo(c.id), b);
    assert.equal(sessionStore.get(c.id)?.pendingRuntime?.setBy, "coordinator");
    assert.equal(
      text(await move(caller, c.id, a)),
      `${c.id} keeps what it runs on now; nothing is pending.`,
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
      [taken, /no longer owned.*cannot be switched here/],
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
      /switches to GPT-5.5, off effort · Owner B when its next turn starts\.$/,
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
      /account must be an account name or id/,
    );
    assert.equal(pendingTo(c.id), twin2);
    assert.equal(boundTo(c.id), a);
  });
  it("loses the move the moment the user takes the child over, even while the account resolves", async () => {
    const a = account("Takeover A");
    const b = account("Takeover B");
    const caller = seed("Coordinator");
    // Each resident read is one await the move passes: the first while the
    // tool resolves the account, the last while the selection is computed,
    // right before its write.
    for (const takeoverAt of [1, 2]) {
      const c = child(caller, a);
      let reads = 0;
      setAccountMoveHostForTests({
        resident: async () => {
          if (++reads === takeoverAt)
            sessionStore.setSpawnedOwnership(c.id, "taken-over");
          return c.driver;
        },
      });
      await assert.rejects(
        () => move(caller, c.id, b),
        /no longer owned.*cannot be switched here/,
      );
      assert.ok(reads >= takeoverAt, "the takeover landed during the move");
      assert.equal(
        pendingTo(c.id),
        undefined,
        `takeover at read ${takeoverAt}`,
      );
      assert.equal(boundTo(c.id), a);
    }
  });
});

describe("session_control set_runtime: model", () => {
  const setModel = (caller: string, target: string, model: string) =>
    tool().execute(
      { operation: "set_runtime", targetSessionId: target, model },
      context(caller),
    );
  const pendingModel = (id: string) =>
    sessionStore.get(id)?.pendingRuntime?.model.id;
  /** Freeze `id` as an agent that lists `listed`, or (null) a pre-list row. */
  const asAgent = (id: string, listed: string[] | null) =>
    freezeSessionAgent(id, {
      name: "reviewer",
      blob: "blob",
      persona: "assistant",
      provider: "openai-codex",
      model: "gpt-5.5",
      effort: "off",
      runtimeSource: "definition",
      ...(listed
        ? {
            listedModels: listed.map((id) => ({
              provider: "openai-codex",
              id,
            })),
          }
        : {}),
      denyTools: [],
      skills: [],
      body: "Review.",
    });
  const cards = (caller: string) =>
    approvalsForSession(caller).filter(
      (card) =>
        card.body.kind === "sessionRuntime" && card.status === "pending",
    );

  it("sets a model the child's definition lists without asking, as its coordinator's choice", async () => {
    const a = account("Listed A");
    const caller = seed("Coordinator");
    const c = child(caller, a);
    asAgent(c.id, ["gpt-5.5", "gpt-5.6-sol"]);
    const result = await setModel(caller, c.id, "sol");
    assert.equal(result.terminate, undefined);
    assert.equal(
      text(result),
      `${c.id} switches to GPT Sol, off effort when its next turn starts.`,
    );
    assert.equal(pendingModel(c.id), "gpt-5.6-sol");
    assert.equal(sessionStore.get(c.id)?.pendingRuntime?.setBy, "coordinator");
    assert.equal(cards(caller).length, 0);
  });

  it("asks the user for a model the definition does not list, and for any model of a child without one", async () => {
    const a = account("Unlisted A");
    const caller = seed("Coordinator");
    const listed = child(caller, a);
    asAgent(listed.id, ["gpt-5.5", "gpt-5.6-sol"]);
    const legacy = child(caller, a);
    // Frozen before definitions recorded their list: only its own model.
    asAgent(legacy.id, null);
    const plain = child(caller, a);
    for (const [target, model] of [
      [listed.id, "gpt-5.4-mini"],
      [legacy.id, "gpt-5.6-sol"],
      [plain.id, "gpt-5.6-sol"],
    ] as const) {
      const result = await setModel(caller, target, model);
      assert.equal(result.terminate, true, target);
      assert.match(text(result), /Nothing changed yet/);
      assert.equal(
        pendingModel(target),
        undefined,
        "nothing set before the card",
      );
    }
    const pending = cards(caller);
    assert.deepEqual(
      pending.map(
        (card) =>
          card.body.kind === "sessionRuntime" && card.body.targetSessionId,
      ),
      [listed.id, legacy.id, plain.id],
    );
    // The model it runs already is no change, so it never asks, and writes
    // nothing a reset could turn into an unapproved change.
    assert.equal(
      text(await setModel(caller, plain.id, "gpt-5.5")),
      `${plain.id} keeps what it runs on now; nothing is pending.`,
    );
    assert.equal(sessionStore.get(plain.id)?.pendingRuntime, undefined);
    assert.equal(cards(caller).length, 3);

    await resolveApproval(pending[0]!.id, "approved");
    assert.equal(pendingModel(listed.id), "gpt-5.4-mini");
    assert.equal(
      sessionStore.get(listed.id)?.pendingRuntime?.setBy,
      "coordinator",
    );
  });

  it("asks for an effort change only of a child without a definition; an account alone never asks", async () => {
    const a = account("Effort A");
    const b = account("Effort B");
    const caller = seed("Coordinator");
    const listed = child(caller, a);
    asAgent(listed.id, ["gpt-5.5"]);
    const plain = child(caller, a);
    const setEffort = (target: string) =>
      tool().execute(
        { operation: "set_runtime", targetSessionId: target, effort: "high" },
        context(caller),
      );

    // A definition vouches for any effort of its own.
    assert.equal((await setEffort(listed.id)).terminate, undefined);
    assert.equal(
      sessionStore.get(listed.id)?.pendingRuntime?.thinkingLevel,
      "high",
    );

    // A child without one has nothing to vouch for it.
    const asked = await setEffort(plain.id);
    assert.equal(asked.terminate, true);
    assert.match(text(asked), /Nothing changed yet/);
    assert.equal(sessionStore.get(plain.id)?.pendingRuntime, undefined);
    const [card] = cards(caller);
    assert.equal(card?.title, "Change a child's effort");

    // The account rule predates model switching: no card for any owned child.
    const moved = await tool().execute(
      {
        operation: "set_runtime",
        targetSessionId: plain.id,
        account: "Effort B",
      },
      context(caller),
    );
    assert.equal(moved.terminate, undefined);
    assert.deepEqual(sessionStore.get(plain.id)?.pendingRuntime?.account, {
      kind: "account",
      id: b,
    });

    await resolveApproval(card!.id, "approved");
    const pending = sessionStore.get(plain.id)?.pendingRuntime;
    assert.equal(pending?.thinkingLevel, "high");
    assert.equal(pending?.model.id, "gpt-5.5", "the model stays");
    assert.equal(pending?.setBy, "coordinator");
  });

  it.each(["model", "effort"] as const)(
    "measures a %s against the next turn's pending target, not what the child runs now",
    async (field) => {
      const a = account(`Next turn ${field}`);
      const caller = seed("Coordinator");
      const plain = child(caller, a);
      const listed = child(caller, a);
      asAgent(listed.id, ["gpt-5.5", "gpt-5.6-sol"]);
      // Both run GPT-5.5 at off effort, with GPT Sol at high pending.
      for (const target of [plain.id, listed.id])
        sessionStore.setPendingRuntime(target, {
          model: { provider: "openai-codex", id: "gpt-5.6-sol" },
          thinkingLevel: "high",
          account: { kind: "automatic" },
          setBy: "user",
        });
      const request = (target: string, value: string) =>
        tool().execute(
          {
            operation: "set_runtime",
            targetSessionId: target,
            ...(field === "model" ? { model: value } : { effort: value }),
          },
          context(caller),
        );
      const pendingField = (id: string) => {
        const pending = sessionStore.get(id)?.pendingRuntime;
        return field === "model" ? pending?.model.id : pending?.thinkingLevel;
      };
      const [current, pendingValue] =
        field === "model" ? ["gpt-5.5", "gpt-5.6-sol"] : ["off", "high"];

      // What the next turn runs already is no change: nothing asked, kept.
      const same = await request(plain.id, pendingValue);
      assert.equal(same.terminate, undefined);
      assert.equal(pendingField(plain.id), pendingValue);
      assert.equal(cards(caller).length, 0);

      // What it runs now differs from the next turn: a real change, which a
      // child without a definition asks the user for.
      const asked = await request(plain.id, current);
      assert.equal(asked.terminate, true);
      assert.match(text(asked), /Nothing changed yet/);
      assert.equal(pendingField(plain.id), pendingValue, "nothing set yet");
      const [card] = cards(caller);
      assert.ok(card);
      await resolveApproval(card.id, "approved");
      assert.equal(pendingField(plain.id), current);
      assert.equal(
        sessionStore.get(plain.id)?.pendingRuntime?.setBy,
        "coordinator",
      );

      // A definition vouches for it: set without asking.
      const vouched = await request(listed.id, current);
      assert.equal(vouched.terminate, undefined);
      assert.equal(pendingField(listed.id), current);
      assert.equal(cards(caller).length, 0);
    },
  );

  it("fails an approved card when the user took the child over meanwhile", async () => {
    const a = account("Card takeover A");
    const caller = seed("Coordinator");
    const c = child(caller, a);
    await setModel(caller, c.id, "gpt-5.6-sol");
    const [card] = cards(caller);
    sessionStore.setSpawnedOwnership(c.id, "taken-over");
    const { card: resolved } = await resolveApproval(card!.id, "approved");
    assert.equal(resolved.status, "failed");
    assert.match(
      resolved.error ?? "",
      /no longer owned.*cannot be switched here/,
    );
    assert.equal(pendingModel(c.id), undefined);
  });
});
