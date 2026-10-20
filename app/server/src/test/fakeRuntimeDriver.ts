/**
 * A minimal, controllable {@link RuntimePromptDriver} + {@link PromptableAdapter}
 * pair for tests that need to drive REAL runtime prompts (peer-prompt delivery,
 * idle hooks, retry paths) without a real pi/Claude session. Backed by the real
 * `sessionRuntime` singleton (file-backed under the test's temp DATA_DIR), so
 * durable log entries persist normally; only the provider turn itself is faked.
 */
import type { AgentType, Harness } from "@assistant/shared";
import type {
  AgentRunResult,
  ForkCapability,
  PromptableAdapter,
  PromptOptions,
  AdapterEvent,
} from "../session/adapters/contract.ts";
import type { RuntimePromptDriver } from "../session/runtimePrompt.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";

export type FakeTurnBehavior =
  | { mode: "success" }
  | { mode: "error"; message: string }
  | { mode: "reject"; message: string };

class FakePromptableAdapter implements PromptableAdapter {
  readonly provider = "fake";
  readonly capabilities: ForkCapability;
  /** The options of the most recent turn, for tests asserting what was sent. */
  lastPromptOptions: PromptOptions | undefined;
  private readonly listeners = new Set<(event: AdapterEvent) => void>();
  constructor(
    private readonly behavior: () => FakeTurnBehavior,
    private readonly record: (
      text: string,
      options: PromptOptions | undefined,
    ) => void,
    attachments = false,
    /** Resolves when the held turn may finish; absent means "finish now". */
    private readonly gate: () => Promise<void> | undefined = () => undefined,
    /**
     * When present, the run completes (its idle edge) first and the prompt
     * call answers only once this resolves, as a harness that still settles
     * its provider call after the run closed.
     */
    private readonly settle: () => Promise<void> | undefined = () => undefined,
  ) {
    // The runtime DROPS attachments for an adapter that cannot take them
    // (`liveSession.ts`), so a test about attachments has to opt in.
    this.capabilities = { fork: "none", compact: false, attachments };
  }
  subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getBinding() {
    return { provider: "fake" };
  }
  async prompt(text: string, options?: PromptOptions): Promise<AgentRunResult> {
    this.lastPromptOptions = options;
    this.record(text, options);
    // A held turn keeps the session RUNNING, which is what tests about busy
    // sessions (steering, queued handoffs, peer drains) are actually about.
    await this.gate();
    const behavior = this.behavior();
    if (behavior.mode === "reject") throw new Error(behavior.message);
    if (behavior.mode === "error")
      return { stopReason: "error", errorMessage: behavior.message };
    const settle = this.settle();
    if (settle) {
      for (const listener of this.listeners)
        listener({ type: "runCompleted", stopReason: "end" });
      await settle;
    }
    return { stopReason: "end" };
  }
  abort(): void {}
  setModel(): void {}
  setReasoning(): void {}
  dispose(): void {}
}

/** A fake live driver whose next-turn behavior is settable per test step. */
export class FakeRuntimeDriver implements RuntimePromptDriver {
  readonly id: string;
  readonly key: string;
  readonly sessionId: string;
  readonly harness: Harness = "pi";
  readonly agentType: AgentType = "assistant";
  readonly sessionFile: string | undefined = undefined;
  readonly canSteer = false;
  behavior: FakeTurnBehavior = { mode: "success" };
  /** Options of every turn this driver has run, oldest first. */
  readonly promptOptions: Array<PromptOptions | undefined> = [];
  /** The model text of every turn this driver has run, oldest first. */
  readonly promptTexts: string[] = [];
  /** Opt in to attachment forwarding; off by default, as most fakes do not care. */
  acceptsAttachments = false;
  private gate: Promise<void> | undefined;
  private settleGate: Promise<void> | undefined;

  constructor(id: string) {
    this.id = id;
    this.key = id;
    this.sessionId = id;
  }

  get isRunning(): boolean {
    return sessionRuntime.isRunning(this.sessionId);
  }

  contextInfo(): ReturnType<RuntimePromptDriver["contextInfo"]> {
    return {
      sessionId: this.sessionId,
      updatedAt: Date.now(),
      messageCounts: {
        user: 0,
        assistant: 0,
        toolCalls: 0,
        toolResults: 0,
        total: 0,
      },
      tokenUsage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
      cost: 0,
    };
  }

  broadcastState(): void {}

  /**
   * Keep every turn this driver starts open until the returned release runs, so
   * a test can observe the session while it is genuinely mid-turn.
   */
  holdTurns(): () => void {
    let release: () => void = () => {};
    this.gate = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.gate = undefined;
      release();
    };
  }

  /**
   * End every successful turn this driver starts with its run completion — the
   * session goes idle — but keep the prompt call itself pending until the
   * returned release runs, so a test can act inside that gap.
   */
  holdSettle(): () => void {
    let release: () => void = () => {};
    this.settleGate = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.settleGate = undefined;
      release();
    };
  }

  createRuntimeAdapter(): PromptableAdapter {
    return new FakePromptableAdapter(
      () => this.behavior,
      (text, options) => {
        this.promptTexts.push(text);
        this.promptOptions.push(options);
      },
      this.acceptsAttachments,
      () => this.gate,
      () => this.settleGate,
    );
  }
}
