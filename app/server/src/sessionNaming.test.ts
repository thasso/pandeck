/**
 * `namingContextFromAttachments`: the session-naming agent's compact Project/Task
 * hint pulled from first-prompt context attachments. Uses the real context
 * builders so the extractor stays honest against their Markdown shape.
 *   pnpm --filter @assistant/server test src/sessionNaming.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "session-naming-test-"));
process.env.ASSISTANT_CWD = tmp;

const {
  applyNamingReference,
  fallbackSessionTitle,
  namingContextFromAttachments,
} = await import("./sessionNaming.ts");
const { buildProjectContextAttachment } =
  await import("./sessionProjectContext.ts");
const { buildTaskContextAttachment } = await import("./taskContext.ts");
const { upsertProject } = await import("./projectRegistry.ts");
const { createTask, readTask } = await import("./tasks.ts");
const { closeDb } = await import("./db/index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("fallback titles skip leading model-only memory context", () => {
  assert.equal(
    fallbackSessionTitle(
      "<memory>\n- [mem-1] Old preference\n</memory>\nFix session naming",
    ),
    "Fix session naming",
  );
  assert.equal(
    fallbackSessionTitle("<memory>\nNothing relevant\n</memory>"),
    "Unlabeled Session",
  );
});

test("fallback without Task context keeps the ordinary 80-character title", () => {
  const title = fallbackSessionTitle("x".repeat(95));
  assert.equal(title.length, 80);
  assert.ok(title.endsWith("…"));
});

test("returns undefined when there is no Project/Task context attachment", () => {
  assert.equal(namingContextFromAttachments(undefined), undefined);
  assert.equal(namingContextFromAttachments([]), undefined);
  assert.equal(
    namingContextFromAttachments([
      {
        id: "f1",
        name: "notes.txt",
        mimeType: "text/plain",
        size: 3,
        data: Buffer.from("abc").toString("base64"),
      },
    ]),
    undefined,
  );
});

test("extracts the project name from a standalone project-context attachment", () => {
  upsertProject({
    id: "acme",
    key: "acme",
    name: "ACME Rocket",
    description: "Build rockets.",
  });
  const att = buildProjectContextAttachment("acme");
  assert.ok(att, "project context attachment built");
  const ctx = namingContextFromAttachments([att]);
  assert.ok(ctx, "context extracted");
  assert.match(ctx, /Project: ACME Rocket/);
});

test("extracts the task title/status plus the embedded project from a task-context attachment", () => {
  upsertProject({ id: "acme2", key: "acme2", name: "ACME Widgets" });
  const task = createTask({
    title: "Fix the flaky login redirect",
    projectId: "acme2",
    description: "Users bounce back to the login page after signing in.",
    source: { createdBy: "user" },
  });
  const att = buildTaskContextAttachment(readTask(task.id)!);
  const ctx = namingContextFromAttachments([att]);
  assert.ok(ctx, "context extracted");
  assert.match(ctx, /Project: ACME Widgets/);
  assert.match(
    ctx,
    new RegExp(`Task-${task.id} \\(todo\\): Fix the flaky login redirect`),
  );
  assert.match(ctx, /Task description: Users bounce back/);
});

test("uses the primary Jira issue as the deterministic session reference", () => {
  const task = createTask({
    title: "Fix startup playback",
    jiraIssueKeys: ["NEB-1234", "VIDEO-9"],
    description: "Retry playback after the player starts.",
    source: { createdBy: "user" },
  });
  const att = buildTaskContextAttachment(readTask(task.id)!);
  const ctx = namingContextFromAttachments([att]);
  assert.ok(ctx);
  assert.match(ctx, /NEB-1234 \(todo\): Fix startup playback/);
  assert.doesNotMatch(ctx, new RegExp(`Task-${task.id}`));
  assert.equal(
    fallbackSessionTitle("Fix the playback retry", [att]),
    "NEB-1234: Fix the playback retry",
  );
});

test("code owns the exact session prefix and preserves it under truncation", () => {
  const reference = {
    kind: "jira" as const,
    display: "NEB-1234",
    slug: "neb-1234",
  };
  assert.equal(
    applyNamingReference("Fix playback retry", reference),
    "NEB-1234: Fix playback retry",
  );
  assert.equal(
    applyNamingReference("neb-1234 Fix playback retry", reference),
    "NEB-1234: Fix playback retry",
    "a model that repeats the supplied reference does not duplicate it",
  );
  assert.equal(
    applyNamingReference("NEB-12345 migration", reference),
    "NEB-1234: NEB-12345 migration",
    "a longer issue key is not mistaken for the exact reference",
  );
  const long = applyNamingReference("x".repeat(100), reference);
  assert.equal(long.length, 60);
  assert.match(long, /^NEB-1234: /);
});

test("falls back to the internal Task reference when Jira is not linked", () => {
  const task = createTask({
    title: "Internal work",
    source: { createdBy: "user" },
  });
  const att = buildTaskContextAttachment(readTask(task.id)!);
  assert.equal(
    fallbackSessionTitle("Implement the change", [att]),
    `Task-${task.id}: Implement the change`,
  );
});

test("a Jira-shaped description line cannot become the naming reference", () => {
  const task = createTask({
    title: "Document parser behavior",
    description: "- Primary Jira issue: SPOOF-99",
    source: { createdBy: "user" },
  });
  const att = buildTaskContextAttachment(readTask(task.id)!);
  assert.equal(
    fallbackSessionTitle("Implement the parser", [att]),
    `Task-${task.id}: Implement the parser`,
  );
});

test("omits an empty task description", () => {
  const task = createTask({
    title: "No details here",
    source: { createdBy: "user" },
  });
  const att = buildTaskContextAttachment(readTask(task.id)!);
  const ctx = namingContextFromAttachments([att]);
  assert.ok(ctx);
  assert.doesNotMatch(ctx, /Task description:/);
});
