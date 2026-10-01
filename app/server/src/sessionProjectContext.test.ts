/**
 * `resolveSessionProject`: standalone session→project links win over a
 * Task-derived project; a Task-start origin resolves the project live from the
 * originating Task when no standalone link exists.
 *
 * `buildProjectContext` (Task 309): the guidance rendered next to the evidence
 * is conditional on the evidence being there. The block is injected in a
 * session's FIRST user turn, so every char is cache-read on every provider call
 * of that session — a precedence rule for Jira links the Project does not have
 * is paid for by the whole conversation.
 *   pnpm --filter @assistant/server test src/sessionProjectContext.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "session-project-context-test-"));
process.env.ASSISTANT_CWD = tmp;

const { buildProjectContext, resolveSessionProject } =
  await import("./sessionProjectContext.ts");
const { projectStore } = await import("./db/projectStore.ts");
const { upsertProject } = await import("./projectRegistry.ts");
const { createTask, linkSessionToTask } = await import("./tasks.ts");
const { closeDb } = await import("./db/index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("resolves undefined for a session with no standalone link and no origin Task", () => {
  assert.equal(resolveSessionProject("s-none"), undefined);
});

test("resolves a Task-derived project when the session was started from that Task", () => {
  const task = createTask({
    title: "Investigate outage",
    projectId: "acme",
    source: { createdBy: "user" },
  });
  linkSessionToTask(task.id, {
    sessionId: "s-task-only",
    origin: "task-start",
  });
  assert.equal(resolveSessionProject("s-task-only"), "acme");
});

test("a plain reference link (not task-start) does not scope the session to that Task's project", () => {
  const task = createTask({
    title: "Reference only",
    projectId: "acme-ref",
    source: { createdBy: "user" },
  });
  linkSessionToTask(task.id, {
    sessionId: "s-reference-only",
    origin: "reference",
  });
  assert.equal(resolveSessionProject("s-reference-only"), undefined);
});

const JIRA_PRECEDENCE = /Prefer listed primary\/specific Jira links/;
const ALIAS_RULE = /aliases are leads of the same kind/;
/** The rules that hold whatever the registry record contains. */
const ALWAYS = [
  /candidate discovery hints/,
  /Explicit user instructions and stronger current tool evidence override/,
  /`project_registry_read`/,
  /`project_registry_write`/,
];

test("a plain Project renders its data plus the rules that apply to it", () => {
  upsertProject({
    id: "plain-ctx",
    key: "PLAIN",
    name: "Plain Project",
    description: "No Jira, no aliases.",
    localPaths: [
      { path: "/tmp/example/projects/plain", kind: "repo", match: "prefix" },
    ],
  });
  const block = buildProjectContext("plain-ctx");

  for (const rule of ALWAYS) assert.match(block, rule);
  assert.match(block, /Plain Project/);
  assert.match(block, /No Jira, no aliases\./);
  assert.match(block, /\/tmp\/example\/projects\/plain \(repo; prefix\)/);
  // The Knowledge Base pointer is one line carrying this Project's coordinates;
  // the kb_* tool descriptions own everything else about using them.
  assert.match(block, /tag `project:plain-ctx`/);
  assert.match(block, /`pa:\/\/project\/plain-ctx`/);

  assert.doesNotMatch(block, JIRA_PRECEDENCE);
  assert.doesNotMatch(block, ALIAS_RULE);
  assert.doesNotMatch(
    block,
    /including Jira links/,
    "the override rule names Jira only for a Project that has Jira links",
  );
  assert.ok(
    Buffer.byteLength(block, "utf8") < 1000,
    `the common shape stays around the data plus its rules (got ${Buffer.byteLength(block, "utf8")} B)`,
  );
});

test("a Project WITH Jira links and aliases still gets the full precedence guidance", () => {
  upsertProject({
    id: "rich-ctx",
    key: "RICH",
    name: "Rich Project",
    aliases: ["richie"],
    jira: [
      { projectKey: "RICH", role: "primary" },
      { projectKey: "OLD", role: "historical" },
    ],
  });
  const block = buildProjectContext("rich-ctx");

  for (const rule of ALWAYS) assert.match(block, rule);
  assert.match(block, JIRA_PRECEDENCE);
  assert.match(block, ALIAS_RULE);
  assert.match(block, /override registry hints, including Jira links/);
  assert.match(block, /RICH \(role: primary\)/);
  assert.match(block, /OLD \(role: historical\)/);
});

test("an unknown project id warns and points at the Knowledge Base, nothing more", () => {
  const block = buildProjectContext("not-in-the-registry");
  assert.match(block, /not currently in the project registry/);
  assert.match(block, /tag `project:not-in-the-registry`/);
  assert.match(block, /`pa:\/\/project\/not-in-the-registry`/);
  // No registry evidence, so no guidance on weighing it: that session keeps the
  // eager Project Registry pointer (`projectRegistryPointer` stays true).
  assert.doesNotMatch(block, JIRA_PRECEDENCE);
  assert.doesNotMatch(block, /candidate discovery hints/);
  assert.ok(Buffer.byteLength(block, "utf8") < 400);
});

test("a standalone session→project link wins over the origin Task's project", () => {
  const task = createTask({
    title: "Ship feature",
    projectId: "task-project",
    source: { createdBy: "user" },
  });
  linkSessionToTask(task.id, { sessionId: "s-both", origin: "task-start" });
  projectStore.setSessionProject("s-both", "standalone-project");
  assert.equal(
    resolveSessionProject("s-both"),
    "standalone-project",
    "standalone mapping takes precedence over Task-derived project",
  );
});
