/**
 * Pi provider adapter. Presents a pi-backed session as a {@link PromptableAdapter}
 * emitting the normalized {@link AdapterEvent} vocabulary.
 *
 * `PiLiveSession` now emits adapter-native events directly; this module
 * only drives prompts/configuration, forwards those events, and recovers pi's
 * native entry ids after each completed run.
 */
import type {
  AgentContentBlock,
  AgentUsage,
  SessionConfigModel,
} from "@assistant/shared/session";
import type { ProviderBinding } from "../log/identity.ts";
import { scanPiEntries } from "./entryScanner.ts";
import type {
  AdapterEvent,
  AgentRunResult,
  ForkCapability,
  MessageDelta,
  PromptableAdapter,
  PromptOptions,
} from "./contract.ts";
import type { AdapterEventListener } from "./nativeEvents.ts";

type PiPromptOutcome = "started" | "steered" | "ignored";

interface PiPromptResult {
  outcome: PiPromptOutcome;
  /**
   * Optional backing engine completion. The adapter uses it only as a fallback:
   * normal pi turns still complete from the observed runCompleted event.
   */
  completed?: Promise<unknown>;
}

export type PiPromptResponse = PiPromptOutcome | PiPromptResult;

/**
 * The narrow surface the adapter needs from a pi session (a subset of
 * `PiLiveSession`), kept as an interface so this module doesn't import it.
 */
export interface PiDriver {
  subscribeAdapterEvents(listener: AdapterEventListener): () => void;
  prompt(
    text: string,
    attachments?: unknown[],
    options?: {
      clientRequestId?: string;
      hidden?: boolean;
      /**
       * Join a running turn or do nothing. The driver owns this decision because
       * it holds the authoritative streaming state; answering `"ignored"` here
       * is what keeps a lost race from becoming an unasked-for turn.
       */
      steerOnly?: boolean;
    },
  ): PiPromptResponse;
  abort(): void | Promise<void>;
  setModel(model: unknown): void | Promise<void>;
  setThinkingLevel(level: string): void;
  /** Best-effort metadata for driver-completion fallback when no native completion event arrives. */
  completionMetadata?(): { model?: string; usage?: AgentUsage };
  readonly sessionFile: string | undefined;
}

export interface PiAdapterDeps {
  /** Resolve a normalized model selection to a pi model handle for `driver.setModel`. */
  resolveModel?: (model: SessionConfigModel) => unknown;
  /** Available models for the picker. */
  listModels?: () => Promise<SessionConfigModel[]>;
  /** Fork capability for this pi session (pi supports arbitrary-point fork). */
  capabilities?: ForkCapability;
}

const PROVIDER = "pi";

interface PendingRun {
  resolve: (r: AgentRunResult) => void;
}

export function createPiAdapter(
  sessionId: string,
  driver: PiDriver,
  deps: PiAdapterDeps = {},
): PromptableAdapter {
  return new PiAdapter(sessionId, driver, deps);
}

class PiAdapter implements PromptableAdapter {
  readonly provider = PROVIDER;
  readonly capabilities: ForkCapability;
  private readonly listeners = new Set<(event: AdapterEvent) => void>();
  private readonly unsubscribeDriver: () => void;
  private pendingRun: PendingRun | undefined;
  private activeAssistantStreamId: string | undefined;
  private fallbackContent: AgentContentBlock[] = [];
  private readonly suppressedLateCompletions = new Set<string>();
  private suppressLateEventsUntilRunCompleted = false;

  constructor(
    readonly sessionId: string,
    private readonly driver: PiDriver,
    private readonly deps: PiAdapterDeps = {},
  ) {
    this.capabilities = deps.capabilities ?? {
      fork: "arbitrary",
      compact: true,
      steer: true,
      attachments: true,
    };
    this.unsubscribeDriver = this.driver.subscribeAdapterEvents((event) =>
      this.onAdapterEvent(event),
    );
  }

  subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getBinding(): ProviderBinding {
    return {
      provider: PROVIDER,
      ...(this.driver.sessionFile
        ? {
            nativeId: this.driver.sessionFile,
            providerMeta: { logRef: this.driver.sessionFile },
          }
        : {}),
    };
  }

