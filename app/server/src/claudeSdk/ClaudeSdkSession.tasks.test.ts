import { afterEach, expect, test, vi } from "vitest";
import type { AgentType } from "@assistant/shared";
import * as tasks from "../tasks.ts";
import { ClaudeSdkSession } from "./ClaudeSdkSession.ts";

const sessions: ClaudeSdkSession[] = [];
const taskIds: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) session.dispose();
  for (const id of taskIds.splice(0)) {
    if (tasks.readTask(id)) tasks.deleteTask(id);
  }
});

function makeSession(agentType: AgentType = "developer") {
  const session = new ClaudeSdkSession(`task-state-${agentType}`, {
    agentType,
    seam: () => Promise.reject(new Error("state must not open the SDK")),
  });
  sessions.push(session);
  return session;
}

function makeTask(title: string) {
  const task = tasks.createTask({ title, source: { createdBy: "user" } });
  taskIds.push(task.id);
  return task;
}

test.each<AgentType>(["developer", "workshop", "assistant"])(
  "%s state includes the origin and referenced Tasks, with fresh summaries",
  (agentType) => {
    const session = makeSession(agentType);
    const origin = makeTask("Started from this Task");
    const related = makeTask("Referenced Task");
    makeTask("Unrelated Task");

    expect(session.state()).toMatchObject({
      tasks: [],
      relatedGlobalTasks: [],
    });
    expect(session.state()).not.toHaveProperty("originTask");

    tasks.linkSessionToTask(origin.id, {
      sessionId: session.id,
      origin: "task-start",
    });
    tasks.linkSessionToTask(related.id, {
      sessionId: session.id,
      origin: "reference",
    });
    const state = session.state();
    expect(state.originTask).toEqual({
      id: origin.id,
      title: origin.title,
      status: "todo",
    });
    expect(state.tasks).toEqual(
      expect.arrayContaining([
        tasks.taskSummaryOf(tasks.readTask(origin.id)!),
        tasks.taskSummaryOf(tasks.readTask(related.id)!),
      ]),
    );
    expect(state.tasks).toHaveLength(2);
    expect(state.relatedGlobalTasks).toEqual([
      tasks.taskSummaryOf(tasks.readTask(related.id)!),
    ]);
    expect(state.tasks?.every((task) => !("description" in task))).toBe(true);

    tasks.updateTask(origin.id, { title: "Renamed origin", status: "doing" });
    expect(session.state().originTask).toEqual({
      id: origin.id,
      title: "Renamed origin",
      status: "doing",
    });

    tasks.deleteTask(origin.id);
    tasks.deleteTask(related.id);
    expect(session.state()).toMatchObject({
      tasks: [],
      relatedGlobalTasks: [],
    });
    expect(session.state()).not.toHaveProperty("originTask");
  },
);

test.each([
  ["listSessionTasks", "tasks", []],
  ["listRelatedGlobalTasks", "relatedGlobalTasks", []],
  ["findOriginTask", "originTask", undefined],
] as const)(
  "a failed %s read degrades only its own state field",
  (reader, field, fallback) => {
    const session = makeSession();
    const origin = makeTask("Origin");
    const related = makeTask("Related");
    tasks.linkSessionToTask(origin.id, {
      sessionId: session.id,
      origin: "task-start",
    });
    tasks.linkSessionToTask(related.id, {
      sessionId: session.id,
      origin: "reference",
    });
    const before = session.state();
    vi.spyOn(tasks, reader).mockImplementation(() => {
      throw new Error("task store unavailable");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const state = session.state();
    expect(state[field]).toEqual(fallback);
    for (const other of [
      "tasks",
      "relatedGlobalTasks",
      "originTask",
    ] as const) {
      if (other !== field) expect(state[other]).toEqual(before[other]);
    }
    expect(warning).toHaveBeenCalled();
    expect(state.sessionId).toBe(session.id);
    expect(state.model).toEqual(before.model);
  },
);

test("a directly spawned child's state names its spawner; no other session's does", async () => {
  const { directPeerChildStore } =
    await import("../db/directPeerChildStore.ts");
  const child = makeSession("developer");
  const plain = makeSession("assistant");
  directPeerChildStore.record({
    childSessionId: child.id,
    spawnerSessionId: "claude-spawner",
    costClass: "counted",
    source: { kind: "agent", agentName: "reviewer" },
    provider: "claude-sdk",
    modelId: "opus",
    thinkingLevel: "high",
    credentialProfileId: "acct",
    createdAt: Date.now(),
  });
  expect(child.state().directSpawnedBy).toBe("claude-spawner");
  expect(plain.state()).not.toHaveProperty("directSpawnedBy");
});
