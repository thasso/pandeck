/**
 * Persistence + registry for in-process Claude-SDK sessions.
 *
 * Claude-SDK sessions own the conversation and persist their record under
 * `DATA_DIR/claude-sdk/` — small metadata plus an append-only timeline log, in
 * the format `claudeSdkRecords.ts` owns — which is rehydrated on acquire. A
 * persist writes only the entries the log does not hold yet. Deleted ids are
 * tombstoned so a late event can't resurrect a removed session.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type AgentType,
  DEFAULT_SESSION_SCOPE,
  type BrowserRuntimeInfo,
  type SessionForkOrigin,
  type SessionScope,
} from "@assistant/shared";
import { CWD, DATA_DIR } from "../config.ts";
import { ClaudeSdkSession } from "./ClaudeSdkSession.ts";
import { buildRealClaudeSdkSeam, type ClaudeSdkSeam } from "./sdkSeam.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { worktreeCwdForSession } from "../worktrees/sessionCwd.ts";
import { claudeProfileSessionStore } from "./profileSessionStore.ts";
import { defaultClaudeProfileId } from "../credentialProfiles.ts";
import { sessionSkills } from "../sessionSkills.ts";
import {
  claudeSdkEntryFigures,
  claudeSdkRecordPresent,
  ClaudeSdkRecordReadError,
  readClaudeSdkRecord,
  readClaudeSdkRecordMeta,
  removeClaudeSdkRecord,
  writeClaudeSdkRecord,
  ClaudeSdkRecordWriteError,
  type ClaudeSdkEntryFigures,
  type ClaudeSdkLogCursor,
  type ClaudeSdkRecordMeta,
} from "./claudeSdkRecords.ts";

const STORE_DIR = join(DATA_DIR, "claude-sdk");

class ClaudeSdkSessionStore {
  private sessions = new Map<string, ClaudeSdkSession>();
  private deleted = new Set<string>();
  /** Where each live session's next persist continues its timeline log. */
  private logs = new Map<string, ClaudeSdkLogCursor>();
  /** Lazily-built real seam, shared by every live session. */
  private seamPromise: Promise<ClaudeSdkSeam> | undefined;
  private onChange: () => void = () => {};
  private browserRuntimesFor: (sessionId: string) => BrowserRuntimeInfo[] =
    () => [];

  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

  setBrowserRuntimesProvider(
    cb: (sessionId: string) => BrowserRuntimeInfo[],
  ): void {
    this.browserRuntimesFor = cb;
    for (const session of this.sessions.values())
      session.browserRuntimesFor = cb;
  }

  /** Inject a fake seam (tests only); defaults to the real installed SDK. */
  setSeam(factory: () => Promise<ClaudeSdkSeam>): void {
    this.seamPromise = factory();
  }

  private seam(): Promise<ClaudeSdkSeam> {
    if (!this.seamPromise) this.seamPromise = buildRealClaudeSdkSeam();
    return this.seamPromise;
  }

  get(id: string): ClaudeSdkSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * The live session for a caller about to DRIVE it, with its idle clock
   * restarted so it is not released between this answer and the prompt. `get`
   * is for readers, and restarts nothing: a broadcast is not activity.
   */
  getForDrive(id: string): ClaudeSdkSession | undefined {
    const session = this.sessions.get(id);
    session?.armIdleIfUnviewed();
    return session;
  }

  /**
   * True when an id is a live or persisted Claude-SDK session. It reads
   * nothing and never throws: a record that is present but unreadable counts,
   * so routing sends the id here and ACQUIRING it fails with the read error
   * ({@link unreadableRecord}) — never starting a fresh session over it, and
   * never breaking a caller that only asked where the id belongs.
   */
  exists(id: string): boolean {
    if (this.sessions.has(id)) return true;
    if (this.deleted.has(id)) return false;
    return claudeSdkRecordPresent(STORE_DIR, id);
  }

  /**
   * Why a present, non-live record cannot be read, for a caller that has to
   * tell the reader; undefined when it can be (or there is none). Reads the
   * WHOLE record, timeline included — metadata can be sound while its log is
   * not — so it belongs on an exceptional path only, never a view or list.
   */
  unreadableRecord(id: string): string | undefined {
    if (this.sessions.has(id) || this.deleted.has(id)) return undefined;
    try {
      readClaudeSdkRecord(STORE_DIR, id);
      return undefined;
    } catch (err) {
      if (err instanceof ClaudeSdkRecordReadError) return err.message;
      throw err;
    }
  }

  list(): ClaudeSdkSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Get or create a live session for `id`, rehydrating a persisted record if one
   * exists on disk. The hub calls this when a connection loads/creates a session.
   */
  acquire(
    id: string,
    opts: {
      createdAt?: number;
      modelId?: string;
      thinkingLevel?: string;
      mode?: string;
      agentType?: AgentType;
      cwd?: string;
      additionalSystemPrompt?: string;
      credentialProfileId?: string;
      /**
       * Whose session this is, declared by the CREATING caller: it is persisted
       * before the session enters the live map, because the session list treats
       * a live session with no row as the user's.
       */
      scope?: SessionScope;
    } = {},
  ): ClaudeSdkSession {
    const existing = this.getForDrive(id);
    if (existing) return existing;
    const loaded = this.deleted.has(id)
      ? undefined
      : readClaudeSdkRecord(STORE_DIR, id);
    const record = loaded?.record;
    const modelIdValue = record?.modelId ?? opts.modelId;
    const thinkingLevelValue = record?.thinkingLevel ?? opts.thinkingLevel;
    const modeValue = record?.mode ?? opts.mode;
    const agentTypeValue = record?.agentType ?? opts.agentType;
    const additionalSystemPromptValue =
      record?.additionalSystemPrompt ?? opts.additionalSystemPrompt;
    const cwdValue = worktreeCwdForSession(id) ?? record?.cwd ?? opts.cwd;
    const session = new ClaudeSdkSession(id, {
      seam: () => this.seam(),
      createdAt: record?.createdAt ?? opts.createdAt ?? Date.now(),
      // Restore last activity too: without it every restart back-dates the
      // session to its creation time until the next mutation.
      ...(record?.updatedAt !== undefined
        ? { updatedAt: record?.updatedAt }
        : {}),
      ...(record?.title !== undefined ? { title: record?.title } : {}),
      ...(record?.providerSessionId !== undefined
        ? { providerSessionId: record?.providerSessionId }
        : {}),
      ...(record?.entries !== undefined ? { entries: record?.entries } : {}),
      ...(record?.forkOrigin !== undefined
        ? { forkOrigin: record?.forkOrigin }
        : {}),
      ...(record?.forkAutoRenamePending !== undefined
        ? { forkAutoRenamePending: record?.forkAutoRenamePending }
        : {}),
      ...(modelIdValue !== undefined ? { modelId: modelIdValue } : {}),
      ...(thinkingLevelValue !== undefined
        ? { thinkingLevel: thinkingLevelValue }
        : {}),
      // The persisted mode WINS over whatever the client asked to start in: a
      // reopened session resumes the mode it was left in, and a stale client
      // cannot silently re-enable file writes on a session put into Plan.
      ...(modeValue !== undefined ? { mode: modeValue } : {}),
      ...(agentTypeValue !== undefined ? { agentType: agentTypeValue } : {}),
      ...(additionalSystemPromptValue !== undefined
        ? { additionalSystemPrompt: additionalSystemPromptValue }
        : {}),
      // The in_worktree edge is the durable cwd source of truth; the persisted
      // record cwd and the caller's cwd are fallbacks (e.g. pre-link creation).
      ...(cwdValue !== undefined ? { cwd: cwdValue } : {}),
      credentialProfileId:
        record?.credentialProfileId ??
        opts.credentialProfileId ??
        defaultClaudeProfileId(),
      ...(record?.usage !== undefined ? { usage: record?.usage } : {}),
    });
    session.onChange = () => this.onChange();
    session.onPersist = () => this.persist(session);
    session.holdBy(() => this.evictIdle(session));
    session.browserRuntimesFor = (sessionId) =>
      this.browserRuntimesFor(sessionId);
    if (loaded) this.logs.set(id, loaded.cursor);
    else this.logs.delete(id);
    // Scope BEFORE the live map: an id the session list can already see must
    // already be classified, and a claim contradicting the stored scope throws
    // instead of registering the session.
    sessionStore.claimScope({
      id,
      harness: "claude-sdk",
      agentType: record?.agentType ?? opts.agentType ?? "workshop",
      ...(opts.scope ? { scope: opts.scope } : {}),
    });
    // Registry sync: record the session's metadata on create (providerSessionId
    // is not known until the first turn ends; persist() fills it in then).
    this.syncRegistry(session);
    this.sessions.set(id, session);
    // Ownership from the first moment: an acquisition nobody views and nothing
    // drives (a rename, a superseded load) idles out like any other.
    session.armIdleIfUnviewed();
    this.onChange();
    return session;
  }

  /**
   * Branch a session at `anchor` (a native transcript uuid) into a new one.
   *
   * Three things are cut to the SAME point, in this order: the native
   * transcript (by the SDK, which copies it under fresh uuids and leaves the
   * source untouched), the app-owned runtime log, and the session record. The
   * runtime log is authoritative — it is what the transport renders and what
   * later fork anchors are read from — so the record's entries are DERIVED from
   * the forked log rather than sliced separately, which is also why
   * `keepThroughEntryId` is a runtime log entry id (the only id a client holds).
   *
   * For an edit-and-retry fork the caller passes the entry BEFORE the edited
   * prompt, so that prompt is dropped from every copy and can be re-sent.
   *
   * The child inherits the parent's execution context: effective cwd, model,
   * thinking level, mode, persona, credential profile and system-prompt suffix.
   */
  async forkSession(
    sourceId: string,
    opts: {
      anchor: string;
      keepThroughEntryId: string;
      forkOrigin: SessionForkOrigin;
    },
  ): Promise<ClaudeSdkSession> {
    const source = this.sessions.get(sourceId);
    if (source?.isRunning)
      throw new Error("Cannot fork a session while it is streaming.");
    const record = this.deleted.has(sourceId)
      ? undefined
      : (source?.toRecordMeta() ??
        readClaudeSdkRecordMeta(STORE_DIR, sourceId)?.meta);
    if (!record) throw new Error("Cannot fork: session is not available.");
    if (!record.providerSessionId)
      throw new Error("Cannot fork: this session has never run.");

    const agentType = record.agentType ?? "workshop";
    // A legacy parent freezes at this first post-upgrade runtime start. The
    // child receives that exact list even if settings move while it is created.
    const inheritedSkills = await sessionSkills(sourceId, agentType);

    const seam = await this.seam();
    if (!seam.forkSession)
      throw new Error(
        "Cannot fork: the Claude SDK build cannot branch sessions.",
      );
    // The project dir keys the native transcript's location, so resolve the
    // session's EFFECTIVE cwd exactly as `acquire` does — the worktree EDGE
    // first, because a session linked or handed off after creation carries a
    // stale cwd both in its record and on its live instance.
    const cwd =
      worktreeCwdForSession(sourceId) ?? source?.cwd ?? record.cwd ?? CWD;
    const store = claudeProfileSessionStore(record.credentialProfileId);
    // Validate OUR side of the cut before the provider's, because the provider's
    // is not undoable: a native fork that no session ends up referencing is an
    // orphan transcript, and PA pinned retention to a decade, so nothing would
    // ever sweep it.
    if (!sessionRuntime.canForkLogAt(sourceId, opts.keepThroughEntryId))
      throw new Error("Cannot fork: selected message is no longer available.");
    // Then cut the native transcript FIRST of the two creations: if the provider
    // cannot cut it (an expired or deleted `.jsonl`), no session exists yet and
    // the error reaches the user instead of leaving a child bound to nothing.
    const forked = await seam.forkSession(record.providerSessionId, {
      upToMessageId: opts.anchor,
      dir: cwd,
      // Bind the cut to the session's OWN credential profile: a named profile
      // keeps its transcripts under its private CLAUDE_CONFIG_DIR, which this
      // in-process call would otherwise never look in (`dir` only selects the
      // project key inside a root).
      sessionStore: store,
    });

    const id = randomUUID();
    try {
      // Seed the child's durable log from the parent's, or it would open on an
      // empty transcript while its provider session holds the whole history. The
      // inherited prefix arrives UNANCHORED: the cut above remapped every uuid,
      // so the parent's bindings name nothing in the child's transcript. The
      // child re-anchors through its own turns, and offers no fork point in the
      // inherited part until then.
      const entries = sessionRuntime.forkLog(
        sourceId,
        id,
        opts.keepThroughEntryId,
      );
      if (!entries)
        throw new Error(
          "Cannot fork: selected message is no longer available.",
        );
      await sessionSkills(id, agentType, inheritedSkills);

      const session = new ClaudeSdkSession(id, {
        seam: () => this.seam(),
        // Keep the parent's title so the fork is recognizable in the list, but
        // leave auto-naming ARMED: a title alone would mark the child as already
        // named, leaving two identically-titled rows forever — and a parent still
        // on the default title would strand the child there.
        title: record.title,
        forkAutoRenamePending: true,
        providerSessionId: forked.sessionId,
        entries,
        forkOrigin: opts.forkOrigin,
        ...(record.modelId !== undefined ? { modelId: record.modelId } : {}),
        ...(record.thinkingLevel !== undefined
          ? { thinkingLevel: record.thinkingLevel }
          : {}),
        ...(record.mode !== undefined ? { mode: record.mode } : {}),
        ...(record.agentType !== undefined
          ? { agentType: record.agentType }
          : {}),
        ...(record.additionalSystemPrompt !== undefined
          ? { additionalSystemPrompt: record.additionalSystemPrompt }
          : {}),
        cwd,
        ...(record.credentialProfileId !== undefined
          ? { credentialProfileId: record.credentialProfileId }
          : {}),
      });
      session.onChange = () => this.onChange();
      session.onPersist = () => this.persist(session);
      session.holdBy(() => this.evictIdle(session));
      session.browserRuntimesFor = (sessionId) =>
        this.browserRuntimesFor(sessionId);
      // A fork INHERITS its parent's scope, and claims it before the live map
      // can hand the child to the session list: forking is not a way for a
      // session outside the user's scope to produce one inside it.
      sessionStore.claimScope({
        id,
        harness: "claude-sdk",
        agentType: record.agentType ?? "workshop",
        scope: sessionStore.get(sourceId)?.scope ?? DEFAULT_SESSION_SCOPE,
      });
      this.sessions.set(id, session);
      this.persist(session);
      session.armIdleIfUnviewed();
      this.onChange();
      return session;
    } catch (err) {
      // Nothing references the child now, so unwind BOTH sides of the failed
      // creation: drop the half-registered session before reclaiming its native
      // transcript, or the store would keep serving a session whose transcript
      // is gone. The original failure is what the user should see.
      this.sessions.delete(id);
      this.logs.delete(id);
      try {
        await seam.deleteSession?.(forked.sessionId, {
          dir: cwd,
          sessionStore: store,
        });
      } catch {
        // Best-effort compensation.
      }
      throw err;
    }
  }

  /**
   * Persist a session's current record: its metadata whole, and only the
   * timeline entries its log does not hold yet. A session the store no longer
   * holds (removed, or replaced by a later acquire) writes nothing, or a late
   * persist would put a deleted record back on disk. Answers whether the
   * record on disk now holds the whole session.
   */
  persist(session: ClaudeSdkSession): boolean {
    if (this.sessions.get(session.id) !== session) return false;
    const cursor = this.logs.get(session.id);
    let written = false;
    try {
      this.logs.set(
        session.id,
        writeClaudeSdkRecord(
          STORE_DIR,
          session.toRecordMeta(),
          session.committedTimeline(),
          cursor,
        ),
      );
      written = true;
    } catch (err) {
      // Best-effort; losing the record only drops history across a restart.
      // The error says where the next write must start: re-checking the tail
      // after a failed append, rewriting after a failed rewrite, and unchanged
      // after a refusal to overwrite a log someone else wrote, which is loud.
      if (err instanceof ClaudeSdkRecordWriteError) {
        if (err.next) this.logs.set(session.id, err.next);
        else this.logs.delete(session.id);
        console.error(`[claude-sdk] ${err.message}`);
      } else this.logs.set(session.id, { kind: "rewrite" });
    }
    // Registry sync: keep the metadata row in step with each persisted record
    // (turn end / title change), so native.id (providerSessionId), model, and
    // title are captured once known.
    this.syncRegistry(session);
    return written;
  }

  /**
   * Release an idle session from memory: its idle clock ran out with nobody
   * viewing it and nothing in flight. It has to come back exactly as it left,
   * so it goes only once its record on disk holds everything it does — a final
   * persist, and a session whose write failed stays resident rather than lose
   * what only memory has. Its runtime session goes with it; the next acquire
   * rehydrates both from disk. Answers whether it went.
   */
  private evictIdle(session: ClaudeSdkSession): boolean {
    if (this.sessions.get(session.id) !== session) return false;
    if (!session.isQuiescent || sessionRuntime.isBusy(session.id)) return false;
    if (!this.persist(session)) return false;
    this.sessions.delete(session.id);
    this.logs.delete(session.id);
    session.dispose();
    void sessionRuntime.releaseHarness(session.id);
    return true;
  }

  /**
   * Write/refresh the session-metadata row for a Claude-SDK session. Our id is
   * the handle; the provider session id (for SDK resume) is learned on the first
   * turn end. Best-effort — never break persistence on a metadata-store hiccup.
   */
  private syncRegistry(session: ClaudeSdkSession): void {
    // The log's own figures when it holds the whole timeline (after every
    // successful persist); counted afresh only when it does not.
    const cursor = this.logs.get(session.id);
    const committed = session.committedTimeline();
    this.syncRegistryRecord(
      session.toRecordMeta(),
      cursor?.kind === "append" && cursor.log.count === committed.length
        ? cursor.log
        : claudeSdkEntryFigures(committed),
    );
  }

  private syncRegistryRecord(
    record: ClaudeSdkRecordMeta,
    figures: ClaudeSdkEntryFigures,
  ): void {
    try {
      const harness = "claude-sdk";
      const agentType = record.agentType ?? "workshop";
      const messageCount = figures.messages;
      const assistantTurns = figures.assistantTurns;
      // Runs that actually reported usage — what the accumulated totals cover.
      const usageTurns = figures.usageTurns;
      const existing = sessionStore.get(record.id);
      const metadataUnchanged =
        existing?.harness === harness &&
        existing.agentType === agentType &&
        existing.provider === "claude" &&
        existing.model === record.modelId &&
        existing.thinkingLevel === record.thinkingLevel &&
        existing.title === record.title &&
        existing.createdAt === record.createdAt &&
        existing.updatedAt === record.updatedAt &&
        existing.messageCount === messageCount &&
        existing.providerSessionId === record.providerSessionId &&
        existing.credentialProfileId === record.credentialProfileId;
      // The metadata guard must not gate the usage mirror: usage can move while
      // every compared metadata field stays identical (e.g. a helper-model run
      // that adds no timeline entry), and skipping the write there leaves a
      // stale totals row behind. The upsert below is also what creates the
      // `session_index` row the usage table keys off, so it stays first.
      if (!metadataUnchanged) {
        sessionStore.upsert({
          id: record.id,
          harness,
          agentType,
          title: record.title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          messageCount,
          provider: "claude",
          ...(record.providerSessionId !== undefined
            ? { providerSessionId: record.providerSessionId }
            : {}),
          ...(record.modelId !== undefined ? { model: record.modelId } : {}),
          ...(record.thinkingLevel !== undefined
            ? { thinkingLevel: record.thinkingLevel }
            : {}),
          ...(record.credentialProfileId !== undefined
            ? { credentialProfileId: record.credentialProfileId }
            : {}),
          ...(record.forkOrigin ? { forkOrigin: record.forkOrigin } : {}),
        });
      }
      if (record.usage) {
        sessionStore.replaceUsage(record.id, {
          inputTokens: record.usage.input,
          outputTokens: record.usage.output,
          cacheReadTokens: record.usage.cacheRead,
          cacheWriteTokens: record.usage.cacheWrite,
          reasoningTokens: 0,
          totalTokens:
            record.usage.input +
            record.usage.output +
            record.usage.cacheRead +
            record.usage.cacheWrite,
          costMicros: Math.round(record.usage.cost * 1_000_000),
          currency: "USD",
          usageTurns,
          assistantTurns,
          ...(record.usage.contextTokens !== undefined
            ? { contextTokens: record.usage.contextTokens }
            : {}),
          ...(record.usage.contextWindow !== undefined
            ? { contextWindow: record.usage.contextWindow }
            : {}),
          usageSource: "provider_reported",
          updatedAt: record.updatedAt,
        });
      }
    } catch {
      // Best-effort metadata sync.
    }
  }

  /** Remove a session for good (tombstone + delete its record). */
  remove(id: string): void {
    this.deleted.add(id);
    sessionStore.remove(id); // tombstone the SDK session's metadata row
    const session = this.sessions.get(id);
    const record = session?.toRecordMeta() ?? this.metaForRemoval(id);
    session?.dispose();
    // Dispose any runtime-backed session bound to it.
    void sessionRuntime.disposeSession(id);
    this.sessions.delete(id);
    this.logs.delete(id);
    try {
      removeClaudeSdkRecord(STORE_DIR, id);
    } catch {
      // ignore
    }
    void this.removeNativeTranscript(id, record);
    this.onChange();
  }

  /**
   * The metadata a removal needs to find the native transcript. A record that
   * cannot be read is still deleted — that is what the user asked for — and
   * only its native transcript stays behind.
   */
  private metaForRemoval(id: string): ClaudeSdkRecordMeta | undefined {
    try {
      return readClaudeSdkRecordMeta(STORE_DIR, id)?.meta;
    } catch (err) {
      console.error(
        `[claude-sdk] removing unreadable record ${id}: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  /**
   * Delete the session's native transcript alongside our record.
   *
   * PA pins `cleanupPeriodDays` far into the future so a fork always has a
   * transcript to cut from, which means the CLI's own sweep no longer collects
   * anything: without this, deleting a session would leave its transcript on
   * disk for a decade. Retention being PA-owned is exactly what makes PA
   * responsible for the removal.
   *
   * Best-effort and asynchronous, matching the rest of `remove`: losing a native
   * transcript we no longer reference must never fail the user's delete.
   */
  private async removeNativeTranscript(
    id: string,
    record: ClaudeSdkRecordMeta | undefined,
  ): Promise<void> {
    if (!record?.providerSessionId) return;
    try {
      const seam = await this.seam();
      if (!seam.deleteSession) return;
      await seam.deleteSession(record.providerSessionId, {
        dir: worktreeCwdForSession(id) ?? record.cwd ?? CWD,
        sessionStore: claudeProfileSessionStore(record.credentialProfileId),
      });
    } catch {
      // Best-effort: the record and metadata row are already gone.
    }
  }
}

export const claudeSdkStore = new ClaudeSdkSessionStore();
