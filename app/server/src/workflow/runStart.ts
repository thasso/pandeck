/**
 * Starting a code-delivery Workflow Run (`docs/agent-workflows.md`, "The
 * code-delivery recipe" step 1, [Task-366](pa://task/366)).
 *
 * The start sheet's server side: validate what the user asked for, create the
 * durable run row, then provision the worktree and branch the run owns and
 * advance the engine. Ordering is deliberate:
 *
 * 1. Everything that can be refused CHEAPLY is checked before anything is
 *    created — unknown Task, no Project, no git-backed repo — so a refused
 *    start leaves nothing behind.
 * 2. The run row is created BEFORE provisioning. Provisioning can take minutes
 *    (submodules) and the process can die inside it; a durable run that pauses
 *    with the reason is recoverable state, while a worktree without a run would
 *    be debris nothing owns.
 * 3. A provisioning failure therefore PAUSES the run naming the error instead
 *    of throwing: the run is visible, the reason is on it, and cancelling it is
 *    the user's call.
 *
 * Starting is the user's authorization for exactly: the run's sessions, one new
 * worktree, local commits, and push plus PR creation after review passes. This
 * module grants none of that itself — it only records the run and provisions
 * the checkout; the executors of later steps act within that authorization.
 */
import {
  accountProviderForModelProvider,
  isTerminalWorkflowRunLifecycle,
  normalizeWorkflowRunLimits,
  supportedThinkingLevelsForModel,
  THINKING_LEVELS,
  WORKFLOW_CI_BOUNDS,
  WORKFLOW_CI_DEFAULTS,
  WORKFLOW_PROMPT_OVERRIDE_MAX_CHARS,
  WORKFLOW_ROLE_FAMILY_MAX_CHARS,
  WORKFLOW_ROLE_NOTES_MAX_CHARS,
  WORKFLOW_ROLE_SET_BOUNDS,
  type CodeDeliveryWorkflowConfig,
  type WorkflowActor,
  type WorkflowJsonValue,
  type WorkflowRoleCandidate,
  type WorkflowRoleConfig,
  type WorkflowRunLimits,
  type TaskItem,
  type WorkflowRunStartPhase,
} from "@assistant/shared";
import {
  automaticProfileIdFor,
  enabledCredentialProfileById,
} from "../credentialProfiles.ts";
import {
  attachRunWorktree,
  createRun,
  getRun,
  type WorkflowRunRow,
} from "../db/workflowStore.ts";
import { errorText } from "../errors.ts";
import { gitOptional } from "../gitExec.ts";
import { modelsForAccount } from "../harnesses/models.ts";
import { getProject, type ProjectRecord } from "../projectRegistry.ts";
import { getSettings } from "../settings.ts";
import { readTask } from "../tasks.ts";
import { createWorktree } from "../worktrees/worktrees.ts";
import {
  noMainRepoMessage,
  resolveMainRepo,
} from "../worktrees/worktreeResolve.ts";
import {
  generateWorktreeSuffix,
  taskWorktreeName,
} from "../worktrees/worktreeNaming.ts";
import { broadcastWorkflowRuns } from "../workflowRuns.ts";
import {
  CODE_DELIVERY_RECIPE_ID,
  CODE_DELIVERY_RECIPE_VERSION,
} from "./codeDeliveryRecipe.ts";
import { advanceRun, pauseRun } from "./engine.ts";
import type { WorkComplexity } from "./resultContracts.ts";

/** One progress/outcome update, relayed to the start sheet as it happens. */
interface WorkflowRunStartUpdate {
  phase: WorkflowRunStartPhase;
  runId?: number;
  branch?: string;
  error?: string;
}

export interface StartCodeDeliveryRunInput {
  taskId: string;
  config: CodeDeliveryWorkflowConfig;
  /** Local branch to fork from; omitted for the main checkout's branch. */
  baseBranch?: string;
  /** Omit to size both starting ceilings from the coordinator's complexity. */
  limits?: WorkflowRunLimits;
  actor: WorkflowActor;
  /** Called for each phase; the connection turns these into wire messages. */
  report?: (update: WorkflowRunStartUpdate) => void;
}

