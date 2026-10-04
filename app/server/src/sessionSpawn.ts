/**
 * Agent-spawned peer sessions ([Task-553](pa://task/553)).
 *
 * An agent proposes a BATCH of new sessions; the user reviews one approval card
 * and only then does anything exist. Approving creates each session and hands it
 * its opening prompt as a peer prompt from the proposer, which is what lets a
 * coordinating agent set up an implementer and a reviewer without the user
 * copying session ids by hand.
 *
 * These are ordinary `scope = 'user'` sessions — watchable, steerable and
 * re-promptable by the human — not subagents: nothing here belongs to the
 * subagent registry, and nothing here may import it.
 *
 * Two authorities are deliberately split. The AGENT owns what it can be held to:
 * the title, the persona, the target checkout and the opening prompt; a mistake
 * there throws and no card is written. The USER owns what only a human should
 * decide: which account, model and thinking level each session runs on, and
 * whether a row runs at all. An agent's model hint is therefore a hint — it is
 * resolved for display, flagged when it does not survive, and overridable in the
 * card.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  accountProviderForModelProvider,
  type ApprovalBody,
  type ApprovalCard,
  type ApprovalResolutionEdits,
  CLAUDE_SDK_PROVIDER,
  HARNESSES,
  harnessForModelProvider,
  type ModelOption,
  type SessionSpawnApprovalBody,
  type SessionSpawnApprovalItem,
  type SessionSpawnResolutionEdits,
  supportedThinkingLevelsForModel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@assistant/shared";
import {
  credentialProfileById,
  enabledCredentialProfileById,
  automaticProfileIdFor,
} from "./credentialProfiles.ts";
import { sessionStore, type SessionMeta } from "./db/sessionStore.ts";
import { errorText } from "./errors.ts";
import { getProject } from "./projectRegistry.ts";
import { findModelForProfile } from "./piSdk/models.ts";
import {
  admitDirectPeerTurns,
  modelsForProfile,
  recordDirectPeerChild,
  resolveApprovedPeerRuntime,
  withReportingRoute,
  type ApprovedPeerRuntime,
} from "./peerSpawnRuntimes.ts";
import { registerApprovalExecutor } from "./pendingApprovals.ts";
import { sendPeerPrompt } from "./peerPrompt.ts";
import type { LiveSession } from "./harness.ts";
import type { NewSession } from "./harnesses/create.ts";
import {
  applySessionContext,
  resolveSessionContext,
  sessionContextEvidence,
} from "./sessionContext.ts";
import { readTask } from "./tasks.ts";
import { broadcastWorktreeEdgeChange } from "./worktrees/worktrees.ts";
import {
  isMainWorktreeId,
  mainCheckoutPathForProject,
  resolveWorktreeRow,
} from "./worktrees/worktreeResolve.ts";

/** How many sessions one proposal may carry: a card nobody can read is not a gate. */
export const MAX_SPAWN_ROWS = 8;

/** Titles are sidebar entries, and the naming agent's own ceiling is 60. */
export const MAX_SPAWN_TITLE_CHARS = 60;

type SpawnAgentType = "developer" | "assistant";

/** One row as the agent asked for it, before any resolution. */
export interface SpawnRequestRow {
  title: string;
  agentType: SpawnAgentType;
  prompt: string;
  responseRequested?: boolean;
  worktreeId?: string;
  projectId?: string;
  taskId?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
}

/** Raised for a proposal the AGENT can fix; no card is created. */
export class SpawnProposalError extends Error {}

/* --------------------------- runtime resolution --------------------------- */

interface ResolvedRuntime {
  provider: string;
  modelId: string;
  modelName?: string;
  credentialProfileId: string;
  accountName?: string;
  thinkingLevel: ThinkingLevel;
  warning?: string;
}

