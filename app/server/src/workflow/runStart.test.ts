/**
 * Starting a code-delivery Workflow Run ([Task-366](pa://task/366)). Run with:
 *   pnpm --filter @assistant/server test src/workflow/runStart.test.ts
 *
 * Against a real temp git repository and the real stores, like
 * `firstSendWorktreeProvision.test.ts`: the naming agent has no credentials
 * here, so `generateWorktreeSuffix` takes its documented timestamp fallback —
 * naming must never block a start. No agent executor is registered (that is
 * step 4), so a successful start is expected to end PAUSED saying exactly that,
 * with the first implement step reserved.
 *
 * Role configs are untrusted wire input that the run PERSISTS, so every
 * refusal test asserts the double negative: the start throws AND no run row
 * (and no worktree) was created.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";
import type {
  CodeDeliveryWorkflowConfig,
  WorkflowActor,
  WorkflowRunStartPhase,
} from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "workflow-run-start-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({ claudeSdk: { enabled: true } }),
);

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  );
}

const repoPath = join(tmp, "mainrepo");
mkdirSync(repoPath, { recursive: true });
sh(repoPath, "init", "-b", "main");
writeFileSync(join(repoPath, "readme.md"), "hello\n");
sh(repoPath, "add", "-A");
sh(repoPath, "commit", "-m", "init");

const { startCodeDeliveryRun, startingCeilingUpdateForPlan } =
  await import("./runStart.ts");
const store = await import("../db/workflowStore.ts");
const { resetWorkflowEngineForTests } = await import("./engine.ts");
const { createTask } = await import("../tasks.ts");
const { projectStore } = await import("../db/projectStore.ts");
const { getWorktree, taskIdsForWorktree, listWorktrees } =
  await import("../db/worktreeStore.ts");
const { createCredentialProfile, setCredentialProfileEnabled } =
  await import("../credentialProfiles.ts");
const { closeDb } = await import("../db/index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

projectStore.put({
  id: "wf-proj",
  name: "Workflow Project",
  key: "WF",
  description: "",
  status: "active",
  localPaths: [{ path: repoPath, kind: "repo", match: "prefix" }],
  worktreeRoot: join(tmp, "wt-root"),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
projectStore.put({
  id: "no-repo-proj",
  name: "No Repo Project",
  key: "NR",
  description: "",
  status: "active",
  localPaths: [],
  worktreeRoot: join(tmp, "wt-root"),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const USER: WorkflowActor = { kind: "user" };

// Real accounts, so the resolution being tested is the real one: two enabled
// Claude profiles, a disabled one, and an OpenAI profile for the family
// mismatch case.
const claudeProfile = createCredentialProfile({
  name: "Claude Main",
  provider: "claude",
});
const claudeProfileTwo = createCredentialProfile({
  name: "Claude Work",
  provider: "claude",
});
const disabledProfile = createCredentialProfile({
  name: "Claude Disabled",
  provider: "claude",
});
setCredentialProfileEnabled(disabledProfile.id, false);
const openAiProfile = createCredentialProfile({
  name: "OpenAI Main",
  provider: "openai-codex",
});

const config: CodeDeliveryWorkflowConfig = {
  coordinator: {
    provider: "claude-sdk",
    modelId: "haiku",
    thinkingLevel: "low",
    credentialProfileId: claudeProfile.id,
  },
  roles: {
    implementer: [
      {
        provider: "claude-sdk",
        modelId: "sonnet",
        thinkingLevel: "medium",
        credentialProfileId: claudeProfile.id,
        family: "claude",
      },
      {
        provider: "claude-sdk",
        modelId: "opus",
        thinkingLevel: "high",
        credentialProfileId: claudeProfileTwo.id,
        family: "claude",
      },
    ],
    reviewer: [
      {
        provider: "claude-sdk",
        modelId: "opus",
        thinkingLevel: "high",
        credentialProfileId: claudeProfileTwo.id,
        family: "claude",
      },
    ],
    fixer: [],
    verdict: [],
  },
  reviewerPromptOverride: "  Be strict about tests.  ",
};

/** A role set of `count` runnable configurations (all resolvable here). */
function candidatesOf(
  count: number,
): CodeDeliveryWorkflowConfig["roles"]["implementer"] {
  return Array.from({ length: count }, (_entry, index) => ({
    provider: "claude-sdk",
    modelId: ["sonnet", "opus", "haiku"][index % 3]!,
    thinkingLevel: "medium" as const,
    credentialProfileId: claudeProfile.id,
    family: "claude",
  }));
}