  /** Drive a turn; resolves when the turn completes (pi signals runCompleted). */
  prompt(text: string, options: PromptOptions = {}): Promise<AgentRunResult> {
    const drive = () =>
      normalizePromptResponse(
        this.driver.prompt(text, options.attachments ?? [], {
          ...(options.clientRequestId
            ? { clientRequestId: options.clientRequestId }
            : {}),
          ...(options.hidden ? { hidden: true } : {}),
          ...(options.steerOnly ? { steerOnly: true } : {}),
        }),
      );

    if (options.steer) {
      if (options.steerOnly) return this.promptSteerOnly(drive);
      return this.promptSteer(drive);
    }

    this.fallbackContent = [];
    return new Promise<AgentRunResult>((resolve, reject) => {
      const run: PendingRun = { resolve };
      this.pendingRun = run;
      let result: PiPromptResult;
      try {
        result = drive();
      } catch (err) {
        this.pendingRun = undefined;
        reject(err);
        return;
      }
      if (this.pendingRun !== run) return; // synchronous runCompleted already resolved the run.
      if (result.outcome === "ignored") {
        this.pendingRun = undefined;
        reject(new Error("Prompt was not accepted by the pi session."));
      } else if (result.outcome === "steered") {
        this.pendingRun = undefined;
        resolve({ stopReason: "end" });
      } else {
        this.watchDriverCompletion(run, result.completed);
      }
    });
  }

  /**
   * An ordinary steering prompt. It resolves only once pi has ACCEPTED the
   * message, not merely once the driver has handed it over.
   *
   * The driver reports `"steered"` synchronously while `session.steer(...)` is
   * still in flight, and pi rejects a steer into an idle harness. Resolving on
   * the synchronous outcome therefore claims a delivery that may never happen —
   * harmless while a steer only carried the user's own words (they can see it
   * failed), but not once model-only context rides along: the facade commits a
   * deferred background fact when this resolves, and the fact would be gone.
   *
   * A lost race that started a whole turn instead (`"started"`) keeps resolving
   * immediately: awaiting there would block until the turn ends.
   */
  private async promptSteer(
    drive: () => PiPromptResult,
  ): Promise<AgentRunResult> {
    const result = drive();
    if (result.outcome === "ignored")
      throw new Error("Prompt was not accepted by the pi session.");
    if (result.outcome === "steered") await result.completed;
    return { stopReason: "end" };
  }

  /**
   * Report whether the message actually joined the running turn.
   *
   * The driver answers `"steered"` the moment it hands the text to pi, before
   * pi's own promise settles — and pi refuses to steer an idle harness. Trusting
   * the synchronous outcome therefore reports a rejected steer as delivered,
   * which is the same silent loss `steerOnly` exists to prevent, one layer
   * deeper. So the acceptance is awaited when the driver exposes it; a driver
   * that returns a bare outcome has nothing further to wait for.
   */
  private async promptSteerOnly(
    drive: () => PiPromptResult,
  ): Promise<AgentRunResult> {
    let result: PiPromptResult;
    try {
      result = drive();
    } catch {
      return { stopReason: "end", steered: false };
    }
    // "started" cannot occur under `steerOnly` — the driver refuses instead —
    // and treating it as a steer is exactly what let a lost race spend a turn.
    if (result.outcome !== "steered")
      return { stopReason: "end", steered: false };
    try {
      await result.completed;
    } catch {
      return { stopReason: "end", steered: false };
    }
    return { stopReason: "end", steered: true };
  }

  abort(): void | Promise<void> {
    return this.driver.abort();
  }

  setModel(model: SessionConfigModel): void | Promise<void> {
    const resolved = this.deps.resolveModel?.(model);
    if (!resolved)
      throw new Error(`Model ${model.provider}/${model.id} is not available.`);
    return this.driver.setModel(resolved);
  }

  setReasoning(level: string): void {
    this.driver.setThinkingLevel(level);
  }

  listModels(): Promise<SessionConfigModel[]> {
    return this.deps.listModels?.() ?? Promise.resolve([]);
  }

  dispose(): void {
    this.unsubscribeDriver();
    this.listeners.clear();
  }

