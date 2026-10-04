import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  THINKING_LEVELS,
  isCodingAgentType,
  pendingSessionOutcome,
  type AgentType,
  type Harness,
  type SessionAttentionKind,
  type SessionForkOrigin,
  type SessionListItem,
  type SessionTaskProgress,
} from "@assistant/shared";
import { DATA_DIR } from "./config.ts";
import {
  claudeSdkModelOption,
  knownClaudeSdkModelAlias,
} from "./claudeSdk/modelSettings.ts";
import { getPendingAgentQuestion } from "./tools/core/questionTool.ts";
import { pendingApprovalSessionIds } from "./pendingApprovals.ts";
import {
  choosingTaskSessionIds,
  pullRequestSummariesBySession,
} from "./pullRequestCards.ts";
import { taskIndexVersion } from "./tasks.ts";
import { projectStore } from "./db/projectStore.ts";
import { taskStore } from "./db/taskStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { subagentStore } from "./db/subagentStore.ts";
import { backgroundWorkStore } from "./db/backgroundWorkStore.ts";
import { agentHandoffStore } from "./db/agentHandoffStore.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { sessionRunStartedAt } from "./sessionActivity.ts";
import { worktreeIdBySession } from "./db/worktreeStore.ts";
import { worktreeMissingProbe } from "./worktrees/sessionCwd.ts";
import { objectRefsBySession } from "./db/sessionObjectStore.ts";
import { canonicalPiSessionPath } from "./sessionStorage.ts";

export const SESSION_TITLE_MAX_CHARS = 80;

export function deriveTitle(
  name: string | undefined,
  firstMessage: string,
): string {
  const raw = (name ?? firstMessage ?? "").trim();
  if (!raw) return "New chat";
  const firstLine = raw.split("\n")[0] ?? raw;
  return firstLine.length > SESSION_TITLE_MAX_CHARS
    ? `${firstLine.slice(0, SESSION_TITLE_MAX_CHARS - 1)}…`
    : firstLine;
}

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

interface NativePiSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nativeTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type?: unknown; text: string } =>
        Boolean(part) &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function summarizeNativePiSession(
  id: string,
  file: string,
): NativePiSummary | undefined {
  let createdAt = statSync(file).birthtimeMs;
  let updatedAt = statSync(file).mtimeMs;
  let messageCount = 0;
  let firstUserText = "";
  let title: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let thinkingLevel: string | undefined;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = timestampMs(entry.timestamp);
    if (ts !== undefined) {
      createdAt = Math.min(createdAt, ts);
      updatedAt = Math.max(updatedAt, ts);
    }
    if (entry.type === "session_info") {
      const name = typeof entry.name === "string" ? entry.name : undefined;
      if (name?.trim()) title = name;
      continue;
    }
    if (entry.type === "model_change") {
      provider = typeof entry.provider === "string" ? entry.provider : provider;
      model = typeof entry.modelId === "string" ? entry.modelId : model;
      continue;
    }
    if (entry.type === "thinking_level_change") {
      thinkingLevel =
        typeof entry.thinkingLevel === "string"
          ? entry.thinkingLevel
          : thinkingLevel;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    const role = message?.role;
    if (role === "user" || role === "assistant") messageCount += 1;
    if (role === "user" && !firstUserText)
      firstUserText = nativeTextContent(message?.content).trim();
  }

  if (messageCount === 0) return undefined;
  return {
    id,
    title: deriveTitle(title, firstUserText),
    createdAt,
    updatedAt,
    messageCount,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  };
}

/**
 * Heal pi sessions whose native/log files exist but whose metadata row was never
 * written. This covers developer sessions created while the SQLite CHECK
 * constraint still rejected the `developer` persona: their transcripts are safe
 * on disk, but id-only routing and the session list need this metadata row.
 */
