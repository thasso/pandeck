import { applyPatch } from "@assistant/shared";
import type {
  ApprovalCard,
  ContextInfo,
  Patch,
  ProjectRecord,
  PullRequestCard,
  ServerMessage,
  SessionListItem,
  SessionState,
  SkillLibraryList,
  TaskListResponse,
} from "@assistant/shared";
import { describe, expect, it } from "vitest";
import { entriesToDisplayMessages } from "@assistant/shared/display";
import type { ClientTimelineEntry } from "@assistant/shared/runtime";
import { dataOf, ready } from "../lib/loadState.ts";
import {
  createInitialState,
  projectSaveOperation,
  reduceAssistantState,
  type ClientPullRequestCard,
  type UIState,
} from "./useAssistant.ts";

const session = (patch: Partial<SessionState> = {}): SessionState => ({
  sessionId: "s1",
  harness: "pi",
  agentType: "assistant",
  thinkingLevel: "off",
  ...patch,
});

const row = (patch: Partial<SessionListItem> = {}): SessionListItem => ({
  id: "s1",
  harness: "pi",
  agentType: "assistant",
  title: "Session",
  createdAt: 0,
  updatedAt: 1,
  messageCount: 0,
  ...patch,
});

const contextInfo = (sessionId = "s1"): ContextInfo => ({
  sessionId,
  updatedAt: 1,
  messageCounts: {
    user: 0,
    assistant: 0,
    toolCalls: 0,
    toolResults: 0,
    total: 0,
  },
  tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
});

function apply(msg: ServerMessage, state = createInitialState()) {
  return reduceAssistantState(state, { kind: "server", msg });
}

describe("useAssistant message arrivals on their object", () => {
  // A failure naming a session is a CONDITION on that session and stays there.
  // Deriving it from a global message slot meant any unrelated message wiped it
  // off that session's composer while it was still true.
  it("moves a session failure onto the session, where it survives other traffic", () => {
    let state = apply({
      type: "error",
      message: "Failed to fork session: no anchor",
      target: { type: "session", id: "s1" },
    });
    expect(state.sessionFailures).toEqual({
      s1: "Failed to fork session: no anchor",
    });

    // Something entirely unrelated arrives. The session is still broken.
    state = apply(
      {
        type: "notice",
        severity: "warning",
        message: "That timeline block is no longer available.",
      },
      state,
    );
    expect(state.sessionFailures).toEqual({
      s1: "Failed to fork session: no anchor",
    });

    // A SECOND session fails. Neither may erase the other.
    state = apply(
      {
        type: "error",
        message: "Failed to rename session: session not found.",
        target: { type: "session", id: "s2" },
      },
      state,
    );
    expect(state.sessionFailures).toEqual({
      s1: "Failed to fork session: no anchor",
      s2: "Failed to rename session: session not found.",
    });

    // Retirement names its session, and leaves the other alone.
    state = reduceAssistantState(state, {
      kind: "clearChatError",
      sessionId: "s2",
    });
    expect(state.sessionFailures).toEqual({
      s1: "Failed to fork session: no anchor",
    });
  });

  it("keeps a session the server cannot open until it opens or a new connection says otherwise", () => {
    let state = apply({
      type: "error",
      message: "This session cannot be opened: EIO",
      target: { type: "session", id: "s1" },
      sessionUnavailable: true,
    });
    expect(state.unopenableSessions).toEqual({
      s1: "This session cannot be opened: EIO",
    });
    // An ordinary session failure is not "cannot be opened".
    state = apply(
      {
        type: "error",
        message: "Failed to rename session.",
        target: { type: "session", id: "s2" },
      },
      state,
    );
    expect(state.unopenableSessions).toEqual({
      s1: "This session cannot be opened: EIO",
    });
    // Dismissing the note leaves the session unopenable.
    state = reduceAssistantState(state, {
      kind: "clearChatError",
      sessionId: "s1",
    });
    expect(state.unopenableSessions).toHaveProperty("s1");
    // It opened after all.
    state = apply(
      {
        type: "snapshot",
        state: session(),
        contextInfo: contextInfo(),
        snapshot: {
          sessionId: "s1",
          runState: "idle",
          timeline: [],
          timelineStart: 0,
          totalEntryCount: 0,
          streaming: [],
        },
      },
      state,
    );
    expect(state.unopenableSessions).toEqual({});
  });

  const unavailable = (id: string): ServerMessage => ({
    type: "error",
    message: `This session cannot be opened: EACCES (${id})`,
    target: { type: "session", id },
    sessionUnavailable: true,
  });
  const snapshotOf = (id: string): ServerMessage => ({
    type: "snapshot",
    state: session({ sessionId: id }),
    contextInfo: contextInfo(id),
    snapshot: {
      sessionId: id,
      runState: "idle",
      timeline: [],
      timelineStart: 0,
      totalEntryCount: 0,
      streaming: [],
    },
  });
  const readyMessage: ServerMessage = {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: null,
    models: [],
    agents: [],
    sessions: [],
    settings: {},
    speechToText: {
      configured: false,
      availableModelIds: [],
      maxUtteranceSeconds: 120,
    },
    slashCommands: [],
    contextInfo: null,
  };

  // Recovery WITHOUT a dismissal first: a stale "cannot be opened" note must
  // not stand over the chat that did open.
  it("retires the unavailable note when that session opens after all", () => {
    let state = apply(unavailable("s1"));
    state = apply(
      {
        type: "error",
        message: "Failed to rename session.",
        target: { type: "session", id: "s2" },
      },
      state,
    );
    expect(state.sessionFailures).toHaveProperty("s1");

    state = apply(snapshotOf("s1"), state);
    expect(state.unopenableSessions).toEqual({});
    expect(state.sessionFailures).toEqual({
      s2: "Failed to rename session.",
    });
  });

  it("retires unavailable notes on a new connection, which re-reports what still holds", () => {
    let state = apply(unavailable("s1"));
    state = apply(unavailable("s3"), state);
    state = apply(
      {
        type: "error",
        message: "Failed to rename session.",
        target: { type: "session", id: "s2" },
      },
      state,
    );
    state = apply(readyMessage, state);
    expect(state.unopenableSessions).toEqual({});
    expect(state.sessionFailures).toEqual({
      s2: "Failed to rename session.",
    });
    // Still broken: the server says so again after `ready`.
    state = apply(unavailable("s3"), state);
    expect(state.unopenableSessions).toHaveProperty("s3");
    expect(state.sessionFailures).toHaveProperty("s3");
  });

  it("keeps a LATER, different failure of the same session when it opens", () => {
    let state = apply(unavailable("s1"));
    state = apply(
      {
        type: "error",
        message: "Failed to fork session: no anchor",
        target: { type: "session", id: "s1" },
      },
      state,
    );
    state = apply(snapshotOf("s1"), state);
    expect(state.unopenableSessions).toEqual({});
    expect(state.sessionFailures).toEqual({
      s1: "Failed to fork session: no anchor",
    });
  });

  // Retirement belongs to the SEND, not to its echo. An attachments-only prompt
  // produces no echo at all, and a staged first send echoes into a session that
  // does not exist yet — in both cases a retry that SUCCEEDED used to leave the
  // old note standing above the composer.
  it("retires only the session a send actually targets", () => {
    let state = apply({
      type: "error",
      message: "Failed to send prompt: connection lost",
      target: { type: "session", id: "s1" },
      // The send is named, and there is simply no echo under that name to
      // retire — which is the attachments-only case, not a reason to keep the
      // failure off the session.
      failedPromptClientRequestId: "c9",
    });
    state = apply(
      {
        type: "error",
        message: "Failed to rename session: session not found.",
        target: { type: "session", id: "s2" },
      },
      state,
    );

    state = reduceAssistantState(state, {
      kind: "clearSessionFailure",
      sessionId: "s1",
    });
    expect(state.sessionFailures).toEqual({
      s2: "Failed to rename session: session not found.",
    });

    // Naming a session with nothing wrong changes nothing, and does not even
    // produce a new state object.
    const before = state;
    expect(
      reduceAssistantState(before, {
        kind: "clearSessionFailure",
        sessionId: "nobody",
      }),
    ).toBe(before);
  });

  it("leaves a non-session or non-failure message off the session", () => {
    expect(
      apply({
        type: "notice",
        severity: "warning",
        message: "heads up",
        target: { type: "session", id: "s1" },
      }).sessionFailures,
    ).toEqual({});
    expect(
      apply({
        type: "error",
        message: "Failed to remove worktree: busy",
        target: { type: "worktree", id: "w1" },
      }).sessionFailures,
    ).toEqual({});
    expect(
      apply({ type: "error", message: "Failed to save settings" })
        .sessionFailures,
    ).toEqual({});
  });

  // A list that could not be read is a condition on the COLLECTION, and the
  // wire says which one. Recognising the sentence instead put the failure in
  // the wrong pane — or in none — as soon as anyone reworded it.
  it("puts a collection's load failure on that collection, by target", () => {
    const projects = apply({
      type: "error",
      message: "Failed to list projects: disk full",
      target: { type: "project" },
    });
    expect(projects.projectListError).toBe(
      "Failed to list projects: disk full",
    );
    expect(projects.worktreeListError).toBeNull();

    const worktrees = apply({
      type: "error",
      message: "Failed to list worktrees: git exploded",
      target: { type: "worktree" },
    });
    expect(worktrees.worktreeListError).toBe(
      "Failed to list worktrees: git exploded",
    );
    expect(worktrees.projectListError).toBeNull();

    // A failure about ONE project is not the pane's condition.
    const single = apply({
      type: "error",
      message: "Failed to save project: disk full",
      target: { type: "project", id: "p1" },
    });
    expect(single.projectListError).toBeNull();

    // And the sentence alone no longer routes anything.
    const untargeted = apply({
      type: "error",
      message: "Failed to list projects: disk full",
    });
    expect(untargeted.projectListError).toBeNull();
  });

  // Nothing about a message is kept for someone to announce later: what the
  // user is told is decided at the arrival (`lib/messageArrival.ts`). Only the
  // viewed chat's OUTCOME survives, and only for an error.
  it("keeps no global message slot behind an arrival", () => {
    const state = apply({
      type: "notice",
      severity: "info",
      message: "Reloaded 4 available models.",
    });
    expect(state.error).toBeNull();
    expect(
      apply({ type: "notice", severity: "error", message: "It broke." }).error,
    ).toBe("It broke.");
  });

  // Deleted rather than announced: the rows move in the list, which is the
  // receipt (`docs/messaging.md`). The Backlog's Undo toast IS earned, because
  // it carries an action, so the arrival is reported as a counter.
  it("confirms a project assignment with a counter", () => {
    const state = apply({ type: "taskProjectsAssigned" });
    expect(state.taskProjectsAssignedSeq).toBe(1);
  });
});

