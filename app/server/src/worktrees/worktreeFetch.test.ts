/**
 * The background fetch's SCHEDULING rules. The git call itself is exercised by
 * the worktree domain tests against real repos; what matters here is what this
 * module refuses to do — fetch when disabled, fetch a repo twice at once, and
 * above all claim a `fetchedAt` it did not earn.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

const gitOptional = vi.fn();

vi.mock("../gitExec.ts", () => ({
  gitOptional: (...args: unknown[]) => gitOptional(...args),
  repoLockKey: async (path: string) => `key:${path}`,
}));

let mod: typeof import("./worktreeFetch.ts");
let remoteFetchMinutes = 10;

async function loadWith(enabled: boolean, minutes = 10) {
  remoteFetchMinutes = minutes;
  vi.resetModules();
  vi.doMock("../config.ts", () => ({ BACKGROUND_FETCH_ENABLED: enabled }));
  vi.doMock("../settings.ts", () => ({
    getSettings: () => ({ worktrees: { remoteFetchMinutes } }),
  }));
  mod = await import("./worktreeFetch.ts");
  return mod;
}

beforeEach(() => {
  gitOptional.mockReset();
  gitOptional.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
});

afterEach(() => {
  mod?.resetBackgroundFetchForTests();
  vi.doUnmock("../config.ts");
  vi.doUnmock("../settings.ts");
});

test("a successful fetch stamps fetchedAt", async () => {
  const m = await loadWith(true);
  m.noteRepoInterest("key:/repo", "/repo");
  await m.fetchRepoRemotes("key:/repo", "/repo");
  const at = m.repoFetchedAt("key:/repo");
  assert.ok(at && at > 0, "expected a stamp after a clean fetch");
});

// This sweep runs WITHOUT the repository lock, so its isolation has to be a
// fact about the command. `FETCH_HEAD` is per-working-tree and this fetch runs
// in the MAIN checkout — the very one `worktreeSync.ts` reads under the lock to
// pick a rebase target ("pull main" is a `pull-rebase` there). What the argv
// does to a real repository is pinned in `worktreeSync.test.ts`.
test("the sweep asks git not to write FETCH_HEAD", async () => {
  const m = await loadWith(true);
  assert.deepEqual(m.backgroundFetchArgs(), [
    "fetch",
    "--prune",
    "--quiet",
    "--no-write-fetch-head",
    "--all",
  ]);

  await m.fetchRepoRemotes("key:/repo", "/repo");
  assert.deepEqual(
    gitOptional.mock.calls[0]?.[0],
    m.backgroundFetchArgs(),
    "the sweep must issue exactly those arguments",
  );
});

// The whole point of the stamp is that a consumer can tell how old the numbers
// are. Stamping a failed fetch would present stale counts as fresh.
test("a FAILED fetch leaves the previous stamp alone", async () => {
  const m = await loadWith(true);
  await m.fetchRepoRemotes("key:/repo", "/repo");
  const first = m.repoFetchedAt("key:/repo");
  assert.ok(first);

  gitOptional.mockResolvedValue({
    code: 128,
    stdout: "",
    stderr: "could not read from remote",
  });
  await m.fetchRepoRemotes("key:/repo", "/repo");
  assert.equal(
    m.repoFetchedAt("key:/repo"),
    first,
    "a failure must not refresh the stamp",
  );
});

test("a failing on-demand fetch remains fire-and-forget", async () => {
  const m = await loadWith(true);
  let release: (() => void) | undefined;
  gitOptional.mockImplementation(
    () =>
      new Promise(
        (resolve) =>
          (release = () =>
            resolve({ code: 128, stdout: "", stderr: "offline" })),
      ),
  );

  assert.equal(m.fetchRepoIfDue("key:/repo", "/repo"), undefined);
  assert.equal(gitOptional.mock.calls.length, 1);
  release?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(m.repoFetchedAt("key:/repo"), undefined);
});

test("a never-fetched repo reports no stamp at all", async () => {
  const m = await loadWith(true);
  gitOptional.mockResolvedValue({ code: 128, stdout: "", stderr: "no remote" });
  await m.fetchRepoRemotes("key:/repo", "/repo");
  assert.equal(m.repoFetchedAt("key:/repo"), undefined);
});

test("concurrent fetches of one repo coalesce into a single git call", async () => {
  const m = await loadWith(true);
  let release: (() => void) | undefined;
  gitOptional.mockImplementation(
    () =>
      new Promise(
        (resolve) =>
          (release = () => resolve({ code: 0, stdout: "", stderr: "" })),
      ),
  );
  const a = m.fetchRepoRemotes("key:/repo", "/repo");
  const b = m.fetchRepoRemotes("key:/repo", "/repo");
  assert.equal(a, b, "the second caller must join the in-flight fetch");
  release?.();
  await a;
  assert.equal(gitOptional.mock.calls.length, 1);
});

test("fetch due-ness uses the interval from settings", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const m = await loadWith(true, 10);
    await m.fetchRepoRemotes("key:/repo", "/repo");
    assert.equal(gitOptional.mock.calls.length, 1);

    vi.setSystemTime(new Date("2026-01-01T00:09:59Z"));
    m.fetchRepoIfDue("key:/repo", "/repo");
    assert.equal(gitOptional.mock.calls.length, 1, "still within ten minutes");

    vi.setSystemTime(new Date("2026-01-01T00:10:00Z"));
    m.fetchRepoIfDue("key:/repo", "/repo");
    assert.equal(gitOptional.mock.calls.length, 2, "due at ten minutes");
  } finally {
    vi.useRealTimers();
  }
});

test("zero disables watched and on-demand background fetches", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const m = await loadWith(true, 1);
    m.noteRepoInterest("key:/repo", "/repo");
    await m.fetchRepoRemotes("key:/repo", "/repo");
    const fetchedAt = m.repoFetchedAt("key:/repo");
    remoteFetchMinutes = 0;

    vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
    m.setFetchInterestSource(() => ["/repo"]);
    m.fetchRepoIfDue("key:/repo", "/repo");
    m.sweepBackgroundFetchForTests();

    assert.equal(gitOptional.mock.calls.length, 1);
    assert.equal(
      m.repoFetchedAt("key:/repo"),
      fetchedAt,
      "disabling must preserve freshness state",
    );
    assert.equal(await m.noteWorktreeInterest("/repo"), "key:/repo");
  } finally {
    vi.useRealTimers();
  }
});

test("a settings change takes effect without recreating the sweeper", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const m = await loadWith(true, 0);
    m.noteRepoInterest("key:/repo", "/repo");
    m.setFetchInterestSource(() => ["/repo"]);
    m.startBackgroundFetch();
    await vi.advanceTimersByTimeAsync(15_000);
    assert.equal(gitOptional.mock.calls.length, 0);

    remoteFetchMinutes = 1;
    await vi.advanceTimersByTimeAsync(15_000);

    assert.equal(
      gitOptional.mock.calls.length,
      1,
      "the existing timer must observe that fetching was enabled",
    );
  } finally {
    vi.useRealTimers();
  }
});

// Previews share production's checkouts, so the flag is what keeps N instances
// off the same repositories even when the user enables a cadence.
test("the instance gate wins for on-demand and swept fetches", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const m = await loadWith(false, 1);
    m.noteRepoInterest("key:/repo", "/repo");
    m.setFetchInterestSource(() => ["/repo"]);
    m.fetchRepoIfDue("key:/repo", "/repo");
    m.sweepBackgroundFetchForTests();
    m.startBackgroundFetch();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    assert.equal(gitOptional.mock.calls.length, 0);
  } finally {
    vi.useRealTimers();
  }
});

test("the fetch runs non-interactively so it cannot hang on a prompt", async () => {
  const m = await loadWith(true);
  await m.fetchRepoRemotes("key:/repo", "/repo");
  const [args, cwd, , env] = gitOptional.mock.calls[0] as [
    string[],
    string,
    unknown,
    Record<string, string | undefined>,
  ];
  assert.deepEqual(args, m.backgroundFetchArgs());
  assert.equal(cwd, "/repo");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.match(env.GIT_SSH_COMMAND ?? "", /BatchMode=yes/);
});

// A no-op fetch writes no refs, so the filesystem watcher sees nothing. Without
// its own signal the `fetchedAt` stamp would never reach a browser, and the
// card's "as of" marker would freeze at the last fetch that moved something.
test("a fetch that changes nothing still announces its freshness", async () => {
  const m = await loadWith(true);
  const seen: string[] = [];
  m.onFetchCompleted((repoPath) => seen.push(repoPath));
  await m.fetchRepoRemotes("key:/repo", "/repo");
  assert.deepEqual(seen, ["/repo"], "a clean no-op fetch must still notify");
});

test("a failed fetch announces nothing", async () => {
  const m = await loadWith(true);
  const seen: string[] = [];
  m.onFetchCompleted((repoPath) => seen.push(repoPath));
  gitOptional.mockResolvedValue({ code: 128, stdout: "", stderr: "boom" });
  await m.fetchRepoRemotes("key:/repo", "/repo");
  assert.deepEqual(seen, []);
});

// The reported failure: a browser holds the inbox open for hours with nothing
// happening locally, so no status is recomputed, the recorded interest ages
// out, and the repo is dropped exactly because the surface is calm.
test("a continuously watched repo is never forgotten, however long it is quiet", async () => {
  const m = await loadWith(true);
  m.noteRepoInterest("key:/repo", "/repo");
  await m.fetchRepoRemotes("key:/repo", "/repo");
  const firstStamp = m.repoFetchedAt("key:/repo");
  assert.ok(firstStamp);

  // Nobody reads a status again, and far more than the interest TTL passes.
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + 60 * 60_000);
    m.setFetchInterestSource(() => ["/repo"]);
    m.sweepBackgroundFetchForTests();
    await vi.waitFor(() => assert.equal(gitOptional.mock.calls.length, 2));
    assert.ok(
      (m.repoFetchedAt("key:/repo") ?? 0) > (firstStamp ?? 0),
      "the watched repo must have been refreshed",
    );
  } finally {
    vi.useRealTimers();
  }
});

test("interest lifetime scales beyond a longer fetch interval", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const m = await loadWith(true, 20);
    m.noteRepoInterest("key:/repo", "/repo");
    await m.fetchRepoRemotes("key:/repo", "/repo");

    vi.setSystemTime(new Date("2026-01-01T00:21:00Z"));
    m.setFetchInterestSource(() => []);
    m.sweepBackgroundFetchForTests();
    await vi.waitFor(() => assert.equal(gitOptional.mock.calls.length, 2));
    assert.ok(
      m.repoFetchedAt("key:/repo"),
      "the repo must survive the old 15-minute TTL to reach its next fetch",
    );
  } finally {
    vi.useRealTimers();
  }
});

test("a repo nobody watches or reads is forgotten", async () => {
  const m = await loadWith(true);
  m.noteRepoInterest("key:/repo", "/repo");
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + 60 * 60_000);
    m.setFetchInterestSource(() => []);
    m.sweepBackgroundFetchForTests();
    assert.equal(m.repoFetchedAt("key:/repo"), undefined);
    assert.equal(
      gitOptional.mock.calls.length,
      0,
      "a forgotten repo must not be fetched",
    );
  } finally {
    vi.useRealTimers();
  }
});