export function reconcileMissingPiSessionMetadata(): number {
  const sessionsDir = join(DATA_DIR, "sessions");
  if (!existsSync(sessionsDir)) return 0;
  // Every scope, because this is about session IDS, not about what is shown:
  // healing a row for an id another scope already owns would be a duplicate.
  const known = new Set(
    sessionStore
      .list({ scopes: "all", includeDeleted: true })
      .map((session) => session.id),
  );
  let recovered = 0;
  for (const id of readdirSync(sessionsDir)) {
    if (!SAFE_SESSION_ID_RE.test(id) || known.has(id)) continue;
    const nativePath = canonicalPiSessionPath(id);
    if (!existsSync(nativePath)) continue;
    const summary = summarizeNativePiSession(id, nativePath);
    if (!summary) continue;
    const stored = sessionStore.upsert({
      id,
      harness: "pi",
      // The missing-row class was caused by the old schema rejecting the new
      // production-capable coding persona. Preserve those sessions as developer
      // sessions so they can run in production after restart.
      agentType: "developer",
      title: summary.title,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      messageCount: summary.messageCount,
      ...(summary.provider !== undefined ? { provider: summary.provider } : {}),
      providerSessionId: id,
      ...(summary.model !== undefined ? { model: summary.model } : {}),
      ...(summary.thinkingLevel !== undefined
        ? { thinkingLevel: summary.thinkingLevel }
        : {}),
    });
    if (!stored || !sessionStore.get(id)) continue;
    known.add(id);
    recovered += 1;
  }
  return recovered;
}

/** A live session's contribution to the list, supplied by the hub. */
export interface LiveListInfo {
  kind: AgentType;
  /** Which engine runs this session (pi / claude-sdk). */
  harness?: Harness;
  /** Which persona/toolset this session emulates, independent of harness. */
  agentType?: AgentType;
  sessionId: string;
  file: string | undefined;
  /** Live title, including the stable unlabeled placeholder before naming settles. */
  title: string | undefined;
  /** True while the dedicated naming agent is generating the title. */
  titleGenerationPending?: boolean;
  /** Native message-entry count; zero means no prompt content exists. */
  messageCount: number;
  isStreaming: boolean;
  /** True when paused on a pending question awaiting the user. */
  awaitingInput: boolean;
  /** Newest in-memory activity, so a not-yet-persisted session can still sort. */
  updatedAt: number;
  /** Creation time for live-only rows; falls back to `updatedAt` when unknown. */
  createdAt?: number;
  /** Runtime model for live-only rows before metadata persistence catches up. */
  model?: SessionListItem["model"];
  /** Thinking/reasoning level for live-only rows before metadata persistence catches up. */
  thinkingLevel?: SessionListItem["thinkingLevel"];
  forkOrigin?: SessionForkOrigin;
  forkAutoRenamePending?: boolean;
}

/**
 * List the web sessions across every available agent store, newest first.
 *
 * Merges the on-disk sessions with the hub's live sessions so that:
 *   - a chat appears the instant its first prompt is sent (live, not yet on disk),
 *   - the running indicator (`isStreaming`) reflects the in-memory run, and
 *   - `unread` is computed against the persisted per-session read timestamp.
 */
export interface SessionListOptions {
  /** Include archived rows in the returned list. Defaults to false for initial/sidebar payloads. */
  includeArchived?: boolean;
  /**
   * Project only these sessions. For a server-side question about a few known
   * rows (may this session settle?): the per-row work — a Claude session's
   * transcript snapshot above all — is then paid for those rows alone.
   */
  onlyIds?: ReadonlySet<string>;
}

/** Server-internal session list row. The provider-native file is intentionally not part of the websocket payload. */
export interface InternalSessionListItem extends SessionListItem {
  /** Provider-native handle used only by server-side resume/fork/relay paths. */
  file: string;
}

function normalizeThinkingLevel(
  level: string | undefined,
): SessionListItem["thinkingLevel"] | undefined {
  return THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number])
    ? (level as SessionListItem["thinkingLevel"])
    : undefined;
}

