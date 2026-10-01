/**
 * The live coordinator. Owns the in-memory {@link LiveRuntimeSession} objects,
 * drives prompts (one run per session), and exposes a race-safe
 * subscribe-then-snapshot feed for the transport. The durable log is passive and
 * supplied by a {@link SessionLogStore}; run state lives only here.
 */
import type {
  LazyBlockKind,
  SessionConfig,
  SessionSnapshot,
} from "@assistant/shared/session";
import type { ClientTimelineEntry } from "@assistant/shared/runtime";
import type { PromptableAdapter } from "../adapters/contract.ts";
import { detachedAdapter } from "../adapters/detached.ts";
import type { SessionLogEntry } from "../log/rawEntry.ts";
import {
  SessionLogStore,
  type SessionLog,
  type TimelineRangeResult,
} from "../log/store.ts";
import { InactiveSessionError } from "./errors.ts";
import type { RuntimeEvent, RuntimeEventListener } from "./events.ts";
import {
  LiveRuntimeSession,
  type RuntimePromptOptions,
} from "./liveSession.ts";

/** A subscription handle: the snapshot captured AT subscribe time + the unsubscribe fn. */
export interface SessionStream {
  snapshot: SessionSnapshot;
  unsubscribe: () => void;
}

export type RuntimeSessionEventListener = (
  sessionId: string,
  event: RuntimeEvent,
) => void;

/**
 * How long a DETACHED session stays live after its last view lets go. Long
 * enough that flipping to another session and back, or a reloading tab, finds
 * it resident; short enough that browsing does not accumulate logs, which cost
 * 1.2–2.3× their file size in heap. Reopening is a log read (~5ms/MB).
 */
export const VIEW_RELEASE_GRACE_MS = 60_000;

export class SessionRuntime {
  private readonly live = new Map<string, LiveRuntimeSession>();
  private readonly eventUnsubscribers = new Map<string, () => void>();
  private readonly eventListeners = new Set<RuntimeSessionEventListener>();
  /** Views holding each live session (see {@link retainView}). */
  private readonly viewCounts = new WeakMap<LiveRuntimeSession, number>();
  private readonly viewReleaseTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** Prompts admitted at `runtimePrompt.ts` and not yet settled, per session. */
  private readonly admissions = new Map<string, number>();

  constructor(
    private readonly logStore: SessionLogStore = new SessionLogStore(),
    private readonly viewReleaseGraceMs = VIEW_RELEASE_GRACE_MS,
  ) {}

  /**
   * Bring a session live under the runtime with its backing adapter. The log is
   * opened (and rehydrated) from the store. Idempotent: re-creating an already
   * live session returns the existing instance (the passed adapter is ignored).
   */
  createSession(
    sessionId: string,
    adapter: PromptableAdapter,
  ): LiveRuntimeSession {
    const existing = this.live.get(sessionId);
    if (existing) return existing;
    const log = this.logStore.open(sessionId);
    const session = new LiveRuntimeSession(sessionId, log, adapter);
    this.live.set(sessionId, session);
    this.eventUnsubscribers.set(
      sessionId,
      session.subscribe((event) => this.emitSessionEvent(sessionId, event)),
    );
    return session;
  }

  get(sessionId: string): LiveRuntimeSession | undefined {
    return this.live.get(sessionId);
  }

  /**
   * Bring a session live for RENDERING ONLY, without opening its harness (see
   * `adapters/detached.ts`). Idempotent and never downgrades: a session already
   * live with a real adapter is returned as it is.
   *
   * A session brought live here is released like one whose last view let go,
   * unless a view retains it: a caller that only reads it once (a storage-backed
   * `contextInfo`) must not leave its log resident for the process lifetime.
   */
  openForView(sessionId: string): LiveRuntimeSession {
    const existing = this.live.get(sessionId);
    if (existing) return existing;
    const session = this.createSession(sessionId, detachedAdapter(sessionId));
    this.scheduleViewRelease(session);
    return session;
  }