describe("useAssistant run-state reducer", () => {
  it("derives viewed-chat streaming from runtime snapshots/events without mutating SessionState", () => {
    let state = apply({
      type: "snapshot",
      state: session(),
      contextInfo: contextInfo(),
      snapshot: {
        sessionId: "s1",
        runState: "running",
        timeline: [],
        timelineStart: 0,
        totalEntryCount: 0,
        streaming: [],
      },
    });

    expect(state.runState).toBe("running");
    expect(state.streaming).toBe(true);
    expect(state.session).toEqual(session());
    expect("isStreaming" in state.session!).toBe(false);

    state = apply({ type: "state", state: session({ canSteer: true }) }, state);
    expect(state.streaming).toBe(true);
    expect(state.session).toEqual(session({ canSteer: true }));
    expect("isStreaming" in state.session!).toBe(false);

    state = apply(
      {
        type: "event",
        sessionId: "s1",
        event: { type: "runStateChanged", runState: "idle" },
      },
      state,
    );
    expect(state.runState).toBe("idle");
    expect(state.streaming).toBe(false);
    expect(state.session).toEqual(session({ canSteer: true }));
    expect("isStreaming" in state.session!).toBe(false);
  });

  it("treats session-list running metadata as sidebar-only for the viewed chat", () => {
    let state = apply({
      type: "snapshot",
      state: session(),
      contextInfo: contextInfo(),
      snapshot: {
        sessionId: "s1",
        runState: "idle",
        timeline: [],
        timelineStart: 0,
        totalEntryCount: 0,
        streaming: [],
      },
    });

    state = apply(
      { type: "sessions", sessions: [row({ isStreaming: true })] },
      state,
    );

    expect(state.sessions[0]?.isStreaming).toBe(true);
    expect(state.runState).toBe("idle");
    expect(state.streaming).toBe(false);
    expect("isStreaming" in state.session!).toBe(false);
  });
});

describe("staged session drafts", () => {
  it("retires the fork draft once the composer has taken it", () => {
    let state = apply({
      type: "forkedSession",
      state: session({ sessionId: "s2" }),
      sessions: [row({ id: "s2" })],
      contextInfo: contextInfo("s2"),
      selectedText: "the forked prompt",
    });

    const staged = state.forkDraft;
    expect(staged).toMatchObject({
      sessionId: "s2",
      text: "the forked prompt",
    });

    // A stale token (an older handoff, or a review draft the host owns) leaves
    // the live one standing.
    expect(
      reduceAssistantState(state, {
        kind: "sessionDraftConsumed",
        token: staged!.token - 1,
      }).forkDraft,
    ).toBe(staged);

    state = reduceAssistantState(state, {
      kind: "sessionDraftConsumed",
      token: staged!.token,
    });
    expect(state.forkDraft).toBeNull();
  });

  it("retires a draft-session handoff the same way", () => {
    let state = apply({
      type: "draftSession",
      state: session({ sessionId: "s3" }),
      sessions: [row({ id: "s3" })],
      contextInfo: contextInfo("s3"),
      draftText: "review this",
    });

    const token = state.forkDraft!.token;
    state = reduceAssistantState(state, {
      kind: "sessionDraftConsumed",
      token,
    });
    expect(state.forkDraft).toBeNull();
  });
});

describe("cached domain-list freshness", () => {
  it("keeps cached rows visible while requiring an answer in every socket episode", () => {
    const cachedProjects = {
      request: { includeArchived: true },
      projects: [],
      updatedAt: 1,
    };
    let state: UIState = {
      ...createInitialState(),
      projectList: cachedProjects,
      projectListFresh: false,
    };

    state = apply(
      {
        type: "projectList",
        list: cachedProjects,
        seq: 0,
        revisions: [],
      },
      state,
    );
    expect(state.projectListFresh).toBe(true);

    state = reduceAssistantState(state, { kind: "status", connected: false });
    expect(state.projectList).toBe(cachedProjects);
    expect(state.projectListFresh).toBe(false);
  });
});

describe("skills library reducer", () => {
  const list: SkillLibraryList = {
    libraryPath: "/data/skills",
    skills: [
      { name: "notes", description: "Take notes.", path: "notes/SKILL.md" },
    ],
    diagnostics: [
      {
        code: "duplicate-name",
        folder: "notes-copy",
        path: "notes-copy/SKILL.md",
        declaredName: "notes",
        error: 'Duplicate declared skill name "notes".',
      },
    ],
  };

  it("is idle until the section subscribes, then pending until the scan answers", () => {
    let state = createInitialState();
    expect(state.skillLibrary.status).toBe("idle");

    state = reduceAssistantState(state, { kind: "skillLibraryLoad" });
    expect(state.skillLibrary.status).toBe("loading");

    state = apply({ type: "skillList", list }, state);
    expect(state.skillLibrary).toEqual(ready(list));
    // Diagnostics ride along with the summaries; nothing narrows them away.
    expect(dataOf(state.skillLibrary)?.diagnostics).toHaveLength(1);
  });

  it("refreshes without blanking, and a failed rescan keeps the last good list", () => {
    let state = apply({ type: "skillList", list });

    // Reopening the section rescans the same library: the rows stay.
    state = reduceAssistantState(state, { kind: "skillLibraryLoad" });
    expect(state.skillLibrary.status).toBe("refreshing");
    expect(dataOf(state.skillLibrary)).toBe(list);

    state = apply(
      { type: "skillList", error: "Failed to read the skills library: EACCES" },
      state,
    );
    expect(state.skillLibrary.status).toBe("error");
    expect(dataOf(state.skillLibrary)).toBe(list);
  });

  it("never turns a failed first scan into an empty library", () => {
    const state = apply({
      type: "skillList",
      error: "Failed to read the skills library: EACCES",
    });

    expect(state.skillLibrary.status).toBe("error");
    expect(dataOf(state.skillLibrary)).toBeUndefined();
  });

  it("resolves an unanswered settings read as every skill off", () => {
    // The shell's `ready` settings do not carry this section, so the section
    // starts empty rather than absent: the toggle is asked a question it can
    // answer, and the answer is off.
    expect(createInitialState().settings.skills).toEqual({});
  });

  it("holds the whole toggle map the server echoed, not a merge of patches", () => {
    // The section is replaced whole on the wire, so the reducer must replace it
    // too: merging would resurrect a name the user just turned off.
    let state = reduceAssistantState(createInitialState(), {
      kind: "optimisticSettings",
      patch: { skills: { notes: "on", triage: "on" } },
    });
    expect(state.settings.skills).toEqual({ notes: "on", triage: "on" });

    state = reduceAssistantState(state, {
      kind: "optimisticSettings",
      patch: { skills: { notes: "on" } },
    });
    expect(state.settings.skills).toEqual({ notes: "on" });

    // The echo is authoritative: whatever the server persisted wins, including
    // a name it dropped while normalizing.
    state = apply(
      {
        type: "settings",
        settings: { ...state.settings, skills: { triage: "on" } },
      },
      state,
    );
    expect(state.settings.skills).toEqual({ triage: "on" });
  });

  it("records a sent toggle map without letting it reach the controls", () => {
    const state = reduceAssistantState(createInitialState(), {
      kind: "skillTogglesSent",
      requestId: "req-a",
      skills: { notes: "on" },
    });

    // The base for the next write moves; what the checkbox reads does not.
    expect(state.pendingSkillToggles).toEqual({
      requestId: "req-a",
      skills: { notes: "on" },
    });
    expect(state.settings.skills).toEqual({});
  });

  it("retires the pending base only on its OWN answer", () => {
    const sent = reduceAssistantState(createInitialState(), {
      kind: "skillTogglesSent",
      requestId: "req-a",
      skills: { notes: "on" },
    });

    // An echo names no request, so it cannot answer one: it may describe
    // settings this write is already ahead of.
    expect(
      apply(
        { type: "settings", settings: { ...sent.settings, skills: {} } },
        sent,
      ).pendingSkillToggles,
    ).toEqual({ requestId: "req-a", skills: { notes: "on" } });

    // Neither may an earlier write's answer, once a later write holds the base.
    expect(
      reduceAssistantState(sent, {
        kind: "skillTogglesAnswered",
        requestId: "req-older",
      }),
    ).toBe(sent);

    expect(
      reduceAssistantState(sent, {
        kind: "skillTogglesAnswered",
        requestId: "req-a",
      }).pendingSkillToggles,
    ).toBeNull();
  });

  it("drops the pending base when the socket goes", () => {
    const sent = reduceAssistantState(createInitialState(), {
      kind: "skillTogglesSent",
      requestId: "req-a",
      skills: { notes: "on" },
    });

    // A disconnect makes an in-flight write unknowable: the last echo is what
    // the next one may build on, never a map that may never have arrived.
    expect(
      reduceAssistantState(sent, { kind: "status", connected: false })
        .pendingSkillToggles,
    ).toBeNull();
    expect(
      reduceAssistantState(sent, { kind: "status", connected: true })
        .pendingSkillToggles,
    ).toEqual({ requestId: "req-a", skills: { notes: "on" } });
  });
});