/** What an un-hinted row inherits: whatever the proposing session runs on. */
interface SpawnFallbackRuntime {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * The proposer's own runtime, or nothing when its row cannot supply one.
 *
 * A claude-sdk session persists its provider as the account family `claude`,
 * while the model pickers speak {@link CLAUDE_SDK_PROVIDER} — so the harness,
 * not the stored string, is what identifies that family here.
 */
function fallbackRuntimeOf(
  meta: SessionMeta | undefined,
): SpawnFallbackRuntime | undefined {
  if (!meta?.model) return undefined;
  const provider = HARNESSES[meta.harness].modelProvider ?? meta.provider;
  if (!provider) return undefined;
  return {
    provider,
    modelId: meta.model,
    thinkingLevel:
      (meta.thinkingLevel as ThinkingLevel | undefined) ?? "medium",
  };
}

/**
 * The greatest supported level at or below the request.
 *
 * Never rounds upward: a hint is a ceiling, and turning `minimal` into a
 * model's `xhigh` because the exact level is missing from its ladder would make
 * the cheapest hint the most expensive setting. Only a model whose whole ladder
 * starts above the request (Fable has no `off`) falls back to its lowest level,
 * which is then the closest honest answer. An unrecognized level lands there
 * too, so an untrusted value can never buy more thinking than it asked for.
 */
function clampThinking(
  level: ThinkingLevel,
  model: ModelOption,
): ThinkingLevel {
  const supported = supportedThinkingLevelsForModel(model);
  if (supported.includes(level)) return level;
  const wanted = THINKING_LEVELS.indexOf(level);
  const ordered = [...supported].sort(
    (a, b) => THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b),
  );
  const atOrBelow = ordered.filter(
    (candidate) => wanted >= 0 && THINKING_LEVELS.indexOf(candidate) <= wanted,
  );
  return atOrBelow[atOrBelow.length - 1] ?? ordered[0] ?? "off";
}

function accountNameOf(profileId: string): string | undefined {
  return credentialProfileById(profileId)?.name;
}

function runtimeOf(
  profileId: string,
  model: ModelOption,
  level: ThinkingLevel,
): ResolvedRuntime {
  const accountName = accountNameOf(profileId);
  return {
    provider: model.provider,
    modelId: model.id,
    ...(model.name ? { modelName: model.name } : {}),
    credentialProfileId: profileId,
    ...(accountName ? { accountName } : {}),
    thinkingLevel: clampThinking(level, model),
  };
}

/** Accounts to try for a provider: the proposer's own first, then automatic. */
function candidateProfiles(
  provider: string,
  preferredProfileId: string | undefined,
): string[] {
  const family = accountProviderForModelProvider(provider);
  const ids: string[] = [];
  if (
    preferredProfileId &&
    enabledCredentialProfileById(preferredProfileId)?.provider === family
  )
    ids.push(preferredProfileId);
  const automatic = automaticProfileIdFor(family);
  if (!ids.includes(automatic) && enabledCredentialProfileById(automatic))
    ids.push(automatic);
  return ids;
}

/** Any runnable account/model, preferring the proposer's own account. */
async function firstAvailableRuntime(
  preferredProfileId: string | undefined,
  level: ThinkingLevel,
): Promise<ResolvedRuntime | undefined> {
  const ordered = [
    ...(preferredProfileId && enabledCredentialProfileById(preferredProfileId)
      ? [preferredProfileId]
      : []),
    automaticProfileIdFor("claude"),
    automaticProfileIdFor("openai-codex"),
  ];
  for (const profileId of new Set(ordered)) {
    if (!enabledCredentialProfileById(profileId)) continue;
    const [model] = await modelsForProfile(profileId);
    if (!model) continue;
    return runtimeOf(profileId, model, level);
  }
  return undefined;
}

/** One account/model pair a resolution attempt may land on. */
async function tryRuntime(
  provider: string,
  modelId: string,
  level: ThinkingLevel,
  preferredProfileId: string | undefined,
): Promise<ResolvedRuntime | undefined> {
  for (const profileId of candidateProfiles(provider, preferredProfileId)) {
    const model = (await modelsForProfile(profileId)).find(
      (option) => option.provider === provider && option.id === modelId,
    );
    if (model) return runtimeOf(profileId, model, level);
  }
  return undefined;
}

/**
 * The runtime a row would actually run on, plus what was lost on the way there.
 *
 * A hint that does not resolve NEVER fails the proposal: the user is looking at
 * this card precisely so they can choose the model, and refusing a whole batch
 * because an agent guessed a model id that does not exist is a worse trade than
 * showing them a working default with a note saying so. The ladder down from a
 * dead hint is deliberate — the proposer's own runtime first, since inheriting
 * it is what an un-hinted row would have done anyway, and only then whatever
 * any enabled account can run.
 */
