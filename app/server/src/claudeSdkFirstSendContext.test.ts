/**
 * The claude-sdk create-on-first-prompt path must build the staged
 * task/project context attachment, not just record the back-link — otherwise a
 * session started from the new-session page with a Task selected loses the chip
 * and the agent never sees the Task (regression: the branch had drifted from
 * the pi first-send and ordinary-prompt paths, which both build it).
 *
 * It also owns the AUTHORITATIVE-context regression: the attachment is built
 * after `linkTaskStart`'s `doing` nudge and carries the parent chain and latest
 * comment within a byte budget, so the session needs no Task read to start.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/claudeSdkFirstSendContext.test.ts
 */
import assert from "node:assert/strict";
import { afterAll, beforeEach, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptAttachment } from "@assistant/shared";

// Isolate CWD and DATA_DIR BEFORE importing the connection, and enable the
// claude-sdk harness so the first send runs its body.
const tmp = mkdtempSync(join(tmpdir(), "claude-sdk-first-send-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({ claudeSdk: { enabled: true } }),
);

// Capture the attachments handed to the runtime instead of driving a real turn.
const promptCalls: Array<{ text: string; attachments: PromptAttachment[] }> =
  [];
vi.mock("./session/runtimePrompt.ts", () => ({
  subscribeHarnessOpened: () => () => {},
  promptRuntimeSession: async (
    _driver: unknown,
    text: string,
    options: { attachments?: PromptAttachment[] } = {},
  ) => {
    promptCalls.push({ text, attachments: options.attachments ?? [] });
  },
}));

const { Connection } = await import("./connection.ts");
const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { createTask, readTask } = await import("./tasks.ts");
const { addTaskComment } = await import("./taskComments.ts");
const { createCredentialProfile } = await import("./credentialProfiles.ts");
const claudeProfile = createCredentialProfile({
  name: "Test Claude",
  provider: "claude",
});

function makeConnection() {
  const sent: unknown[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s)),
  };
  const conn = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs) as unknown as {
    handleFirstSend: (msg: Record<string, unknown>) => Promise<void>;
    view: unknown;
  };
  // The first prompt would otherwise create a real SDK session; the mocked
  // prompt facade never touches the returned driver, so a marker object is
  // enough, and nothing attaches to view it.
  vi.spyOn(claudeSdkStore, "acquire").mockReturnValue({
    sessionId: "c1",
    broadcastState() {},
    contextInfo: () => ({}),
  } as never);
  conn.view = () => {};
  // linkTaskStart is NOT stubbed: it owns the `doing` nudge and hands back the
  // Task the attachment is built from, so stubbing it would hide the drift these
  // tests exist to catch.
  return { conn, sent };
}

/** The Markdown body the agent actually receives for the attached Task. */
function taskContextBody(
  attachments: PromptAttachment[],
  taskId: string,
): string {
  const taskCtx = attachments.find((a) => a.role === "task-context");
  assert.ok(taskCtx, "a task-context attachment is passed to the runtime");
  assert.equal(
    taskCtx.id,
    `taskctx-${taskId}`,
    "the attachment is for the attached Task",
  );
  return Buffer.from(taskCtx.data, "base64").toString("utf8");
}

beforeEach(() => {
  promptCalls.length = 0;
});

test("claude-sdk first send builds the attached Task's context attachment", async () => {
  const task = createTask({
    title: "Fix the flux capacitor",
    description: "It leaks.",
    source: { createdBy: "user" },
  });
  const { conn } = makeConnection();

  await conn.handleFirstSend({
    harness: "claude-sdk",
    id: "c1",
    agentType: "workshop",
    text: "hello",
    attachTaskId: task.id,
    credentialProfileId: claudeProfile.id,
  });

  assert.equal(
    promptCalls.length,
    1,
    "the first prompt is driven exactly once",
  );
  assert.equal(
    sessionStore.getSkills("c1"),
    "[]",
    "the ordinary Claude creation path freezes skills before acquire/prompt",
  );
  const body = taskContextBody(promptCalls[0]?.attachments ?? [], task.id);
  assert.match(
    body,
    /Fix the flux capacitor/,
    "the attachment carries the Task title so the agent sees it",
  );
  assert.match(body, /It leaks\./, "and the description in full");
});

test("the injected status is the post-nudge stored status, not the pre-nudge one", async () => {
  const task = createTask({
    title: "Recalibrate the flux valve",
    description: "Valve drifts.",
    source: { createdBy: "user" },
  });
  assert.equal(task.status, "todo", "a fresh Task starts in todo");
  const { conn } = makeConnection();

  await conn.handleFirstSend({
    harness: "claude-sdk",
    id: "c-status",
    agentType: "workshop",
    text: "hello",
    attachTaskId: task.id,
    credentialProfileId: claudeProfile.id,
  });

  assert.equal(
    readTask(task.id)?.status,
    "doing",
    "linkTaskStart nudged the Task into doing",
  );
  assert.match(
    taskContextBody(promptCalls[0]?.attachments ?? [], task.id),
    /^- Status: doing$/m,
    "the attachment agrees with the stored status instead of saying todo",
  );
});

