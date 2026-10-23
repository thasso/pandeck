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
const {
  resetPullRequestInventorySyncForTests,
  setPullRequestInventorySyncOperationsForTests,
} = await import("./pullRequestInventorySync.ts");

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
afterEach(() => {
  resetPullRequestInventorySnapshotForTests();
  resetPullRequestInventorySyncForTests();
});

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

async function callRefresh(
  method: string,
): Promise<{ status: number; body: unknown }> {
  let status = 0;
  let body = "";
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
    { method } as IncomingMessage,
    res,
    new URL("http://localhost/api/pull-requests/refresh"),
    () => ({ "content-type": "application/json" }),
  );
  return { status, body: JSON.parse(body) as unknown };
}

test("POST refresh rebuilds from the providers and answers the written snapshot", async () => {
  let written: unknown;
  setPullRequestInventorySyncOperationsForTests({
    build: async () => ({
      items: [item()],
      projectIds: ["pa"],
      failedProjectIds: [],
    }),
    read: () => null,
    write: (snapshot) => {
      written = snapshot;
    },
    now: () => 456,
  });

  assert.deepEqual(await callRefresh("POST"), {
    status: 200,
    body: { status: "ready", items: [item()], fetchedAt: 456 },
  });
  assert.deepEqual(written, {
    version: 1,
    builtAt: 456,
    projects: { pa: { items: [item()], fetchedAt: 456 } },
  });
});

test("a refresh no provider answered is a failure, not an empty inventory", async () => {
  setPullRequestInventorySyncOperationsForTests({
    build: async () => ({
      items: [],
      projectIds: ["pa"],
      failedProjectIds: ["pa"],
    }),
    read: () => null,
    write: () => {
      throw new Error("must not write");
    },
    now: () => 456,
  });

  const answer = await callRefresh("POST");
  assert.equal(answer.status, 500);
  assert.match(
    (answer.body as { error: string }).error,
    /No pull request provider answered/,
  );
});

test("refresh is POST only", async () => {
  assert.equal((await callRefresh("GET")).status, 405);
});

test("the conversation route refuses an incomplete identity before any provider read", async () => {
  let status = 0;
  const res = {
    writeHead(next: number) {
      status = next;
      return this;
    },
    end() {
      return this;
    },
  } as unknown as ServerResponse;
  await handlePullRequestApi(
    { method: "GET" } as IncomingMessage,
    res,
    new URL(
      "http://localhost/api/pull-requests/conversation?projectId=pa&provider=github&number=7",
    ),
    () => ({ "content-type": "application/json" }),
  );
  assert.equal(status, 400);
});

// `mergeRequestId` ends up in a provider URL path segment, so anything but an
// opaque id is refused at the edge, before any provider read.
test("the check route refuses a malformed mergeRequestId before any provider read", async () => {
  const { Readable } = await import("node:stream");
  for (const mergeRequestId of ["../stacks/3", "a".repeat(129), 42, ""]) {
    let status = 0;
    let body = "";
    const req = Object.assign(
      Readable.from([
        Buffer.from(
          JSON.stringify({
            projectId: "pa",
            provider: "github",
            repositoryKey: "acme/pa",
            number: 7,
            mergeRequestId,
          }),
        ),
      ]),
      { method: "POST", headers: {} },
    ) as unknown as IncomingMessage;
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
      new URL("http://localhost/api/pull-requests/check"),
      () => ({ "content-type": "application/json" }),
    );
    assert.equal(status, 400, String(mergeRequestId));
    assert.match(body, /Invalid mergeRequestId/);
  }
  assert.equal(hoisted.provider.mock.calls.length, 0);
});