async function resolveRuntime(
  row: SpawnRequestRow,
  fallback: SpawnFallbackRuntime | undefined,
  preferredProfileId: string | undefined,
): Promise<ResolvedRuntime> {
  const hintedProvider = row.provider?.trim();
  const hintedModelId = row.modelId?.trim();
  const level = row.thinkingLevel ?? fallback?.thinkingLevel ?? "medium";

  const wantedProvider = hintedProvider || fallback?.provider;
  const wantedModelId = hintedModelId || fallback?.modelId;
  // Either field alone is a hint: `modelId: "sonnet"` from an OpenAI parent
  // resolves against the PARENT's provider and usually fails, and the user must
  // see the pair that was actually tried rather than nothing at all.
  const asked =
    hintedProvider || hintedModelId
      ? `${wantedProvider ?? "?"}/${wantedModelId ?? "?"}`
      : undefined;
  if (wantedProvider && wantedModelId) {
    const exact = await tryRuntime(
      wantedProvider,
      wantedModelId,
      level,
      preferredProfileId,
    );
    if (exact) return exact;
  }

  const inherited =
    fallback &&
    (fallback.provider !== wantedProvider || fallback.modelId !== wantedModelId)
      ? await tryRuntime(
          fallback.provider,
          fallback.modelId,
          level,
          preferredProfileId,
        )
      : undefined;
  const fell =
    inherited ?? (await firstAvailableRuntime(preferredProfileId, level));
  if (!fell)
    throw new SpawnProposalError(
      "No enabled provider account offers a model right now — enable an account in Settings first.",
    );
  if (!asked) return fell;
  return {
    ...fell,
    warning: `${asked} is not available on any enabled account — this would run ${fell.provider}/${fell.modelId} instead.`,
  };
}

/* ------------------------------- worktrees -------------------------------- */

/** A checkout a spawned session can actually run in. */
interface SpawnWorktree {
  /** Canonical id — a `main:<projectId>` alias collapses to the registry's key. */
  id: string;
  path: string;
  projectId: string;
  branch: string;
}

/**
 * Resolve a worktree id the way the session-creation paths do, and only accept
 * one a session could really run in.
 *
 * `resolveWorktreeRow` — not the DB-only `getWorktree` — is the canonical
 * resolver: a project's MAIN checkout is a synthetic `main:<projectId>` row that
 * `worktree_status` shows and an agent will copy, so reading the table directly
 * would reject exactly the target that the "spawn in any worktree" workflow
 * needs most. Main also runs in the project's checkout path rather than the
 * row's, and both paths are proven to exist here: an absent folder means the
 * session would silently run somewhere else.
 */
async function resolveSpawnWorktree(
  id: string,
): Promise<SpawnWorktree | undefined> {
  const row = await resolveWorktreeRow(id);
  if (!row || row.status !== "active" || !existsSync(row.path))
    return undefined;
  const path = isMainWorktreeId(row.id)
    ? mainCheckoutPathForProject(row.projectId)
    : row.path;
  if (!path || !existsSync(path)) return undefined;
  return { id: row.id, path, projectId: row.projectId, branch: row.branch };
}

/* --------------------------- structural validation ------------------------ */

/** One row's targets, proven to exist. Shared by both spawn paths. */
interface StructuralRow {
  title: string;
  agentType: SpawnAgentType;
  prompt: string;
  worktree?: SpawnWorktree;
  projectId?: string;
  projectName?: string;
  taskId?: string;
  taskTitle?: string;
}

/**
 * Everything the AGENT is accountable for, checked before anything exists.
 *
 * Both the proposal and the direct path go through here, so a wrong title,
 * persona, worktree, Project or Task costs a tool error in exactly the same way
 * whether or not the runtime was pre-approved.
 */
async function validateStructure(row: SpawnRequestRow): Promise<StructuralRow> {
  const title = row.title?.trim() ?? "";
  if (!title) throw new SpawnProposalError("Every session needs a title.");
  if (title.length > MAX_SPAWN_TITLE_CHARS)
    throw new SpawnProposalError(
      `"${title.slice(0, 20)}…" is ${title.length} characters; a title may be at most ${MAX_SPAWN_TITLE_CHARS}.`,
    );
  if (row.agentType !== "developer" && row.agentType !== "assistant")
    throw new SpawnProposalError(
      `agentType must be "developer" or "assistant" (got "${String(row.agentType)}").`,
    );
  const prompt = row.prompt?.trim() ?? "";
  if (!prompt)
    throw new SpawnProposalError(
      `"${title}" has no opening prompt. A session comes into existence with its first prompt, so every row needs one.`,
    );

  const wantedWorktreeId = row.worktreeId?.trim();
  const worktree = wantedWorktreeId
    ? await resolveSpawnWorktree(wantedWorktreeId)
    : undefined;
  if (wantedWorktreeId && !worktree)
    throw new SpawnProposalError(
      `Worktree ${wantedWorktreeId} does not exist, was removed, or its checkout is gone.`,
    );
  if (row.agentType === "developer" && !worktree)
    throw new SpawnProposalError(
      `"${title}" is a developer session, which must run in a worktree — name a registered worktreeId.`,
    );

  // A Project the AGENT named must exist — it can fix that. One inherited
  // from the worktree is dropped when the registry does not know it: an
  // unregistered id carries no context, and failing the row over a checkout's
  // stale metadata would block work nobody asked to be about that Project.
  const namedProjectId = row.projectId?.trim();
  const project = getProject(namedProjectId || worktree?.projectId || "");
  if (namedProjectId && !project)
    throw new SpawnProposalError(
      `Project ${namedProjectId} is not in the registry.`,
    );

  const taskId = row.taskId?.trim();
  const task = taskId ? readTask(taskId) : null;
  if (taskId && !task)
    throw new SpawnProposalError(`Task ${taskId} does not exist.`);

  return {
    title,
    agentType: row.agentType,
    prompt,
    ...(worktree ? { worktree } : {}),
    ...(project?.id ? { projectId: project.id } : {}),
    ...(project?.name ? { projectName: project.name } : {}),
    ...(taskId ? { taskId } : {}),
    ...(task?.title ? { taskTitle: task.title } : {}),
  };
}

