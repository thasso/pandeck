/** App projections use real temporary stores, never a provider session. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import type { SessionState, ThinkingLevel } from "@assistant/shared";
import type { SessionNativeFacts } from "./sessionState.ts";

const tmp = mkdtempSync(join(tmpdir(), "session-state-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(process.env.DATA_DIR, { recursive: true });

const pendingQuestion = {
  requestId: "pending-question",
  toolCallId: "question-call",
  sessionId: "projection",
  title: "Choose a direction",
  questions: [{ id: "q1", title: "Which?", style: "text" as const }],
  createdAt: 1_000,
};
const answeredQuestion = {
  requestId: "answered-question",
  toolCallId: "answered-call",
  response: {
    requestId: "answered-question",
    status: "submitted" as const,
    answers: [
      { questionId: "q1", text: "Yes", disposition: "answered" as const },
    ],
    submittedAt: 900,
  },
};
writeFileSync(
  join(process.env.DATA_DIR, "pending-questions.json"),
  JSON.stringify({ projection: [pendingQuestion] }),
);
writeFileSync(
  join(process.env.DATA_DIR, "answered-questions.json"),
  JSON.stringify({ projection: [answeredQuestion] }),
);

const { sessionStore } = await import("./db/sessionStore.ts");
const { viewSessionById, ViewSession } = await import("./viewSession.ts");
const { buildSessionState } = await import("./sessionState.ts");
const { storedSessionModelOption } = await import("./harnesses/models.ts");
const proxied = await import("./mcp/toolGroups/proxiedServer.ts");
const questions = await import("./tools/core/questionTool.ts");
const approvals = await import("./pendingApprovals.ts");
const cards = await import("./pullRequestCards.ts");
const cwd = await import("./worktrees/sessionCwd.ts");
const { SKILLS_RUNTIME_DIR } = await import("./config.ts");
const { skillSetHash, skillRuntimePluginName } =
  await import("./skills/skillRuntimeMaterializer.ts");
const { closeDb, getDb } = await import("./db/index.ts");
const tasks = await import("./tasks.ts");
const worktrees = await import("./db/worktreeStore.ts");
const { directPeerChildStore } = await import("./db/directPeerChildStore.ts");
const { promptQueueStore } = await import("./db/promptQueueStore.ts");
const { peerPromptStore } = await import("./db/peerPromptStore.ts");
const { installBackgroundUpdateQueue } =
  await import("./backgroundUpdateQueue.ts");
const { freezeSessionAgent } = await import("./agents/sessionAgent.ts");
const { registerSessionToolExposure } =
  await import("./tools/sessionToolExposure.ts");
const { stageSessionArtifact } =
  await import("./mcp/toolGroups/packRuntime.ts");
const { canonicalPiSessionPath } = await import("./sessionStorage.ts");

function storedFacts(id: string): SessionNativeFacts {
  const meta = sessionStore.get(id)!;
  return {
    harness: meta.harness,
    agentType: meta.agentType,
    kind: meta.agentType,
    forkOrigin: meta.forkOrigin,
    model: storedSessionModelOption(meta.harness, meta.provider, meta.model),
    thinkingLevel: (meta.thinkingLevel ?? "off") as ThinkingLevel,
    mode: meta.mode,
  };
}

function storedState(id: string): SessionState {
  return buildSessionState(id, storedFacts(id));
}

function serialized(state: unknown): string {
  return JSON.stringify(state)
    .replaceAll(tmp, "<tmp>")
    .replace(/"(id|conversationId)":"k[a-z0-9]+"/g, '"$1":"<peer-key>"')
    .replace(/artifact-[a-f0-9-]+/g, "<artifact-id>")
    .replace(/1000-[a-f0-9]{10}-capture\.txt/g, "<artifact-file>");
}

afterEach(() => {
  vi.restoreAllMocks();
  installBackgroundUpdateQueue(undefined);
});
afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("detached serialization preserves the pre-owner field order and values", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const id = "projection";
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "workshop",
    provider: "openai-codex",
    model: "gpt-6-sol",
    thinkingLevel: "high",
    mode: "plan",
    requiresEnterprise: true,
    forkOrigin: { parentSessionId: "parent", parentEntryId: "fork-point" },
  });
  const nativeFile = canonicalPiSessionPath(id);
  mkdirSync(join(nativeFile, ".."), { recursive: true });
  writeFileSync(nativeFile, "Native contents must never be read by a view");
  sessionStore.setCompactionWindow(id, 100_000);
  sessionStore.freezeSkills(id, '["review"]');
  freezeSessionAgent(id, {
    name: "reviewer",
    blob: "abc123",
    persona: "developer",
    provider: "openai-codex",
    model: "gpt-6-sol",
    effort: "high",
    runtimeSource: "definition",
    denyTools: ["task_manage"],
    skills: ["review"],
    body: "Review the change.",
  });
  const origin = tasks.createTask({
    title: "Origin",
    source: { createdBy: "user" },
  });
  const related = tasks.createTask({
    title: "Reference",
    source: { createdBy: "user" },
  });
  tasks.linkSessionToTask(origin.id, { sessionId: id, origin: "task-start" });
  tasks.linkSessionToTask(related.id, { sessionId: id, origin: "reference" });
  tasks.createTask({ title: "Unrelated", source: { createdBy: "user" } });
  worktrees.insertWorktree({
    id: "missing-worktree",
    projectId: "project",
    mainRepoRoot: tmp,
    path: join(tmp, "missing"),
    branch: "feature",
    baseBranch: "main",
    baseCommit: "base",
    status: "active",
    mergeStateJson: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    removedAt: null,
  });
  worktrees.linkSessionToWorktree(id, "missing-worktree");
  directPeerChildStore.record({
    childSessionId: id,
    spawnerSessionId: "spawner",
    costClass: "counted",
    source: { kind: "profile", profileId: "pr_test" },
    provider: "openai-codex",
    modelId: "gpt-6-sol",
    thinkingLevel: "high",
    credentialProfileId: "acct",
    createdAt: 1_000,
  });
  promptQueueStore.append({
    id: "queued-user",
    sessionId: id,
    text: "Next prompt",
  });
  promptQueueStore.setPaused(id, true);
  peerPromptStore.enqueue(
    {
      conversationId: "conversation",
      chainId: "chain",
      hop: 1,
      senderSessionId: "peer",
      recipientSessionId: id,
      prompt: "Peer first line\nPeer second line\nNot rendered",
      responseRequested: true,
    },
    1_000,
  );
  const batch = [{ itemId: "background", revision: 2, attemptId: null }];
  installBackgroundUpdateQueue({
    count: (sessionId) => (sessionId === id ? 2 : 0),
    unhandled: (sessionId) =>
      sessionId === id ? { count: 1, batch } : { count: 0, batch: [] },
    publish() {},
  });
  writeFileSync(
    join(process.env.DATA_DIR!, "post-reload-continuation.json"),
    JSON.stringify({
      sessionId: id,
      id: "reload",
      message: "Continue after reload",
      reason: "Test",
      createdAt: 1_000,
    }),
  );
  const artifact = stageSessionArtifact(id, {
    name: "capture.txt",
    mimeType: "text/plain",
    kind: "download",
    label: "Capture",
    sourceTool: "test",
    bytes: new Uint8Array([65]),
  });
  const unregister = registerSessionToolExposure(id, () => ({
    counts: {
      total: 0,
      eager: 0,
      usable: 0,
      loaded: 0,
      loadedButUnused: 0,
      loadedButUnusedDefinitionChars: 0,
    },
    tools: [],
    loadEvents: [],
  }));
  try {
    // Captured on the exact base before the owner replaces ViewSession.state().
    const detached = viewSessionById(id)!.state();
    expect(
      serialized(detached).replaceAll(artifact.id, "<artifact-id>"),
    ).toMatchSnapshot();
    const detachedFacts = { ...storedFacts(id), sessionFile: nativeFile };
    expect(JSON.stringify(buildSessionState(id, detachedFacts))).toBe(
      JSON.stringify(detached),
    );
    expect(detached).not.toHaveProperty("skillInvocations");
    expect(detached).not.toHaveProperty("browserRuntimes");

    proxied.setProxiedClientFactoryForTests(async () => ({
      callTool: async () => ({ content: [] }),
      close: async () => {},
      onUnexpectedClose() {},
    }));
    await proxied.openProxiedConnection(
      id,
      {
        name: "Test browser",
        outputDir: () => join(tmp, "browser"),
        spawn: () => ({ command: "unused", args: [] }),
      },
      false,
    );
    const browserRuntimeOwner = vi.fn(() => ({
      agentKind: "workshop" as const,
      agentStatus: "idle" as const,
      sessionTitle: "Owner",
      sessionFile: nativeFile,
    }));
    const appFields = [
      "idleReason",
      "pendingQuestions",
      "answeredQuestions",
      "tasks",
      "relatedGlobalTasks",
      "originTask",
      "activeSkills",
      "agent",
      "artifacts",
      "pendingPostReloadContinuation",
      "peerPrompts",
      "peerPromptPeers",
      "promptQueue",
      "queuedPeerPrompts",
      "directSpawnedBy",
      "queuedBackgroundUpdates",
      "unhandledBackgroundUpdates",
      "unhandledBackgroundBatch",
      "worktreeId",
      "worktreeMissing",
    ] as const satisfies readonly (keyof SessionState)[];
    for (const facts of liveFixtures(detachedFacts)) {
      const state = buildSessionState(id, facts, browserRuntimeOwner);
      expect(browserRuntimeOwner).toHaveBeenLastCalledWith(id);
      for (const field of appFields) {
        expect(state[field], `${facts.harness} ${field}`).toEqual(
          detached[field],
        );
        expect(Object.hasOwn(state, field)).toBe(
          Object.hasOwn(detached, field),
        );
      }
      expect(state).toMatchObject({
        sessionId: id,
        sessionFile: facts.sessionFile,
        harness: facts.harness,
        agentType: facts.agentType,
        forkOrigin: facts.forkOrigin,
        model: facts.model,
        thinkingLevel: facts.thinkingLevel,
        mode: "plan",
        requiresEnterprise: true,
        canSteer: facts.live!.canSteer,
        compactionWindow: {
          tokens: 100_000,
          effectiveTokens: 100_000,
          applied: "confirmed",
          appliedTokens: 100_000,
          range: {
            min: facts.harness === "pi" ? 1 : 100_000,
            max: facts.harness === "pi" ? 190_000 : 200_000,
          },
        },
        browserRuntimes: [
          {
            sessionId: id,
            sessionFile: nativeFile,
            sessionTitle: "Owner",
            agentKind: "workshop",
            agentStatus: "idle",
            connectedToCurrentSession: true,
            status: "running",
            headed: false,
            outputDir: join(tmp, "browser"),
            startedAt: 1_000,
            lastUsedAt: 1_000,
          },
        ],
        skillInvocations: [
          {
            name: "review",
            at: 500,
            via: facts.harness === "pi" ? "read" : "skill_tool",
          },
        ],
      });
      const exposure = state.toolExposure!;
      expect(
        exposure.tools.find((tool) => tool.name === "task_read"),
      ).toMatchObject({
        loaded: true,
        usable: true,
        used: true,
        tokens: 42,
        definitionChars: 123,
      });
      expect(
        exposure.tools.find((tool) => tool.name === "task_manage"),
      ).toMatchObject({ loaded: false, usable: false });
      expect(
        exposure.tools.find((tool) => tool.name === "worktree_commit"),
      ).toMatchObject({ loaded: false, usable: false });
      expect(
        exposure.tools.find((tool) => tool.name === "slack_search"),
      ).toMatchObject({ loaded: false, usable: false });
      expect(exposure.loadEvents).toEqual(facts.live!.toolLoading!.loadEvents);
      expect(exposure.tools.some((tool) => tool.name === "find_tools")).toBe(
        facts.harness === "pi",
      );
      expect(JSON.stringify(state)).not.toContain("transitions");
      expect(state.tasks!.every((task) => !("description" in task))).toBe(true);
    }
    tasks.updateTask(origin.id, { title: "Renamed origin", status: "doing" });
    expect(storedState(id).originTask).toEqual({
      id: origin.id,
      title: "Renamed origin",
      status: "doing",
    });
  } finally {
    unregister();
    await proxied.closeProxiedConnection(id);
    proxied.setProxiedClientFactoryForTests(undefined);
  }
});

function liveFixtures(base: SessionNativeFacts): SessionNativeFacts[] {
  const plugin = skillRuntimePluginName(skillSetHash(["review"]));
  const path = join(
    SKILLS_RUNTIME_DIR,
    skillSetHash(["review"]),
    "skills",
    "review",
    "SKILL.md",
  );
  return (["claude-sdk", "pi"] as const).map((harness) => ({
    ...base,
    harness,
    model:
      harness === "claude-sdk"
        ? storedSessionModelOption(harness, "claude", "opus")
        : base.model,
    thinkingLevel: harness === "claude-sdk" ? "max" : "high",
    sessionFile: join(tmp, `${harness}-native`),
    live: {
      canSteer: harness === "pi",
      compactionWindow: {
        contextWindow: 200_000,
        underlyingReserve: 10_000,
        live: { applied: "confirmed", appliedTokens: 100_000 },
      },
      skillInvocationTranscript: () => ({
        calls: [
          {
            toolCallId: "load",
            toolName: harness === "pi" ? "read" : "Skill",
            input: harness === "pi" ? { path } : { skill: `${plugin}:review` },
            at: 500,
          },
          {
            toolCallId: "foreign",
            toolName: "read",
            input: { path: join(tmp, "elsewhere", "SKILL.md") },
            at: 501,
          },
          { toolCallId: "failed", toolName: "read", input: { path }, at: 502 },
          { toolCallId: "pending", toolName: "read", input: { path }, at: 503 },
        ],
        succeeded: new Set(["load", "foreign"]),
      }),
      toolLoading: {
        loadedToolNames: new Set([
          "task_read",
          "task_manage",
          "worktree_commit",
          "slack_search",
        ]),
        usedToolNames: new Set(["task_read"]),
        definitionCharsByName: new Map([["task_read", 123]]),
        tokensByName: new Map([["task_read", 42]]),
        includeFindTools: harness === "pi",
        loadEvents: [{ at: 400, via: "find_tools", names: ["task_read"] }],
      },
    },
  }));
}

test("a stored Claude SDK session reports its model by alias", () => {
  sessionStore.upsert({
    id: "view-claude",
    harness: "claude-sdk",
    agentType: "developer",
    provider: "claude",
    model: "opus",
    thinkingLevel: "high",
  });
  const state = storedState("view-claude");
  expect(state.model).toMatchObject({ provider: "claude-sdk", id: "opus" });
  expect(state.thinkingLevel).toBe("high");
  sessionStore.upsert({
    id: "view-claude",
    harness: "claude-sdk",
    agentType: "developer",
    model: "claude-opus-5-5[1m]",
  });
  expect(storedState("view-claude").model).toMatchObject({
    provider: "claude-sdk",
    id: "opus",
  });
});

test("a stored pi session reports its catalog model", () => {
  sessionStore.upsert({
    id: "view-pi",
    harness: "pi",
    agentType: "developer",
    provider: "openai-codex",
    model: "gpt-6-sol",
    thinkingLevel: "high",
  });
  const state = storedState("view-pi");
  expect(state.model).toMatchObject({
    provider: "openai-codex",
    id: "gpt-6-sol",
  });
  expect(state.thinkingLevel).toBe("high");
});

test("an id no catalog offers resolves to no model rather than a guess", () => {
  sessionStore.upsert({
    id: "view-unknown",
    harness: "claude-sdk",
    agentType: "developer",
    provider: "claude",
    model: "retired-model",
  });
  expect(storedState("view-unknown").model).toBeUndefined();
});

test("a directly spawned child's state names its spawner; no other session's does", () => {
  for (const id of ["view-child", "view-plain"])
    sessionStore.upsert({ id, harness: "pi", agentType: "developer" });
  directPeerChildStore.record({
    childSessionId: "view-child",
    spawnerSessionId: "view-spawner",
    costClass: "counted",
    source: { kind: "profile", profileId: "pr_test" },
    provider: "openai-codex",
    modelId: "gpt-6-sol",
    thinkingLevel: "high",
    credentialProfileId: "acct",
    createdAt: Date.now(),
  });
  for (const facts of [
    storedFacts("view-child"),
    ...liveFixtures(storedFacts("view-child")),
  ]) {
    expect(buildSessionState("view-child", facts).directSpawnedBy).toBe(
      "view-spawner",
    );
    expect(buildSessionState("view-plain", facts)).not.toHaveProperty(
      "directSpawnedBy",
    );
  }
});

test("undefined optionals are absent, and only coding live facts enable live projections", () => {
  const detached: SessionNativeFacts = {
    harness: "pi",
    agentType: "assistant",
    kind: "assistant",
    thinkingLevel: "off",
    sessionFile: undefined,
    forkOrigin: undefined,
    model: undefined,
    mode: undefined,
    live: undefined,
  };
  const state = buildSessionState("no-row", detached);
  expect(state).toEqual({
    sessionId: "no-row",
    harness: "pi",
    agentType: "assistant",
    thinkingLevel: "off",
    canSteer: false,
    answeredQuestions: [],
    tasks: [],
    relatedGlobalTasks: [],
    peerPrompts: { threads: [], truncated: false },
    peerPromptPeers: [],
  });
  expect(Object.values(state)).not.toContain(undefined);
  for (const facts of liveFixtures(detached)) {
    const live = buildSessionState("no-row", {
      ...facts,
      live: { ...facts.live!, toolLoading: undefined },
    });
    for (const field of [
      "toolExposure",
      "activeSkills",
      "skillInvocations",
      "browserRuntimes",
      "artifacts",
      "pendingPostReloadContinuation",
    ])
      expect(live).not.toHaveProperty(field);
    expect(live.sessionFile).toBe(facts.sessionFile);
    expect(live.canSteer).toBe(facts.live!.canSteer);
    expect(Object.values(live)).not.toContain(undefined);
  }
  const coding = buildSessionState("no-row", {
    ...detached,
    kind: "developer",
    agentType: "developer",
  });
  expect(coding.activeSkills).toEqual([]);
  expect(coding.artifacts).toEqual([]);
  expect(coding).not.toHaveProperty("skillInvocations");
  expect(coding).not.toHaveProperty("browserRuntimes");
});

test("lazy native transcripts are read only for rendered nonempty frozen skills", () => {
  const transcript = vi.fn(() => ({ calls: [], succeeded: new Set<string>() }));
  const facts: SessionNativeFacts = {
    harness: "pi",
    kind: "assistant",
    agentType: "assistant",
    thinkingLevel: "off",
    live: { canSteer: true, skillInvocationTranscript: transcript },
  };
  expect(buildSessionState("lazy-skills", facts)).not.toHaveProperty(
    "skillInvocations",
  );
  expect(
    buildSessionState("lazy-skills", {
      ...facts,
      kind: "developer",
      agentType: "developer",
    }).skillInvocations,
  ).toEqual([]);
  expect(transcript).not.toHaveBeenCalled();
  sessionStore.freezeSkills("lazy-skills", '["review"]');
  expect(
    buildSessionState("lazy-skills", {
      ...facts,
      kind: "developer",
      agentType: "developer",
    }).skillInvocations,
  ).toEqual([]);
  expect(transcript).toHaveBeenCalledExactlyOnceWith(["review"]);
});

test("the owner reads fresh stored restrictions and compaction, not captured view metadata", () => {
  sessionStore.upsert({
    id: "fresh-window",
    harness: "pi",
    agentType: "developer",
    provider: "openai-codex",
    model: "gpt-6-sol",
  });
  const meta = sessionStore.get("fresh-window")!;
  const view = new ViewSession(meta);
  sessionStore.setCompactionWindow(meta.id, 80_000);
  expect(view.state()).toMatchObject({ compactionWindow: { tokens: 80_000 } });
  expect(view.state()).not.toHaveProperty("requiresEnterprise");
  sessionStore.setCompactionWindow(meta.id, 60_000);
  expect(view.state().compactionWindow?.tokens).toBe(60_000);
  const fixtures = [
    storedFacts(meta.id),
    ...liveFixtures(storedFacts(meta.id)),
  ];
  // Model a persisted restriction correction. Ordinary metadata upserts cannot change it.
  getDb()
    .prepare("UPDATE session_index SET requires_enterprise = 1 WHERE id = ?")
    .run(meta.id);
  expect(view.state().requiresEnterprise).toBe(true);
  for (const facts of fixtures)
    expect(buildSessionState(meta.id, facts).requiresEnterprise).toBe(true);
  sessionStore.markDeleted(meta.id);
  expect(view.state().requiresEnterprise).toBe(true);
  expect(view.state()).not.toHaveProperty("compactionWindow");
  const unstored = new ViewSession({
    ...meta,
    id: "unstored",
    requiresEnterprise: true,
  });
  expect(unstored.state()).not.toHaveProperty("requiresEnterprise");
  expect(unstored.state()).not.toHaveProperty("compactionWindow");
});

test("question, approval and task-choice priority comes from the app stores", async () => {
  const id = "projection";
  const state = () => storedState(id);
  const card = cards.createPullRequestCard(
    {
      sessionId: id,
      status: "choosing-task",
      title: "Choose Task",
      headBranch: "feature",
      baseBranch: "main",
    },
    {
      repoRoot: tmp,
      sessionKind: "workshop",
      sessionId: id,
      headBranch: "feature",
      baseBranch: "main",
      draft: false,
    },
  );
  const approval = approvals.createApproval({
    sessionId: id,
    kind: "commit",
    title: "Approve commit",
    body: { kind: "commit", message: "Test commit", files: [] },
  });
  expect(state().idleReason).toBe("awaiting_question");
  questions.clearPendingQuestion(id);
  expect(state().idleReason).toBe("awaiting_approval");
  await approvals.resolveApproval(approval.id, "rejected");
  expect(state().idleReason).toBe("awaiting_task_choice");
  cards.patchPullRequestCard(card.id, { status: "closed" });
  expect(state()).not.toHaveProperty("idleReason");
  expect(state()).not.toHaveProperty("pendingQuestions");
});

const failedReads = [
  {
    field: "tasks",
    fallback: [],
    fail: () => vi.spyOn(tasks, "listSessionTasks"),
  },
  {
    field: "relatedGlobalTasks",
    fallback: [],
    fail: () => vi.spyOn(tasks, "listRelatedGlobalTasks"),
  },
  {
    field: "originTask",
    fallback: undefined,
    fail: () => vi.spyOn(tasks, "findOriginTask"),
  },
  {
    field: "worktreeId",
    fallback: undefined,
    fail: () => vi.spyOn(worktrees, "worktreeIdForSession"),
  },
  {
    field: "worktreeMissing",
    fallback: undefined,
    fail: () => vi.spyOn(cwd, "sessionWorktreeMissing"),
  },
] as const;

test.each(failedReads)(
  "a failed $field read logs once and degrades only that field",
  ({ field, fallback, fail }) => {
    const facts = storedFacts("projection");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const fixture of [facts, ...liveFixtures(facts)]) {
      const before = buildSessionState("projection", fixture);
      const read = fail().mockImplementationOnce(() => {
        throw new Error("store unavailable");
      });
      warning.mockClear();
      const state = buildSessionState("projection", fixture);
      expect(state[field]).toEqual(fallback);
      const expected = { ...before, [field]: fallback };
      if (fallback === undefined) delete expected[field];
      expect(state).toEqual(expected);
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("Session state"),
        "store unavailable",
      );
      expect(Object.values(state)).not.toContain(undefined);
      read.mockRestore();
    }
  },
);
