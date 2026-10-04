import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";
import {
  REVIEW_REPORT_CONVENTION,
  REVIEW_RESPONSE_CONVENTION,
} from "@assistant/shared";
import type {
  PromptAttachment,
  WorkflowActor,
  WorkflowJsonValue,
} from "@assistant/shared";
import type { WorkflowRunRow, WorkflowStepRow } from "../db/workflowStore.ts";
import type { RuntimePromptDriver } from "../session/runtimePrompt.ts";
import type { WorkflowAgentExecutorDeps } from "./agentExecutor.ts";
import type { SessionPromptEvidence } from "../promptConditions.ts";
import {
  absent,
  affirmed,
  assertPromptRules,
  forbidden,
} from "../test/promptRules.ts";

const tmp = mkdtempSync(join(tmpdir(), "workflow-agent-executor-"));
const workflowWorktreePath = join(tmp, "workflow-worktree");
mkdirSync(workflowWorktreePath);
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const store = await import("../db/workflowStore.ts");
const { ASSESSMENT_FINDINGS_MAX_CHARS, ASSESSMENT_FINDINGS_MAX_COUNT } =
  await import("@assistant/shared");
const { subagentStore } = await import("../db/subagentStore.ts");
const worktrees = await import("../db/worktreeStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { deriveTitle, SESSION_TITLE_MAX_CHARS } = await import("../sessions.ts");
const { objectRefsForSession } = await import("../db/sessionObjectStore.ts");
const { createTask, readTask } = await import("../tasks.ts");
const engine = await import("./engine.ts");
const executors = await import("./executors.ts");
const contracts = await import("./resultContracts.ts");
const { TRUNCATION_MARKER } = await import("../textBudget.ts");
const recipe = await import("./codeDeliveryRecipe.ts");
const agentExecutor = await import("./agentExecutor.ts");
const { SessionBusyError } = await import("../session/runtime/index.ts");
const { closeDb } = await import("../db/index.ts");
const { createSession } = await import("../harnesses/create.ts");
const { claudeSdkStore } = await import("../claudeSdk/claudeSdkStore.ts");
const { piStore } = await import("../piSdk/piStore.ts");
const skillResolver = await import("../skills/skillResolver.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

const ACTOR: WorkflowActor = { kind: "user", id: "test" };
let nextSession: number;
/**
 * Bumped per test and part of every minted id: session rows, freezes and
 * worktree edges outlive a test, so no new session may reuse an earlier id.
 */
let testTag = 0;
/** The id of the `n`th session this test minted. */
const sid = (kind: "pi" | "claude", n: number) => `${kind}-${testTag}-${n}`;
let prompts: Array<{
  sessionId: string;
  text: string;
  attachments: PromptAttachment[];
}>;
let rejectPrompt: Error | undefined;
let available = new Set<string>();
let createdAgentTypes: string[];
let createdCwds: Array<string | undefined>;
let createdEvidence: SessionPromptEvidence[];
let createdTitles: string[];
let busySessions = new Set<string>();
let deliveryStopped = false;
let clock = 0;
let polls = 0;
/** Survives `beforeEach`: every queued-assignment test gets unused session ids. */
let queuedAssignmentSessionBase = 100;

function driver(id: string, harness: "pi" | "claude-sdk" = "pi") {
  available.add(id);
  return {
    id,
    key: id,
    sessionId: id,
    harness,
    agentType: "developer",
    sessionFile: harness === "pi" ? `/sessions/${id}.jsonl` : undefined,
    isRunning: false,
    canSteer: true,
    contextInfo: () => ({}),
    broadcastState() {},
    createRuntimeAdapter: () => {
      throw new Error("unused test adapter");
    },
  } as unknown as RuntimePromptDriver;
}

// Engine stand-ins behind the real `createSession`, so the executor's spec
// goes through the same creation sequence a real session does.
vi.spyOn(claudeSdkStore, "acquire").mockImplementation((id, opts) => {
  // The edge must exist before Claude acquisition resolves cwd.
  assert.equal(worktrees.worktreeIdForSession(id), "wt-test");
  createdCwds.push(opts?.cwd);
  sessionStore.upsert({
    id,
    harness: "claude-sdk",
    agentType: opts?.agentType ?? "developer",
    ...(opts?.credentialProfileId
      ? { credentialProfileId: opts.credentialProfileId }
      : {}),
  });
  return {
    ...driver(id, "claude-sdk"),
    setTitle: (title: string) => createdTitles.push(title),
  } as never;
});
vi.spyOn(piStore, "acquireNew").mockImplementation(
  async (agentType, _model, _thinkingLevel, opts) => {
    createdAgentTypes.push(agentType);
    // Absent when the run's checkout is not live: pi defaults to the app CWD.
    createdCwds.push(opts?.cwd);
    createdEvidence.push(opts?.promptEvidence ?? { hasAttachments: false });
    return {
      ...driver(sid("pi", ++nextSession)),
      sessionMode: "build",
      rename: (title: string) => createdTitles.push(title),
    } as never;
  },
);

// The engine stand-ins above live for the whole file; a library seed does not.
afterEach(() => vi.mocked(skillResolver.resolveSkillNames).mockRestore?.());

function deps(): WorkflowAgentExecutorDeps {
  return {
    newSessionId: () => sid("claude", ++nextSession),
    acquireById: async (id) => (available.has(id) ? driver(id) : undefined),
    findPiModel: async (_profile, provider, id) => ({ provider, id }) as never,
    create: createSession,
    prompt: async (live, text, options) => {
      prompts.push({
        sessionId: live.sessionId,
        text,
        attachments: options.attachments,
      });
      if (rejectPrompt) throw rejectPrompt;
    },
    broadcastSessions() {},
    isSessionBusy: (sessionId) => busySessions.has(sessionId),
    now: () => clock,
    // One virtual MINUTE per poll against a real millisecond, so the bounded
    // wait costs the test milliseconds while its own assertions still get to
    // run between two polls.
    sleep: async () => {
      clock += 60_000;
      polls += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    deliveryStopped: () => deliveryStopped,
  };
}

function createRun(
  options: {
    provider?: "pi" | "claude-sdk";
    promptOverride?: string;
    useFixer?: boolean;
    useVerdict?: boolean;
    attachWorktree?: boolean;
    taskTitle?: string;
    jiraIssueKeys?: string[];
  } = {},
) {
  const task = createTask({
    title: options.taskTitle ?? `Workflow task ${Date.now()}-${Math.random()}`,
    description: "Implement and review the feature.",
    projectId: "workflow-project",
    ...(options.jiraIssueKeys ? { jiraIssueKeys: options.jiraIssueKeys } : {}),
    source: { createdBy: "user" },
  });
  const provider = options.provider ?? "pi";
  const run = store.createRun({
    taskId: Number(task.id),
    projectId: "workflow-project",
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: 2,
    maxReviewPasses: 1,
    config: {
      coordinator: roleConfig(provider),
      roles: {
        implementer: [roleConfig(provider)],
        reviewer: [roleConfig(provider)],
        fixer: options.useFixer ? [roleConfig(provider)] : [],
        verdict: options.useVerdict ? [roleConfig(provider)] : [],
      },
      ...(options.promptOverride
        ? { implementerPromptOverride: options.promptOverride }
        : {}),
    },
    actor: ACTOR,
  });
  if (options.attachWorktree !== false)
    store.attachRunWorktree(
      run.id,
      { worktreeId: "wt-test", branch: "workflow-test" },
      ACTOR,
    );
  const plan = store.appendStep({
    runId: run.id,
    kind: "agent",
    payload: {
      role: "coordinator",
      objective: "plan",
      roles: {
        implementer: [roleConfig(provider)],
        reviewer: [roleConfig(provider)],
        fixer: [],
        verdict: [],
      },
      maxReviewPasses: 1,
      resultContract: contracts.WORK_PLAN_CONTRACT_ID,
    },
    actor: ACTOR,
  });
  store.startStep(
    plan.id,
    { kind: "session", id: `seed-coordinator-${run.id}` },
    ACTOR,
  );
  store.completeStep(plan.id, {
    status: "completed",
    result: {
      status: "completed",
      summary: "simple",
      contractId: contracts.WORK_PLAN_CONTRACT_ID,
      payload: {
        complexity: "low",
        implementer: roleConfig(provider),
        reviewer: roleConfig(provider),
        ...(options.useFixer ? { fixer: roleConfig(provider) } : {}),
        ...(options.useVerdict ? { verdict: roleConfig(provider) } : {}),
        rationale: "small change",
      },
    },
    actor: ACTOR,
  });
  return { run: store.getRun(run.id)!, task };
}

function roleConfig(
  provider: "pi" | "claude-sdk",
  promptOverride?: string,
): WorkflowJsonValue {
  return {
    provider: provider === "pi" ? "openai-codex" : "claude-sdk",
    modelId: provider === "pi" ? "gpt-test" : "sonnet",
    thinkingLevel: "medium",
    credentialProfileId: `${provider}-profile`,
    family: provider === "pi" ? "gpt" : "claude",
    ...(promptOverride ? { promptOverride } : {}),
  };
}

function appendAgent(
  runId: number,
  payload: WorkflowJsonValue,
): WorkflowStepRow {
  return store.appendStep({ runId, kind: "agent", payload, actor: ACTOR });
}

function complete(
  step: WorkflowStepRow,
  contractId: string,
  payload: WorkflowJsonValue,
) {
  const current = store.getStep(step.id)!;
  store.completeStep(step.id, {
    status: "completed",
    result: { status: "completed", summary: "done", contractId, payload },
    actor: { kind: "agent", id: current.executor!.id },
  });
}

beforeEach(() => {
  store.resetWorkflowStoreForTests();
  engine.resetWorkflowEngineForTests();
  executors.resetWorkflowExecutorsForTests();
  nextSession = 0;
  testTag += 1;
  prompts = [];
  rejectPrompt = undefined;
  available = new Set();
  createdAgentTypes = [];
  createdCwds = [];
  createdEvidence = [];
  createdTitles = [];
  busySessions = new Set();
  deliveryStopped = false;
  clock = 0;
  polls = 0;
  if (worktrees.getWorktree("wt-test")) {
    worktrees.updateWorktree("wt-test", {
      status: "active",
      removedAt: null,
    });
  } else
    worktrees.insertWorktree({
      id: "wt-test",
      projectId: "workflow-project",
      mainRepoRoot: tmp,
      path: workflowWorktreePath,
      branch: "workflow-test",
      baseBranch: "main",
      baseCommit: "base",
      status: "active",
      mergeStateJson: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      removedAt: null,
    });
});

test("the coordinator can plan before a failed provision receives a worktree", async () => {
  const { run } = createRun({ attachWorktree: false });
  const plan = appendAgent(run.id, {
    role: "coordinator",
    objective: "plan",
    roles: {
      implementer: [roleConfig("pi")],
      reviewer: [roleConfig("pi")],
      fixer: [],
      verdict: [],
    },
    maxReviewPasses: 1,
    resultContract: contracts.WORK_PLAN_CONTRACT_ID,
  });

  await agentExecutor.createWorkflowAgentExecutor(deps()).dispatch({
    run,
    step: plan,
    actor: ACTOR,
  });

  const started = store.getStep(plan.id)!;
  assert.equal(started.status, "running");
  assert.equal(worktrees.worktreeIdForSession(started.executor!.id), undefined);
  assert.deepEqual(createdCwds, [undefined], "no checkout yet: the app CWD");
});

test("a coordinator falls back to CWD when its run worktree was removed", async () => {
  const { run } = createRun();
  worktrees.markWorktreeRemovedForTests("wt-test");
  const plan = appendAgent(run.id, {
    role: "coordinator",
    objective: "plan",
    roles: {
      implementer: [roleConfig("pi")],
      reviewer: [roleConfig("pi")],
      fixer: [],
      verdict: [],
    },
    maxReviewPasses: 1,
    resultContract: contracts.WORK_PLAN_CONTRACT_ID,
  });

  await agentExecutor.createWorkflowAgentExecutor(deps()).dispatch({
    run,
    step: plan,
    actor: ACTOR,
  });

  assert.deepEqual(createdCwds, [undefined], "the app CWD, not a dead path");
});

test("a role whose active worktree lost its folder is created in the app CWD, still linked", async () => {
  // The link is what lets the missing-worktree gate refuse a coding role's
  // real prompt; the stubbed `prompt` here never reaches that gate.
  const { run } = createRun();
  const step = appendAgent(run.id, {
    role: "implementer",
    objective: "implement",
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  rmSync(workflowWorktreePath, { recursive: true, force: true });
  try {
    await agentExecutor.createWorkflowAgentExecutor(deps()).dispatch({
      run,
      step,
      actor: ACTOR,
    });
  } finally {
    mkdirSync(workflowWorktreePath);
  }

  assert.deepEqual(createdCwds, [undefined], "the app CWD, not a dead path");
  const id = store.getStep(step.id)!.executor!.id;
  assert.equal(worktrees.worktreeIdForSession(id), "wt-test");
});

test("the coordinator is a constrained Task-context session in the run worktree", async () => {
  const { run } = createRun();
  const plan = appendAgent(run.id, {
    role: "coordinator",
    objective: "plan",
    roles: {
      implementer: [roleConfig("pi")],
      reviewer: [roleConfig("pi")],
      fixer: [],
      verdict: [],
    },
    maxReviewPasses: 2,
    resultContract: contracts.WORK_PLAN_CONTRACT_ID,
  });
  await agentExecutor.createWorkflowAgentExecutor(deps()).dispatch({
    run,
    step: plan,
    actor: ACTOR,
  });

  const started = store.getStep(plan.id)!;
  assert.equal(started.status, "running");
  assert.deepEqual(createdAgentTypes, ["workflow-coordinator"]);
  assert.deepEqual(createdCwds, [workflowWorktreePath]);
  assert.equal(
    sessionStore.getSkills(started.executor!.id),
    undefined,
    "a non-coding workflow coordinator never freezes library skills",
  );
  assert.equal(worktrees.worktreeIdForSession(started.executor!.id), "wt-test");
  assert.equal(prompts[0]!.attachments[0]?.role, "task-context");
  // The frozen evidence and that attachment come from ONE resolution of the
  // run's Task ([Task-554](pa://task/554)) — not from the run snapshot on one
  // side and the live Task on the other.
  assert.deepEqual(createdEvidence, [
    { hasAttachments: false, projectId: "workflow-project" },
  ]);
  assert.doesNotMatch(prompts[0]!.text, /tool search/);
  // The plan chooses two runtimes; who fixes, reviews again or judges is
  // decided later, in this session, when that evidence exists.
  assert.match(prompts[0]!.text, /Choose nothing else here/);
  assert.match(prompts[0]!.text, /the FIRST discovery reviewer/);
  assert.doesNotMatch(prompts[0]!.text, /fixer\?: \{ provider/);
  assert.match(
    prompts[0]!.text,
    /only workflow_status and session_submit_result/,
  );
  assert.match(prompts[0]!.text, /at most 2 passes/);
  assert.match(prompts[0]!.text, /Role-set guidance \(empirical/);
  assert.match(prompts[0]!.text, /different model family/);
  assert.match(prompts[0]!.text, /verification report is a CLAIM/);
});

test("the review decision reuses the coordinator's session and carries the evidence", async () => {
  const { run } = createRun();
  const executor = agentExecutor.createWorkflowAgentExecutor(deps());
  const plan = appendAgent(run.id, {
    role: "coordinator",
    objective: "plan",
    roles: {
      implementer: [roleConfig("pi")],
      reviewer: [roleConfig("pi")],
      fixer: [],
      verdict: [],
    },
    maxReviewPasses: 2,
    resultContract: contracts.WORK_PLAN_CONTRACT_ID,
  });
  await executor.dispatch({ run, step: plan, actor: ACTOR });
  const coordinatorSession = store.getStep(plan.id)!.executor!.id;
  store.completeStep(plan.id, {
    status: "completed",
    result: {
      status: "completed",
      summary: "planned",
      contractId: contracts.WORK_PLAN_CONTRACT_ID,
      payload: {
        complexity: "low",
        implementer: roleConfig("pi"),
        reviewer: roleConfig("pi"),
        rationale: "small",
      },
    },
    actor: ACTOR,
  });

  const decision = appendAgent(run.id, {
    role: "coordinator",
    objective: "review-decision",
    roles: {
      implementer: [roleConfig("pi")],
      reviewer: [roleConfig("pi"), roleConfig("claude-sdk")],
      fixer: [],
      verdict: [],
    },
    implementer: roleConfig("pi"),
    commitRange: { baseCommit: "aaa", headCommit: "bbb" },
    completedReviewPass: 1,
    maxReviewPasses: 2,
    reviewSummary: "clean, but broad",
    priorReviewers: [roleConfig("claude-sdk")],
    observations: ["the naming reads oddly"],
    ciResults: {
      outcome: "green",
      headCommit: "bbb",
      checks: [{ name: "typecheck", status: "success" }],
    },
    changes: {
      filesChanged: 2,
      insertions: 30,
      deletions: 4,
      files: [{ path: "app/server/src/x.ts", insertions: 30, deletions: 4 }],
      commitSubjects: ["do the thing"],
    },
    resultContract: contracts.REVIEW_DECISION_CONTRACT_ID,
  });
  await executor.dispatch({ run, step: decision, actor: ACTOR });

  // Deciding must not open a second session: that is what keeps the decision
  // free: a decision opens no session at all.
  assert.equal(store.getStep(decision.id)!.executor!.id, coordinatorSession);
  assert.equal(createdAgentTypes.length, 1);
  const prompt = prompts[prompts.length - 1]!.text;
  assert.match(prompt, /review pass 1 of at most 2 has PASSED/);
  assert.match(prompt, /2 file\(s\), \+30\/-4/);
  assert.match(prompt, /app\/server\/src\/x\.ts \+30\/-4/);
  assert.match(prompt, /do the thing/);
  assert.match(prompt, /the naming reads oddly/);
  assert.match(prompt, /CI results: green for exact commit bbb/);
  assert.match(prompt, /typecheck: success/);
  assert.match(prompt, /machine results for the exact commit under review/);
  assert.match(
    prompt,
    /Implementation runtime.*"modelId":"gpt-test".*"family":"gpt"/,
  );
  assert.match(
    prompt,
    /Discovery reviewers used so far.*"modelId":"sonnet".*"family":"claude"/,
  );
  assert.match(
    prompt,
    /prefer a reviewer from a family different from the implementer/,
  );
  assert.match(prompt, /prior-reviewer diversity as evidence, not enforcement/);
  assert.match(prompt, /"deliver" \| "review-again"/);
  assert.match(prompt, /only workflow_status and session_submit_result/);
});

test("fresh dispatch creates and binds a deterministically named session with worktree and Task context", async () => {
  vi.spyOn(skillResolver, "resolveSkillNames").mockReturnValue(["alpha"]);
  const { run, task } = createRun({
    promptOverride: "Prefer focused tests.",
    taskTitle: "Add the workflow widget",
  });
  const step = appendAgent(run.id, {
    role: "implementer",
    objective: "implement",
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  await agentExecutor.createWorkflowAgentExecutor(deps()).dispatch({
    run,
    step,
    actor: ACTOR,
  });

  const started = store.getStep(step.id)!;
  assert.equal(started.status, "running");
  assert.equal(started.executor?.id, sid("pi", 1));
  assert.equal(
    sessionStore.getSkills(sid("pi", 1)),
    '["alpha"]',
    "the pi workflow creation path freezes skills before prompting",
  );
  assert.equal(worktrees.worktreeIdForSession(sid("pi", 1)), "wt-test");
  assert.ok(
    objectRefsForSession(sid("pi", 1)).some(
      (ref) => ref.objectType === "task" && ref.id === task.id,
    ),
  );
  assert.equal(readTask(task.id)?.status, "doing");
  assert.equal(prompts.length, 1);
  assert.deepEqual(createdTitles, [
    `Task-${task.id} · Implementer — Add the workflow widget · Run ${run.id}`,
  ]);
  assert.equal(prompts[0]!.attachments[0]?.role, "task-context");
  assert.match(
    prompts[0]!.text,
    /tool search to load the deferred session_submit_result tool/,
  );
  assert.match(prompts[0]!.text, /Additional instructions from the user/);
  assert.ok(prompts[0]!.text.endsWith("Prefer focused tests."));
});

test("workflow session naming uses Jira and truncates only the Task title", async () => {
  const { run } = createRun({
    taskTitle: "A".repeat(200),
    jiraIssueKeys: ["NEB-1234"],
  });
  const step = appendAgent(run.id, {
    role: "reviewer",
    objective: "review",
    reviewPass: 2,
    commitRange: { baseCommit: "base", headCommit: "head" },
    resultContract: contracts.ASSESSMENT_CONTRACT_ID,
  });

  await agentExecutor.createWorkflowAgentExecutor(deps()).dispatch({
    run,
    step,
    actor: ACTOR,
  });

  assert.equal(createdTitles[0]?.length, SESSION_TITLE_MAX_CHARS);
  assert.match(
    createdTitles[0] ?? "",
    new RegExp(`^NEB-1234 · Reviewer 2 — A+… · Run ${run.id}$`),
  );
  assert.equal(
    deriveTitle(createdTitles[0], ""),
    createdTitles[0],
    "pi's display projection must preserve the trailing run identity",
  );
});

test("revise reuses the implementer while review gets an independent session", async () => {
  const { run } = createRun();
  const executor = agentExecutor.createWorkflowAgentExecutor(deps());
  const implement = appendAgent(run.id, {
    role: "implementer",
    objective: "implement",
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  await executor.dispatch({ run, step: implement, actor: ACTOR });
  complete(implement, contracts.IMPLEMENTATION_RESULT_CONTRACT_ID, {});

  const review = appendAgent(run.id, {
    role: "reviewer",
    commitRange: { baseCommit: "base", headCommit: "head" },
    resultContract: contracts.ASSESSMENT_CONTRACT_ID,
  });
  await executor.dispatch({ run, step: review, actor: ACTOR });
  complete(review, contracts.ASSESSMENT_CONTRACT_ID, {
    verdict: "revise",
    headCommit: "head",
    findings: [{ severity: "major", text: "add coverage" }],
  });

  const revise = appendAgent(run.id, {
    role: "implementer",
    objective: "revise",
    reviewedCommit: "head",
    findings: [{ severity: "major", text: "add coverage" }],
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  await executor.dispatch({ run, step: revise, actor: ACTOR });

  assert.equal(
    implement.executor?.id ?? store.getStep(implement.id)!.executor?.id,
    sid("pi", 1),
  );
  assert.equal(store.getStep(review.id)!.executor?.id, sid("pi", 2));
  assert.equal(store.getStep(revise.id)!.executor?.id, sid("pi", 1));
  assert.equal(
    prompts[2]!.attachments.length,
    0,
    "reused session already has Task context",
  );
  assert.match(prompts[2]!.text, /add coverage/);
  assert.match(prompts[2]!.text, /reviewed commit head/);
});

// A pass is a pair of eyes, not a range: a stale pass that commit/sync
// reissues for the head that actually landed goes back to the reviewer who
// read the old one.
test("a discovery review reissued for a new range returns to the same reviewer session", async () => {
  const { run } = createRun();
  const executor = agentExecutor.createWorkflowAgentExecutor(deps());
  const first = appendAgent(run.id, {
    role: "reviewer",
    objective: "review",
    reviewPass: 2,
    commitRange: { baseCommit: "base", headCommit: "head" },
    resultContract: contracts.ASSESSMENT_CONTRACT_ID,
  });
  await executor.dispatch({ run, step: first, actor: ACTOR });
  complete(first, contracts.ASSESSMENT_CONTRACT_ID, {
    verdict: "pass",
    headCommit: "moved",
    findings: [],
  });

  const reissued = appendAgent(run.id, {
    role: "reviewer",
    objective: "review",
    reviewPass: 2,
    commitRange: { baseCommit: "base", headCommit: "moved" },
    resultContract: contracts.ASSESSMENT_CONTRACT_ID,
  });
  await executor.dispatch({ run, step: reissued, actor: ACTOR });

  assert.ok(store.getStep(first.id)!.executor?.id, "the first review ran");
  assert.equal(
    store.getStep(reissued.id)!.executor?.id,
    store.getStep(first.id)!.executor?.id,
  );
  assert.equal(createdTitles.length, 1, "no second reviewer session opens");
  assert.match(prompts[1]!.text, /base\.\.moved/);
});

test("a persisted non-empty fixer choice gets its own runtime after executor restart", async () => {
  const { run } = createRun({ useFixer: true });
  const implement = appendAgent(run.id, {
    role: "implementer",
    objective: "implement",
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  await agentExecutor
    .createWorkflowAgentExecutor(deps())
    .dispatch({ run, step: implement, actor: ACTOR });
  complete(implement, contracts.IMPLEMENTATION_RESULT_CONTRACT_ID, {});

  const revise = appendAgent(run.id, {
    role: "implementer",
    objective: "revise",
    reviewedCommit: "head",
    findings: [{ severity: "major", text: "fix the race" }],
    fixer: roleConfig("pi"),
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  await agentExecutor
    .createWorkflowAgentExecutor(deps())
    .dispatch({ run, step: revise, actor: ACTOR });

  assert.equal(store.getStep(implement.id)!.executor?.id, sid("pi", 1));
  assert.equal(store.getStep(revise.id)!.executor?.id, sid("pi", 2));
  assert.match(prompts[1]!.text, /fix the race/);
});

test("the raised cap seats and names coordinator, implementer, reviewer, fixer, and verdict", async () => {
  const { run, task } = createRun({
    useFixer: true,
    useVerdict: true,
    taskTitle: "Add the workflow widget",
  });
  const executor = agentExecutor.createWorkflowAgentExecutor(deps());
  const assignments: WorkflowStepRow[] = [
    appendAgent(run.id, {
      role: "implementer",
      objective: "implement",
      resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
    }),
    appendAgent(run.id, {
      role: "reviewer",
      objective: "review",
      commitRange: { baseCommit: "base", headCommit: "head" },
      reviewPass: 1,
      resultContract: contracts.ASSESSMENT_CONTRACT_ID,
    }),
    appendAgent(run.id, {
      role: "implementer",
      objective: "revise",
      reviewedCommit: "head",
      findings: [{ severity: "major", text: "fix it" }],
      fixer: roleConfig("pi"),
      fixerLineage: "pass-1",
      resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
    }),
    appendAgent(run.id, {
      role: "verdict",
      objective: "verdict",
      commitRange: { baseCommit: "head", headCommit: "fixed" },
      findings: [{ severity: "major", text: "fix it" }],
      verdict: roleConfig("pi"),
      resultContract: contracts.ASSESSMENT_CONTRACT_ID,
    }),
  ];
  for (const assignment of assignments) {
    await executor.dispatch({ run, step: assignment, actor: ACTOR });
    const contract =
      (assignment.payload as Record<string, WorkflowJsonValue>)
        .resultContract === contracts.ASSESSMENT_CONTRACT_ID
        ? contracts.ASSESSMENT_CONTRACT_ID
        : contracts.IMPLEMENTATION_RESULT_CONTRACT_ID;
    complete(
      assignment,
      contract,
      contract === contracts.ASSESSMENT_CONTRACT_ID
        ? { verdict: "pass", headCommit: "head", findings: [] }
        : {},
    );
  }
  assert.deepEqual(
    assignments.map((assignment) => store.getStep(assignment.id)!.executor?.id),
    [sid("pi", 1), sid("pi", 2), sid("pi", 3), sid("pi", 4)],
  );
  const title = (role: string) =>
    `Task-${task.id} · ${role} — Add the workflow widget · Run ${run.id}`;
  assert.deepEqual(createdTitles, [
    title("Implementer"),
    title("Reviewer 1"),
    title("Fixer review 1"),
    title("Verdict"),
  ]);
});

test("a vanished role session is replaced, with no cap to refuse it", async () => {
  const { run } = createRun();
  const executor = agentExecutor.createWorkflowAgentExecutor(deps());
  const first = appendAgent(run.id, {
    role: "implementer",
    objective: "implement",
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  await executor.dispatch({ run, step: first, actor: ACTOR });
  complete(first, contracts.IMPLEMENTATION_RESULT_CONTRACT_ID, {});
  available.delete(sid("pi", 1));
  sessionStore.remove(sid("pi", 1));

  const replacement = appendAgent(run.id, {
    role: "implementer",
    objective: "revise",
    reviewedCommit: "head",
    findings: [{ severity: "major", text: "again" }],
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  await executor.dispatch({ run, step: replacement, actor: ACTOR });
  assert.equal(store.getStep(replacement.id)!.executor?.id, sid("pi", 2));

  // A run no longer carries a session ceiling that could refuse the
  // replacement: what it may open follows from its two ceilings, so a
  // vanished session is replaced again rather than pausing the run.
  complete(replacement, contracts.IMPLEMENTATION_RESULT_CONTRACT_ID, {});
  available.delete(sid("pi", 2));
  sessionStore.remove(sid("pi", 2));
  const third = appendAgent(run.id, {
    role: "implementer",
    objective: "revise",
    reviewedCommit: "head2",
    findings: [{ severity: "major", text: "one more" }],
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  await executor.dispatch({ run, step: third, actor: ACTOR });
  assert.equal(store.getStep(third.id)!.executor?.id, sid("pi", 3));
  assert.equal(store.getRun(run.id)!.lifecycle, "active");
});

/**
 * The role session is mid-turn when its next assignment arrives — the shape of
 * the real failure: the implementer submits its result from inside a turn, so
 * the turn is still winding down when the recipe comes back with the next one.
 */
async function busyRoleSessionRun(
  patch: (deps: WorkflowAgentExecutorDeps) => WorkflowAgentExecutorDeps,
) {
  // A removed session id is never resurrected by `sessionStore.upsert`, so an
  // id an earlier test buried would come back unresolvable and be REPLACED
  // instead of reused. Claim ids no other test in this file uses.
  nextSession = queuedAssignmentSessionBase += 10;
  const { run } = createRun();
  const executor = agentExecutor.createWorkflowAgentExecutor(patch(deps()));
  executors.registerWorkflowAgentExecutor(executor);
  const implement = appendAgent(run.id, {
    role: "implementer",
    objective: "implement",
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  await executor.dispatch({ run, step: implement, actor: ACTOR });
  complete(implement, contracts.IMPLEMENTATION_RESULT_CONTRACT_ID, {});
  const roleSession = store.getStep(implement.id)!.executor!.id;
  busySessions.add(roleSession);

  const revise = appendAgent(run.id, {
    role: "implementer",
    objective: "revise",
    reviewedCommit: "head",
    findings: [{ severity: "major", text: "add coverage" }],
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  await engine.advanceRun(run.id);
  // Nothing was handed out: the reservation is untouched and pending.
  assert.equal(store.getStep(revise.id)!.status, "pending");
  assert.equal(prompts.length, 1);
  const queued = store
    .listEvents(run.id)
    .find((event) => event.type === "observation-recorded");
  assert.deepEqual(queued?.detail, { queuedBehindTurn: roleSession });
  assert.equal(queued?.stepId, revise.id);
  return { run, revise, roleSession };
}

test("an assignment queued behind a running turn is delivered when it ends", async () => {
  const { run, revise, roleSession } = await busyRoleSessionRun((base) => ({
    ...base,
    sleep: async (ms) => {
      await base.sleep(ms);
      if (polls === 3) busySessions.clear();
    },
  }));

  await waitFor(() => prompts.length === 2);
  // The same assignment, in the same session, without a session spent on it.
  assert.equal(store.getStep(revise.id)!.status, "running");
  assert.equal(store.getStep(revise.id)!.executor?.id, roleSession);
  assert.match(prompts[1]!.text, /add coverage/);
  assert.equal(store.getRun(run.id)!.lifecycle, "active");
});

test("a turn that never ends pauses the run with the reservation still pending", async () => {
  const { run, revise, roleSession } = await busyRoleSessionRun((base) => base);

  await waitFor(() => store.getRun(run.id)!.lifecycle === "paused");
  assert.equal(store.getStep(revise.id)!.status, "pending");
  assert.equal(prompts.length, 1);
  assert.match(
    store.getRun(run.id)!.lifecycleReason ?? "",
    new RegExp(`waited 15 minutes for session ${roleSession} to finish`),
  );
  // The wait is bounded by time, not by attempts.
  assert.equal(clock >= 15 * 60_000, true);
});

test("a graceful drain holds a queued assignment for the next boot", async () => {
  const { run, revise } = await busyRoleSessionRun((base) => ({
    ...base,
    sleep: async (ms) => {
      await base.sleep(ms);
      if (polls === 2) deliveryStopped = true;
    },
  }));

  await waitFor(() => deliveryStopped);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.getStep(revise.id)!.status, "pending");
  assert.equal(store.getRun(run.id)!.lifecycle, "active");
  assert.equal(prompts.length, 1);
});

test.each([
  [
    "a refusal that precedes the turn",
    () => new SessionBusyError(sid("pi", 1)),
    { assignmentUndelivered: true },
  ],
  [
    "a failure once the turn ran",
    () => new Error("provider exploded"),
    undefined,
  ],
] as const)(
  "%s is recorded as such on the failed step",
  async (_name, error, expected) => {
    const { run } = createRun();
    rejectPrompt = error();
    const step = appendAgent(run.id, {
      role: "implementer",
      objective: "implement",
      resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
    });
    executors.registerWorkflowAgentExecutor(
      agentExecutor.createWorkflowAgentExecutor(deps()),
    );
    await engine.advanceRun(run.id);
    await waitFor(() => store.getStep(step.id)!.status === "failed");
    assert.deepEqual(store.getStep(step.id)!.result?.payload, expected);
  },
);

test("a prompt failure still ends and announces the run when the session owes delegated work", async () => {
  // The delegation invariant refuses to complete a step whose session still
  // owns delegated work — and the doc blesses users picking up role sessions,
  // so a session that has already run a step can take on a child and then meet
  // a later assignment's prompt failure. Both the strict attempt and the
  // fallback used to throw, leaving the step RUNNING on an ACTIVE run with
  // nothing to pause it: a silent stall until a restart repaired it. The
  // fallback records the failure AND finishes the job — deriving the pause and
  // telling the card — or it has only made the stall quieter.
  const { run } = createRun();
  const owing = "pi-owing";

  // A first assignment this session completed: that is what makes it a durable
  // workflow executor, and only then may it own delegated work.
  const first = appendAgent(run.id, {
    role: "implementer",
    objective: "implement",
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  sessionStore.upsert({
    id: owing,
    scope: "internal",
    harness: "pi",
    agentType: "developer",
  });
  store.startStep(first.id, { kind: "session", id: owing }, ACTOR);
  store.completeStep(first.id, {
    status: "completed",
    result: { status: "completed", summary: "built it" },
    actor: ACTOR,
  });

  // Then it takes on a child — the user's delegation, outliving this turn.
  sessionStore.upsert({
    id: `${owing}-child`,
    scope: "subagent",
    harness: "pi",
    agentType: "developer",
  });
  subagentStore.acceptInitial({
    thread: {
      parentSessionId: owing,
      sessionId: `${owing}-child`,
      profile: {
        roleName: "implementer",
        baseRole: "developer",
        provider: "openai-codex",
        modelId: "gpt-test",
        credentialProfileId: "test-profile",
        accountSource: "test",
        defaultThinking: "high",
        hardMaxThinking: "xhigh",
        executionProfileId: "test-execution",
        contractId: "implementation-result",
        contractVersion: 1,
      },
    },
    run: { initiatedBy: "agent", actualThinking: "high" },
    parentLimit: 1,
  });

  // The next assignment reuses that same role session, and its prompt fails.
  const step = appendAgent(run.id, {
    role: "implementer",
    objective: "implement",
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  available.add(owing);
  const base = deps();
  executors.registerWorkflowAgentExecutor(
    agentExecutor.createWorkflowAgentExecutor({
      ...base,
      // Rejected LATE, on a later macrotask, the way a provider timeout does.
      // The dispatcher fires the prompt with `void` and handles the rejection
      // whenever it arrives, so by then the advance loop that started this step
      // has long returned — and the failure path has to carry the run forward
      // itself rather than borrow that loop's next iteration.
      prompt: async (live, text, options) => {
        await base.prompt(live, text, options);
        await new Promise((resolve) => setTimeout(resolve, 0));
        throw new Error("provider dropped the turn");
      },
    }),
  );

  await engine.advanceRun(run.id);
  assert.equal(
    store.getRun(run.id)!.lifecycle,
    "active",
    "the loop has returned with the prompt still in flight",
  );
  await waitFor(() => store.getRun(run.id)!.lifecycle === "paused");

  const failed = store.getStep(step.id)!;
  assert.equal(failed.status, "failed", "the step ended rather than hanging");
  assert.equal(
    (failed.executor as { id: string }).id,
    owing,
    "and it really was the session owing delegated work",
  );
  assert.match(failed.result?.summary ?? "", /provider dropped the turn/);
  // The obligation is recorded on the step, not enforced against a dead turn.
  assert.match(
    store
      .listEvents(run.id)
      .flatMap((event) =>
        event.stepId === failed.id &&
        typeof event.detail === "object" &&
        event.detail !== null &&
        "abandonedDelegationObligation" in event.detail
          ? [String(event.detail.abandonedDelegationObligation)]
          : [],
      )
      .join(),
    /active delegated work/,
  );
  // And the run was advanced: the recipe derived its pause from the failed
  // tail rather than the run sitting active with nobody told.
  assert.equal(
    store.getRun(run.id)!.lifecycleReason,
    `implement step ${step.id} ended as failed`,
  );
});

test("Claude is named and links its worktree before acquire while prompt rejection fails the step", async () => {
  vi.spyOn(skillResolver, "resolveSkillNames").mockReturnValue(["alpha"]);
  const { run, task } = createRun({
    provider: "claude-sdk",
    taskTitle: "Add the workflow widget",
  });
  rejectPrompt = new Error("provider unavailable");
  const step = appendAgent(run.id, {
    role: "implementer",
    objective: "implement",
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  executors.registerWorkflowAgentExecutor(
    agentExecutor.createWorkflowAgentExecutor(deps()),
  );
  await engine.advanceRun(run.id);
  await waitFor(() => store.getRun(run.id)!.lifecycle === "paused");

  const failed = store.getStep(step.id)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.result?.summary ?? "", /provider unavailable/);
  const submitted = store
    .listEvents(run.id)
    .find(
      (event) =>
        event.type === "result-submitted" && event.stepId === failed.id,
    );
  assert.deepEqual(submitted?.actor, {
    kind: "system",
    id: "workflow-agent-executor",
  });
  assert.equal(worktrees.worktreeIdForSession(sid("claude", 1)), "wt-test");
  assert.deepEqual(createdCwds, [workflowWorktreePath]);
  assert.equal(
    sessionStore.getSkills(sid("claude", 1)),
    '["alpha"]',
    "the Claude workflow creation path freezes skills before acquire",
  );
  assert.deepEqual(createdTitles, [
    `Task-${task.id} · Implementer — Add the workflow widget · Run ${run.id}`,
  ]);
  assert.equal(
    store.getRun(run.id)!.lifecycleReason,
    `implement step ${step.id} ended as failed`,
  );
});

test("prompt builder renders implement and revise assignments without I/O", () => {
  const { run } = createRun();
  const implement = appendAgent(run.id, {
    role: "implementer",
    objective: "implement",
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  const implementationPrompt =
    agentExecutor.buildWorkflowAssignmentPrompt(implement);
  assert.match(implementationPrompt, /implementation-result/);

  const revise: WorkflowStepRow = {
    ...implement,
    id: implement.id + 1,
    payload: {
      role: "implementer",
      objective: "revise",
      reviewedCommit: "reviewed-head",
      findings: [
        { severity: "major", text: "fix the race" },
        { severity: "major", text: "add a regression test" },
      ],
      reviewSummary: "the locking is close but not yet correct",
      observations: ["the helper name reads oddly"],
      resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
    },
  };
  const revisePrompt = agentExecutor.buildWorkflowAssignmentPrompt(
    revise,
    "Check the migration too.",
  );
  assert.match(revisePrompt, /reviewed commit reviewed-head/);
  assert.match(revisePrompt, /fix the race/);
  assert.match(revisePrompt, /add a regression test/);
  // The reviewer's own words, and the channel back to it.
  assert.match(revisePrompt, /the locking is close but not yet correct/);
  assert.match(revisePrompt, /non-blocking observations/);
  assert.match(revisePrompt, /the helper name reads oddly/);
  assert.equal(revisePrompt.split(REVIEW_RESPONSE_CONVENTION).length - 1, 1);
  assert.ok(revisePrompt.endsWith("Check the migration too."));
  // An initial implementation has no findings to answer, so it is not asked to.
  assert.doesNotMatch(implementationPrompt, /responses/);
});

test("a fix assignment with a review set says the claims framing once", () => {
  const { run } = createRun();
  const revise = appendAgent(run.id, {
    role: "implementer",
    objective: "revise",
    reviewedCommit: "reviewed-head",
    reviewSetId: "set-1",
    findings: [
      {
        severity: "major",
        text: "fix the race",
        path: "src/lock.ts",
        line: 12,
        commentId: "thread-1",
      },
      { severity: "minor", text: "the reviewer named no file" },
    ],
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  const handoff = [
    "## Review comments",
    "",
    REVIEW_RESPONSE_CONVENTION,
    "",
    "### src/lock.ts:12 — [major] (comment id: thread-1)",
    "",
    "fix the race",
  ].join("\n");
  const prompt = agentExecutor.buildWorkflowAssignmentPrompt(
    revise,
    undefined,
    handoff,
  );
  // The handoff carries the framing, so the assembled prompt must not add its
  // own copy of it — nor a second rendering of a finding that has a thread.
  assert.equal(prompt.split(REVIEW_RESPONSE_CONVENTION).length - 1, 1);
  assert.equal(prompt.split("fix the race").length - 1, 1);
  assert.match(prompt, /comment id: thread-1/);
  assert.match(prompt, /- \[minor\] the reviewer named no file/);

  // Without a set, the findings are all the fixer gets, and the framing with it.
  const withoutSet = agentExecutor.buildWorkflowAssignmentPrompt(revise);
  assert.equal(
    withoutSet.split(REVIEW_RESPONSE_CONVENTION).length - 1,
    1,
    "the convention still reaches a fixer that has no threads",
  );
  assert.match(withoutSet, /- \[major\] src\/lock\.ts:12 — fix the race/);
  assert.doesNotMatch(withoutSet, /comment id/);
});

/**
 * A run and a history built as PLAIN ROWS, so the recipe can bound a payload
 * far larger than the store's own result cap allows to be persisted. The whole
 * point is to measure the recipe's real shrinking, not a hand-made marker.
 */
function inMemoryRun(): WorkflowRunRow {
  return {
    id: 9_001,
    taskId: 1,
    recipeId: recipe.CODE_DELIVERY_RECIPE_ID,
    recipeVersion: recipe.CODE_DELIVERY_RECIPE_VERSION,
    worktreeId: "wt-9001",
    branch: "in-memory",
    lifecycle: "active",
    maxIterations: 3,
    maxReviewPasses: 1,
    config: {
      coordinator: roleConfig("pi") as unknown as WorkflowJsonValue,
      roles: {
        implementer: [roleConfig("pi") as unknown as WorkflowJsonValue],
        reviewer: [roleConfig("pi") as unknown as WorkflowJsonValue],
        fixer: [],
        verdict: [],
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function inMemoryStep(
  id: number,
  payload: WorkflowJsonValue,
  contractId: string,
  resultPayload: WorkflowJsonValue,
): WorkflowStepRow {
  return {
    id,
    runId: 9_001,
    kind: "agent",
    payload,
    status: "completed",
    attempt: 1,
    executor: { kind: "session", id: `sess-${id}` },
    result: {
      status: "completed",
      summary: "done",
      contractId,
      payload: resultPayload,
      submittedAt: 1,
    },
    createdAt: id,
    updatedAt: id,
  } as unknown as WorkflowStepRow;
}

/** Plan, implement, commit, and a review that raises exactly these findings. */
function inMemoryReviseHistory(
  findings: readonly { severity: string; text: string }[],
): WorkflowStepRow[] {
  const plan = inMemoryStep(
    1,
    { role: "coordinator", objective: "plan" },
    contracts.WORK_PLAN_CONTRACT_ID,
    {
      complexity: "high",
      implementer: roleConfig("pi") as unknown as WorkflowJsonValue,
      reviewer: roleConfig("pi") as unknown as WorkflowJsonValue,
      rationale: "large review",
    },
  );
  const implement = inMemoryStep(
    2,
    { role: "implementer", objective: "implement" },
    contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
    { notes: "built it" },
  );
  const commit = {
    ...inMemoryStep(
      3,
      { operation: "commit-sync", idempotencyKey: "wf9001:commit-sync:1" },
      contracts.COMMIT_SYNC_RESULT_CONTRACT_ID,
      { baseCommit: "aaa", headCommit: "bbb" },
    ),
    kind: "host-operation" as const,
  };
  const review = inMemoryStep(
    4,
    {
      role: "reviewer",
      objective: "review",
      commitRange: { baseCommit: "aaa", headCommit: "bbb" },
      reviewPass: 1,
    },
    contracts.ASSESSMENT_CONTRACT_ID,
    {
      verdict: "revise",
      headCommit: "bbb",
      findings: findings as unknown as WorkflowJsonValue,
    },
  );
  return [plan, implement, commit, review];
}

test("the largest accepted review reaches every role with every finding", () => {
  // Findings are the one payload group composition may never shrink by dropping
  // items. A dropped finding cannot be recovered by anything the run can do: a
  // retry re-composes the same shortened payload, and the coordinator deciding
  // WHO fixes what has no review threads to fall back on — so a shortened list
  // would either be worked silently or block a run that can never unblock. The
  // bound therefore lives where the reviewer is still live to act on it.
  // At BOTH bounds, like the recipe's own boundary test — a list far inside
  // them would prove nothing about the guarantee.
  const atTheBound = Array.from(
    { length: ASSESSMENT_FINDINGS_MAX_COUNT },
    (_unused, index) => ({
      severity: "major" as const,
      text: `finding ${index} ${"y".repeat(200)}`,
    }),
  );
  assert.ok(JSON.stringify(atTheBound).length <= ASSESSMENT_FINDINGS_MAX_CHARS);

  const { run } = createRun();
  const bounded = recipe.decideNextStep(
    inMemoryRun(),
    inMemoryReviseHistory(atTheBound),
  );
  assert.equal(bounded.kind, "append");
  const payload = (bounded as Extract<typeof bounded, { kind: "append" }>).step
    .payload as Record<string, WorkflowJsonValue>;
  const carried = payload.findings as WorkflowJsonValue[];
  assert.equal(
    carried.filter((finding) => recipe.isOmittedItemMarker(finding)).length,
    0,
    "nothing was dropped to make it fit",
  );
  assert.equal(carried.length, atTheBound.length);

  // And the rendered assignment lists them all, with no warning to explain a
  // shortfall that did not happen.
  const prompt = agentExecutor.buildWorkflowAssignmentPrompt({
    ...store.getStep(
      appendAgent(run.id, { role: "implementer", objective: "revise" }).id,
    )!,
    payload,
  });
  assert.doesNotMatch(prompt, /WARNING/);
  assert.doesNotMatch(prompt, /missing from the list above/);
  // Rendered whole, not merely counted: each finding's own text is present.
  for (const finding of atTheBound)
    assert.ok(
      prompt.includes(finding.text),
      `the assignment carries "${finding.text.slice(0, 20)}…" in full`,
    );
});

test("the accepted boundary is exact, and publication cannot move it", () => {
  // Both bounds tested AT the edge rather than far inside it: the largest set
  // the contract takes must validate, and one character or one finding more
  // must not. Refusing the SUBMISSION keeps the loss where something can still
  // be done about it — the reviewer is running, sees the limit, consolidates.
  const contract = contracts.getResultContract(
    contracts.ASSESSMENT_CONTRACT_ID,
  )!;
  const assess = (findings: unknown) =>
    contract.validate({ verdict: "revise", headCommit: "abc", findings });

  // At the COUNT bound, with the bytes filled to just under the byte bound.
  const atBoth = (textLength: number) =>
    Array.from({ length: ASSESSMENT_FINDINGS_MAX_COUNT }, (_unused, index) => ({
      severity: "major" as const,
      text: `finding ${index} ${"y".repeat(textLength)}`,
      path: `src/some/deeper/path/module-${index}.ts`,
      line: index + 1,
    }));
  let width = 1;
  while (
    JSON.stringify(atBoth(width + 1)).length <= ASSESSMENT_FINDINGS_MAX_CHARS
  )
    width += 1;
  const maximal = atBoth(width);
  assert.ok(
    JSON.stringify(maximal).length > ASSESSMENT_FINDINGS_MAX_CHARS - 300,
    "the fixture really is at the byte bound",
  );
  assert.ok(assess(maximal), "the largest accepted review validates");
  assert.equal(
    assess(atBoth(width + 1)),
    false,
    "and a wider one does not: the byte bound is exact",
  );
  assert.equal(
    assess([...maximal.slice(1), maximal[0]!, maximal[0]!]),
    false,
    "one finding past the count is refused too",
  );

  // The server's own thread ids are not charged to the reviewer. Measuring the
  // stored shape would make this very set fail its contract the moment it was
  // published — and the recipe reads results through that contract, so the run
  // would pause on evidence it had just accepted, with nothing able to shrink
  // it.
  assert.ok(
    assess(
      maximal.map((finding, index) => ({
        ...finding,
        commentId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
    ),
    "publication cannot invalidate an accepted assessment",
  );
});

test("the coordinator is not told to resolve findings it cannot record", () => {
  // `implementerReportLines` renders into assessments AND into the routing
  // decision. Assessments resolve each answer explicitly; the coordinator's
  // contract has no verdict at all, so telling it to "record the finding again
  // with verdict revise" asks for a submission the recipe refuses — a wasted
  // refusal and retry for a cheap model to learn that.
  const { run } = createRun();
  const report = {
    summary: "did the work",
    responses: [{ finding: "guard the retry path", response: "out of scope" }],
  };
  const judging = agentExecutor.buildWorkflowAssignmentPrompt(
    appendAgent(run.id, {
      role: "verdict",
      objective: "verdict",
      commitRange: { baseCommit: "abc", headCommit: "def" },
      implementerReport: report,
      verdict: roleConfig("pi"),
      resultContract: contracts.ASSESSMENT_CONTRACT_ID,
    }),
  );
  assert.match(judging, /record the finding again with verdict revise/);

  const routing = agentExecutor.buildWorkflowAssignmentPrompt(
    appendAgent(run.id, {
      role: "coordinator",
      objective: "review-decision",
      question: "route-fix",
      commitRange: { baseCommit: "abc", headCommit: "def" },
      completedReviewPass: 1,
      maxReviewPasses: 2,
      implementer: roleConfig("pi"),
      implementerReport: report,
      findings: [{ severity: "major", text: "guard the retry path" }],
      resultContract: contracts.REVIEW_DECISION_CONTRACT_ID,
    }),
  );
  assert.doesNotMatch(routing, /verdict revise/);
  assert.match(routing, /judging them is the reviewer's job, not yours/);
});

test("an oversized range is reported as an expectation, never as a limit", () => {
  const { run } = createRun();
  const decide = (insertions: number, deletions: number): string =>
    agentExecutor.buildWorkflowAssignmentPrompt(
      appendAgent(run.id, {
        role: "coordinator",
        objective: "review-decision",
        question: "deliver-or-review",
        commitRange: { baseCommit: "abc", headCommit: "def" },
        completedReviewPass: 1,
        maxReviewPasses: 6,
        implementer: roleConfig("pi"),
        roles: { reviewer: [roleConfig("pi")], verdict: [] },
        changes: { filesChanged: 12, insertions, deletions, files: [] },
        resultContract: contracts.REVIEW_DECISION_CONTRACT_ID,
      }),
    );

  // Most ranges say nothing: an advisory on every run is an advisory nobody
  // reads. 53 of the 75 ranges in the published dataset fall below the first
  // threshold (`workflow-run-economics-2026-09`); the live figure only grows
  // with new runs, so the citable snapshot is the one quoted here.
  assert.doesNotMatch(decide(600, 40), /changed lines this range/);
  // Exact boundaries, both of them.
  assert.doesNotMatch(decide(1_499, 0), /changed lines this range/);
  assert.match(decide(1_500, 0), /start to need real iteration/);
  assert.match(decide(3_999, 0), /start to need real iteration/);
  // The threshold is on the RANGE, so insertions and deletions both count.
  assert.match(decide(2_000, 1_999), /start to need real iteration/);
  assert.match(decide(2_000, 2_000), /larger than all but four/);

  const iterating = decide(2_000, 200);
  assert.match(iterating, /2200 changed lines/);
  assert.match(iterating, /start to need real iteration/);

  assert.match(
    decide(7_000, 482),
    /larger than all but four of the runs measured/,
  );
});

test("a repeated seam is named to the pass decision, and never narrows it", () => {
  const { run } = createRun();
  const decide = (repeatedPaths?: unknown): string =>
    agentExecutor.buildWorkflowAssignmentPrompt(
      appendAgent(run.id, {
        role: "coordinator",
        objective: "review-decision",
        question: "deliver-or-review",
        commitRange: { baseCommit: "abc", headCommit: "def" },
        completedReviewPass: 3,
        maxReviewPasses: 6,
        implementer: roleConfig("pi"),
        roles: { reviewer: [roleConfig("pi")], verdict: [] },
        ...(repeatedPaths
          ? { repeatedPaths: repeatedPaths as WorkflowJsonValue }
          : {}),
        resultContract: contracts.REVIEW_DECISION_CONTRACT_ID,
      }),
    );

  const exploring = decide();
  assert.doesNotMatch(exploring, /has not converged on/);

  const cycling = decide([
    { path: "src/gitHosting.ts", passes: 4 },
    { path: "src/pullRequestMerge.ts", passes: 2 },
  ]);
  assert.match(cycling, /src\/gitHosting\.ts \(4 passes\)/);
  assert.match(cycling, /src\/pullRequestMerge\.ts \(2 passes\)/);
  assert.match(cycling, /often a seam the run has not converged on/);

  // A single pass is not a seam, whatever the payload says.
  assert.doesNotMatch(decide([{ path: "src/a.ts", passes: 1 }]), /1 passes/);

  // Payload pressure clips strings and replaces an omitted tail with a marker.
  // Neither is a filename, and naming one as a focus target would point the
  // next pass at nothing.
  const damaged = decide([
    { path: `src/very/long/pa${TRUNCATION_MARKER}`, passes: 3 },
    { path: TRUNCATION_MARKER, passes: 2 },
    { path: "src/real.ts", passes: 2 },
  ]);
  assert.doesNotMatch(damaged, /3 passes/);
  assert.match(damaged, /src\/real\.ts \(2 passes\)/);
});

test("routing carries what this run has spent, and never as an instruction", () => {
  const { run } = createRun();
  const step = appendAgent(run.id, {
    role: "coordinator",
    objective: "review-decision",
    question: "route-fix",
    commitRange: { baseCommit: "abc", headCommit: "def" },
    completedReviewPass: 1,
    maxReviewPasses: 2,
    implementer: roleConfig("pi"),
    findings: [{ severity: "major", text: "the retry path is unguarded" }],
    findingRounds: [],
    resultContract: contracts.REVIEW_DECISION_CONTRACT_ID,
  });
  const withoutSpend = agentExecutor.buildWorkflowAssignmentPrompt(step);
  assert.doesNotMatch(
    withoutSpend,
    /has spent/,
    "a run with nothing measured says nothing about cost",
  );

  const withSpend = agentExecutor.buildWorkflowAssignmentPrompt(
    step,
    undefined,
    undefined,
    [
      "This run has spent $41 so far across 6 sessions.",
      "An assignment in the implementer's own session has cost $16 on average in this run; that session re-reads everything it has already done, so its next round costs more than its last.",
      "Cost is evidence here, never an instruction — you may not leave a finding unanswered, downgrade one, or pick a runtime you judge unequal to the work in order to spend less.",
    ],
  );
  assert.match(withSpend, /has spent \$41 so far across 6 sessions/);
  assert.match(withSpend, /its next round costs more than its last/);
  assert.match(withSpend, /Cost is evidence here, never an instruction/);
  assert.match(
    withSpend,
    /may not leave a finding unanswered, downgrade one/,
    "cheapness can never become a reason to soften a finding",
  );
});

test("a finding earlier rounds already answered says so on its own line", () => {
  // The count is rendered ON the finding, not as a separate list: the
  // coordinator is choosing what to do about THIS finding, and a table it has to
  // join by eye is one it reads past. A first-time finding stays unmarked, which
  // is what makes a marked one stand out.
  const { run } = createRun();
  const routing = agentExecutor.buildWorkflowAssignmentPrompt(
    appendAgent(run.id, {
      role: "coordinator",
      objective: "review-decision",
      question: "route-fix",
      commitRange: { baseCommit: "abc", headCommit: "def" },
      completedReviewPass: 1,
      maxReviewPasses: 2,
      implementer: roleConfig("pi"),
      findings: [
        {
          severity: "major",
          text: "the lock is missing on the retry path",
          commentId: "thread-stubborn",
        },
        {
          severity: "minor",
          text: "the helper name reads oddly",
          commentId: "thread-fresh",
        },
      ],
      findingRounds: [{ commentId: "thread-stubborn", rounds: 2 }],
      resultContract: contracts.REVIEW_DECISION_CONTRACT_ID,
    }),
  );
  const lineFor = (text: string): string =>
    routing.split("\n").find((line) => line.includes(text)) ?? "";
  assert.match(
    lineFor("the lock is missing on the retry path"),
    /already answered by 2 fix rounds and raised again/,
  );
  assert.doesNotMatch(
    lineFor("the helper name reads oddly"),
    /already answered/,
    "a finding no round has seen carries no count",
  );
  // The thread id is a join key, never something the coordinator is shown: it
  // has no tool that could read a thread.
  assert.doesNotMatch(routing, /thread-stubborn/);
  // A table that IS present says nothing about unavailability, however many
  // findings in it are unmarked.
  assert.doesNotMatch(routing, /could not carry how many fix rounds/);
});

test("a routing assignment that lost the round counts says so", () => {
  // An unmarked finding means "no round has answered this one" — a claim the
  // assignment may only make when it HAS the table. The payload carries it even
  // when empty for exactly this reason, so a MISSING table on a routing question
  // is composition having dropped it, and silence there would read as evidence
  // that every finding is new: the defect this evidence was added to fix,
  // recreated for the largest payloads.
  const { run } = createRun();
  const withoutTable = agentExecutor.buildWorkflowAssignmentPrompt(
    appendAgent(run.id, {
      role: "coordinator",
      objective: "review-decision",
      question: "route-fix",
      commitRange: { baseCommit: "abc", headCommit: "def" },
      completedReviewPass: 1,
      maxReviewPasses: 2,
      implementer: roleConfig("pi"),
      findings: [
        {
          severity: "major",
          text: "the lock is missing on the retry path",
          commentId: "thread-stubborn",
        },
      ],
      resultContract: contracts.REVIEW_DECISION_CONTRACT_ID,
    }),
  );
  assert.match(withoutTable, /could not carry how many fix rounds/);
  assert.match(withoutTable, /Read no finding above as new on that account/);

  // An EMPTY table is the run having looked: it says nothing, because nothing is
  // what it found.
  const emptyTable = agentExecutor.buildWorkflowAssignmentPrompt(
    appendAgent(run.id, {
      role: "coordinator",
      objective: "review-decision",
      question: "route-fix",
      commitRange: { baseCommit: "abc", headCommit: "def" },
      completedReviewPass: 1,
      maxReviewPasses: 2,
      implementer: roleConfig("pi"),
      findings: [
        { severity: "major", text: "a brand new problem", commentId: "t-1" },
      ],
      findingRounds: [],
      resultContract: contracts.REVIEW_DECISION_CONTRACT_ID,
    }),
  );
  assert.doesNotMatch(emptyTable, /could not carry how many fix rounds/);
  // On the FINDING's line: the routing prompt explains what a mark means, so a
  // whole-prompt match for that phrase passes on the explanation alone.
  assert.doesNotMatch(
    emptyTable
      .split("\n")
      .find((line) => line.includes("a brand new problem")) ?? "",
    /already answered/,
  );

  // And the notice belongs to the routing question alone: the other two are not
  // choosing a fix round, and never carry the table.
  const delivering = agentExecutor.buildWorkflowAssignmentPrompt(
    appendAgent(run.id, {
      role: "coordinator",
      objective: "review-decision",
      question: "deliver-or-review",
      commitRange: { baseCommit: "abc", headCommit: "def" },
      completedReviewPass: 1,
      maxReviewPasses: 2,
      implementer: roleConfig("pi"),
      findings: [{ severity: "minor", text: "an accepted remark" }],
      resultContract: contracts.REVIEW_DECISION_CONTRACT_ID,
    }),
  );
  assert.doesNotMatch(delivering, /could not carry how many fix rounds/);
});

test("a fix round is handed the coordinator's focus, and still owes every finding", () => {
  // The fix wording cannot be the review wording: a pass is told where to look
  // first, while a fix round's scope is already settled by the findings. Read
  // the review way, focus would be permission to answer only the named part —
  // so the mandate line has to follow it immediately.
  const { run } = createRun();
  const fix = appendAgent(run.id, {
    role: "implementer",
    objective: "revise",
    reviewedCommit: "def",
    findings: [{ severity: "major", text: "guard the retry path" }],
    observations: ["the helper name reads oddly"],
    focus: ["the retry helper is missing the lock everywhere, not just here"],
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  const prompt = agentExecutor.buildWorkflowAssignmentPrompt(fix);
  assert.match(
    prompt,
    /the retry helper is missing the lock everywhere, not just here/,
  );
  assert.match(prompt, /asked this fix round to concentrate on/);
  assert.ok(
    prompt.indexOf("concentrate on the following") <
      prompt.indexOf("Address every finding"),
    "the mandate line answers the guidance",
  );
});

test("the fix focus claims no position for the findings it must not narrow", () => {
  // The findings are NOT above the guidance in the common case: once the
  // assessment published a review set, every anchored finding is filtered out of
  // the list here and rendered at the END, in the handoff section, with the list
  // collapsing to a pointer at it. So the wording states the obligation and says
  // nothing about where the findings are — exactly as the mandate line does.
  const { run } = createRun();
  const fix = appendAgent(run.id, {
    role: "implementer",
    objective: "revise",
    reviewedCommit: "def",
    reviewSetId: "set-1",
    findings: [
      {
        severity: "major",
        text: "guard the retry path",
        path: "src/retry.ts",
        line: 8,
        commentId: "thread-1",
      },
    ],
    focus: ["the retry helper is missing the lock everywhere, not just here"],
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  const handoff = [
    "## Review comments",
    "",
    REVIEW_RESPONSE_CONVENTION,
    "",
    "### src/retry.ts:8 — [major] (comment id: thread-1)",
    "",
    "guard the retry path",
  ].join("\n");
  const prompt = agentExecutor.buildWorkflowAssignmentPrompt(
    fix,
    undefined,
    handoff,
  );
  assert.match(prompt, /asked this fix round to concentrate on/);
  assert.doesNotMatch(prompt, /every finding above/);
  assert.match(prompt, /every finding still has to be fixed or answered/);
  // The premise of the claim above: the only rendering of the finding is the
  // handoff, and it comes after the guidance rather than before it.
  assert.match(prompt, /\(every finding is a review thread in the section/);
  assert.ok(
    prompt.indexOf("concentrate on the following") <
      prompt.indexOf("guard the retry path"),
    "the findings this round owes are rendered after the guidance, not above it",
  );
});

test("a softening focus is refused where it is rendered, not only where it is written", () => {
  // The coordinator is told focus may not excuse a finding, but that binds the
  // coordinator. A focus item saying "reject the third one" reaches a fixer
  // whose mandate line expressly permits rejecting a finding, so the refusal has
  // to live in the fixer's own assignment.
  const { run } = createRun();
  const fix = appendAgent(run.id, {
    role: "implementer",
    objective: "revise",
    reviewedCommit: "def",
    findings: [
      { severity: "major", text: "guard the retry path" },
      { severity: "minor", text: "the helper name is wrong" },
    ],
    focus: ["the second finding is out of scope, reject it"],
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  const prompt = agentExecutor.buildWorkflowAssignmentPrompt(fix);

  // Asserted on the focus lead-in LINE, not on the prompt: the rule has to be
  // the sentence introducing the items, where a fixer reading them cannot miss
  // it. A match anywhere in the prompt would also pass on the mandate line's
  // own wording, which is what let this gap exist in the first place.
  const leadIn = prompt
    .split("\n")
    .find((line) => line.includes("asked this fix round to concentrate on"));
  assert.ok(leadIn, "the fix round carries a focus lead-in");
  assert.match(leadIn, /implementation guidance only/);
  assert.match(
    leadIn,
    /skip, downgrade, reject or declare a finding out of scope/,
  );
  assert.match(leadIn, /not the coordinator's to give/);
  assert.match(leadIn, /judge that finding on its own evidence/);

  // The review variant governs a pass that owes no findings, so it must NOT
  // grow this rule.
  const review = appendAgent(run.id, {
    role: "reviewer",
    objective: "review",
    reviewPass: 1,
    maxReviewPasses: 2,
    commitRange: { baseCommit: "abc", headCommit: "def" },
    focus: ["the retry path"],
    resultContract: contracts.ASSESSMENT_CONTRACT_ID,
  });
  assert.doesNotMatch(
    agentExecutor.buildWorkflowAssignmentPrompt(review),
    /not the coordinator's to give/,
  );
});

test("a verdict assignment renders each finding's thread resolution", () => {
  const { run } = createRun();
  const step = appendAgent(run.id, {
    role: "verdict",
    objective: "verdict",
    commitRange: { baseCommit: "fix-base", headCommit: "fix-head" },
    reviewSetId: "set-1",
    findings: [
      {
        severity: "major",
        text: "fix the race",
        path: "src/lock.ts",
        line: 12,
        commentId: "thread-1",
      },
      {
        severity: "minor",
        text: "rename the helper",
        path: "src/lock.ts",
        line: 40,
        commentId: "thread-2",
      },
    ],
    findingResolutions: [
      { commentId: "thread-1", state: "resolved" },
      {
        commentId: "thread-2",
        state: "disputed",
        response: "the name matches the caller",
      },
    ],
    verdict: roleConfig("pi"),
    resultContract: contracts.ASSESSMENT_CONTRACT_ID,
  });
  const prompt = agentExecutor.buildWorkflowAssignmentPrompt(step);
  // The finding line and its resolution are separate lines on purpose: appended
  // to the text, the state was copyable INTO a restatement, which no longer
  // matches the thread and closes the original as accepted.
  assert.match(
    prompt,
    /- \[major\] src\/lock\.ts:12 — fix the race\n {2}answered: resolved/,
  );
  assert.match(
    prompt,
    /- \[minor\] src\/lock\.ts:40 — rename the helper\n {2}answered: disputed — the name matches the caller/,
  );
});

test("prompt builder gives verdict the findings, responses, and fix range", () => {
  const { run } = createRun();
  const step = appendAgent(run.id, {
    role: "verdict",
    objective: "verdict",
    commitRange: { baseCommit: "fix-base", headCommit: "fix-head" },
    findings: [{ severity: "major", text: "fix the race" }],
    verdict: roleConfig("pi"),
    implementerReport: {
      notes: "locked the update",
      responses: [
        { finding: "fix the race", response: "fixed: added the lock" },
      ],
    },
    resultContract: contracts.ASSESSMENT_CONTRACT_ID,
  });
  const prompt = agentExecutor.buildWorkflowAssignmentPrompt(step);
  assert.match(prompt, /fix-base\.\.fix-head/);
  assert.match(prompt, /fix the race/);
  assert.match(prompt, /fixed: added the lock/);
  assert.equal(prompt.split(REVIEW_REPORT_CONVENTION).length - 1, 1);
});

test("prompt builder covers review range, read-only rules, exact head, and override", () => {
  const { run } = createRun();
  const step = appendAgent(run.id, {
    role: "reviewer",
    commitRange: { baseCommit: "abc", headCommit: "def" },
    ciResults: {
      outcome: "timeout",
      headCommit: "def",
      checks: [{ name: "test", status: "pending" }],
      reason: "CI did not settle",
    },
    resultContract: contracts.ASSESSMENT_CONTRACT_ID,
  });
  const prompt = agentExecutor.buildWorkflowAssignmentPrompt(
    step,
    "Check migration safety.",
  );
  assert.match(prompt, /abc\.\.def/);
  assert.match(prompt, /assessment/);
  assert.match(prompt, /CI results: timeout for exact commit def/);
  assert.match(prompt, /test: pending/);
  assert.doesNotMatch(prompt, /The implementer reports/);
  assert.equal(prompt.split(REVIEW_REPORT_CONVENTION).length - 1, 1);
  assert.ok(prompt.endsWith("Check migration safety."));
});

test("a review assignment renders the implementer's report and its answers", () => {
  const { run } = createRun();
  const step = appendAgent(run.id, {
    role: "reviewer",
    commitRange: { baseCommit: "abc", headCommit: "def" },
    reviewPass: 2,
    maxReviewPasses: 2,
    implementerReport: {
      summary: "reworked the retry path",
      notes: "kept the existing lock",
      responses: [
        {
          finding: "add a regression test",
          response: "the e2e case covers it",
        },
      ],
    },
    resultContract: contracts.ASSESSMENT_CONTRACT_ID,
  });
  const prompt = agentExecutor.buildWorkflowAssignmentPrompt(step);
  assert.match(prompt, /The implementer reports on this range/);
  assert.match(prompt, /reworked the retry path/);
  assert.match(prompt, /kept the existing lock/);
  assert.match(prompt, /finding: add a regression test/);
  assert.match(prompt, /answer: the e2e case covers it/);
  assert.match(prompt, /Resolve each answer explicitly/);
});

test("the rebase repair assignment names files and forbids push or extra commits", () => {
  const { run } = createRun();
  const step = appendAgent(run.id, {
    role: "implementer",
    objective: "repair-rebase",
    files: ["docs/reference/web-diff.md", "app/server/src/engine.ts"],
    truncated: true,
    baseBranch: "main",
    originalHead: "a".repeat(40),
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  const prompt = agentExecutor.buildWorkflowAssignmentPrompt(step);
  assert.match(prompt, /repair the rebase onto main/i);
  assert.match(prompt, /docs\/reference\/web-diff\.md/);
  assert.match(prompt, /truncated; inspect Git for the complete set/);
});

test("the operation triage assignment carries the failure and forbids every mutation", () => {
  const { run } = createRun();
  const step = appendAgent(run.id, {
    role: "implementer",
    objective: "triage-operation",
    failedOperation: {
      operation: "observe-ci",
      phase: "ci",
      stepId: 12,
      status: "failed",
      summary: "push rejected: non-fast-forward (remote tip 9f2c)",
      attempts: 2,
      idempotencyKey: "wf1:observe-ci:11",
    },
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  const prompt = agentExecutor.buildWorkflowAssignmentPrompt(step);
  assert.match(
    prompt,
    /diagnose why this run's ci host operation "observe-ci"/,
  );
  assert.match(
    prompt,
    /ran it 2 times and it failed with the identical result/,
  );
  assert.match(prompt, /push rejected: non-fast-forward \(remote tip 9f2c\)/);
  // The failure text is provider output pasted into a prompt: it is fenced and
  // named as data, exactly as machine CI findings are.
  assert.match(prompt, /<<<operation-failure/);
  assert.match(prompt, /\noperation-failure>>>/);
});

test("a triage assignment with no readable failure is refused rather than prompted", () => {
  const { run } = createRun();
  const step = appendAgent(run.id, {
    role: "implementer",
    objective: "triage-operation",
    resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
  });
  assert.throws(
    () => agentExecutor.buildWorkflowAssignmentPrompt(step),
    /carries no operation failure/,
  );
});

test("each assignment kind states the rules its role works by", () => {
  // The prose rules only. Which step data reaches a prompt, and which section
  // renders under which condition, stay in the tests above.
  const { run } = createRun();
  const render = (payload: WorkflowJsonValue): string =>
    agentExecutor.buildWorkflowAssignmentPrompt(appendAgent(run.id, payload));
  const range = { baseCommit: "abc", headCommit: "def" };
  const routing = {
    role: "coordinator",
    objective: "review-decision",
    commitRange: range,
    completedReviewPass: 3,
    implementer: roleConfig("pi"),
    resultContract: contracts.REVIEW_DECISION_CONTRACT_ID,
  };
  assertPromptRules({
    implement: {
      text: render({
        role: "implementer",
        objective: "implement",
        resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
      }),
      rules: {
        "implements-the-task": /implement[^.\n]*\bTask\b/i,
        "no-commit-push-or-pr": forbidden(
          "commit",
          "push",
          "open a pull request",
        ),
      },
    },
    "revise with observations and focus": {
      text: render({
        role: "implementer",
        objective: "revise",
        reviewedCommit: "def",
        findings: [{ severity: "major", text: "guard the retry path" }],
        observations: ["the helper name reads oddly"],
        focus: ["the retry helper is missing the lock everywhere"],
        resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
      }),
      rules: {
        "answers-findings-in-responses":
          /(answer|respond|reply)[^.\n]*\bresponses\b/i,
        "responses-shape":
          /responses\?: \[\{ finding: string, response: string \}\]/,
        "response-leads-with-disposition":
          /(start|begin|lead|open)[^.\n]*\bresponse[^.\n]*disposition/i,
        "observations-are-optional-work": affirmed(
          /observations[^.\n]*?(?<key>only if|need not|at your discretion|optional)/i,
        ),
        "focus-still-owes-every-finding": affirmed(
          /every finding (still )?(?<key>has to|must)( still)? be (fixed|answered)/i,
        ),
        // The review wording would read as permission to answer only part.
        "focus-is-not-review-narrowing": absent(
          /narrows where you look first/i,
        ),
      },
    },
    review: {
      text: render({
        role: "reviewer",
        objective: "review",
        reviewPass: 1,
        maxReviewPasses: 2,
        commitRange: range,
        ciResults: {
          outcome: "timeout",
          headCommit: "def",
          checks: [{ name: "test", status: "pending" }],
          reason: "CI did not settle",
        },
        resultContract: contracts.ASSESSMENT_CONTRACT_ID,
      }),
      rules: {
        "is-read-only": /never (modify|change|edit|touch)[^.\n]*worktree/i,
        "pins-the-exact-head": /git rev-parse/,
        "verification-report-is-a-claim":
          /implementer's own verification[^.\n]*claim/i,
        // Both directions, so minor remarks are neither dropped nor hidden.
        "verdict-and-findings-agree": affirmed(
          /(verdict and findings|findings and verdict) must (agree|match|be consistent)/i,
        ),
        "pass-empty-revise-nonempty":
          /\bpass\b[^.\n]*no findings[^.\n]*\brevise\b[^.\n]*at least one/i,
        "minor-remark-is-an-observation":
          /(record|note|put)[^.\n]*as an observation/i,
        "severity-in-its-field": affirmed(
          /severity in (its|the) severity field/i,
        ),
        // Every rework assignment renders observations to the fix round.
        "observations-reach-the-fix-round": affirmed(
          /observations (also )?travel|observations (also )?reach the fix round|fix round is shown them/i,
        ),
        "finding-means-must-address":
          /must be addressed[^.\n]*not (who|whom|the audience)/i,
        "no-stale-observation-claim": absent(
          /observations reach the user, not the implementer/i,
        ),
      },
    },
    // Settlement matches a restatement to its thread on severity + text, and
    // resolves every unrestated thread as accepted: a paraphrase opens a second
    // thread AND closes the original.
    "re-check": {
      text: render({
        role: "reviewer",
        objective: "re-check",
        reviewPass: 1,
        commitRange: { baseCommit: "fix-base", headCommit: "fix-head" },
        reviewSetId: "set-1",
        answersStepId: 1,
        findings: [
          {
            severity: "major",
            text: "fix the race",
            path: "src/lock.ts",
            line: 12,
            commentId: "thread-1",
          },
        ],
        findingResolutions: [{ commentId: "thread-1", state: "resolved" }],
        resultContract: contracts.ASSESSMENT_CONTRACT_ID,
      }),
      rules: {
        "findings-are-yours": /\byour (own )?findings\b/i,
        "restate-verbatim": affirmed(
          /(?<verb>restate)[^.\n]*?(?<how>exactly|verbatim|word for word)/i,
        ),
        "silence-is-acceptance":
          // The premise legitimately negates (NOT restate); the consequence may not.
          affirmed(
            /(?<premise>(not|never) restate|unrestated)[^.\n]*?(?<key>(recorded|counted|treated) as accepted)/i,
          ),
        "carries-report-convention": (text) =>
          text.includes(REVIEW_REPORT_CONVENTION),
        "convention-is-for-the-report": affirmed(
          /convention[^.\n]*?(?<key>governs|is for|applies to)[^.\n]*report you write[^.\n]*not[^.\n]*fields/i,
        ),
      },
    },
    verdict: {
      text: render({
        role: "verdict",
        objective: "verdict",
        commitRange: { baseCommit: "fix-base", headCommit: "fix-head" },
        reviewSetId: "set-1",
        findings: [
          {
            severity: "minor",
            text: "rename the helper",
            path: "src/lock.ts",
            line: 40,
            commentId: "thread-2",
          },
        ],
        findingResolutions: [
          { commentId: "thread-2", state: "disputed", response: "matches" },
        ],
        implementerReport: { notes: "renamed nothing" },
        verdict: roleConfig("pi"),
        resultContract: contracts.ASSESSMENT_CONTRACT_ID,
      }),
      rules: {
        "judges-the-fix-round":
          /(judge|decide)[^.\n]*whether[^.\n]*fix round[^.\n]*resolved/i,
        "resolution-not-rediscovery":
          /resolution,? not rediscovery|new finding only for (a )?regression/i,
        "dispute-on-its-argument":
          /dispute[^.\n]*(on|by) its (own )?(argument|merits)/i,
      },
    },
    "route-fix": {
      text: render({
        ...routing,
        question: "route-fix",
        maxReviewPasses: 4,
        findings: [
          { severity: "major", text: "the lock is missing", commentId: "t-1" },
        ],
        findingRounds: [{ commentId: "t-1", rounds: 2 }],
        implementerReport: { summary: "did the work" },
      }),
      rules: {
        "fixer-is-the-default": affirmed(
          /fixer is the default|default (answer )?is a fixer/i,
        ),
        "exception-needs-a-named-reason": affirmed(
          /"implementer"[^.\n]*?(?<key>needs a (named )?reason|reason you can name)/i,
        ),
        // The reason routing actually gave when it went the expensive way.
        "finding-count-is-no-reason":
          /not a reason[^.\n]*number of findings|number of findings[^.\n]*(is not|isn't) a reason/i,
        "work-beyond-every-fixer-has-a-route": /beyond (every|any|each) fixer/i,
        "repeat-count-means-not-converged": /not converged/i,
        "repeat-belongs-in-its-conversation":
          /(count|mark)[^.\n]*finding's own/i,
        // The one place the coordinator can say anything TO the fix round; the
        // rationale is the user's record and reaches no agent.
        "offers-the-class-level-correction": /class-level correction/i,
        "focus-is-the-only-channel": affirmed(/only channel/i),
        "rationale-reaches-nobody":
          /rationale[^.\n]*reaches no(body| agent| one)/i,
        "focus-shape": /focus\?: string\[\]/,
        // "Answered" is the fixer's disposition vocabulary.
        "focus-is-implementation-guidance":
          /focus[^.\n]*implementation guidance/i,
        "focus-shapes-no-dispositions": absent(
          /how the findings are answered/i,
        ),
        "focus-never-excuses-a-finding":
          /(never|cannot|can't) excuse a finding/i,
      },
    },
    "deliver-or-review, oversized and cycling": {
      text: render({
        ...routing,
        question: "deliver-or-review",
        maxReviewPasses: 6,
        roles: { reviewer: [roleConfig("pi")], verdict: [] },
        changes: {
          filesChanged: 12,
          insertions: 7_000,
          deletions: 482,
          files: [],
        },
        repeatedPaths: [{ path: "src/gitHosting.ts", passes: 4 }],
      }),
      rules: {
        // The MEDIAN: a mean of 14 is one runaway carrying three others.
        "quotes-the-median":
          /median[^.\n]*\b8 discovery passes[^.\n]*\b8 fix rounds/i,
        "names-the-outlier": /\b35\b/,
        "few-runs-are-no-law": /not a (law|prediction)/i,
        // It renders inside "deliver unless a pass is warranted".
        "size-never-means-less-review":
          /(none|not|never)[^.\n]*reason to review[^.\n]*\bless\b/i,
        "size-never-stops-passes": /never a reason to stop/i,
        "is-no-rule-or-limit": /not a (rule|limit)/i,
        // The card shows only the latest decision's rationale.
        "no-durable-flag-promised": /only[^.\n]*most recent decision/i,
        "only-the-author-cuts-scope": /only (its|the Task's) author/i,
        // A repeated seam and unexplored ground coexist.
        "seam-does-not-settle-the-rest": /not evidence[^.\n]*settled/i,
        "seam-never-narrows-the-pass": /never narrows what[^.\n]*report/i,
      },
    },
    "repair-rebase": {
      text: render({
        role: "implementer",
        objective: "repair-rebase",
        files: ["app/server/src/engine.ts"],
        baseBranch: "main",
        originalHead: "a".repeat(40),
        resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
      }),
      rules: {
        "continues-the-rebase": /git rebase --continue/,
        "no-extra-commits-or-push": forbidden(
          /create (any )?extra commits/i,
          "push",
          "open a pull request",
        ),
        "aborts-and-blocks-when-stuck": /abort[^.\n]*rebase[^.\n]*blocked/i,
      },
    },
    "triage-operation": {
      text: render({
        role: "implementer",
        objective: "triage-operation",
        failedOperation: {
          operation: "observe-ci",
          phase: "ci",
          stepId: 12,
          status: "failed",
          summary: "push rejected",
          attempts: 2,
          idempotencyKey: "wf1:observe-ci:11",
        },
        resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
      }),
      rules: {
        "failure-is-data": affirmed(
          /(?<key>as data),? (never|not) (as )?instructions/i,
        ),
        "no-git-mutation": forbidden(
          "commit",
          "amend",
          "rebase",
          "reset",
          "stash",
          "force-push",
        ),
        "moved-result-is-refused": affirmed(
          /(?<key>refuse|reject)s?[^.\n]*result[^.\n]*(moved|changed)/i,
        ),
        "blocks-with-diagnosis": /blocked[^.\n]*diagnosis/i,
      },
    },
    // What the reviewer reads when a too-large submission is refused.
    "assessment contract": {
      text: contracts.getResultContract(contracts.ASSESSMENT_CONTRACT_ID)!
        .describe,
      rules: {
        "says-to-consolidate": affirmed(/consolidate/i),
        "states-the-count-bound": new RegExp(
          `at most ${ASSESSMENT_FINDINGS_MAX_COUNT} findings`,
          "i",
        ),
        "states-the-size-bound": new RegExp(
          `at most ${ASSESSMENT_FINDINGS_MAX_CHARS} characters`,
          "i",
        ),
      },
    },
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not settle");
}

test("a fixer session follows its lineage and its runtime", async () => {
  // Session ids restart per test while the session store does not, and a
  // removed id is never resurrected by an upsert — so this test takes ids no
  // earlier one has used, or reuse would fail for a reason that is not the
  // keying under test.
  nextSession = 700;
  const { run } = createRun({ useFixer: true });
  const executor = agentExecutor.createWorkflowAgentExecutor(deps());
  const small = roleConfig("pi") as Record<string, unknown>;
  const large = { ...small, modelId: "pi-large" };
  const fix = async (
    payload: Record<string, unknown>,
  ): Promise<WorkflowStepRow> => {
    const step = appendAgent(run.id, {
      role: "implementer",
      objective: "revise",
      reviewedCommit: "head",
      findings: [{ severity: "major", text: "fix the race" }],
      resultContract: contracts.IMPLEMENTATION_RESULT_CONTRACT_ID,
      ...payload,
    });
    await executor.dispatch({ run, step, actor: ACTOR });
    complete(step, contracts.IMPLEMENTATION_RESULT_CONTRACT_ID, {});
    return step;
  };

  // Two rounds of the same lineage on the same runtime continue in ONE
  // session, which is what remembers the attempt that did not settle it.
  const first = await fix({ fixer: small, fixerLineage: 1 });
  const second = await fix({ fixer: small, fixerLineage: 1 });
  assert.equal(
    store.getStep(second.id)!.executor?.id,
    store.getStep(first.id)!.executor?.id,
  );

  // Escalating opens a fresh one rather than piling onto the stalled context.
  const escalated = await fix({ fixer: large, fixerLineage: 1 });
  assert.notEqual(
    store.getStep(escalated.id)!.executor?.id,
    store.getStep(first.id)!.executor?.id,
  );

  // And another reviewer's findings are another conversation entirely.
  const nextLineage = await fix({ fixer: small, fixerLineage: 2 });
  assert.notEqual(
    store.getStep(nextLineage.id)!.executor?.id,
    store.getStep(first.id)!.executor?.id,
  );
  assert.match(createdTitles[0] ?? "", / · Fixer review 1 —/);
  assert.match(createdTitles[1] ?? "", / · Fixer review 1 —/);
  assert.match(createdTitles[2] ?? "", / · Fixer review 2 —/);
});

test("a verdict session follows its runtime, and a re-check returns to its author", async () => {
  // A later delivery may name a DIFFERENT verdict runtime; the payload said so
  // while the session silently stayed on the first one, so the card described a
  // model the run was not using.
  nextSession = 800;
  const { run } = createRun({ useVerdict: true });
  const executor = agentExecutor.createWorkflowAgentExecutor(deps());
  const first = roleConfig("pi") as Record<string, unknown>;
  const second = { ...first, modelId: "pi-second" };
  const verdict = async (
    payload: Record<string, unknown>,
  ): Promise<WorkflowStepRow> => {
    const step = appendAgent(run.id, {
      role: "verdict",
      objective: "verdict",
      commitRange: { baseCommit: "base", headCommit: "head" },
      findings: [],
      resultContract: contracts.ASSESSMENT_CONTRACT_ID,
      ...payload,
    });
    await executor.dispatch({ run, step, actor: ACTOR });
    complete(step, contracts.ASSESSMENT_CONTRACT_ID, {
      verdict: "pass",
      headCommit: "head",
      findings: [],
    });
    return step;
  };

  const judged = await verdict({ verdict: first });
  // Its own re-check carries the same runtime, so it returns to that session.
  const reCheck = await verdict({ objective: "re-check", verdict: first });
  assert.equal(
    store.getStep(reCheck.id)!.executor?.id,
    store.getStep(judged.id)!.executor?.id,
    "the author re-checks in its own session",
  );

  // A different runtime is a different session, not the old one wearing a new
  // name on the card.
  const escalated = await verdict({ verdict: second });
  assert.notEqual(
    store.getStep(escalated.id)!.executor?.id,
    store.getStep(judged.id)!.executor?.id,
  );
});
