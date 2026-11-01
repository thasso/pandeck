/**
 * The handle server code holds on a live pi engine (`docs/agent-harnesses.md`).
 *
 * Reads are synchronous and answer engine-reported state; every command
 * returns a promise that reaches the consumer reporting its outcome; no member
 * returns an SDK object, only pi's plain data (models, stats, transcript
 * entries). That is the shape the worker protocol serves (`docs/workers.md`):
 * production holds the remote handle (`remotePiEngine.ts`), whose reads are
 * its mirror, its commands `engine.command` requests and `subscribe` its
 * events, over the local handle the Worker hosts (`piEngineHosted.ts`).
 *
 * The engine's loop policy lives here, because it must run synchronously
 * inside pi's own event loop and needs the session's settings: retry
 * suppression, the compaction-window check before a turn, and the window's
 * rewrite on a model change. It runs before any listener sees the event.
 */
import type {
  AgentSession,
  AgentSessionEvent,
  CompactionResult,
  SessionManager,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { ProviderErrorInfo, SessionMode } from "@assistant/shared";
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  analyzeProviderError,
  shouldSuppressProviderRetry,
} from "../providerErrors.ts";
import type {
  CompactionWindowApplyResult,
  CompactionWindowHarnessStatus,
  CompactionWindowLowerResult,
} from "../harness.ts";
import type { ToolSessionManager } from "../mcp/tool.ts";
import { compactionWindowFor } from "./compactionWindow.ts";
import { modelRegistry, type PiModel } from "./models.ts";
import {
  prepareToolsForUserTurn,
  type PiToolActivation,
} from "./toolActivation.ts";

/** pi's model data, read by its fields only (never compared by identity). */
export type PiEngineModel = Parameters<AgentSession["setModel"]>[0];
type PiEngineThinkingLevel = AgentSession["thinkingLevel"];
type PiEngineImages = NonNullable<Parameters<AgentSession["steer"]>[1]>;

/** The engine's transcript, read-only; entries are pi's plain JSON data. */
export interface PiTranscriptView {
  getSessionId(): string;
  getHeader(): ReturnType<SessionManager["getHeader"]>;
  getEntries(): ReturnType<SessionManager["getEntries"]>;
  /** Looks across ALL entries, not only the current branch. */
  getEntry(id: string): ReturnType<SessionManager["getEntry"]>;
  getBranch(): ReturnType<SessionManager["getBranch"]>;
  getLeafId(): string | null;
}

/**
 * What the commit workflow and host commands use on the pi side. Its append
 * is a command, so it answers a promise.
 */
type PiCommitSessionManager = ToolSessionManager &
  Pick<PiTranscriptView, "getEntry">;

type PiClearContextResult =
  { kind: "skipped" } | { kind: "cleared"; tokensBefore?: number };

/**
 * What the engine did with a submit or a continuation, and when pi settled it.
 * `disposition` precedes the turn's first event and rejects when the engine
 * did nothing; `settled` is a steer's acceptance, or a turn's end. Both are
 * handled inside the engine, so an unread rejection is never unhandled.
 */
interface PiEngineRun {
  disposition: Promise<"steered" | "started">;
  settled: Promise<void>;
}

export interface PiEngineHandle {
  readonly sessionId: string;
  /** Read per access: canonicalization may retarget the file. */
  readonly sessionFile: string | undefined;

  readonly isStreaming: boolean;
  readonly sessionName: string | undefined;
  readonly model: PiEngineModel | undefined;
  readonly thinkingLevel: PiEngineThinkingLevel | undefined;
  stats(): SessionStats;
  /** How many messages the live context holds. */
  contextMessageCount(): number;
  skills(): readonly { name: string; filePath: string }[];
  readonly transcript: PiTranscriptView;
  compactionWindowStatus(): CompactionWindowHarnessStatus;
  /** Reads from {@link transcript}; its append is a command. */
  toolSessionManager(): PiCommitSessionManager;

