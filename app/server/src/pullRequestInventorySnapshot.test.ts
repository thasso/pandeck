import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import type { PullRequestInventoryItem } from "@assistant/shared";
import {
  pullRequestInventoryResponse,
  pullRequestInventorySnapshotPathForTests,
  readPullRequestInventorySnapshot,
  resetPullRequestInventorySnapshotForTests,
  unloadPullRequestInventorySnapshotForTests,
  writePullRequestInventorySnapshot,
  type PullRequestInventorySnapshot,
} from "./pullRequestInventorySnapshot.ts";

function item(): PullRequestInventoryItem {
  return {
    projectId: "pa",
    provider: "forgejo",
    repositoryKey: "acme/pa",
    repoWebUrl: "https://git.example/acme/pa",
    number: 7,
    url: "https://git.example/acme/pa/pulls/7",
    title: "Pull 7",
    headBranch: "feature-7",
    baseBranch: "main",
    mine: true,
    reviewRequested: false,
    state: "open",
    sessionIds: [],
    taskIds: [],
  };
}

beforeEach(resetPullRequestInventorySnapshotForTests);
afterEach(resetPullRequestInventorySnapshotForTests);

test("the versioned snapshot survives a memory restart with its timestamp", () => {
  const snapshot: PullRequestInventorySnapshot = {
    version: 1,
    builtAt: 200,
    projects: { pa: { items: [item()], fetchedAt: 123 } },
  };
  writePullRequestInventorySnapshot(snapshot);
  unloadPullRequestInventorySnapshotForTests();

  assert.deepEqual(readPullRequestInventorySnapshot(), snapshot);
  assert.deepEqual(pullRequestInventoryResponse(snapshot), {
    status: "ready",
    items: [item()],
    fetchedAt: 123,
  });
});

test("a corrupt cache file is a cold cache", () => {
  const path = pullRequestInventorySnapshotPathForTests();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "not json", "utf8");
  unloadPullRequestInventorySnapshotForTests();

  assert.equal(readPullRequestInventorySnapshot(), null);
});

test("an unknown cache version is a cold cache", () => {
  const path = pullRequestInventorySnapshotPathForTests();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ version: 2, builtAt: 1, projects: {} }),
    "utf8",
  );
  unloadPullRequestInventorySnapshotForTests();

  assert.equal(readPullRequestInventorySnapshot(), null);
});
