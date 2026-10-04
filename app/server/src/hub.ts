import type {
  AgentType,
  BackgroundWorkItemSummary,
  BroadcastTopic,
  DisplayMessage,
  ServerMessage,
  StateEvent,
  ProjectSummary,
  TaskSummary,
  SubagentThreadSummary,
} from "@assistant/shared";
import { isCodingAgentType } from "@assistant/shared";
import {
  archivedSessionCount,
  listSessions,
  type SessionListOptions,
} from "./sessions.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { pendingApprovalSessionIds } from "./pendingApprovals.ts";
import { choosingTaskSessionIds } from "./pullRequestCards.ts";
import { claudeSdkStore } from "./claudeSdk/claudeSdkStore.ts";
import type { HarnessDriver, Viewer } from "./harness.ts";
import { sessionRuntime } from "./session/runtimeInstance.ts";
import { subscribeHarnessOpened } from "./session/runtimePrompt.ts";
import { viewSessionById } from "./viewSession.ts";
import {
  subscribeTaskChanges,
  taskLinkedSessionIds,
  taskRevisionIndex,
  taskSummaryFor,
} from "./tasks.ts";
import {
  consumePostReloadContinuation,
  listBrowserRuntimes,
  subscribeBrowserRuntimeChanges,
  type PostReloadContinuation,
} from "./mcp/toolGroups/registry.ts";
import type { PiLiveSession } from "./piSdk/PiLiveSession.ts";
import { piStore } from "./piSdk/piStore.ts";
import { harnessRegistry } from "./harnesses/registry.ts";
import { setWorktreeBroadcaster } from "./worktrees/worktreeEvents.ts";
import { setKnowledgeBaseBroadcaster } from "./knowledgeBaseEvents.ts";
import { setSkillLibraryBroadcaster } from "./skills/skillLibraryEvents.ts";
import { setMemoryBroadcaster } from "./memoryEvents.ts";
import { setAppNotificationBroadcaster } from "./webPush.ts";
import { setCalendarScanBroadcaster } from "./dayScan/scanProgress.ts";
import { setUsageBroadcaster } from "./usageCache.ts";
import { onSettingsChanged } from "./settingsService.ts";
import {
  projectRevisionIndex,
  projectSummaryFor,
  subscribeProjectChanges,
} from "./projectRegistry.ts";
import { setWorkflowBroadcaster } from "./workflowRuns.ts";
import {
  notifyCommentChanges,
  notifyCommentMetadataChanges,
  setCommentBroadcaster,
} from "./comments/commentEvents.ts";
import {
  setCommentChangeNotifier,
  setCommentMetadataChangeNotifier,
} from "./comments/commentChanges.ts";
import { errorText } from "./errors.ts";
import { setSubagentStateChangeNotifier } from "./db/subagentStore.ts";
import { setBackgroundWorkStateChangeNotifier } from "./db/backgroundWorkStore.ts";
import {
  backgroundWorkRevisionIndex,
  backgroundWorkStateItems,
  BACKGROUND_WORK_SNAPSHOT_MAX,
} from "./backgroundWorkRegistry.ts";
import {
  subagentRunStateItems,
  subagentRunThreadId,
  subagentThreadRevisionIndex,
  subagentThreadStateItems,
} from "./subagentRegistry.ts";

/**
 * Grace period between announcing a dev reload and exiting. The run has already
 * finished (we defer until idle), so this just gives the client a beat to render
 * the completed response and show the "restarting" banner before the socket drops.
 */
const RELOAD_GRACE_MS = 1500;
/**
 * Once all runs are idle, wait one extra beat before exiting so SDK/session
 * persistence and any asynchronous cleanup kicked off by agent_end can settle.
 */
const RELOAD_IDLE_SETTLE_MS = 1200;

const SESSION_BROADCAST_DEBOUNCE_MS = 25;
/** Same shape as the session-list debounce; a burst of Task writes is one broadcast. */
const TASK_BROADCAST_DEBOUNCE_MS = 25;
const PROJECT_BROADCAST_DEBOUNCE_MS = 25;
const SUBAGENT_BROADCAST_DEBOUNCE_MS = 25;
const BACKGROUND_WORK_BROADCAST_DEBOUNCE_MS = 25;
/**
 * Minimum gap between consecutive list rebuilds while invalidations keep
 * arriving (e.g. a streaming run). The first broadcast is fast (25ms debounce);
 * sustained churn coalesces to at most ~4 rebuilds/second.
 */
const SESSION_BROADCAST_SUSTAINED_MS = 250;
const SESSION_LIST_SLOW_MS = 50;
/**
 * Above this many changed rows, resend the whole list instead of row updates:
 * the delta stops saving anything, and the full list is the shape that also
 * carries the archived count.
 */
const SESSION_DELTA_MAX_ROWS = 5;

export interface LifecycleDrainParticipant {
  /** Synchronous gate, called as soon as reload or shutdown starts. */
  closeAdmissions(): void;
  /** Called once after prompted turns finish and before the clean-exit marker. */
  drain(): Promise<void>;
}

/**
 * The rows to send as `sessionUpdated`s, or `null` when the whole list must go.
 *
 * A delta is only valid while the SET of rows is unchanged — an added, removed
 * or archived session changes what the sidebar must stop showing, which a
 * single-row upsert cannot express. Within that, comparing the serialized rows
 * is exact and cheap next to building the list in the first place.
 */
function sessionListDelta<T extends { id: string }>(
  previous: T[] | undefined,
  next: T[],
): T[] | null {
  if (!previous || previous.length !== next.length) return null;
  const before = new Map(
    previous.map((session) => [session.id, JSON.stringify(session)]),
  );
  const changed: T[] = [];
  for (const session of next) {
    const serialized = before.get(session.id);
    if (serialized === undefined) return null;
    if (serialized !== JSON.stringify(session)) changed.push(session);
    if (changed.length > SESSION_DELTA_MAX_ROWS) return null;
  }
  return changed;
}

