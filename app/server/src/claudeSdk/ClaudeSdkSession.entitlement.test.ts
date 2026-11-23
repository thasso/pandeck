/**
 * A Claude session runs the concrete id its CURRENT account resolves for its
 * alias (`docs/agent-harnesses.md`, models port): at every query open, the
 * standalone compact open and a model change, with the agent's pin and the
 * stored pin. A refusal at the open is a local-policy backstop.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import { freezeSessionAgent } from "../agents/sessionAgent.ts";
import {
  createCredentialProfile,
  deleteCredentialProfile,
} from "../credentialProfiles.ts";
import { resetClaudeAccountModelsForTests } from "../harnesses/claudeAccountModels.ts";
import type { AdapterEvent } from "../session/adapters/contract.ts";
import { COMPANY, PRIVATE, Y } from "../test/claudeListings.ts";
import { ClaudeSdkSession } from "../test/claudeSdkSession.ts";
import type {
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
} from "./sdkSeam.ts";

const PROVIDER_SESSION = "11111111-2222-3333-4444-555555555555";
const profiles: string[] = [];
let sequence = 0;

afterEach(() => {
  resetClaudeAccountModelsForTests();
  for (const id of profiles.splice(0)) deleteCredentialProfile(id);
});

/** A Claude account with a fixed listing (undefined: never read, unknown). */
function accounts(
  byName: Record<string, readonly string[] | undefined>,
): Record<string, string> {
  const ids: Record<string, string> = {};
  const listings = new Map<string, readonly string[] | undefined>();
  for (const [name, listing] of Object.entries(byName)) {
    const profile = createCredentialProfile({ name, provider: "claude" });
    profiles.push(profile.id);
    ids[name] = profile.id;
    listings.set(profile.id, listing);
  }
  resetClaudeAccountModelsForTests({
    read: async (id) => {
      const listing = listings.get(id);
      return listing ? [...listing] : undefined;
    },
  });
  return ids;
}