describe("Project state-sync reducer", () => {
  it("keys settings controls independently instead of dropping sibling saves", () => {
    expect(projectSaveOperation({ repoUrl: "ssh://repo" })).toBe(
      "field:repoUrl",
    );
    expect(projectSaveOperation({ localPaths: [] })).toBe("field:localPaths");
    expect(projectSaveOperation({ color: "#ffffff" })).toBe("field:color");
    expect(projectSaveOperation({ repoUrl: "ssh://repo" })).not.toBe(
      projectSaveOperation({ localPaths: [] }),
    );
  });
  const summaryA = {
    id: "a",
    name: "Alpha",
    key: "AA",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const summaryB = {
    id: "b",
    name: "Beta",
    key: "BB",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  function projectState(): UIState {
    return {
      ...createInitialState(),
      projectList: {
        request: { includeArchived: true },
        projects: [summaryA, summaryB],
        updatedAt: 1,
      },
      stateEventRevisions: { projects: { a: 1, b: 1 } },
      projectListFresh: true,
    };
  }

  it("keeps optimistic editor input out of the authoritative detail cache", () => {
    const detail: ProjectRecord = { ...summaryA, description: "Server value" };
    const initial: UIState = {
      ...projectState(),
      projectDetails: { a: ready(detail) },
    };
    const optimistic = reduceAssistantState(initial, {
      kind: "optimisticProjectSave",
      id: "a",
      patch: { description: "Attempted value" },
      now: 2,
    });
    expect(dataOf(optimistic.projectDetails.a!)).toBe(detail);
    expect(optimistic.projectList!.projects[0]?.updatedAt).not.toBe(
      summaryA.updatedAt,
    );
  });

  it("does not let unrelated notices or errors settle keyed repo operations", () => {
    let state = reduceAssistantState(projectState(), {
      kind: "projectMutationStart",
      key: "a:clone",
    });
    state = reduceAssistantState(state, {
      kind: "projectMutationStart",
      key: "b:remove",
    });
    state = apply(
      { type: "notice", severity: "info", message: "Unrelated notice" },
      state,
    );
    expect(state.projectMutations["a:clone"]?.status).toBe("loading");
    expect(state.projectMutations["b:remove"]?.status).toBe("loading");
    state = apply({ type: "error", message: "Unrelated error" }, state);
    expect(state.projectMutations["a:clone"]?.status).toBe("loading");
    expect(state.projectMutations["b:remove"]?.status).toBe("loading");
  });

  it("changes only the touched row and makes its authoritative echo an exact no-op", () => {
    const initial = projectState();
    const beforeA = initial.projectList!.projects[0];
    const beforeB = initial.projectList!.projects[1];
    const event: ServerMessage = {
      type: "stateEvents",
      topic: "projects",
      seq: 2,
      events: [
        {
          kind: "upsert",
          id: "a",
          revision: 2,
          item: { ...summaryA, name: "Alpha renamed" },
        },
      ],
    };
    const changed = apply(event, initial);
    expect(changed.projectList!.projects[0]).not.toBe(beforeA);
    expect(changed.projectList!.projects[1]).toBe(beforeB);
    expect(apply(event, changed)).toBe(changed);
  });

  it("applies a digest by pruning deletes while retaining equal row identity", () => {
    const initial = projectState();
    const beforeB = initial.projectList!.projects[1];
    const digested = apply(
      {
        type: "stateDigest",
        topic: "projects",
        seq: 4,
        entries: [{ id: "b", revision: 1 }],
      },
      initial,
    );
    expect(digested.projectList!.projects).toEqual([summaryB]);
    expect(digested.projectList!.projects[0]).toBe(beforeB);
    expect(digested.projectListFresh).toBe(true);
  });

  it("never lets a filtered read overwrite the canonical registry slot", () => {
    const initial = projectState();
    const next = apply(
      {
        type: "projectList",
        list: {
          request: { query: "Alpha" },
          projects: [summaryA],
          updatedAt: 2,
        },
        seq: 3,
        revisions: [],
      },
      initial,
    );
    expect(next).toBe(initial);
  });

  it("keeps per-id details isolated and re-requests a stale same-id answer", () => {
    const detailA: ProjectRecord = {
      ...summaryA,
      description: "Alpha body",
    };
    const detailB: ProjectRecord = {
      ...summaryB,
      description: "Beta body",
    };
    let state: UIState = {
      ...projectState(),
      projectDetails: { a: ready(detailA), b: ready(detailB) },
      projectDetailRevisions: { a: 1, b: 1 },
      openProjectProjectionId: "b",
    };
    state = apply(
      {
        type: "stateEvents",
        topic: "projects",
        seq: 2,
        events: [
          {
            kind: "upsert",
            id: "a",
            revision: 2,
            item: { ...summaryA, updatedAt: "2026-01-02T00:00:00.000Z" },
          },
        ],
      },
      state,
    );
    expect(state.projectDetails.a?.status).toBe("refreshing");
    expect(dataOf(state.projectDetails.a!)).toBe(detailA);
    expect(state.projectDetails.b).toEqual(ready(detailB));

    state = reduceAssistantState(state, {
      kind: "projectDetailResult",
      id: "a",
      item: detailA,
      revision: 1,
    });
    expect(state.projectDetails.a?.status).toBe("refreshing");
    expect(dataOf(state.projectDetails.b!)).toBe(detailB);
  });
});

describe("useAssistant approval chronology", () => {
  const approval = (patch: Patch<ApprovalCard> = {}): ApprovalCard =>
    applyPatch(
      {
        renderKind: "approval",
        id: "appr-1",
        sessionId: "s1",
        kind: "jiraIssue",
        status: "pending",
        title: "Edit Jira",
        createdAt: Date.parse("2026-01-01T00:00:02.500Z"),
        sourceToolCallId: "call-1",
        body: { kind: "jiraIssue", items: [] },
      },
      patch,
    );

  function snapshotFor(sessionId: string): ServerMessage {
    return {
      type: "snapshot",
      state: session({ sessionId }),
      contextInfo: contextInfo(sessionId),
      snapshot: {
        sessionId,
        runState: "idle",
        timelineStart: 0,
        totalEntryCount: 4,
        streaming: [],
        timeline: [
          {
            id: "u1",
            seq: 1,
            createdAt: "2026-01-01T00:00:01.000Z",
            type: "message",
            role: "user",
            origin: { kind: "human" },
            content: [{ type: "text", text: "change it" }],
          },
          {
            id: "a1",
            seq: 2,
            createdAt: "2026-01-01T00:00:02.000Z",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "toolCall",
                toolCallId: "call-1",
                name: "jira_mutate_issue",
                input: {},
              },
            ],
          },
          {
            id: "u2",
            seq: 3,
            createdAt: "2026-01-01T00:00:03.000Z",
            type: "message",
            role: "user",
            origin: { kind: "human" },
            content: [{ type: "text", text: "later" }],
          },
        ],
      },
    };
  }

  function approvalTimelineState() {
    return apply(snapshotFor("s1"));
  }

  it("anchors an approval directly after the tool call that issued it and keeps updates in place", () => {
    let state = approvalTimelineState();
    state = apply(
      { type: "approvalUpdate", sessionId: "s1", approval: approval() },
      state,
    );
    expect(state.messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "approval-appr-1",
      "u2",
    ]);

    state = apply(
      {
        type: "approvalUpdate",
        sessionId: "s1",
        approval: approval({ status: "failed", error: "denied" }),
      },
      state,
    );
    expect(state.messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "approval-appr-1",
      "u2",
    ]);
    expect(
      state.messages
        .flatMap((message) => message.blocks)
        .find((block) => block.kind === "approval")?.approval.status,
    ).toBe("failed");
  });

  it("places legacy approvals without a tool anchor by their creation time instead of at chat bottom", () => {
    let state = approvalTimelineState();
    state = apply(
      {
        type: "approvalUpdate",
        sessionId: "s1",
        approval: approval({ sourceToolCallId: undefined }),
      },
      state,
    );
    expect(state.messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "approval-appr-1",
      "u2",
    ]);
  });

  /**
   * A reconnect re-attaches the session the browser is already reading, and the
   * store-backed cards are not in that snapshot: the server re-emits them as
   * separate messages just after it. Blanking them here would take every card
   * out of the transcript for the frames in between — an unmount that resets a
   * card's local state and blinks it on screen while its action is running.
   */
  it("keeps the cards of the session it re-attaches to, and drops another session's", () => {
    let state = approvalTimelineState();
    state = apply(
      { type: "approvalUpdate", sessionId: "s1", approval: approval() },
      state,
    );
    state = apply(
      {
        type: "pullRequestCardUpdate",
        sessionId: "s1",
        card: {
          renderKind: "pullRequest",
          id: "pr-1",
          sessionId: "s1",
          status: "open",
          createdAt: Date.parse("2026-01-01T00:00:03.000Z"),
          updatedAt: Date.parse("2026-01-01T00:00:03.000Z"),
          title: "A pull request",
          headBranch: "feature",
          baseBranch: "main",
          warnings: [],
        },
      },
      state,
    );
    expect(state.messages.map((message) => message.id)).toContain(
      "pull-request-card-pr-1",
    );

    const reattached = apply(snapshotFor("s1"), state);
    expect(reattached.approvals).toBe(state.approvals);
    expect(reattached.pullRequestCards).toBe(state.pullRequestCards);
    expect(reattached.messages.map((message) => message.id)).toEqual(
      expect.arrayContaining(["approval-appr-1", "pull-request-card-pr-1"]),
    );

    // A session SWITCH is the case the blanking exists for: another session's
    // cards are not this transcript's.
    const switched = apply(snapshotFor("s2"), state);
    expect(switched.approvals).toEqual([]);
    expect(switched.pullRequestCards).toEqual([]);
  });

  /**
   * The server sends a session's grant list on every view, empty included: a
   * grant revoked while the reader looked at another session must not survive
   * the return in the list the client kept.
   */
  it("replaces a session's grants with the list its next view carries, even an empty one", () => {
    const grant = {
      key: "github:comment",
      grantedAt: 1,
      sourceApprovalId: "appr-1",
    };
    let state = approvalTimelineState();
    state = apply(
      { type: "approvalGrants", sessionId: "s1", grants: [grant] },
      state,
    );
    expect(state.approvalGrants).toEqual({ sessionId: "s1", grants: [grant] });

    state = apply(snapshotFor("s2"), state);
    state = apply(
      { type: "approvalGrants", sessionId: "s2", grants: [] },
      state,
    );
    state = apply(snapshotFor("s1"), state);
    state = apply(
      { type: "approvalGrants", sessionId: "s1", grants: [] },
      state,
    );

    expect(state.approvalGrants).toEqual({ sessionId: "s1", grants: [] });
  });
});

