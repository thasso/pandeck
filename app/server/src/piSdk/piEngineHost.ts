/**
 * The engine side of a live interactive pi session (`docs/workers.md`): the
 * one place that creates or opens its `SessionManager` and calls
 * `createAgentSession`. Server code describes what to open in a JSON
 * {@link PiEngineOpenSpec} and gets back a {@link PiEngineHandle} and JSON
 * {@link PiEngineOpenInfo}; it never holds a pi object.
 *
 * Both are JSON as they stand, so a Worker can host this opener across the
 * worker protocol unchanged. The {@link PiEngineHostContext} is host wiring
 * and never crosses: each host supplies its own child env and app-tool route.
 *
 * The server resolves everything fixed at open into the spec
 * (`piEngineStart.ts`) and reaches the model runtime through the host's
 * {@link PiModelPort}. What the opener still reads in the server process
 * (skill materialization, background work) `docs/workers.md` lists and
 * `harnessBoundary.test.ts` pins.
 */
import {
  type AgentSession,
  createAgentSession,
  type ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  hasNativeTools,
  type AgentType,
  type NoticeSeverity,
  type SessionMode,
  type ThinkingLevel,
} from "@assistant/shared";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CWD } from "../config.ts";
import {
  planModeToolUnavailableMessage,
  type AgentTool,
  type AppToolExecutor,
  type ToolSession,
} from "../mcp/tool.ts";
import {
  buildPiEngineOptions,
  PI_PLAN_RESTRICTED_BUILTIN_TOOLS,
  sessionDirFor,
  type PiOutputPersist,
  type PiPersonaOptions,
} from "./options.ts";
import { toPiToolDefinitions } from "./agentToolAdapter.ts";
import { isPlanModeToolAllowed } from "../tools/toolPolicy.ts";
import { installToolPayloadProbe } from "./toolPayloadProbe.ts";
import { installCompactionWindow } from "./compactionWindow.ts";
import {
  calledToolNamesFromMessages,
  createPiToolActivation,
  loadedToolNamesFromMessages,
  mergedActiveToolNames,
} from "./toolActivation.ts";
import {
  canonicalPiSessionPath,
  migrateFileToCanonical,
} from "../sessionStorage.ts";
import { FORK_ORIGIN_CUSTOM_TYPE } from "./forkOrigin.ts";
import { openExistingSession } from "./sessionOpen.ts";
import { deniesNative } from "../agents/agentDefinitionPolicy.ts";
import type { SessionAgent } from "../agents/sessionAgent.ts";
import type { PromptConditions } from "../promptConditions.ts";
import type { IntegrationToolGates } from "../tools/toolPolicy.ts";
import {
  localPiEngine,
  type PiEngineHandle,
  type PiEngineModel,
  type PiEngineTools,
} from "./piEngine.ts";
import { createPiBackgroundTools } from "./backgroundWorkBackend.ts";

/** Which transcript an engine runs on. */
type PiEngineTranscript =
  /** A fresh session, minted in `kind`'s session directory. */
  | { type: "new"; cwd: string }
  /**
   * An existing transcript, already migrated to where it opens. `cwd` is the
   * checked worktree edge, which wins over the file header's.
   */
  | { type: "open"; file: string; expectedId?: string; cwd?: string }
  /**
   * A branch of `file` at pi's `nativeEntryId`. `originEntryId` is the app log
   * entry the user picked, recorded as the fork's origin; `cwd` is the
   * parent's checked worktree edge.
   */
  | {
      type: "fork";
      file: string;
      parentSessionId: string;
      nativeEntryId: string;
      position: "before" | "at";
      originEntryId: string;
      cwd?: string;
    };

/**
 * The records a session starts with (`piEngineStart.ts`): a reopen's stored
 * rows, or what a new session or fork freezes under the id its open mints.
 * The engine builds from exactly these and freezes nothing itself.
 */
export interface PiEngineStartRecords {
  /** The frozen conditional prompt sections. */
  conditions: PromptConditions;
  /** Sorted library skill names; empty for a non-coding persona, which stores none. */
  skillNames: string[];
  /** The agent definition it runs as: a spawn's, a fork's parent's, or a reopen's row. */
  agent?: SessionAgent;
}

