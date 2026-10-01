import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { PullRequestInventoryItem } from "@assistant/shared";
import {
  invalidatePullRequestInventorySnapshot,
  mergePullRequestInventoryBuild,
  obsoletePullRequestInventoryBuild,
  refreshPullRequestInventorySnapshot,
  requestPullRequestInventoryRefresh,
  resetPullRequestInventorySyncForTests,
  setPullRequestInventorySyncOperationsForTests,
  startPullRequestInventorySync,
  stopPullRequestInventorySync,
  type PullRequestInventorySyncOperations,
} from "./pullRequestInventorySync.ts";
import type { PullRequestInventorySnapshot } from "./pullRequestInventorySnapshot.ts";

function item(projectId: string, number: number): PullRequestInventoryItem {
  return {
    projectId,
    provider: "forgejo",
    repositoryKey: `acme/${projectId}`,
    repoWebUrl: `https://git.example/acme/${projectId}`,
    number,
    url: `https://git.example/acme/${projectId}/pulls/${number}`,
    title: `Pull ${number}`,
    headBranch: `feature-${number}`,
    baseBranch: "main",
    mine: true,
    reviewRequested: false,
    state: "open",
    sessionIds: [],
    taskIds: [],
  };
}

function emptySnapshot(): PullRequestInventorySnapshot | null {
  return null;
}

afterEach(() => resetPullRequestInventorySyncForTests());

test("a refresh writes the completed provider projection", async () => {
  const write = vi.fn();
  const operations: PullRequestInventorySyncOperations = {
    build: async () => ({
      items: [item("pa", 7)],
      projectIds: ["pa"],
      failedProjectIds: [],
    }),
    read: emptySnapshot,
    write,
    now: () => 123,
  };

  setPullRequestInventorySyncOperationsForTests(operations);
  const response = await refreshPullRequestInventorySnapshot();

  assert.deepEqual(response, {
    status: "ready",
    items: [item("pa", 7)],
    fetchedAt: 123,
  });
  assert.deepEqual(write.mock.calls, [
    [
      {
        version: 1,
        builtAt: 123,
        projects: { pa: { items: [item("pa", 7)], fetchedAt: 123 } },
      },
    ],
  ]);
});

test("concurrent refresh requests share one build", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const build = vi.fn(async () => {
    await gate;
    return {
      items: [item("pa", 8)],
      projectIds: ["pa"],
      failedProjectIds: [],
    };
  });
  const write = vi.fn();
  const operations: PullRequestInventorySyncOperations = {
    build,
    read: emptySnapshot,
    write,
    now: () => 456,
  };

  setPullRequestInventorySyncOperationsForTests(operations);
  const first = refreshPullRequestInventorySnapshot();
  const second = refreshPullRequestInventorySnapshot();
  release();

  assert.equal(first, second);
  await first;
  assert.equal(build.mock.calls.length, 1);
  assert.equal(write.mock.calls.length, 1);
});

test("invalidation discards an older in-flight build and rebuilds", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const operations: PullRequestInventorySyncOperations = {
    async build() {
      calls += 1;
      if (calls === 1) await gate;
      return {
        items: [item("pa", calls)],
        projectIds: ["pa"],
        failedProjectIds: [],
      };
    },
    read: emptySnapshot,
    write: vi.fn(),
    now: () => 789,
  };

  setPullRequestInventorySyncOperationsForTests(operations);
  const refresh = refreshPullRequestInventorySnapshot();
  invalidatePullRequestInventorySnapshot();
  release();
  const response = await refresh;

  assert.equal(calls, 2);
  assert.deepEqual(response.items, [item("pa", 2)]);
  assert.equal(vi.mocked(operations.write).mock.calls.length, 1);
});

test("a failed project retains its older rows while successful projects replace", () => {
  const previous: PullRequestInventorySnapshot = {
    version: 1,
    builtAt: 100,
    projects: {
      alpha: { items: [item("alpha", 1)], fetchedAt: 90 },
      beta: { items: [item("beta", 2)], fetchedAt: 100 },
      removed: { items: [item("removed", 3)], fetchedAt: 100 },
    },
  };

  const merged = mergePullRequestInventoryBuild(
    previous,
    {
      items: [item("beta", 4)],
      projectIds: ["alpha", "beta"],
      failedProjectIds: ["alpha"],
    },
    200,
  );

  assert.deepEqual(merged, {
    version: 1,
    builtAt: 200,
    projects: {
      alpha: { items: [item("alpha", 1)], fetchedAt: 90 },
      beta: { items: [item("beta", 4)], fetchedAt: 200 },
    },
  });
});

test("a successful empty project removes its old rows", () => {
  const previous: PullRequestInventorySnapshot = {
    version: 1,
    builtAt: 100,
    projects: { pa: { items: [item("pa", 1)], fetchedAt: 100 } },
  };

  const merged = mergePullRequestInventoryBuild(
    previous,
    { items: [], projectIds: ["pa"], failedProjectIds: [] },
    200,
  );

  assert.deepEqual(merged.projects.pa, { items: [], fetchedAt: 200 });
});