describe("useAssistant pull request card reducer", () => {
  const pullRequest: PullRequestCard = {
    renderKind: "pullRequest",
    id: "pr-1",
    sessionId: "s1",
    status: "merged",
    createdAt: 1,
    updatedAt: 1,
    title: "Optimistic card actions",
    headBranch: "feature",
    baseBranch: "main",
    worktreeId: "wt-1",
    warnings: [],
    linkedTask: {
      id: "625",
      title: "Optimistic card actions",
      status: "todo",
      source: { createdBy: "user" },
      createdAt: 1,
      updatedAt: 1,
    },
  };

  const cardFrom = (state: UIState) =>
    state.pullRequestCards[0]?.blocks.find(
      (block) => block.kind === "pullRequest",
    )?.pullRequest as ClientPullRequestCard | undefined;

  it("patches the linked Task and keeps local pending across unrelated watcher echoes", () => {
    let state: UIState = { ...createInitialState(), session: session() };
    state = apply(
      { type: "pullRequestCardUpdate", sessionId: "s1", card: pullRequest },
      state,
    );
    state = reduceAssistantState(state, {
      kind: "optimisticPullRequestCardAction",
      cardId: pullRequest.id,
      action: "mark-task-done",
    });
    expect(cardFrom(state)?.pendingAction).toBe("mark-task-done");
    expect(cardFrom(state)?.linkedTask?.status).toBe("todo");
    expect(cardFrom(state)?.optimisticLinkedTask?.status).toBe("done");

    state = apply(
      {
        type: "pullRequestCardUpdate",
        sessionId: "s1",
        card: { ...pullRequest, updatedAt: 2 },
      },
      state,
    );
    expect(cardFrom(state)?.pendingAction).toBe("mark-task-done");
    expect(cardFrom(state)?.linkedTask?.status).toBe("todo");
    expect(cardFrom(state)?.optimisticLinkedTask?.status).toBe("done");

    // The steady state for any card that ever completed an action: the outcome
    // text is durable until the server DEQUEUES the next one, so a routine
    // watcher poll re-broadcasts the PREVIOUS action's message with a fresh
    // `updatedAt`. Reading that as this click's answer would drop the overlay.
    state = apply(
      {
        type: "pullRequestCardUpdate",
        sessionId: "s1",
        card: {
          ...pullRequest,
          updatedAt: 3,
          actionMessage: "Rebased onto main and force-pushed.",
        },
      },
      state,
    );
    expect(cardFrom(state)?.pendingAction).toBe("mark-task-done");
    expect(cardFrom(state)?.linkedTask?.status).toBe("todo");
    expect(cardFrom(state)?.optimisticLinkedTask?.status).toBe("done");
    expect(cardFrom(state)?.actionMessage).toBeUndefined();

    // Same for a refusal the user was retrying: the click answered it.
    state = apply(
      {
        type: "pullRequestCardUpdate",
        sessionId: "s1",
        card: {
          ...pullRequest,
          updatedAt: 4,
          actionError: "The branch is not contained in main.",
        },
      },
      state,
    );
    expect(cardFrom(state)?.pendingAction).toBe("mark-task-done");
    expect(cardFrom(state)?.actionError).toBeUndefined();
  });

  it("drops the linked-Task overlay when a card action is refused", () => {
    let state: UIState = { ...createInitialState(), session: session() };
    state = apply(
      { type: "pullRequestCardUpdate", sessionId: "s1", card: pullRequest },
      state,
    );
    state = reduceAssistantState(state, {
      kind: "optimisticPullRequestCardAction",
      cardId: pullRequest.id,
      action: "mark-task-done",
    });
    state = reduceAssistantState(state, {
      kind: "pullRequestCardActionResult",
      cardId: pullRequest.id,
      error: "The server is restarting. Try again.",
    });

    expect(cardFrom(state)?.pendingAction).toBeUndefined();
    expect(cardFrom(state)?.optimisticLinkedTask).toBeUndefined();
    expect(cardFrom(state)?.linkedTask?.status).toBe("todo");
    expect(cardFrom(state)?.actionError).toContain("restarting");
  });

  it("restores a refused linked-Task write from an equal-revision authoritative item", () => {
    const task = pullRequest.linkedTask!;
    const cardWithOverlay: ClientPullRequestCard = {
      ...pullRequest,
      linkedTask: { ...task, status: "done" },
      optimisticLinkedTask: { ...task, status: "done" },
    };
    const recovered = reduceAssistantState(
      {
        ...createInitialState(),
        taskList: {
          request: {},
          items: [{ ...task, status: "done" }],
          updatedAt: 2,
        },
        stateEventRevisions: { tasks: { [task.id]: 7 } },
        pullRequestCards: [
          {
            id: `pull-request-card-${pullRequest.id}`,
            role: "assistant",
            blocks: [{ kind: "pullRequest", pullRequest: cardWithOverlay }],
          },
        ],
      },
      {
        kind: "taskRecoveryItems",
        events: [{ kind: "upsert", id: task.id, revision: 7, item: task }],
      },
    );

    expect(recovered.taskList?.items[0]?.status).toBe("todo");
    expect(cardFrom(recovered)?.linkedTask?.status).toBe("todo");
    expect(cardFrom(recovered)?.optimisticLinkedTask).toBeUndefined();
    expect(recovered.stateEventRevisions.tasks?.[task.id]).toBe(7);
  });

  it("lets the server busy flag take over and clears a refused local action", () => {
    let state: UIState = { ...createInitialState(), session: session() };
    state = apply(
      { type: "pullRequestCardUpdate", sessionId: "s1", card: pullRequest },
      state,
    );
    state = reduceAssistantState(state, {
      kind: "optimisticPullRequestCardAction",
      cardId: pullRequest.id,
      action: "cleanup",
    });
    state = apply(
      {
        type: "pullRequestCardUpdate",
        sessionId: "s1",
        card: { ...pullRequest, busyAction: "cleanup", updatedAt: 2 },
      },
      state,
    );
    expect(cardFrom(state)?.pendingAction).toBeUndefined();
    expect(cardFrom(state)?.busyAction).toBe("cleanup");

    state = apply(
      {
        type: "pullRequestCardUpdate",
        sessionId: "s1",
        card: {
          ...pullRequest,
          actionError: "The branch is not contained in main.",
          updatedAt: 3,
        },
      },
      state,
    );
    expect(cardFrom(state)?.pendingAction).toBeUndefined();
    expect(cardFrom(state)?.actionError).toContain("not contained");
  });
});