function makeTask(projectId?: string, jiraIssueKeys?: string[]): string {
  return createTask({
    title: "Add the widget",
    description: "The widget needs adding.",
    ...(projectId ? { projectId } : {}),
    ...(jiraIssueKeys ? { jiraIssueKeys } : {}),
    source: { createdBy: "user" },
  }).id;
}

/** Assert a refused start created NOTHING: no run row, no new worktree. */
async function assertRefused(
  taskId: string,
  brokenConfig: CodeDeliveryWorkflowConfig,
  pattern: RegExp,
): Promise<void> {
  const worktreesBefore = listWorktrees({}).length;
  await assert.rejects(
    startCodeDeliveryRun({
      taskId,
      config: brokenConfig,
      limits: { maxIterations: 3, maxReviewPasses: 1 },
      actor: USER,
    }),
    pattern,
  );
  assert.equal(store.listRuns().length, 0);
  assert.equal(listWorktrees({}).length, worktreesBefore);
}

beforeEach(() => {
  resetWorkflowEngineForTests();
  store.resetWorkflowStoreForTests();
});

test("a start provisions the worktree, records the config, and hands over to the engine", async () => {
  const taskId = makeTask("wf-proj", ["NEB-1234"]);
  const phases: WorkflowRunStartPhase[] = [];
  const run = await startCodeDeliveryRun({
    taskId,
    config,
    limits: { maxIterations: 3, maxReviewPasses: 1 },
    actor: USER,
    report: (update) => phases.push(update.phase),
  });

  assert.equal(run.taskId, Number(taskId));
  assert.equal(run.projectId, "wf-proj");
  assert.equal(run.recipeId, "code-delivery");
  assert.equal(run.maxIterations, 3);
  assert.equal(run.maxReviewPasses, 1);
  assert.equal(
    startingCeilingUpdateForPlan(run, "high"),
    undefined,
    "the plan cannot override explicitly configured ceilings",
  );

  // The captured config survives resolved and sanitized: trimmed override,
  // the RESOLVED account per role, no extras.
  assert.deepEqual(run.config, {
    coordinator: {
      provider: "claude-sdk",
      modelId: "haiku",
      thinkingLevel: "low",
      credentialProfileId: claudeProfile.id,
    },
    roles: {
      implementer: [
        {
          provider: "claude-sdk",
          modelId: "sonnet",
          thinkingLevel: "medium",
          credentialProfileId: claudeProfile.id,
          family: "claude",
        },
        {
          provider: "claude-sdk",
          modelId: "opus",
          thinkingLevel: "high",
          credentialProfileId: claudeProfileTwo.id,
          family: "claude",
        },
      ],
      reviewer: [
        {
          provider: "claude-sdk",
          modelId: "opus",
          thinkingLevel: "high",
          credentialProfileId: claudeProfileTwo.id,
          family: "claude",
        },
      ],
      fixer: [],
      verdict: [],
    },
    earlyPush: true,
    ciTimeoutMs: 600_000,
    ciPollIntervalMs: 5_000,
    startingCeilings: { mode: "explicit" },
    reviewerPromptOverride: "Be strict about tests.",
  });

  // The run owns a worktree whose branch leads with the primary Jira issue,
  // and the worktree is linked back to the Task like any Task-staged checkout.
  assert.ok(run.worktreeId, "worktree attached");
  assert.ok(run.branch?.startsWith("neb-1234-"), `branch ${run.branch}`);
  assert.deepEqual(taskIdsForWorktree(run.worktreeId!), [taskId]);

  // The engine advanced: the first worktree-free coordinator step is reserved, and
  // with no agent executor registered the run pauses saying exactly that.
  const steps = store.listSteps(run.id);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.kind, "agent");
  assert.equal(
    (steps[0]!.payload as Record<string, unknown>).role,
    "coordinator",
  );
  assert.equal(steps[0]!.status, "pending");
  assert.equal(run.lifecycle, "paused");
  assert.match(run.lifecycleReason ?? "", /no agent executor is registered/);

  assert.deepEqual(phases, ["naming", "creating", "started"]);
});