/** Automatic starting ceilings, applied after planning and before any work. */
const WORKFLOW_COMPLEXITY_STARTING_CEILINGS: Record<
  WorkComplexity,
  WorkflowRunLimits
> = {
  low: { maxIterations: 2, maxReviewPasses: 2 },
  medium: { maxIterations: 4, maxReviewPasses: 4 },
  high: { maxIterations: 6, maxReviewPasses: 6 },
};

/**
 * Return the atomic ceiling update carried by an automatic run's work-plan
 * completion. Older and explicitly configured runs return no update.
 */
export function startingCeilingUpdateForPlan(
  run: WorkflowRunRow,
  complexity: WorkComplexity,
):
  | {
      ceilings: WorkflowRunLimits;
      adjustment: WorkflowJsonValue;
    }
  | undefined {
  const config =
    run.config && typeof run.config === "object" && !Array.isArray(run.config)
      ? run.config
      : undefined;
  const starting = config?.startingCeilings;
  if (
    !starting ||
    typeof starting !== "object" ||
    Array.isArray(starting) ||
    starting.mode !== "plan-complexity"
  )
    return undefined;
  return {
    ceilings: WORKFLOW_COMPLEXITY_STARTING_CEILINGS[complexity],
    adjustment: {
      mode: "plan-complexity",
      complexity,
    },
  };
}

/**
 * Start a run for a Task. Throws — creating NOTHING — when the request is
 * refused up front; after the run row exists every failure lands on the run as
 * a pause instead. Resolves once provisioning settled either way, so callers
 * (and tests) observe a deterministic end state.
 */
