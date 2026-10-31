/**
 * The handle server code holds on a live pi engine (`docs/agent-harnesses.md`).
 *
 * Reads are synchronous and answer engine-reported state; every command
 * returns a promise that reaches the consumer reporting its outcome; no member
 * returns an SDK object, only pi's plain data (models, stats, transcript
 * entries). That is the shape the worker protocol serves later (W9b): the
 * reads become its mirror, the commands its requests, `subscribe` its events.
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
import type { ProviderErrorInfo } from "@assistant/shared";
import {
  analyzeProviderError,
  shouldSuppressProviderRetry,
} from "../providerErrors.ts";
import type {
  CompactionWindowApplyResult,
  CompactionWindowHarnessStatus,
  CompactionWindowLowerResult,
} from "../harness.ts";
import { compactionWindowFor } from "./compactionWindow.ts";
import { modelRegistry, type PiModel } from "./models.ts";

/** pi's model data, read by its fields only (never compared by identity). */
export type PiEngineModel = Parameters<AgentSession["setModel"]>[0];
type PiEngineThinkingLevel = AgentSession["thinkingLevel"];
type PiEngineImages = NonNullable<Parameters<AgentSession["steer"]>[1]>;

/** The engine's transcript, read-only; entries are pi's plain JSON data. */
interface PiTranscriptView {
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
interface PiCommitSessionManager {
  getSessionId(): string;
  getBranch(): unknown[];
  getEntry(id: string): unknown;
  appendCustomEntry(type: string, data: unknown): Promise<string | undefined>;
}

type PiClearContextResult =
  { kind: "skipped" } | { kind: "cleared"; tokensBefore?: number };

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
   * Start a turn, or steer the running one, as the caller decided in its own
   * synchronous span. `steerOnly` is carried for an engine whose streaming
   * state the caller read late; the local engine needs no reconciliation.
   * Consumers read only its settlement: a steer settles on pi's acceptance.
   */
  submit(
    text: string,
    images: PiEngineImages,
    intent: { steer: boolean; steerOnly: boolean },
  ): Promise<unknown>;
  /** Continue a failed turn with model-only custom input. */
  continueFailedTurn(context: string): Promise<void>;
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

const nativeSessions = new WeakMap<PiEngineHandle, AgentSession>();

/** The handle over an in-process pi `AgentSession`. */
export function localPiEngine(session: AgentSession): PiEngineHandle {
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

    // pi's own promise, called in the caller's synchronous span: acceptance
    // and settlement keep their timing.
    submit: (text, images, intent) =>
      intent.steer
        ? session.steer(text, images)
        : session.prompt(text, { images }),
    continueFailedTurn(context) {
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
      // Agent.continue alone bypasses AgentSession's settle/retry/compaction and
      // queue lifecycle. Its public custom-message turn preserves that lifecycle
      // without persisting another user role or making this instruction visible.
      return session.sendCustomMessage(
        {
          customType: "account-continuation",
          content: context,
          display: false,
        },
        { triggerTurn: true },
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
    async dispose() {
      unsubscribe();
      session.dispose();
    },
  };
  nativeSessions.set(engine, session);
  return engine;
}

/**
 * Test seam only: the native session behind a local handle, for suites that
 * observe pi itself. Production code never calls it.
 */
export function nativePiSessionForTests(engine: PiEngineHandle): AgentSession {
  const session = nativeSessions.get(engine);
  if (!session) throw new Error("Not a local pi engine.");
  return session;
}