/**
 * What to open, as JSON: `JSON.parse(JSON.stringify(spec))` deep-equals it.
 * Optional fields are omitted, never `undefined`.
 */
export interface PiEngineOpenSpec {
  kind: AgentType;
  credentialProfileId: string;
  transcript: PiEngineTranscript;
  /** Resolved in the account's own registry; pi's model objects never travel. */
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
  start: PiEngineStartRecords;
  /** The persona's prompt and tool policy, computed by the server. */
  persona: PiPersonaOptions;
  /** The session's stored compaction window: only a reopen has one. */
  compactionWindow?: number;
  /**
   * The integration gates when the server resolved the open. The server
   * sends every later change (`setIntegrationGates`), including one that
   * landed while this open was in flight (`piStore`).
   */
  integrationGates: IntegrationToolGates;
  /** The Build/Plan mode the engine's tools start under, resolved by the server. */
  mode: SessionMode;
  /** An account reopen: its tools register only once its swap commits. */
  staged?: true;
  /** Move a new or forked transcript to its canonical per-id path. */
  canonicalize?: true;
}

/** What the opened engine reports, as JSON. */
interface PiEngineOpenInfo {
  sessionId: string;
  sessionFile?: string;
  /** Where the session executes: the spec's cwd, else the file header's, else the app CWD. */
  cwd: string;
  notices: Array<{ severity: NoticeSeverity; message: string }>;
}

/**
 * How the engine reaches pi's model runtime and registry, per credential
 * profile. The in-process Worker's host wires the server's own runtimes
 * (`models.ts`: one cached runtime and refresher per profile), so no
 * credential crosses the wire; it is the phase-3 credential gateway's seam.
 */
export interface PiModelPort {
  runtime(profileId: string): Promise<ModelRuntime>;
  findForProfile(
    profileId: string,
    provider: string,
    id: string,
  ): Promise<PiEngineModel | undefined>;
  /** The default registry's model, which a hosted `setModel` resolves in. */
  find(provider: string, id: string): PiEngineModel | undefined;
}

/** Host wiring, never on the wire: each host supplies its own. */
export interface PiEngineHostContext {
  /** The base environment of the engine's shell children. */
  childEnv(): NodeJS.ProcessEnv;
  /** How the session's app tools reach the server. */
  appToolExecutor(sessionId: string): AppToolExecutor;
  models: PiModelPort;
  /** How an elided native result's full output is persisted by the server. */
  persistOutput: PiOutputPersist;
}

export interface PiEngineOpened {
  engine: PiEngineHandle;
  info: PiEngineOpenInfo;
}

/** What starting pi on an opened transcript built. */
interface PiEngineStarted {
  session: AgentSession;
  /** Absent only for a suite's stand-in session. */
  tools?: PiEngineTools;
  notices: PiEngineOpenInfo["notices"];
}

/**
 * Starts pi on the transcript the opener opened: {@link startPiSession} in
 * production. Suites that observe only the transcript pass their own.
 */
export type PiEngineStart = (
  spec: PiEngineOpenSpec,
  ctx: PiEngineHostContext,
  opened: { sm: SessionManager; cwd: string; model?: PiEngineModel },
) => Promise<PiEngineStarted>;

