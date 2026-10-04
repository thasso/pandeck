/**
 * Agent-spawned peer sessions: proposal validation, approve-time edits, and
 * what one approval actually creates ([Task-553](pa://task/553)).
 *
 * The model/account/thinking pickers are the human's authority, so the
 * assertions here are mostly about WHERE a decision is allowed to fail: a row
 * the agent stated wrongly must cost a tool error with no card at all, while an
 * unavailable model must cost a note on a card the user can still fix.
 *
 * Session creation and peer delivery run through the injected deps: the real
 * ones drive `hub`, whose two harnesses have their own suites.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  ApprovalCard,
  ModelOption,
  SessionSpawnApprovalBody,
} from "@assistant/shared";

// Isolate DATA_DIR and enable the claude-sdk harness BEFORE the modules load,
// so a `claude-sdk` hint has real models to resolve against.
const tmp = mkdtempSync(join(tmpdir(), "session-spawn-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({ claudeSdk: { enabled: true } }),
);

vi.mock("./piSdk/models.ts", () => ({
  listModelsForProfile: vi.fn(async () => piModels),
  findModelForProfile: vi.fn(async () => ({
    provider: "openai-codex",
    id: "gpt-5",
  })),
}));

const piModels: ModelOption[] = [
  {
    provider: "openai-codex",
    id: "gpt-5",
    name: "GPT-5",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high"],
    contextWindow: 400_000,
  },
];

const { insertWorktree, updateWorktree, worktreeIdForSession } =
  await import("./db/worktreeStore.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const piModelApi = await import("./piSdk/models.ts");
const worktreeResolve = await import("./worktrees/worktreeResolve.ts");
const { projectStore } = await import("./db/projectStore.ts");
const { createTask, deleteTask } = await import("./tasks.ts");
const {
  buildSpawnProposal,
  prepareSpawnApproval,
  setSessionSpawnDepsForTests,
  MAX_SPAWN_ROWS,
  MAX_SPAWN_TITLE_CHARS,
  SpawnProposalError,
} = await import("./sessionSpawn.ts");
const {
  resolveApproval,
  approvalsForSession,
  createApproval,
  setApprovalBroadcastForTests,
} = await import("./pendingApprovals.ts");
const { sessionSpawnTools } =
  await import("./tools/sessions/sessionSpawnTool.ts");
const { shouldAutoNamePiSession } = await import("./piSdk/titleState.ts");
const { getSettings, updateSettings } = await import("./settings.ts");
const { listCredentialProfiles } = await import("./credentialProfiles.ts");
const { resetDirectPeerChildrenForTests } =
  await import("./peerSpawnRuntimes.ts");
const { createSession } = await import("./harnesses/create.ts");
const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const skillResolver = await import("./skills/skillResolver.ts");

const spawnTool = sessionSpawnTools()[0]!;
const SENDER = "spawner-session";

/** Calls the injected deps recorded, so a test can assert what was created. */
interface Recorded {
  claude: Array<Record<string, unknown>>;
  pi: Array<Record<string, unknown>>;
  delivered: Array<Record<string, unknown>>;
  events: string[];
}
let recorded: Recorded;
let createFails: string | undefined;
let deliverFails = false;

