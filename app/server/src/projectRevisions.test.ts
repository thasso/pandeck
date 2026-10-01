import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  addAlias,
  addJiraLink,
  addLocalPath,
  archiveProject,
  deleteProject,
  notifyProjectChange,
  projectRevision,
  projectRevisionIndex,
  projectStateItems,
  removeAlias,
  removeJiraLink,
  removeLocalPath,
  reorderProjects,
  updateProject,
  upsertProject,
} from "./projectRegistry.ts";

const SRC = dirname(fileURLToPath(import.meta.url));
const suffix = Math.random().toString(36).slice(2, 9);
const parentId = `revision-parent-${suffix}`;
const childId = `revision-child-${suffix}`;

function moves(ids: string[], write: () => void): void {
  const before = ids.map(projectRevision);
  write();
  ids.forEach((id, index) =>
    assert.ok(
      projectRevision(id) > before[index]!,
      `Project ${id} changed without notify-with-touched-ids`,
    ),
  );
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
    moves([childId], () => notifyProjectChange([childId]));

    moves([childId], () => deleteProject(childId));
    assert.equal(projectRevisionIndex().get(childId)?.live, false);
    assert.equal(projectStateItems([childId])[0]?.kind, "delete");
  } finally {
    discard(childId);
    discard(parentId);
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
    "subscribeProjectChanges",
    "projectRevisionIndex",
    "projectRevisionDigest",
    "projectSummaryFor",
    "projectStateItems",
    "projectRevision",
    "validateProjectRegistry",
    "draftNewProject",
  ]);
  const covered = new Set([
    "notifyProjectChange",
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