  /** Listeners see each event after the engine's policy has run for it. */
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  /**
   * Start a turn, or steer the running one. The local engine does as the
   * caller decided in its own synchronous span, so its disposition is always
   * the caller's `steer`. The hosted engine reconciles on its own streaming
   * state (`piEngineHosted.ts`): it steers exactly when it streams, and
   * refuses a `steerOnly` steer when idle. `settled` settles as pi's
   * call does: a steer on pi's acceptance. `userTurnIdleMs` is how long the
   * session sat idle before this user turn; the engine prunes never-used tool
   * loads first when it crossed the cold boundary.
   */
  submit(
    text: string,
    images: PiEngineImages,
    intent: { steer: boolean; steerOnly: boolean; userTurnIdleMs: number },
  ): PiEngineRun;
  /**
   * Continue a failed turn with model-only custom input. A failed transcript
   * write rejects the disposition: no turn starts.
   */
  continueFailedTurn(context: string): PiEngineRun;
  /** Omit opaque OpenAI reasoning from context; `false` while streaming. */
  dropEncryptedReasoning(): Promise<boolean>;
  abort(): Promise<void>;
  compact(instructions?: string): Promise<CompactionResult>;
  clearContext(): Promise<PiClearContextResult>;
  setModel(model: PiEngineModel): Promise<void>;
  setThinkingLevel(level: PiEngineThinkingLevel): Promise<void>;
  setSessionName(name: string): Promise<void>;
  applyCompactionWindow(
    tokens: number | null,
  ): Promise<CompactionWindowApplyResult>;
  /** Checks and applies only; persisting is the caller's. */
  lowerCompactionWindow(tokens: number): Promise<CompactionWindowLowerResult>;
  /** Put back the window a lower replaced, after the caller failed to persist it. */
  restoreCompactionWindow(
    previous: number | null,
    reason: string,
  ): Promise<CompactionWindowLowerResult>;
  /**
   * Bring the engine's own Build/Plan copy (its active-set merge and the gate
   * of the tools it executes) to `mode`. Rejects, keeping the old mode, when
   * the engine could not apply it.
   */
  setToolMode(mode: SessionMode): Promise<void>;
  /** Publish a staged engine's tools under `mode`, after its swap is admitted. */
  commitStaged(options: { mode: SessionMode }): Promise<void>;
  /**
   * Note that one of the session's routed app tools is about to execute, from
   * the server's binding after its gate admitted the call, so a cold prune
   * keeps it. A notification: nothing reads its effect but the engine's own
   * next `submit`.
   */
  markToolUsed(name: string): void;
  /**
   * Tear down an engine that was never registered. `removeFile` also deletes
   * its transcript, best-effort, unless that is the `except` file.
   */
  discard(options: { removeFile?: { except?: string } }): Promise<void>;
  dispose(): Promise<void>;
}

export function terminalAssistantError(message: unknown): string | undefined {
  const m = message as
    | { role?: unknown; stopReason?: unknown; errorMessage?: unknown }
    | null
    | undefined;
  if (!m || m.role !== "assistant") return undefined;
  const errorMessage =
    typeof m.errorMessage === "string" ? m.errorMessage : undefined;
  if (m.stopReason === "error") return errorMessage || "Unknown provider error";
  return undefined;
}

function assistantErrorMetadata(message: unknown): {
  api?: string;
  provider?: string;
  model?: string;
  responseId?: string;
} {
  const m = message as
    | {
        api?: unknown;
        provider?: unknown;
        model?: unknown;
        responseId?: unknown;
      }
    | null
    | undefined;
  return {
    ...(typeof m?.api === "string" ? { api: m.api } : {}),
    ...(typeof m?.provider === "string" ? { provider: m.provider } : {}),
    ...(typeof m?.model === "string" ? { model: m.model } : {}),
    ...(typeof m?.responseId === "string" ? { responseId: m.responseId } : {}),
  };
}