describe("useAssistant worktree reducer", () => {
  it("removes a worktree optimistically while the server performs the filesystem operation", () => {
    const worktree = {
      id: "wt-1",
      projectId: "personal-assistant",
      mainRepoRoot: "/repo",
      path: "/repo-wt",
      branch: "topic",
      baseBranch: "main",
      baseCommit: "abc",
      status: "active" as const,
      sessionIds: [],
      taskIds: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const state: UIState = { ...createInitialState(), worktrees: [worktree] };

    const next = reduceAssistantState(state, {
      kind: "optimisticWorktreeRemove",
      worktreeId: worktree.id,
    });

    expect(next.worktrees).toEqual([]);
  });

  it("renders first-send worktree provisioning as a card above the chat and hands over to the durable one", () => {
    // The card belongs to the SEND (a failed provision produces no session at
    // all), so it is a client overlay keyed by clientRequestId — and it sits at
    // the top, where the server's durable genesis card lands too.
    let state = apply({
      type: "worktreeProvision",
      clientRequestId: "creq-1",
      provision: { state: "naming", projectId: "proj" },
    });
    expect(state.worktreeProvision).toMatchObject({
      clientRequestId: "creq-1",
      state: "naming",
    });
    expect(state.messages[0]?.blocks).toEqual([
      {
        kind: "worktreeProvision",
        provision: { state: "naming", projectId: "proj" },
      },
    ]);

    state = apply(
      {
        type: "worktreeProvision",
        clientRequestId: "creq-1",
        provision: {
          state: "failed",
          projectId: "proj",
          error: "The main checkout is on a detached HEAD",
        },
      },
      state,
    );
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.blocks[0]).toMatchObject({
      kind: "worktreeProvision",
      provision: { state: "failed" },
    });

    // `created` hands over: the durable card arrives with the session.
    state = apply(
      {
        type: "worktreeProvision",
        clientRequestId: "creq-1",
        provision: {
          state: "created",
          projectId: "proj",
          branch: "t240-card",
          worktreeId: "wt-1",
        },
      },
      state,
    );
    expect(state.worktreeProvision).toBeNull();
    expect(state.messages).toEqual([]);
  });

  it("drops a failed provisioning card when a session is viewed", () => {
    let state = apply({
      type: "worktreeProvision",
      clientRequestId: "creq-1",
      provision: { state: "failed", projectId: "proj", error: "nope" },
    });
    state = apply(
      {
        type: "snapshot",
        state: session(),
        contextInfo: contextInfo(),
        snapshot: {
          sessionId: "s1",
          timeline: [],
          timelineStart: 0,
          totalEntryCount: 0,
          streaming: [],
          runState: "idle",
        },
      },
      state,
    );
    expect(state.worktreeProvision).toBeNull();
    expect(state.messages).toEqual([]);
  });
});

describe("useAssistant task reducer", () => {
  it("replaces a stale browser-cached Task list with the authoritative subscribe snapshot", () => {
    // `ready` no longer carries the Task list: it is a subscribed topic, and the
    // snapshot arrives as the subscription's `taskList` answer on every connect.
    const stale: TaskListResponse = {
      request: {},
      items: [
        {
          id: "1",
          title: "Stale task",
          status: "todo",
          createdAt: 1,
          updatedAt: 1,
          source: { createdBy: "user" },
        },
      ],
      updatedAt: 1,
    };
    const fresh: TaskListResponse = {
      request: {},
      items: [
        {
          id: "25",
          title: "Created from Slack",
          status: "todo",
          createdAt: 2,
          updatedAt: 2,
          source: { createdBy: "user" },
        },
      ],
      updatedAt: 2,
    };
    let state: UIState = { ...createInitialState(), taskList: stale };

    state = apply(
      {
        type: "ready",
        serverBuild: { version: "0.0.0-test" },
        state: null,
        models: [],
        agents: [],
        sessions: [],
        settings: {},
        speechToText: {
          configured: false,
          availableModelIds: [],
          maxUtteranceSeconds: 120,
        },
        slashCommands: [],
        contextInfo: null,
      },
      state,
    );
    expect(state.taskList).toEqual(stale);

    const next = apply(
      {
        type: "taskList",
        list: fresh,
        seq: 0,
        revisions: [{ id: "25", revision: 4 }],
      },
      state,
    );

    expect(next.taskList).toEqual(fresh);
    expect(next.taskList?.items.some((task) => task.id === "1")).toBe(false);
  });

  it("preserves unchanged row identities across full Task snapshots", () => {
    const first: TaskListResponse = {
      request: {},
      items: [
        {
          id: "1",
          title: "Stable",
          status: "todo",
          sessionRefs: [{ sessionId: "s1", origin: "task-start" }],
          createdAt: 1,
          updatedAt: 2,
          source: { createdBy: "user" },
        },
        {
          id: "2",
          title: "Changes",
          status: "todo",
          createdAt: 1,
          updatedAt: 2,
          source: { createdBy: "user" },
        },
      ],
      updatedAt: 2,
    };
    const state: UIState = { ...createInitialState(), taskList: first };
    const echoed: TaskListResponse = JSON.parse(JSON.stringify(first));
    echoed.updatedAt = 3;

    const revisions = first.items.map((item) => ({
      id: item.id,
      revision: 1,
    }));
    const noOp = apply(
      { type: "taskList", list: echoed, seq: 0, revisions },
      state,
    );
    expect(noOp.taskList?.items[0]).toBe(first.items[0]);
    expect(noOp.taskList?.items[1]).toBe(first.items[1]);

    const changed: TaskListResponse = JSON.parse(JSON.stringify(echoed));
    changed.items[1] = {
      ...changed.items[1]!,
      title: "Changed",
      updatedAt: 3,
    };
    const next = apply(
      { type: "taskList", list: changed, seq: 0, revisions },
      noOp,
    );
    expect(next.taskList?.items[0]).toBe(first.items[0]);
    expect(next.taskList?.items[1]).not.toBe(first.items[1]);
  });

  it("diffs a Task digest against warm objects and batch-applies only changed ids", () => {
    const stable = {
      id: "1",
      title: "Stable",
      status: "todo" as const,
      createdAt: 1,
      updatedAt: 1,
      source: { createdBy: "user" as const },
    };
    const stale = { ...stable, id: "2", title: "Stale" };
    const removed = { ...stable, id: "4", title: "Removed" };
    let state: UIState = {
      ...createInitialState(),
      taskList: {
        request: {},
        items: [stable, stale, removed],
        updatedAt: 1,
      },
      stateEventRevisions: { tasks: { "1": 5, "2": 6, "4": 7 } },
    };

    state = apply(
      {
        type: "stateDigest",
        topic: "tasks",
        seq: 10,
        entries: [
          { id: "1", revision: 5 },
          { id: "2", revision: 8 },
          { id: "3", revision: 9 },
        ],
      },
      state,
    );

    expect(state.taskList?.items).toEqual([stable, stale]);
    expect(state.taskList?.items[0]).toBe(stable);
    expect(state.taskListFresh).toBe(false);
    // Changed rows keep their old revision until the fetched event arrives.
    expect(state.stateEventRevisions.tasks).toEqual({ "1": 5, "2": 6 });

    const changed = { ...stale, title: "Fresh", updatedAt: 2 };
    const added = { ...stable, id: "3", title: "Added", updatedAt: 2 };
    state = apply(
      {
        type: "stateItems",
        topic: "tasks",
        requestId: "sync-1",
        events: [
          { kind: "upsert", id: "2", revision: 8, item: changed },
          { kind: "upsert", id: "3", revision: 9, item: added },
        ],
      },
      state,
    );

    expect(state.taskListFresh).toBe(true);
    expect(state.taskList?.items.find((item) => item.id === "1")).toBe(stable);
    expect(state.taskList?.items.find((item) => item.id === "2")).toBe(changed);
    expect(state.taskList?.items.find((item) => item.id === "3")).toBe(added);
    expect(state.stateEventRevisions.tasks).toEqual({
      "1": 5,
      "2": 8,
      "3": 9,
    });
  });

  it("applies only newer Task events and keeps deletes revision-ordered", () => {
    const taskList: TaskListResponse = {
      request: {},
      items: [
        {
          id: "1",
          title: "First",
          status: "todo",
          createdAt: 1,
          updatedAt: 1,
          source: { createdBy: "user" },
        },
        {
          id: "2",
          title: "Second",
          status: "todo",
          createdAt: 1,
          updatedAt: 1,
          source: { createdBy: "user" },
        },
      ],
      updatedAt: 1,
    };
    const state: UIState = { ...createInitialState(), taskList };
    const next = apply(
      {
        type: "stateEvents",
        topic: "tasks",
        seq: 7,
        events: [
          {
            kind: "upsert",
            id: "1",
            revision: 3,
            item: { ...taskList.items[0]!, title: "Changed", updatedAt: 2 },
          },
          { kind: "delete", id: "2", revision: 4 },
        ],
      },
      state,
    );

    expect(next.taskList?.items.map((task) => task.title)).toEqual(["Changed"]);
    expect(next.stateEventRevisions.tasks).toEqual({ "1": 3, "2": 4 });

    const stale = apply(
      {
        type: "stateEvents",
        topic: "tasks",
        seq: 8,
        events: [
          {
            kind: "upsert",
            id: "2",
            revision: 3,
            item: taskList.items[1]!,
          },
        ],
      },
      next,
    );
    // A batch whose events are all stale is an exact no-op.
    expect(stale).toBe(next);
  });

  it("keeps subagent registry echoes identity-stable and revision ordered", () => {
    const thread = {
      id: "thread-1",
      parentSessionId: "parent-1",
      sessionId: "child-1",
      peerConversationId: "peer-1",
      config: {
        roleName: "implementer",
        baseRole: "developer",
        provider: "pi",
        modelId: "model",
        credentialProfileId: "profile",
        executionProfileId: "execution",
        contractId: "implementation-result",
        contractVersion: 1,
      },
      relation: {},
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      createdAt: 1,
      updatedAt: 1,
      activityAt: 1,
    };
    let state = apply({
      type: "subagentThreadList",
      threads: [thread],
      seq: 4,
      revisions: [{ id: thread.id, revision: 8 }],
    });
    expect(state.subagentThreads[0]).toBe(thread);
    const echo = apply(
      {
        type: "stateEvents",
        topic: "subagents",
        seq: 5,
        events: [{ kind: "upsert", id: thread.id, revision: 8, item: thread }],
      },
      state,
    );
    expect(echo).toBe(state);
    const stale = apply(
      {
        type: "stateEvents",
        topic: "subagents",
        seq: 6,
        events: [{ kind: "delete", id: thread.id, revision: 7 }],
      },
      echo,
    );
    expect(stale).toBe(echo);
    state = apply(
      {
        type: "stateEvents",
        topic: "subagents",
        seq: 7,
        events: [{ kind: "delete", id: thread.id, revision: 9 }],
      },
      stale,
    );
    expect(state.subagentThreads).toEqual([]);
    expect(state.stateEventRevisions.subagents).toEqual({ [thread.id]: 9 });
  });

  it("keeps background work echoes identity-stable and revision ordered", () => {
    const item = {
      id: "bgw-1",
      ownerSessionId: "session-1",
      backend: "host-process" as const,
      kind: "shell" as const,
      label: "pnpm run build",
      state: "running" as const,
      stopState: "none" as const,
      createdAt: 1,
      updatedAt: 2,
      startedAt: 2,
      deadlineAt: 1_000,
      settingsGeneration: 1,
    };
    let state = apply({
      type: "backgroundWorkList",
      items: [item],
      seq: 3,
      revisions: [{ id: item.id, revision: 5 }],
    });
    expect(state.backgroundWorkItems[0]).toBe(item);
    const echo = apply(
      {
        type: "stateEvents",
        topic: "background",
        seq: 4,
        events: [{ kind: "upsert", id: item.id, revision: 5, item }],
      },
      state,
    );
    expect(echo).toBe(state);
    const stale = apply(
      {
        type: "stateEvents",
        topic: "background",
        seq: 5,
        events: [{ kind: "delete", id: item.id, revision: 4 }],
      },
      echo,
    );
    expect(stale).toBe(echo);
    state = apply(
      {
        type: "stateEvents",
        topic: "background",
        seq: 6,
        events: [{ kind: "delete", id: item.id, revision: 6 }],
      },
      stale,
    );
    expect(state.backgroundWorkItems).toEqual([]);
    expect(state.stateEventRevisions.background).toEqual({ [item.id]: 6 });
  });

  it("optimistic task saves use the current protocol shape", () => {
    const taskList: TaskListResponse = { request: {}, items: [], updatedAt: 1 };
    const state = { ...createInitialState(), taskList };

    const next = reduceAssistantState(state, {
      kind: "optimisticTaskSave",
      request: {
        title: "New task",
        status: "todo",
        jiraIssueKeys: ["APP-42"],
        dueDate: "2026-07-10",
      },
      tempId: "optimistic-1",
      now: 123,
    });

    const task = next.taskList?.items[0] as Record<string, unknown> | undefined;
    expect(task?.title).toBe("New task");
    expect(task?.jiraIssueKeys).toEqual(["APP-42"]);
    expect(task).not.toHaveProperty("scope");
    expect(task).not.toHaveProperty("jiraIssueKey");
    expect(task).not.toHaveProperty("reminderAt");
    expect(task).not.toHaveProperty("dependsOnIds");
  });
});