/**
 * The `{id → revision}` baseline for the FIRST Task flush of the process.
 *
 * Every subscriber's snapshot was read from this same database, so the state
 * they already hold is the current live projection — minus the rows the writes
 * that triggered this flush just touched, which are exactly what they still owe
 * an event. Starting from an empty map instead would make the first mutation
 * after a restart emit an upsert for every Task alive, which is the full-list
 * broadcast this model exists to remove.
 */
export function seedTaskBaseline(
  index: Map<string, { revision: number; live: boolean }>,
  pending: ReadonlySet<string>,
): Map<string, number> {
  const baseline = new Map<string, number>();
  for (const [id, entry] of index) {
    // A pending LIVE row is the change itself: leaving it out makes it an upsert.
    if (entry.live && pending.has(id)) continue;
    // A pending row that is no longer live left the projection in this same
    // burst, and a subscriber holding it needs the delete.
    if (entry.live || pending.has(id)) baseline.set(id, entry.revision);
  }
  return baseline;
}

const seedProjectBaseline = seedTaskBaseline;

/** Object-addressed comment delivery shared by the live hub and isolation tests. */
export function broadcastCommentEventToViewers(
  viewers: Iterable<Viewer>,
  target: import("@assistant/shared").CommentTarget,
  message: import("@assistant/shared").CommentEventsMessage,
): void {
  for (const viewer of viewers) {
    if (viewer.wantsComments?.(target)) viewer.send(message);
  }
}

/**
 * Process-global registry of open connections. Which engine holds a session is
 * the harness registry's to answer (`harnesses/registry.ts`); the remaining
 * lifecycle calls (fork, rename, removal, pi images) and the merged listing
 * still delegate to {@link piStore} and {@link claudeSdkStore} until they move
 * behind it; creation goes through `harnesses/create.ts`. Keeps every tab's
 * session list in sync.
 */
class SessionHub {
  private connections = new Set<Viewer>();
  /** A dev reload has been requested and is waiting for every active run to finish. */
  private reloadQueued = false;
  /** Guards against firing the exit timer more than once. */
  private reloadTriggered = false;
  private readonly lifecycleDrainParticipants =
    new Set<LifecycleDrainParticipant>();
  private lifecycleDrainPromise: Promise<void> | undefined;
  private lifecycleDrainFinished = false;
  /** Timer for the small idle-settle delay before the actual process exit. */
  private reloadSettleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Coalesces bursts of session-list invalidations into one filesystem scan + broadcast. */
  private sessionsBroadcastTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionsBroadcastPromise: Promise<void> | undefined;
  private resolveSessionsBroadcast: (() => void) | undefined;
  private sessionsBroadcastInFlight = false;
  private sessionsBroadcastRequestedDuringFlush = false;
  /** Last list sent, per variant, so a rebuild can be broadcast as row updates. */
  private lastBroadcastSessions:
    Awaited<ReturnType<typeof listSessions>> | undefined;
  private lastBroadcastArchivedSessions:
    Awaited<ReturnType<typeof listSessions>> | undefined;
  /** Archived count last sent; it only travels on a full list (see `flushSessionsBroadcast`). */
  private lastBroadcastArchivedCount: number | undefined;
  /** Coalesces a burst of Task mutations into one event batch + fan-out. */
  private tasksBroadcastTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * `{task id → revision}` as of the last flush; the next one diffs against it.
   * Undefined until the first flush of the process — see {@link seedTaskBaseline}.
   */
  private lastFlushedTaskRevisions: Map<string, number> | undefined;
  /** Ids reported by writes since the last flush (notify-with-ids). */
  private pendingTaskIds = new Set<string>();
  /** Gap tripwire for the `tasks` topic; see {@link taskEventSeq}. */
  private tasksEventSeq = 0;
  /** Sessions that were task-linked at the previous broadcast (see `flushTaskBroadcast`). */
  private taskLinkedSessions = new Set<string>();
  private projectsBroadcastTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlushedProjectRevisions: Map<string, number> | undefined;
  private pendingProjectIds = new Set<string>();
  private projectsEventSeq = 0;
  /** The canonical thread registry is event-only after subscribe/resync. */
  private subagentBroadcastTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlushedSubagentRevisions: Map<string, number> | undefined;
  private pendingSubagentIds = new Set<string>();
  private pendingSubagentRunIds = new Set<string>();
  private subagentRegistryEventSeq = 0;
  private subagentRunTopicSeq = new Map<string, number>();
  /** Background work is event-only after subscribe/resync, like the registry above. */
  private backgroundBroadcastTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingBackgroundIds = new Set<string>();
  private backgroundEventSequence = 0;

