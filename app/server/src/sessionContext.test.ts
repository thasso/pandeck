/**
 * The one session-context rule ([Task-554](pa://task/554)).
 *
 * Precedence used to be restated by five triggers and had drifted between them,
 * so it is asserted here ONCE rather than per caller. The pairing tests matter
 * most: the frozen prompt evidence is a claim that a matching attachment ships,
 * and a path that claimed a Project without sending one left its session with
 * neither the context nor the eager registry pointer.
 */
import { beforeEach, expect, test } from "vitest";
import type { TaskSessionRef } from "@assistant/shared";
import { projectStore } from "./db/projectStore.ts";
import { computePromptConditions } from "./promptConditions.ts";
import {
  applySessionContext,
  resolveSessionContext,
  sessionContextEvidence,
  sessionFirstTurnContext,
} from "./sessionContext.ts";
import { createTask, deleteTask, readTask, updateTask } from "./tasks.ts";

const ref = (sessionId: string): TaskSessionRef => ({
  sessionId,
  harness: "pi",
  agentType: "developer",
});

function project(id: string) {
  projectStore.put({
    id,
    name: `Project ${id}`,
    key: id.toUpperCase().slice(0, 3),
    description: "",
    status: "active",
    localPaths: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return id;
}

const decode = (data: string) => Buffer.from(data, "base64").toString("utf8");

let counter = 0;
const nextSession = () => `ctx-session-${(counter += 1)}`;

beforeEach(() => {
  project("ctx-proj");
  project("task-proj");
});

/* ------------------------------- precedence ------------------------------- */

test("a Task wins over everything else named alongside it", () => {
  const task = createTask({
    title: "T",
    projectId: "task-proj",
    source: { createdBy: "user" },
  });

  const resolved = resolveSessionContext({
    taskId: task.id,
    projectId: "ctx-proj",
    fileContext: "/files/tmp/notes.md",
    worktreeProjectId: "wt-proj",
  });

  // Its OWN Project too — a Task carries one, and it overrides the rest.
  expect(resolved).toEqual({
    kind: "task",
    taskId: task.id,
    projectId: "task-proj",
  });
});

test("a Task with NO Project keeps the one the session is started in", () => {
  const task = createTask({
    title: "Bare task",
    source: { createdBy: "user" },
  });

  // Dropping it would leave a developer session running in a checkout whose
  // Project it cannot see — and, for a spawn, contradict the approved card.
  expect(
    resolveSessionContext({ taskId: task.id, worktreeProjectId: "ctx-proj" }),
  ).toEqual({ kind: "task", taskId: task.id, projectId: "ctx-proj" });
  expect(
    resolveSessionContext({ taskId: task.id, projectId: "ctx-proj" }),
  ).toEqual({ kind: "task", taskId: task.id, projectId: "ctx-proj" });
  // A blank Project is "not named" here exactly as it is in the project
  // branch, so it falls through to the worktree instead of ending the chain.
  expect(
    resolveSessionContext({
      taskId: task.id,
      projectId: "   ",
      worktreeProjectId: "ctx-proj",
    }),
  ).toEqual({ kind: "task", taskId: task.id, projectId: "ctx-proj" });
});

test("a file wins over a Project but not a Task", () => {
  expect(
    resolveSessionContext({
      fileContext: "/files/tmp/notes.md",
      projectId: "ctx-proj",
    }),
  ).toEqual({ kind: "file", href: "/files/tmp/notes.md" });
});

test("a named Project beats the worktree's", () => {
  const resolved = resolveSessionContext({
    projectId: "ctx-proj",
    worktreeProjectId: "wt-proj",
  });

  // This is what lets one agent drive a cross-project epic from a worktree.
  expect(resolved).toEqual({ kind: "project", projectId: "ctx-proj" });
});

test("the worktree's Project is the fallback, and only when offered", () => {
  expect(resolveSessionContext({ worktreeProjectId: "wt-proj" })).toEqual({
    kind: "project",
    projectId: "wt-proj",
  });
  // A send into a RUNNING session passes no worktree project, so it stays bare.
  expect(resolveSessionContext({})).toEqual({ kind: "none" });
});

/* -------------------- evidence and attachments in step -------------------- */

test("a Project's evidence and its attachment come from one resolution", async () => {
  const sessionId = nextSession();
  const resolved = resolveSessionContext({ projectId: "ctx-proj" });

  const evidence = sessionContextEvidence(resolved);
  const applied = await applySessionContext(resolved, ref(sessionId));

  // The bug this guards: evidence claiming an attached Project (which drops the
  // eager registry pointer) while nothing is attached.
  expect(evidence.projectId).toBe("ctx-proj");
  expect(applied.attachments).toHaveLength(1);
  expect(applied.attachments[0]?.role).toBe("project-context");
  expect(
    computePromptConditions("developer", evidence).projectRegistryPointer,
  ).toBe(false);
});

test("no Project means no claim: the session keeps the registry pointer", () => {
  const evidence = sessionContextEvidence(resolveSessionContext({}));

  expect(evidence.projectId).toBeUndefined();
  expect(
    computePromptConditions("developer", evidence).projectRegistryPointer,
  ).toBe(true);
});

test("a Task lends its own Project to the evidence, never the worktree's", () => {
  const task = createTask({
    title: "T",
    projectId: "task-proj",
    source: { createdBy: "user" },
  });

  const evidence = sessionContextEvidence(
    resolveSessionContext({ taskId: task.id, worktreeProjectId: "ctx-proj" }),
  );

  expect(evidence.projectId).toBe("task-proj");
});

test("a file brings no Project, so the pointer stays", () => {
  const evidence = sessionContextEvidence(
    resolveSessionContext({ fileContext: "/files/tmp/notes.md" }),
  );

  expect(evidence.projectId).toBeUndefined();
  expect(
    computePromptConditions("developer", evidence).projectRegistryPointer,
  ).toBe(true);
});

/* ---------------------------------- apply --------------------------------- */

test("attaching a Task links it, nudges it to doing, and carries its body", async () => {
  const sessionId = nextSession();
  const task = createTask({
    title: "Refactor auth",
    projectId: "task-proj",
    source: { createdBy: "user" },
  });

  const applied = await applySessionContext(
    resolveSessionContext({ taskId: task.id }),
    ref(sessionId),
  );

  expect(readTask(task.id)?.status).toBe("doing");
  expect(applied.taskId).toBe(task.id);
  expect(applied.attachments[0]?.role).toBe("task-context");
  expect(decode(applied.attachments[0]!.data)).toContain("Refactor auth");
});

test("attaching a Project binds the session to it", async () => {
  const sessionId = nextSession();

  await applySessionContext(
    resolveSessionContext({ projectId: "ctx-proj" }),
    ref(sessionId),
  );

  expect(projectStore.sessionProjectOf(sessionId)).toBe("ctx-proj");
});

/* ------------------- the window between resolve and apply ----------------- */

test("a Task that MOVED Project is attached under the resolved one", async () => {
  const sessionId = nextSession();
  const task = createTask({
    title: "Moving target",
    projectId: "task-proj",
    source: { createdBy: "user" },
  });
  const resolved = resolveSessionContext({ taskId: task.id });
  const evidence = sessionContextEvidence(resolved);

  // Session creation happens between resolve and apply, and the frozen evidence
  // cannot move with the Task — so the attachment honours the claim.
  updateTask(task.id, { projectId: "ctx-proj" });
  const applied = await applySessionContext(resolved, ref(sessionId));

  expect(evidence.projectId).toBe("task-proj");
  expect(applied.projectId).toBe("task-proj");
  const body = decode(applied.attachments[0]!.data);
  expect(body).toContain("Project task-proj");
  expect(body).not.toContain("Project ctx-proj");
});

test("a Task DELETED in that window leaves the claimed Project's context", async () => {
  const sessionId = nextSession();
  const task = createTask({
    title: "Doomed",
    projectId: "ctx-proj",
    source: { createdBy: "user" },
  });
  const resolved = resolveSessionContext({ taskId: task.id });
  const evidence = sessionContextEvidence(resolved);

  deleteTask(task.id);
  const applied = await applySessionContext(resolved, ref(sessionId));

  // Silence here would be the original bug: evidence claiming a Project the
  // session never received. The Task is gone, the promise is not.
  expect(evidence.projectId).toBe("ctx-proj");
  expect(applied.attachments[0]?.role).toBe("project-context");
  expect(projectStore.sessionProjectOf(sessionId)).toBe("ctx-proj");
});

test("a Task with no Project that vanishes attaches nothing, and claimed nothing", async () => {
  const sessionId = nextSession();
  const task = createTask({ title: "Bare", source: { createdBy: "user" } });
  const resolved = resolveSessionContext({ taskId: task.id });

  deleteTask(task.id);
  const applied = await applySessionContext(resolved, ref(sessionId));

  expect(sessionContextEvidence(resolved).projectId).toBeUndefined();
  expect(applied.attachments).toEqual([]);
});

/* ----------------------------- deferred first turn ------------------------ */

test("a deferred first turn rebuilds the same Task context from the links", async () => {
  const sessionId = nextSession();
  const task = createTask({
    title: "Deferred work",
    source: { createdBy: "user" },
  });
  const applied = await applySessionContext(
    resolveSessionContext({ taskId: task.id }),
    ref(sessionId),
  );

  // No payload was carried between creation and the first turn — only the
  // durable links, which is what makes this survive a restart.
  const rebuilt = sessionFirstTurnContext(sessionId);

  expect(rebuilt.attachments.map((a) => a.role)).toEqual(
    applied.attachments.map((a) => a.role),
  );
  expect(decode(rebuilt.attachments[0]!.data)).toContain("Deferred work");
});

test("a deferred first turn rebuilds Project context too", async () => {
  const sessionId = nextSession();
  await applySessionContext(
    resolveSessionContext({ projectId: "ctx-proj" }),
    ref(sessionId),
  );

  const rebuilt = sessionFirstTurnContext(sessionId);

  expect(rebuilt.projectId).toBe("ctx-proj");
  expect(rebuilt.attachments[0]?.role).toBe("project-context");
});

test("a pinned deferred rebuild keeps the Project the evidence claimed", async () => {
  const sessionId = nextSession();
  const task = createTask({
    title: "Deferred move",
    projectId: "task-proj",
    source: { createdBy: "user" },
  });
  const resolved = resolveSessionContext({ taskId: task.id });
  const evidence = sessionContextEvidence(resolved);
  await applySessionContext(resolved, ref(sessionId), { pinProject: true });

  // The Task moves AFTER creation and before the deferred first turn — the
  // window the immediate path already survives, which the rebuild must too.
  updateTask(task.id, { projectId: "ctx-proj" });
  const rebuilt = sessionFirstTurnContext(sessionId);

  expect(evidence.projectId).toBe("task-proj");
  expect(rebuilt.projectId).toBe("task-proj");
  const body = decode(rebuilt.attachments[0]!.data);
  expect(body).toContain("Project task-proj");
  expect(body).not.toContain("Project ctx-proj");
});

test("a pinned session whose Task is deleted still rebuilds its Project", async () => {
  const sessionId = nextSession();
  const task = createTask({
    title: "Deferred doom",
    projectId: "ctx-proj",
    source: { createdBy: "user" },
  });
  await applySessionContext(
    resolveSessionContext({ taskId: task.id }),
    ref(sessionId),
    { pinProject: true },
  );

  deleteTask(task.id);
  const rebuilt = sessionFirstTurnContext(sessionId);

  expect(rebuilt.attachments[0]?.role).toBe("project-context");
  expect(rebuilt.projectId).toBe("ctx-proj");
});

test("an UNPINNED Task session still resolves its Project live", async () => {
  const sessionId = nextSession();
  const task = createTask({
    title: "Live follower",
    projectId: "task-proj",
    source: { createdBy: "user" },
  });
  await applySessionContext(
    resolveSessionContext({ taskId: task.id }),
    ref(sessionId),
  );

  updateTask(task.id, { projectId: "ctx-proj" });

  // Immediate triggers keep today's semantics: a Task start follows its Task.
  expect(sessionFirstTurnContext(sessionId).projectId).toBe("ctx-proj");
  expect(projectStore.sessionProjectOf(sessionId)).toBeUndefined();
});

test("a session with no context rebuilds nothing", () => {
  expect(sessionFirstTurnContext(nextSession()).attachments).toEqual([]);
});