test("an explicitly selected pushed base is trimmed and passed to worktree creation", async () => {
  sh(repoPath, "branch", "epic", "main");
  sh(repoPath, "update-ref", "refs/remotes/origin/epic", "refs/heads/epic");
  const run = await startCodeDeliveryRun({
    taskId: makeTask("wf-proj"),
    config,
    baseBranch: "  epic  ",
    actor: USER,
  });

  assert.ok(run.worktreeId);
  const worktree = getWorktree(run.worktreeId!);
  assert.equal(worktree?.baseBranch, "epic");
  assert.equal(worktree?.baseCommit, sh(repoPath, "rev-parse", "epic").trim());
});

test("unknown and unpushed bases are refused before the run row is created", async () => {
  const taskId = makeTask("wf-proj");
  const worktreesBefore = listWorktrees({}).length;
  await assert.rejects(
    startCodeDeliveryRun({
      taskId,
      config,
      baseBranch: "missing-epic",
      actor: USER,
    }),
    /does not exist as a local branch/,
  );
  sh(repoPath, "branch", "local-only-epic", "main");
  await assert.rejects(
    startCodeDeliveryRun({
      taskId,
      config,
      baseBranch: "local-only-epic",
      actor: USER,
    }),
    /has not been pushed to origin/,
  );
  assert.equal(store.listRuns().length, 0);
  assert.equal(listWorktrees({}).length, worktreesBefore);
});

test("an automatic start waits at legal floors for the complexity plan", async () => {
  const taskId = makeTask("wf-proj");
  const run = await startCodeDeliveryRun({
    taskId,
    config,
    actor: USER,
  });

  assert.equal(run.maxIterations, 0);
  assert.equal(run.maxReviewPasses, 1);
  assert.deepEqual((run.config as Record<string, unknown>).startingCeilings, {
    mode: "plan-complexity",
  });
});

test("limits are clamped into the offered bounds", async () => {
  const taskId = makeTask("wf-proj");
  const run = await startCodeDeliveryRun({
    taskId,
    config,
    limits: { maxIterations: 999, maxReviewPasses: 99 },
    actor: USER,
  });
  assert.equal(run.maxIterations, 10);
  assert.equal(run.maxReviewPasses, 5);
});

test("optional roles change nothing about the run's ceilings", async () => {
  // They used to raise a session floor, because sessions were rationed beside
  // the ceilings; now they follow from them and a configured fixer or verdict
  // is purely a candidate set the coordinator may choose from.
  const candidate = config.roles.implementer[0]!;
  const run = await startCodeDeliveryRun({
    taskId: makeTask("wf-proj"),
    config: {
      ...config,
      roles: {
        ...config.roles,
        fixer: [candidate],
        verdict: [candidate],
      },
    },
    limits: { maxIterations: 3, maxReviewPasses: 2 },
    actor: USER,
  });
  assert.equal(run.maxReviewPasses, 2);
  assert.equal(run.maxIterations, 3);
});

test("role sets enforce their independent bounds", async () => {
  const six = await startCodeDeliveryRun({
    taskId: makeTask("wf-proj"),
    config: {
      ...config,
      roles: { ...config.roles, implementer: candidatesOf(6) },
    },
    limits: { maxIterations: 3, maxReviewPasses: 1 },
    actor: USER,
  });
  assert.equal(
    (six.config as { roles: { implementer: unknown[] } }).roles.implementer
      .length,
    6,
  );

  store.resetWorkflowStoreForTests();
  const taskId = makeTask("wf-proj");
  await assertRefused(
    taskId,
    { ...config, roles: { ...config.roles, reviewer: [] } },
    /reviewer role set must contain between 1 and 6 configurations/,
  );
  await assertRefused(
    taskId,
    { ...config, roles: { ...config.roles, verdict: candidatesOf(7) } },
    /verdict role set must contain between 0 and 6 configurations/,
  );
});