function activeWorktree(id: string, projectId = "spawn-proj") {
  // A real worktree belongs to a registered Project; an unregistered id is
  // dropped rather than inherited, so the fixture has to be honest about it.
  projectStore.put({
    id: projectId,
    name: "Spawn Project",
    key: "SP",
    description: "",
    status: "active",
    localPaths: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  // The folder must really exist: resolution refuses a checkout that is gone,
  // since a session would otherwise silently run somewhere else.
  const path = join(tmp, id);
  mkdirSync(path, { recursive: true });
  insertWorktree({
    id,
    projectId,
    mainRepoRoot: join(tmp, "spawn-main"),
    path,
    branch: id,
    baseBranch: "main",
    baseCommit: "0".repeat(40),
    status: "active",
    mergeStateJson: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    removedAt: null,
  });
  return id;
}

const row = (patch: Record<string, unknown> = {}) => ({
  title: "Reviewer: auth",
  agentType: "assistant" as const,
  prompt: "Review the auth refactor and report back.",
  ...patch,
});

/** Run the tool and return the card it staged. */
async function propose(rows: Array<Record<string, unknown>>) {
  const result = await spawnTool.execute(
    { operation: "propose", sessions: rows } as never,
    {
      toolCallId: "call-1",
      session: {
        sessionId: SENDER,
        harness: "pi" as const,
        agentType: "developer" as const,
      },
    } as never,
  );
  return {
    result,
    card: approvalsForSession(SENDER).at(-1) as ApprovalCard,
  };
}

const bodyOf = (card: ApprovalCard) => card.body as SessionSpawnApprovalBody;

/**
 * Survives `beforeEach`: every test mints unused ids, so no row an earlier test
 * froze or linked can answer for a new session.
 */
let counter = 0;

beforeEach(() => {
  setApprovalBroadcastForTests(() => {});
  vi.mocked(piModelApi.listModelsForProfile).mockImplementation(
    async () => piModels,
  );
  recorded = { claude: [], pi: [], delivered: [], events: [] };
  createFails = undefined;
  deliverFails = false;
  const standIn = (sessionId: string) =>
    ({ sessionId, setTitle() {}, rename() {} }) as never;
  vi.spyOn(claudeSdkStore, "acquire").mockImplementation((id: string) =>
    standIn(id),
  );
  vi.spyOn(piStore, "acquireNew").mockImplementation(async () =>
    standIn(`pi-session-${(counter += 1)}`),
  );
  setSessionSpawnDepsForTests({
    newSessionId: () => `claude-session-${(counter += 1)}`,
    findPiModel: async (_profile, provider, modelId) =>
      ({ provider, id: modelId }) as never,
    create: async (spec) => {
      if (createFails === spec.title) throw new Error("creation exploded");
      const cwd = spec.worktree?.path ?? spec.cwd;
      const started = {
        thinkingLevel: spec.thinkingLevel,
        agentType: spec.agentType,
        ...(cwd ? { cwd } : {}),
        credentialProfileId: spec.credentialProfileId,
        title: spec.title,
      };
      if (spec.harness === "claude-sdk")
        recorded.claude.push({
          id: spec.id,
          modelId: spec.modelId,
          ...started,
        });
      else {
        const model = spec.model as unknown as { provider: string; id: string };
        recorded.pi.push({
          provider: model.provider,
          modelId: model.id,
          ...started,
          promptEvidence: spec.promptEvidence,
        });
      }
      // The real creation sequence (link, freeze, title) on stand-in engines.
      return createSession(spec);
    },
    deliver: async (input) => {
      // Provenance is durable BEFORE the opening prompt is delivered, and the
      // fresh spawn is coordinator-owned from that moment.
      const spawn = sessionStore
        .spawnedParentsByChildIds([input.targetSessionId])
        .get(input.targetSessionId);
      recorded.events.push(
        `deliver:${spawn ? `${spawn.parentSessionId}:${spawn.ownership}` : "unlinked"}`,
      );
      if (deliverFails) throw new Error("delivery exploded");
      recorded.delivered.push({ ...input });
    },
    broadcastSessions: () => recorded.events.push("broadcast"),
  });
  sessionStore.upsert({
    id: SENDER,
    harness: "pi",
    agentType: "developer",
    provider: "openai-codex",
    model: "gpt-5",
    thinkingLevel: "high",
    mode: "build",
  });
});

afterEach(() => {
  setApprovalBroadcastForTests(null);
  setSessionSpawnDepsForTests(null);
  updateSettings({ peerSpawnRuntimes: [] });
  resetDirectPeerChildrenForTests();
  vi.restoreAllMocks();
});

/* ----------------------------- proposal shape ----------------------------- */

test("a proposal stages one pending card and creates nothing", async () => {
  const { result, card } = await propose([
    row(),
    row({ title: "Implementer" }),
  ]);

  expect(result.terminate).toBe(true);
  expect(card.kind).toBe("sessionSpawn");
  expect(card.status).toBe("pending");
  expect(bodyOf(card).items.map((item) => item.title)).toEqual([
    "Reviewer: auth",
    "Implementer",
  ]);
  expect(recorded.claude).toHaveLength(0);
  expect(recorded.pi).toHaveLength(0);
  expect(recorded.delivered).toHaveLength(0);
});

test("an un-hinted row inherits the proposing session's runtime", async () => {
  const { card } = await propose([row()]);

  const [item] = bodyOf(card).items;
  expect(item?.provider).toBe("openai-codex");
  expect(item?.modelId).toBe("gpt-5");
  expect(item?.thinkingLevel).toBe("high");
  expect(item?.modelWarning).toBeUndefined();
});

test("a thinking hint the model cannot do is lowered, never raised", async () => {
  const { card } = await propose([row({ thinkingLevel: "max" })]);

  expect(bodyOf(card).items[0]?.thinkingLevel).toBe("high");
});

test("an unavailable model hint becomes a note, not a refusal", async () => {
  const { card } = await propose([
    row({ provider: "openai-codex", modelId: "gpt-9-imaginary" }),
  ]);

  const [item] = bodyOf(card).items;
  expect(item?.modelId).toBe("gpt-5");
  expect(item?.modelWarning).toContain("gpt-9-imaginary");
  expect(card.status).toBe("pending");
});

test("a model hint with no provider is still reported when it fails", async () => {
  // `modelId: "sonnet"` from an openai-codex parent resolves as
  // `openai-codex/sonnet` and fails. The card must say so — silently running
  // the parent's model would misrepresent what the agent asked for.
  const { card } = await propose([row({ modelId: "sonnet" })]);

  const [item] = bodyOf(card).items;
  expect(item?.modelId).toBe("gpt-5");
  expect(item?.modelWarning).toContain("openai-codex/sonnet");
});

/* --------------------------- refusals with no card ------------------------- */

test.each([
  ["no title", { title: "   " }],
  ["an overlong title", { title: "x".repeat(MAX_SPAWN_TITLE_CHARS + 1) }],
  ["an unknown persona", { agentType: "reviewer" }],
  ["no prompt", { prompt: "" }],
  ["an unknown worktree", { worktreeId: "wt-nope" }],
  ["a developer with no worktree", { agentType: "developer" }],
  ["an unknown project", { projectId: "no-such-project" }],
  ["an unknown Task", { taskId: "424242" }],
])("%s is refused before any card exists", async (_label, patch) => {
  const before = approvalsForSession(SENDER).length;
  await expect(propose([row(patch)])).rejects.toThrow();
  expect(approvalsForSession(SENDER)).toHaveLength(before);
});

test(`more than ${MAX_SPAWN_ROWS} rows is refused`, async () => {
  await expect(
    buildSpawnProposal({
      senderSessionId: SENDER,
      rows: Array.from({ length: MAX_SPAWN_ROWS + 1 }, () => ({
        title: "One",
        agentType: "assistant" as const,
        prompt: "hello",
      })),
    }),
  ).rejects.toBeInstanceOf(SpawnProposalError);
});

/* -------------------------------- targets --------------------------------- */

test("a project's MAIN checkout is a valid target, by its synthetic id", async () => {
  // `worktree_status` shows main checkouts as `main:<projectId>`, so an agent
  // will copy that id — resolution has to accept it like any other worktree.
  const repo = join(tmp, "mainrepo");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "readme.md"), "hi\n");
  git("add", "-A");
  git("commit", "-m", "init");
  projectStore.put({
    id: "main-spawn-proj",
    name: "Main Spawn Project",
    key: "MSP",
    description: "",
    status: "active",
    localPaths: [{ path: repo, kind: "repo", match: "prefix" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const { card } = await propose([
    row({ agentType: "developer", worktreeId: "main:main-spawn-proj" }),
  ]);

  const [item] = bodyOf(card).items;
  expect(item?.worktreeId).toBe("main:main-spawn-proj");
  expect(item?.projectId).toBe("main-spawn-proj");

  await resolveApproval(card.id, "approved");
  expect(recorded.pi[0]?.cwd).toBe(realpathSync(repo));
});

test("a developer row carries its worktree, project and Task into the card", async () => {
  activeWorktree("wt-dev");
  const task = createTask({
    title: "Refactor auth",
    source: { createdBy: "user" },
  });

  const { card } = await propose([
    row({ agentType: "developer", worktreeId: "wt-dev", taskId: task.id }),
  ]);

  const [item] = bodyOf(card).items;
  expect(item?.worktreeId).toBe("wt-dev");
  expect(item?.projectId).toBe("spawn-proj");
  expect(item?.taskId).toBe(task.id);
  expect(item?.taskTitle).toBe("Refactor auth");
});

/* ------------------------ approve-time settlement ------------------------- */

const pendingCard = (
  item: Partial<Record<string, unknown>> = {},
): ApprovalCard =>
  createApproval({
    sessionId: SENDER,
    kind: "sessionSpawn",
    title: "Start a session",
    body: {
      kind: "sessionSpawn",
      items: [
        {
          rowId: "row_1",
          title: "Reviewer",
          agentType: "assistant",
          prompt: "review",
          responseRequested: false,
          provider: "openai-codex",
          modelId: "gpt-5",
          credentialProfileId: "default",
          thinkingLevel: "medium",
          ...item,
        },
      ],
    },
  });

test("an edit for a row this card does not have is refused, card still pending", async () => {
  const { card } = await propose([row()]);

  await expect(
    resolveApproval(card.id, "approved", {
      kind: "sessionSpawn",
      items: [{ rowId: "row_nope", thinkingLevel: "low" }],
    }),
  ).rejects.toThrow(/no row/);
  expect(approvalsForSession(SENDER).at(-1)?.status).toBe("pending");
  expect(recorded.pi).toHaveLength(0);
});

test("an edit naming an account that cannot run the model is refused", async () => {
  const card = pendingCard({ provider: "claude-sdk", modelId: "sonnet" });

  await expect(
    prepareSpawnApproval(card, {
      kind: "sessionSpawn",
      items: [{ rowId: "row_1", credentialProfileId: "default" }],
    }),
  ).rejects.toThrow(/cannot run claude-sdk models/);
});

test("an edit naming a model the chosen account does not offer is refused", async () => {
  const card = pendingCard();

  await expect(
    prepareSpawnApproval(card, {
      kind: "sessionSpawn",
      items: [{ rowId: "row_1", modelId: "gpt-9-imaginary" }],
    }),
  ).rejects.toThrow(/no longer offers/);
});

test("an UNTOUCHED row is revalidated too, and a stale one blocks approval", async () => {
  // The proposal was written when this model existed; approving must not
  // create a session on a runtime the account can no longer run.
  const card = pendingCard({ modelId: "gpt-4-retired" });

  await expect(prepareSpawnApproval(card, undefined)).rejects.toThrow(
    /no longer offers/,
  );
});

test("a skipped row is not revalidated: skipping a broken row is the way out", async () => {
  const card = pendingCard({ modelId: "gpt-4-retired" });

  const body = (await prepareSpawnApproval(card, {
    kind: "sessionSpawn",
    items: [{ rowId: "row_1", skip: true }],
  })) as SessionSpawnApprovalBody;

  expect(body.items[0]?.skipped).toBe(true);
});

test("a thinking level the newly picked model cannot do is clamped DOWN", async () => {
  // `xhigh` is above this model's ladder; the row must not silently keep it.
  const card = pendingCard({ thinkingLevel: "xhigh" });

  const body = (await prepareSpawnApproval(
    card,
    undefined,
  )) as SessionSpawnApprovalBody;

  expect(body.items[0]?.thinkingLevel).toBe("high");
});

test("resolution never rounds a thinking hint upward", async () => {
  // `minimal` is missing from the model's ladder. The answer is the greatest
  // supported level BELOW it, never the ceiling.
  const { card } = await propose([row({ thinkingLevel: "minimal" })]);

  expect(bodyOf(card).items[0]?.thinkingLevel).toBe("off");
});

test("the user's pick replaces the proposal's model and clears its note", async () => {
  const { card } = await propose([
    row({ provider: "openai-codex", modelId: "gpt-9-imaginary" }),
  ]);
  const rowId = bodyOf(card).items[0]!.rowId;

  const edited = (await prepareSpawnApproval(card, {
    kind: "sessionSpawn",
    items: [
      {
        rowId,
        provider: "openai-codex",
        modelId: "gpt-5",
        credentialProfileId: "default",
        thinkingLevel: "low",
      },
    ],
  })) as SessionSpawnApprovalBody;

  expect(edited.items[0]?.modelId).toBe("gpt-5");
  expect(edited.items[0]?.thinkingLevel).toBe("low");
  expect(edited.items[0]?.modelWarning).toBeUndefined();
});

/* -------------------------------- execution -------------------------------- */

test("approving creates each session and delivers its opening prompt", async () => {
  const { card } = await propose([
    row({ title: "Reviewer", responseRequested: true }),
    row({ title: "Implementer", provider: "claude-sdk", modelId: "sonnet" }),
  ]);

  const { card: done, outcomePrompt } = await resolveApproval(
    card.id,
    "approved",
  );

  expect(done.status).toBe("executed");
  expect(recorded.pi).toHaveLength(1);
  expect(recorded.pi[0]).toMatchObject({
    title: "Reviewer",
    modelId: "gpt-5",
    agentType: "assistant",
  });
  // Both harnesses are reachable from one batch, each on its own runtime.
  expect(recorded.claude).toHaveLength(1);
  expect(recorded.claude[0]).toMatchObject({
    title: "Implementer",
    modelId: "sonnet",
  });
  expect(recorded.delivered).toHaveLength(2);
  expect(recorded.events).toEqual([
    `deliver:${SENDER}:coordinator`,
    `deliver:${SENDER}:coordinator`,
    "broadcast",
  ]);
  // The opening prompt comes FROM the proposer, which is what gives the new
  // session a peer to answer — and, with no shared history, a fresh chain.
  expect(recorded.delivered[0]).toMatchObject({
    senderSessionId: SENDER,
    prompt: "Review the auth refactor and report back.",
    responseRequested: true,
  });
  // The agent reads its new ids out of the outcome, so they must be in it.
  for (const item of bodyOf(done).items)
    expect(outcomePrompt).toContain(item.resultSessionId);
});

test("coding peers are linked and freeze skills on both harness creation paths", async () => {
  activeWorktree("wt-skills");
  const path = join(tmp, "wt-skills");
  vi.spyOn(skillResolver, "resolveSkillNames").mockReturnValue(["alpha"]);
  const { card } = await propose([
    row({
      title: "Pi developer",
      agentType: "developer",
      worktreeId: "wt-skills",
    }),
    row({
      title: "Claude developer",
      agentType: "developer",
      provider: "claude-sdk",
      modelId: "sonnet",
      worktreeId: "wt-skills",
    }),
  ]);

  const { card: done } = await resolveApproval(card.id, "approved");

  expect(recorded.pi).toHaveLength(1);
  expect(recorded.claude).toHaveLength(1);
  for (const item of bodyOf(done).items) {
    expect(sessionStore.getSkills(item.resultSessionId!)).toBe('["alpha"]');
    expect(worktreeIdForSession(item.resultSessionId!)).toBe("wt-skills");
  }
  // What the engines were handed, not just what spawn asked for.
  expect(vi.mocked(claudeSdkStore.acquire).mock.calls[0]?.[1]?.cwd).toBe(path);
  expect(vi.mocked(piStore.acquireNew).mock.calls[0]?.[3]?.cwd).toBe(path);
});

test("a skipped row creates nothing while the rest of the batch runs", async () => {
  const { card } = await propose([
    row({ title: "Reviewer" }),
    row({ title: "Implementer" }),
  ]);
  const skipRow = bodyOf(card).items[0]!.rowId;

  const { card: done } = await resolveApproval(card.id, "approved", {
    kind: "sessionSpawn",
    items: [{ rowId: skipRow, skip: true }],
  });

  expect(done.status).toBe("executed");
  expect(recorded.delivered).toHaveLength(1);
  expect(bodyOf(done).items[0]?.resultSessionId).toBeUndefined();
  expect(bodyOf(done).items[1]?.resultSessionId).toBeTruthy();
  expect(done.resultSummary).toContain("1 skipped");
});

test("one row failing does not abort the others", async () => {
  createFails = "Implementer";
  const { card } = await propose([
    row({ title: "Reviewer" }),
    row({ title: "Implementer" }),
  ]);

  const { card: done } = await resolveApproval(card.id, "approved");

  expect(done.status).toBe("executed");
  expect(bodyOf(done).items[0]?.resultSessionId).toBeTruthy();
  expect(bodyOf(done).items[1]?.error).toContain("creation exploded");
  expect(done.resultSummary).toContain("1 not created");
});

test("a session that failed delivery is still reported, never orphaned", async () => {
  deliverFails = true;
  const { card } = await propose([row({ title: "Reviewer" })]);

  const { card: done, outcomePrompt } = await resolveApproval(
    card.id,
    "approved",
  );

  // The session exists — hiding it because the prompt failed would leave a real
  // sidebar entry that neither the user nor the agent can account for.
  const [item] = bodyOf(done).items;
  expect(item?.resultSessionId).toBeTruthy();
  expect(item?.error).toContain("delivery exploded");
  expect(outcomePrompt).toContain(item!.resultSessionId!);
  expect(outcomePrompt).toContain("opening prompt failed");
  expect(
    sessionStore
      .spawnedParentsByChildIds([item!.resultSessionId!])
      .get(item!.resultSessionId!),
  ).toMatchObject({ parentSessionId: SENDER, ownership: "coordinator" });
  expect(recorded.events).toEqual([
    `deliver:${SENDER}:coordinator`,
    "broadcast",
  ]);
});

test("a Task deleted after the proposal stops the row BEFORE a session exists", async () => {
  const task = createTask({
    title: "Doomed task",
    source: { createdBy: "user" },
  });
  const { card } = await propose([row({ taskId: task.id })]);
  deleteTask(task.id);

  const { card: done } = await resolveApproval(card.id, "approved");

  expect(done.status).toBe("failed");
  expect(bodyOf(done).items[0]?.resultSessionId).toBeUndefined();
  expect(bodyOf(done).items[0]?.error).toContain("was deleted");
  expect(recorded.pi).toHaveLength(0);
});

test("a spawned session is bound to its Project and claims it in its evidence", async () => {
  activeWorktree("wt-ctx");
  const { card } = await propose([
    row({ agentType: "developer", worktreeId: "wt-ctx" }),
  ]);

  const { card: done } = await resolveApproval(card.id, "approved");

  // The claim and the context now come from one resolution, so a spawned
  // session gets the Project it was shown ([Task-554](pa://task/554)).
  const sessionId = bodyOf(done).items[0]!.resultSessionId!;
  expect(projectStore.sessionProjectOf(sessionId)).toBe("spawn-proj");
  expect(recorded.pi[0]?.promptEvidence).toEqual({
    hasAttachments: false,
    projectId: "spawn-proj",
  });
});

test("a worktree Task row still binds the Project the card showed", async () => {
  // The common spawn shape: a developer row in a worktree, working on a Task
  // that carries no Project of its own. The card names the worktree's Project,
  // so the session must actually get it.
  activeWorktree("wt-taskctx");
  const task = createTask({
    title: "Projectless work",
    source: { createdBy: "user" },
  });
  const { card } = await propose([
    row({ agentType: "developer", worktreeId: "wt-taskctx", taskId: task.id }),
  ]);
  expect(bodyOf(card).items[0]?.projectId).toBe("spawn-proj");

  const { card: done } = await resolveApproval(card.id, "approved");

  const sessionId = bodyOf(done).items[0]!.resultSessionId!;
  expect(recorded.pi[0]?.promptEvidence).toEqual({
    hasAttachments: false,
    projectId: "spawn-proj",
  });
  // Pinned, so the deferred first turn carries that Project too.
  expect(projectStore.sessionProjectOf(sessionId)).toBe("spawn-proj");
});

test("a Task with its OWN Project overrides the worktree's", async () => {
  activeWorktree("wt-override");
  projectStore.put({
    id: "other-proj",
    name: "Other Project",
    key: "OP",
    description: "",
    status: "active",
    localPaths: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const task = createTask({
    title: "Cross-project work",
    projectId: "other-proj",
    source: { createdBy: "user" },
  });
  const { card } = await propose([
    row({ agentType: "developer", worktreeId: "wt-override", taskId: task.id }),
  ]);

  await resolveApproval(card.id, "approved");

  expect(recorded.pi[0]?.promptEvidence).toEqual({
    hasAttachments: false,
    projectId: "other-proj",
  });
});

test("a Project removed after the proposal stops the row before creation", async () => {
  // The Project is an `in_project` edge and frozen prompt evidence, so starting
  // the session anyway would drop the very context the card displayed.
  projectStore.put({
    id: "doomed-proj",
    name: "Doomed Project",
    key: "DP",
    description: "",
    status: "active",
    localPaths: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const { card } = await propose([row({ projectId: "doomed-proj" })]);
  projectStore.remove("doomed-proj");

  const { card: done } = await resolveApproval(card.id, "approved");

  expect(done.status).toBe("failed");
  expect(bodyOf(done).items[0]?.resultSessionId).toBeUndefined();
  expect(bodyOf(done).items[0]?.error).toContain("removed from the registry");
  expect(recorded.pi).toHaveLength(0);
});

test("a worktree removed after the proposal fails that row legibly", async () => {
  activeWorktree("wt-doomed");
  const { card } = await propose([
    row({ agentType: "developer", worktreeId: "wt-doomed" }),
  ]);
  updateWorktree("wt-doomed", { status: "removed", removedAt: Date.now() });

  const { card: done } = await resolveApproval(card.id, "approved");

  expect(done.status).toBe("failed");
  expect(bodyOf(done).items[0]?.error).toContain("removed");
});

test("the agent's title reaches creation, so nothing is auto-named", async () => {
  const { card } = await propose([
    row({ title: "Reviewer: auth" }),
    row({ title: "Impl: auth", provider: "claude-sdk", modelId: "sonnet" }),
  ]);

  await resolveApproval(card.id, "approved");

  // A title present at creation is what suppresses naming on BOTH harnesses:
  // `setTitle` marks the Claude session named, and a stored pi title makes
  // `shouldAutoNamePiSession` false on the first prompt.
  expect(recorded.pi[0]?.title).toBe("Reviewer: auth");
  expect(recorded.claude[0]?.title).toBe("Impl: auth");
  expect(
    shouldAutoNamePiSession({
      sessionManager: { getBranch: () => [] },
      storedTitle: String(recorded.pi[0]?.title),
    }),
  ).toBe(false);
});

test("rejecting creates nothing and tells the agent so", async () => {
  const { card } = await propose([row()]);

  const { card: done, outcomePrompt } = await resolveApproval(
    card.id,
    "rejected",
  );

  expect(done.status).toBe("rejected");
  expect(recorded.pi).toHaveLength(0);
  expect(recorded.delivered).toHaveLength(0);
  expect(outcomePrompt).toContain("REJECTED");
});

/* ---------------------- direct spawn on approved runtimes ------------------ */

/** The accounts this fixture really has, so a roster row names a live one. */
function accountFor(provider: "openai-codex" | "claude"): string {
  const profile = listCredentialProfiles().find(
    (candidate) => candidate.provider === provider && candidate.enabled,
  );
  if (!profile) throw new Error(`no ${provider} account in the fixture`);
  return profile.id;
}

function approveRuntimes(
  rows: Array<Record<string, unknown>> = [
    {
      id: "pr_terra",
      name: "Codex implementer",
      relativeCost: "low",
      description: "Use for focused implementation and fixes.",
      credentialProfileId: accountFor("openai-codex"),
      provider: "openai-codex",
      modelId: "gpt-5",
      thinkingLevel: "medium",
      enabled: true,
    },
    {
      id: "pr_sonnet",
      name: "Claude reviewer",
      relativeCost: "high",
      description: "Use for final cross-family review.",
      credentialProfileId: accountFor("claude"),
      provider: "claude-sdk",
      modelId: "sonnet",
      thinkingLevel: "low",
      enabled: true,
    },
  ],
) {
  updateSettings({ peerSpawnRuntimes: rows as never });
  return getSettings().peerSpawnRuntimes;
}

/** The text block of a tool result, which is all these paths return. */
function textOf(result: { content: unknown[] }): string {
  const block = result.content[0] as { text?: string } | undefined;
  return String(block?.text ?? "");
}

async function runSpawnOperation(
  operation: "profiles" | "spawn" | "propose",
  sessions?: Array<Record<string, unknown>>,
) {
  return await spawnTool.execute(
    { operation, ...(sessions ? { sessions } : {}) } as never,
    {
      toolCallId: `call-${operation}`,
      session: {
        sessionId: SENDER,
        harness: "pi" as const,
        agentType: "developer" as const,
      },
    } as never,
  );
}

/** Run the tool on the direct path and return its text. */
async function spawnDirect(rows: Array<Record<string, unknown>>) {
  return textOf(await runSpawnOperation("spawn", rows));
}

test('operation "profiles" lists family and user-authored selection metadata', async () => {
  approveRuntimes();

  const text = textOf(await runSpawnOperation("profiles"));

  // Enough for "prefer cross-model-family review" without inferring anything
  // from a provider string or a model name.
  expect(text).toContain("pr_terra");
  expect(text).toContain("family gpt");
  expect(text).toContain("user-set relative cost low");
  expect(text).toContain("Use for focused implementation and fixes.");
  expect(text).toContain("pr_sonnet");
  expect(text).toContain("family claude");
  expect(text).toContain("Use for final cross-family review.");
  expect(text).not.toContain("terminate");
  expect(recorded.pi).toHaveLength(0);
});

test('operation "profiles" states when no selection hint was provided', async () => {
  approveRuntimes([
    {
      id: "pr_terra",
      name: "Codex implementer",
      relativeCost: "unknown",
      credentialProfileId: accountFor("openai-codex"),
      provider: "openai-codex",
      modelId: "gpt-5",
      thinkingLevel: "medium",
      enabled: true,
    },
  ]);

  const text = textOf(await runSpawnOperation("profiles"));

  expect(text).toContain("user-set relative cost unknown");
  expect(text).toContain("No user selection hint provided.");
});

test('operation "profiles" remains available in persisted Plan mode', async () => {
  approveRuntimes();
  sessionStore.upsert({
    id: SENDER,
    harness: "pi",
    agentType: "developer",
    mode: "plan",
  });

  await expect(runSpawnOperation("profiles")).resolves.toBeTruthy();
  expect(recorded.pi).toHaveLength(0);
  expect(recorded.claude).toHaveLength(0);
});

test.each(["spawn", "propose"] as const)(
  'operation "%s" is refused in persisted Plan mode before any side effect',
  async (operation) => {
    approveRuntimes();
    sessionStore.upsert({
      id: SENDER,
      harness: "pi",
      agentType: "developer",
      mode: "plan",
    });
    const approvalsBefore = approvalsForSession(SENDER).length;
    const sessions = [
      {
        ...row(),
        ...(operation === "spawn" ? { profileId: "pr_terra" } : {}),
      },
    ];

    await expect(runSpawnOperation(operation, sessions)).rejects.toThrow(
      /Build-only.*profiles.*Plan mode/,
    );
    expect(approvalsForSession(SENDER)).toHaveLength(approvalsBefore);
    expect(recorded.pi).toHaveLength(0);
    expect(recorded.claude).toHaveLength(0);
    expect(recorded.delivered).toHaveLength(0);
  },
);

test("profiles, spawn and propose all remain available in Build mode", async () => {
  approveRuntimes();
  const approvalsBefore = approvalsForSession(SENDER).length;

  await expect(runSpawnOperation("profiles")).resolves.toBeTruthy();
  await spawnDirect([{ ...row(), profileId: "pr_terra" }]);
  await propose([row({ title: "Proposed reviewer" })]);

  expect(recorded.pi).toHaveLength(1);
  expect(recorded.delivered).toHaveLength(1);
  expect(approvalsForSession(SENDER)).toHaveLength(approvalsBefore + 1);
});

test("a direct batch creates both harnesses and reports ids, runtime and family", async () => {
  approveRuntimes();

  const text = await spawnDirect([
    { ...row({ title: "Implementer" }), profileId: "pr_terra" },
    { ...row({ title: "Reviewer" }), profileId: "pr_sonnet" },
  ]);

  expect(recorded.pi[0]).toMatchObject({
    title: "Implementer",
    modelId: "gpt-5",
    thinkingLevel: "medium",
  });
  expect(recorded.claude[0]).toMatchObject({
    title: "Reviewer",
    modelId: "sonnet",
    thinkingLevel: "low",
  });
  expect(recorded.delivered).toHaveLength(2);
  // The coordinator must be able to address and compare them without reading
  // anyone's transcript.
  for (const delivered of recorded.delivered)
    expect(text).toContain(String(delivered.targetSessionId));
  expect(text).toContain("family gpt");
  expect(text).toContain("family claude");
  expect(recorded.events).toEqual([
    `deliver:${SENDER}:coordinator`,
    `deliver:${SENDER}:coordinator`,
    "broadcast",
  ]);
});

test("a direct child keeps its spawn edge when opening-prompt delivery fails", async () => {
  approveRuntimes();
  deliverFails = true;

  const text = await spawnDirect([
    { ...row({ title: "Reviewer" }), profileId: "pr_terra" },
  ]);

  expect(text).toContain("created, but its opening prompt failed");
  const childId = text.match(/→ session ([A-Za-z0-9._-]+)/)?.[1];
  expect(childId).toBeTruthy();
  expect(
    sessionStore.spawnedParentsByChildIds([childId!]).get(childId!),
  ).toMatchObject({ parentSessionId: SENDER, ownership: "coordinator" });
  expect(recorded.events).toEqual([
    `deliver:${SENDER}:coordinator`,
    "broadcast",
  ]);
});

test("the child is told to report back to its coordinator, exactly once", async () => {
  approveRuntimes();

  await spawnDirect([
    {
      ...row({ title: "Implementer", prompt: "Do the work." }),
      profileId: "pr_terra",
    },
  ]);

  const prompt = String(recorded.delivered[0]?.prompt ?? "");
  expect(prompt).toContain("Do the work.");
  expect(prompt).toContain(SENDER);
  expect(prompt).toContain("session_send_prompt");
  expect(prompt.split("Reporting back to your coordinator").length - 1).toBe(1);
  // A coordinator that pastes the route in itself does not get it twice.
  recorded.delivered = [];
  await spawnDirect([
    { ...row({ title: "Second", prompt }), profileId: "pr_terra" },
  ]);
  expect(
    String(recorded.delivered[0]?.prompt ?? "").split(
      "Reporting back to your coordinator",
    ).length - 1,
  ).toBe(1);
});

test("a direct row awaits an answer unless it explicitly says otherwise", async () => {
  approveRuntimes();

  await spawnDirect([
    { ...row({ title: "Implementer" }), profileId: "pr_terra" },
    {
      ...row({ title: "Standby" }),
      profileId: "pr_terra",
      responseRequested: false,
    },
  ]);

  expect(recorded.delivered[0]?.responseRequested).toBe(true);
  expect(recorded.delivered[1]?.responseRequested).toBe(false);
});

test.each([
  ["provider", { provider: "claude-sdk" }],
  ["modelId", { modelId: "opus" }],
  ["thinkingLevel", { thinkingLevel: "max" }],
])(
  "a direct row naming %s is refused, and nothing is created",
  async (_label, patch) => {
    approveRuntimes();

    await expect(
      spawnDirect([{ ...row(), profileId: "pr_terra", ...patch }]),
    ).rejects.toThrow(/does not accept/);
    expect(recorded.pi).toHaveLength(0);
    expect(recorded.claude).toHaveLength(0);
  },
);

test.each([
  ["credentialProfileId", { credentialProfileId: "some-account" }],
  ["accountName", { accountName: "Work Codex" }],
])(
  "a direct row smuggling %s is refused, not silently dropped",
  async (_label, patch) => {
    // The schema says additionalProperties: false, but arguments arrive as raw
    // JSON — an ignored account hint would spawn successfully while hiding the
    // request it expressed, which is the one outcome this path must not have.
    approveRuntimes();

    await expect(
      spawnDirect([{ ...row(), profileId: "pr_terra", ...patch }]),
    ).rejects.toThrow(/not a field of a session request/);
    expect(recorded.pi).toHaveLength(0);
    expect(recorded.claude).toHaveLength(0);
  },
);

test.each([
  ["provider", "as a number", { provider: 7 }],
  ["modelId", "as null", { modelId: null }],
  ["thinkingLevel", "as an empty string", { thinkingLevel: "" }],
  ["provider", "as a blank string", { provider: "   " }],
])(
  "a direct row stating %s %s is refused, never quietly dropped",
  async (_field, _shape, patch) => {
    // The parser used to keep only non-empty strings, so these reached the
    // direct path as ABSENT and the batch started on the roster's runtime with
    // the caller's runtime request leaving no trace. A stated value is a
    // statement whatever its type.
    approveRuntimes();

    await expect(
      spawnDirect([{ ...row(), profileId: "pr_terra", ...patch }]),
    ).rejects.toThrow();
    expect(recorded.pi).toHaveLength(0);
    expect(recorded.claude).toHaveLength(0);
  },
);

test("a direct row stating a runtime hint is told which operation takes it", async () => {
  approveRuntimes();

  await expect(
    spawnDirect([{ ...row(), profileId: "pr_terra", provider: 7 }]),
  ).rejects.toThrow(/operation "spawn" does not accept/);
});

test("a proposal row stating a wrong-kind profileId is refused too", async () => {
  const before = approvalsForSession(SENDER).length;

  await expect(propose([{ ...row(), profileId: null }])).rejects.toThrow(
    /belongs to operation "spawn"/,
  );

  expect(approvalsForSession(SENDER)).toHaveLength(before);
});

test.each([
  ["worktreeId", { worktreeId: 7 }],
  ["taskId", { taskId: "" }],
  ["responseRequested", { responseRequested: "yes" }],
])(
  "a row whose %s is the wrong kind is refused, not ignored",
  async (_field, patch) => {
    approveRuntimes();

    await expect(
      spawnDirect([{ ...row(), profileId: "pr_terra", ...patch }]),
    ).rejects.toThrow();
    expect(recorded.pi).toHaveLength(0);
  },
);

test("an omitted field is still omitted: undefined is not a statement", async () => {
  approveRuntimes();

  const text = await spawnDirect([
    {
      ...row({ title: "Implementer" }),
      profileId: "pr_terra",
      provider: undefined,
      worktreeId: undefined,
    },
  ]);

  expect(text).toContain("session");
  expect(recorded.pi).toHaveLength(1);
});

test("a proposal row cannot smuggle an account either", async () => {
  const before = approvalsForSession(SENDER).length;

  await expect(
    propose([{ ...row(), credentialProfileId: "some-account" }]),
  ).rejects.toThrow(/not a field of a session request/);

  expect(approvalsForSession(SENDER)).toHaveLength(before);
});

test("a runtime hint at the top level of the call is refused", async () => {
  approveRuntimes();

  await expect(
    spawnTool.execute(
      {
        operation: "spawn",
        credentialProfileId: "some-account",
        sessions: [{ ...row(), profileId: "pr_terra" }],
      } as never,
      {
        toolCallId: "call-direct",
        session: {
          sessionId: SENDER,
          harness: "pi" as const,
          agentType: "developer" as const,
        },
      } as never,
    ),
  ).rejects.toThrow(/takes only "operation" and "sessions"/);
  expect(recorded.pi).toHaveLength(0);
});

test("an unknown profileId is refused rather than proposed", async () => {
  approveRuntimes();
  const cards = approvalsForSession(SENDER).length;

  const text = await spawnDirect([{ ...row(), profileId: "pr_typo" }]);

  // Silently degrading a typo into an approval card would let a mistyped id
  // widen what an agent may ask for.
  expect(text).toMatch(/not an approved peer runtime/i);
  expect(text).toContain("No session was started.");
  expect(text).not.toContain("They were told to report back");
  expect(text).not.toContain("Keep these ids");
  expect(recorded.pi).toHaveLength(0);
  expect(approvalsForSession(SENDER)).toHaveLength(cards);
});

test("a disabled roster row cannot be spawned on", async () => {
  approveRuntimes([
    {
      id: "pr_off",
      credentialProfileId: accountFor("openai-codex"),
      provider: "openai-codex",
      modelId: "gpt-5",
      thinkingLevel: "medium",
      enabled: false,
    },
  ]);

  const text = await spawnDirect([{ ...row(), profileId: "pr_off" }]);

  expect(text).toMatch(/disabled in settings/i);
  expect(recorded.pi).toHaveLength(0);
});

test("one direct row failing leaves the others created and says which broke", async () => {
  approveRuntimes();
  createFails = "Reviewer";

  const text = await spawnDirect([
    { ...row({ title: "Implementer" }), profileId: "pr_terra" },
    { ...row({ title: "Reviewer" }), profileId: "pr_sonnet" },
  ]);

  expect(recorded.pi).toHaveLength(1);
  expect(text).toContain("Implementer");
  expect(text).toMatch(/"Reviewer" NOT started/);
  expect(text).toContain("creation exploded");
});

test("a structural mistake costs a tool error with nothing created", async () => {
  approveRuntimes();

  await expect(
    spawnDirect([
      { ...row({ title: "Implementer" }), profileId: "pr_terra" },
      { ...row({ agentType: "developer" }), profileId: "pr_terra" },
    ]),
  ).rejects.toThrow(/must run in a worktree/);
  expect(recorded.pi).toHaveLength(0);
});

/**
 * Land a Settings edit inside the window the finding names: AFTER the row's
 * runtime was first resolved and BEFORE the session is created.
 *
 * `resolveWorktreeRow` is called twice per developer row — once by structural
 * validation, once by `spawnOne` — and only the second sits in that window, so
 * the edit rides the second call. Anything earlier would be caught by the first
 * resolution and would prove nothing.
 */
function editRosterDuringCreation(rows: Array<Record<string, unknown>>): void {
  const real = worktreeResolve.resolveWorktreeRow;
  let calls = 0;
  vi.spyOn(worktreeResolve, "resolveWorktreeRow").mockImplementation(
    async (id: string) => {
      calls += 1;
      if (calls === 2) approveRuntimes(rows);
      return await real(id);
    },
  );
}

test("a Settings edit during late discovery refuses the stale runtime", async () => {
  approveRuntimes();
  activeWorktree("wt-discovery-race");
  const realResolveWorktree = worktreeResolve.resolveWorktreeRow;
  let worktreeCalls = 0;
  let lateResolution = false;
  vi.spyOn(worktreeResolve, "resolveWorktreeRow").mockImplementation(
    async (id: string) => {
      worktreeCalls += 1;
      if (worktreeCalls === 2) lateResolution = true;
      return await realResolveWorktree(id);
    },
  );
  let discoveryStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    discoveryStarted = resolve;
  });
  let finishDiscovery!: () => void;
  const discoveryGate = new Promise<void>((resolve) => {
    finishDiscovery = resolve;
  });
  vi.mocked(piModelApi.listModelsForProfile).mockImplementation(async () => {
    if (lateResolution) {
      discoveryStarted();
      await discoveryGate;
    }
    return piModels;
  });

  const spawning = spawnDirect([
    {
      ...row({ title: "Implementer", agentType: "developer" }),
      profileId: "pr_terra",
      worktreeId: "wt-discovery-race",
    },
  ]);
  await started;
  approveRuntimes([
    {
      id: "pr_terra",
      credentialProfileId: accountFor("openai-codex"),
      provider: "openai-codex",
      modelId: "gpt-5",
      thinkingLevel: "medium",
      enabled: false,
    },
  ]);
  finishDiscovery();

  const text = await spawning;
  expect(text).toMatch(/disabled in settings/i);
  expect(text).toContain("NOT started on profile pr_terra");
  expect(text).not.toContain("family gpt");
  expect(recorded.pi).toHaveLength(0);
  expect(recorded.claude).toHaveLength(0);
  expect(recorded.delivered).toHaveLength(0);
});

test("a row disabled DURING the spawn is refused, not started", async () => {
  approveRuntimes();
  activeWorktree("wt-race");
  editRosterDuringCreation([
    {
      id: "pr_terra",
      credentialProfileId: accountFor("openai-codex"),
      provider: "openai-codex",
      modelId: "gpt-5",
      thinkingLevel: "medium",
      enabled: false,
    },
  ]);

  const text = await spawnDirect([
    {
      ...row({ title: "Implementer", agentType: "developer" }),
      profileId: "pr_terra",
      worktreeId: "wt-race",
    },
  ]);

  // A paid session on an approval the human has just withdrawn is the one
  // outcome this path must never have.
  expect(text).toMatch(/disabled in settings/i);
  expect(recorded.pi).toHaveLength(0);
  expect(recorded.claude).toHaveLength(0);
  vi.restoreAllMocks();
});

test("a row re-pointed DURING the spawn runs on the current approval", async () => {
  // Editing the row is the human exercising the authority the roster exists
  // for, so the session runs on what is approved NOW — and the result reports
  // that, never the reading taken before the edit.
  approveRuntimes();
  activeWorktree("wt-repoint");
  editRosterDuringCreation([
    {
      id: "pr_terra",
      name: "Repointed",
      credentialProfileId: accountFor("claude"),
      provider: "claude-sdk",
      modelId: "sonnet",
      thinkingLevel: "low",
      enabled: true,
    },
  ]);

  const text = await spawnDirect([
    {
      ...row({ title: "Implementer", agentType: "developer" }),
      profileId: "pr_terra",
      worktreeId: "wt-repoint",
    },
  ]);

  expect(recorded.pi).toHaveLength(0);
  expect(recorded.claude[0]).toMatchObject({
    modelId: "sonnet",
    thinkingLevel: "low",
  });
  expect(text).toContain("sonnet");
  expect(text).not.toContain("gpt-5");
  vi.restoreAllMocks();
});

test("a direct developer row carries its worktree, Project and Task", async () => {
  approveRuntimes();
  activeWorktree("wt-direct");
  const task = createTask({
    title: "Direct work",
    source: { createdBy: "user" },
  });

  await spawnDirect([
    {
      ...row({ title: "Implementer", agentType: "developer" }),
      profileId: "pr_terra",
      worktreeId: "wt-direct",
      taskId: task.id,
    },
  ]);

  expect(recorded.pi[0]).toMatchObject({
    agentType: "developer",
    promptEvidence: { hasAttachments: false, projectId: "spawn-proj" },
  });
  expect(recorded.delivered[0]?.taskId).toBe(task.id);
});

test("a proposal row may not name an approved runtime", async () => {
  approveRuntimes();

  await expect(propose([{ ...row(), profileId: "pr_terra" }])).rejects.toThrow(
    /belongs to operation "spawn"/,
  );
});
