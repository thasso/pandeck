/**
 * A model change and an account move race on one idle Claude session: nothing
 * holds the account while `setModel` waits for a listing, so a move can commit
 * in between. The model must be judged on the account the session has when the
 * change lands (`docs/agent-harnesses.md`, models port), never on the account
 * it was asked about before the move.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import {
  createCredentialProfile,
  deleteCredentialProfile,
} from "../credentialProfiles.ts";
import { sessionStore } from "../db/sessionStore.ts";
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

test("a model change pending on A while the session moves to B is judged on B, which cannot run it", async () => {
  const f = fixture();
  const changing = f.live.setModel("mythos");
  changing.catch(() => {});
  await settle();
  // The move sees the unchanged opus selection, which B runs, and commits.
  await f.move();
  assert.equal(f.live.credentialProfileId, f.b);
  f.releaseA(COMPANY);
  await assert.rejects(
    changing,
    (err: Error) =>
      err.name === "ModelUnavailableOnAccountError" &&
      err.message === "B can't run Claude Mythos.",
  );
  assert.equal(f.live.credentialProfileId, f.b);
  assert.equal(f.live.toRecord().modelId, "opus");
  assert.equal(f.live.modelSelection().model?.id, "opus");
  assert.equal(sessionStore.get(f.live.id)?.credentialProfileId, f.b);
});

test("a model change pending on A while the session moves to B lands when B runs it", async () => {
  const f = fixture();
  const changing = f.live.setModel("sonnet");
  await settle();
  await f.move();
  f.releaseA(COMPANY);
  await changing;
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

test("a retained process's model change is dropped when the session moves during the control call", async () => {
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
  const changing = f.live.setModel("mythos");
  changing.catch(() => {});
  await settle();
  assert.deepEqual(controls, ["claude-mythos-5-2"]);
  // The real move closes the retained process and commits B while the
  // control call is still out.
  await f.move();
  assert.equal(closed, true, "the move closed the retained process");
  finishControl();
  await assert.rejects(changing, {
    name: "AccountChangedDuringModelChangeError",
    message:
      "The session moved to another account while its model was changing. Pick the model again.",
  });
  assert.equal(f.live.credentialProfileId, f.b);
  assert.equal(f.live.toRecord().modelId, "opus");
});

test("a retained process's model change on an unmoved session lands", async () => {
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
  const before = f.persisted();
  await f.live.setModel("mythos");
  assert.deepEqual(controls, ["claude-mythos-5-2"]);
  assert.equal(f.live.toRecord().modelId, "mythos");
  assert.equal(f.persisted(), before + 1);
});
