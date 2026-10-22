import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import type { BroadcastTopic } from "@assistant/shared";
import { setStateChangeSink, withChangeSet } from "./db/changeSet.ts";
import { getDb } from "./db/index.ts";
import { projectStore } from "./db/projectStore.ts";
import {
  addAlias,
  addJiraLink,
  addLocalPath,
  archiveProject,
  deleteProject,
  getProject,
  projectRevision,
  projectStateTopic,
  removeAlias,
  removeJiraLink,
  removeLocalPath,
  reorderProjects,
  updateProject,
  upsertProject,
} from "./projectRegistry.ts";
import { stateTopicFor } from "./stateTopics.ts";
import {
  createTask,
  readTask,
  subscribeTaskChanges,
  taskRevision,
} from "./tasks.ts";

const SRC = dirname(fileURLToPath(import.meta.url));
const suffix = Math.random().toString(36).slice(2, 9);
const parentId = `revision-parent-${suffix}`;
const childId = `revision-child-${suffix}`;

/**
 * Run `write` with a recording change-set sink, which also appends each
 * reported topic to `log`. A report made inside a transaction fails.
 */
function recording<T>(
  write: () => T,
  log: string[] = [],
): { value: T; reports: Array<[BroadcastTopic, readonly string[]]> } {
  const reports: Array<[BroadcastTopic, readonly string[]]> = [];
  setStateChangeSink((topic, ids) => {
    assert.equal(getDb().isTransaction, false, "reported before COMMIT");
    reports.push([topic, ids]);
    log.push(topic);
  });
  try {
    return { value: write(), reports };
  } finally {
    setStateChangeSink(undefined);
  }
}

/** `write` moves every touched revision and reports exactly `reported` once. */
function moves(ids: string[], write: () => void, reported = ids): void {
  const before = ids.map(projectRevision);
  const { reports } = recording(write);
  ids.forEach((id, index) =>
    assert.ok(
      projectRevision(id) > before[index]!,
      `Project ${id} changed without notify-with-touched-ids`,
    ),
  );
  assert.deepEqual(reports, [["projects", reported]]);
}

function discard(id: string): void {
  try {
    deleteProject(id);
  } catch {
    // already removed
  }
}

test("every public Project write bumps every touched revision", () => {
  try {
    upsertProject({
      id: parentId,
      name: "Revision Parent",
      key: `RP${suffix.slice(0, 4).toUpperCase()}`,
      localPaths: [{ path: `/tmp/${parentId}`, kind: "workspace" }],
    });
    upsertProject({
      id: childId,
      name: "Revision Child",
      key: `RC${suffix.slice(0, 4).toUpperCase()}`,
      parentId,
    });
    assert.ok(projectRevision(parentId) > 0);
    assert.ok(projectRevision(childId) > 0);

    moves([childId], () => updateProject(childId, { description: "updated" }));
    moves([childId], () =>
      addLocalPath(childId, { path: `/tmp/${childId}`, kind: "repo" }),
    );
    moves([childId], () => removeLocalPath(childId, `/tmp/${childId}`));
    moves([childId], () =>
      addJiraLink(childId, { projectKey: "REV", role: "related" }),
    );
    moves([childId], () => removeJiraLink(childId, "REV"));
    moves([childId], () => addAlias(childId, "revision alias"));
    moves([childId], () => removeAlias(childId, "revision alias"));
    moves([childId], () => archiveProject(childId));
    moves([parentId, childId], () =>
      reorderProjects(
        [parentId, childId],
        [
          { id: parentId, parentId: null },
          { id: childId, parentId },
        ],
      ),
    );

    moves([childId], () => deleteProject(childId));
    assert.equal(
      projectStateTopic.revisions([childId]).get(childId)?.live,
      false,
    );
    assert.equal(
      stateTopicFor("projects")!.items([childId])[0]?.kind,
      "delete",
    );
  } finally {
    discard(childId);
    discard(parentId);
  }
});

let fixtureSerial = 0;

/** A fresh Project of this file's run, with a unique id and key. */
function fixture(
  name: string,
  extra: Parameters<typeof upsertProject>[0] = {},
) {
  fixtureSerial += 1;
  const id = `revision-${name}-${suffix}-${fixtureSerial}`;
  upsertProject({
    id,
    name: `Revision ${name} ${fixtureSerial}`,
    key: `K${suffix.slice(0, 4).toUpperCase()}${fixtureSerial}`,
    ...extra,
  });
  return id;
}

function taskIn(projectId: string): string {
  return createTask({
    title: `Task in ${projectId}`,
    source: { createdBy: "user" },
    projectId,
  }).id;
}

test("a Project delete stamps its child Projects in its change set, then reports its Tasks", () => {
  const parent = fixture("delete-parent");
  const child = fixture("delete-child", { parentId: parent });
  const held = taskIn(parent);
  const before = [parent, child].map(projectRevision);
  const taskBefore = taskRevision(held)!;
  const order: string[] = [];
  const stop = subscribeTaskChanges((ids) => {
    if (ids.includes(held)) order.push("tasks");
  });
  try {
    const { reports } = recording(() => deleteProject(parent), order);
    assert.deepEqual(reports, [["projects", [parent, child]]]);
  } finally {
    stop();
    discard(child);
  }
  assert.ok(projectRevision(parent) > before[0]!);
  assert.ok(projectRevision(child) > before[1]!);
  assert.equal(getProject(child)?.parentId, undefined);
  assert.ok(taskRevision(held)! > taskBefore);
  assert.equal(readTask(held)?.projectId, undefined);
  assert.deepEqual(order, ["projects", "tasks"]);
});