/**
 * A stored row's model as the picker names it. A Claude SDK row's `provider`
 * is the credential kind (`claude`), so its model resolves by alias instead;
 * an id no alias covers is passed through as stored rather than guessed.
 */
function sessionModel(
  harness: string,
  provider: string | undefined,
  modelId: string | undefined,
): SessionListItem["model"] | undefined {
  if (!modelId) return undefined;
  if (harness === "claude-sdk") {
    const alias = knownClaudeSdkModelAlias(modelId);
    if (alias) {
      const option = claudeSdkModelOption(alias);
      return { provider: option.provider, id: option.id, name: option.name };
    }
  }
  if (!provider) return undefined;
  return { provider, id: modelId };
}

/**
 * The run's start time, so the sidebar can label "Working · 4m" honestly
 * instead of guessing from `updatedAt`. Only meaningful while running.
 */
function runStatusFields(
  sessionId: string,
  isStreaming: boolean,
): Pick<SessionListItem, "runStartedAt"> {
  if (!isStreaming) return {};
  const startedAt = sessionRunStartedAt(sessionId);
  return startedAt === undefined ? {} : { runStartedAt: startedAt };
}

/**
 * `awaitingInput` says the session needs a human; `attention` says which
 * decision it is waiting for, so the inbox can word the card and its blocked
 * Settle action precisely. `approvals` and `taskChoices` are resolved once per
 * list build (see `pendingApprovalSessionIds` / `choosingTaskSessionIds`),
 * never per row — one query each rather than one per row, and this list is
 * rebuilt up to ~4 times a second while agents stream.
 */
function attentionFields(
  sessionId: string,
  liveAwaitingInput: boolean | undefined,
  approvals: Set<string>,
  taskChoices: Set<string>,
): Pick<SessionListItem, "awaitingInput" | "attention"> {
  const attention: SessionAttentionKind | undefined = getPendingAgentQuestion(
    sessionId,
  )
    ? "question"
    : approvals.has(sessionId)
      ? "approval"
      : taskChoices.has(sessionId)
        ? "task-choice"
        : undefined;
  const awaitingInput = liveAwaitingInput ?? Boolean(attention);
  return { awaitingInput, ...(attention ? { attention } : {}) };
}

/**
 * Sessions with work queued behind their next turn (two queries): peer prompts,
 * and the card outcomes a mid-turn session could not be told about yet
 * (`agentHandoffs.ts`). Both are the same fact to a reader — something is
 * waiting for this session to finish — so they share the row's one flag.
 */
function queuedWorkRecipients(): Set<string> {
  const queued = new Set<string>();
  try {
    for (const id of peerPromptStore.queuedRecipientIds()) queued.add(id);
  } catch (err) {
    console.warn("Failed to read queued peer prompts for session list:", err);
  }
  try {
    for (const id of agentHandoffStore.queuedSessionIds()) queued.add(id);
  } catch (err) {
    console.warn("Failed to read queued agent handoffs for session list:", err);
  }
  return queued;
}

