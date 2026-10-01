import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { PullRequestInventoryItem } from "@assistant/shared";
import {
  resetPullRequestInventorySnapshotForTests,
  writePullRequestInventorySnapshot,
} from "./pullRequestInventorySnapshot.ts";

const hoisted = vi.hoisted(() => ({ provider: vi.fn() }));
vi.mock("./gitHosting.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gitHosting.ts")>();
  return { ...actual, hostingProviderForRepo: hoisted.provider };
});

const { handlePullRequestApi } = await import("./pullRequestHttp.ts");

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

beforeEach(() => {
  resetPullRequestInventorySnapshotForTests();
  hoisted.provider.mockReset();
});
afterEach(resetPullRequestInventorySnapshotForTests);

async function getInventory(): Promise<{ status: number; body: unknown }> {
  let status = 0;
  let body = "";
  const req = { method: "GET" } as IncomingMessage;
  const res = {
    writeHead(next: number) {
      status = next;
      return this;
    },
    end(value?: string) {
      body = value ?? "";
      return this;
    },
  } as unknown as ServerResponse;
  await handlePullRequestApi(
    req,
    res,
    new URL("http://localhost/api/pull-requests"),
    () => ({ "content-type": "application/json" }),
  );
  return { status, body: JSON.parse(body) as unknown };
}

test("a cold inventory is a successful loading answer with no provider call", async () => {
  assert.deepEqual(await getInventory(), {
    status: 200,
    body: { status: "cold", items: [], fetchedAt: null },
  });
  assert.equal(hoisted.provider.mock.calls.length, 0);
});

test("GET serves the persisted snapshot without a provider call", async () => {
  writePullRequestInventorySnapshot({
    version: 1,
    builtAt: 200,
    projects: { pa: { fetchedAt: 123, items: [item()] } },
  });

  assert.deepEqual(await getInventory(), {
    status: 200,
    body: { status: "ready", items: [item()], fetchedAt: 123 },
  });
  assert.equal(hoisted.provider.mock.calls.length, 0);
});