  /**
   * Hold `session` live for one view until the returned release runs
   * (idempotent).
   *
   * A DETACHED session belongs to its views: once the last one lets go it is
   * disposed after the grace ({@link VIEW_RELEASE_GRACE_MS}), and a view that
   * comes back inside it keeps the session. One with a harness bound is its
   * harness store's to release ({@link releaseHarness}); its views only count.
   * Counts belong to the INSTANCE, so a view of a session since disposed and
   * reopened can never release the new one.
   */
  retainView(session: LiveRuntimeSession): () => void {
    this.viewCounts.set(session, (this.viewCounts.get(session) ?? 0) + 1);
    this.cancelViewRelease(session.sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.viewCounts.get(session) ?? 1) - 1;
      if (remaining > 0) {
        this.viewCounts.set(session, remaining);
        return;
      }
      this.viewCounts.delete(session);
      this.scheduleViewRelease(session);
    };
  }

  /**
   * Dispose `session` after the grace if it is still live, still detached and
   * still unviewed then. The check and the dispose happen in one synchronous
   * step, and `disposeSession` unregisters before anything else, so a view
   * arriving at any point either keeps this instance or opens a fresh one.
   */
  private scheduleViewRelease(session: LiveRuntimeSession): void {
    const { sessionId } = session;
    if (this.live.get(sessionId) !== session || !session.isDetached) return;
    this.cancelViewRelease(sessionId);
    const timer = setTimeout(() => {
      this.viewReleaseTimers.delete(sessionId);
      if (
        this.live.get(sessionId) !== session ||
        !session.isDetached ||
        session.isRunning ||
        this.viewCounts.has(session)
      )
        return;
      console.info(`[sessions] released ${sessionId}: its last view closed`);
      void this.disposeSession(sessionId);
    }, this.viewReleaseGraceMs);
    timer.unref?.();
    this.viewReleaseTimers.set(sessionId, timer);
  }

  private cancelViewRelease(sessionId: string): void {
    const timer = this.viewReleaseTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.viewReleaseTimers.delete(sessionId);
  }

  /**
   * Give a detached session the harness that has just been opened for it. A
   * session that was never detached (or is not live) is left alone, so this is
   * safe to call on every prompt path.
   */
  attachAdapter(sessionId: string, adapter: () => PromptableAdapter): void {
    const session = this.live.get(sessionId);
    if (session?.isDetached) session.rebindAdapter(adapter());
  }

  /**
   * When this session's log ends on an open run bracket — a turn the process died
   * inside. Read at BOOT, before anything is live: while the server is up an
   * unfinished turn is simply a running one.
   */
  interruptedRunAt(sessionId: string): number | undefined {
    return this.logStore.interruptedRunAt(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.live.get(sessionId)?.isRunning ?? false;
  }

  /**
   * Count a prompt from its admission at the prompt door until it settles
   * (the returned release, idempotent). The awaits between the two come BEFORE
   * the run starts, so {@link isRunning} alone would let an idle release cut a
   * harness out from under a prompt already on its way in.
   */
  admitPrompt(sessionId: string): () => void {
    this.admissions.set(sessionId, (this.admissions.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.admissions.get(sessionId) ?? 1) - 1;
      if (remaining > 0) this.admissions.set(sessionId, remaining);
      else this.admissions.delete(sessionId);
    };
  }

  /** A run is live or a prompt is admitted: what an idle release must wait out. */
  isBusy(sessionId: string): boolean {
    return this.isRunning(sessionId) || this.admissions.has(sessionId);
  }

  /** Drive a prompt on a live session. Throws {@link InactiveSessionError} if not live. */
  async prompt(
    sessionId: string,
    text: string,
    options?: RuntimePromptOptions,
  ): Promise<void> {
    const session = this.require(sessionId);
    return session.prompt(text, options);
  }

  abort(sessionId: string): void | Promise<void> {
    return this.live.get(sessionId)?.abort();
  }

  loadTimelineBlock(
    sessionId: string,
    entryId: string,
    blockIndex: number,
    kind: LazyBlockKind,
  ): unknown {
    return this.require(sessionId).loadTimelineBlock(entryId, blockIndex, kind);
  }

  /** The entries before `beforeSeq` for a windowed transcript's "load earlier". */
  loadTimelineRange(
    sessionId: string,
    beforeSeq: number,
    limit?: number,
  ): TimelineRangeResult | undefined {
    return this.require(sessionId).loadTimelineRange(beforeSeq, limit);
  }

  /**
   * Locate a jump target in ANY session's log, live or not: a reader following
   * a peer prompt or a fork origin asks about the session they are about to
   * open, which by definition is not the one running. The log is opened from
   * disk for the lookup and dropped again unless something already held it, so
   * browsing anchors cannot accumulate resident logs ({@link readLog}).
   */
  locateAnchor(
    sessionId: string,
    match: (entry: SessionLogEntry) => boolean,
  ): { entryId: string; index: number; totalEntryCount: number } | undefined {
    if (!this.logStore.has(sessionId)) return undefined;
    return this.readLog(sessionId, (log) => log.locateAnchor(match));
  }

  /**
   * Read a session's log, live or not, without leaving it resident: a log
   * opened from disk for the read is dropped again afterwards, on every exit —
   * but never while a {@link LiveRuntimeSession} owns it, which would otherwise
   * be left writing to an evicted copy. Fork and edit paths read a session the
   * reader may no longer be viewing, whose view grace can end mid-fork.
   */
  private readLog<T>(sessionId: string, read: (log: SessionLog) => T): T {
    try {
      return read(this.logStore.open(sessionId));
    } finally {
      if (!this.live.has(sessionId)) this.logStore.evict(sessionId);
    }
  }

  getConfig(sessionId: string): Promise<SessionConfig> {
    return this.require(sessionId).getConfig();
  }

  /**
   * Translate OUR entry id into the harness anchors (`providerMessageId`) a
   * fork can be cut at. Both sides are returned because the harnesses cut
   * differently, and only the caller knows which one it drives:
   *
   * - `own` — the selected entry's own native id. pi forks "before" a user
   *   message FROM that message (it walks to the parent itself), and either
   *   harness forks "at" an assistant turn from its own id.
   * - `ownTurnEnd` — the native id the selected entry's TURN ends on, for a
   *   harness that spends several native messages on the one entry our log
   *   aggregates (pi's assistant → tool result → … → final assistant): cutting
   *   INCLUSIVELY there is what reproduces the whole turn. Present only when the
   *   binding RESOLVED it, so its absence is meaningful — an entry anchored
   *   before this was recorded says nothing about where its turn ended, and a
   *   caller must fall back rather than assume `own` is the end.
   * - `previous` — the nearest anchored entry ahead of it. The Claude SDK
   *   slices INCLUSIVELY, so cutting before a prompt means cutting at the turn
   *   that precedes it. Absent for the first prompt, which has nothing before.
   *
   * `precedingEntryId` is not an anchor at all: it is simply the conversation
   * entry BEFORE the selected one. Copying our log needs no anchor, so a harness
   * that branches from the selected entry itself (pi walks to its parent) slices
   * our side there — which keeps the copy equal to the provider's cut even
   * across a turn that was never anchored.
   *
   * Reads the log directly rather than the live map: a merely persisted session
   * must be forkable without being brought live first.
   */
  forkAnchors(
    sessionId: string,
    entryId: string,
  ): {
    own?: string;
    ownTurnEnd?: string;
    previous?: string;
    /** OUR id of the entry `previous` anchors, for slicing the app timeline. */
    previousEntryId?: string;
    /** OUR id of the entry immediately before this one, anchored or not. */
    precedingEntryId?: string;
    entryFound: boolean;
  } {
    const entries = this.readLog(sessionId, (log) => log.serverEntries());
    const index = entries.findIndex((entry) => entry.id === entryId);
    if (index < 0) return { entryFound: false };
    const own = entries[index]?.providerMessageId;
    const turnEnd = entries[index]?.providerTurnEndId;
    const preceding = entries[index - 1]?.id;
    const anchors = {
      ...(own ? { own } : {}),
      ...(turnEnd ? { ownTurnEnd: turnEnd } : {}),
      ...(preceding ? { precedingEntryId: preceding } : {}),
    };
    for (let i = index - 1; i >= 0; i--) {
      const previous = entries[i]?.providerMessageId;
      if (!previous) continue;
      return {
        entryFound: true,
        ...anchors,
        previous,
        previousEntryId: entries[i]!.id,
      };
    }
    return { entryFound: true, ...anchors };
  }

  /**
   * Copy `sourceId`'s durable transcript THROUGH `entryId` into a fresh log for
   * `targetId`, and answer the child's client timeline.
   *
   * This is the authoritative half of a fork: the log is what the transport
   * renders and what `forkAnchors` reads, so a child whose log was not seeded
   * would open on an empty transcript while its provider session carries the
   * whole history. Returns undefined when the anchor entry is not in the source
   * log, leaving the target untouched.
   */
  forkLog(
    sourceId: string,
    targetId: string,
    entryId: string,
  ): ClientTimelineEntry[] | undefined {
    // The child's log is written through to disk as it is copied, so it is read
    // back from there when the child is first opened.
    return this.readLog(sourceId, (source) => {
      const cut = this.turnEndEntryId(source, entryId);
      if (!cut) return undefined;
      return this.readLog(targetId, (target) =>
        source.copyPrefixTo(target, cut) ? target.clientTimeline() : undefined,
      );
    });
  }

  /**
   * OUR id of the entry a fork anchored at `entryId` would copy THROUGH — see
   * {@link turnEndEntryId}. Resolved WITHOUT creating anything, so a caller
   * whose provider-side cut is irreversible can refuse a bad entry id before a
   * native transcript exists that nothing would reference, and a harness whose
   * transcript orders tool results the way ours does can branch at this entry
   * rather than at the assistant row (`connection.ts`, pi).
   */
  forkCutEntryId(sessionId: string, entryId: string): string | undefined {
    return this.readLog(sessionId, (log) => this.turnEndEntryId(log, entryId));
  }

  /** Whether {@link forkCutEntryId} resolves — the pre-flight for an irreversible cut. */
  canForkLogAt(sessionId: string, entryId: string): boolean {
    return Boolean(this.forkCutEntryId(sessionId, entryId));
  }

  /**
   * The app-log cut for a fork anchored at `entryId`: that entry plus the tool
   * results BELONGING to it.
   *
   * An anchored assistant entry is not the end of its own turn in our log —
   * tool results are appended AFTER the row that declared the calls (the
   * adapter flushes them on completion), while the provider's transcript
   * carries those exchanges BEFORE the message the anchor names. Cutting at the
   * assistant row would keep the tool calls and drop their outputs.
   *
   * The extension is scoped by OWNERSHIP, not by "everything until the next
   * prompt": rows after the turn can be app-only (a `/commit` card, a provider
   * notice) with no counterpart in the provider transcript, and a synthetic
   * host-command turn has no user row to stop at — so a boundary walk would
   * copy cards the native cut excluded, and the child would render history the
   * model has never seen. `undefined` when the entry is not in this log.
   */
  private turnEndEntryId(log: SessionLog, entryId: string): string | undefined {
    const entries = log.rawEntries();
    const start = entries.findIndex((entry) => entry.id === entryId);
    if (start < 0) return undefined;
    const anchor = entries[start]!;
    if (anchor.type !== "message" || anchor.role !== "assistant")
      return anchor.id;
    const owned = new Set(
      anchor.content
        .filter((block) => block.type === "toolCall")
        .map((block) => block.toolCallId),
    );
    if (owned.size === 0) return anchor.id;
    let end = start;
    for (let i = start + 1; i < entries.length; i++) {
      const entry = entries[i]!;
      // A prompt starts the next turn and always ends the search. Anything else
      // is stepped OVER rather than stopped at: only an owned result advances
      // the cut, so a stray row (a provider notice, a bookkeeping row) cannot
      // truncate the turn and leave the child rendering calls with no output.
      // The tradeoff is contiguity — `copyPrefixTo` copies through the end
      // index, so a row sitting BETWEEN the turn and one of its own results
      // rides along. Copying one extra card beats dropping a tool result.
      if (entry.type === "message" && entry.role === "user") break;
      if (
        entry.type === "message" &&
        entry.role === "toolResult" &&
        owned.has(entry.toolCallId)
      )
        end = i;
    }
    return entries[end]!.id;
  }

  /** The plain text of one entry, used to prefill an edit-and-retry composer. */
  entryText(sessionId: string, entryId: string): string | undefined {
    const entry = this.readLog(sessionId, (log) =>
      log.serverEntries().find((candidate) => candidate.id === entryId),
    );
    const text = (entry?.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    return text || undefined;
  }

  /**
   * Preferred race-safe entry point: SUBSCRIBE first, THEN capture the snapshot,
   * so no event can fire in the gap between the two. Returns the snapshot + an
   * unsubscribe fn. (The lower-level `session.subscribe` + `getSnapshot` are
   * correct only in that order.)
   */
  openSessionStream(
    sessionId: string,
    listener: RuntimeEventListener,
  ): SessionStream {
    const session = this.require(sessionId);
    const unsubscribe = session.subscribe(listener);
    const snapshot = session.getSnapshot();
    return { snapshot, unsubscribe };
  }

  /** Subscribe to all live runtime events, tagged with their session id. */
  subscribeEvents(listener: RuntimeSessionEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * The harness behind this session was released for being idle (pi and Claude
   * idle eviction). Its runtime session goes with it, unless no harness was ever
   * bound to it: a DETACHED session is a reader's view of the log and belongs to
   * its views ({@link retainView}). Deleting a session is {@link disposeSession}.
   *
   */
  releaseHarness(sessionId: string): Promise<void> {
    const session = this.live.get(sessionId);
    if (!session || session.isDetached) return Promise.resolve();
    console.info(`[sessions] released ${sessionId}: its harness went idle`);
    return this.disposeSession(sessionId);
  }

  /** Dispose a session's live runtime (unsubscribe + release the adapter). The log is untouched. */
  async disposeSession(sessionId: string): Promise<void> {
    const session = this.live.get(sessionId);
    if (!session) return;
    this.live.delete(sessionId);
    this.cancelViewRelease(sessionId);
    this.viewCounts.delete(session);
    this.eventUnsubscribers.get(sessionId)?.();
    this.eventUnsubscribers.delete(sessionId);
    this.logStore.evict(sessionId);
    await session.dispose();
  }

  /** Dispose everything (process shutdown / test cleanup). */
  async dispose(): Promise<void> {
    const ids = [...this.live.keys()];
    for (const id of ids) await this.disposeSession(id);
  }

  private emitSessionEvent(sessionId: string, event: RuntimeEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(sessionId, event);
      } catch {
        // isolate app-level observers from the runtime core
      }
    }
  }

  private require(sessionId: string): LiveRuntimeSession {
    const session = this.live.get(sessionId);
    if (!session) throw new InactiveSessionError(sessionId);
    return session;
  }
}
