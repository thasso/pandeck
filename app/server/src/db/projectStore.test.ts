/**
 * Unit test for the SQLite projects store + the domain layer over it. Run through
 * the server Vitest suite:
 *   pnpm --filter @assistant/server test src/db/projectStore.test.ts
 *
 * Roots the data dir at an isolated temp dir, then exercises the projects store
 * (row + child tables + graph edges), the standalone session→project mapping, and
 * the projectRegistry lookup/scoring engine backed by the store.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { Project } from "./projectStore.ts";

const tmp = mkdtempSync(join(tmpdir(), "project-store-test-"));
process.env.ASSISTANT_CWD = tmp;

const { projectStore } = await import("./projectStore.ts");
const { outgoing, incoming } = await import("./links.ts");
const registry = await import("../projectRegistry.ts");

function make(
  overrides: Partial<Project> & { id: string; name: string; key: string },
): Project {
  const now = new Date().toISOString();
  return {
    description: "",
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("SQLite projects store: rows, child tables, edges, session mapping", () => {
  /* ------------------------------- put + get ------------------------------ */
  projectStore.put(
    make({
      id: "parent-proj",
      name: "Parent",
      key: "PAR",
      description: "root project",
      tags: ["alpha", "beta"],
      aliases: ["par"],
      sortOrder: 0,
    }),
  );
  projectStore.put(
    make({
      id: "child-proj",
      name: "Child",
      key: "CH",
      color: "#112233",
      localPaths: [{ path: "/tmp/child", kind: "repo", match: "prefix" }],
      repoUrl: "git@example.com:acme/child.git",
      jira: [{ projectKey: "CH", issueKey: "CH-1", role: "primary" }],
      parentId: "parent-proj",
      sortOrder: 1,
    }),
  );

  const parent = projectStore.get("parent-proj")!;
  assert.equal(parent.name, "Parent");
  assert.deepEqual(parent.tags, ["alpha", "beta"]);
  assert.deepEqual(parent.aliases, ["par"]);

  const child = projectStore.get("child-proj")!;
  assert.equal(child.color, "#112233");
  assert.equal(child.localPaths?.[0]?.path, "/tmp/child");
  assert.equal(child.repoUrl, "git@example.com:acme/child.git");
  assert.equal(child.jira?.[0]?.issueKey, "CH-1");

  /* ------------------------------- hierarchy ------------------------------ */
  assert.equal(projectStore.parentOf("child-proj"), "parent-proj");
  assert.equal(
    outgoing(projectStore.projectNode("child-proj"), "parent")[0]?.toId,
    "parent-proj",
  );

  /* --------------------------------- jira --------------------------------- */
  assert.equal(projectStore.jiraFor("child-proj")[0]?.role, "primary");
  assert.equal(
    outgoing(projectStore.projectNode("child-proj"), "jira")[0]?.toId,
    "CH-1",
  );

  /* ------------------------------- list view ------------------------------ */
  assert.deepEqual(
    projectStore
      .list()
      .map((p) => p.id)
      .sort(),
    ["child-proj", "parent-proj"],
  );

  /* ------------------------ standalone session map ------------------------ */
  projectStore.setSessionProject("sess-1", "child-proj");
  assert.equal(projectStore.sessionProjectOf("sess-1"), "child-proj");
  assert.equal(
    incoming(projectStore.projectNode("child-proj"), "in_project")[0]?.fromId,
    "sess-1",
  );
  projectStore.forgetSessionProject("sess-1");
  assert.equal(projectStore.sessionProjectOf("sess-1"), undefined);

  /* --------------------- replace-on-put for collections ------------------- */
  projectStore.put({
    ...child,
    localPaths: [{ path: "/tmp/renamed", match: "exact" }],
    jira: [],
  });
  const updated = projectStore.get("child-proj")!;
  assert.equal(updated.localPaths?.length, 1);
  assert.equal(updated.localPaths?.[0]?.path, "/tmp/renamed");
  assert.deepEqual(
    updated.jira,
    undefined,
    "jira edges cleared when set to empty",
  );

  /* ------------------------- remove sweeps edges -------------------------- */
  projectStore.setSessionProject("sess-2", "child-proj");
  projectStore.remove("child-proj");
  assert.equal(projectStore.get("child-proj"), undefined, "tombstoned");
  assert.equal(
    projectStore.parentOf("child-proj"),
    undefined,
    "parent edge swept",
  );
  assert.equal(
    projectStore.sessionProjectOf("sess-2"),
    undefined,
    "incoming session edge swept",
  );
});

test("projectRegistry domain layer: upsert, validation, lookup scoring", () => {
  const created = registry.upsertProject({
    id: "acme",
    name: "Acme",
    key: "AC",
    localPaths: [{ path: "/work/acme" }],
  });
  assert.equal(created.created, true);
  assert.equal(created.project.status, "active");

  // Duplicate key is rejected by validation.
  assert.throws(
    () => registry.upsertProject({ id: "acme2", name: "Acme Two", key: "AC" }),
    /Duplicate project key/,
  );

  // Path lookup returns the project with a match reason.
  const byPath = registry.lookupProjects({ path: "/work/acme/src" });
  assert.equal(byPath[0]?.project.id, "acme");
  assert.ok(byPath[0]?.matchedBy.some((r) => r.startsWith("localPaths")));

  // Jira lookup after adding a link.
  registry.addJiraLink("acme", { projectKey: "ACM", role: "primary" });
  const byJira = registry.lookupProjects({ jiraKey: "ACM-42" });
  assert.equal(byJira[0]?.project.id, "acme");
});