test("an unknown Task is refused before anything is created", async () => {
  await assert.rejects(
    startCodeDeliveryRun({
      taskId: "999999",
      config,
      limits: { maxIterations: 3, maxReviewPasses: 1 },
      actor: USER,
    }),
    /Unknown Task/,
  );
  assert.equal(store.listRuns().length, 0);
});

test("a Task without a git-backed Project is refused before anything is created", async () => {
  await assertRefused(makeTask(), config, /has no Project/);
  await assertRefused(
    makeTask("no-repo-proj"),
    config,
    /no local path that is a git repository/,
  );
});

test("an unknown or disabled account is refused before anything is created", async () => {
  const taskId = makeTask("wf-proj");
  await assertRefused(
    taskId,
    {
      ...config,
      roles: {
        ...config.roles,
        implementer: [
          { ...config.roles.implementer[0]!, credentialProfileId: "cp_gone" },
        ],
      },
    },
    /implementer role set entry 1 account "cp_gone" is not an enabled credential profile/,
  );
  await assertRefused(
    taskId,
    {
      ...config,
      roles: {
        ...config.roles,
        reviewer: [
          {
            ...config.roles.reviewer[0]!,
            credentialProfileId: disabledProfile.id,
          },
        ],
      },
    },
    /reviewer role set entry 1 account .* is not an enabled credential profile/,
  );
});

test("an account of the wrong provider family is refused", async () => {
  await assertRefused(
    makeTask("wf-proj"),
    {
      ...config,
      roles: {
        ...config.roles,
        implementer: [
          {
            ...config.roles.implementer[0]!,
            credentialProfileId: openAiProfile.id,
          },
        ],
      },
    },
    /is a openai-codex account; model claude-sdk:sonnet needs a claude account/,
  );
});

test("a model the account does not offer is refused", async () => {
  await assertRefused(
    makeTask("wf-proj"),
    {
      ...config,
      roles: {
        ...config.roles,
        reviewer: [
          { ...config.roles.reviewer[0]!, modelId: "claude-sonnet-5" },
        ],
      },
    },
    /claude-sdk:claude-sonnet-5 is not available on the reviewer role set entry 1 account/,
  );
});

test("a thinking level the model does not accept is refused", async () => {
  await assertRefused(
    makeTask("wf-proj"),
    {
      ...config,
      // Fable accepts low…xhigh only; "off" is not among them (the account's
      // offered list, the same one the sheet's picker shows, decides).
      roles: {
        ...config.roles,
        implementer: [
          {
            ...config.roles.implementer[0]!,
            modelId: "fable",
            thinkingLevel: "off",
          },
        ],
      },
    },
    /does not accept thinking level "off" for the implementer role set entry 1 role/,
  );
});

test("an oversized prompt override is rejected, not truncated", async () => {
  await assertRefused(
    makeTask("wf-proj"),
    {
      ...config,
      implementerPromptOverride: "x".repeat(4_001),
    },
    /prompt override/,
  );
});

test("a provisioning failure pauses the durable run with the reason", async () => {
  const taskId = makeTask("wf-proj");
  // Sabotage worktree creation only: the repo resolves (createRun proceeds),
  // but `git worktree add` cannot create the checkout because a FILE occupies
  // the worktree root.
  const project = projectStore.get("wf-proj")!;
  const brokenRoot = join(tmp, "broken-root");
  writeFileSync(brokenRoot, "not a directory\n");
  projectStore.put({ ...project, worktreeRoot: brokenRoot });
  try {
    const phases: WorkflowRunStartPhase[] = [];
    const run = await startCodeDeliveryRun({
      taskId,
      config,
      limits: { maxIterations: 3, maxReviewPasses: 1 },
      actor: USER,
      report: (update) => phases.push(update.phase),
    });
    assert.equal(run.lifecycle, "paused");
    assert.match(run.lifecycleReason ?? "", /worktree provisioning failed/);
    assert.equal(run.worktreeId, undefined);
    assert.equal(phases[phases.length - 1], "failed");
  } finally {
    projectStore.put(project);
  }
});
