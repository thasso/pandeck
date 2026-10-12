import type { ServerMessage } from "@assistant/shared";
import type { AgentContentBlock, AgentUsage } from "@assistant/shared/session";
import type { HostCommandCard } from "../log/rawEntry.ts";
import type {
  AdapterEvent,
  ProviderActivityKind,
  ProviderRunId,
  RunFailureFacts,
} from "./contract.ts";

export type AdapterEventListener = (event: AdapterEvent) => void;

/** A failed run's message and, when the harness classified it, its facts. */
function runFailureFields(options: {
  errorMessage?: string;
  failure?: RunFailureFacts;
}): { errorMessage?: string; failure?: RunFailureFacts } {
  if (!options.errorMessage) return {};
  return {
    errorMessage: options.errorMessage,
    ...(options.failure ? { failure: options.failure } : {}),
  };
}

/**
 * Small event source used by in-process harnesses to emit the runtime adapter
 * contract directly while they continue to broadcast websocket envelopes to any
 * direct viewers.
 */
export class NativeAdapterEventSource {
  private readonly listeners = new Set<AdapterEventListener>();
  private currentContent: AgentContentBlock[] = [];
  private bufferedToolCompletions: AdapterEvent[] = [];
  private pendingHostCommand:
    { name: string; card: HostCommandCard } | undefined;
  /** Wall-clock start of the in-flight message, for the durable startedAt/completedAt span. */
  private currentStartedAt: string | undefined;
  /**
   * The provider run open right now, if any (the contract's `run`). Opened by
   * the first message of a turn and closed by the turn's end, so it follows the
   * harness's OWN turn brackets: an event the harness emits after its turn
   * closed carries no run, whenever the runtime happens to receive it.
   */
  private openRun: ProviderRunId | undefined;
  private lastRun: ProviderRunId = 0;
  /** Inside {@link unattributed}: what is emitted belongs to no run. */
  private attributionSuspended = 0;

  subscribe(listener: AdapterEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.listeners.clear();
  }

  /**
   * Run `handle` for a provider event that does not belong to the open turn —
   * one the harness knows came from somewhere else (an earlier query epoch).
   * Its transcript events still flow; they simply carry no run.
   */
  unattributed<T>(handle: () => T): T {
    this.attributionSuspended += 1;
    try {
      return handle();
    } finally {
      this.attributionSuspended -= 1;
    }
  }

  /** The run an event emitted now belongs to, if any. */
  private currentRun(): ProviderRunId | undefined {
    return this.attributionSuspended > 0 ? undefined : this.openRun;
  }

  private withRun<E extends AdapterEvent>(event: E): E {
    const run = this.currentRun();
    return run === undefined ? event : { ...event, run };
  }

  /** A turn's message starts, opening the turn's provider run unless one is open. */
  messageStarted(streamId: string): void {
    this.currentContent = [];
    this.bufferedToolCompletions = [];
    this.pendingHostCommand = undefined;
    this.currentStartedAt = new Date().toISOString();
    if (this.openRun === undefined && this.attributionSuspended === 0)
      this.openRun = ++this.lastRun;
    this.emit(this.withRun({ type: "messageStarted", streamId }));
  }

  messageDelta(
    streamId: string,
    kind: "text" | "thinking",
    text: string,
  ): void {
    appendDelta(this.currentContent, kind, text);
    this.emit(
      this.withRun({ type: "messageDelta", streamId, delta: { kind, text } }),
    );
  }

  toolStarted(toolCallId: string, name: string, input: unknown): void {
    this.currentContent.push({ type: "toolCall", toolCallId, name, input });
    this.emit(
      this.withRun({
        type: "toolStarted",
        streamId: toolCallId,
        toolCallId,
        name,
        input,
      }),
    );
  }

  toolUpdated(toolCallId: string, output: string): void {
    this.emit(
      this.withRun({ type: "toolUpdated", streamId: toolCallId, output }),
    );
  }

