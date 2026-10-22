/**
 * Kernel topics over the socket: `Connection` only routes. A `projects`
 * subscribe and `getStateItems` answer through the topic's kernel, and a
 * Project or Initiative subscribe that cannot read its collection answers that
 * collection's `error`, so the pane owning it renders the failure in place.
 *   pnpm --filter @assistant/server exec vitest run src/stateTopicSubscription.test.ts
 */
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { BroadcastTopic, ServerMessage } from "@assistant/shared";
import { Connection } from "./connection.ts";
import { initiativeStore } from "./db/initiativeStore.ts";
import { projectStore } from "./db/projectStore.ts";
import { deleteProject, upsertProject } from "./projectRegistry.ts";
import { stateTopicFor } from "./stateTopics.ts";

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
