import type { BroadcastTopic, ServerMessage } from "@assistant/shared";
import { isCodingAgentType } from "@assistant/shared";
import {
  archivedSessionCount,
  listSessions,
  type SessionListOptions,
} from "./sessions.ts";
import type { HarnessDriver, Viewer } from "./harness.ts";
import { sessionRuntime } from "./session/runtimeInstance.ts";
import { subscribeHarnessOpened } from "./session/runtimePrompt.ts";
import { viewSessionById } from "./viewSession.ts";
import { buildSessionState } from "./sessionState.ts";
import { taskLinkedSessionIds } from "./tasks.ts";
import {
  consumePostReloadContinuation,
  subscribeBrowserRuntimeChanges,
  type PostReloadContinuation,
} from "./mcp/toolGroups/registry.ts";
import { harnessRegistry } from "./harnesses/registry.ts";
import { mergedSessionList } from "./harnesses/sessionList.ts";
import { setWorktreeBroadcaster } from "./worktrees/worktreeEvents.ts";
import {
  onPresenceChange,
  type PresenceChange,
} from "./worktrees/checkoutPresence.ts";
import { worktreeReadsPresenceKey } from "./worktrees/sessionCwd.ts";
import {
  worktreeIdBySession,
  worktreeIdForSession,
} from "./db/worktreeStore.ts";
import { setLibraryBroadcaster } from "./library/libraryPublish.ts";
import { setMemoryBroadcaster } from "./memoryEvents.ts";
import {
  setAppNotificationBroadcaster,
  deliverAppNotification,
} from "./webPush.ts";
import { initializeAccountHealth } from "./accountHealth.ts";
import {
  listCredentialProfiles,
  credentialProfileHasCredential,
  subscribeCredentialProfileChanges,
  subscribeCredentialProfileDeleted,
} from "./credentialProfiles.ts";
import { setUsageBroadcaster } from "./usageCache.ts";
import { onSettingsChanged } from "./settingsService.ts";
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
import {
  setSessionListSink,
  touchSessionRows,
} from "./db/sessionListChanges.ts";
import {
  advancePeerDeadlines,
  startPeerDeadlineClock,
} from "./db/peerDeadlineClock.ts";
import { permanentAssistantStore } from "./db/permanentAssistantStore.ts";
import { permanentAssistantUnread } from "./permanentAssistantUnread.ts";
import {
  attachStateTopics,
  flushStateTopicsForTests,
  stateTopicFor,
} from "./stateTopics.ts";

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
/**
 * Minimum gap between consecutive list rebuilds while invalidations keep
 * arriving (e.g. a streaming run). The first broadcast is fast (25ms debounce);
 * sustained churn coalesces to at most ~4 rebuilds/second.
 */
const SESSION_BROADCAST_SUSTAINED_MS = 250;
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
 * Backstop interval of the production sweep (`sweepSessionRows`). Tests run
 * without it, so no assertion can pass because it repaired a row.
 */
const SESSION_LIST_SWEEP_MS = 60_000;
/**
 * Under test, every flush first compares a full build with what was published
 * and throws on a row nothing touched (`docs/session-list.md`, "Audit").
 */
const SESSION_LIST_AUDIT = process.env.VITEST === "true";

type SessionRow = Awaited<ReturnType<typeof listSessions>>[number];

/** A row as last published: its serialization and which variant holds it. */
interface PublishedSessionRow {
  json: string;
  archived: boolean;
}

/**
 * What one flush sends, per variant: the archived-loaded variant holds every
 * row, the default one the unarchived rows. A variant whose row SET changed
 * (a row added, removed, or archived/restored for the default variant) or
 * with more than {@link SESSION_DELTA_MAX_ROWS} changed rows needs the whole
 * list: a single-row upsert cannot express a removal. Forced rows are sent
 * even when equal and do not count against the cap. Comparing serialized rows
 * is exact and cheap next to building them.
 */