test("a refused reorder moves no revision and reports nothing", () => {
  const id = fixture("refused-reorder");
  try {
    const before = projectRevision(id);
    const { reports } = recording(() =>
      assert.throws(
        () =>
          reorderProjects([id], [{ id, parentId: `missing-parent-${suffix}` }]),
        /Parent Project not found/,
      ),
    );
    assert.equal(projectRevision(id), before);
    assert.deepEqual(reports, []);
  } finally {
    discard(id);
  }
});

test("projectStore.put joins an open change set", () => {
  const id = fixture("joined-put");
  try {
    const project = projectStore.get(id)!;
    withChangeSet(() =>
      projectStore.put({ ...project, description: "joined" }),
    );
    assert.equal(projectStore.get(id)?.description, "joined");
  } finally {
    discard(id);
  }
});

/** What a failed write must leave exactly as it was: the row, paths and edges. */
const committed = (id: string) => projectStore.get(id);

test("a reorder that fails mid-write commits nothing and reports nothing", () => {
  const first = fixture("reorder-first");
  const second = fixture("reorder-second");
  const before = [first, second].map(committed);
  const original = projectStore.setSortOrder;
  let calls = 0;
  const spy = vi
    .spyOn(projectStore, "setSortOrder")
    .mockImplementation((id, sortOrder) => {
      calls += 1;
      if (calls === 2) throw new Error("reorder failed");
      original(id, sortOrder);
    });
  try {
    const { reports } = recording(() =>
      assert.throws(
        () =>
          reorderProjects(
            [second, first],
            [
              { id: second, parentId: null },
              { id: first, parentId: second },
            ],
          ),
        /reorder failed/,
      ),
    );
    assert.equal(calls, 2, "the first placement wrote before the failure");
    assert.deepEqual([first, second].map(committed), before);
    assert.deepEqual(reports, []);
  } finally {
    spy.mockRestore();
    discard(first);
    discard(second);
  }
});

test("a delete that fails after its sweep restores the Project, its children and its Tasks", () => {
  const parent = fixture("failed-delete-parent");
  const child = fixture("failed-delete-child", { parentId: parent });
  const held = taskIn(parent);
  const before = [parent, child].map(committed);
  const taskBefore = taskRevision(held);
  const original = projectStore.remove;
  const spy = vi.spyOn(projectStore, "remove").mockImplementation((id) => {
    original(id);
    throw new Error("delete failed");
  });
  try {
    const { reports } = recording(() =>
      assert.throws(() => deleteProject(parent), /delete failed/),
    );
    assert.ok(getProject(parent), "the parent is live again");
    assert.equal(getProject(child)?.parentId, parent);
    assert.equal(readTask(held)?.projectId, parent);
    assert.deepEqual([parent, child].map(committed), before);
    assert.equal(taskRevision(held), taskBefore, "no Task notify ran");
    assert.deepEqual(reports, []);
  } finally {
    spy.mockRestore();
    discard(child);
    discard(parent);
  }
});

test("an update that fails after put leaves the row, paths and edges as they were", () => {
  const parent = fixture("failed-update-parent");
  const id = fixture("failed-update", {
    localPaths: [{ path: `/tmp/revision-before-${suffix}`, kind: "repo" }],
    jira: [{ projectKey: "BEFORE", role: "primary" }],
  });
  const before = committed(id);
  const original = projectStore.put;
  const spy = vi.spyOn(projectStore, "put").mockImplementation((project) => {
    original(project);
    throw new Error("update failed");
  });
  try {
    const { reports } = recording(() =>
      assert.throws(
        () =>
          updateProject(id, {
            name: "Revision failed update renamed",
            localPaths: [
              { path: `/tmp/revision-after-${suffix}`, kind: "repo" },
            ],
            parentId: parent,
            jira: [{ projectKey: "AFTER", role: "primary" }],
          }),
        /update failed/,
      ),
    );
    assert.deepEqual(committed(id), before);
    assert.deepEqual(reports, []);
  } finally {
    spy.mockRestore();
    discard(id);
    discard(parent);
  }
});

test("every exported Project registry write is covered by the revision test", () => {
  const source = readFileSync(join(SRC, "projectRegistry.ts"), "utf8");
  const exported = [...source.matchAll(/^export function (\w+)/gm)].map(
    (match) => match[1]!,
  );
  const readsOnly = new Set([
    "readProjectRegistry",
    "listProjects",
    "getProject",
    "lookupProjects",
    "projectRevisionDigest",
    "projectListMessage",
    "projectRevision",
    "validateProjectRegistry",
    "draftNewProject",
  ]);
  const covered = new Set([
    "upsertProject",
    "updateProject",
    "addLocalPath",
    "removeLocalPath",
    "addJiraLink",
    "removeJiraLink",
    "addAlias",
    "removeAlias",
    "archiveProject",
    "deleteProject",
    "reorderProjects",
  ]);
  assert.deepEqual(
    exported.filter((name) => !readsOnly.has(name) && !covered.has(name)),
    [],
    "a new Project write must prove it reports touched ids",
  );
});

test("Project mutation handlers contain no full-registry recovery path", () => {
  const source = readFileSync(join(SRC, "connection.ts"), "utf8");
  const mutationStart = source.indexOf("private onSaveProject");
  const mutationEnd = source.indexOf("private async onListWorktrees");
  const handlers = source.slice(mutationStart, mutationEnd);
  assert.ok(mutationStart >= 0 && mutationEnd > mutationStart);
  assert.doesNotMatch(handlers, /broadcastProjectList|this\.onListProjects/);
  assert.doesNotMatch(handlers, /type:\s*["']projectList["']/);

  const cloneStart = source.indexOf("private async onProvisionProjectRepo");
  const cloneEnd = source.indexOf("private async onRemoveProjectRepo");
  assert.doesNotMatch(
    source.slice(cloneStart, cloneEnd),
    /onListProjects|projectList/,
  );
});
