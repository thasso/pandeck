// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import type {
  CredentialProfileSummary,
  ModelOption,
  ProjectListResponse,
  SessionListItem,
  TaskListResponse,
  WorktreeRecord,
} from "@assistant/shared";
import { createInitialState } from "./hooks/useAssistant.ts";

beforeEach(() => window.localStorage.clear());

it("hydrates every boot-critical new-session source from the app-shell cache", () => {
  const defaults = createInitialState();
  const profile: CredentialProfileSummary = {
    id: "claude-work",
    name: "Claude work",
    provider: "claude",
    enabled: true,
    status: "ready",
    createdAt: 1,
    updatedAt: 1,
  };
  const model: ModelOption = {
    provider: "claude-sdk",
    id: "sonnet",
    name: "Sonnet",
    reasoning: true,
    supportedThinkingLevels: ["low"],
    contextWindow: 200_000,
  };
  const projectList: ProjectListResponse = {
    request: { includeArchived: true },
    projects: [],
    updatedAt: 1,
  };
  const worktrees: WorktreeRecord[] = [];
  window.localStorage.setItem(
    "assistant.appShellCache.v1",
    JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      models: [model],
      agents: [],
      sessions: [],
      settings: defaults.settings,
      slashCommands: [],
      taskList: null,
      projectList,
      worktrees,
      credentialProfileProjection: {
        profiles: [profile],
        modelsByProfile: { [profile.id]: [model] },
      },
    }),
  );

  const hydrated = createInitialState();
  expect(hydrated.hydrationSource).toBe("cache");
  expect(hydrated.projectList).toEqual(projectList);
  expect(hydrated.worktrees).toEqual(worktrees);
  // Cached rows paint, but they are still due for this connection's
  // subscription answer or one-off read.
  expect(hydrated.projectListFresh).toBe(false);
  expect(hydrated.worktreesFresh).toBe(false);
  expect(hydrated.credentialProfileProjection).toEqual({
    profiles: [profile],
    modelsByProfile: { [profile.id]: [model] },
  });
});

it("hydrates settled Task objects with their revision sidecar for a warm digest", () => {
  const defaults = createInitialState();
  const taskList: TaskListResponse = {
    request: {},
    items: [
      {
        id: "413",
        title: "Warm task",
        status: "doing",
        source: { createdBy: "user" },
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    updatedAt: 2,
  };
  window.localStorage.setItem(
    "assistant.appShellCache.v1",
    JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      models: [],
      agents: [],
      sessions: [],
      settings: defaults.settings,
      slashCommands: [],
      taskList,
      taskRevisions: { "413": 27 },
    }),
  );

  const hydrated = createInitialState();
  expect(hydrated.taskList).toEqual(taskList);
  expect(hydrated.stateEventRevisions.tasks).toEqual({ "413": 27 });
  expect(hydrated.taskListFresh).toBe(false);
});

it("never paints a cached Personal Assistant singleton in the session list", () => {
  const defaults = createInitialState();
  const singleton: SessionListItem = {
    id: "pa-singleton",
    harness: "claude-sdk",
    agentType: "personal-assistant",
    title: "Personal Assistant",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 7,
  };
  const ordinary: SessionListItem = {
    ...singleton,
    id: "chat",
    agentType: "assistant",
  };
  window.localStorage.setItem(
    "assistant.appShellCache.v1",
    JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      models: [],
      agents: [],
      // A row an older build cached before the server stopped sending it.
      sessions: [singleton, ordinary],
      settings: defaults.settings,
      slashCommands: [],
      taskList: null,
      projectList: null,
      worktrees: [],
    }),
  );

  const hydrated = createInitialState();
  expect(hydrated.hydrationSource).toBe("cache");
  expect(hydrated.sessions.map((session) => session.id)).toEqual([ordinary.id]);
});

it("drops who still owes a reply from cached rows, like every live fact", () => {
  const defaults = createInitialState();
  const owed: SessionListItem = {
    id: "coordinator",
    harness: "pi",
    agentType: "assistant",
    title: "Coordinator",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 3,
    awaitingRepliesFrom: ["reviewer"],
  };
  window.localStorage.setItem(
    "assistant.appShellCache.v1",
    JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      models: [],
      agents: [],
      // Cached while the reviewer was still working: restored alone, the
      // debt would read as a stalled tree until the first list arrives.
      sessions: [owed],
      settings: defaults.settings,
      slashCommands: [],
      taskList: null,
      projectList: null,
      worktrees: [],
    }),
  );

  const hydrated = createInitialState();
  expect(hydrated.sessions[0]?.awaitingRepliesFrom).toBe(undefined);
});