export async function startCodeDeliveryRun(
  input: StartCodeDeliveryRunInput,
): Promise<WorkflowRunRow> {
  const task = readTask(input.taskId);
  if (!task) throw new Error(`Unknown Task: ${input.taskId}`);
  const taskId = Number(task.id);
  if (!Number.isInteger(taskId)) throw new Error(`Invalid Task id: ${task.id}`);
  const project = task.projectId ? getProject(task.projectId) : undefined;
  if (!project)
    throw new Error(
      `Task-${task.id} has no Project; a workflow run needs a git-backed Project to provision its worktree from.`,
    );
  const main = await resolveMainRepo(project);
  if (!main) throw new Error(await noMainRepoMessage(project));
  const baseBranch = await validateBaseBranch(input.baseBranch, main.root);

  if (input.config.coordinator.promptOverride?.trim())
    throw new Error(
      "The coordinator runtime cannot carry a prompt override; it judges Task context and run evidence only.",
    );
  const coordinator = await resolveRoleConfig(
    "coordinator",
    input.config.coordinator,
  );
  const roles = Object.fromEntries(
    await Promise.all(
      (["implementer", "reviewer", "fixer", "verdict"] as const).map(
        async (role) => {
          const candidates = input.config.roles?.[role];
          const bounds = WORKFLOW_ROLE_SET_BOUNDS[role];
          if (
            !Array.isArray(candidates) ||
            candidates.length < bounds.min ||
            candidates.length > bounds.max
          )
            throw new Error(
              `The workflow ${role} role set must contain between ${bounds.min} and ${bounds.max} configurations.`,
            );
          return [
            role,
            await Promise.all(
              candidates.map((candidate, index) =>
                resolveCandidateConfig(role, candidate, index),
              ),
            ),
          ] as const;
        },
      ),
    ),
  ) as CodeDeliveryWorkflowConfig["roles"];
  const implementerPromptOverride = promptOverrideOf(
    "implementer",
    input.config.implementerPromptOverride,
  );
  const reviewerPromptOverride = promptOverrideOf(
    "reviewer",
    input.config.reviewerPromptOverride,
  );
  const config: CodeDeliveryWorkflowConfig = {
    coordinator,
    roles,
    earlyPush: input.config.earlyPush ?? WORKFLOW_CI_DEFAULTS.enabled,
    ciTimeoutMs: boundedCiSetting(
      input.config.ciTimeoutMs,
      WORKFLOW_CI_DEFAULTS.timeoutMs,
      WORKFLOW_CI_BOUNDS.timeoutMs,
    ),
    ciPollIntervalMs: boundedCiSetting(
      input.config.ciPollIntervalMs,
      WORKFLOW_CI_DEFAULTS.pollIntervalMs,
      WORKFLOW_CI_BOUNDS.pollIntervalMs,
    ),
    ...(implementerPromptOverride ? { implementerPromptOverride } : {}),
    ...(reviewerPromptOverride ? { reviewerPromptOverride } : {}),
  };
  const explicitLimits = input.limits
    ? normalizeWorkflowRunLimits(input.limits)
    : undefined;
  // Automatic runs begin at the legal floors only long enough to obtain the
  // coordinator's plan. Its result raises these once, before implementation is
  // admitted; explicitly configured numbers are persisted unchanged instead.
  const limits = explicitLimits ?? { maxIterations: 0, maxReviewPasses: 1 };
  const run = createRun({
    taskId,
    projectId: project.id,
    recipeId: CODE_DELIVERY_RECIPE_ID,
    recipeVersion: CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: limits.maxIterations,
    maxReviewPasses: limits.maxReviewPasses,
    config: {
      coordinator: roleConfigJson(config.coordinator),
      roles: Object.fromEntries(
        Object.entries(config.roles).map(([role, candidates]) => [
          role,
          candidates.map(candidateConfigJson),
        ]),
      ),
      earlyPush: config.earlyPush ?? WORKFLOW_CI_DEFAULTS.enabled,
      ciTimeoutMs: config.ciTimeoutMs ?? WORKFLOW_CI_DEFAULTS.timeoutMs,
      ciPollIntervalMs:
        config.ciPollIntervalMs ?? WORKFLOW_CI_DEFAULTS.pollIntervalMs,
      startingCeilings: explicitLimits
        ? { mode: "explicit" }
        : { mode: "plan-complexity" },
      ...(config.implementerPromptOverride
        ? { implementerPromptOverride: config.implementerPromptOverride }
        : {}),
      ...(config.reviewerPromptOverride
        ? { reviewerPromptOverride: config.reviewerPromptOverride }
        : {}),
    },
    actor: input.actor,
  });
  broadcastWorkflowRuns();

  await provisionRunWorktree(run, task, project, input, baseBranch);
  return getRun(run.id) ?? run;
}

/** Validate an explicitly selected base before the durable run exists. */
async function validateBaseBranch(
  rawBaseBranch: string | undefined,
  mainRoot: string,
): Promise<string | undefined> {
  if (rawBaseBranch === undefined) return undefined;
  const baseBranch = rawBaseBranch.trim();
  if (!baseBranch) throw new Error("The workflow base branch cannot be empty.");
  const localRef = `refs/heads/${baseBranch}`;
  const local = await gitOptional(
    ["show-ref", "--verify", "--quiet", localRef],
    mainRoot,
  );
  if (local.code !== 0)
    throw new Error(
      `Workflow base branch "${baseBranch}" does not exist as a local branch.`,
    );
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  const remote = await gitOptional(
    ["show-ref", "--verify", "--quiet", remoteRef],
    mainRoot,
  );
  if (remote.code !== 0)
    throw new Error(
      `Workflow base branch "${baseBranch}" has not been pushed to origin.`,
    );
  return baseBranch;
}

/**
 * Provision the worktree and branch the run owns, attach them, and hand the run
 * to the engine. Never throws: after this point the run row is the durable
 * record, so a failure pauses it with the reason the card will show.
 */