test("the attachment carries the parent chain, the latest comment and no re-read instruction", async () => {
  const grandparent = createTask({
    title: "Make Tasks cheap",
    description: "Grandparent body nobody needs inline.",
    source: { createdBy: "user" },
  });
  const parent = createTask({
    title: "Bound the injected context",
    description: `Parent epic body. ${"p".repeat(4_000)}`,
    parentId: grandparent.id,
    source: { createdBy: "user" },
  });
  const task = createTask({
    title: "Inject the Task authoritatively",
    description: "Own body, never clipped.",
    parentId: parent.id,
    source: { createdBy: "user" },
  });
  addTaskComment({
    taskId: task.id,
    authorKind: "agent",
    authorName: "Claude",
    body: "First event.",
  });
  addTaskComment({
    taskId: task.id,
    authorKind: "agent",
    authorName: "Claude",
    body: "Second event.",
  });
  addTaskComment({
    taskId: task.id,
    authorKind: "user",
    authorName: "Alice",
    body: `Newest event. ${"c".repeat(4_000)}`,
  });
  const { conn } = makeConnection();

  await conn.handleFirstSend({
    harness: "claude-sdk",
    id: "c-chain",
    agentType: "workshop",
    text: "hello",
    attachTaskId: task.id,
    credentialProfileId: claudeProfile.id,
  });
  const body = taskContextBody(promptCalls[0]?.attachments ?? [], task.id);

  assert.match(body, /Own body, never clipped\./, "the Task's own description");
  assert.match(
    body,
    new RegExp(
      `^- Parent: Task ${parent.id} — Bound the injected context$`,
      "m",
    ),
    "the parent title",
  );
  assert.match(
    body,
    new RegExp(
      `^- Grandparent: Task ${grandparent.id} — Make Tasks cheap$`,
      "m",
    ),
    "the grandparent title as a breadcrumb",
  );
  assert.doesNotMatch(
    body,
    /Grandparent body nobody needs inline/,
    "but never the grandparent's description",
  );
  assert.match(body, /Parent epic body\./, "the parent description head");
  assert.doesNotMatch(
    body,
    new RegExp("p".repeat(2_500)),
    "clipped rather than injected whole",
  );
  assert.match(body, /…\[truncated\]/, "using the shared truncation marker");
  assert.match(body, /Newest event\./, "the most recent comment");
  assert.doesNotMatch(body, /First event\./, "not the whole trace");
  assert.match(
    body,
    /2 older comments not shown/,
    "with a count of the comments it left out",
  );
  assert.doesNotMatch(
    body,
    /use the `task_read` tool with the id above/i,
    "and no instruction to re-read what is already inline",
  );
});

test("a huge epic parent and a huge comment stay inside the attachment budget", async () => {
  const parent = createTask({
    title: "Oversized epic",
    description: "E".repeat(20_000),
    source: { createdBy: "user" },
  });
  const task = createTask({
    title: "Child of an oversized epic",
    description: "Small own body.",
    parentId: parent.id,
    source: { createdBy: "user" },
  });
  addTaskComment({
    taskId: task.id,
    authorKind: "agent",
    authorName: "Claude",
    body: "C".repeat(20_000),
  });
  const { conn } = makeConnection();

  await conn.handleFirstSend({
    harness: "claude-sdk",
    id: "c-budget",
    agentType: "workshop",
    text: "hello",
    attachTaskId: task.id,
    credentialProfileId: claudeProfile.id,
  });
  const attachments = promptCalls[0]?.attachments ?? [];
  const body = taskContextBody(attachments, task.id);

  assert.ok(
    Buffer.byteLength(body, "utf8") <= 8_000,
    `the attachment stays within the budget (was ${Buffer.byteLength(body, "utf8")} B)`,
  );
  assert.match(body, /Small own body\./, "the Task's own description survives");
  assert.match(
    body,
    /^- Parent: Task \d+ — Oversized epic$/m,
    "the parent title survives",
  );
});

test("a Task with a huge own description keeps it in full and drops the rest with a note", async () => {
  const parent = createTask({
    title: "Parent of a long Task",
    description: "Parent body that will not fit.",
    source: { createdBy: "user" },
  });
  const own = `Own body in full. ${"o".repeat(9_000)}`;
  const task = createTask({
    title: "Very long Task",
    description: own,
    parentId: parent.id,
    source: { createdBy: "user" },
  });
  addTaskComment({
    taskId: task.id,
    authorKind: "agent",
    authorName: "Claude",
    body: "Comment body that will not fit.",
  });
  const { conn } = makeConnection();

  await conn.handleFirstSend({
    harness: "claude-sdk",
    id: "c-own-body",
    agentType: "workshop",
    text: "hello",
    attachTaskId: task.id,
    credentialProfileId: claudeProfile.id,
  });
  const body = taskContextBody(promptCalls[0]?.attachments ?? [], task.id);

  assert.ok(
    body.includes(own),
    "the Task's own description is never clipped, even past the budget",
  );
  assert.doesNotMatch(
    body,
    /Parent body that will not fit/,
    "the parent description gives way",
  );
  assert.match(
    body,
    new RegExp(
      `Parent Task ${parent.id}'s description is omitted here for size`,
    ),
    "and says so instead of pretending there was none",
  );
  assert.doesNotMatch(
    body,
    /Comment body that will not fit/,
    "the comment gives way too",
  );
  assert.match(
    body,
    /This Task has 1 comment, omitted here for size/,
    "and says so",
  );
});

test("claude-sdk first send refuses a missing credential profile before creating a session", async () => {
  const { conn, sent } = makeConnection();
  await conn.handleFirstSend({
    harness: "claude-sdk",
    id: "c2",
    agentType: "workshop",
    text: "hello",
  });
  assert.equal(promptCalls.length, 0);
  assert.ok(
    sent.some(
      (message) =>
        (message as { type?: string; message?: string }).type === "error" &&
        /select a claude credential profile/i.test(
          (message as { message?: string }).message ?? "",
        ),
    ),
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
