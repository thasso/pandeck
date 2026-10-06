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
  type AgentSession,
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  AGENT_TYPE_IDS,
  isCodingAgentType,
  sessionModeOrDefault,
  type AgentType,
  type NoticeSeverity,
  type SessionMode,
  type SessionScope,
  type ThinkingLevel,
} from "@assistant/shared";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CWD } from "../config.ts";
import {
  planModeToolUnavailableMessage,
  type ToolSession,
} from "../mcp/tool.ts";
import {
  buildAgentOptions,
  PI_PLAN_RESTRICTED_BUILTIN_TOOLS,
  sessionDirFor,
} from "./options.ts";
import { toPiToolDefinitions } from "./agentToolAdapter.ts";
import { isPlanModeToolAllowed } from "../tools/toolPolicy.ts";
import { installToolPayloadProbe } from "./toolPayloadProbe.ts";
import {
  calledToolNamesFromMessages,
  createPiToolActivation,
  loadedToolNamesFromMessages,
  mergedActiveToolNames,
  type PiToolActivation,
} from "./toolActivation.ts";
import { modelRuntimeForProfile } from "./models.ts";
import type { LiveListInfo } from "../sessions.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";
import {
  canonicalPiSessionPath,
  migrateFileToCanonical,
} from "../sessionStorage.ts";
import { FORK_ORIGIN_CUSTOM_TYPE } from "./forkOrigin.ts";
import {
  findLegacySessionFile,
  openExistingSession,
  readSessionHeaderId,
  sessionIdFromFile,
} from "./sessionOpen.ts";
import { worktreeCwdForSession } from "../worktrees/sessionCwd.ts";
import { sessionStore } from "../db/sessionStore.ts";
import {
  parsePromptConditions,
  sessionPromptConditions,
  type PromptConditions,
  type SessionPromptEvidence,
} from "../promptConditions.ts";
import { PiLiveSession } from "./PiLiveSession.ts";
import { SessionHeldElsewhereError, type HarnessHost } from "../harness.ts";
import { defaultOpenAiProfileId } from "../credentialProfiles.ts";
import { sessionSkills } from "../sessionSkills.ts";
import { createPiBackgroundTools } from "./backgroundWorkBackend.ts";
import { closeToolGroupSession } from "../mcp/toolGroups/registry.ts";

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

/**
 * How a pi session decides its frozen prompt conditions: from what it starts
 * with (`evidence`), or by inheriting a parent's record (a fork). Neither is
 * consulted once the session has frozen conditions of its own.
 */
interface PiPromptStart {
  evidence?: SessionPromptEvidence;
  inherit?: PromptConditions;
  inheritSkills?: readonly string[];
}

