import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  ProjectSummary,
  ServerMessage,
  StateEvent,
} from "@assistant/shared";
import { hub } from "./hub.ts";
import {
  archiveProject,
  deleteProject,
  projectRevisionDigest,
  updateProject,
  upsertProject,
} from "./projectRegistry.ts";
import { stateTopicFor } from "./stateTopics.ts";

const settled = () => hub.flushPendingBroadcastsForTests();

const items = (ids: string[]) => stateTopicFor("projects")!.items(ids);

function lastProjectBatch(messages: ServerMessage[]): {
  events: StateEvent<ProjectSummary>[];
} {
  const batch = [...messages]
    .reverse()
    .find(
      (message) =>
        message.type === "stateEvents" && message.topic === "projects",
    );
  assert.ok(batch?.type === "stateEvents" && batch.topic === "projects");
  return { events: batch.events };
}

test("Project writes broadcast lean events and digest/items converge", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const id = `broadcast-project-${suffix}`;
  const messages: ServerMessage[] = [];
  const viewer = {
    send: (message: ServerMessage) => messages.push(message),
    wantsTopic: (topic: string) => topic === "projects",
  };
  hub.register(viewer);
  try {
    upsertProject({
      id,
      name: "Broadcast Project",
      key: `BP${suffix.slice(0, 4).toUpperCase()}`,
      description: "detail only",
      localPaths: [{ path: `/tmp/${id}`, kind: "repo" }],
      repoUrl: "ssh://example.invalid/repo.git",
    });
    await settled();
    const created = lastProjectBatch(messages);
    assert.deepEqual(
      created.events.map((event) => event.id),
      [id],
    );
    const upsert = created.events[0];
    assert.ok(upsert?.kind === "upsert");
    assert.equal(upsert.item.hasRepoPath, true);
    assert.equal(upsert.item.primaryPath, `/tmp/${id}`);
    assert.ok(!("description" in upsert.item));
    assert.ok(!("localPaths" in upsert.item));
    assert.ok(!("repoUrl" in upsert.item));
    assert.equal(
      messages.some((message) => message.type === "projectList"),
      false,
    );

    updateProject(id, { name: "Broadcast Project Renamed" });
    await settled();
    const updated = lastProjectBatch(messages);
    assert.deepEqual(
      updated.events.map((event) => event.id),
      [id],
    );
    assert.equal(updated.events[0]?.kind, "upsert");

    archiveProject(id);
    await settled();
    assert.equal(
      lastProjectBatch(messages).events[0]?.kind,
      "upsert",
      "archived Projects remain canonical members",
    );

    const digest = projectRevisionDigest();
    const entry = digest.find((candidate) => candidate.id === id);
    assert.ok(entry && entry.revision > 0);
    const recovered = items([id]);
    assert.equal(recovered[0]?.kind, "upsert");
    assert.equal(recovered[0]?.revision, entry.revision);

    deleteProject(id);
    await settled();
    assert.equal(lastProjectBatch(messages).events[0]?.kind, "delete");
    assert.equal(items([id])[0]?.kind, "delete");
  } finally {
    hub.unregister(viewer);
    try {
      deleteProject(id);
    } catch {
      // already deleted
    }
  }
});
