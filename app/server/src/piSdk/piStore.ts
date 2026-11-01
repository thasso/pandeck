/**
 * Registry + lifecycle for live pi sessions, mirroring
 * `claudeSdk/claudeSdkStore.ts`: a singleton store the hub delegates to. Owns
 * the live-session map, session creation/reopen/fork, eviction, and the pi
 * halves of id-only lookup, rename, image resolution, and session listing.
 * The hub's behaviour arrives as the {@link HarnessHost} via
 * {@link PiSessionStore.setHost} (`harnesses/registry.ts`); this module must
 * never import hub.ts.
 */
import {
  AGENT_TYPE_IDS,
  sessionModeOrDefault,
  type AgentType,
  type SessionMode,
  type SessionScope,
  type ThinkingLevel,
} from "@assistant/shared";
import { existsSync } from "node:fs";
import { CWD } from "../config.ts";
import {
  planModeToolUnavailableMessage,
  type ToolSession,
} from "../mcp/tool.ts";
import { AGENT_TYPES } from "../agentTypes.ts";
import { piAppToolBinding } from "./agentToolAdapter.ts";
import { isPlanModeToolAllowed } from "../tools/toolPolicy.ts";
import type { LiveListInfo } from "../sessions.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";
import {
  canonicalPiSessionPath,
  migrateFileToCanonical,
} from "../sessionStorage.ts";
import {
  findLegacySessionFile,
  openExistingSession,
  readSessionHeaderId,
  sessionIdFromFile,
} from "./sessionOpen.ts";
import {
  withCheckedCheckout,
  worktreeCwdForSession,
} from "../worktrees/sessionCwd.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { sourceRequiresEnterprise } from "../sessionEnterprise.ts";
import {
  sessionAgent,
  withoutDeniedTools,
  type SessionAgent,
} from "../agents/sessionAgent.ts";
import {
  parsePromptConditions,
  type SessionPromptEvidence,
} from "../promptConditions.ts";
import { PiLiveSession } from "./PiLiveSession.ts";
import type { PiEngineHandle, PiEngineModel } from "./piEngine.ts";
import type { PiEngineOpened, PiEngineOpenSpec } from "./piEngineHost.ts";
import { piHostedEngineFactory } from "./piEngineHosted.ts";
import { openRemotePiEngine } from "./remotePiEngine.ts";
import { SessionHeldElsewhereError, type HarnessHost } from "../harness.ts";
import {
  credentialProfileById,
  DEFAULT_OPENAI_PROFILE_ID,
} from "../credentialProfiles.ts";
import { sessionSkills } from "../sessionSkills.ts";
import { closeToolGroupSession } from "../mcp/toolGroups/registry.ts";
import { registerAppToolSession } from "../workers/appToolHost.ts";
import { registerInProcessEngineFactory } from "../workers/inProcessWorker.ts";

/** Every persona a legacy per-persona transcript directory can hold. */
const LEGACY_KINDS: readonly AgentType[] = AGENT_TYPE_IDS;

/**
 * A cold open lost to a delete: the session was tombstoned while its
 * transcript was opening, so nothing was registered and every acquisition
 * sharing that open is refused (`acquireExisting`).
 */