  constructor() {
    // The host object inverts the session→hub calls so no engine imports hub.ts.
    harnessRegistry.setHost({
      broadcastSessions: () => this.broadcastSessions(),
      noteRunStarted: () => this.noteRunStarted(),
      checkPendingReload: () => this.checkPendingReload(),
      isReloadQueued: () => this.isReloadQueued(),
      browserRuntimesFor: (sessionId) => this.browserRuntimesFor(sessionId),
    });
    subscribeBrowserRuntimeChanges(() => {
      for (const session of harnessRegistry.resident())
        if (isCodingAgentType(session.agentType)) session.broadcastState();
    });
    subscribeTaskChanges((ids) => {
      for (const id of ids) this.pendingTaskIds.add(id);
      this.broadcastTasks();
    });
    subscribeProjectChanges((ids) => {
      for (const id of ids) this.pendingProjectIds.add(id);
      this.broadcastProjects();
    });
    setSubagentStateChangeNotifier((change) => {
      for (const id of change.threadIds) this.pendingSubagentIds.add(id);
      for (const id of change.runIds) this.pendingSubagentRunIds.add(id);
      this.broadcastSubagents();
      // A thread/run transition changes the parent session's registry relation.
      if (change.parentSessionIds.length) void this.broadcastSessions();
    });
    setBackgroundWorkStateChangeNotifier((change) => {
      for (const id of change.itemIds) this.pendingBackgroundIds.add(id);
      this.broadcastBackgroundWork();
      // The owner's `backgroundActivity` moved. This is the ONLY session-list
      // effect background work has: run state and unread stay untouched.
      if (change.ownerSessionIds.length) void this.broadcastSessions();
    });
    sessionRuntime.subscribeEvents((_sessionId, event) => {
      if (event.type === "runStateChanged") void this.broadcastSessions();
    });
    // Same inversion for worktree domain modules: they push through this seam
    // instead of importing hub.ts.
    setWorktreeBroadcaster({
      broadcast: (msg) => this.broadcastTopic("worktrees", msg),
      broadcastWorktree: (worktreeId, msg) => {
        for (const c of this.connections) {
          if (c.wantsWorktree?.(worktreeId)) c.send(msg);
        }
      },
    });
    setKnowledgeBaseBroadcaster({
      broadcast: (msg) => this.broadcastTopic("knowledge", msg),
    });
    // The library's only path to browsers: one topic, one list shape.
    setSkillLibraryBroadcaster({
      broadcast: (msg) => this.broadcastTopic("skills", msg),
    });
    setCommentBroadcaster({
      broadcast: (target, msg) =>
        broadcastCommentEventToViewers(this.connections, target, msg),
    });
    setCommentChangeNotifier(notifyCommentChanges);
    setCommentMetadataChangeNotifier(notifyCommentMetadataChanges);
    setMemoryBroadcaster({ broadcastAll: (msg) => this.broadcastAll(msg) });
    setCalendarScanBroadcaster({
      broadcast: (msg) => this.broadcastTopic("calendar", msg),
    });
    setWorkflowBroadcaster({
      broadcast: (msg) => this.broadcastTopic("workflow", msg),
    });
    // Web Push cannot reach a client with no push service (the native shell),
    // so every alert also goes out live to whoever is connected; the client
    // decides whether it is the one that must raise it.
    setAppNotificationBroadcaster({
      broadcastAll: (notification) =>
        this.broadcastAll({ type: "appNotification", ...notification }),
    });
    // The usage cache never fetches headlessly, so it asks the hub whether any
    // browser is attached at all before doing background work.
    setUsageBroadcaster({
      broadcast: (msg) => this.broadcastTopic("usage", msg),
      hasClients: () => this.connections.size > 0,
    });
    // Settings carry per-connection URLs (OAuth redirect URIs), so each client
    // builds its own copy instead of receiving one shared message.
    onSettingsChanged((change) => {
      for (const viewer of this.connections) {
        try {
          viewer.settingsChanged?.(change);
        } catch (err) {
          console.warn("[settings] push to a client failed:", errorText(err));
        }
      }
    });
    subscribeHarnessOpened((sessionId) => this.sessionHarnessOpened(sessionId));
  }

  register(v: Viewer): void {
    this.connections.add(v);
  }

  unregister(v: Viewer): void {
    this.connections.delete(v);
  }

  /**
   * Deleting a session is a view transition for EVERY connection, not only the
   * one that asked: the driver and runtime about to be disposed are shared, so
   * a viewer left attached would keep routing commands into them and keep a
   * transcript nobody can reach. Each viewer detaches and tells its client,
   * synchronously, before the caller tombstones and evicts.
   */
  clearSessionViews(sessionId: string): void {
    for (const c of this.connections) c.sessionRemoved?.(sessionId);
  }

  /**
   * A session someone was only LOOKING at now has a harness behind it. Every
   * connection showing it through a {@link ViewSession} re-attaches to the real
   * driver, so live state (steering, model, run events) reaches readers who did
   * not open it themselves.
   */
  private sessionHarnessOpened(sessionId: string): void {
    const driver = this.getLiveById(sessionId);
    if (!driver) return;
    for (const c of this.connections) c.sessionHarnessOpened?.(driver);
  }