/** The shared batch-size gate; both paths carry the same ceiling. */
function assertBatchSize(rows: readonly unknown[]): void {
  if (rows.length === 0)
    throw new SpawnProposalError("sessions must contain at least one entry.");
  if (rows.length > MAX_SPAWN_ROWS)
    throw new SpawnProposalError(
      `sessions may contain at most ${MAX_SPAWN_ROWS} entries (${rows.length} given).`,
    );
}

/* ------------------------------- proposal -------------------------------- */

export interface SpawnProposalInput {
  /** The proposing session; its runtime is what an un-hinted row inherits. */
  senderSessionId: string;
  rows: SpawnRequestRow[];
}

/**
 * Validate and resolve a batch into the card body. Throws
 * {@link SpawnProposalError} for anything the agent stated wrongly — that must
 * cost a tool error, not a card the user has to reject.
 */
export async function buildSpawnProposal(
  input: SpawnProposalInput,
): Promise<SessionSpawnApprovalBody> {
  assertBatchSize(input.rows);

  const sender = sessionStore.get(input.senderSessionId);
  const fallback = fallbackRuntimeOf(sender);

  const items: SessionSpawnApprovalItem[] = [];
  for (const row of input.rows) {
    const structural = await validateStructure(row);
    const runtime = await resolveRuntime(
      row,
      fallback,
      sender?.credentialProfileId,
    );
    items.push({
      ...approvalItemOf(structural),
      responseRequested: row.responseRequested === true,
      provider: runtime.provider,
      modelId: runtime.modelId,
      ...(runtime.modelName ? { modelName: runtime.modelName } : {}),
      credentialProfileId: runtime.credentialProfileId,
      ...(runtime.accountName ? { accountName: runtime.accountName } : {}),
      thinkingLevel: runtime.thinkingLevel,
      ...(runtime.warning ? { modelWarning: runtime.warning } : {}),
    });
  }
  return { kind: "sessionSpawn", items };
}

/** The structural half of a row, in the shape the executor consumes. */
function approvalItemOf(
  structural: StructuralRow,
): Omit<
  SessionSpawnApprovalItem,
  | "provider"
  | "modelId"
  | "credentialProfileId"
  | "thinkingLevel"
  | "responseRequested"
> {
  return {
    rowId: `row_${randomUUID().slice(0, 8)}`,
    title: structural.title,
    agentType: structural.agentType,
    prompt: structural.prompt,
    ...(structural.worktree
      ? {
          worktreeId: structural.worktree.id,
          worktreeName: structural.worktree.branch,
        }
      : {}),
    ...(structural.projectId ? { projectId: structural.projectId } : {}),
    ...(structural.projectName ? { projectName: structural.projectName } : {}),
    ...(structural.taskId ? { taskId: structural.taskId } : {}),
    ...(structural.taskTitle ? { taskTitle: structural.taskTitle } : {}),
  };
}

/* ------------------------- approve-time settlement ------------------------ */

/** Merge one row's edit, without deciding yet whether the result can run. */
function editedItem(
  item: SessionSpawnApprovalItem,
  edit: SessionSpawnResolutionEdits["items"][number] | undefined,
): SessionSpawnApprovalItem {
  if (!edit) return item;
  // The user has now chosen deliberately, so the proposal's warning about a
  // hint that did not survive is spent and must not outlive their pick.
  const repicked = Boolean(
    edit.provider || edit.modelId || edit.credentialProfileId,
  );
  const { modelWarning, ...rest } = item;
  return {
    ...rest,
    ...(repicked || !modelWarning ? {} : { modelWarning }),
    provider: edit.provider?.trim() || item.provider,
    modelId: edit.modelId?.trim() || item.modelId,
    credentialProfileId:
      edit.credentialProfileId?.trim() || item.credentialProfileId,
    ...(edit.thinkingLevel ? { thinkingLevel: edit.thinkingLevel } : {}),
    ...(edit.skip === undefined ? {} : { skipped: edit.skip }),
  } satisfies SessionSpawnApprovalItem;
}