/** The model and thinking level a branch last selected, if any. */
function branchRuntime(sm: SessionManager): {
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
} {
  let selected: { provider?: string; modelId?: string } = {};
  let thinkingLevel: ThinkingLevel | undefined;
  for (const entry of sm.getBranch()) {
    if (entry.type === "model_change")
      selected = { provider: entry.provider, modelId: entry.modelId };
    if (entry.type === "thinking_level_change")
      thinkingLevel = entry.thinkingLevel as ThinkingLevel;
  }
  return { ...selected, ...(thinkingLevel ? { thinkingLevel } : {}) };
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
      appendCustomEntry: async (type, data) => sm.appendCustomEntry(type, data),
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

function canonicalizeCreatedPiSession(session: AgentSession): void {
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
 * The transcript `spec` names, opened (and, for a fork, branched with its
 * origin recorded), with the cwd the session runs in.
 */
async function openTranscript(
  spec: PiEngineOpenSpec,
): Promise<{ sm: SessionManager; cwd: string }> {
  const { kind, transcript } = spec;
  if (transcript.type === "new")
    return {
      sm: SessionManager.create(transcript.cwd, sessionDirFor(kind)),
      cwd: transcript.cwd,
    };
  if (transcript.type === "open") {
    const sm = await openExistingSession(kind, transcript.file, {
      ...(transcript.expectedId !== undefined
        ? { expectedId: transcript.expectedId }
        : {}),
      ...(transcript.cwd !== undefined ? { cwd: transcript.cwd } : {}),
    });
    return { sm, cwd: transcript.cwd ?? sessionManagerCwd(sm) ?? CWD };
  }
  const { file, nativeEntryId, position } = transcript;
  // No cwd override: the branch header keeps the parent header's cwd.
  const sm = await openExistingSession(kind, file);
  if (sm.getSessionId() !== transcript.parentSessionId)
    throw new Error("Cannot fork: the source session changed.");
  const entry = sm.getEntry(nativeEntryId);
  if (!entry)
    throw new Error("Cannot fork: selected message is no longer available.");
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
    parentSessionId: transcript.parentSessionId,
    parentEntryId: transcript.originEntryId,
    position,
    createdAt: Date.now(),
  });
  // Forks inherit the parent's execution context (the caller copies the
  // in_worktree edge to the forked session id for durable reopen). Without a
  // worktree link, the parent's header cwd (applied by the open above) wins.
  return { sm, cwd: transcript.cwd ?? sessionManagerCwd(sm) ?? CWD };
}

/**
 * Open the live engine `spec` describes. Every failure disposes what the
 * opener built before it rejects.
 */
export async function openPiEngine(
  spec: PiEngineOpenSpec,
  ctx: PiEngineHostContext,
  start: PiEngineStart = startPiSession,
): Promise<PiEngineOpened> {
  let model: PiEngineModel | undefined;
  if (spec.model) {
    model = await ctx.models.findForProfile(
      spec.credentialProfileId,
      spec.model.provider,
      spec.model.id,
    );
    if (!model)
      throw new Error(
        spec.staged
          ? "The replacement account no longer offers this session's model."
          : `Model ${spec.model.provider}/${spec.model.id} is not available.`,
      );
  }
  const { sm, cwd } = await openTranscript(spec);
  const { session, tools, notices } = await start(spec, ctx, {
    sm,
    cwd,
    ...(model ? { model } : {}),
  });
  try {
    if (spec.canonicalize) canonicalizeCreatedPiSession(session);
  } catch (err) {
    tools?.activation.dispose();
    session.dispose();
    throw err;
  }
  const sessionFile = session.sessionFile;
  return {
    engine: localPiEngine(session, tools),
    info: {
      sessionId: session.sessionId,
      ...(sessionFile !== undefined ? { sessionFile } : {}),
      cwd,
      notices,
    },
  };
}