async function provisionRunWorktree(
  run: WorkflowRunRow,
  task: TaskItem,
  project: ProjectRecord,
  input: StartCodeDeliveryRunInput,
  baseBranch: string | undefined,
): Promise<void> {
  const report = (update: Omit<WorkflowRunStartUpdate, "runId">) =>
    input.report?.({ ...update, runId: run.id });
  try {
    report({ phase: "naming" });
    // Naming never blocks creation (worktrees/CLAUDE.md): every failure path
    // inside falls back to a timestamp suffix.
    const proposed = await generateWorktreeSuffix(
      workflowNamingContext(task),
      getSettings().worktrees.namingAgent,
    );
    // Same convention as a Task-staged first send: the primary Jira key leads
    // the branch, with the internal Task id as fallback.
    const name = taskWorktreeName(task, proposed);
    report({ phase: "creating", branch: name });
    const record = await createWorktree({
      projectId: project.id,
      name,
      taskId: task.id,
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      onSubmodules: () => report({ phase: "submodules", branch: name }),
    });
    attachRunWorktree(
      run.id,
      { worktreeId: record.id, branch: record.branch },
      input.actor,
    );
    broadcastWorkflowRuns();
    // Hand over to the engine: it appends the first implement step and, until
    // step 4 registers the agent executor, pauses stating exactly that.
    await advanceRun(run.id, input.actor);
    report({ phase: "started", branch: record.branch });
  } catch (err) {
    const message = `worktree provisioning failed: ${errorText(err)}`;
    pauseProvisionedRun(run.id, message, input.actor);
    report({ phase: "failed", error: message });
  }
}

/** Pause the run with the provisioning failure, unless it already ended. */
function pauseProvisionedRun(
  runId: number,
  reason: string,
  actor: WorkflowActor,
): void {
  const run = getRun(runId);
  if (!run || isTerminalWorkflowRunLifecycle(run.lifecycle)) return;
  pauseRun(runId, reason, actor);
}

/** The naming agent's evidence: the Task's title and body. */
function workflowNamingContext(task: TaskItem): string {
  return [`Task: ${task.title}`, task.description?.slice(0, 2000) ?? ""]
    .filter(Boolean)
    .join("\n");
}

/**
 * A role config the run can be trusted to replay later. The wire shape is
 * untrusted input, and this config is a PERSISTED authorization the step-4
 * executor replays after any restart — so it is resolved against what is
 * actually runnable NOW, not merely shape-checked: the account must be a
 * currently ENABLED credential profile of the model's provider family (an
 * omitted account resolves to the automatic default), the model must be in
 * that account's own offered list (the same list the sheet's pickers show),
 * and the thinking level must be one that model accepts. A prompt override
 * over its bound is REJECTED rather than truncated — a cut instruction is a
 * different instruction.
 */