/**
 * Prove one row can run exactly as the card now reads, and return it with the
 * account's own naming and a supported thinking level.
 *
 * This runs for EVERY row that will execute, edited or not. An untouched row is
 * no safer than an edited one: a card can sit pending while an account is
 * disabled or a model withdrawn, and the edits arrive from a browser, so
 * "the agent proposed it" is not evidence that it is still runnable. Failing
 * here is the point — the card stays pending and the user re-picks — because
 * the alternative is creating a session on a runtime they never approved.
 */
async function settledItem(
  item: SessionSpawnApprovalItem,
): Promise<SessionSpawnApprovalItem> {
  const profile = enabledCredentialProfileById(item.credentialProfileId);
  if (!profile)
    throw new Error(
      `The account for "${item.title}" is not enabled — pick another one, or skip that row.`,
    );
  if (profile.provider !== accountProviderForModelProvider(item.provider))
    throw new Error(
      `"${profile.name}" cannot run ${item.provider} models — pick a matching account for "${item.title}".`,
    );
  const model = (await modelsForProfile(item.credentialProfileId)).find(
    (option) => option.provider === item.provider && option.id === item.modelId,
  );
  if (!model)
    throw new Error(
      `"${profile.name}" no longer offers ${item.provider}/${item.modelId} — pick another model for "${item.title}", or skip that row.`,
    );
  return {
    ...item,
    modelName: model.name,
    accountName: profile.name,
    // Clamped, not refused: the level is derived from a model choice the user
    // may have just changed, and clamping only ever moves it DOWN.
    thinkingLevel: clampThinking(item.thinkingLevel, model),
  };
}

/**
 * The `prepare` seam: fold in the user's changes, then settle what will run.
 * Called on every approval, with or without edits.
 */
export async function prepareSpawnApproval(
  card: ApprovalCard,
  edits: ApprovalResolutionEdits | undefined,
): Promise<ApprovalBody> {
  if (card.body.kind !== "sessionSpawn") return card.body;
  const spawnEdits = edits?.kind === "sessionSpawn" ? edits : undefined;
  const byRow = new Map(
    (spawnEdits?.items ?? []).map((item) => [item.rowId, item]),
  );
  for (const rowId of byRow.keys())
    if (!card.body.items.some((item) => item.rowId === rowId))
      throw new Error(
        `This card has no row ${rowId} — reload the session and decide again.`,
      );
  const items: SessionSpawnApprovalItem[] = [];
  for (const original of card.body.items) {
    const item = editedItem(original, byRow.get(original.rowId));
    items.push(item.skipped ? item : await settledItem(item));
  }
  return { kind: "sessionSpawn", items };
}

/* -------------------------------- execution ------------------------------- */

/** A pi model handle on the session's account, as creation takes it. */
type PiSessionModel = Extract<NewSession, { harness: "pi" }>["model"];

/** Injectable creation/delivery seams; validation and linking stay real. */
export interface SessionSpawnDeps {
  newSessionId(): string;
  /** The pi model a row names, on its account; undefined when it is gone. */
  findPiModel(
    credentialProfileId: string,
    provider: string,
    modelId: string,
  ): Promise<PiSessionModel | undefined>;
  /** Create and register the session (`harnesses/create.ts`). */
  create(spec: NewSession): Promise<LiveSession>;
  deliver(input: {
    senderSessionId: string;
    targetSessionId: string;
    prompt: string;
    responseRequested: boolean;
    taskId?: string;
  }): Promise<void>;
  broadcastSessions(): void;
}

/**
 * `hub` is reached through a dynamic import, never a static one: it constructs
 * the session hub at module load, and this module is pulled in transitively by
 * the tool catalog — a static edge closes an initialization cycle that fails as
 * a TDZ error in whichever module the importer happens to be initializing.
 */
async function harnessHub() {
  return (await import("./hub.ts")).hub;
}

const REAL_DEPS: SessionSpawnDeps = {
  newSessionId: randomUUID,
  findPiModel: findModelForProfile,
  // Dynamic for the same reason as `harnessHub`: creation reaches the Claude
  // store, whose tool catalog pulls this module in.
  create: async (spec) =>
    (await import("./harnesses/create.ts")).createSession(spec),
  deliver: async (input) => {
    await sendPeerPrompt({
      senderSessionId: input.senderSessionId,
      targetSessionId: input.targetSessionId,
      prompt: input.prompt,
      responseRequested: input.responseRequested,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    });
  },
  broadcastSessions: () => {
    void harnessHub().then((instance) => instance.broadcastSessions());
  },
};