/** A seam recording each query's `--model` and answering one clean turn. */
function recordingSeam(models: string[], reported?: string): ClaudeSdkSeam {
  return {
    query(params: ClaudeQueryParams) {
      models.push(String(params.options?.model));
      const messages = [
        ...(reported
          ? [
              {
                type: "assistant",
                uuid: "asst-1",
                session_id: PROVIDER_SESSION,
                message: {
                  id: "msg-1",
                  role: "assistant",
                  model: reported,
                  content: [{ type: "text", text: "hi" }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              },
            ]
          : []),
        {
          type: "result",
          subtype: "success",
          session_id: PROVIDER_SESSION,
          uuid: "result-uuid",
          is_error: false,
          result: "",
          num_turns: 1,
          total_cost_usd: 0,
          modelUsage: {},
        },
      ] as unknown as ClaudeSdkMessage[];
      return {
        async *[Symbol.asyncIterator]() {
          for (const message of messages) yield message;
        },
      };
    },
  };
}

function session(
  profileId: string,
  modelId: string,
  seam: ClaudeSdkSeam,
  extra: { providerSessionId?: string; id?: string } = {},
): InstanceType<typeof ClaudeSdkSession> {
  return new ClaudeSdkSession(extra.id ?? `entitled-${sequence++}`, {
    seam: () => Promise.resolve(seam),
    credentialProfileId: profileId,
    modelId,
    thinkingLevel: "medium",
    agentType: "workshop",
    ...(extra.providerSessionId
      ? { providerSessionId: extra.providerSessionId }
      : {}),
  });
}

/** Give a session the agent row a pinned definition froze for it. */
function pinned(sessionId: string, model: string, pinnedModel: string): void {
  freezeSessionAgent(sessionId, {
    name: "pinned",
    blob: "0".repeat(40),
    persona: "developer",
    provider: "claude-sdk",
    model,
    pinnedModel,
    effort: "medium",
    runtimeSource: "definition",
    denyTools: [],
    skills: [],
    body: "",
  });
}

test("a fable turn opens with the newest fable its account lists; the record keeps the alias", async () => {
  const { company, y } = accounts({ company: COMPANY, y: Y });
  const models: string[] = [];
  const onCompany = session(company!, "fable", recordingSeam(models));
  await onCompany.createRuntimeAdapter().prompt("hello");
  const onY = session(y!, "fable", recordingSeam(models));
  await onY.createRuntimeAdapter().prompt("hello");
  assert.deepEqual(models, ["claude-fable-5-2", "claude-fable-5-1"]);
  assert.equal(onY.toRecord().modelId, "fable");
});

test("a standalone compact opens with the id its account resolves", async () => {
  const { y } = accounts({ y: Y });
  const models: string[] = [];
  const compacting = session(y!, "fable", recordingSeam(models), {
    providerSessionId: PROVIDER_SESSION,
  });
  await compacting.compactContext();
  assert.deepEqual(models, ["claude-fable-5-1"]);
});

test("a mythos turn on an unknown account is a local-policy backstop; once listed it runs", async () => {
  const listings = new Map<string, string[] | undefined>();
  const profile = createCredentialProfile({
    name: "usage limit 401 account",
    provider: "claude",
  });
  profiles.push(profile.id);
  const cache = resetClaudeAccountModelsForTests({
    read: async (id) => listings.get(id),
  });
  const models: string[] = [];
  const mythos = session(profile.id, "mythos", recordingSeam(models));
  const events: AdapterEvent[] = [];
  const envelopes: ServerMessage[] = [];
  const adapter = mythos.createRuntimeAdapter();
  adapter.subscribe((event) => events.push(event));
  mythos.addViewer({ send: (message) => envelopes.push(message) });

  const local = { kind: "unknown", localPolicy: true };
  const text = "usage limit 401 account can't run Claude Mythos.";
  assert.deepEqual(await adapter.prompt("hello"), {
    stopReason: "error",
    errorMessage: text,
    failure: local,
  });
  assert.deepEqual(models, [], "no query opened");
  const failing = events.find((event) => event.type === "runFailing");
  assert.deepEqual(failing && "failure" in failing && failing.failure, local);
  const completed = events.find((event) => event.type === "messageCompleted");
  assert.deepEqual(
    completed && "failure" in completed && completed.failure,
    local,
  );
  const end = envelopes.find((message) => message.type === "assistantEnd");
  assert.ok(end && "error" in end && end.error === text);
  assert.equal("errorInfo" in end, false, "never classified from its text");
  assert.equal(mythos.toRecord().modelId, "mythos");

  listings.set(profile.id, [...COMPANY]);
  await cache.refresh({ profileIds: [profile.id], force: true });
  assert.equal((await adapter.prompt("again")).stopReason, "end");
  assert.deepEqual(models, ["claude-mythos-5-2"]);
});

test("a reported mythos id keeps the session on mythos", async () => {
  const { company } = accounts({ company: COMPANY });
  const models: string[] = [];
  const mythos = session(
    company!,
    "mythos",
    recordingSeam(models, "claude-mythos-5-2"),
  );
  await mythos.createRuntimeAdapter().prompt("hello");
  assert.deepEqual(models, ["claude-mythos-5-2"]);
  assert.equal(mythos.toRecord().modelId, "mythos");
});

/** A session whose process is retained: a model change is a control. */
function retained(
  profileId: string,
  modelId: string,
  id?: string,
): { session: InstanceType<typeof ClaudeSdkSession>; calls: string[] } {
  const calls: string[] = [];
  const kept = session(
    profileId,
    modelId,
    {
      query() {
        throw new Error("no query in this test");
      },
    },
    id ? { id } : {},
  );
  Object.assign(kept, {
    activeQuery: {
      async setModel(model: string) {
        calls.push(model);
      },
    },
    retainedEpochKey: "retained",
    queryEpochKey: "retained",
  });
  return { session: kept, calls };
}

test("a model change resolves on the session's account before anything changes", async () => {
  const { company, priv, y } = accounts({
    company: COMPANY,
    priv: PRIVATE,
    y: Y,
  });
  const onPrivate = retained(priv!, "opus");
  let persisted = 0;
  Object.assign(onPrivate.session, { onPersist: () => (persisted += 1) });
  await assert.rejects(
    onPrivate.session.setModel("mythos"),
    (err: Error) =>
      err.name === "ModelUnavailableOnAccountError" &&
      err.message === "priv can't run Claude Mythos.",
  );
  assert.deepEqual(onPrivate.calls, []);
  assert.equal(onPrivate.session.toRecord().modelId, "opus");
  assert.equal(persisted, 0);

  const onCompany = retained(company!, "opus");
  await onCompany.session.setModel("mythos");
  assert.deepEqual(onCompany.calls, ["claude-mythos-5-2"]);
  assert.equal(onCompany.session.toRecord().modelId, "mythos");

  const onY = retained(y!, "opus");
  await onY.session.setModel("fable");
  assert.deepEqual(onY.calls, ["claude-fable-5-1"]);

  // Before the first prompt (no process), the change is refused the same way.
  const fresh = session(priv!, "opus", recordingSeam([]));
  await assert.rejects(
    fresh.setModel("mythos"),
    (err: Error) => err.name === "ModelUnavailableOnAccountError",
  );
  assert.equal(fresh.toRecord().modelId, "opus");
});

test("an unknown account keeps a session's own legacy pin, never as a new pin", async () => {
  const { off, company } = accounts({ off: undefined, company: COMPANY });
  const models: string[] = [];
  const id = `legacy-${sequence++}`;
  pinned(id, "opus", "claude-opus-5");
  const legacy = session(off!, "opus", recordingSeam(models), { id });
  await legacy.createRuntimeAdapter().prompt("hello");
  assert.deepEqual(models, ["claude-opus-5"]);

  // A model change back onto the alias carries no stored pin: refused.
  const changeId = `legacy-change-${sequence++}`;
  pinned(changeId, "opus", "claude-opus-5");
  const changing = retained(off!, "sonnet", changeId);
  await assert.rejects(
    changing.session.setModel("opus"),
    (err: Error) => err.name === "ModelUnavailableOnAccountError",
  );
  assert.deepEqual(changing.calls, []);
  // On an account that lists it, it runs.
  const listedId = `legacy-listed-${sequence++}`;
  pinned(listedId, "opus", "claude-opus-5");
  const listed = retained(company!, "sonnet", listedId);
  await listed.session.setModel("opus");
  assert.deepEqual(listed.calls, ["claude-opus-5"]);
});

test("a known account refuses a pin it does not list at the open", async () => {
  const { y } = accounts({ y: Y });
  const models: string[] = [];
  const id = `pinned-52-${sequence++}`;
  pinned(id, "fable", "claude-fable-5-2");
  const onY = session(y!, "fable", recordingSeam(models), { id });
  const result = await onY.createRuntimeAdapter().prompt("hello");
  assert.equal(result.stopReason, "error");
  assert.deepEqual(result.failure, { kind: "unknown", localPolicy: true });
  assert.deepEqual(models, []);
});

test("a refused model change reaches the adapter's caller and announces no config change", async () => {
  const { priv } = accounts({ priv: PRIVATE });
  const refusing = session(priv!, "opus", recordingSeam([]));
  const adapter = refusing.createRuntimeAdapter();
  const events: AdapterEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  await assert.rejects(
    async () => adapter.setModel({ provider: "claude-sdk", id: "mythos" }),
    /priv can't run Claude Mythos\./,
  );
  assert.equal(
    events.some((event) => event.type === "sessionConfigChanged"),
    false,
  );
  await adapter.setModel({ provider: "claude-sdk", id: "sonnet" });
  assert.equal(
    events.filter((event) => event.type === "sessionConfigChanged").length,
    1,
  );
});