describe("useAssistant permanent Assistant reducer", () => {
  it("permanentAssistantOpened swaps in the session without leaving its dedicated route", () => {
    // Start from a different viewed session so the switch is observable.
    let state = apply({
      type: "snapshot",
      state: session(),
      contextInfo: contextInfo(),
      snapshot: {
        sessionId: "s1",
        runState: "idle",
        timeline: [],
        timelineStart: 0,
        totalEntryCount: 0,
        streaming: [],
      },
    });

    state = apply(
      {
        type: "permanentAssistantOpened",
        state: session({ sessionId: "assistant-1" }),
        sessions: [row({ id: "assistant-1", title: "Personal Assistant" })],
        contextInfo: contextInfo("assistant-1"),
      },
      state,
    );

    expect(state.session?.sessionId).toBe("assistant-1");
    // The dedicated /assistant route owns navigation, so this must not reuse the
    // ordinary fork-switch path that canonicalizes empty sessions to /sessions/create.
    expect(state.sessions.some((s) => s.id === "assistant-1")).toBe(true);
    expect(state.forkSwitch).toBeNull();
  });

  /**
   * The queue states are conditions on ONE message, so they live on that
   * message's row — the optimistic echo, keyed by the same `clientRequestId`
   * the send created it under.
   *
   * The row is still there when they arrive, and that is the whole premise:
   * the server appends the durable user entry from inside the run it starts
   * AFTER reporting `working`, so the echo outlives both conditions and hands
   * over to the durable row exactly when the transcript starts saying the same
   * thing itself.
   */
  it("keeps a queued prompt's conditions on its own row until the durable entry lands", () => {
    const queue = (state: "queued" | "working" | "completed" | "failed") => ({
      type: "permanentAssistantQueue" as const,
      sessionId: "pa",
      clientRequestId: "c1",
      state,
    });
    let state = apply({
      type: "snapshot",
      state: session({ sessionId: "pa", agentType: "personal-assistant" }),
      contextInfo: contextInfo("pa"),
      snapshot: {
        sessionId: "pa",
        runState: "idle",
        timeline: [],
        timelineStart: 0,
        totalEntryCount: 0,
        streaming: [],
      },
    });
    state = reduceAssistantState(state, {
      kind: "optimisticUserMessage",
      clientRequestId: "c1",
      text: "what is on today?",
    });
    expect(state.messages.map((m) => m.id)).toEqual(["creq-c1"]);

    state = apply(queue("queued"), state);
    expect(state.promptQueueStates).toEqual({ "creq-c1": "queued" });
    state = apply(queue("working"), state);
    expect(state.promptQueueStates).toEqual({ "creq-c1": "working" });
    // Still the row it is about — nothing has retired the echo yet.
    expect(state.messages.map((m) => m.id)).toEqual(["creq-c1"]);

    // The durable entry replaces the echo, and the condition goes with it.
    state = apply(
      {
        type: "event",
        sessionId: "pa",
        event: {
          type: "timelineDelta",
          clientRequestId: "c1",
          entries: [
            {
              id: "u1",
              seq: 0,
              createdAt: "t",
              type: "message",
              role: "user",
              origin: { kind: "human" },
              content: [{ type: "text", text: "what is on today?" }],
            },
          ],
        },
      },
      state,
    );
    expect(state.messages.map((m) => m.id)).toEqual(["u1"]);
    expect(state.promptQueueStates).toEqual({});
  });

  /**
   * The failure is session-scoped like every other one, so it goes on the
   * session — where the composer renders it — and it survives the traffic that
   * keeps arriving from the queue behind it.
   *
   * The queue emits `completed` OR `failed` per item, never both for the same
   * one, so a completion is always some OTHER item's: retiring the failure with
   * it would erase a live error because the next message in the queue happened
   * to succeed. What retires it is what retires every session failure — the
   * dismiss, or that session's own next send.
   */
  it("keeps a queued prompt's failure on its session while the queue drains on", () => {
    let state = apply({
      type: "permanentAssistantQueue",
      sessionId: "pa",
      clientRequestId: "c1",
      state: "failed",
      error: "No model is available",
    });
    expect(state.sessionFailures).toEqual({ pa: "No model is available" });

    state = apply(
      {
        type: "permanentAssistantQueue",
        sessionId: "pa",
        clientRequestId: "c2",
        state: "completed",
      },
      state,
    );
    expect(state.sessionFailures).toEqual({ pa: "No model is available" });

    // The session's own next send is one of the two things that does retire it.
    state = reduceAssistantState(state, {
      kind: "clearChatError",
      sessionId: "pa",
    });
    expect(state.sessionFailures).toEqual({});
  });
});

// Which fork actions a transcript offers depends on the harness backing it (the
// two branch at different points), so the reducer has to hand the viewed
// session's harness to the projection. Getting it wrong shows a fork button that
// the server then refuses — which is what a pi session did on every prompt whose
// own native id it had not recovered.
describe("fork affordances follow the viewed session's harness", () => {
  const forkTimeline: ClientTimelineEntry[] = [
    {
      id: "u1",
      seq: 0,
      createdAt: "t",
      type: "message",
      role: "user",
      origin: { kind: "human" },
      content: [{ type: "text", text: "first" }],
      forkable: true,
    },
    {
      id: "a1",
      seq: 1,
      createdAt: "t",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      forkable: true,
    },
    // Sent, not yet anchored: pi recovers native ids only after the turn.
    {
      id: "u2",
      seq: 2,
      createdAt: "t",
      type: "message",
      role: "user",
      origin: { kind: "human" },
      content: [{ type: "text", text: "second" }],
    },
  ];
  const viewing = (harness: SessionState["harness"]) =>
    apply({
      type: "snapshot",
      state: session({ harness }),
      contextInfo: contextInfo(),
      snapshot: {
        sessionId: "s1",
        runState: "idle",
        timeline: forkTimeline,
        timelineStart: 0,
        totalEntryCount: forkTimeline.length,
        streaming: [],
      },
    });

  it("offers pi's fork-before only where the prompt itself is anchored", () => {
    const messages = viewing("pi").messages;
    expect(messages.find((m) => m.id === "u1")?.forkBeforeEntryId).toBe("u1");
    expect(messages.find((m) => m.id === "a1")?.forkAtEntryId).toBe("a1");
    expect(messages.find((m) => m.id === "u2")?.forkBeforeEntryId).toBe(
      undefined,
    );
  });

  it("keeps the Claude SDK's earlier-anchor rule on its own sessions", () => {
    const messages = viewing("claude-sdk").messages;
    expect(messages.find((m) => m.id === "u2")?.forkBeforeEntryId).toBe("u2");
    // ...but its FIRST prompt has no earlier turn to cut at, so the server
    // refuses it and the row must not offer the action, anchored or not.
    expect(messages.find((m) => m.id === "u1")?.forkBeforeEntryId).toBe(
      undefined,
    );
  });
});