function planSessionListSends(
  rows: readonly SessionRow[],
  compared: readonly string[],
  previous: ReadonlyMap<string, PublishedSessionRow> | undefined,
  forced: ReadonlySet<string>,
): {
  byId: Map<string, SessionRow>;
  plainFull: boolean;
  archivedFull: boolean;
  plainSend: SessionRow[];
  archivedSend: SessionRow[];
} {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ids = new Set(compared);
  let plainFull = false;
  let archivedFull = false;
  let plainChanged = 0;
  let archivedChanged = 0;
  const plainSend: SessionRow[] = [];
  const archivedSend: SessionRow[] = [];
  for (const id of ids) {
    const before = previous?.get(id);
    if (byId.has(id) || !before) continue;
    archivedFull = true;
    if (!before.archived) plainFull = true;
  }
  // In list order, so a delta reads like the list it patches.
  for (const row of rows) {
    if (!ids.has(row.id)) continue;
    const before = previous?.get(row.id);
    const archived = Boolean(row.archived);
    if (!before) {
      archivedFull = true;
      if (!archived) plainFull = true;
    } else if (before.archived !== archived) plainFull = true;
    const changed = before?.json !== JSON.stringify(row);
    if (changed) {
      archivedChanged += 1;
      if (!archived) plainChanged += 1;
    }
    if (changed || forced.has(row.id)) {
      archivedSend.push(row);
      if (!archived) plainSend.push(row);
    }
  }
  return {
    byId,
    plainFull: plainFull || plainChanged > SESSION_DELTA_MAX_ROWS,
    archivedFull: archivedFull || archivedChanged > SESSION_DELTA_MAX_ROWS,
    plainSend,
    archivedSend,
  };
}

