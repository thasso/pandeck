/**
 * A model change and an account move on one idle Claude session. A model
 * change holds its admission place (`admissionQueue.ts`) while it resolves the
 * model on the session's account, and an account switch waits behind it, so
 * the change is judged on the account it was asked about and the move is
 * judged on the model it left (`docs/agent-harnesses.md`, models port;
 * `docs/session-runtime-switching.md`).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import {
  createCredentialProfile,
  deleteCredentialProfile,
} from "../credentialProfiles.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { assertSessionModelEntitled } from "../sessionAccount.ts";
import { resetClaudeAccountModelsForTests } from "../harnesses/claudeAccountModels.ts";
import { COMPANY, PRIVATE } from "../test/claudeListings.ts";
import { enableClaudeSdkForTests } from "../test/claudeSdkEnabled.ts";
import { ClaudeSdkSession } from "../test/claudeSdkSession.ts";
import type { ClaudeSdkSeam } from "./sdkSeam.ts";

const profiles: string[] = [];
const sessions: string[] = [];
let sequence = 0;

// These suites drive Claude runs; the integration is off by default.
beforeEach(enableClaudeSdkForTests);

afterEach(() => {
  resetClaudeAccountModelsForTests();
  for (const id of sessions.splice(0)) sessionStore.remove(id);
  for (const id of profiles.splice(0)) deleteCredentialProfile(id);
});

const noQueries: ClaudeSdkSeam = {
  query() {
    throw new Error("no provider call in a model change");
  },
};

/**
 * Accounts A and B. A's first listing waits for `releaseA`; B lists PRIVATE (no
 * mythos). The session is stored, bound to A, on opus.
 */
function fixture() {
  const a = createCredentialProfile({ name: "A", provider: "claude" }).id;
  const b = createCredentialProfile({ name: "B", provider: "claude" }).id;
  profiles.push(a, b);
  let releaseA!: (listing: readonly string[]) => void;
  const aListing = new Promise<readonly string[]>((resolve) => {
    releaseA = resolve;
  });
  resetClaudeAccountModelsForTests({
    read: async (id) =>
      id === a ? [...(await aListing)] : id === b ? [...PRIVATE] : undefined,
  });
  const id = `model-change-race-${sequence++}`;
  sessionStore.upsert({
    id,
    harness: "claude-sdk",
    agentType: "workshop",
    credentialProfileId: a,
  });
  sessions.push(id);
  const live = new ClaudeSdkSession(id, {
    seam: () => Promise.resolve(noQueries),
    credentialProfileId: a,
    modelId: "opus",
    thinkingLevel: "medium",
    agentType: "workshop",
  });
  let persisted = 0;
  Object.assign(live, { onPersist: () => (persisted += 1) });
  return {
    a,
    b,
    live,
    releaseA,
    persisted: () => persisted,
    /** The move the inspector's picker makes on an idle, history-free session. */
    move: () => live.switchAccount(b, () => {}, { allowWithoutHistory: true }),
  };
}

/** Let the pending resolve reach its listing wait. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("a move asked for while a model change waits on A's listing waits; the change is judged on A, and turn admission judges the move's result", async () => {
  const f = fixture();
  let accountWhenChanged: string | undefined;
  const changing = f.live.setModel("mythos").then(() => {
    accountWhenChanged = f.live.credentialProfileId;
  });
  await settle();
  const moving = f.move();
  await settle();
  assert.equal(f.live.credentialProfileId, f.a, "the move waits");
  f.releaseA(COMPANY);
  await changing;
  assert.equal(
    accountWhenChanged,
    f.a,
    "the change landed on A, before the move",
  );
  assert.equal(f.live.toRecord().modelId, "mythos");
  // The switch primitive moves what it is given; the move's model rule is its
  // caller's (`modelRefusal`), and the next turn's admission refuses B as
  // local policy before any provider call.
  await moving;
  await assert.rejects(
    assertSessionModelEntitled({
      sessionId: f.live.id,
      credentialProfileId: f.live.credentialProfileId,
      model: f.live.modelSelection().model,
    }),
    /B can't run Claude Mythos/,
  );
});

test("a move asked for while a model change waits commits after it when B runs the new model", async () => {
  const f = fixture();
  const changing = f.live.setModel("sonnet");
  await settle();
  const moving = f.move();
  await settle();
  assert.equal(f.live.credentialProfileId, f.a, "the move waits");
  f.releaseA(COMPANY);
  await changing;
  await moving;
  assert.equal(f.live.credentialProfileId, f.b);
  assert.equal(f.live.toRecord().modelId, "sonnet");
});

test("without a move, a model change waits for its account's listing and lands", async () => {
  const f = fixture();
  const changing = f.live.setModel("mythos");
  await settle();
  f.releaseA(COMPANY);
  await changing;
  assert.equal(f.live.credentialProfileId, f.a);
  assert.equal(f.live.toRecord().modelId, "mythos");
});

test("a move waits for a retained process's model control call, then closes the process on the new model", async () => {
  const f = fixture();
  f.releaseA(COMPANY);
  const controls: string[] = [];
  let finishControl!: () => void;
  const control = new Promise<void>((resolve) => {
    finishControl = resolve;
  });
  let closed = false;
  Object.assign(f.live, {
    activeQuery: {
      async setModel(model: string) {
        controls.push(model);
        await control;
      },
      close() {
        closed = true;
      },
    },
    retainedEpochKey: "retained",
    queryEpochKey: "retained",
  });
  const changing = f.live.setModel("sonnet");
  await settle();
  assert.deepEqual(controls, ["claude-sonnet-5-5"]);
  const moving = f.move();
  await settle();
  assert.equal(closed, false, "the move waits for the control call");
  assert.equal(f.live.credentialProfileId, f.a);
  finishControl();
  await changing;
  await moving;
  assert.equal(closed, true, "the move closed the retained process");
  assert.equal(f.live.credentialProfileId, f.b);
  assert.equal(f.live.toRecord().modelId, "sonnet");
});

test("a retained process's model change on an unmoved session lands with the id its account resolves", async () => {
  const f = fixture();
  f.releaseA(COMPANY);
  const controls: string[] = [];
  Object.assign(f.live, {
    activeQuery: {
      async setModel(model: string) {
        controls.push(model);
      },
    },
    retainedEpochKey: "retained",
    queryEpochKey: "retained",
  });
  await f.live.setModel("mythos");
  assert.deepEqual(controls, ["claude-mythos-5-2"]);
  assert.equal(f.live.toRecord().modelId, "mythos");
});