/** A provider error classified against the model the session runs on. */
export function piProviderErrorInfo(
  sessionModel: PiEngineModel | undefined,
  error: string,
  message?: unknown,
): ProviderErrorInfo {
  const model = sessionModel as unknown as PiModel | undefined;
  const metadata = assistantErrorMetadata(message);
  let authMode: ProviderErrorInfo["authMode"] = "unknown";
  try {
    if (model)
      authMode = modelRegistry.isUsingOAuth(model as any)
        ? "subscription"
        : "api_key";
  } catch {
    authMode = "unknown";
  }
  const providerValue = metadata.provider ?? model?.provider;
  const modelValue = metadata.model ?? model?.id;
  return analyzeProviderError(error, {
    ...(providerValue !== undefined ? { provider: providerValue } : {}),
    ...(modelValue !== undefined ? { model: modelValue } : {}),
    ...(metadata.api !== undefined ? { api: metadata.api } : {}),
    ...(metadata.responseId !== undefined
      ? { responseId: metadata.responseId }
      : {}),
    authMode,
  });
}

/**
 * What an engine the host opened owns beside its session: its tool
 * activation, and the Build/Plan copy that activation's merge and the
 * engine-executed tools' gate read.
 */
export interface PiEngineTools {
  activation: PiToolActivation;
  mode: { current: SessionMode };
}

function engineRun(
  disposition: "steered" | "started" | Promise<never>,
  settled: Promise<void>,
): PiEngineRun {
  const run: PiEngineRun = {
    disposition:
      typeof disposition === "string"
        ? Promise.resolve(disposition)
        : disposition,
    settled,
  };
  run.disposition.catch(() => {});
  run.settled.catch(() => {});
  return run;
}

const nativeSessions = new WeakMap<PiEngineHandle, AgentSession>();
const toolActivations = new WeakMap<PiEngineHandle, PiToolActivation>();

/**
 * The handle over an in-process pi `AgentSession`. Without `tools` (suites
 * over a fake session) the mode, commit and use-noting commands do nothing.
 */