describe("assistant turn error surfaces in the chat transcript", () => {
  it("projects a failed turn's provider error onto its DisplayMessage", () => {
    const messages = entriesToDisplayMessages([
      {
        id: "u0",
        seq: 0,
        createdAt: "t",
        type: "message",
        role: "user",
        origin: { kind: "human" },
        content: [{ type: "text", text: "hi" }],
      },
      {
        id: "a1",
        seq: 1,
        createdAt: "t",
        type: "message",
        role: "assistant",
        content: [],
        stopReason: "error",
        error:
          "Model usage limit reached (openai-codex/gpt-5): quota exceeded.",
      },
    ]);

    const assistant = messages.find((m) => m.id === "a1");
    // Rendered durably in the session it belongs to (AssistantMessage shows message.error),
    // not just as a transient global banner.
    expect(assistant?.error).toBe(
      "Model usage limit reached (openai-codex/gpt-5): quota exceeded.",
    );
    expect(assistant?.stopReason).toBe("error");
  });
});

// Which echo a failed send retires is decided by the WIRE naming that send
// (`failedPromptClientRequestId`), never by the sentence the server chose: none
// of these failures say "Failed to send prompt".
describe("a failed prompt and its optimistic echo", () => {
  const optimisticPrompt = (
    staged: boolean,
    clientRequestId = "c1",
    state = createInitialState(),
  ) =>
    reduceAssistantState(state, {
      kind: "optimisticUserMessage",
      clientRequestId,
      text: "Draft the release notes",
      ...(staged
        ? { sessionId: "pending-pi-session", canMoveSession: true }
        : {}),
    });
  const failed = (state: UIState, clientRequestId = "c1") =>
    apply(
      {
        type: "error",
        message: "engine did not start",
        failedPromptClientRequestId: clientRequestId,
      },
      state,
    );

  it("keeps a STAGED first send's prompt so its surface can retry in place", () => {
    // Dropping it drops the user back to an empty new-session page with the
    // prompt gone; no session owns it yet, so nothing else can bring it back —
    // and the wire naming that very send does not change the answer.
    const state = failed(optimisticPrompt(true));
    expect(state.optimistic).toHaveLength(1);
    expect(state.messages.map((message) => message.role)).toEqual(["user"]);
    expect(state.error).toBe("engine did not start");
  });

  it("drops the echo of a prompt that failed inside an existing session", () => {
    expect(failed(optimisticPrompt(false)).optimistic).toEqual([]);
  });

  it("drops only the send that failed, leaving another still in flight", () => {
    // The sentence could not say WHICH prompt it was about, so every non-staged
    // echo used to go with it — including sends that were still on their way.
    const state = failed(
      optimisticPrompt(false, "c2", optimisticPrompt(false, "c1")),
      "c1",
    );
    expect(state.optimistic.map((entry) => entry.id)).toEqual(["creq-c2"]);
  });

  it("keeps every echo for a failure that is not a prompt send", () => {
    const state = apply(
      {
        type: "error",
        message: "Failed to rename session: session not found.",
      },
      optimisticPrompt(false),
    );
    expect(state.optimistic.map((entry) => entry.id)).toEqual(["creq-c1"]);
  });

  it("retires the chat's last failure for a send that echoes nothing", () => {
    // Announcing a failure does not end it: `error` stays set on purpose,
    // because it is the chat's last OUTCOME and a surface that renders it in
    // place would otherwise keep narrating something that is over. Arming a
    // staged send is what ends it (`clearChatError`); the optimistic echo does
    // the same for an ordinary prompt.
    let state = failed(createInitialState());
    expect(state.error).toBe("engine did not start");

    state = reduceAssistantState(state, { kind: "clearChatError" });
    expect(state.error).toBeNull();
  });
});

describe("useAssistant peer-prompt card update / history expansion reducer", () => {
  it("ignores a peerPromptCardUpdate for a session other than the one currently viewed", () => {
    let state = apply({
      type: "snapshot",
      state: session(),
      contextInfo: contextInfo(),
      snapshot: {
        sessionId: "s1",
        runState: "idle",
        timeline: [],
        timelineStart: 0,
        totalEntryCount: 0,
        streaming: [],
      },
    });
    state = apply(
      {
        type: "peerPromptCardUpdate",
        sessionId: "other-session",
        messageKey: "k1",
        state: "completed",
      },
      state,
    );
    expect(state.peerPromptCardOverrides).toEqual({});
  });

  it("merges a peerPromptCardUpdate for the current session into peerPromptCardOverrides", () => {
    let state = apply({
      type: "snapshot",
      state: session(),
      contextInfo: contextInfo(),
      snapshot: {
        sessionId: "s1",
        runState: "idle",
        timeline: [],
        timelineStart: 0,
        totalEntryCount: 0,
        streaming: [],
      },
    });
    state = apply(
      {
        type: "peerPromptCardUpdate",
        sessionId: "s1",
        messageKey: "k1",
        state: "interrupted",
        failureReason: "boom",
      },
      state,
    );
    expect(state.peerPromptCardOverrides.k1).toEqual({
      state: "interrupted",
      failureReason: "boom",
    });

    // A second update for a different key accumulates rather than replacing.
    state = apply(
      {
        type: "peerPromptCardUpdate",
        sessionId: "s1",
        messageKey: "k2",
        state: "completed",
      },
      state,
    );
    expect(Object.keys(state.peerPromptCardOverrides).sort()).toEqual([
      "k1",
      "k2",
    ]);
  });

  it("resets peerPromptCardOverrides and peerPromptHistoryExpanded when a new session snapshot loads", () => {
    let state = apply({
      type: "snapshot",
      state: session(),
      contextInfo: contextInfo(),
      snapshot: {
        sessionId: "s1",
        runState: "idle",
        timeline: [],
        timelineStart: 0,
        totalEntryCount: 0,
        streaming: [],
      },
    });
    state = apply(
      {
        type: "peerPromptCardUpdate",
        sessionId: "s1",
        messageKey: "k1",
        state: "completed",
      },
      state,
    );
    state = apply(
      {
        type: "peerPromptHistoryExpanded",
        sessionId: "s1",
        projection: { threads: [], truncated: false },
      },
      state,
    );
    expect(state.peerPromptCardOverrides).not.toEqual({});
    expect(state.peerPromptHistoryExpanded).not.toBeNull();

    state = apply(
      {
        type: "snapshot",
        state: session({ sessionId: "s2" }),
        contextInfo: contextInfo("s2"),
        snapshot: {
          sessionId: "s2",
          runState: "idle",
          timeline: [],
          timelineStart: 0,
          totalEntryCount: 0,
          streaming: [],
        },
      },
      state,
    );
    expect(state.peerPromptCardOverrides).toEqual({});
    expect(state.peerPromptHistoryExpanded).toBeNull();
  });

  it("applies an expanded history projection only for the currently viewed session", () => {
    let state = apply({
      type: "snapshot",
      state: session(),
      contextInfo: contextInfo(),
      snapshot: {
        sessionId: "s1",
        runState: "idle",
        timeline: [],
        timelineStart: 0,
        totalEntryCount: 0,
        streaming: [],
      },
    });
    const projection = {
      threads: [
        {
          conversationId: "c1",
          otherPartyTitle: "Other",
          peerSessionId: "peer-1",
          messages: [],
        },
      ],
      truncated: false,
    };
    state = apply(
      {
        type: "peerPromptHistoryExpanded",
        sessionId: "wrong-session",
        projection,
      },
      state,
    );
    expect(state.peerPromptHistoryExpanded).toBeNull();

    state = apply(
      { type: "peerPromptHistoryExpanded", sessionId: "s1", projection },
      state,
    );
    expect(state.peerPromptHistoryExpanded).toEqual(projection);
  });

  it("merges an expanded history projection into peerPromptCardOverrides too, so explicitly loading more history also reconciles stale rendered cards", () => {
    let state = apply({
      type: "snapshot",
      state: session(),
      contextInfo: contextInfo(),
      snapshot: {
        sessionId: "s1",
        runState: "idle",
        timeline: [],
        timelineStart: 0,
        totalEntryCount: 0,
        streaming: [],
      },
    });
    // A live broadcast already landed for one message not in the expanded page.
    state = apply(
      {
        type: "peerPromptCardUpdate",
        sessionId: "s1",
        messageKey: "live-only",
        state: "delivered",
      },
      state,
    );
    const projection = {
      truncated: true,
      threads: [
        {
          conversationId: "c1",
          otherPartyTitle: "Other",
          peerSessionId: "peer-1",
          messages: [
            {
              id: "old-1",
              direction: "received" as const,
              message: "old",
              state: "failed" as const,
              responseRequested: false,
              failureReason: "boom",
              createdAt: 1,
            },
          ],
        },
      ],
    };
    state = apply(
      { type: "peerPromptHistoryExpanded", sessionId: "s1", projection },
      state,
    );
    expect(state.peerPromptCardOverrides["live-only"]).toEqual({
      state: "delivered",
      failureReason: undefined,
    });
    expect(state.peerPromptCardOverrides["old-1"]).toEqual({
      state: "failed",
      failureReason: "boom",
    });
  });

  it("seeds peerPromptCardOverrides from SessionState.peerPrompts on snapshot, so a navigation/reconnect shows durable card state without waiting for a new live broadcast", () => {
    const state = apply({
      type: "snapshot",
      state: session({
        peerPrompts: {
          truncated: false,
          threads: [
            {
              conversationId: "c1",
              otherPartyTitle: "Other",
              peerSessionId: "peer-1",
              messages: [
                {
                  id: "m1",
                  direction: "sent",
                  message: "hi",
                  state: "failed",
                  responseRequested: false,
                  failureReason: "provider error",
                  createdAt: 1,
                },
              ],
            },
          ],
        },
      }),
      contextInfo: contextInfo(),
      snapshot: {
        sessionId: "s1",
        runState: "idle",
        timeline: [],
        timelineStart: 0,
        totalEntryCount: 0,
        streaming: [],
      },
    });
    expect(state.peerPromptCardOverrides.m1).toEqual({
      state: "failed",
      failureReason: "provider error",
    });
  });

  it("merges (rather than replaces) peerPromptCardOverrides seeded from history on a state update, preserving live overrides not yet reflected in the bounded history projection", () => {
    let state = apply({
      type: "snapshot",
      state: session(),
      contextInfo: contextInfo(),
      snapshot: {
        sessionId: "s1",
        runState: "idle",
        timeline: [],
        timelineStart: 0,
        totalEntryCount: 0,
        streaming: [],
      },
    });
    // A live broadcast lands for a message not (yet) present in the bounded history snapshot.
    state = apply(
      {
        type: "peerPromptCardUpdate",
        sessionId: "s1",
        messageKey: "live-only",
        state: "delivered",
      },
      state,
    );
    // A subsequent `state` message carries history for a different message.
    state = apply(
      {
        type: "state",
        state: session({
          peerPrompts: {
            truncated: false,
            threads: [
              {
                conversationId: "c1",
                otherPartyTitle: "Other",
                peerSessionId: "peer-1",
                messages: [
                  {
                    id: "m1",
                    direction: "sent",
                    message: "hi",
                    state: "completed",
                    responseRequested: false,
                    createdAt: 1,
                  },
                ],
              },
            ],
          },
        }),
      },
      state,
    );
    expect(state.peerPromptCardOverrides["live-only"]).toEqual({
      state: "delivered",
      failureReason: undefined,
    });
    expect(state.peerPromptCardOverrides.m1).toEqual({
      state: "completed",
      failureReason: undefined,
    });
  });
});