  private emit(event: AdapterEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // isolate a faulty consumer
      }
    }
  }

  private onAdapterEvent(event: AdapterEvent): void {
    if (
      event.type === "messageCompleted" &&
      this.suppressedLateCompletions.delete(event.streamId)
    ) {
      // A driver-completion fallback already closed this turn. The real late
      // completion would flush buffered toolCompleted events before runCompleted;
      // drop that whole tail so no orphan tool results are appended post-fallback.
      this.suppressLateEventsUntilRunCompleted = true;
      return;
    }
    if (this.suppressLateEventsUntilRunCompleted) {
      if (event.type === "runCompleted")
        this.suppressLateEventsUntilRunCompleted = false;
      return;
    }

    this.recordFallbackContent(event);
    this.emit(event);

    if (event.type === "messageStarted") {
      this.activeAssistantStreamId = event.streamId;
    } else if (event.type === "runCompleted") {
      this.activeAssistantStreamId = undefined;
      this.completeRun(event.stopReason, event.errorMessage);
    } else if (event.type === "hostCommandResult") {
      this.activeAssistantStreamId = undefined;
    }
  }

  private recordFallbackContent(event: AdapterEvent): void {
    switch (event.type) {
      case "messageStarted":
        this.fallbackContent = [];
        return;
      case "messageDelta":
        appendDelta(this.fallbackContent, event.delta);
        return;
      case "toolStarted":
        this.fallbackContent.push({
          type: "toolCall",
          toolCallId: event.toolCallId,
          name: event.name,
          input: event.input,
        });
        return;
      default:
        return;
    }
  }

  private watchDriverCompletion(
    run: PendingRun,
    completed: Promise<unknown> | undefined,
  ): void {
    if (!completed) return;
    void completed.then(
      () => this.scheduleDriverCompletionFallback(run),
      (err) =>
        this.scheduleDriverCompletionFallback(
          run,
          `Pi prompt failed before runCompleted: ${errorText(err)}`,
        ),
    );
  }

  private scheduleDriverCompletionFallback(
    run: PendingRun,
    errorMessage?: string,
  ): void {
    setTimeout(() => this.completeFromDriverCompletion(run, errorMessage), 0);
  }

  private completeFromDriverCompletion(
    run: PendingRun,
    errorMessage?: string,
  ): void {
    if (this.pendingRun !== run) return;
    const streamId = this.activeAssistantStreamId;
    if (streamId) {
      this.suppressedLateCompletions.add(streamId);
      const metadata = this.driver.completionMetadata?.() ?? {};
      this.emit({
        type: "messageCompleted",
        streamId,
        content: this.fallbackContent.map((block) => ({ ...block })),
        ...(metadata.model ? { model: metadata.model } : {}),
        ...(metadata.usage ? { usage: metadata.usage } : {}),
        ...(errorMessage
          ? { stopReason: "error" as const, error: errorMessage }
          : {}),
      });
      this.emit({
        type: "runCompleted",
        stopReason: errorMessage ? "error" : "end",
        ...(errorMessage ? { errorMessage } : {}),
      });
      this.activeAssistantStreamId = undefined;
      this.completeRun(errorMessage ? "error" : "end", errorMessage);
      return;
    }
    this.emit({
      type: "runCompleted",
      stopReason: errorMessage ? "error" : "end",
      ...(errorMessage ? { errorMessage } : {}),
    });
    this.completeRun(errorMessage ? "error" : "end", errorMessage);
  }

  /** On turn end: recover EVERY entry's native id from the persisted file and bind them. */
  private completeRun(
    stopReason: "end" | "error" | "aborted",
    errorMessage: string | undefined,
  ): void {
    // Pi has just persisted the turn; scan the file for all conversation entries'
    // native ids (user + assistant + tool result) IN NATIVE ORDER, so the log can
    // reconcile them against its own entries and bind each fork/resume anchor. The
    // scan is a native transcript, not a copy of our log: one tool-heavy turn is
    // several native assistant/tool cycles against our single assistant entry.
    const scanned = scanPiEntries(this.driver.sessionFile);
    if (scanned.length > 0) {
      this.emit({
        type: "entriesBound",
        entries: scanned.map((e) => ({
          role: e.role,
          providerMessageId: e.id,
          ...(e.toolCallId ? { toolCallId: e.toolCallId } : {}),
          ...(e.toolCallIds ? { toolCallIds: e.toolCallIds } : {}),
          ...(e.unidentifiedToolCalls ? { unidentifiedToolCalls: true } : {}),
        })),
      });
    }
    const run = this.pendingRun;
    this.pendingRun = undefined;
    run?.resolve(
      errorMessage ? { stopReason: "error", errorMessage } : { stopReason },
    );
  }
}

function normalizePromptResponse(response: PiPromptResponse): PiPromptResult {
  return typeof response === "string" ? { outcome: response } : response;
}

function appendDelta(content: AgentContentBlock[], delta: MessageDelta): void {
  const last = content[content.length - 1];
  if (last && last.type === delta.kind) last.text += delta.text;
  else content.push({ type: delta.kind, text: delta.text });
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