export function localPiEngine(
  session: AgentSession,
  tools?: PiEngineTools,
): PiEngineHandle {
  const listeners: Array<(event: AgentSessionEvent) => void> = [];
  let retrySettingsBeforeSuppression:
    ReturnType<AgentSession["settingsManager"]["getRetrySettings"]> | undefined;

  const applyPolicy = (event: AgentSessionEvent): AgentSessionEvent => {
    switch (event.type) {
      case "agent_start": {
        compactionWindowFor(session)?.verify();
        if (retrySettingsBeforeSuppression) {
          session.settingsManager.applyOverrides({
            retry: retrySettingsBeforeSuppression,
          });
          retrySettingsBeforeSuppression = undefined;
        }
        return event;
      }
      case "message_end": {
        // An aborted message has no terminal error: its stop reason is not "error".
        const error = terminalAssistantError(event.message);
        if (
          error &&
          shouldSuppressProviderRetry(
            piProviderErrorInfo(session.model, error, event.message),
          )
        ) {
          if (!retrySettingsBeforeSuppression)
            retrySettingsBeforeSuppression =
              session.settingsManager.getRetrySettings();
          session.settingsManager.applyOverrides({
            retry: { ...retrySettingsBeforeSuppression, maxRetries: 0 },
          });
        }
        return event;
      }
      case "auto_retry_start": {
        const retryError = piProviderErrorInfo(
          session.model,
          event.errorMessage,
        );
        if (shouldSuppressProviderRetry(retryError)) session.abortRetry();
        return event;
      }
      case "agent_end": {
        // The maxRetries=0 suppression override should already make willRetry
        // false; retain the settings guard defensively for SDK event snapshots.
        return event.willRetry && retrySettingsBeforeSuppression
          ? { ...event, willRetry: false }
          : event;
      }
      default:
        return event;
    }
  };

  // The engine's one subscription; pi's own emit loop has the same shape.
  const unsubscribe = session.subscribe((native) => {
    const event = applyPolicy(native);
    for (const listener of listeners) listener(event);
  });

  const transcript: PiTranscriptView = {
    getSessionId: () => session.sessionManager.getSessionId(),
    getHeader: () => session.sessionManager.getHeader(),
    getEntries: () => session.sessionManager.getEntries(),
    getEntry: (id) => session.sessionManager.getEntry(id),
    getBranch: () => session.sessionManager.getBranch(),
    getLeafId: () => session.sessionManager.getLeafId(),
  };

  const engine: PiEngineHandle = {
    get sessionId() {
      return session.sessionId;
    },
    get sessionFile() {
      return session.sessionFile;
    },
    get isStreaming() {
      return session.isStreaming;
    },
    get sessionName() {
      return session.sessionName;
    },
    get model() {
      return session.model;
    },
    get thinkingLevel() {
      return session.thinkingLevel;
    },
    stats: () => session.getSessionStats(),
    contextMessageCount: () => session.messages.length,
    skills: () =>
      session.resourceLoader
        .getSkills()
        .skills.map(({ name, filePath }) => ({ name, filePath })),
    transcript,
    compactionWindowStatus: () =>
      compactionWindowFor(session)?.status() ?? {
        live: { applied: "pending", pendingReason: "next-turn" },
      },
    toolSessionManager: () => ({
      getSessionId: () => transcript.getSessionId(),
      getBranch: () => transcript.getBranch(),
      getEntry: (id) => transcript.getEntry(id),
      appendCustomEntry: async (type, data) =>
        session.sessionManager.appendCustomEntry(type, data),
    }),

    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },

    // pi is called in the caller's synchronous span, before the first await;
    // only its settlement crosses, not a steer's queue disposition.
    submit(text, images, intent) {
      const settled = (async () => {
        prepareToolsForUserTurn(session.sessionId, intent.userTurnIdleMs);
        await (intent.steer
          ? session.steer(text, images)
          : session.prompt(text, { images }));
      })();
      return engineRun(intent.steer ? "steered" : "started", settled);
    },
    continueFailedTurn(context) {
      try {
        const branch = session.sessionManager.getBranch();
        const last = [...branch]
          .reverse()
          .find((entry) => entry.type === "message");
        // Like pi's own recovery, retain the failed response in the native file but
        // omit it from model context; Agent.continue requires a user/tool-result tail.
        if (
          last?.type === "message" &&
          last.message.role === "assistant" &&
          last.message.stopReason === "error"
        )
          session.sessionManager.appendContextEdit(last.id, null);
        session.state.messages =
          session.sessionManager.buildSessionContext().messages;
      } catch (error) {
        // The write failed before pi was called: nothing started.
        const failed = Promise.reject(error);
        return engineRun(failed, failed);
      }
      // Agent.continue alone bypasses AgentSession's settle/retry/compaction and
      // queue lifecycle. Its public custom-message turn preserves that lifecycle
      // without persisting another user role or making this instruction visible.
      return engineRun(
        "started",
        session.sendCustomMessage(
          {
            customType: "account-continuation",
            content: context,
            display: false,
          },
          { triggerTurn: true },
        ),
      );
    },
    async dropEncryptedReasoning() {
      if (session.isStreaming) return false;
      let changed = false;
      const manager = session.sessionManager;
      for (const { sourceEntry, messages } of manager.buildSessionProjection()
        .entries) {
        const message = messages[0];
        if (
          sourceEntry.type !== "message" ||
          message?.role !== "assistant" ||
          !/^openai(?:-|$)/.test(message.provider)
        )
          continue;
        const content = message.content.filter(
          (block) => block.type !== "thinking" || !block.thinkingSignature,
        );
        if (content.length === message.content.length) continue;
        manager.appendContextEdit(
          sourceEntry.id,
          content.length ? { content } : null,
        );
        changed = true;
      }
      return changed;
    },
    async abort() {
      await session.abort();
    },
    async compact(instructions) {
      return session.compact(instructions);
    },
    async clearContext() {
      if (session.messages.length === 0) return { kind: "skipped" };
      const tokensBefore = session.getSessionStats().contextUsage?.tokens;
      session.sessionManager.resetLeaf();
      session.state.messages = [];
      return {
        kind: "cleared",
        ...(tokensBefore != null ? { tokensBefore } : {}),
      };
    },
    async setModel(model) {
      await session.setModel(model);
      compactionWindowFor(session)?.onModelChanged();
    },
    async setThinkingLevel(level) {
      session.setThinkingLevel(level);
    },
    async setSessionName(name) {
      session.setSessionName(name);
    },
    async applyCompactionWindow(tokens) {
      const controller = compactionWindowFor(session);
      return controller
        ? controller.apply(tokens)
        : { pendingReason: "next-turn" };
    },
    async lowerCompactionWindow(tokens) {
      const controller = compactionWindowFor(session);
      return controller
        ? controller.lower(tokens, () => {})
        : { ok: false, message: "This pi session cannot change its window." };
    },
    async restoreCompactionWindow(previous, reason) {
      const controller = compactionWindowFor(session);
      return controller
        ? controller.restore(previous, reason)
        : { ok: false, message: reason };
    },
    async setToolMode(mode) {
      if (!tools) return;
      const previous = tools.mode.current;
      tools.mode.current = mode;
      try {
        tools.activation.reapply();
      } catch (err) {
        tools.mode.current = previous;
        throw err;
      }
    },
    async commitStaged({ mode }) {
      if (!tools) return;
      tools.mode.current = mode;
      tools.activation.register();
      // A staged engine may have waited across a live Build/Plan change.
      tools.activation.reapply();
    },
    markToolUsed(name) {
      tools?.activation.markUsed(name);
    },
    async discard({ removeFile }) {
      const sessionFile = session.sessionFile;
      unsubscribe();
      tools?.activation.dispose();
      session.dispose();
      if (
        !removeFile ||
        !sessionFile ||
        (removeFile.except &&
          resolve(sessionFile) === resolve(removeFile.except))
      )
        return;
      try {
        unlinkSync(sessionFile);
      } catch {
        // Best-effort cleanup must not hide the refusal that discarded it.
      }
    },
    async dispose() {
      unsubscribe();
      tools?.activation.dispose();
      session.dispose();
    },
  };
  nativeSessions.set(engine, session);
  if (tools) toolActivations.set(engine, tools.activation);
  return engine;
}