  toolCompleted(envelope: Extract<ServerMessage, { type: "toolEnd" }>): void {
    const run = this.currentRun();
    this.bufferedToolCompletions.push({
      type: "toolCompleted",
      streamId: envelope.toolId,
      toolCallId: envelope.toolId,
      content: [{ type: "text", text: envelope.output }],
      ...(envelope.isError ? { isError: true } : {}),
      ...(envelope.resultDiff !== undefined
        ? { resultDiff: envelope.resultDiff }
        : {}),
      ...(run !== undefined ? { run } : {}),
    });
    this.emit({
      type: "passthrough",
      envelope,
      ...(run !== undefined ? { run } : {}),
    });
  }

  hostCommandCard(
    name: string,
    card: HostCommandCard,
    envelope: ServerMessage,
  ): void {
    this.pendingHostCommand = { name, card };
    this.emit({ type: "passthrough", envelope });
  }

  hostCommandDiscarded(): void {
    this.resetTurn();
    this.closeRun();
    this.emit({ type: "hostCommandDiscarded" });
  }

  providerNotice(
    notice: Extract<AdapterEvent, { type: "providerNotice" }>,
  ): void {
    this.emit(notice);
  }

  /**
   * Provider activity with no delta of its own (the contract's
   * `providerActivity`). Dropped outside an open run: nothing to credit it to.
   */
  providerActivity(kind: ProviderActivityKind): void {
    const run = this.currentRun();
    if (run === undefined) return;
    this.emit({ type: "providerActivity", kind, run });
  }

  /** A provider retry report, for the open run only. */
  providerRetry(
    retry: Omit<
      Extract<AdapterEvent, { type: "providerRetry" }>,
      "type" | "run"
    >,
  ): void {
    const run = this.currentRun();
    if (run === undefined) return;
    this.emit({ type: "providerRetry", ...retry, run });
  }

  /**
   * Persist one assistant attempt while keeping its logical provider run open.
   * Pi uses this before an automatic retry/compaction continuation: the next
   * assistant message is distinct, but runtime idle waits for `agent_settled`.
   */
  messageAttemptCompleted(
    streamId: string,
    options: {
      model?: string;
      usage?: AgentUsage;
      providerMessageId?: string;
    } = {},
  ): void {
    this.emitMessageCompleted(streamId, options);
    this.flushToolCompletions();
    this.resetTurn();
  }

  /** Complete a logical run that has no currently open assistant attempt. */
  runCompleted(
    stopReason: "end" | "error" | "aborted",
    errorMessage?: string,
    failure?: RunFailureFacts,
  ): void {
    this.flushToolCompletions();
    const run = this.closeRun();
    this.emit({
      type: "runCompleted",
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
      ...(errorMessage && failure ? { failure } : {}),
      ...(run !== undefined ? { run } : {}),
    });
    this.resetTurn();
  }

  messageCompleted(
    streamId: string,
    options: {
      model?: string;
      usage?: AgentUsage;
      errorMessage?: string;
      /** Structured facts about `errorMessage`, when the harness has them. */
      failure?: RunFailureFacts;
      aborted?: boolean;
      /** The abort was asked for, not the provider's own (see the contract). */
      abortRequested?: boolean;
      /** Native id of the message this turn ended on — the fork/resume anchor. */
      providerMessageId?: string;
    } = {},
  ): void {
    if (options.aborted) {
      this.emitMessageCompleted(streamId, {
        ...options,
        stopReason: "aborted",
      });
      this.flushToolCompletions();
      const run = this.closeRun();
      this.emit({
        type: "runCompleted",
        stopReason: options.errorMessage ? "error" : "aborted",
        ...runFailureFields(options),
        ...(options.abortRequested ? { abortRequested: true as const } : {}),
        ...(run !== undefined ? { run } : {}),
      });
      this.resetTurn();
      return;
    }

    if (this.pendingHostCommand) {
      const { name, card } = this.pendingHostCommand;
      this.resetTurn();
      this.closeRun();
      this.emit({ type: "hostCommandResult", name, card });
      return;
    }

    const stopReason = options.errorMessage ? "error" : undefined;
    this.emitMessageCompleted(streamId, {
      ...options,
      ...(stopReason ? { stopReason } : {}),
    });
    this.flushToolCompletions();
    const run = this.closeRun();
    this.emit({
      type: "runCompleted",
      stopReason: options.errorMessage ? "error" : "end",
      ...runFailureFields(options),
      ...(run !== undefined ? { run } : {}),
    });
    this.resetTurn();
  }