/** The top-level fields that differ between a published row and a fresh one. */
function changedSessionRowFields(
  before: string | undefined,
  after: SessionRow | undefined,
): string[] {
  if (before === undefined) return ["(added)"];
  if (after === undefined) return ["(removed)"];
  const old = JSON.parse(before) as Record<string, unknown>;
  const next = after as unknown as Record<string, unknown>;
  return [...new Set([...Object.keys(old), ...Object.keys(next)])].filter(
    (key) => JSON.stringify(old[key]) !== JSON.stringify(next[key]),
  );
}

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
 * the harness registry's to answer (`harnesses/registry.ts`), and session
 * creation, forks, renames and removal go through `harnesses/`; pi images and
 * the merged listing still read {@link piStore} and {@link claudeSdkStore}.
 * Keeps every tab's session list in sync.
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
  /** Coalesces bursts of session-row touches into one rebuild + broadcast. */
  private sessionsBroadcastTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionsBroadcastPromise: Promise<void> | undefined;
  private resolveSessionsBroadcast: (() => void) | undefined;
  private sessionsBroadcastInFlight = false;
  private sessionsBroadcastRequestedDuringFlush = false;
  /** A caller awaits the flush (`flushSessionRowsNow`): no sustained wait. */
  private sessionsFlushNow = false;
  /** Rows touched since the last flush took them; see `db/sessionListChanges.ts`. */
  private touchedSessionRows = new Set<string>();
  /** The touched rows to send even when equal (an authoritative refresh). */
  private forcedSessionRows = new Set<string>();
  private touchAllSessionRowsPending = false;
  /**
   * Every row as last published, archived ones included, by id: what each
   * touched row is compared with. Undefined before the first flush, which
   * therefore rebuilds and sends every row.
   */
  private publishedSessionRows: Map<string, PublishedSessionRow> | undefined;
  /** The every-flush audit (tests only); a cost measurement pauses it. */
  private sessionListAudit = SESSION_LIST_AUDIT;
  /** Archived count last sent; it only travels on a full list (see `publishTouchedSessionRows`). */
  private lastBroadcastArchivedCount: number | undefined;
  private lastPermanentAssistantUnread: boolean | undefined;
  /** Sessions task-linked at the previous Task flush; see `refreshTaskLinkedSessions`. */
  private taskLinkedSessions = new Set<string>();

  constructor() {
    // The host object inverts the session→hub calls so no engine imports hub.ts.
    setSessionListSink({
      touch: (ids, force) => this.touchSessionRowIds(ids, force),
      touchAll: () => {
        this.touchAllSessionRowsPending = true;
        void this.scheduleSessionsFlush();
      },
    });
    startPeerDeadlineClock();
    if (!SESSION_LIST_AUDIT) this.startSessionListSweep();
    harnessRegistry.setHost({
      sessionRowsChanged: (ids) => touchSessionRows(ids),
      noteRunStarted: () => this.noteRunStarted(),
      checkPendingReload: () => this.checkPendingReload(),
      isReloadQueued: () => this.isReloadQueued(),
      buildSessionState: (sessionId, facts) =>
        buildSessionState(sessionId, facts, (id) =>
          harnessRegistry.browserRuntimeOwner(id),
        ),
    });
    subscribeBrowserRuntimeChanges(() => {
      for (const session of harnessRegistry.resident())
        if (isCodingAgentType(session.agentType)) session.broadcastState();
    });
    attachStateTopics((topic, msg) => this.broadcastTopic(topic, msg));
    // A published Task change may have moved a session's task back-links.
    stateTopicFor("tasks")!.onPublished(() => this.refreshTaskLinkedSessions());
    // Background work moves only its owners' `backgroundActivity`, which its
    // store touches at the write (`backgroundWorkStore` `markStateChanged`).
    sessionRuntime.subscribeEvents((sessionId, event) => {
      if (event.type === "runStateChanged") touchSessionRows([sessionId]);
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
    // A checkout's side answered differently than before (D14): the list's
    // `worktreeMissing` and the banner of every session reading that answer
    // are rebuilt. Rebuilding reads the cache again, which probes once more;
    // an unchanged answer notifies nothing, so this settles.
    onPresenceChange((changes) => this.checkoutPresenceChanged(changes));
    // The libraries' only path to browsers: one topic each, one list shape.
    setLibraryBroadcaster({
      broadcast: (msg, topic) => this.broadcastTopic(topic, msg),
    });
    setCommentBroadcaster({
      broadcast: (target, msg) =>
        broadcastCommentEventToViewers(this.connections, target, msg),
    });
    setCommentChangeNotifier(notifyCommentChanges);
    setCommentMetadataChangeNotifier(notifyCommentMetadataChanges);
    setMemoryBroadcaster({ broadcastAll: (msg) => this.broadcastAll(msg) });
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
    initializeAccountHealth({
      broadcast: (message) => this.broadcastAll(message),
      push: deliverAppNotification,
      profiles: listCredentialProfiles,
      hasCredential: credentialProfileHasCredential,
      subscribeChanges: subscribeCredentialProfileChanges,
      subscribeDeleted: subscribeCredentialProfileDeleted,
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

  /**
   * A session's stored metadata changed: every viewer showing it detached
   * resends its state from the row. Opens no harness.
   */
  sessionStateChanged(sessionId: string): void {
    for (const c of this.connections) c.sessionStateChanged?.(sessionId);
  }

  private checkoutPresenceChanged(changes: readonly PresenceChange[]): void {
    const keys = new Set(changes.map((change) => change.key));
    const reads = (sessionId: string) => {
      const worktreeId = worktreeIdForSession(sessionId);
      return !!worktreeId && worktreeReadsPresenceKey(worktreeId, keys);
    };
    // Every row in such a worktree, resident or not: its `worktreeMissing`
    // reads the answer that just changed. Synchronous with `apply`.
    const readingWorktrees = new Map<string, boolean>();
    touchSessionRows(
      [...worktreeIdBySession()]
        .filter(([, worktreeId]) => {
          let reads = readingWorktrees.get(worktreeId);
          if (reads === undefined) {
            reads = worktreeReadsPresenceKey(worktreeId, keys);
            readingWorktrees.set(worktreeId, reads);
          }
          return reads;
        })
        .map(([sessionId]) => sessionId),
    );
    for (const session of harnessRegistry.resident())
      if (reads(session.sessionId)) session.broadcastState();
    for (const sessionId of this.viewedSessionIds())
      if (reads(sessionId)) this.sessionStateChanged(sessionId);
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

  consumePostReloadContinuation(): PostReloadContinuation | undefined {
    return consumePostReloadContinuation();
  }

  /** The merged session list across both engines (`harnesses/sessionList.ts`). */
  private async mergedSessions(
    opts: SessionListOptions = {},
  ): Promise<Awaited<ReturnType<typeof listSessions>>> {
    return mergedSessionList(opts);
  }

  /** Connect and live delivery share one cache; a late read cannot regress it. */
  async sendPermanentAssistantUnreadTo(viewer: Viewer): Promise<void> {
    if (this.lastPermanentAssistantUnread === undefined) {
      const unread = await permanentAssistantUnread();
      if (this.lastPermanentAssistantUnread === undefined)
        this.lastPermanentAssistantUnread = unread;
    }
    viewer.send({
      type: "permanentAssistantUnread",
      unread: this.lastPermanentAssistantUnread ?? false,
    });
  }

  private publishPermanentAssistantUnread(unread: boolean): void {
    if (unread === this.lastPermanentAssistantUnread) return;
    this.lastPermanentAssistantUnread = unread;
    for (const viewer of this.connections)
      viewer.send({ type: "permanentAssistantUnread", unread });
  }

  /**
   * Re-send one session-list row even when it equals what was published: an
   * authoritative refresh replacing a client's optimistic guess (a refused
   * delete, a blocked settle). Resolves once the row is sent, so the caller's
   * error follows it.
   */
  async broadcastSessionUpdated(sessionId: string): Promise<void> {
    touchSessionRows([sessionId], { force: true });
    await this.flushSessionRowsNow();
  }

  /**
   * Resolves once the rows touched so far are sent — the pending flush, its
   * debounce included. Not a report: a caller whose reply or other broadcast
   * must FOLLOW the list (a command's `mutationSettled`, a run list after its
   * roles) awaits it after its writes.
   */
  sessionRowsSent(): Promise<void> {
    return this.sessionsBroadcastPromise ?? Promise.resolve();
  }

  /** The sink behind `touchSessionRows` (`db/sessionListChanges.ts`). */
  private touchSessionRowIds(ids: ReadonlySet<string>, force: boolean): void {
    for (const id of ids) {
      this.touchedSessionRows.add(id);
      if (force) this.forcedSessionRows.add(id);
    }
    void this.scheduleSessionsFlush();
  }

  /** Coalesce touches into one flush: 25 ms debounce, 250 ms under churn. */
  private scheduleSessionsFlush(): Promise<void> {
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

  /** Flush pending touches now, skipping the debounce and the sustained wait. */
  private async flushSessionRowsNow(): Promise<void> {
    this.sessionsFlushNow = true;
    const pending = this.sessionsBroadcastPromise;
    if (this.sessionsBroadcastInFlight) {
      this.sessionsBroadcastRequestedDuringFlush = true;
      await pending;
      return;
    }
    if (this.sessionsBroadcastTimer) {
      clearTimeout(this.sessionsBroadcastTimer);
      this.sessionsBroadcastTimer = undefined;
    }
    await this.flushSessionsBroadcast();
  }

  private async flushSessionsBroadcast(): Promise<void> {
    if (this.sessionsBroadcastInFlight) {
      this.sessionsBroadcastRequestedDuringFlush = true;
      return;
    }
    this.sessionsBroadcastInFlight = true;
    let unreported: Error | undefined;
    try {
      do {
        this.sessionsBroadcastRequestedDuringFlush = false;
        // The audit compares BEFORE anything is published, so neither the
        // delta nor a full-list fallback can refresh the baseline over an
        // unreported change.
        if (this.sessionListAudit && this.publishedSessionRows) {
          const unreportedRows = this.unreportedSessionRowChanges(
            await this.mergedSessions({ includeArchived: true }),
          );
          if (unreportedRows.length > 0) {
            unreported = new Error(
              `unreported session row change: ${unreportedRows
                .map(({ id, fields }) => `${id} ${fields.join(",")}`)
                .join("; ")}`,
            );
            break;
          }
        }
        await this.publishTouchedSessionRows();
        // Don't rebuild back-to-back while touches keep streaming in — wait a
        // beat so a burst coalesces into one more rebuild, not many.
        if (
          this.sessionsBroadcastRequestedDuringFlush &&
          !this.sessionsFlushNow
        )
          await new Promise((r) =>
            setTimeout(r, SESSION_BROADCAST_SUSTAINED_MS),
          );
      } while (this.sessionsBroadcastRequestedDuringFlush);
    } catch (err) {
      console.warn("Failed to broadcast sessions:", errorText(err));
    } finally {
      this.sessionsBroadcastInFlight = false;
      this.sessionsFlushNow = false;
      const resolve = this.resolveSessionsBroadcast;
      this.sessionsBroadcastPromise = undefined;
      this.resolveSessionsBroadcast = undefined;
      resolve?.();
    }
    if (unreported) throw unreported;
  }

  /**
   * Rebuild only the touched rows, compare them with what was published, and
   * send today's messages: changed rows as `sessionUpdated` (forced ones even
   * when equal), or the whole list for a variant whose row SET changed, whose
   * archived count moved, or with more than {@link SESSION_DELTA_MAX_ROWS}
   * changed rows. A global touch, or no baseline yet, rebuilds every row.
   */
  private async publishTouchedSessionRows(): Promise<void> {
    const touched = this.touchedSessionRows;
    const forced = this.forcedSessionRows;
    const everyRow =
      this.touchAllSessionRowsPending || !this.publishedSessionRows;
    this.touchedSessionRows = new Set();
    this.forcedSessionRows = new Set();
    this.touchAllSessionRowsPending = false;
    if (!everyRow && touched.size === 0) return;

    const previous = this.publishedSessionRows;
    const archivedCount = await archivedSessionCount();
    // The archived COUNT only rides on a full list, and it can move while
    // both row sets stay the same — restoring a session keeps the archived
    // client's rows, deleting an archived one keeps the active client's — so
    // a changed count forces the list for every variant.
    const archivedCountMoved =
      this.lastBroadcastArchivedCount !== archivedCount;
    this.lastBroadcastArchivedCount = archivedCount;

    let rows = await this.mergedSessions(
      everyRow
        ? { includeArchived: true }
        : { includeArchived: true, onlyIds: touched },
    );
    let builtEveryRow = everyRow;
    const compared = (): string[] =>
      everyRow
        ? [
            ...new Set([
              ...rows.map((row) => row.id),
              ...(previous?.keys() ?? []),
            ]),
          ]
        : [...touched];
    let plan = planSessionListSends(rows, compared(), previous, forced);
    const fullPlain = !previous || archivedCountMoved || plan.plainFull;
    const fullArchived = !previous || archivedCountMoved || plan.archivedFull;
    if ((fullPlain || fullArchived) && !builtEveryRow) {
      // One full build serves both variants; the comparison is redone on it
      // so a delta sent beside a full list describes the same content.
      rows = await this.mergedSessions({ includeArchived: true });
      builtEveryRow = true;
      plan = planSessionListSends(rows, compared(), previous, forced);
    }

    const published = new Map(previous ?? []);
    for (const id of compared()) {
      const row = plan.byId.get(id);
      if (row)
        published.set(id, {
          json: JSON.stringify(row),
          archived: Boolean(row.archived),
        });
      else published.delete(id);
    }
    this.publishedSessionRows = published;

    const assistantId = permanentAssistantStore.sessionId();
    if (assistantId && compared().includes(assistantId))
      this.publishPermanentAssistantUnread(
        Boolean(plan.byId.get(assistantId)?.unread),
      );
    else if (!previous) this.publishPermanentAssistantUnread(false);

    const plainRows = builtEveryRow
      ? rows.filter((row) => !row.archived)
      : undefined;
    // The singleton's row reaches clients only as the scalar above; the
    // connection would drop its `sessionUpdated` anyway (`publicServerMessage`).
    const rowUpdates = (sends: SessionRow[]) =>
      sends.filter((session) => session.id !== assistantId);
    for (const c of this.connections) {
      if (c.wantsArchivedSessions?.()) {
        if (fullArchived)
          c.send({
            type: "sessions",
            sessions: rows,
            archivedSessionCount: archivedCount,
            archivedSessionsLoaded: true,
          });
        else
          for (const session of rowUpdates(plan.archivedSend))
            c.send({ type: "sessionUpdated", session });
      } else if (fullPlain) {
        c.send({
          type: "sessions",
          sessions: plainRows!,
          archivedSessionCount: archivedCount,
          archivedSessionsLoaded: false,
        });
      } else {
        for (const session of rowUpdates(plan.plainSend))
          c.send({ type: "sessionUpdated", session });
      }
    }
  }

  /**
   * Rows that differ from what was published although nothing touched them
   * since: what the test-mode audit throws on and the production sweep
   * repairs. A pending global touch rebuilds everything anyway.
   */
  private unreportedSessionRowChanges(
    rows: Awaited<ReturnType<typeof listSessions>>,
  ): { id: string; fields: string[] }[] {
    const published = this.publishedSessionRows;
    if (!published || this.touchAllSessionRowsPending) return [];
    const fresh = new Map(rows.map((row) => [row.id, row]));
    const changes: { id: string; fields: string[] }[] = [];
    for (const id of new Set([...fresh.keys(), ...published.keys()])) {
      if (this.touchedSessionRows.has(id)) continue;
      const row = fresh.get(id);
      const before = published.get(id)?.json;
      const after = row && JSON.stringify(row);
      if (before !== after)
        changes.push({ id, fields: changedSessionRowFields(before, row) });
    }
    return changes;
  }

  /**
   * The production backstop (every {@link SESSION_LIST_SWEEP_MS}): advance the
   * deadline watermark, then compare a full build with what was published and
   * log and repair any row no write reported. It is not a reporter: nothing
   * relies on it, and tests run without it.
   */
  async sweepSessionRows(): Promise<void> {
    advancePeerDeadlines();
    if (!this.publishedSessionRows) return;
    const rows = await this.mergedSessions({ includeArchived: true });
    const changes = this.unreportedSessionRowChanges(rows);
    for (const { id, fields } of changes)
      console.warn(
        `[sessions] unreported row change: ${id} (${fields.join(", ")})`,
      );
    touchSessionRows(changes.map((change) => change.id));
  }

  /** Starts the sweep (production boot); returns its stop. */
  startSessionListSweep(): () => void {
    const timer = setInterval(() => {
      void this.sweepSessionRows().catch((err: unknown) =>
        console.warn("[sessions] row sweep failed:", errorText(err)),
      );
    }, SESSION_LIST_SWEEP_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * Test seam for fixtures that seed rows behind the stores' backs: the next
   * flush rebuilds every row and sends the full list, as after boot.
   */
  resetSessionListBaselineForTests(): void {
    this.publishedSessionRows = undefined;
  }

  /** Test seam: pause the every-flush audit while a test counts store reads. */
  setSessionListAuditForTests(on: boolean): void {
    this.sessionListAudit = on && SESSION_LIST_AUDIT;
  }

  async listSessions(
    opts: SessionListOptions = {},
  ): Promise<Awaited<ReturnType<typeof listSessions>>> {
    return this.mergedSessions(opts);
  }

  async archivedSessionCount(): Promise<number> {
    return archivedSessionCount();
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
   * Test seam: end every pending broadcast window now, as its timer would.
   * Writes made before the call still coalesce into one flush per domain; the
   * test only stops sleeping through the debounce. Resolves once a pending
   * session-list flush has sent.
   */
  async flushPendingBroadcastsForTests(): Promise<void> {
    // Before the session list: a post-publish listener may request it.
    flushStateTopicsForTests();
    if (this.sessionsBroadcastTimer) {
      clearTimeout(this.sessionsBroadcastTimer);
      this.sessionsBroadcastTimer = undefined;
      await this.flushSessionsBroadcast();
    } else if (this.sessionsBroadcastPromise) {
      await this.sessionsBroadcastPromise;
    }
  }

  /** The `tasks` kernel's post-publish listener: runs after every Task flush. */
  private refreshTaskLinkedSessions(): void {
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

  /**
   * How many background-work updates wait for this session, and how many it
   * was given without finishing them, told to its viewers.
   */
  broadcastBackgroundUpdateQueue(
    sessionId: string,
    count: number,
    unhandled: {
      count: number;
      batch: import("@assistant/shared").BackgroundHandlingRef[];
    },
  ): void {
    this.sendToSessionViewers(sessionId, {
      type: "backgroundUpdateQueue",
      sessionId,
      count,
      ...(unhandled.count > 0
        ? { unhandled: unhandled.count, unhandledBatch: unhandled.batch }
        : {}),
    });
  }

  broadcastPeerPromptQueue(
    sessionId: string,
    items: import("@assistant/shared").QueuedPeerPrompt[],
  ): void {
    this.sendToSessionViewers(sessionId, {
      type: "peerPromptQueue",
      sessionId,
      items,
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
    payload: import("./pendingApprovals.ts").ApprovalGrantsPayload,
  ): void {
    this.sendToSessionViewers(sessionId, {
      type: "approvalGrants",
      sessionId,
      ...payload,
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
      interruption?: import("@assistant/shared").PeerPromptInterruption;
      settledReason?: string;
    },
  ): void {
    const msg: import("@assistant/shared").ServerMessage = {
      type: "peerPromptCardUpdate",
      sessionId,
      ...update,
    };
    this.sendToSessionViewers(sessionId, msg);
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
}

export const hub = new SessionHub();