let deps: SessionSpawnDeps = REAL_DEPS;

/** Test seam: replace session creation and peer delivery. */
export function setSessionSpawnDepsForTests(
  override: Partial<SessionSpawnDeps> | null,
): void {
  deps = override ? { ...REAL_DEPS, ...override } : REAL_DEPS;
}

/**
 * Create one row's session and hand it its opening prompt.
 *
 * The prompt travels as a peer prompt from the proposer rather than as a system
 * prompt: that is what gives the new session a named sender to answer, and — as
 * a first exchange between two sessions with no shared history — it opens a
 * fresh causal chain with a full hop budget, which is the honest reading of a
 * spawn a human just approved.
 *
 * Everything the creation depends on is revalidated FIRST, because from the
 * moment the session exists there is no clean way back: a card can sit pending
 * while its worktree is removed or its Task deleted, and a delivery that fails
 * after creation leaves a real session in the sidebar. Hence the second rule —
 * `item.resultSessionId` is written the instant the session exists, before
 * delivery, so a later failure reports a row that has BOTH an id and an error
 * rather than an orphan nobody can find.
 */
async function spawnOne(
  senderSessionId: string,
  item: SessionSpawnApprovalItem,
  options: SpawnOneOptions = {},
): Promise<void> {
  const worktree = item.worktreeId
    ? await resolveSpawnWorktree(item.worktreeId)
    : undefined;
  if (item.worktreeId && !worktree)
    throw new Error(
      `Worktree ${item.worktreeId} was removed, or its checkout is gone, since this was proposed.`,
    );
  // The Task is a delivery input (`sendPeerPrompt` rejects a missing one), so a
  // Task deleted while the card waited must stop this BEFORE a session exists.
  if (item.taskId && !readTask(item.taskId))
    throw new Error(
      `Task ${item.taskId} was deleted since this was proposed — nothing was created for "${item.title}".`,
    );
  // Resolved before creation, applied after: the same rule and the same pairing
  // of frozen evidence to attachments every other trigger uses
  // (`sessionContext.ts`). The card's own Project is passed, never re-derived
  // from the worktree — what the user approved is what the session gets — and
  // the row's Project beating the worktree's is what lets one agent drive a
  // cross-project epic.
  const context = resolveSessionContext({
    ...(item.taskId ? { taskId: item.taskId } : {}),
    ...(item.projectId ? { projectId: item.projectId } : {}),
  });
  const evidence = sessionContextEvidence(context);
  // The Project is context, not decoration: it becomes an `in_project` edge and
  // frozen prompt evidence. Checking the RESOLVED one rather than the row's
  // keeps this honest — it validates exactly what will be applied — and a
  // Project deleted while the card waited stops the row instead of silently
  // dropping the context the card showed.
  if (evidence.projectId && !getProject(evidence.projectId))
    throw new Error(
      `Project ${evidence.projectId} was removed from the registry since this was proposed — nothing was created for "${item.title}".`,
    );

  // THE LAST READ BEFORE THE SIDE EFFECT. Everything above only inspected
  // state, and every `await` it spent is a window in which the human could have
  // disabled, deleted or re-pointed the approved row — so a runtime resolved
  // before those awaits is a claim about the past. A caller whose runtime comes
  // from live settings re-resolves here and the row runs on THAT, or not at
  // all; nothing between this call and `deps.create*` yields to the event loop.
  if (options.currentRuntime) {
    const runtime = await options.currentRuntime();
    item.provider = runtime.provider;
    item.modelId = runtime.modelId;
    item.credentialProfileId = runtime.credentialProfileId;
    item.thinkingLevel = runtime.thinkingLevel;
    if (runtime.modelName) item.modelName = runtime.modelName;
    if (runtime.accountName) item.accountName = runtime.accountName;
  }

  // What the session starts with, whichever engine runs it: creation links
  // its worktree, freezes its prompt conditions and skills before the first
  // query, and titles it, which also stops it being auto-named.
  const start = {
    agentType: item.agentType,
    thinkingLevel: item.thinkingLevel,
    credentialProfileId: item.credentialProfileId,
    promptEvidence: evidence,
    title: item.title,
    ...(worktree ? { worktree: { id: worktree.id, path: worktree.path } } : {}),
  };
  let spec: NewSession;
  if (item.provider === CLAUDE_SDK_PROVIDER) {
    spec = {
      harness: "claude-sdk",
      id: deps.newSessionId(),
      modelId: item.modelId,
      ...start,
    };
  } else {
    const model = await deps.findPiModel(
      item.credentialProfileId,
      item.provider,
      item.modelId,
    );
    if (!model)
      throw new Error(
        `${item.provider}/${item.modelId} is no longer available on this account.`,
      );
    spec = { harness: "pi", model, ...start };
  }
  const sessionId = (await deps.create(spec)).sessionId;
  // From here the session is real: claim it on the result row immediately so
  // any later metadata, context, or delivery failure still reports the child.
  item.resultSessionId = sessionId;
  const harness = harnessForModelProvider(item.provider);
  // Both real creation paths already write metadata. This merge is also the
  // explicit ordering gate for injected adapters and future harnesses: the
  // foreign-keyed spawn edge is written only after the child row exists, and
  // before context application can yield into opening-prompt delivery.
  if (
    !sessionStore.upsert({
      id: sessionId,
      harness,
      agentType: item.agentType,
      title: item.title,
      credentialProfileId: item.credentialProfileId,
    })
  )
    throw new Error(
      `Session ${sessionId} was created but its metadata could not be persisted.`,
    );
  sessionStore.linkSpawned(senderSessionId, sessionId);
  if (worktree) broadcastWorktreeEdgeChange();
  // The attachments this returns are rebuilt from these same links when peer
  // delivery reaches the session, so they are not carried through the envelope
  // — and `pinProject` is what keeps that rebuild honest across the gap.
  await applySessionContext(
    context,
    {
      harness,
      agentType: item.agentType,
      sessionId,
    },
    { pinProject: true },
  );

  await deps.deliver({
    senderSessionId,
    targetSessionId: sessionId,
    prompt: item.prompt,
    responseRequested: item.responseRequested,
    ...(item.taskId ? { taskId: item.taskId } : {}),
  });
}