describe("useAssistant workflow run-start reducer", () => {
  const startMsg = (
    requestId: string,
    phase: "naming" | "creating" | "submodules" | "started" | "failed",
    extra: { runId?: string; branch?: string; error?: string } = {},
  ): ServerMessage => ({
    type: "workflowRunStart",
    requestId,
    phase,
    ...extra,
  });

  it("keys progress per request so one start never shadows another", () => {
    let state = apply(startMsg("req-a", "creating", { runId: "1" }));
    state = apply(startMsg("req-b", "failed", { error: "boom" }), state);
    state = apply(startMsg("req-a", "started", { branch: "t1-alpha" }), state);
    expect(state.workflowRunStarts["req-a"]).toEqual({
      requestId: "req-a",
      phase: "started",
      branch: "t1-alpha",
    });
    expect(state.workflowRunStarts["req-b"]).toEqual({
      requestId: "req-b",
      phase: "failed",
      error: "boom",
    });
  });

  it("keeps the map bounded across a failed → retry sequence (the start flow clears the consumed failure before re-sending)", () => {
    // Attempt 1 fails; its entry stays so the inline error can render.
    let state = apply(startMsg("req-1", "failed", { error: "no repo" }));
    expect(Object.keys(state.workflowRunStarts)).toEqual(["req-1"]);

    // Retry: the flow clears the consumed failed entry BEFORE sending under a
    // fresh id — otherwise nothing would ever address req-1 again and every
    // retry would leak an entry.
    state = reduceAssistantState(state, {
      kind: "clearWorkflowRunStart",
      requestId: "req-1",
    });
    expect(state.workflowRunStarts).toEqual({});
    state = apply(startMsg("req-2", "creating"), state);
    state = apply(startMsg("req-2", "started", { branch: "t1-beta" }), state);
    expect(Object.keys(state.workflowRunStarts)).toEqual(["req-2"]);

    // The started entry is consumed (toast + close) and dropped the same way.
    state = reduceAssistantState(state, {
      kind: "clearWorkflowRunStart",
      requestId: "req-2",
    });
    expect(state.workflowRunStarts).toEqual({});
  });

  it("clearing an unknown request id changes nothing", () => {
    const state = createInitialState();
    expect(
      reduceAssistantState(state, {
        kind: "clearWorkflowRunStart",
        requestId: "req-x",
      }),
    ).toBe(state);
  });
});

describe("windowed transcript reducer", () => {
  const userEntry = (seq: number): ClientTimelineEntry => ({
    id: `u${seq}`,
    seq,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text: `prompt ${seq}` }],
  });

  const seed = (input: number) => ({
    cumulative: { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    prevContextSize: input,
    usageTurnCount: 1,
  });

  function windowedState(): UIState {
    return apply({
      type: "snapshot",
      state: session(),
      contextInfo: contextInfo(),
      snapshot: {
        sessionId: "s1",
        runState: "idle",
        timeline: [userEntry(10), userEntry(11)],
        timelineStart: 10,
        totalEntryCount: 12,
        turnStatsSeed: seed(500),
        streaming: [],
      },
    });
  }

  const range = (
    patch: Partial<Extract<ServerMessage, { type: "timelineRange" }>> = {},
  ): ServerMessage => ({
    type: "timelineRange",
    sessionId: "s1",
    beforeSeq: 10,
    entries: [userEntry(8), userEntry(9)],
    timelineStart: 8,
    totalEntryCount: 12,
    turnStatsSeed: seed(300),
    ...patch,
  });

  it("adopts the window plus the stats for everything before it", () => {
    const state = windowedState();
    expect(state.timeline.map((entry) => entry.seq)).toEqual([10, 11]);
    expect(state.timelineStart).toBe(10);
    expect(state.turnStatsSeed.cumulative.input).toBe(500);
  });

  it("prepends an older range in seq order and re-seeds for the new start", () => {
    const state = apply(range(), windowedState());
    expect(state.timeline.map((entry) => entry.seq)).toEqual([8, 9, 10, 11]);
    expect(state.timelineStart).toBe(8);
    // The seed moved back with the window: the rows already on screen keep the
    // cumulative they were rendered with.
    expect(state.turnStatsSeed.cumulative.input).toBe(300);
    expect(state.timelineRangePending).toBeNull();
  });

  it("drops a range that does not join the rendered suffix", () => {
    const base = windowedState();
    // Wrong anchor (the transcript moved on), overlapping rows, and a slice that
    // does not end where the transcript starts: each is dropped, never spliced.
    for (const bad of [
      range({ beforeSeq: 4 }),
      range({ entries: [userEntry(9), userEntry(10)] }),
      range({ timelineStart: 7 }),
      range({ entries: [] }),
    ]) {
      const next = apply(bad, base);
      expect(next.timeline.map((entry) => entry.seq)).toEqual([10, 11]);
      expect(next.timelineStart).toBe(10);
      expect(next.turnStatsSeed.cumulative.input).toBe(500);
    }
  });

  it("ignores a range for a session that is no longer viewed", () => {
    const base = windowedState();
    const next = apply(range({ sessionId: "other" }), base);
    expect(next).toBe(base);
  });

  it("a fresh snapshot resets the window bookkeeping", () => {
    let state = apply(range(), windowedState());
    state = apply(
      {
        type: "snapshot",
        state: session({ sessionId: "s2" }),
        contextInfo: contextInfo("s2"),
        snapshot: {
          sessionId: "s2",
          runState: "idle",
          timeline: [],
          timelineStart: 0,
          totalEntryCount: 0,
          streaming: [],
        },
      },
      state,
    );
    expect(state.timelineStart).toBe(0);
    expect(state.turnStatsSeed.cumulative.input).toBe(0);
    expect(state.timelineRangePending).toBeNull();
  });
});

describe("session-list freshness across a reconnect", () => {
  const readyWith = (sessions: SessionListItem[]): ServerMessage => ({
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: null,
    models: [],
    agents: [],
    sessions,
    settings: {},
    speechToText: {
      configured: false,
      availableModelIds: [],
      maxUtteranceSeconds: 120,
    },
    slashCommands: [],
    contextInfo: null,
  });

  it("is false until `ready`, and STALE again from the drop to the next one", () => {
    // The window this flag exists for. `hydrationSource` is historical and the
    // status reducer turns `connected` back on immediately for a
    // previously-live shell — BEFORE the new episode's `ready` replaces the
    // session list. Anything deriving freshness from those two blesses
    // previous-episode rows, and a surface joining session ids against them
    // then reports a just-linked session as authoritatively absent.
    let state = createInitialState();
    expect(state.sessionListFresh).toBe(false);

    state = apply(readyWith([row({ id: "s1" })]), state);
    expect(state.sessionListFresh).toBe(true);

    state = reduceAssistantState(state, { kind: "status", connected: false });
    expect(state.sessionListFresh).toBe(false);
    // Reconnected transport, no answer yet: `connected` is already true again
    // and the rows are the previous episode's.
    state = reduceAssistantState(state, { kind: "status", connected: true });
    expect(state.connected).toBe(true);
    expect(state.hydrationSource).toBe("live");
    expect(state.sessionListFresh).toBe(false);
    expect(state.sessions).toHaveLength(1);

    // …and only the next `ready` restores it, with its own list.
    state = apply(readyWith([row({ id: "s2" })]), state);
    expect(state.sessionListFresh).toBe(true);
    expect(state.sessions.map((row) => row.id)).toEqual(["s2"]);
  });
});