function safeSessionId(sm: SessionManager): string | undefined {
  try {
    const id = sm.getSessionId();
    return typeof id === "string" && id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The cwd the opened SessionManager resolved (override or header), if exposed. */
function sessionManagerCwd(sm: SessionManager): string | undefined {
  const cwd = (sm as unknown as { getCwd?: () => unknown }).getCwd?.();
  return typeof cwd === "string" && cwd ? cwd : undefined;
}

/**
 * Fully-populated {@link ToolSession} for a pi session backed by `sm`. Read
 * fresh on every tool call so sessionFile/title appear once persisted; the
 * session-manager surface is the real pi {@link SessionManager}, narrowed to
 * the {@link ToolSession} contract.
 */
function piToolSession(
  kind: AgentType,
  sm: SessionManager,
  cwd: string,
): ToolSession {
  const sessionFileValue = sm.getSessionFile();
  const titleValue = sm.getSessionName();
  return {
    sessionId: sm.getSessionId(),
    harness: "pi",
    agentType: kind,
    cwd,
    ...(sessionFileValue !== undefined
      ? { sessionFile: sessionFileValue }
      : {}),
    ...(titleValue !== undefined ? { title: titleValue } : {}),
    sessionManager: {
      getSessionId: () => sm.getSessionId(),
      getBranch: () => sm.getBranch(),
      appendCustomEntry: (type, data) => sm.appendCustomEntry(type, data),
    },
  };
}

function installDynamicToolTurnRefresh(session: AgentSession): void {
  const previousPrepareNextTurn = session.agent.prepareNextTurn?.bind(
    session.agent,
  );
  session.agent.prepareNextTurn = async (signal) => {
    const previous = await previousPrepareNextTurn?.(signal);
    const previousContext = previous?.context;
    return {
      ...previous,
      context: {
        systemPrompt: session.agent.state.systemPrompt,
        messages:
          previousContext?.messages ?? session.agent.state.messages.slice(),
        tools: session.agent.state.tools.slice(),
      },
    };
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
  /** Per-session tool activation (change subscriptions), disposed on eviction. */
  private toolRuntimes = new Map<string, PiToolActivation>();
  /** Live policy read by the built-in/bridge active-set merge. */
  private sessionModes = new Map<string, SessionMode>();
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
    model?: AgentSession["model"],
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
      mode?: SessionMode;
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
      opts?.credentialProfileId ?? defaultOpenAiProfileId();
    const created = await this.create(
      kind,
      SessionManager.create(cwd, sessionDirFor(kind)),
      model,
      thinkingLevel,
      cwd,
      credentialProfileId,
      opts?.promptEvidence ? { evidence: opts.promptEvidence } : undefined,
      opts?.mode,
    );
    this.canonicalizeCreatedPiSession(created.session);
    return this.track(
      kind,
      created.session,
      created.notices,
      cwd,
      credentialProfileId,
      opts?.scope,
    );
  }

  private canonicalizeCreatedPiSession(session: AgentSession): void {
    const id = session.sessionId;
    const file = session.sessionFile;
    if (!file) return;
    const canonical = canonicalPiSessionPath(id);
    if (file === canonical) return;
    if (!existsSync(file)) {
      // Empty bootstrap sessions do not have a native transcript yet. Do not use
      // SessionManager.setSessionFile() here: for a missing file it calls
      // newSession() and mints another id. Retarget only the pending output path
      // so the first real persist writes the existing in-memory header/id to the
      // canonical per-id native transcript.
      mkdirSync(dirname(canonical), { recursive: true });
      const manager = session.sessionManager as unknown as {
        sessionFile?: string;
        flushed?: boolean;
      };
      manager.sessionFile = canonical;
      manager.flushed = false;
      return;
    }
    const moved = migrateFileToCanonical(file, canonical);
    session.sessionManager.setSessionFile(moved);
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
        (ls.session.sessionFile === file ||
          ls.session.sessionFile === canonical)
      ) {
        if (candidateId !== undefined && ls.session.sessionId !== candidateId)
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
      // openExistingSession falls back to the app CWD last.
      const edgeCwd = candidateId
        ? worktreeCwdForSession(candidateId)
        : undefined;
      const sm = await openExistingSession(kind, openFile, {
        ...(candidateId !== undefined ? { expectedId: candidateId } : {}),
        ...(edgeCwd !== undefined ? { cwd: edgeCwd } : {}),
      });
      const cwd = edgeCwd ?? sessionManagerCwd(sm) ?? CWD;
      const profileId =
        sessionStore.get(candidateId ?? sm.getSessionId())
          ?.credentialProfileId ?? defaultOpenAiProfileId();
      const created = await this.create(
        kind,
        sm,
        undefined,
        undefined,
        cwd,
        profileId,
      );
      // Deletion may have won while the transcript was opening: the record is
      // tombstoned and `evict` found nothing to drop yet. Registering now would
      // install a wrapper and its listeners for a session that is gone — and
      // hand it to EVERY owner sharing this open (a load, a comment handoff, a
      // continuation), which could attach or prompt it until it idled out.
      // Ownership is decided here, once, for all of them.
      if (
        sessionStore.getIncludingDeleted(created.session.sessionId)
          ?.deletedAt !== undefined
      ) {
        this.discardUnregistered(created.session);
        throw new PiSessionDeletedError(created.session.sessionId);
      }
      // An id belongs to one engine: one the Claude store took while this
      // transcript was opening stays Claude's. Only a reopen registers an id
      // it did not mint, so this is the one place pi has to ask.
      if (this.heldElsewhere(created.session.sessionId)) {
        this.discardRefused(created.session);
        throw new SessionHeldElsewhereError(created.session.sessionId);
      }
      return this.track(kind, created.session, created.notices, cwd, profileId);
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
      if (ls.session.sessionId === id) return ls;
    }
    return undefined;
  }

  /**
   * Branch a pi session at `nativeEntryId` — pi's own id, the only one its
   * SessionManager can resolve.
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
      if (ls.kind === kind && ls.session.sessionFile === file && ls.isRunning) {
        throw new Error("Cannot fork a session while it is streaming.");
      }
    }
    if (!existsSync(file))
      throw new Error("Cannot fork: source session file does not exist yet.");

    const sm = await openExistingSession(kind, file);
    const entry = sm.getEntry(nativeEntryId);
    if (!entry)
      throw new Error("Cannot fork: selected message is no longer available.");

    const parentSessionId = sm.getSessionId();

    if (position === "before") {
      if (entry.type !== "message" || entry.message.role !== "user") {
        throw new Error("Can only fork before user messages.");
      }
      if (entry.parentId) {
        sm.createBranchedSession(entry.parentId);
      } else {
        sm.newSession({ parentSession: file });
      }
    } else {
      sm.createBranchedSession(nativeEntryId);
    }

    sm.appendCustomEntry(FORK_ORIGIN_CUSTOM_TYPE, {
      harness: "pi",
      agentType: kind,
      parentSessionFile: file,
      parentSessionId,
      parentEntryId: originEntryId,
      position,
      createdAt: Date.now(),
    });

    // Forks inherit the parent's execution context (the caller copies the
    // in_worktree edge to the forked session id for durable reopen). Without a
    // worktree link, the parent's header cwd (applied by the open above) wins.
    const cwd =
      worktreeCwdForSession(parentSessionId) ?? sessionManagerCwd(sm) ?? CWD;
    const parentMeta = sessionStore.get(parentSessionId);
    const credentialProfileId =
      parentMeta?.credentialProfileId ?? defaultOpenAiProfileId();
    // A fork continues the parent's conversation, so it inherits the parent's
    // frozen prompt conditions rather than recomputing against today's gates.
    const inherit = parsePromptConditions(
      sessionStore.getPromptConditions(parentSessionId),
    );
    // Freeze a legacy parent before branching, then give the child exactly that
    // list. Settings changing between parent and child must not move the fork.
    const inheritSkills = await sessionSkills(parentSessionId, kind);
    // A fork continues the parent's conversation in the parent's mode too —
    // Build/Plan travels like model and thinking level do.
    const mode = sessionModeOrDefault(parentMeta?.mode);
    const created = await this.create(
      kind,
      sm,
      undefined,
      undefined,
      cwd,
      credentialProfileId,
      inherit ? { inherit, inheritSkills } : { inheritSkills },
      mode,
    );
    this.canonicalizeCreatedPiSession(created.session);
    // A fork inherits the parent's SCOPE as well, claimed inside `track` before
    // the child can be listed: branching is not a way for a session outside the
    // user's scope to produce one inside it.
    const live = this.track(
      kind,
      created.session,
      created.notices,
      cwd,
      credentialProfileId,
      parentMeta?.scope,
    );
    sessionStore.upsert({
      id: live.sessionId,
      harness: "pi",
      agentType: parentMeta?.agentType ?? kind,
      credentialProfileId,
      mode,
    });
    await this.requireHost().broadcastSessions();
    return live;
  }

  private async create(
    kind: AgentType,
    sm: SessionManager,
    model?: AgentSession["model"],
    thinkingLevel?: ThinkingLevel,
    cwd: string = CWD,
    credentialProfileId?: string,
    promptStart?: PiPromptStart,
    requestedMode?: SessionMode,
  ): Promise<{
    session: AgentSession;
    notices: Array<{ severity: NoticeSeverity; message: string }>;
  }> {
    credentialProfileId ??= defaultOpenAiProfileId();
    // Session-START prompt conditions (Task 287). pi rebuilds the system prompt
    // on every active-tool change and on every reopen, so this reads the frozen
    // record whenever the session already has one — creation is the only call
    // that can decide it.
    const sessionId = safeSessionId(sm);
    const conditions = sessionId
      ? sessionPromptConditions(
          sessionId,
          kind,
          promptStart?.evidence,
          promptStart?.inherit,
        )
      : undefined;
    const frozenSkillNames = sessionId
      ? await sessionSkills(sessionId, kind, promptStart?.inheritSkills)
      : [];
    const opts = await buildAgentOptions(
      kind,
      cwd,
      credentialProfileId,
      conditions,
      frozenSkillNames,
    );
    const activeSessionId = sm.getSessionId();
    // A durable server record wins over a caller's requested starting mode.
    // Legacy/unrecorded sessions normalize to Build.
    this.sessionModes.set(
      activeSessionId,
      sessionModeOrDefault(
        sessionStore.get(activeSessionId)?.mode ?? requestedMode,
      ),
    );

    // Direct tool path: the persona's AgentTools are adapted straight into pi
    // customTools (no MCP hop — the session MCP server serves the Claude
    // harness only). The full universe is registered up front (pi cannot add
    // definitions mid-session); toolActivation keeps only eager + loaded tools
    // ACTIVE so the initial context stays small, reconciles toolGroup/
    // integration-gate changes, and activates find_tools matches inside the
    // loader's execute window (pi records addedToolNames → native deferred
    // loading on supported models).
    let sessionRef: AgentSession | undefined;
    const piBackgroundTools = isCodingAgentType(kind)
      ? createPiBackgroundTools({
          session: () => piToolSession(kind, sm, cwd),
          bashConfig: () => {
            const settings = sessionRef?.settingsManager;
            const shellPath = settings?.getShellPath();
            const commandPrefix = settings?.getShellCommandPrefix();
            return {
              ...(shellPath ? { shellPath } : {}),
              ...(commandPrefix ? { commandPrefix } : {}),
            };
          },
          identity: () => {
            const current = sessionRef;
            const selectedModel = current?.model as
              { provider?: string; id?: string } | undefined;
            const sessionFile = sm.getSessionFile();
            return {
              sessionId: sm.getSessionId(),
              ...(sessionFile ? { sessionFile } : {}),
              ...(selectedModel?.provider
                ? { provider: selectedModel.provider }
                : {}),
              ...(selectedModel?.id ? { model: selectedModel.id } : {}),
              ...(current?.thinkingLevel
                ? { reasoningLevel: current.thinkingLevel }
                : {}),
            };
          },
        })
      : [];
    const agentTools = [...opts.agentTools, ...piBackgroundTools];
    const eagerToolNames = new Set([
      ...opts.eagerToolNames,
      ...piBackgroundTools.map((tool) => tool.name),
    ]);
    const activation = createPiToolActivation({
      sessionId: sm.getSessionId(),
      agentType: kind,
      agentTools,
      eagerToolNames,
      deferToolLoading: opts.deferToolLoading,
      mode: () => this.sessionModes.get(activeSessionId) ?? "build",
      applyActiveToolNames: (activeNames) => {
        // Merge pi's non-bridge tools (built-ins) with the bridge-active names.
        // `sessionRef` is assigned once the AgentSession exists; earlier
        // callbacks are impossible because change events only follow toolGroup/
        // gate changes emitted after creation, and initialize() runs after.
        const session = sessionRef;
        if (!session) return;
        // `extraBuiltinToolNames` (the search builtins pi registers but leaves
        // inactive, Task-316) rides this merge rather than a `tools:` allowlist,
        // which pi force-re-activates on every registry refresh — that would
        // defeat the deferred app-tool active set. The merge itself is pure and
        // tested in `toolActivation.test.ts`.
        session.setActiveToolsByName(
          mergedActiveToolNames({
            current: session.getActiveToolNames(),
            bridgeToolNames: activation.toolNames,
            extraBuiltin: opts.extraBuiltinToolNames,
            planRestrictedBuiltin: opts.noTools
              ? []
              : PI_PLAN_RESTRICTED_BUILTIN_TOOLS,
            mode: this.sessionModes.get(activeSessionId) ?? "build",
            activeBridge: activeNames,
          }),
        );
      },
    });
    const customTools = toPiToolDefinitions(activation.piToolUniverse, {
      session: () => piToolSession(kind, sm, cwd),
      unavailableReason: (tool) =>
        (this.sessionModes.get(activeSessionId) ?? "build") === "plan" &&
        !isPlanModeToolAllowed(tool)
          ? planModeToolUnavailableMessage(tool.name)
          : undefined,
      onExecute: (name) => activation.markUsed(name),
    });

    let session: AgentSession;
    let extensionsResult: Awaited<
      ReturnType<typeof createAgentSession>
    >["extensionsResult"];
    let modelFallbackMessage: string | undefined;
    try {
      ({ session, extensionsResult, modelFallbackMessage } =
        await createAgentSession({
          cwd,
          modelRuntime: await modelRuntimeForProfile(credentialProfileId),
          sessionManager: sm,
          resourceLoader: opts.resourceLoader,
          ...(opts.noTools !== undefined ? { noTools: opts.noTools } : {}),
          ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
          customTools,
          excludeTools: opts.excludeTools,
          ...(model !== undefined ? { model } : {}),
          ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
        }));
    } catch (err) {
      activation.dispose();
      this.sessionModes.delete(activeSessionId);
      throw err;
    }
    this.closeToolRuntime(session.sessionId); // paranoia: never leak a stale activation under the same key
    this.toolRuntimes.set(session.sessionId, activation);
    installToolPayloadProbe(session);
    installDynamicToolTurnRefresh(session);
    // Initial active set: eager + find_tools + everything the transcript
    // already loaded (addedToolNames), gate/pack-filtered — so a reopened
    // session keeps its loaded tools and a fresh one starts small.
    sessionRef = session;
    activation.initialize(
      loadedToolNamesFromMessages(session.messages),
      calledToolNamesFromMessages(session.messages),
    );
    const notices: Array<{ severity: NoticeSeverity; message: string }> = [];
    if (modelFallbackMessage)
      notices.push({ severity: "warning", message: modelFallbackMessage });
    for (const err of extensionsResult.errors) {
      notices.push({
        severity: "error",
        message: `Extension "${err.path}" failed to load: ${err.error}`,
      });
    }
    return { session, notices };
  }

  private track(
    kind: AgentType,
    session: AgentSession,
    initialNotices: Array<{ severity: NoticeSeverity; message: string }>,
    cwd: string,
    credentialProfileId: string,
    scope?: SessionScope,
  ): PiLiveSession {
    // The scope is claimed BEFORE the live map can hand this session to the
    // session list: a not-yet-persisted live row is treated as the user's
    // everywhere, so a session that is not may never reach the registry first.
    // A claim that contradicts the stored scope throws rather than registering.
    sessionStore.claimScope({
      id: session.sessionId,
      harness: "pi",
      agentType: kind,
      ...(scope ? { scope } : {}),
    });
    // The injected host inverts the session→hub calls so piSdk never imports hub.ts.
    const ls = new PiLiveSession(
      kind,
      session,
      this.requireHost(),
      (key) => this.onLiveSessionEvicted(key, ls),
      initialNotices,
      cwd,
      this.sessionModes.get(session.sessionId) ?? "build",
      (mode) => this.applySessionMode(session.sessionId, mode),
      credentialProfileId,
    );
    this.live.set(ls.key, ls);
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
    this.closeToolRuntime(key);
    this.sessionModes.delete(key);
    void sessionRuntime.releaseHarness(key);
  }

  /**
   * Tear down a session `create` built for an id another engine holds: only
   * what pi made for it. Resources keyed by the id alone, its browser runtime
   * above all, belong to the holder and stay open.
   */
  private discardRefused(session: AgentSession): void {
    this.closeToolRuntime(session.sessionId);
    this.sessionModes.delete(session.sessionId);
    session.dispose();
  }

  /** Tear down a session `create` built that will never be registered. */
  private discardUnregistered(session: AgentSession): void {
    this.closeToolRuntime(session.sessionId);
    this.sessionModes.delete(session.sessionId);
    closeToolGroupSession(session.sessionId);
    session.dispose();
  }

  /** Remove and dispose a live session (e.g. on delete). */
  evict(key: string): void {
    const ls = this.live.get(key);
    if (!ls) return;
    this.live.delete(key);
    ls.dispose();
    this.closeToolRuntime(key);
    this.sessionModes.delete(key);
    void sessionRuntime.disposeSession(key);
  }

  /** Apply a live mode flip through the same active-set merge as every load. */
  private applySessionMode(key: string, mode: SessionMode): void {
    const previous = this.sessionModes.get(key) ?? "build";
    if (previous === mode) return;
    this.sessionModes.set(key, mode);
    try {
      this.toolRuntimes.get(key)?.reapply();
    } catch (err) {
      this.sessionModes.set(key, previous);
      throw err;
    }
  }

  /** Dispose a session's tool activation subscriptions (no-op when none). */
  private closeToolRuntime(key: string): void {
    const runtime = this.toolRuntimes.get(key);
    if (!runtime) return;
    this.toolRuntimes.delete(key);
    runtime.dispose();
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
      if (live.session.sessionFile && live.session.sessionFile !== file) {
        throw new Error("Session file does not match the live session.");
      }
      live.rename(title);
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
      entries = live.session.sessionManager.getEntries() as typeof entries;
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