export async function listSessions(
  allLive: LiveListInfo[],
  readAt: (key: string) => number,
  opts: SessionListOptions = {},
): Promise<InternalSessionListItem[]> {
  let live = allLive;
  const liveByKey = new Map(live.map((l) => [l.sessionId, l]));
  const seen = new Set<string>();
  const taskSessionIndex = getTaskSessionIndex();
  // Every relation below is one indexed scan or one store read, never a
  // per-row SQLite/file round trip: this list is rebuilt up to ~4 times a
  // second while agents stream, on the same thread that serves every other
  // connection. A new per-row lookup belongs in this batched prologue. The
  // maps derived from session edges are memoized on those edges
  // (`memoizedOnLinks`), so between edge writes they cost nothing.
  const projectBySession = projectStore.sessionProjectIndex();
  const worktreeBySession = worktreeIdBySession();
  // Memoized per DISTINCT worktree id, and only for the ids rows actually
  // carry: one read of the active worktrees, then one existsSync per id.
  const worktreeGone = worktreeMissingProbe();
  const worktreeAckBySession = sessionStore.worktreeMissingAckBySession();
  const objectRefsBySessionId = objectRefsBySession();
  const queuedRecipients = queuedWorkRecipients();
  const delegationBySession = subagentStore.delegationSummaries();
  // A separate component from `isStreaming`/`runStartedAt`: background work is
  // the session's, not its provider turn's, so an idle session can own active
  // work and a working session can own none.
  const backgroundBySession = backgroundWorkStore.activityByOwner();
  const approvalSessions = pendingApprovalSessionIds();
  // One card per session, already chosen and narrowed to what a row states
  // (`pullRequestSummariesBySession`), memoized: a rebuild re-reads only the
  // sessions whose cards changed since the last one. `choosingTaskSessionIds`
  // is one query over the `choosing-task` rows.
  const pullRequestBySession = pullRequestSummariesBySession();
  const taskChoiceSessions = choosingTaskSessionIds();
  // The default list asks SQLite for the unarchived rows: the archive grows
  // without bound behind the active list (settled sessions are archived
  // automatically, `sessionRetention.ts`), and this rebuild has to scale with
  // what is shown, not with what was ever finished. `includeArchived` is the
  // on-demand archive view's explicit path.
  // `onlyIds` bounds the read itself, not just its result: a one-row refresh
  // must not pay for the archive it filters out.
  const onlyIds = opts.onlyIds;
  const storedRows = sessionStore.list({
    ...(opts.includeArchived ? {} : { excludeArchived: true }),
    ...(onlyIds ? { ids: [...onlyIds] } : {}),
  });
  if (onlyIds) live = live.filter((l) => onlyIds.has(l.sessionId));
  const spawnedParentByChild = sessionStore.spawnedParentsByChildIds(
    storedRows.map((row) => row.id),
  );

  // Rows outside the default scope never reach the list — not from the store
  // (which reads `user` only) and not from the live rows below, which know
  // nothing about scope and are gated on the persisted one. The same gate
  // holds back a live runtime whose row is archived, which the store query
  // above no longer returns and `seen` therefore cannot cover. Bounded by the
  // live ids, so it costs a handful of primary-key lookups per rebuild.
  const liveAllowed = sessionStore.liveDefaultScopeGate(
    live.map((l) => l.sessionId),
    { includeArchived: Boolean(opts.includeArchived) },
  );

  const sessions: InternalSessionListItem[] = [];
  for (const row of storedRows) {
    const key = row.id;
    const archived = row.archivedAt !== undefined;
    seen.add(key);
    const l = liveByKey.get(key);
    const nativeMessageCount = Math.max(row.messageCount, l?.messageCount ?? 0);
    // A metadata claim happens at runtime creation, before the first prompt. It
    // is a locator/security record, not evidence that a conversation exists.
    // Hiding zero-message rows also retires historical replacement bootstraps
    // that archive/delete used to mint and strand in the list. Draft creation
    // is the explicit exception: it must remain reachable before its prompt is
    // sent, and keeps the old bootstrap count of one so routing does not mistake
    // it for the generic client-staged `/sessions/create` surface.
    const messageCount =
      nativeMessageCount === 0 && row.purpose === "draft"
        ? 1
        : nativeMessageCount;
    if (messageCount === 0) continue;
    const updatedAt = Math.max(row.updatedAt, l?.updatedAt ?? 0);
    const objectRefs = objectRefsBySessionId.get(key) ?? [];
    const isStreaming = l?.isStreaming ?? false;
    const worktreeId = worktreeBySession.get(key);
    const pullRequest = pullRequestBySession.get(key);
    const taskProgressValue = taskSessionIndex.progress.get(key);
    const modelValue =
      l?.model ?? sessionModel(row.harness, row.provider, row.model);
    const thinkingLevelValue =
      l?.thinkingLevel ?? normalizeThinkingLevel(row.thinkingLevel);
    const projectIdValue = projectBySession.get(key);
    const settledAt = pendingSessionOutcome(row.outcomeAttention)
      ? undefined
      : row.settledAt;
    sessions.push({
      id: row.id,
      scope: row.scope,
      file: row.harness === "pi" ? canonicalPiSessionPath(row.id) : row.id,
      harness: row.harness,
      agentType: row.agentType,
      title: l?.title ?? row.title,
      ...(l?.titleGenerationPending ? { titleGenerationPending: true } : {}),
      createdAt: row.createdAt,
      updatedAt,
      messageCount,
      ...(taskProgressValue !== undefined
        ? { taskProgress: taskProgressValue }
        : {}),
      ...(projectIdValue !== undefined ? { projectId: projectIdValue } : {}),
      ...(worktreeId !== undefined ? { worktreeId } : {}),
      ...(isCodingAgentType(row.agentType) &&
      worktreeId &&
      worktreeGone(worktreeId) &&
      worktreeAckBySession.get(key) !== worktreeId
        ? { worktreeMissing: true }
        : {}),
      ...(objectRefs.length ? { objectRefs: [...objectRefs] } : {}),
      ...(pullRequest ? { pullRequest } : {}),
      ...(modelValue !== undefined ? { model: modelValue } : {}),
      ...(thinkingLevelValue !== undefined
        ? { thinkingLevel: thinkingLevelValue }
        : {}),
      ...(row.credentialProfileId
        ? { credentialProfileId: row.credentialProfileId }
        : {}),
      ...(spawnedParentByChild.has(key)
        ? {
            spawnedBySessionId: spawnedParentByChild.get(key)!.parentSessionId,
            spawnOwnership: spawnedParentByChild.get(key)!.ownership,
          }
        : {}),
      ...(l?.forkOrigin
        ? { forkOrigin: l.forkOrigin }
        : row.forkOrigin
          ? { forkOrigin: row.forkOrigin }
          : {}),
      forkAutoRenamePending:
        l?.forkAutoRenamePending ?? row.forkAutoRenamePending,
      isStreaming,
      ...runStatusFields(row.id, isStreaming),
      ...(delegationBySession.has(row.id)
        ? { delegation: delegationBySession.get(row.id)! }
        : {}),
      ...(backgroundBySession.has(row.id)
        ? { backgroundActivity: backgroundBySession.get(row.id)! }
        : {}),
      ...attentionFields(
        row.id,
        l?.awaitingInput,
        approvalSessions,
        taskChoiceSessions,
      ),
      ...(row.lastError ? { lastError: row.lastError } : {}),
      // Suppressed while the session streams: a run started before the stored
      // mark was cleared would otherwise report a session as BOTH interrupted
      // and running, and the badge is about work that is waiting, not moving.
      ...(row.interruptedRunAt !== undefined && !isStreaming
        ? { interruptedRun: { at: row.interruptedRunAt } }
        : {}),
      ...(queuedRecipients.has(row.id) ? { queuedWork: true } : {}),
      // Settlement HOLDS only while the user has acknowledged the session's
      // latest outcome: an unacknowledged completion or failure is what takes a
      // shelved row back into the working set (Task-674). This is the ONE place
      // the two durable halves are combined, so no consumer sees a `settledAt`
      // that a newer event has already superseded.
      ...(settledAt !== undefined ? { settledAt } : {}),
      ...(row.outcomeAttention
        ? { outcomeAttention: row.outcomeAttention }
        : {}),
      // A shelved session is read BY DEFINITION: archiving or settling marks it
      // read, and this guard keeps rows shelved before that rule existed from
      // showing an unread marker nothing on those surfaces can clear.
      unread: updatedAt > row.readAt && !archived && settledAt === undefined,
      ...(archived ? { archived: true } : {}),
    });
  }

  // Live sessions with no persisted messages yet (first prompt in flight) won't
  // be on disk — surface them so the chat shows up immediately. A row with no
  // stored scope may be assumed to be the user's only because
  // `sessionStore.claimScope` persists any other scope BEFORE the session can
  // enter a live registry (`piStore.track`, `claudeSdkStore.acquire`).
  for (const l of live) {
    const key = l.sessionId;
    if (
      seen.has(key) ||
      !liveAllowed(key) ||
      !l.file ||
      !l.title ||
      l.messageCount === 0
    )
      continue;
    const objectRefs = objectRefsBySessionId.get(key) ?? [];
    const pullRequest = pullRequestBySession.get(key);
    const taskProgressValue = taskSessionIndex.progress.get(key);
    const projectIdOpt = projectBySession.get(key);
    const worktreeIdValue = worktreeBySession.get(key);
    sessions.push({
      id: l.sessionId,
      file: l.file,
      harness: "pi",
      agentType: l.kind,
      title: l.title,
      ...(l.titleGenerationPending ? { titleGenerationPending: true } : {}),
      createdAt: l.createdAt ?? l.updatedAt,
      updatedAt: l.updatedAt,
      messageCount: l.messageCount,
      ...(taskProgressValue !== undefined
        ? { taskProgress: taskProgressValue }
        : {}),
      ...(projectIdOpt !== undefined ? { projectId: projectIdOpt } : {}),
      ...(worktreeIdValue !== undefined ? { worktreeId: worktreeIdValue } : {}),
      ...(worktreeBySession.get(key) &&
      worktreeGone(worktreeBySession.get(key)) &&
      worktreeAckBySession.get(key) !== worktreeBySession.get(key)
        ? { worktreeMissing: true }
        : {}),
      ...(objectRefs.length ? { objectRefs: [...objectRefs] } : {}),
      ...(pullRequest ? { pullRequest } : {}),
      ...(l.model !== undefined ? { model: l.model } : {}),
      ...(l.thinkingLevel !== undefined
        ? { thinkingLevel: l.thinkingLevel }
        : {}),
      ...(l.forkOrigin !== undefined ? { forkOrigin: l.forkOrigin } : {}),
      ...(l.forkAutoRenamePending !== undefined
        ? { forkAutoRenamePending: l.forkAutoRenamePending }
        : {}),
      ...(delegationBySession.has(l.sessionId)
        ? { delegation: delegationBySession.get(l.sessionId)! }
        : {}),
      ...(backgroundBySession.has(l.sessionId)
        ? { backgroundActivity: backgroundBySession.get(l.sessionId)! }
        : {}),
      isStreaming: l.isStreaming,
      ...runStatusFields(key, l.isStreaming),
      ...attentionFields(
        key,
        l.awaitingInput,
        approvalSessions,
        taskChoiceSessions,
      ),
      ...(queuedRecipients.has(key) ? { queuedWork: true } : {}),
      unread: l.updatedAt > readAt(key),
    });
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function archivedSessionCount(): Promise<number> {
  // A COUNT, not a full row scan mapped through the store's projection: this is
  // asked on every connect and on every archived-list refresh.
  return sessionStore.countArchived();
}

interface TaskSessionIndex {
  version: number;
  progress: Map<string, SessionTaskProgress>;
}

let taskSessionIndexCache: TaskSessionIndex | undefined;

function getTaskSessionIndex(): TaskSessionIndex {
  try {
    const version = taskIndexVersion();
    if (taskSessionIndexCache?.version === version)
      return taskSessionIndexCache;

    // The same Tasks `listTasks()` lists, on the same `context` edges, but only
    // the two columns a count needs: this runs after every Task write.
    const progress = new Map<string, SessionTaskProgress>();
    for (const { sessionId, status } of taskStore.sessionTaskStatuses()) {
      let counts = progress.get(sessionId);
      if (!counts) {
        counts = { todo: 0, doing: 0, done: 0 };
        progress.set(sessionId, counts);
      }
      counts[status] += 1;
    }
    taskSessionIndexCache = { version, progress };
    return taskSessionIndexCache;
  } catch (err) {
    console.warn("Failed to read task progress for session list:", err);
    return { version: 0, progress: new Map() };
  }
}
