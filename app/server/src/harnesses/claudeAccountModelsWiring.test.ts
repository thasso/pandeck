/**
 * The Claude listing refresh as the server wires it: `startClaudeAccountModelRefresh`
 * on the real credential-profile registry and its real change and delete
 * subscriptions, an hourly timer on a fake clock, and the user's Refresh
 * through `refreshAllModels`. The gateway read is a fake; no credential exists.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "claude-models-wiring-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

vi.mock("../piSdk/models.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../piSdk/models.ts")>()),
  refreshModels: vi.fn(async () => ({ models: [] })),
}));

const {
  completeCredentialProfileLogin,
  createCredentialProfile,
  deleteCredentialProfile,
  listCredentialProfiles,
  renameCredentialProfile,
  setCredentialProfileEnabled,
} = await import("../credentialProfiles.ts");
const {
  claudeAccountModelIds,
  resetClaudeAccountModelsForTests,
  startClaudeAccountModelRefresh,
  subscribeClaudeAccountModelsChanged,
} = await import("./claudeAccountModels.ts");
const { refreshAllModels } = await import("./models.ts");
const { refreshModels } = await import("../piSdk/models.ts");

const ALL = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
];
const NO_HAIKU = ALL.filter((id) => id !== "claude-haiku-5-5");
const HOUR = 60 * 60_000;

interface Pending {
  id: string;
  resolve: (ids: string[]) => void;
}

/** Every gateway read, in order; each waits until the test answers it. */
let reads: Pending[] = [];
let changed: string[] = [];
let stop: (() => void) | undefined;
let unsubscribe: (() => void) | undefined;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const readsOf = (id: string) => reads.filter((read) => read.id === id);
/** Answer every read still waiting with the given listings. */
async function answer(byId: Record<string, string[]>): Promise<void> {
  const waiting = reads.splice(0);
  for (const read of waiting) read.resolve(byId[read.id] ?? ALL);
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  reads = [];
  changed = [];
  resetClaudeAccountModelsForTests({
    read: (id) =>
      new Promise<string[]>((resolve) => reads.push({ id, resolve })),
  });
  unsubscribe = subscribeClaudeAccountModelsChanged((id) => changed.push(id));
});

afterEach(() => {
  stop?.();
  stop = undefined;
  unsubscribe?.();
  vi.useRealTimers();
  resetClaudeAccountModelsForTests();
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("startup and hourly read every enabled Claude account; logins, relogins and enabling re-read at once; deletion drops the listing", async () => {
  const team = createCredentialProfile({ name: "Team", provider: "claude" });
  const priv = createCredentialProfile({ name: "Private", provider: "claude" });
  const off = createCredentialProfile({ name: "Off", provider: "claude" });
  setCredentialProfileEnabled(off.id, false);
  const openAi = createCredentialProfile({
    name: "OpenAI",
    provider: "openai-codex",
  });
  assert.equal(reads.length, 0, "nothing reads before the server starts it");

  // Startup: one unforced read per enabled Claude account, nothing else.
  stop = startClaudeAccountModelRefresh();
  assert.deepEqual(
    reads.map((read) => read.id).sort(),
    [priv.id, team.id].sort(),
  );
  await answer({ [priv.id]: NO_HAIKU });
  assert.ok(!claudeAccountModelIds(priv.id)!.has("claude-haiku-5-5"));
  assert.ok(claudeAccountModelIds(team.id)!.has("claude-haiku-5-5"));
  assert.deepEqual(changed.sort(), [priv.id, team.id].sort());

  // Hourly: the timer reads them again; a changed listing publishes.
  changed = [];
  vi.advanceTimersByTime(HOUR - 1);
  assert.equal(reads.length, 0);
  vi.advanceTimersByTime(1);
  assert.deepEqual(
    reads.map((read) => read.id).sort(),
    [priv.id, team.id].sort(),
  );
  await answer({ [priv.id]: ALL, [team.id]: ALL });
  assert.deepEqual(changed, [priv.id], "only the changed listing publishes");

  // A login during a read: the forced post-login read wins, whatever order
  // the two reads end in.
  changed = [];
  vi.advanceTimersByTime(HOUR);
  const before = readsOf(priv.id)[0]!;
  completeCredentialProfileLogin(priv.id);
  const after = readsOf(priv.id)[1]!;
  assert.ok(
    after,
    "the login starts a read at once, never joining the old one",
  );
  after.resolve(NO_HAIKU);
  await flush();
  before.resolve(ALL);
  await answer({});
  assert.ok(!claudeAccountModelIds(priv.id)!.has("claude-haiku-5-5"));

  // A relogin (another completed login) reads again too.
  completeCredentialProfileLogin(priv.id);
  assert.equal(readsOf(priv.id).length, 1);
  await answer({ [priv.id]: ALL });
  assert.ok(claudeAccountModelIds(priv.id)!.has("claude-haiku-5-5"));

  // Enabling an account reads it; disabling one, or any non-Claude change,
  // reads nothing.
  setCredentialProfileEnabled(off.id, true);
  assert.deepEqual(
    reads.map((read) => read.id),
    [off.id],
  );
  await answer({ [off.id]: NO_HAIKU });
  setCredentialProfileEnabled(team.id, false);
  renameCredentialProfile(openAi.id, "OpenAI 2");
  assert.equal(reads.length, 0);

  // Deletion drops the listing and says so; nothing reads it again.
  changed = [];
  deleteCredentialProfile(off.id);
  assert.equal(claudeAccountModelIds(off.id), undefined);
  assert.deepEqual(changed, [off.id]);
  assert.equal(reads.length, 0);

  // Stopped: no timer, no subscription is left behind.
  stop();
  stop = undefined;
  completeCredentialProfileLogin(priv.id);
  vi.advanceTimersByTime(2 * HOUR);
  assert.equal(reads.length, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("the user's Refresh forces a fresh read of every enabled Claude account, known or not, beside pi's", async () => {
  // The registry is shared with the test above: start from no enabled account.
  for (const { id } of listCredentialProfiles())
    setCredentialProfileEnabled(id, false);
  const known = createCredentialProfile({ name: "Known", provider: "claude" });
  const fresh = createCredentialProfile({ name: "Fresh", provider: "claude" });
  stop = startClaudeAccountModelRefresh();
  // Only `known` answers at startup; `fresh` is still reading.
  readsOf(known.id)[0]!.resolve(ALL);
  await flush();
  const stale = readsOf(fresh.id)[0]!;
  reads = [];

  vi.mocked(refreshModels).mockClear();
  const refreshed = refreshAllModels();
  assert.deepEqual(
    reads.map((read) => read.id).sort(),
    [fresh.id, known.id].sort(),
    "a known account is read again, and a running read is not joined",
  );
  assert.equal(vi.mocked(refreshModels).mock.calls.length, 1);
  await answer({ [known.id]: NO_HAIKU, [fresh.id]: NO_HAIKU });
  assert.deepEqual(await refreshed, { models: [] }, "pi's result is returned");
  assert.ok(!claudeAccountModelIds(known.id)!.has("claude-haiku-5-5"));

  // The read the Refresh superseded never lands over it.
  stale.resolve(ALL);
  await flush();
  assert.ok(!claudeAccountModelIds(fresh.id)!.has("claude-haiku-5-5"));
});
