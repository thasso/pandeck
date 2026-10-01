import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type {
  BroadcastTopic,
  ClientMessage,
  ServerMessage,
} from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "new-session-subscribe-test-"));
process.env.ASSISTANT_CWD = tmp;

const { Connection } = await import("./connection.ts");
const { validateClientMessage } = await import("./validateClientMessage.ts");
const projectRegistry = await import("./projectRegistry.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function makeConnection() {
  const sent: ServerMessage[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (source: string) => sent.push(JSON.parse(source) as ServerMessage),
  };
  const connection = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs);
  return { connection, sent };
}

async function settleAsyncLists(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("a warm Task resubscribe answers with the live digest, not the snapshot", async () => {
  const { createTask, deleteTask } = await import("./tasks.ts");
  const task = createTask({
    title: "Warm digest",
    source: { createdBy: "user" },
  });
  const { connection, sent } = makeConnection();
  const subscribe = (
    connection as unknown as {
      onSubscribe: (
        topics: BroadcastTopic[],
        digests?: BroadcastTopic[],
      ) => void;
    }
  ).onSubscribe.bind(connection);

  try {
    subscribe(["tasks"], ["tasks"]);
    const digest = sent.find((message) => message.type === "stateDigest");
    assert.ok(digest?.type === "stateDigest");
    assert.equal(digest.topic, "tasks");
    assert.ok(
      digest.entries.some(
        (entry) => entry.id === task.id && entry.revision > 0,
      ),
    );
    assert.equal(
      sent.some((message) => message.type === "taskList"),
      false,
    );

    const getStateItems = (
      connection as unknown as {
        onGetStateItems: (
          topic: "tasks",
          ids: string[],
          requestId: string,
        ) => void;
      }
    ).onGetStateItems.bind(connection);
    getStateItems("tasks", [task.id], "digest-fetch");
    const items = sent.find(
      (message) =>
        message.type === "stateItems" && message.requestId === "digest-fetch",
    );
    assert.ok(items?.type === "stateItems");
    assert.equal(items.events.length, 1);
    assert.equal(items.events[0]?.id, task.id);
    assert.equal(items.events[0]?.kind, "upsert");
  } finally {
    deleteTask(task.id);
  }
});

test("a warm Project resubscribe passes validation and the real Connection boundary", async () => {
  const id = `warm-project-${Math.random().toString(36).slice(2, 8)}`;
  const { upsertProject, deleteProject } = projectRegistry;
  upsertProject({
    id,
    name: "Warm Project",
    key: `WP${id.slice(-4).toUpperCase()}`,
  });
  const { connection, sent } = makeConnection();
  const handle = (
    connection as unknown as {
      handle: (message: ClientMessage) => Promise<void>;
    }
  ).handle.bind(connection);
  try {
    const subscribe: ClientMessage = {
      type: "subscribe",
      topics: ["projects"],
      digests: ["projects"],
    };
    assert.equal(validateClientMessage(subscribe).ok, true);
    await handle(subscribe);
    const digest = sent.find(
      (message) =>
        message.type === "stateDigest" && message.topic === "projects",
    );
    assert.ok(digest?.type === "stateDigest" && digest.topic === "projects");
    assert.ok(
      digest.entries.some((entry) => entry.id === id && entry.revision > 0),
    );
    assert.equal(
      sent.some((message) => message.type === "projectList"),
      false,
    );

    const getStateItems: ClientMessage = {
      type: "getStateItems",
      topic: "projects",
      ids: [id],
      requestId: "project-digest-fetch",
    };
    assert.equal(validateClientMessage(getStateItems).ok, true);
    await handle(getStateItems);
    const items = sent.find(
      (message) =>
        message.type === "stateItems" &&
        message.topic === "projects" &&
        message.requestId === "project-digest-fetch",
    );
    assert.ok(items?.type === "stateItems" && items.topic === "projects");
    assert.equal(items.events[0]?.kind, "upsert");
    assert.ok(
      items.events[0]?.kind === "upsert" &&
        !("description" in items.events[0].item),
    );
  } finally {
    deleteProject(id);
  }
});

test("an open new-session Task picker reads each declared domain list exactly once", async () => {
  const { connection, sent } = makeConnection();
  const subscribe = (
    connection as unknown as {
      onSubscribe: (topics: BroadcastTopic[]) => void;
    }
  ).onSubscribe.bind(connection);
  const topics: BroadcastTopic[] = ["tasks", "projects", "worktrees"];

  subscribe(topics);
  // Re-declaring topics inside one connection episode is idempotent.
  subscribe(topics);
  await settleAsyncLists();

  assert.equal(sent.filter((message) => message.type === "taskList").length, 1);
  assert.equal(
    sent.filter((message) => message.type === "projectList").length,
    1,
  );
  assert.equal(
    sent.filter((message) => message.type === "worktreeList").length,
    1,
  );
  const projects = sent.find((message) => message.type === "projectList");
  assert.equal(
    projects?.type === "projectList" && projects.list.request.includeArchived,
    true,
  );
});