export class PiSessionDeletedError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} was deleted while it was opening.`);
    this.name = "PiSessionDeletedError";
  }
}

const ENTERPRISE_REQUIRED =
  "This session requires an enterprise account. Select an account marked as enterprise.";

/**
 * The {@link ToolSession} the server's app tools see for a pi session: read
 * fresh per call from its engine handle, whose transcript append is a command.
 */
function piToolSessionFromHandle(
  kind: AgentType,
  engine: PiEngineHandle,
  cwd: string,
): ToolSession {
  const sessionFile = engine.sessionFile;
  const title = engine.sessionName;
  return {
    sessionId: engine.sessionId,
    harness: "pi",
    agentType: kind,
    cwd,
    ...(sessionFile !== undefined ? { sessionFile } : {}),
    ...(title !== undefined ? { title } : {}),
    sessionManager: engine.toolSessionManager(),
  };
}

/**
 * Process-global registry of live pi sessions. Owns agent runs independent of
 * any socket; the hub delegates every pi-session concern here.
 */
class PiSessionStore {
  private live = new Map<string, PiLiveSession>();
  /**
   * Reopens in flight, by canonical file: two concurrent acquisitions of one
   * session (a rapid A→B→A, two tabs) must share ONE open. Without this both
   * pass the live-map check, both open, and the second `track` overwrites the
   * first wrapper in the map — leaving it registered nowhere, its session and
   * subscriptions alive, unreachable to eviction.
   */
  private readonly opening = new Map<string, Promise<PiLiveSession>>();
  /** Each committed engine's app-tool binding disposer, by session id. */
  private appToolBindings = new Map<string, () => void>();
  /** Live Build/Plan policy, read by the routed app tools' gate. */
  private sessionModes = new Map<string, SessionMode>();
  /**
   * Opens a live engine on the session's Worker (the in-process one in phase
   * 1); the seam suites replace.
   */
  private openEngine: (spec: PiEngineOpenSpec) => Promise<PiEngineOpened> = (
    spec,
  ) => openRemotePiEngine(spec, (engine) => this.onEngineLost(engine));
  private host: HarnessHost | undefined;
  /** Whether another engine holds an id resident; registration refuses it. */
  private heldElsewhere: (id: string) => boolean = () => false;

  /**
   * Wire the hub-side callbacks every {@link PiLiveSession} needs. The harness
   * registry calls this once, when the hub hands it its host
   * (`harnessRegistry.setHost`), so the host inverts the session→hub calls and
   * this module never imports hub.ts.
   */
  setHost(host: HarnessHost): void {
    this.host = host;
  }

  /** How to tell an id another engine holds resident (`harnessRegistry`). */
  setHeldElsewhere(check: (id: string) => boolean): void {
    this.heldElsewhere = check;
  }

  /**
   * Whether a transcript for our id is on disk: the canonical file, or a
   * legacy per-persona one a continuation could still reopen.
   */
  hasTranscript(id: string): boolean {
    if (existsSync(canonicalPiSessionPath(id))) return true;
    return LEGACY_KINDS.some(
      (kind) => findLegacySessionFile(kind, id) !== undefined,
    );
  }

  private requireHost(): HarnessHost {
    if (!this.host)
      throw new Error(
        "PiSessionStore host is not wired; the hub must call setHost() first.",
      );
    return this.host;
  }

  get(key: string): PiLiveSession | undefined {
    return this.live.get(key);
  }

  list(): PiLiveSession[] {
    return [...this.live.values()];
  }

  /** Pi rows for the merged session list, with runtime running state folded in. */
  listInfo(): LiveListInfo[] {
    return [...this.live.values()].map((ls) => {
      const info = ls.listInfo();
      return {
        ...info,
        isStreaming: sessionRuntime.isRunning(ls.id) || info.isStreaming,
      };
    });
  }

  /** A fresh session for `kind`, carrying over the caller's model/thinking level. */
  async acquireNew(
    kind: AgentType,
    model?: PiEngineModel,
    thinkingLevel?: ThinkingLevel,
    opts?: {
      cwd?: string;
      credentialProfileId?: string;
      /**
       * What this session starts with (attachments, Project), for the frozen
       * prompt conditions. pi mints the session id here, so the creating caller
       * cannot stage it by id — it rides the creation call instead.
       */
      promptEvidence?: SessionPromptEvidence;
      /** The agent definition a spawn starts it as; frozen inside creation. */
      agent?: SessionAgent;
      mode?: SessionMode;
      requiresEnterprise?: boolean;
      /**
       * Whose session this is. It is persisted before the live registry can
       * observe the session (`track`), so a caller creating anything other than
       * the user's own conversation must declare it HERE rather than upserting
       * the scope afterwards.
       */
      scope?: SessionScope;
    },
  ): Promise<PiLiveSession> {
    const cwd = opts?.cwd ?? CWD;
    const credentialProfileId =
      opts?.credentialProfileId ?? DEFAULT_OPENAI_PROFILE_ID;
    // A freshly minted id has no record, so the requested mode is the mode.
    const mode = sessionModeOrDefault(opts?.mode);
    const opened = await this.openEngine({
      kind,
      credentialProfileId,
      transcript: { type: "new", cwd },
      ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(opts?.promptEvidence || opts?.agent
        ? {
            promptStart: {
              ...(opts.promptEvidence ? { evidence: opts.promptEvidence } : {}),
              ...(opts.agent ? { agent: opts.agent } : {}),
            },
          }
        : {}),
      mode,
      canonicalize: true,
    });
    const id = opened.info.sessionId;
    if (
      opts?.requiresEnterprise &&
      !credentialProfileById(credentialProfileId)?.enterprise
    ) {
      closeToolGroupSession(id);
      await opened.engine.discard({ removeFile: {} });
      sessionStore.deleteSkills(id);
      throw new Error(ENTERPRISE_REQUIRED);
    }
    this.sessionModes.set(id, mode);
    return this.track(
      kind,
      opened,
      credentialProfileId,
      opts?.scope,
      opts?.requiresEnterprise,
    );
  }

  /**
   * The live session for `file`, reusing one already running if present.
   *
   * When `expectedId` is provided, a live session with a mismatched id is
   * skipped (not reused) so the disk guard below can validate/throw, letting
   * callers fall back to a fresh session instead of prompting the wrong one.
   */
  async acquireExisting(
    kind: AgentType,
    file: string,
    expectedId?: string,
  ): Promise<PiLiveSession> {
    // Some callers still carry a legacy `sessions/{chat,workshop}/...jsonl`
    // handle in persisted task/continuation refs. Resolve that id-only handle to
    // the canonical per-session native path before reuse/open so reload
    // continuations survive after the legacy file has been folded away.
    const candidateId =
      expectedId ?? readSessionHeaderId(file) ?? sessionIdFromFile(file);
    const canonical = candidateId ? canonicalPiSessionPath(candidateId) : file;

    for (const ls of this.live.values()) {
      if (
        ls.kind === kind &&
        (ls.engine.sessionFile === file || ls.engine.sessionFile === canonical)
      ) {
        if (candidateId !== undefined && ls.engine.sessionId !== candidateId)
          continue;
        ls.armIdleIfUnviewed();
        return ls;
      }
    }

    const inFlight = this.opening.get(canonical);
    if (inFlight) return inFlight;
    const open = (async () => {
      const openFile =
        candidateId && file !== canonical
          ? existsSync(file)
            ? migrateFileToCanonical(file, canonical)
            : canonical
          : file;
      // Cwd precedence on reopen: the in_worktree edge (durable source of
      // truth) wins; without one, the session's own header cwd applies
      // (sessions created in a non-CWD directory, e.g. merge agents);
      // openExistingSession falls back to the app CWD last. The edge's cwd
      // comes from this reopen's own check, read where it was compared.
      const edgeCwd = candidateId
        ? await withCheckedCheckout(candidateId, undefined, (checked) =>
            worktreeCwdForSession(candidateId, checked),
          )
        : undefined;
      const record = candidateId ? sessionStore.get(candidateId) : undefined;
      const profileId = record?.credentialProfileId ?? "default";
      // A durable server record decides the mode; an unrecorded session is Build.
      const mode = sessionModeOrDefault(record?.mode);
      const opened = await this.openEngine({
        kind,
        credentialProfileId: profileId,
        transcript: {
          type: "open",
          file: openFile,
          ...(candidateId !== undefined ? { expectedId: candidateId } : {}),
          ...(edgeCwd !== undefined ? { cwd: edgeCwd } : {}),
        },
        mode,
      });
      const id = opened.info.sessionId;
      // Deletion may have won while the transcript was opening: the record is
      // tombstoned and `evict` found nothing to drop yet. Registering now would
      // install a wrapper and its listeners for a session that is gone — and
      // hand it to EVERY owner sharing this open (a load, a comment handoff, a
      // continuation), which could attach or prompt it until it idled out.
      // Ownership is decided here, once, for all of them.
      if (sessionStore.getIncludingDeleted(id)?.deletedAt !== undefined) {
        closeToolGroupSession(id);
        await opened.engine.discard({});
        throw new PiSessionDeletedError(id);
      }
      // An id belongs to one engine: one the Claude store took while this
      // transcript was opening stays Claude's. Only a reopen registers an id
      // it did not mint, so this is the one place pi has to ask.
      if (this.heldElsewhere(id)) {
        await opened.engine.discard({});
        throw new SessionHeldElsewhereError(id);
      }
      this.sessionModes.set(id, mode);
      return this.track(kind, opened, profileId);
    })();
    this.opening.set(canonical, open);
    try {
      return await open;
    } finally {
      this.opening.delete(canonical);
    }
  }

  /**
   * Pi half of the hub's metadata-backed id-only resolver: reopen from the
   * canonical native path (derived from the id), with the pi kind derived from
   * the record's agentType. A pre-fix fork may still be in that kind's legacy
   * directory; acquireExisting folds it into the canonical path before open.
   * Our pi id stays equal to the pi session id, so `expectedId` guards either
   * path. Returns undefined when there is no transcript on disk to reopen.
   */
  async acquireByRecordId(
    id: string,
    agentType: string | undefined,
  ): Promise<PiLiveSession | undefined> {
    const kind: AgentType =
      agentType === "workshop"
        ? "workshop"
        : agentType === "developer"
          ? "developer"
          : agentType === "personal-assistant"
            ? "personal-assistant"
            : agentType === "workflow-coordinator"
              ? "workflow-coordinator"
              : "assistant";
    const canonical = canonicalPiSessionPath(id);
    if (existsSync(canonical)) return this.acquireExisting(kind, canonical, id);
    const legacy = findLegacySessionFile(kind, id);
    return legacy ? this.acquireExisting(kind, legacy, id) : undefined;
  }

  /**
   * The resident session for a caller about to DRIVE it, with its idle clock
   * restarted so it is not released between this answer and the prompt.
   * `getLiveById` is for readers, and restarts nothing.
   */
  getForDrive(id: string): PiLiveSession | undefined {
    const live = this.getLiveById(id);
    live?.armIdleIfUnviewed();
    return live;
  }

  /** A resident live session for our id, without loading anything from disk. */
  getLiveById(id: string): PiLiveSession | undefined {
    // pi live sessions are keyed by id, not by our id directly,
    // so scan for a resident one whose pi sessionId matches.
    for (const ls of this.live.values()) {
      if (ls.engine.sessionId === id) return ls;
    }
    return undefined;
  }

  /**
   * Branch a pi session at `nativeEntryId` — pi's own id, the only one its
   * transcript can resolve.
   *
   * `originEntryId` is the APP log entry the user picked, and the two are
   * different ids in different spaces: the branch anchor can name an entry the
   * app log does not surface as a row (a turn's last tool result), and pi's ids
   * mean nothing to a client. Fork lineage is read by the UI — it focuses the
   * source message in the parent's transcript — so `parentEntryId` records OUR
   * id, matching what the claude-sdk fork stores.
   */
  async forkSession(
    kind: AgentType,
    file: string,
    nativeEntryId: string,
    position: "before" | "at",
    originEntryId: string,
  ): Promise<PiLiveSession> {
    for (const ls of this.live.values()) {
      if (ls.kind === kind && ls.engine.sessionFile === file && ls.isRunning) {
        throw new Error("Cannot fork a session while it is streaming.");
      }
    }
    if (!existsSync(file))
      throw new Error("Cannot fork: source session file does not exist yet.");

    const parentSessionId = readSessionHeaderId(file);
    if (!parentSessionId)
      throw new Error("Cannot fork: source session has no id.");
    const parentMeta = sessionStore.getIncludingDeleted(parentSessionId);
    const credentialProfileId = parentMeta?.credentialProfileId ?? "default";
    const requiresEnterprise = sourceRequiresEnterprise([parentSessionId]);
    const ensureEnterpriseAccount = () => {
      if (
        requiresEnterprise &&
        !credentialProfileById(credentialProfileId)?.enterprise
      ) {
        throw new Error(ENTERPRISE_REQUIRED);
      }
    };
    ensureEnterpriseAccount();
    // Read the frozen definition before any native branch is written.
    const inheritAgent = sessionAgent(parentSessionId);
    // Freeze a legacy parent before branching, then give the child exactly that
    // list. Settings changing between parent and child must not move the fork.
    const inheritSkills = await sessionSkills(parentSessionId, kind);
    // The parent's worktree cwd from the fork's own check, read where it was
    // compared and before any native branch is written.
    const edgeCwd = await withCheckedCheckout(
      parentSessionId,
      undefined,
      (checked) => worktreeCwdForSession(parentSessionId, checked),
    );
    ensureEnterpriseAccount();

    // A fork continues the parent's conversation, so it inherits the parent's
    // frozen prompt conditions rather than recomputing against today's gates.
    const inherit = parsePromptConditions(
      sessionStore.getPromptConditions(parentSessionId),
    );

    // A fork continues the parent's conversation in the parent's mode too —
    // Build/Plan travels like model and thinking level do.
    const mode = sessionModeOrDefault(parentMeta?.mode);
    const opened = await this.openEngine({
      kind,
      credentialProfileId,
      transcript: {
        type: "fork",
        file,
        parentSessionId,
        nativeEntryId,
        position,
        originEntryId,
        ...(edgeCwd !== undefined ? { cwd: edgeCwd } : {}),
      },
      promptStart: {
        ...(inherit ? { inherit } : {}),
        inheritSkills,
        ...(inheritAgent ? { agent: inheritAgent } : {}),
      },
      mode,
      canonicalize: true,
    });
    const id = opened.info.sessionId;
    if (
      requiresEnterprise &&
      !credentialProfileById(credentialProfileId)?.enterprise
    ) {
      closeToolGroupSession(id);
      await opened.engine.discard({ removeFile: { except: file } });
      sessionStore.deleteSkills(id);
      throw new Error(ENTERPRISE_REQUIRED);
    }
    this.sessionModes.set(id, mode);
    // A fork inherits the parent's SCOPE as well, claimed inside `track` before
    // the child can be listed: branching is not a way for a session outside the
    // user's scope to produce one inside it.
    const live = this.track(
      kind,
      opened,
      credentialProfileId,
      parentMeta?.scope,
      requiresEnterprise,
    );
    sessionStore.upsert({
      id: live.sessionId,
      harness: "pi",
      agentType: parentMeta?.agentType ?? kind,
      credentialProfileId,
      mode,
    });
    this.requireHost().sessionRowsChanged([live.sessionId]);
    return live;
  }

  private track(
    kind: AgentType,
    opened: PiEngineOpened,
    credentialProfileId: string,
    scope?: SessionScope,
    requiresEnterprise?: boolean,
  ): PiLiveSession {
    const { engine, info } = opened;
    const id = info.sessionId;
    // The scope is claimed BEFORE the live map can hand this session to the
    // session list: a not-yet-persisted live row is treated as the user's
    // everywhere, so a session that is not may never reach the registry first.
    // A claim that contradicts the stored scope throws rather than registering.
    sessionStore.claimScope({
      id,
      harness: "pi",
      agentType: kind,
      ...(scope ? { scope } : {}),
      ...(requiresEnterprise ? { requiresEnterprise: true } : {}),
    });
    this.registerAppTools(kind, id, engine, info.cwd);
    // The injected host inverts the session→hub calls so piSdk never imports hub.ts.
    const ls: PiLiveSession = new PiLiveSession(
      kind,
      engine,
      this.requireHost(),
      (key) => this.onLiveSessionEvicted(key, ls),
      info.notices,
      info.cwd,
      this.sessionModes.get(id) ?? "build",
      (mode) => this.applySessionMode(id, mode, ls),
      credentialProfileId,
      async (profileId) => {
        const file = ls.sessionFile;
        const selected = ls.modelSelection();
        if (!file || !selected.model)
          throw new Error(
            "The pi session has no transcript or model to reopen.",
          );
        const { engine: replacement } = await this.openEngine({
          kind,
          credentialProfileId: profileId,
          transcript: { type: "open", file, expectedId: ls.id, cwd: ls.cwd },
          model: {
            provider: selected.model.provider,
            id: selected.model.id,
          },
          ...(selected.thinkingLevel !== undefined
            ? { thinkingLevel: selected.thinkingLevel }
            : {}),
          mode: ls.sessionMode,
          staged: true,
        });
        return {
          engine: replacement,
          commit: async () => {
            this.closeAppTools(id);
            this.registerAppTools(kind, id, replacement, ls.cwd);
            // Read in the swap's own synchronous span: no flip falls between.
            await replacement.commitStaged({
              mode: this.sessionModes.get(id) ?? "build",
            });
          },
          // Touches nothing the resident engine owns.
          dispose: () => replacement.discard({}),
        };
      },
    );
    this.live.set(ls.key, ls);
    // A live row overlays the persisted one (`listInfo`).
    this.requireHost().sessionRowsChanged([ls.key]);
    // Ownership from the first moment: an acquisition that is never viewed
    // (superseded navigation, closed socket) and never prompted idles out.
    ls.armIdleIfUnviewed();
    return ls;
  }

  /**
   * A live pi session idled out. Drop it from the map AND release the runtime
   * session bound to it, so a stale adapter wrapping a now-disposed pi session is
   * never reused on re-acquire (and memory is freed). A runtime session this
   * harness was never bound to — a reader's detached view — is its views' to
   * release, not ours (`SessionRuntime.releaseHarness`). Only the instance the
   * map still holds goes. A released instance's clock never runs again
   * (`SessionResidency`), so this is a backstop: should one ever fire late, it
   * cannot drop a reopened successor.
   */
  private onLiveSessionEvicted(key: string, ls: PiLiveSession): void {
    if (this.live.get(key) !== ls) return;
    this.live.delete(key);
    this.requireHost().sessionRowsChanged([key]);
    this.closeAppTools(key);
    this.sessionModes.delete(key);
    void sessionRuntime.releaseHarness(key);
  }

  /** Remove and dispose a live session (e.g. on delete). */
  evict(key: string): void {
    const ls = this.live.get(key);
    if (!ls) return;
    this.live.delete(key);
    this.requireHost().sessionRowsChanged([key]);
    // A turn still running ends here, as a deliberate end, while the runtime
    // can still tell it: disposing the pi session stops its events first.
    sessionRuntime.closeForTeardown(key);
    ls.dispose();
    this.closeAppTools(key);
    this.sessionModes.delete(key);
    void sessionRuntime.disposeSession(key);
  }

  /**
   * A live session's engine went with its Worker connection. End the session
   * like {@link evict}, closing a running turn first, but keep its record:
   * the next acquisition reopens it on a fresh connection. A lost engine no
   * live session holds (a staged replacement) fails its own pending command.
   */
  private onEngineLost(engine: PiEngineHandle): void {
    const ls = [...this.live.values()].find((live) => live.engine === engine);
    if (!ls) return;
    const key = ls.key;
    this.live.delete(key);
    this.requireHost().sessionRowsChanged([key]);
    sessionRuntime.closeForTeardown(key);
    ls.dispose();
    this.closeAppTools(key);
    this.sessionModes.delete(key);
    void sessionRuntime.releaseHarness(key);
  }

  /**
   * Apply a live mode flip: the server's gate at once, then the engine's own
   * copy, on whichever engine the session holds by then. A refused flip puts
   * the gate back, unless a later flip has moved it on (the live session runs
   * its flips one at a time, so none is in flight then).
   */
  private async applySessionMode(
    key: string,
    mode: SessionMode,
    ls: PiLiveSession,
  ): Promise<void> {
    const previous = this.sessionModes.get(key) ?? "build";
    if (previous === mode) return;
    this.sessionModes.set(key, mode);
    try {
      await ls.engine.setToolMode(mode);
    } catch (err) {
      if (this.sessionModes.get(key) === mode)
        this.sessionModes.set(key, previous);
      throw err;
    }
  }

  /**
   * Serve `id`'s app tools from `engine`, gated by the session's live mode.
   * The tools are the persona's, narrowed by its frozen agent definition.
   */
  private registerAppTools(
    kind: AgentType,
    id: string,
    engine: PiEngineHandle,
    cwd: string,
  ): void {
    this.appToolBindings.set(
      id,
      registerAppToolSession(
        id,
        piAppToolBinding(
          withoutDeniedTools(AGENT_TYPES[kind].tools(), sessionAgent(id)),
          {
            session: () => piToolSessionFromHandle(kind, engine, cwd),
            unavailableReason: (tool) =>
              (this.sessionModes.get(id) ?? "build") === "plan" &&
              !isPlanModeToolAllowed(tool)
                ? planModeToolUnavailableMessage(tool.name)
                : undefined,
            onExecute: (name) => engine.markToolUsed(name),
          },
        ),
      ),
    );
  }

  /** Dispose a session's app-tool binding (no-op when none). */
  private closeAppTools(key: string): void {
    this.appToolBindings.get(key)?.();
    this.appToolBindings.delete(key);
  }

  /**
   * Pi half of a session rename: a resident live session renames in memory
   * (after guarding the file match); otherwise the session is reopened cold and
   * the new name appended to its transcript. The caller re-broadcasts the list.
   */
  async renameSession(
    kind: AgentType,
    file: string,
    id: string,
    title: string,
  ): Promise<void> {
    const key = id;
    const live = this.live.get(key);
    if (live) {
      if (live.engine.sessionFile && live.engine.sessionFile !== file) {
        throw new Error("Session file does not match the live session.");
      }
      await live.rename(title);
      return;
    }

    const sm = await openExistingSession(kind, file, { expectedId: id });
    sm.appendSessionInfo(title);
  }

  /**
   * Resolve a pi session image to raw bytes. Prefers the live in-memory entries
   * (O(1) lookup); falls back to opening the session file from disk so the
   * endpoint works even when the session is not loaded.
   *
   * Every entry, not the current branch: the lookup is by unique entry id, and
   * `/clear` resets the leaf — an image the transcript still shows would
   * otherwise stop resolving the moment the session's context was cleared.
   */
  async resolvePiImage(
    kind: AgentType,
    sessionId: string,
    entryId: string,
    imageIndex: number,
  ): Promise<{ data: Buffer; mimeType: string } | undefined> {
    let entries:
      | Array<{
          type?: string;
          id?: string;
          message?: { role?: string; content?: unknown };
        }>
      | undefined;
    const live = this.live.get(sessionId);
    if (live) {
      entries = live.engine.transcript.getEntries() as typeof entries;
    } else {
      try {
        const file = canonicalPiSessionPath(sessionId);
        if (!existsSync(file)) return undefined;
        const sm = await openExistingSession(kind, file, {
          expectedId: sessionId,
        });
        entries = sm.getEntries() as typeof entries;
      } catch {
        return undefined;
      }
    }
    if (!entries) return undefined;
    const entry = entries.find((e) => e.id === entryId);
    if (
      !entry ||
      entry.type !== "message" ||
      !entry.message ||
      entry.message.role !== "user"
    )
      return undefined;
    const content = entry.message.content;
    if (!Array.isArray(content)) return undefined;
    const images = content.filter(
      (c): c is { type: "image"; data: string; mimeType: string } =>
        Boolean(c) &&
        typeof c === "object" &&
        (c as { type?: unknown }).type === "image" &&
        typeof (c as { data?: unknown }).data === "string",
    );
    const image = images[imageIndex];
    if (!image) return undefined;
    return {
      data: Buffer.from(image.data, "base64"),
      mimeType: image.mimeType,
    };
  }
}

export const piStore = new PiSessionStore();

// The composition root's injection: the in-process Worker hosts pi engines.
registerInProcessEngineFactory("pi", piHostedEngineFactory);
