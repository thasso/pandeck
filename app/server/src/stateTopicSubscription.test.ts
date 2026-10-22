/**
 * Kernel topics over the socket: `Connection` only routes. A `projects` or
 * `tasks` subscribe and `getStateItems` answer through the topic's kernel, and
 * a Task, Project or Initiative subscribe that cannot read its collection
 * answers that collection's `error`, so the pane owning it renders the failure
 * in place.
 *   pnpm --filter @assistant/server exec vitest run src/stateTopicSubscription.test.ts
 */
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { BroadcastTopic, ServerMessage } from "@assistant/shared";
import { Connection } from "./connection.ts";
import { initiativeStore } from "./db/initiativeStore.ts";
import { projectStore } from "./db/projectStore.ts";
import { taskStore } from "./db/taskStore.ts";
import { deleteProject, upsertProject } from "./projectRegistry.ts";
import { stateTopicFor } from "./stateTopics.ts";
import { archiveTask, createTask, deleteTask } from "./tasks.ts";

interface ConnectionHandlers {
  onSubscribe(topics: BroadcastTopic[], digests?: BroadcastTopic[]): void;
  onGetStateItems(
    topic: "tasks" | "projects" | "initiatives",
    ids: string[],
    requestId: string,
  ): void;
}

function makeConnection() {
  const sent: ServerMessage[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (source: string) => sent.push(JSON.parse(source) as ServerMessage),
  };
  const connection = new (
    Connection as unknown as new (ws: unknown) => ConnectionHandlers
  )(fakeWs);
  return { connection, sent };
}

const suffix = Math.random().toString(36).slice(2, 8);

test("a projects digest subscribe and getStateItems answer through the kernel", () => {
  const live = `routes-live-${suffix}`;
  const tombstoned = `routes-tombstoned-${suffix}`;
  upsertProject({ id: live, name: "Routes live", key: "RTLIVE" });
  upsertProject({ id: tombstoned, name: "Routes gone", key: "RTGONE" });
  deleteProject(tombstoned);
  try {
    const { connection, sent } = makeConnection();
    connection.onSubscribe(["projects"], ["projects"]);
    const digest = sent.find((message) => message.type === "stateDigest");
    assert.ok(digest?.type === "stateDigest" && digest.topic === "projects");
    assert.equal(digest.seq, stateTopicFor("projects")!.seq());
    assert.ok(digest.entries.some((entry) => entry.id === live));

    connection.onGetStateItems(
      "projects",
      [live, tombstoned, `routes-unknown-${suffix}`],
      "items-1",
    );
    const answer = sent.find((message) => message.type === "stateItems");
    assert.ok(answer?.type === "stateItems" && answer.topic === "projects");
    assert.equal(answer.requestId, "items-1");
    assert.deepEqual(
      answer.events.map((event) => [event.id, event.kind]),
      [
        [live, "upsert"],
        [tombstoned, "delete"],
      ],
    );
  } finally {
    deleteProject(live);
  }
});

/** Subscribe while `fail`'s spy is in place; everything the connection sent. */
function failingSubscribe(
  topic: BroadcastTopic,
  digest: boolean,
  fail: () => { mockRestore(): void },
): ServerMessage[] {
  const spy = fail();
  try {
    const { connection, sent } = makeConnection();
    connection.onSubscribe([topic], digest ? [topic] : []);
    return sent;
  } finally {
    spy.mockRestore();
  }
}

test("a projects subscribe that cannot read answers the Project error, snapshot or digest", () => {
  const broken = () => {
    throw new Error("projects unreadable");
  };
  for (const [digest, read] of [
    [false, "list"],
    [true, "revisions"],
  ] as const) {
    const sent = failingSubscribe("projects", digest, () =>
      vi.spyOn(projectStore, read).mockImplementation(broken),
    );
    assert.deepEqual(sent, [
      {
        type: "error",
        message: "Failed to list projects: projects unreadable",
        target: { type: "project" },
      },
    ]);
  }
});

test("an initiatives subscribe that cannot read answers the Initiative error", () => {
  for (const digest of [false, true]) {
    const sent = failingSubscribe("initiatives", digest, () =>
      vi.spyOn(initiativeStore, "revisions").mockImplementation(() => {
        throw new Error("initiatives unreadable");
      }),
    );
    assert.deepEqual(sent, [
      {
        type: "error",
        message: "Failed to list Initiatives: initiatives unreadable",
        target: { type: "initiative" },
      },
    ]);
  }
});

test("a tasks subscribe answers through the kernel: digest, snapshot and items", () => {
  const make = (title: string) =>
    createTask({ title, source: { createdBy: "user" } }).id;
  const live = make("Routes live Task");
  const archived = make("Routes archived Task");
  const deleted = make("Routes deleted Task");
  archiveTask(archived);
  deleteTask(deleted);
  try {
    const digestRead = makeConnection();
    digestRead.connection.onSubscribe(["tasks"], ["tasks"]);
    const digest = digestRead.sent.find(
      (message) => message.type === "stateDigest",
    );
    assert.ok(digest?.type === "stateDigest" && digest.topic === "tasks");
    assert.equal(digest.seq, stateTopicFor("tasks")!.seq());
    assert.ok(digest.entries.some((entry) => entry.id === live));

    const snapshotRead = makeConnection();
    snapshotRead.connection.onSubscribe(["tasks"]);
    const lists = snapshotRead.sent.filter(
      (message) => message.type === "taskList",
    );
    assert.equal(lists.length, 1);
    const [list] = lists;
    assert.ok(list?.type === "taskList");
    assert.deepEqual(list.list.request, {});
    assert.ok(list.revisions.some((entry) => entry.id === live));
    assert.equal(list.seq, stateTopicFor("tasks")!.seq());

    snapshotRead.connection.onGetStateItems(
      "tasks",
      [live, archived, deleted, "999999999"],
      "task-items",
    );
    const answer = snapshotRead.sent.find(
      (message) => message.type === "stateItems",
    );
    assert.ok(answer?.type === "stateItems" && answer.topic === "tasks");
    assert.equal(answer.requestId, "task-items");
    assert.deepEqual(
      answer.events.map((event) => [event.id, event.kind]),
      [
        [live, "upsert"],
        [archived, "delete"],
        [deleted, "delete"],
      ],
    );
  } finally {
    deleteTask(live);
    deleteTask(archived);
  }
});

test("a tasks subscribe that cannot read answers the Task error, snapshot or digest", () => {
  const broken = () => {
    throw new Error("tasks unreadable");
  };
  for (const [digest, read] of [
    [false, "list"],
    [true, "revisions"],
  ] as const) {
    const sent = failingSubscribe("tasks", digest, () =>
      vi.spyOn(taskStore, read).mockImplementation(broken),
    );
    assert.deepEqual(sent, [
      {
        type: "error",
        message: "Failed to list tasks: tasks unreadable",
        target: { type: "task" },
      },
    ]);
  }
});