/**
 * A re-read of the runtime a row must run on, taken immediately before it is
 * created. Approval cards do not use it — the user settled those values in
 * `prepare` and approved them — but a path whose runtime comes from live
 * settings does.
 */
interface SpawnOneOptions {
  currentRuntime?: () => Promise<{
    provider: string;
    modelId: string;
    modelName?: string;
    credentialProfileId: string;
    accountName?: string;
    thinkingLevel: ThinkingLevel;
  }>;
}

/** Register the executor once at module load, like every other approval family. */
registerApprovalExecutor("sessionSpawn", {
  prepare: prepareSpawnApproval,
  async execute(card) {
    if (card.body.kind !== "sessionSpawn")
      throw new Error("Not a session-spawn approval.");
    const items = card.body.items;
    for (const item of items) {
      if (item.skipped) continue;
      delete item.error;
      try {
        await spawnOne(card.sessionId, item);
      } catch (err) {
        // One row's failure is not the batch's: the others are still worth
        // creating, and the card names which one broke. `spawnOne` may have
        // recorded a session id before failing, and that row keeps BOTH.
        item.error = errorText(err);
      }
    }
    deps.broadcastSessions();
    const created = items.filter((item) => item.resultSessionId);
    const skipped = items.filter((item) => item.skipped).length;
    const stillborn = items.filter(
      (item) => !item.skipped && item.error && !item.resultSessionId,
    ).length;
    if (created.length === 0)
      throw new Error(
        stillborn > 0
          ? `No session could be created: ${items.find((item) => item.error)?.error ?? "unknown error"}`
          : "Every row was skipped, so nothing was created.",
      );
    // The agent reads its new session ids out of this line, so they belong in
    // the summary rather than only in the card's rows — including a session
    // that exists but never received its prompt, which is precisely the one it
    // must be told about.
    const named = created
      .map(
        (item) =>
          `"${item.title}" (${item.resultSessionId})${
            item.error ? " — created, but its opening prompt failed" : ""
          }`,
      )
      .join(", ");
    const tail = [
      skipped > 0 ? `${skipped} skipped` : "",
      stillborn > 0 ? `${stillborn} not created` : "",
    ]
      .filter(Boolean)
      .join(", ");
    return {
      resultSummary: `Started ${created.length} session${created.length === 1 ? "" : "s"}: ${named}${tail ? `. ${tail}.` : "."}`,
    };
  },
});

/* ---------------------------- direct spawn -------------------------------- */

/**
 * One row of a DIRECT batch ([Task-595](pa://task/595)): the same structural
 * fields as a proposal row, plus the approved runtime it must run on. There is
 * deliberately no provider/model/thinking/account field — the human's roster is
 * the only place those are chosen on this path.
 */
export interface DirectSpawnRequestRow {
  title: string;
  agentType: SpawnAgentType;
  prompt: string;
  profileId: string;
  responseRequested?: boolean;
  worktreeId?: string;
  projectId?: string;
  taskId?: string;
}