  private emitMessageCompleted(
    streamId: string,
    options: {
      model?: string;
      usage?: AgentUsage;
      errorMessage?: string;
      failure?: RunFailureFacts;
      stopReason?: "aborted" | "error";
      providerMessageId?: string;
    },
  ): void {
    const run = this.currentRun();
    this.emit({
      type: "messageCompleted",
      streamId,
      content: this.currentContent.map(cloneContentBlock),
      ...(options.providerMessageId
        ? { providerMessageId: options.providerMessageId }
        : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.usage ? { usage: options.usage } : {}),
      ...(this.currentStartedAt
        ? {
            startedAt: this.currentStartedAt,
            completedAt: new Date().toISOString(),
          }
        : {}),
      ...(options.stopReason ? { stopReason: options.stopReason } : {}),
      // Carry the provider error text onto the completed turn so it is persisted
      // durably on the assistant entry and rendered inline in that session's chat
      // (not only as a transient banner that a later broadcast can clear).
      ...(options.errorMessage ? { error: options.errorMessage } : {}),
      ...(options.errorMessage && options.failure
        ? { failure: options.failure }
        : {}),
      // The run it belongs to, so the runtime can tell a straggler of an
      // earlier run from the open one before acting on a failure in it.
      ...(run !== undefined ? { run } : {}),
    });
  }

  /**
   * The turn is over: nothing the harness emits from here belongs to its run.
   * Returns the run it closed, which the closing event still names.
   */
  private closeRun(): ProviderRunId | undefined {
    const run = this.currentRun();
    this.openRun = undefined;
    return run;
  }

  private flushToolCompletions(): void {
    for (const event of this.bufferedToolCompletions) this.emit(event);
  }

  private resetTurn(): void {
    this.currentContent = [];
    this.bufferedToolCompletions = [];
    this.pendingHostCommand = undefined;
    this.currentStartedAt = undefined;
  }

  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // isolate a faulty consumer
      }
    }
  }
}

/** Cumulative session token/cost totals, as both harnesses track them. */
export interface CumulativeUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/**
 * Build ONE completed run's durable {@link AgentUsage} from cumulative session
 * totals sampled before the run started and after it completed. Entry usage is
 * per-run by contract (see `AgentUsage`); attaching a cumulative snapshot instead
 * would double-count in every consumer that sums entries (session stats, the
 * chat's turn/session stats rows, SQLite usage totals).
 *
 * Returns undefined when the run billed nothing (e.g. aborted before the first
 * provider response), so no zero-usage row is rendered. Deltas are clamped at 0
 * as a defensive floor. `context` carries the REAL prompt-side context size
 * after the run (a snapshot the harness tracks separately) plus the model's
 * context window.
 */
export function perTurnUsage(
  before: CumulativeUsageTotals | undefined,
  after: CumulativeUsageTotals,
  context: { tokens?: number | null; window?: number } = {},
): AgentUsage | undefined {
  const base = before ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  const input = Math.max(0, after.input - base.input);
  const output = Math.max(0, after.output - base.output);
  const cacheRead = Math.max(0, after.cacheRead - base.cacheRead);
  const cacheWrite = Math.max(0, after.cacheWrite - base.cacheWrite);
  const cost = Math.max(0, after.cost - base.cost);
  if (input + output + cacheRead + cacheWrite === 0 && cost === 0)
    return undefined;
  return {
    ...(input ? { inputTokens: input } : {}),
    ...(output ? { outputTokens: output } : {}),
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite ? { cacheCreationTokens: cacheWrite } : {}),
    ...(cost ? { costUSD: cost } : {}),
    ...(context.tokens ? { contextTokens: context.tokens } : {}),
    ...(context.window ? { contextWindowTokens: context.window } : {}),
  };
}

function appendDelta(
  content: AgentContentBlock[],
  kind: "text" | "thinking",
  text: string,
): void {
  const last = content[content.length - 1];
  if (last && last.type === kind) last.text += text;
  else content.push({ type: kind, text });
}

function cloneContentBlock(block: AgentContentBlock): AgentContentBlock {
  return { ...block };
}