test("a cold all-provider failure stays cold", () => {
  assert.throws(
    () =>
      mergePullRequestInventoryBuild(
        null,
        {
          items: [],
          projectIds: ["pa"],
          failedProjectIds: ["pa"],
        },
        200,
      ),
    /No pull request provider answered/,
  );
});

test("a refresh deadline releases a build that never settles", async () => {
  vi.useFakeTimers();
  try {
    const operations: PullRequestInventorySyncOperations = {
      build: () => new Promise(() => {}),
      read: emptySnapshot,
      write: vi.fn(),
      now: () => 789,
      timeoutMs: 100,
    };
    setPullRequestInventorySyncOperationsForTests(operations);

    const refresh = refreshPullRequestInventorySnapshot();
    const rejected = assert.rejects(refresh, /timed out after 100 ms/);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
  } finally {
    vi.useRealTimers();
  }
});

test("the deployment gate disables the timer and unsolicited refresh requests", async () => {
  vi.useFakeTimers();
  try {
    const build = vi.fn(async () => ({
      items: [],
      projectIds: [],
      failedProjectIds: [],
    }));
    setPullRequestInventorySyncOperationsForTests({
      build,
      read: emptySnapshot,
      write: vi.fn(),
      now: () => 789,
    });

    startPullRequestInventorySync();
    requestPullRequestInventoryRefresh();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    assert.equal(build.mock.calls.length, 0);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

test("one failed project does not slow healthy projects below the normal cadence", async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const previous: PullRequestInventorySnapshot = {
      version: 1,
      builtAt: 100,
      projects: {
        alpha: { items: [item("alpha", 1)], fetchedAt: 100 },
      },
    };
    setPullRequestInventorySyncOperationsForTests({
      async build() {
        calls += 1;
        return {
          items: [item("beta", calls)],
          projectIds: ["alpha", "beta"],
          failedProjectIds: ["alpha"],
        };
      },
      read: () => previous,
      write: vi.fn(),
      now: () => 789,
    });

    startPullRequestInventorySync({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(calls, 1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    assert.equal(calls, 2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    assert.equal(calls, 3);
  } finally {
    stopPullRequestInventorySync();
    vi.useRealTimers();
  }
});

test("the loop is idempotent, backs off repeated failures, and stops its timer", async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const operations: PullRequestInventorySyncOperations = {
      async build() {
        calls += 1;
        if (calls <= 2) throw new Error("provider unavailable");
        return { items: [], projectIds: [], failedProjectIds: [] };
      },
      read: emptySnapshot,
      write: vi.fn(),
      now: () => 789,
    };
    setPullRequestInventorySyncOperationsForTests(operations);

    startPullRequestInventorySync({ force: true });
    startPullRequestInventorySync({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(calls, 1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    assert.equal(calls, 2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    assert.equal(calls, 2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    assert.equal(calls, 3);

    stopPullRequestInventorySync();
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

test("a failed refresh does not replace the stored snapshot", async () => {
  const write = vi.fn();
  const operations: PullRequestInventorySyncOperations = {
    build: async () => {
      throw new Error("provider unavailable");
    },
    read: emptySnapshot,
    write,
    now: () => 789,
  };

  setPullRequestInventorySyncOperationsForTests(operations);
  await assert.rejects(
    refreshPullRequestInventorySnapshot(),
    /provider unavailable/,
  );
  assert.equal(write.mock.calls.length, 0);
});

test("a build that missed its deadline finishes before the next one starts", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let running = 0;
  let peak = 0;
  let calls = 0;
  setPullRequestInventorySyncOperationsForTests({
    async build() {
      calls += 1;
      running += 1;
      peak = Math.max(peak, running);
      try {
        if (calls === 1) await gate;
        return { items: [], projectIds: ["pa"], failedProjectIds: [] };
      } finally {
        running -= 1;
      }
    },
    read: emptySnapshot,
    write: vi.fn(),
    now: () => 1,
    timeoutMs: 20,
  });

  await assert.rejects(refreshPullRequestInventorySnapshot(), /timed out/);
  const next = refreshPullRequestInventorySnapshot();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1, "the abandoned build is still running");
  release();
  await next;
  assert.equal(calls, 2);
  assert.equal(peak, 1);
});

test("a mutation while waiting for an abandoned build does not discard the next one", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  setPullRequestInventorySyncOperationsForTests({
    async build() {
      calls += 1;
      if (calls === 1) await gate;
      return { items: [], projectIds: ["pa"], failedProjectIds: [] };
    },
    read: emptySnapshot,
    write: vi.fn(),
    now: () => 1,
    timeoutMs: 20,
  });

  await assert.rejects(refreshPullRequestInventorySnapshot(), /timed out/);
  const next = refreshPullRequestInventorySnapshot();
  obsoletePullRequestInventoryBuild();
  release();
  await next;
  assert.equal(calls, 2, "the build after the wait already saw the mutation");
});