/** What one direct row did, whether or not it worked. */
export interface DirectSpawnRowResult {
  title: string;
  profileId: string;
  /** The runtime it actually ran on; absent when the runtime was refused. */
  runtime?: {
    name: string;
    provider: string;
    modelId: string;
    thinkingLevel: ThinkingLevel;
    accountName?: string;
    family: string;
    relativeCost: string;
  };
  sessionId?: string;
  error?: string;
}

/**
 * Create a batch of ordinary peer sessions on pre-approved runtimes, now.
 *
 * The structural half is validated for EVERY row first: a title, persona,
 * worktree, Project or Task the agent stated wrongly is its own mistake and
 * costs a tool error with nothing created. From there the rows are isolated —
 * each one resolves its approved runtime immediately before it is used, so a
 * roster edit between rows is honoured rather than assumed away, and a runtime,
 * creation or delivery failure is reported on that row while the others
 * continue.
 */
export async function spawnApprovedPeers(input: {
  senderSessionId: string;
  rows: DirectSpawnRequestRow[];
}): Promise<DirectSpawnRowResult[]> {
  assertBatchSize(input.rows);
  const structurals: StructuralRow[] = [];
  for (const row of input.rows) {
    if (!row.profileId?.trim())
      throw new SpawnProposalError(
        `"${row.title?.trim() || "(untitled)"}" has no profileId. A direct spawn runs only on an approved runtime — call operation "profiles" first.`,
      );
    structurals.push(await validateStructure(row));
  }
  // The fixed concurrency policy is a batch gate, not a per-row one: half a
  // batch admitted would leave the coordinator reasoning about a limit it
  // cannot see. The claim is held for the whole batch and released in the
  // `finally`, so an overlapping call cannot be told the same slots are free
  // while these sessions are still being created.
  const claim = await admitDirectPeerTurns(
    input.senderSessionId,
    input.rows.length,
  );
  const results: DirectSpawnRowResult[] = [];
  try {
    for (const [index, row] of input.rows.entries()) {
      const structural = structurals[index]!;
      const result: DirectSpawnRowResult = {
        title: structural.title,
        profileId: row.profileId.trim(),
      };
      results.push(result);
      // An early resolution so a roster mistake costs no worktree lookups —
      // but it is NOT what the session runs on. `spawnOne` re-resolves through
      // `currentRuntime` immediately before creating anything, because the
      // awaits in between are exactly where a Settings edit lands.
      let runtime: ApprovedPeerRuntime;
      try {
        runtime = await resolveApprovedPeerRuntime(row.profileId);
      } catch (err) {
        result.error = errorText(err);
        continue;
      }
      const item: SessionSpawnApprovalItem = {
        ...approvalItemOf(structural),
        // The child is told who to answer by the SERVER, so a coordinator that
        // forgot to say it in its own prompt still gets a result.
        prompt: withReportingRoute(structural.prompt, input.senderSessionId),
        // Direct orchestration means the coordinator owns closure, so the default
        // is that it is waiting; only an explicit false says otherwise.
        responseRequested: row.responseRequested !== false,
        provider: runtime.provider,
        modelId: runtime.modelId,
        ...(runtime.modelName ? { modelName: runtime.modelName } : {}),
        credentialProfileId: runtime.credentialProfileId,
        ...(runtime.accountName ? { accountName: runtime.accountName } : {}),
        thinkingLevel: runtime.thinkingLevel,
      };
      let finalRuntime: ApprovedPeerRuntime | undefined;
      try {
        await spawnOne(input.senderSessionId, item, {
          currentRuntime: async () => {
            // Throws if the row was disabled, deleted or made unrunnable while
            // this row was being prepared; a row edited to another runtime runs
            // on the CURRENT approval, which is the only one that exists.
            const current = await resolveApprovedPeerRuntime(row.profileId);
            finalRuntime = current;
            return current;
          },
        });
      } catch (err) {
        result.error = errorText(err);
      }
      // Report only the late resolution used for creation. If late resolution
      // refused the row, repeating the earlier runtime here would imply that a
      // stale or fallback runtime had been attempted when nothing was created.
      if (finalRuntime)
        result.runtime = {
          name: finalRuntime.name,
          provider: finalRuntime.provider,
          modelId: finalRuntime.modelId,
          thinkingLevel: finalRuntime.thinkingLevel,
          ...(finalRuntime.accountName
            ? { accountName: finalRuntime.accountName }
            : {}),
          family: finalRuntime.family,
          relativeCost: finalRuntime.relativeCost,
        };
      if (item.resultSessionId) {
        result.sessionId = item.resultSessionId;
        recordDirectPeerChild(input.senderSessionId, item.resultSessionId);
      }
    }
  } finally {
    claim.release();
  }
  deps.broadcastSessions();
  return results;
}
