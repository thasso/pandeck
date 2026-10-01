/**
 * Claude SDK adapter. Presents an in-process Claude SDK session as a
 * {@link PromptableAdapter} emitting the normalized {@link AdapterEvent}
 * vocabulary the runtime ingests.
 *
 * The owning ClaudeSdkSession emits adapter-native events directly. This adapter
 * only drives the private prompt closure, forwards events, and exposes config
 * controls to the runtime path.
 */
import type { PromptAttachment, ThinkingLevel } from "@assistant/shared";
import type {
  PromptDelivery,
  SessionConfigModel,
} from "@assistant/shared/session";
import { claudeSdkModelAlias } from "../../claudeSdk/modelSettings.ts";
import type { ProviderBinding } from "../log/identity.ts";
import type {
  AdapterEvent,
  AgentRunResult,
  ForkCapability,
  PromptableAdapter,
  PromptOptions,
} from "./contract.ts";
import type { AdapterEventListener } from "./nativeEvents.ts";

export interface ClaudeSdkAdapterDriver {
  subscribeAdapterEvents(listener: AdapterEventListener): () => void;
  prompt(
    text: string,
    options?: {
      clientRequestId?: string;
      hidden?: boolean;
      attachments?: PromptAttachment[];
    },
  ): Promise<void>;
  /**
   * Hand a message to the RUNNING turn. Resolves once the CLI has decided:
   * `steer` when the turn took it at a tool step, `followUp` when it arrived
   * after the reply and runs next within the same run, `refused` when nothing
   * was sent, `withdrawn` when the turn ended (a Stop, a failure) and the CLI
   * confirmed it dropped the message unread, `uncertain` when the turn ended
   * without that confirmation — it may have been read.
   */
  steer(
    text: string,
    options?: {
      clientRequestId?: string;
      hidden?: boolean;
      attachments?: PromptAttachment[];
      /** Called synchronously when the CLI takes the message. */
      onAccepted?: (delivery: PromptDelivery) => void;
    },
  ): Promise<PromptDelivery | "refused" | "withdrawn" | "uncertain">;
  abort(): void;
  setModel(modelId: string): void | Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void | Promise<void>;
}

export interface ClaudeSdkAdapterDeps {
  providerSessionId?: string;
}

const PROVIDER = "claude-sdk";

export function createClaudeSdkAdapter(
  sessionId: string,
  driver: ClaudeSdkAdapterDriver,
  deps: ClaudeSdkAdapterDeps = {},
): PromptableAdapter {
  return new ClaudeSdkAdapter(sessionId, driver, deps);
}

class ClaudeSdkAdapter implements PromptableAdapter {
  readonly provider = PROVIDER;
  readonly capabilities: ForkCapability = {
    // The SDK branches a transcript at any message uuid (`forkSession`'s
    // `upToMessageId`), so long as the turn carries a bound anchor.
    fork: "arbitrary",
    compact: false,
    // The CLI takes a message written mid-turn at its next tool step, or runs
    // it right after the reply — which of the two is known only later.
    steer: true,
    steerAcceptance: "deferred",
    attachments: true,
  };
  private readonly listeners = new Set<(event: AdapterEvent) => void>();
  private readonly unsubscribeDriver: () => void;
  private boundProviderSessionId: string | undefined;
  private lastError: string | undefined;
  private lastStopReason: AgentRunResult["stopReason"] | undefined;

  constructor(
    readonly sessionId: string,
    private readonly driver: ClaudeSdkAdapterDriver,
    deps: ClaudeSdkAdapterDeps,
  ) {
    this.boundProviderSessionId = deps.providerSessionId;
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
      ...(this.boundProviderSessionId
        ? { nativeId: this.boundProviderSessionId }
        : {}),
    };
  }

  async prompt(
    text: string,
    options: PromptOptions = {},
  ): Promise<AgentRunResult> {
    if (options.steer) {
      // Steer-or-nothing is never promised: a queued message the turn does not
      // fold in still runs after the reply, which is exactly the unasked-for
      // turn `steerOnly` forbids. Its callers fall back to their own queue.
      if (options.steerOnly) return { stopReason: "end", steered: false };
      const delivery = await this.driver.steer(text, {
        ...(options.clientRequestId
          ? { clientRequestId: options.clientRequestId }
          : {}),
        ...(options.hidden ? { hidden: true } : {}),
        ...(options.attachments?.length
          ? { attachments: options.attachments }
          : {}),
        ...(options.onSteerAccepted
          ? { onAccepted: options.onSteerAccepted }
          : {}),
      });
      if (delivery === "refused") return { stopReason: "end" };
      if (delivery === "withdrawn")
        return { stopReason: "end", steerWithdrawn: true };
      if (delivery === "uncertain")
        return {
          stopReason: "end",
          steerWithdrawn: true,
          steerUncertain: true,
        };
      return { stopReason: "end", steerDelivery: delivery };
    }
    this.lastError = undefined;
    this.lastStopReason = undefined;
    await this.driver.prompt(text, {
      ...(options.clientRequestId
        ? { clientRequestId: options.clientRequestId }
        : {}),
      ...(options.hidden ? { hidden: true } : {}),
      ...(options.attachments?.length
        ? { attachments: options.attachments }
        : {}),
    });
    const stopReason =
      this.lastStopReason ?? (this.lastError ? "error" : "end");
    return this.lastError
      ? { stopReason: "error", errorMessage: this.lastError }
      : { stopReason };
  }

  abort(): void {
    this.driver.abort();
  }

  async setModel(model: SessionConfigModel): Promise<void> {
    await this.driver.setModel(model.id);
    this.emit({
      type: "sessionConfigChanged",
      model: { provider: PROVIDER, id: claudeSdkModelAlias(model.id) },
    });
  }

  async setReasoning(level: string): Promise<void> {
    await this.driver.setThinkingLevel(level as ThinkingLevel);
    this.emit({ type: "sessionConfigChanged", reasoning: level });
  }

  async listModels(): Promise<SessionConfigModel[]> {
    const { CLAUDE_SDK_MODELS } =
      await import("../../claudeSdk/modelSettings.ts");
    return CLAUDE_SDK_MODELS.map((m) => ({ provider: PROVIDER, id: m.id }));
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
    if (event.type === "runCompleted") {
      this.lastStopReason = event.stopReason;
      this.lastError = event.errorMessage;
    }
    this.emit(event);
  }
}