/** Build pi's agent session, tools and policy on an opened transcript. */
const startPiSession: PiEngineStart = async (spec, ctx, { sm, cwd, model }) => {
  const { kind, credentialProfileId } = spec;
  const staged = spec.staged === true;
  // The session-start records arrive resolved (`piEngineStart.ts`); the server
  // freezes them under the id pi mints here, so an agent needs one.
  const { agent } = spec.start;
  if (agent && !safeSessionId(sm))
    throw new Error(
      `Agent "${agent.name}" cannot start: pi gave the session no id to freeze it under.`,
    );
  // pi restores a session's model from its messages; one with none yet (a
  // fork before the first prompt, a spawn reopened before it ran) would get
  // pi's default model. An agent session never runs on a model it did not
  // select: its branch's last selection, else the frozen one, or a refusal.
  let startModel = model;
  let startThinkingLevel = spec.thinkingLevel;
  if (
    agent &&
    startModel === undefined &&
    sm.buildSessionContext().messages.length === 0
  ) {
    const selected = branchRuntime(sm);
    const provider = selected.provider ?? agent.provider;
    const modelId = selected.modelId ?? agent.model;
    startModel = await ctx.models.findForProfile(
      credentialProfileId,
      provider,
      modelId,
    );
    if (!startModel)
      throw new Error(
        `Agent "${agent.name}" runs on ${provider}/${modelId}, which its account no longer offers; it does not run on another model.`,
      );
    startThinkingLevel ??= selected.thinkingLevel ?? agent.effort;
  }
  const opts = await buildPiEngineOptions({
    kind,
    cwd,
    persona: spec.persona,
    skillNames: spec.start.skillNames,
    agent,
    persistOutput: ctx.persistOutput,
  });
  const activeSessionId = sm.getSessionId();
  // The engine's own Build/Plan copy; the server keeps it in step.
  const mode = { current: spec.mode };

  // The persona's AgentTools are adapted straight into pi customTools (no
  // MCP hop — the session MCP server serves the Claude harness only). The full universe is registered up front (pi cannot add
  // definitions mid-session); toolActivation keeps only eager + loaded tools
  // ACTIVE so the initial context stays small, reconciles toolGroup/
  // integration-gate changes, and activates find_tools matches inside the
  // loader's execute window (pi records addedToolNames → native deferred
  // loading on supported models).
  let sessionRef: AgentSession | undefined;
  // Its background bash and monitor run shell commands: a definition that
  // denies bash denies them too.
  const piBackgroundTools =
    hasNativeTools(kind) && !deniesNative(agent, "bash")
      ? createPiBackgroundTools({
          session: () => piToolSession(kind, sm, cwd),
          childEnv: ctx.childEnv,
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
    sessionId: activeSessionId,
    agentType: kind,
    agentTools,
    eagerToolNames,
    deferToolLoading: opts.deferToolLoading,
    deferRegistration: staged,
    integrationGates: spec.integrationGates,
    mode: () => mode.current,
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
          mode: mode.current,
          activeBridge: activeNames,
        }),
      );
    },
  });
  // The persona's app tools run on the server, through the session's
  // Worker, gated and noted (`markToolUsed`) there by the binding the server
  // registers; `find_tools` and the background shell tools run, are gated and
  // are noted here.
  const customTools = toPiToolDefinitions(activation.piToolUniverse, {
    session: () => piToolSession(kind, sm, cwd),
    unavailableReason: (tool: AgentTool) =>
      mode.current === "plan" && !isPlanModeToolAllowed(tool)
        ? planModeToolUnavailableMessage(tool.name)
        : undefined,
    onExecute: (name: string) => activation.markUsed(name),
    appTools: {
      routes: new Set(opts.agentTools),
      execute: ctx.appToolExecutor(activeSessionId),
    },
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
        modelRuntime: await ctx.models.runtime(credentialProfileId),
        sessionManager: sm,
        resourceLoader: opts.resourceLoader,
        ...(opts.noTools !== undefined ? { noTools: opts.noTools } : {}),
        ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
        customTools,
        excludeTools: opts.excludeTools,
        ...(startModel !== undefined ? { model: startModel } : {}),
        ...(startThinkingLevel !== undefined
          ? { thinkingLevel: startThinkingLevel }
          : {}),
      }));
  } catch (err) {
    activation.dispose();
    throw err;
  }
  try {
    // Nor when the model it was on cannot be restored: pi would quietly pick
    // another one.
    if ((agent || staged) && modelFallbackMessage)
      throw new Error(
        agent
          ? `Agent "${agent.name}" cannot run: ${modelFallbackMessage}. It does not run on another model.`
          : `Cannot switch accounts: ${modelFallbackMessage}. The session must keep its model.`,
      );
    // Before any prompt: the controller must observe every settings rebuild.
    installCompactionWindow(session, spec.compactionWindow);
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
  } catch (err) {
    activation.dispose();
    session.dispose();
    throw err;
  }
  const notices: PiEngineOpenInfo["notices"] = [];
  if (modelFallbackMessage)
    notices.push({ severity: "warning", message: modelFallbackMessage });
  for (const err of extensionsResult.errors) {
    notices.push({
      severity: "error",
      message: `Extension "${err.path}" failed to load: ${err.error}`,
    });
  }
  return { session, tools: { activation, mode }, notices };
};