  /** The sessions some connected viewer is showing right now. */
  viewedSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const c of this.connections) {
      const id = c.viewingSessionId?.();
      if (id) ids.add(id);
    }
    return ids;
  }

  get(key: string): PiLiveSession | undefined {
    return piStore.get(key);
  }

  snapshotFor(sessionId: string): DisplayMessage[] | undefined {
    return piStore.get(sessionId)?.snapshot();
  }

  browserRuntimesFor(currentSessionId: string) {
    return listBrowserRuntimes(currentSessionId, (sessionId) =>
      harnessRegistry.browserRuntimeOwner(sessionId),
    );
  }

  consumePostReloadContinuation(): PostReloadContinuation | undefined {
    return consumePostReloadContinuation();
  }

  /**
   * The live session for `file`, reusing one already running if present. See
   * {@link piStore.acquireExisting} for the id-guard semantics.
   */
  async acquireExisting(
    kind: AgentType,
    file: string,
    expectedId?: string,
  ): Promise<PiLiveSession> {
    return piStore.acquireExisting(kind, file, expectedId);
  }

  async forkSession(
    kind: AgentType,
    file: string,
    nativeEntryId: string,
    position: "before" | "at",
    originEntryId: string,
  ): Promise<PiLiveSession> {
    return piStore.forkSession(
      kind,
      file,
      nativeEntryId,
      position,
      originEntryId,
    );
  }

  /** Remove and dispose a live pi session (e.g. on delete). */
  evict(key: string): void {
    piStore.evict(key);
  }

  /** The merged session list: pi sessions plus in-process Claude SDK sessions. */
  private async mergedSessions(
    opts: SessionListOptions = {},
  ): Promise<Awaited<ReturnType<typeof listSessions>>> {
    const startedAt = Date.now();
    const live = piStore.listInfo();
    const merged = await listSessions(live, sessionStore.getReadAt, opts);
    const byId = new Map(merged.map((session, index) => [session.id, index]));
    // One query each against the approval and pull-request-card tables for the
    // whole merge, never one per SDK row (`sessions.ts`'s one-pass contract).
    const approvals = pendingApprovalSessionIds();
    const taskChoices = choosingTaskSessionIds();
    // In-process SDK sessions are a live source like the pi store: they carry
    // no scope of their own, so the persisted classification decides whether
    // they may appear at all.
    const onlyIds = opts.onlyIds;
    const sdkSessions = claudeSdkStore
      .list()
      .filter((sdk) => !onlyIds || onlyIds.has(sdk.id));
    const sdkAllowed = sessionStore.liveDefaultScopeGate(
      sdkSessions.map((sdk) => sdk.id),
      { includeArchived: Boolean(opts.includeArchived) },
    );
    for (const sdk of sdkSessions) {
      const sdkKey = sdk.id;
      if (!sdkAllowed(sdkKey)) continue;
      const item = sdk.listItem(
        sessionStore.getReadAt(sdkKey),
        approvals,
        taskChoices,
      );
      // Match the pi projection: acquiring a runtime claims metadata but does
      // not create a conversation. Claude prompts persist + invalidate at user
      // entry acceptance, so a real first turn appears immediately.
      if (item.messageCount === 0) continue;
      item.isStreaming =
        sessionRuntime.isRunning(sdkKey) || Boolean(item.isStreaming);
      if (sessionStore.isArchived(sdkKey)) item.archived = true;
      if (item.archived && !opts.includeArchived) continue;
      const idx = byId.get(item.id);
      if (idx === undefined) {
        byId.set(item.id, merged.length);
        merged.push(item);
      } else {
        merged[idx] = { ...merged[idx], ...item };
      }
    }
    merged.sort((a, b) => b.updatedAt - a.updatedAt);
    const elapsed = Date.now() - startedAt;
    if (
      elapsed > SESSION_LIST_SLOW_MS &&
      process.env.NODE_ENV !== "production"
    ) {
      console.debug(
        `[perf] session list generated in ${elapsed}ms (${merged.length} sessions)`,
      );
    }
    return merged;
  }

  /**
   * Recompute one session-list row and push it to connected tabs. Built with
   * `onlyIds`: every row is computed from its own inputs, so the one row is the
   * same as in a full build, without projecting the whole archive to find it.
   */
  async broadcastSessionUpdated(sessionId: string): Promise<void> {
    const [session] = await this.mergedSessions({
      includeArchived: true,
      onlyIds: new Set([sessionId]),
    });
    if (!session) return;
    for (const c of this.connections) {
      if (session.archived && !c.wantsArchivedSessions?.()) continue;
      c.send({ type: "sessionUpdated", session });
    }
  }

  /** Recompute the merged session list and push it to every connected tab. */
  async broadcastSessions(): Promise<void> {
    if (!this.sessionsBroadcastPromise) {
      this.sessionsBroadcastPromise = new Promise((resolve) => {
        this.resolveSessionsBroadcast = resolve;
      });
    }

    if (this.sessionsBroadcastInFlight) {
      this.sessionsBroadcastRequestedDuringFlush = true;
      return this.sessionsBroadcastPromise;
    }

    if (this.sessionsBroadcastTimer) clearTimeout(this.sessionsBroadcastTimer);
    this.sessionsBroadcastTimer = setTimeout(() => {
      this.sessionsBroadcastTimer = undefined;
      void this.flushSessionsBroadcast();
    }, SESSION_BROADCAST_DEBOUNCE_MS);

    return this.sessionsBroadcastPromise;
  }

  private async flushSessionsBroadcast(): Promise<void> {
    if (this.sessionsBroadcastInFlight) {
      this.sessionsBroadcastRequestedDuringFlush = true;
      return;
    }
    this.sessionsBroadcastInFlight = true;
    try {
      do {
        this.sessionsBroadcastRequestedDuringFlush = false;
        const sessions = await this.mergedSessions();
        const archivedCount = await archivedSessionCount();
        // Most rebuilds during a run change ONE row's volatile state (running,
        // unread, title, updatedAt). Send those as single-row `sessionUpdated`s
        // instead of the whole list (~30 KB) to every connection: the client's
        // upsert is idempotent and re-sorts, so a delta is always safe to apply,
        // whatever that client last saw.
        // The archived COUNT only rides on a full list, and it can move while
        // both row sets stay the same — restoring a session keeps the archived
        // client's rows, deleting an archived one keeps the active client's — so
        // a changed count forces the list for every variant.
        const archivedCountMoved =
          this.lastBroadcastArchivedCount !== archivedCount;
        this.lastBroadcastArchivedCount = archivedCount;
        const plainDelta = archivedCountMoved
          ? null
          : sessionListDelta(this.lastBroadcastSessions, sessions);
        this.lastBroadcastSessions = sessions;
        let sessionsWithArchived: typeof sessions | undefined;
        let archivedDelta: typeof sessions | null | undefined;
        for (const c of this.connections) {
          if (c.wantsArchivedSessions?.()) {
            if (sessionsWithArchived === undefined) {
              sessionsWithArchived = await this.mergedSessions({
                includeArchived: true,
              });
              archivedDelta = archivedCountMoved
                ? null
                : sessionListDelta(
                    this.lastBroadcastArchivedSessions,
                    sessionsWithArchived,
                  );
              this.lastBroadcastArchivedSessions = sessionsWithArchived;
            }
            if (archivedDelta) {
              for (const session of archivedDelta)
                c.send({ type: "sessionUpdated", session });
            } else {
              c.send({
                type: "sessions",
                sessions: sessionsWithArchived,
                archivedSessionCount: archivedCount,
                archivedSessionsLoaded: true,
              });
            }
          } else if (plainDelta) {
            for (const session of plainDelta)
              c.send({ type: "sessionUpdated", session });
          } else {
            c.send({
              type: "sessions",
              sessions,
              archivedSessionCount: archivedCount,
              archivedSessionsLoaded: false,
            });
          }
        }
        // Don't rebuild back-to-back while invalidations keep streaming in —
        // wait a beat so a burst coalesces into one more rebuild, not many.
        if (this.sessionsBroadcastRequestedDuringFlush) {
          await new Promise((r) =>
            setTimeout(r, SESSION_BROADCAST_SUSTAINED_MS),
          );
        }
      } while (this.sessionsBroadcastRequestedDuringFlush);
    } catch (err) {
      console.warn("Failed to broadcast sessions:", errorText(err));
    } finally {
      this.sessionsBroadcastInFlight = false;
      const resolve = this.resolveSessionsBroadcast;
      this.sessionsBroadcastPromise = undefined;
      this.resolveSessionsBroadcast = undefined;
      resolve?.();
    }
  }

  async listSessions(
    opts: SessionListOptions = {},
  ): Promise<Awaited<ReturnType<typeof listSessions>>> {
    return this.mergedSessions(opts);
  }

  async archivedSessionCount(): Promise<number> {
    return archivedSessionCount();
  }

  /** Drop an in-process Claude-SDK session (tombstone + delete its record). */
  removeClaudeSdk(id: string): void {
    claudeSdkStore.remove(id);
  }

  /**
   * The driver for OUR session id, opening it from disk when it is not resident:
   * the single entry point the id-only `/sessions/<id>` routing uses. The
   * registry decides the engine (`harnesses/registry.ts`), from the metadata
   * row or, without one, from what an engine has on disk. Undefined when
   * nothing holds the session or its row is tombstoned, or when a pi session
   * has no native transcript to reopen from.
   */
  async acquireById(id: string): Promise<HarnessDriver | undefined> {
    return harnessRegistry.acquireById(id);
  }

  /**
   * What a READER needs to show session `id`: the resident driver when one
   * exists, otherwise a storage-backed {@link ViewSession} that renders the
   * session without opening its harness (see `viewSession.ts`). Synchronous by
   * construction — that is the whole point, since the open it avoids is what
   * made loading a long session take seconds.
   *
   * Undefined means there is nothing to show: no live session and no metadata
   * row (an optimistic id, or one already deleted).
   */
  viewById(id: string): HarnessDriver | undefined {
    return this.getLiveById(id) ?? viewSessionById(id);
  }

  /**
   * Synchronous lookup of an already-resident {@link HarnessDriver} for our id,
   * across both engines (`harnesses/registry.ts`), without loading or reopening
   * anything. Undefined if the session isn't currently live in memory.
   */
  getLiveById(id: string): HarnessDriver | undefined {
    return harnessRegistry.residentById(id);
  }

  /**
   * The `tasks` topic sequence a snapshot is taken at. The subscribe answer
   * carries it so the client can tell a MISSED event batch (a gap) from an
   * ordinary one; it is in-memory on purpose, because a reconnect resubscribes
   * and gets a fresh baseline anyway (docs/state-sync.md).
   */
  taskEventSeq(): number {
    return this.tasksEventSeq;
  }

  projectEventSeq(): number {
    return this.projectsEventSeq;
  }

  subagentEventSeq(): number {
    return this.subagentRegistryEventSeq;
  }

  subagentRunEventSeq(threadId: string): number {
    return this.subagentRunTopicSeq.get(threadId) ?? 0;
  }

  backgroundEventSeq(): number {
    return this.backgroundEventSequence;
  }

  /** Coalesce post-commit notifications; no mutation sends a registry snapshot. */
  broadcastBackgroundWork(): void {
    if (this.backgroundBroadcastTimer)
      clearTimeout(this.backgroundBroadcastTimer);
    this.backgroundBroadcastTimer = setTimeout(() => {
      this.backgroundBroadcastTimer = undefined;
      this.flushBackgroundWorkBroadcast();
    }, BACKGROUND_WORK_BROADCAST_DEBOUNCE_MS);
  }

  /**
   * Diff only the ids writes reported since the last flush. Every background
   * write stamps a fresh revision on each row it touches and reports exactly
   * those ids after COMMIT, so an unreported row cannot have moved: reading
   * the rest — all terminal history ever recorded — cannot produce an event.
   * A reported live row is an upsert; a reported row that left membership is
   * a delete, sent even when it joined and left inside one debounce window,
   * because a subscribe in between may have snapshotted it.
   */
  private flushBackgroundWorkBroadcast(): void {
    const pending = this.pendingBackgroundIds;
    this.pendingBackgroundIds = new Set();
    const index = backgroundWorkRevisionIndex(pending);
    const events: StateEvent<BackgroundWorkItemSummary>[] = [];
    for (const id of pending) {
      if (!index.has(id)) continue;
      const event = backgroundWorkStateItems([id], index)[0];
      if (event) {
        events.push(event);
        continue;
      }
      // A live row with no summary cannot happen in one synchronous flush. If
      // it ever does, keep the id pending so the next flush retries it rather
      // than losing the event.
      console.warn(
        `[background] no summary for live work item ${id}; event deferred.`,
      );
      this.pendingBackgroundIds.add(id);
    }
    // Deleting a session reports every row it ever owned, however many, so a
    // flush is cut into frames no larger than a subscribe answer. Each is an
    // ordinary batch with the next `seq`, sent in order.
    for (
      let start = 0;
      start < events.length;
      start += BACKGROUND_WORK_SNAPSHOT_MAX
    ) {
      this.backgroundEventSequence += 1;
      this.broadcastTopic("background", {
        type: "stateEvents",
        topic: "background",
        seq: this.backgroundEventSequence,
        events: events.slice(start, start + BACKGROUND_WORK_SNAPSHOT_MAX),
      });
    }
  }

  releaseSubagentRunTopic(threadId: string): void {
    if (
      ![...this.connections].some((viewer) =>
        viewer.wantsSubagentThread?.(threadId),
      )
    )
      this.subagentRunTopicSeq.delete(threadId);
  }

  /** Coalesce post-commit notifications; no mutation sends a registry snapshot. */
  broadcastSubagents(): void {
    if (this.subagentBroadcastTimer) clearTimeout(this.subagentBroadcastTimer);
    this.subagentBroadcastTimer = setTimeout(() => {
      this.subagentBroadcastTimer = undefined;
      this.flushSubagentBroadcast();
    }, SUBAGENT_BROADCAST_DEBOUNCE_MS);
  }

  private flushSubagentBroadcast(): void {
    const index = subagentThreadRevisionIndex();
    const pending = this.pendingSubagentIds;
    this.pendingSubagentIds = new Set();
    // Match Tasks/Projects: a pending live row is omitted from the cold
    // baseline so it is upserted; a pending tombstone remains in the baseline
    // so subscribers holding that row receive its delete. Non-members that were
    // not touched in this burst never enter the baseline.
    const baseline =
      this.lastFlushedSubagentRevisions ?? seedTaskBaseline(index, pending);
    const events: StateEvent<SubagentThreadSummary>[] = [];
    const flushed = new Map<string, number>();
    for (const [id, entry] of index) {
      if (!entry.live) continue;
      if (baseline.get(id) === entry.revision) {
        flushed.set(id, entry.revision);
        continue;
      }
      const event = subagentThreadStateItems([id], index)[0];
      if (!event || event.kind !== "upsert") {
        // Keep the old revision so a transient projection read failure retries
        // on the next flush instead of being mistaken for a delete below.
        console.warn(
          `[subagents] no summary for live thread ${id}; event deferred.`,
        );
        const previous = baseline.get(id);
        if (previous !== undefined) flushed.set(id, previous);
        continue;
      }
      flushed.set(id, entry.revision);
      events.push(event);
    }
    for (const [id, revision] of baseline) {
      if (flushed.has(id)) continue;
      events.push({
        kind: "delete",
        id,
        revision: index.get(id)?.revision ?? revision + 1,
      });
    }
    this.lastFlushedSubagentRevisions = flushed;
    if (events.length) {
      this.subagentRegistryEventSeq += 1;
      this.broadcastTopic("subagents", {
        type: "stateEvents",
        topic: "subagents",
        seq: this.subagentRegistryEventSeq,
        events,
      });
    }

    const runIds = this.pendingSubagentRunIds;
    this.pendingSubagentRunIds = new Set();
    const runEventsByThread = new Map<
      string,
      StateEvent<import("@assistant/shared").SubagentRunSummary>[]
    >();
    for (const id of runIds) {
      const threadId = subagentRunThreadId(id);
      if (!threadId) continue;
      const event = subagentRunStateItems([id])[0];
      if (!event) continue;
      const eventsForThread = runEventsByThread.get(threadId) ?? [];
      eventsForThread.push(event);
      runEventsByThread.set(threadId, eventsForThread);
    }
    for (const [threadId, runEvents] of runEventsByThread) {
      const viewers = [...this.connections].filter((viewer) =>
        viewer.wantsSubagentThread?.(threadId),
      );
      if (!viewers.length) continue;
      const seq = (this.subagentRunTopicSeq.get(threadId) ?? 0) + 1;
      this.subagentRunTopicSeq.set(threadId, seq);
      const message = {
        type: "subagentRunEvents" as const,
        threadId,
        seq,
        events: runEvents,
      };
      for (const viewer of viewers) viewer.send(message);
    }
  }

  broadcastProjects(): void {
    if (this.projectsBroadcastTimer) clearTimeout(this.projectsBroadcastTimer);
    this.projectsBroadcastTimer = setTimeout(() => {
      this.projectsBroadcastTimer = undefined;
      this.flushProjectBroadcast();
    }, PROJECT_BROADCAST_DEBOUNCE_MS);
  }

  private flushProjectBroadcast(): void {
    const index = projectRevisionIndex();
    const pending = this.pendingProjectIds;
    this.pendingProjectIds = new Set();
    const baseline =
      this.lastFlushedProjectRevisions ?? seedProjectBaseline(index, pending);
    const events: StateEvent<ProjectSummary>[] = [];
    const flushed = new Map<string, number>();
    for (const [id, entry] of index) {
      if (!entry.live) continue;
      if (baseline.get(id) === entry.revision) {
        flushed.set(id, entry.revision);
        continue;
      }
      const item = projectSummaryFor(id);
      if (!item) continue;
      flushed.set(id, entry.revision);
      events.push({ kind: "upsert", id, revision: entry.revision, item });
    }
    for (const [id, revision] of baseline) {
      if (flushed.has(id)) continue;
      events.push({
        kind: "delete",
        id,
        revision: index.get(id)?.revision ?? revision + 1,
      });
    }
    this.lastFlushedProjectRevisions = flushed;
    if (events.length) {
      this.projectsEventSeq += 1;
      this.broadcastTopic("projects", {
        type: "stateEvents",
        topic: "projects",
        seq: this.projectsEventSeq,
        events,
      });
    }
  }

  /**
   * Test seam: end every pending broadcast window now, as its timer would.
   * Writes made before the call still coalesce into one flush per domain; the
   * test only stops sleeping through the debounce. Resolves once a pending
   * session-list flush has sent.
   */
  async flushPendingBroadcastsForTests(): Promise<void> {
    if (this.tasksBroadcastTimer) {
      clearTimeout(this.tasksBroadcastTimer);
      this.tasksBroadcastTimer = undefined;
      this.flushTaskBroadcast();
    }
    if (this.projectsBroadcastTimer) {
      clearTimeout(this.projectsBroadcastTimer);
      this.projectsBroadcastTimer = undefined;
      this.flushProjectBroadcast();
    }
    if (this.subagentBroadcastTimer) {
      clearTimeout(this.subagentBroadcastTimer);
      this.subagentBroadcastTimer = undefined;
      this.flushSubagentBroadcast();
    }
    if (this.backgroundBroadcastTimer) {
      clearTimeout(this.backgroundBroadcastTimer);
      this.backgroundBroadcastTimer = undefined;
      this.flushBackgroundWorkBroadcast();
    }
    if (this.sessionsBroadcastTimer) {
      clearTimeout(this.sessionsBroadcastTimer);
      this.sessionsBroadcastTimer = undefined;
      await this.flushSessionsBroadcast();
    }
  }

  /**
   * A Task write happened. The authoritative rows reach subscribers as a
   * `stateEvents` batch, never as a list: a status toggle used to push the whole
   * active list (~140 KB) to every connected browser.
   */
  broadcastTasks(): void {
    // Coalesced like the session list: a bulk edit fires this many times in a
    // row. One trailing flush per burst diffs the same revisions and emits one
    // batch, so a fifty-Task sweep is one message, not fifty.
    if (this.tasksBroadcastTimer) clearTimeout(this.tasksBroadcastTimer);
    this.tasksBroadcastTimer = setTimeout(() => {
      this.tasksBroadcastTimer = undefined;
      this.flushTaskBroadcast();
    }, TASK_BROADCAST_DEBOUNCE_MS);
  }

  /**
   * Diff the domain's `{id → revision}` map against the one last flushed:
   * changed or new live ids become upserts carrying the row's summary, ids that
   * left the live projection become deletes. Membership is what travels, so
   * archiving is a delete and unarchiving an upsert.
   */
  private flushTaskBroadcast(): void {
    const index = taskRevisionIndex();
    const pending = this.pendingTaskIds;
    this.pendingTaskIds = new Set();
    const baseline =
      this.lastFlushedTaskRevisions ?? seedTaskBaseline(index, pending);
    const events: StateEvent<TaskSummary>[] = [];
    const flushed = new Map<string, number>();
    for (const [id, entry] of index) {
      if (!entry.live) continue;
      if (baseline.get(id) === entry.revision) {
        flushed.set(id, entry.revision);
        continue;
      }
      // Summaries only. Bodies are the bulk of a Task payload (~350 KB of
      // Markdown across the active list here) and no list surface renders them.
      const item = taskSummaryFor(id);
      if (!item) {
        // A live row with no summary cannot happen in one synchronous flush.
        // If it ever does, carry the OLD revision forward so the next flush
        // retries this row: recording the new one would tell every later flush
        // the event had been sent and lose it silently.
        console.warn(`[tasks] no summary for live Task ${id}; event deferred.`);
        const previous = baseline.get(id);
        if (previous !== undefined) flushed.set(id, previous);
        continue;
      }
      flushed.set(id, entry.revision);
      events.push({ kind: "upsert", id, revision: entry.revision, item });
    }
    for (const [id, revision] of baseline) {
      if (flushed.has(id)) continue;
      // A row that left the projection was archived or tombstoned; either way
      // its revision was stamped by the write that removed it.
      events.push({
        kind: "delete",
        id,
        revision: index.get(id)?.revision ?? revision + 1,
      });
    }
    this.lastFlushedTaskRevisions = flushed;
    if (events.length > 0) {
      this.tasksEventSeq += 1;
      this.broadcastTopic("tasks", {
        type: "stateEvents",
        topic: "tasks",
        seq: this.tasksEventSeq,
        events,
      });
    }

    // Session state carries a session's TASK BACK-LINKS, so only sessions that
    // are (or just stopped being) linked to a Task can have changed. Rebuilding
    // it for every live session meant one Task edit re-ran `toolExposure()` and
    // `peerPromptThreadsFor()` for every open conversation.
    const linked = taskLinkedSessionIds();
    // A session whose LAST task link was just removed is no longer in the index
    // but still shows the stale link, so it gets one final refresh.
    const targets = new Set([...linked, ...this.taskLinkedSessions]);
    this.taskLinkedSessions = linked;
    for (const session of harnessRegistry.resident())
      if (targets.has(session.sessionId)) session.broadcastState();
  }

  /** A session's prompt queue changed: its viewers get the complete new state. */
  broadcastPromptQueue(
    sessionId: string,
    queue: import("@assistant/shared").PromptQueueState,
  ): void {
    this.sendToSessionViewers(sessionId, {
      type: "promptQueue",
      sessionId,
      queue,
    });
  }

  /** A failure that belongs to one session, told to that session's viewers. */
  reportSessionError(sessionId: string, message: string): void {
    this.sendToSessionViewers(sessionId, {
      type: "error",
      message,
      target: { type: "session", id: sessionId },
    });
  }

  /** Broadcast an approvalUpdate to viewers of the specific origin session only. */
  broadcastApprovalUpdate(
    sessionId: string,
    approval: import("@assistant/shared").ApprovalCard,
  ): void {
    this.sendToSessionViewers(sessionId, {
      type: "approvalUpdate",
      sessionId,
      approval,
    });
  }

  /** Broadcast a session's approval grants to that session's viewers only. */
  broadcastApprovalGrants(
    sessionId: string,
    grants: import("@assistant/shared").ApprovalGrant[],
  ): void {
    this.sendToSessionViewers(sessionId, {
      type: "approvalGrants",
      sessionId,
      grants,
    });
  }

  /** Viewers of a resident session get it; with none resident, every tab does. */
  private sendToSessionViewers(
    sessionId: string,
    msg: import("@assistant/shared").ServerMessage,
  ): void {
    const session = harnessRegistry.residentById(sessionId);
    if (session) session.broadcast(msg);
    else this.broadcastAll(msg);
  }

  /** Broadcast a pullRequestCardUpdate to viewers of the card's origin session only. */
  broadcastPullRequestCardUpdate(
    card: import("@assistant/shared").PullRequestCard,
  ): void {
    const msg: import("@assistant/shared").ServerMessage = {
      type: "pullRequestCardUpdate",
      sessionId: card.sessionId,
      card,
    };
    this.sendToSessionViewers(card.sessionId, msg);
  }

  /** Broadcast a targeted peer-prompt card lifecycle patch to viewers of one session. */
  broadcastPeerPromptCardUpdate(
    sessionId: string,
    update: {
      messageKey: string;
      state: import("@assistant/shared").PeerPromptState;
      failureReason?: string;
    },
  ): void {
    const msg: import("@assistant/shared").ServerMessage = {
      type: "peerPromptCardUpdate",
      sessionId,
      ...update,
    };
    this.sendToSessionViewers(sessionId, msg);
  }

  async renameSession(
    kind: AgentType,
    file: string,
    id: string,
    title: string,
  ): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("Session title cannot be empty.");
    if (trimmed.length > 120)
      throw new Error("Session title must be 120 characters or fewer.");

    if (claudeSdkStore.exists(id)) {
      const sdk = claudeSdkStore.get(id) ?? claudeSdkStore.acquire(id);
      sdk.setTitle(trimmed); // persists + broadcasts the updated list
      return;
    }

    await piStore.renameSession(kind, file, id, trimmed);
    await this.broadcastSessions();
  }

  /* ----------------------------- dev reload ----------------------------- */

  private broadcastAll(message: ServerMessage): void {
    for (const c of this.connections) c.send(message);
  }

  /**
   * Send to the connections currently SHOWING this domain's list. A Task
   * mutation used to push ~147 KB to every connected browser, including phones
   * sitting in a conversation; a connection now declares what it displays
   * (`BroadcastTopic`), and a viewer that never subscribed receives nothing —
   * which is correct, since subscribing is what delivers the snapshot.
   */
  private broadcastTopic(topic: BroadcastTopic, message: ServerMessage): void {
    for (const c of this.connections) {
      if (c.wantsTopic?.(topic)) c.send(message);
    }
  }

  /**
   * Number of sessions with an active turn — pi agents AND in-process Claude SDK
   * sessions. A dev reload must wait for any streaming turn to finish.
   */
  runningCount(): number {
    return harnessRegistry.resident().filter((session) => session.isRunning)
      .length;
  }

  /**
   * Register work that shares the process lifecycle authority. Participants do
   * not affect `runningCount`; they close admission immediately, then drain only
   * after ordinary prompted turns have reached their safe boundary.
   */
  registerLifecycleDrainParticipant(
    participant: LifecycleDrainParticipant,
  ): () => void {
    this.lifecycleDrainParticipants.add(participant);
    return () => this.lifecycleDrainParticipants.delete(participant);
  }

  /** True while a requested reload is pending or already exiting. */
  isReloadQueued(): boolean {
    return this.reloadQueued || this.reloadTriggered;
  }

  /** A run just started; cancel any idle-settle countdown for a queued reload. */
  noteRunStarted(): void {
    if (!this.reloadQueued || this.reloadTriggered) return;
    if (this.reloadSettleTimer) {
      clearTimeout(this.reloadSettleTimer);
      this.reloadSettleTimer = undefined;
    }
    this.broadcastReloadPending();
  }

  /**
   * Production/systemd shutdown path: reuse the reload drain so no new pi prompts
   * start, active turns finish, and the process exits
   * through the normal DB close hook. The optional force timer is a last resort;
   * systemd's TimeoutStopSec should be comfortably higher than normal turns.
   */
  requestGracefulShutdown(opts: { forceAfterMs?: number } = {}): void {
    this.requestReload();
    if (opts.forceAfterMs === undefined || opts.forceAfterMs <= 0) return;
    setTimeout(() => {
      if (this.reloadTriggered) return;
      console.warn(
        `[shutdown] forcing shutdown after ${opts.forceAfterMs}ms with ${this.runningCount()} active session(s).`,
      );
      this.triggerReload();
    }, opts.forceAfterMs).unref();
  }

  sendReloadStateTo(v: Viewer): void {
    if (this.reloadTriggered)
      v.send({
        type: "devReload",
        phase: "reloading",
        runningCount: this.runningCount(),
      });
    else if (this.reloadQueued)
      v.send({
        type: "devReload",
        phase: "pending",
        runningCount: this.runningCount(),
      });
  }

  private broadcastReloadPending(): void {
    this.broadcastAll({
      type: "devReload",
      phase: "pending",
      runningCount: this.runningCount(),
    });
  }

  /**
   * Dev-only: a server/shared file changed. Queue a global reload, announce it
   * to every client, wait for every live session to become idle, then wait one
   * extra settle delay before exiting. The dev supervisor respawns the server
   * and clients auto-reconnect.
   */
  requestReload(): void {
    if (this.reloadTriggered) return;
    if (!this.reloadQueued) {
      for (const participant of this.lifecycleDrainParticipants) {
        try {
          participant.closeAdmissions();
        } catch (error) {
          console.warn("[shutdown] lifecycle admission close failed:", error);
        }
      }
    }
    this.reloadQueued = true;
    this.broadcastReloadPending();
    this.checkPendingReload();
  }

  /** Re-check after a run ends whether a deferred reload can now proceed. */
  checkPendingReload(): void {
    if (!this.reloadQueued || this.reloadTriggered) return;
    const running = this.runningCount();
    if (running > 0) {
      if (this.reloadSettleTimer) {
        clearTimeout(this.reloadSettleTimer);
        this.reloadSettleTimer = undefined;
      }
      this.broadcastReloadPending();
      return;
    }
    if (!this.lifecycleDrainFinished) {
      if (!this.lifecycleDrainPromise) {
        this.lifecycleDrainPromise = Promise.all(
          [...this.lifecycleDrainParticipants].map((participant) =>
            Promise.resolve().then(() => participant.drain()),
          ),
        )
          .then(() => {
            this.lifecycleDrainFinished = true;
            this.checkPendingReload();
          })
          .catch((error) => {
            // A failed participant may not authorize a CLEAN exit. The outer
            // graceful-shutdown force timer remains the bounded unclean path.
            console.warn(
              "[shutdown] lifecycle participant drain failed:",
              error,
            );
          });
      }
      return;
    }
    if (this.reloadSettleTimer) return;
    this.broadcastReloadPending();
    this.reloadSettleTimer = setTimeout(() => {
      this.reloadSettleTimer = undefined;
      if (!this.reloadQueued || this.reloadTriggered) return;
      if (this.runningCount() > 0) {
        this.checkPendingReload();
        return;
      }
      this.triggerReload();
    }, RELOAD_IDLE_SETTLE_MS);
  }

  private triggerReload(): void {
    if (this.reloadTriggered) return;
    if (this.reloadSettleTimer) {
      clearTimeout(this.reloadSettleTimer);
      this.reloadSettleTimer = undefined;
    }
    this.reloadQueued = false;
    this.reloadTriggered = true;
    this.broadcastAll({
      type: "devReload",
      phase: "reloading",
      runningCount: this.runningCount(),
    });
    // The response is already shown; let the client render it and the banner
    // before the socket drops and it reconnects to the respawned server.
    setTimeout(() => process.exit(0), RELOAD_GRACE_MS);
  }

  /* ----------------------------- image serving ----------------------------- */

  /** Resolve a pi session image to raw bytes (live branch or cold reopen). */
  async resolvePiImage(
    kind: AgentType,
    sessionId: string,
    entryId: string,
    imageIndex: number,
  ): Promise<{ data: Buffer; mimeType: string } | undefined> {
    return piStore.resolvePiImage(kind, sessionId, entryId, imageIndex);
  }
}

export const hub = new SessionHub();