async function resolveRoleConfig(
  role: string,
  config: WorkflowRoleConfig,
): Promise<WorkflowRoleConfig> {
  const provider = config.provider?.trim();
  const modelId = config.modelId?.trim();
  if (!provider || !modelId)
    throw new Error(`The ${role} role needs a provider and a model.`);
  if (!THINKING_LEVELS.includes(config.thinkingLevel))
    throw new Error(
      `The ${role} role names an unknown thinking level "${String(config.thinkingLevel)}".`,
    );
  const promptOverride = config.promptOverride?.trim();
  if (
    promptOverride &&
    promptOverride.length > WORKFLOW_PROMPT_OVERRIDE_MAX_CHARS
  )
    throw new Error(
      `The ${role} prompt override is ${promptOverride.length} characters; the limit is ${WORKFLOW_PROMPT_OVERRIDE_MAX_CHARS}.`,
    );

  const family = accountProviderForModelProvider(provider);
  const requestedProfileId = config.credentialProfileId?.trim();
  const profileId = requestedProfileId ?? automaticProfileIdFor(family);
  const profile = enabledCredentialProfileById(profileId);
  if (!profile)
    throw new Error(
      `The ${role} account "${profileId}" is not an enabled credential profile.`,
    );
  if (profile.provider !== family)
    throw new Error(
      `The ${role} account "${profile.name}" is a ${profile.provider} account; model ${provider}:${modelId} needs a ${family} account.`,
    );

  // The same list the sheet's picker offers for that account, resolved fresh.
  const models = await modelsForAccount(profile);
  const model = models.find(
    (candidate) => candidate.provider === provider && candidate.id === modelId,
  );
  if (!model)
    throw new Error(
      `Model ${provider}:${modelId} is not available on the ${role} account "${profile.name}".`,
    );
  if (!supportedThinkingLevelsForModel(model).includes(config.thinkingLevel))
    throw new Error(
      `${model.name} does not accept thinking level "${config.thinkingLevel}" for the ${role} role.`,
    );

  return {
    provider,
    modelId,
    thinkingLevel: config.thinkingLevel,
    // Always the RESOLVED account, so the executor never re-derives a default
    // that may have moved by the time it builds the role's session.
    credentialProfileId: profile.id,
    ...(promptOverride ? { promptOverride } : {}),
  };
}

async function resolveCandidateConfig(
  role: keyof CodeDeliveryWorkflowConfig["roles"],
  config: WorkflowRoleCandidate,
  index: number,
): Promise<WorkflowRoleCandidate> {
  if (config.promptOverride?.trim())
    throw new Error(
      `The ${role} role set entry ${index + 1} cannot carry a prompt override; use the role-specific override instead.`,
    );
  const family = config.family?.trim();
  if (!family)
    throw new Error(`The ${role} role set entry ${index + 1} needs a family.`);
  if (family.length > WORKFLOW_ROLE_FAMILY_MAX_CHARS)
    throw new Error(
      `The ${role} role set entry ${index + 1} family is ${family.length} characters; the limit is ${WORKFLOW_ROLE_FAMILY_MAX_CHARS}.`,
    );
  const notes = config.notes?.trim();
  if (notes && notes.length > WORKFLOW_ROLE_NOTES_MAX_CHARS)
    throw new Error(
      `The ${role} role set entry ${index + 1} notes are ${notes.length} characters; the limit is ${WORKFLOW_ROLE_NOTES_MAX_CHARS}.`,
    );
  const runtime = await resolveRoleConfig(
    `${role} role set entry ${index + 1}`,
    config,
  );
  return { ...runtime, family, ...(notes ? { notes } : {}) };
}

function boundedCiSetting(
  value: number | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value))
    throw new Error("Workflow CI timing values must be finite numbers.");
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

function promptOverrideOf(
  role: string,
  value: string | undefined,
): string | undefined {
  const override = value?.trim();
  if (override && override.length > WORKFLOW_PROMPT_OVERRIDE_MAX_CHARS)
    throw new Error(
      `The ${role} prompt override is ${override.length} characters; the limit is ${WORKFLOW_PROMPT_OVERRIDE_MAX_CHARS}.`,
    );
  return override || undefined;
}

/** The role config as the opaque JSON the generic run column stores. */
function roleConfigJson(config: WorkflowRoleConfig): WorkflowJsonValue {
  return {
    provider: config.provider,
    modelId: config.modelId,
    thinkingLevel: config.thinkingLevel,
    ...(config.credentialProfileId
      ? { credentialProfileId: config.credentialProfileId }
      : {}),
    ...(config.promptOverride ? { promptOverride: config.promptOverride } : {}),
  };
}

function candidateConfigJson(config: WorkflowRoleCandidate): WorkflowJsonValue {
  return {
    provider: config.provider,
    modelId: config.modelId,
    thinkingLevel: config.thinkingLevel,
    ...(config.credentialProfileId
      ? { credentialProfileId: config.credentialProfileId }
      : {}),
    family: config.family,
    ...(config.notes ? { notes: config.notes } : {}),
  };
}