/**
 * What the test seams below reach through a remote handle while the
 * in-process Worker hosts its engine: the local handle it drives, and a
 * refresh of its mirror.
 */
interface HostedLink {
  local: () => PiEngineHandle | undefined;
  refresh: () => Promise<void>;
}

/** Remote handles, each with its link into the in-process Worker. */
const hostedLinks = new WeakMap<PiEngineHandle, HostedLink>();

/** Record a remote handle's link, so the test seams see through it. */
export function linkRemotePiEngine(
  remote: PiEngineHandle,
  link: HostedLink,
): void {
  hostedLinks.set(remote, link);
}

/** The local handle `engine` is, or drives through the in-process Worker. */
function localHandleOf(engine: PiEngineHandle): PiEngineHandle {
  const link = hostedLinks.get(engine);
  if (!link) return engine;
  const handle = link.local();
  if (!handle) throw new Error("The pi engine is no longer hosted.");
  return handle;
}

/**
 * Test seam only: the native session behind a local handle, or behind the
 * Worker-side handle a remote one drives, for suites that observe pi itself.
 * Production code never calls it.
 */
export function nativePiSessionForTests(engine: PiEngineHandle): AgentSession {
  const session = nativeSessions.get(localHandleOf(engine));
  if (!session) throw new Error("Not a local pi engine.");
  return session;
}

/**
 * Test seam only: the tool activation of an engine the host opened, directly
 * or through the in-process Worker. Production code never calls it.
 */
export function piToolActivationForTests(
  engine: PiEngineHandle,
): PiToolActivation {
  const activation = toolActivations.get(localHandleOf(engine));
  if (!activation) throw new Error("Not a host-opened pi engine.");
  return activation;
}

/**
 * Test seam only: bring a remote handle's mirror up to date with what a suite
 * wrote to pi natively (through {@link nativePiSessionForTests}), outside any
 * command. A local handle has no mirror. Production code never calls it, and
 * no engine command or protocol method reaches the refresh.
 */
export async function syncPiEngineMirrorForTests(
  engine: PiEngineHandle,
): Promise<void> {
  await hostedLinks.get(engine)?.refresh();
}
