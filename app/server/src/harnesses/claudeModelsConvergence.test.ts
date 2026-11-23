/**
 * Cold discovery converges (`docs/agent-harnesses.md`, models port): the account
 * projection's own models map (`modelsByAccount`, what
 * `GET /api/credential-profiles?includeModels=1` answers) starts a cold Claude
 * account's first listing read. Its success pushes `models` through the same
 * subscription `hub.ts` pushes from while that request is still running, and
 * the client's refetch on the push (the web's `credentialProfilesChanged`)
 * reads known listings only, so it pushes nothing. Real registry and settings
 * on a temp data dir; the gateway read is a fake.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelOption } from "@assistant/shared";
import { afterAll, afterEach, beforeAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "claude-models-convergence-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const {
  createCredentialProfile,
  listCredentialProfiles,
  setCredentialProfileEnabled,
} = await import("../credentialProfiles.ts");
const { getSettings, updateSettings } = await import("../settings.ts");
const { resetClaudeAccountModelsForTests } =
  await import("./claudeAccountModels.ts");
const { modelsByAccount, subscribePickerModelsChanged } =
  await import("./models.ts");

const ALL = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
];
const NO_HAIKU = ALL.filter((id) => id !== "claude-haiku-5-5");

interface Pending {
  id: string;
  resolve: (ids: string[]) => void;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const ids = (models: ModelOption[] | undefined) =>
  (models ?? []).map((model) => model.id);

/**
 * One client: a projection request counter, and a refetch on every push, as
 * the web does. Records whether each push arrived while a request ran.
 */
function client() {
  const state = {
    requests: 0,
    running: 0,
    pushes: [] as { duringRequest: boolean }[],
    refetches: [] as Promise<Record<string, ModelOption[]>>[],
  };
  const project = async () => {
    state.requests += 1;
    state.running += 1;
    try {
      return await modelsByAccount(listCredentialProfiles());
    } finally {
      state.running -= 1;
    }
  };
  const unsubscribe = subscribePickerModelsChanged(() => {
    state.pushes.push({ duringRequest: state.running > 0 });
    state.refetches.push(project());
  });
  /** Settle every refetch, including those later pushes start. */
  const settle = async () => {
    for (let seen = 0; seen < state.refetches.length; seen += 1)
      await state.refetches[seen];
    await flush();
  };
  return { state, project, settle, unsubscribe };
}

let reads: Pending[] = [];
const cleanup: (() => void)[] = [];

beforeAll(() => {
  updateSettings({
    claudeSdk: { ...getSettings().claudeSdk, enabled: true },
  });
});

afterEach(() => {
  for (const run of cleanup.splice(0)) run();
  for (const { id } of listCredentialProfiles())
    setCredentialProfileEnabled(id, false);
  resetClaudeAccountModelsForTests();
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function coldReader(): void {
  reads = [];
  resetClaudeAccountModelsForTests({
    read: (id) =>
      new Promise<string[]>((resolve) => reads.push({ id, resolve })),
  });
}

test("a cold projection request's first listing pushes once while it runs; the one refetch it causes pushes nothing", async () => {
  const account = createCredentialProfile({
    name: "Private",
    provider: "claude",
  });
  coldReader();
  const { state, project, settle, unsubscribe } = client();
  cleanup.push(unsubscribe);

  const cold = project();
  await flush();
  assert.deepEqual(
    reads.map((read) => read.id),
    [account.id],
    "the cold request starts the account's first read",
  );
  reads[0]!.resolve(NO_HAIKU);
  const first = await cold;

  // The push came while the cold request was still running, and that same
  // request already answers with the listing.
  assert.deepEqual(state.pushes, [{ duringRequest: true }]);
  assert.ok(!ids(first[account.id]).includes("haiku"));

  await settle();
  assert.equal(state.requests, 2, "exactly one extra projection request");
  assert.equal(state.pushes.length, 1, "the refetch pushed nothing");
  assert.equal(reads.length, 1, "known listings are not read again");
  const refetched = await state.refetches[0]!;
  assert.deepEqual(refetched, first);

  // Any later projection request of known listings is silent too.
  await project();
  await flush();
  assert.equal(state.pushes.length, 1);
  assert.equal(reads.length, 1);
});

test("an unchanged first listing still pushes once (unknown to known), and nothing follows", async () => {
  const account = createCredentialProfile({ name: "Team", provider: "claude" });
  coldReader();
  const { state, project, settle, unsubscribe } = client();
  cleanup.push(unsubscribe);

  const cold = project();
  await flush();
  reads.find((read) => read.id === account.id)!.resolve(ALL);
  await cold;
  await settle();
  assert.equal(state.pushes.length, 1);
  assert.equal(state.requests, 2);
  assert.equal(reads.length, 1);
});

test("several cold accounts: each pushes once as it becomes known, and the exchange settles", async () => {
  const a = createCredentialProfile({ name: "A", provider: "claude" });
  const b = createCredentialProfile({ name: "B", provider: "claude" });
  coldReader();
  const { state, project, settle, unsubscribe } = client();
  cleanup.push(unsubscribe);

  const cold = project();
  await flush();
  assert.deepEqual(reads.map((read) => read.id).sort(), [a.id, b.id].sort());
  for (const read of reads.splice(0)) read.resolve(NO_HAIKU);
  await cold;
  await settle();

  assert.equal(
    state.pushes.length,
    2,
    "one push per newly known account, none from the refetches",
  );
  assert.equal(state.requests, 1 + state.pushes.length);
  assert.equal(reads.length, 0, "no refetch read a known listing again");
  const settled = state.pushes.length;
  await project();
  await settle();
  assert.equal(state.pushes.length, settled, "settled: no further push");
});
