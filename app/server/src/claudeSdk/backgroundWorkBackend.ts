import type {
  BackgroundWorkBackendPort,
  BackgroundWorkHostCloseAck,
  BackgroundWorkHostCloseRequest,
  BackgroundWorkLaunchAck,
  BackgroundWorkLaunchRequest,
  BackgroundWorkStopAck,
  BackgroundWorkStopAllAck,
  BackgroundWorkStopAllRequest,
  BackgroundWorkStopRequest,
} from "../backgroundWork/backends.ts";
import { backgroundWorkSupervisor } from "../backgroundWork/supervisor.ts";

interface ClaudeBackgroundHostController {
  ownerSessionId: string;
  hostEpochKey: string;
  /** Trusted provider-output root captured when this epoch is registered. */
  outputRoot: string;
  stopProviderTask(providerTaskId: string): Promise<void>;
  interruptBackgroundTurn(reason: string): Promise<void>;
  close(reason: string): Promise<void>;
}

interface ItemBinding {
  itemId: string;
  toolUseId?: string;
  providerTaskId?: string;
}

interface HostState {
  controller: ClaudeBackgroundHostController;
  outputRoot: string;
  items: Map<string, ItemBinding>;
  itemByToolUse: Map<string, string>;
  itemByProviderTask: Map<string, string>;
  announcedTasks: Map<string, { taskType: string; description: string }>;
  completedProviderTasks: Set<string>;
  lastCompletedItemId?: string;
  stopAllRequested: boolean;
}

function key(ownerSessionId: string, hostEpochKey: string): string {
  return `${ownerSessionId}\u0000${hostEpochKey}`;
}

/**
 * Claude's provider-specific side of the background-work port. All mutable
 * state is scoped to one owner/epoch, so deployment may stop or close distinct
 * owners concurrently without a process-global current target.
 */
class ClaudeBackgroundWorkBackend implements BackgroundWorkBackendPort {
  readonly backend = "claude-query" as const;
  private readonly hosts = new Map<string, HostState>();

  registerHost(controller: ClaudeBackgroundHostController): () => void {
    const hostKey = key(controller.ownerSessionId, controller.hostEpochKey);
    if (this.hosts.has(hostKey))
      throw new Error(
        `Claude background host ${controller.hostEpochKey} is already registered`,
      );
    const host: HostState = {
      controller,
      outputRoot: controller.outputRoot,
      items: new Map(),
      itemByToolUse: new Map(),
      itemByProviderTask: new Map(),
      announcedTasks: new Map(),
      completedProviderTasks: new Set(),
      stopAllRequested: false,
    };
    this.hosts.set(hostKey, host);
    return () => {
      if (this.hosts.get(hostKey) === host) this.hosts.delete(hostKey);
    };
  }

  reserveItem(
    ownerSessionId: string,
    hostEpochKey: string,
    itemId: string,
    toolUseId: string,
  ): void {
    const host = this.requireHost(ownerSessionId, hostEpochKey);
    const existing = host.itemByToolUse.get(toolUseId);
    if (existing && existing !== itemId)
      throw new Error(`Claude tool use ${toolUseId} is already reserved`);
    host.items.set(itemId, { itemId, toolUseId });
    host.itemByToolUse.set(toolUseId, itemId);
  }

  observeItem(
    ownerSessionId: string,
    hostEpochKey: string,
    itemId: string,
    providerTaskId: string,
  ): void {
    const host = this.requireHost(ownerSessionId, hostEpochKey);
    host.items.set(itemId, { itemId, providerTaskId });
    host.itemByProviderTask.set(providerTaskId, itemId);
  }

  bindProviderTask(
    ownerSessionId: string,
    hostEpochKey: string,
    providerTaskId: string,
    toolUseId?: string,
  ): string | undefined {
    const host = this.requireHost(ownerSessionId, hostEpochKey);
    const already = host.itemByProviderTask.get(providerTaskId);
    if (already) return already;
    if (!toolUseId) return undefined;
    const itemId = host.itemByToolUse.get(toolUseId);
    if (!itemId) return undefined;
    const binding = host.items.get(itemId) ?? { itemId };
    binding.providerTaskId = providerTaskId;
    host.items.set(itemId, binding);
    host.itemByProviderTask.set(providerTaskId, itemId);
    return itemId;
  }

  itemForProviderTask(
    ownerSessionId: string,
    hostEpochKey: string,
    providerTaskId: string,
  ): string | undefined {
    return this.hosts
      .get(key(ownerSessionId, hostEpochKey))
      ?.itemByProviderTask.get(providerTaskId);
  }

  providerTaskWasCompleted(
    ownerSessionId: string,
    hostEpochKey: string,
    providerTaskId: string,
  ): boolean {
    return (
      this.hosts
        .get(key(ownerSessionId, hostEpochKey))
        ?.completedProviderTasks.has(providerTaskId) ?? false
    );
  }

  itemForToolUse(
    ownerSessionId: string,
    hostEpochKey: string,
    toolUseId: string,
  ): string | undefined {
    return this.hosts
      .get(key(ownerSessionId, hostEpochKey))
      ?.itemByToolUse.get(toolUseId);
  }

  outputRoot(ownerSessionId: string, hostEpochKey: string): string | undefined {
    return this.hosts.get(key(ownerSessionId, hostEpochKey))?.outputRoot;
  }

  replaceAnnouncedTasks(
    ownerSessionId: string,
    hostEpochKey: string,
    tasks: Array<{ taskId: string; taskType: string; description: string }>,
  ): void {
    const host = this.requireHost(ownerSessionId, hostEpochKey);
    host.announcedTasks = new Map(
      tasks.map((task) => [
        task.taskId,
        { taskType: task.taskType, description: task.description },
      ]),
    );
  }

  announcedTask(
    ownerSessionId: string,
    hostEpochKey: string,
    providerTaskId: string,
  ): { taskType: string; description: string } | undefined {
    return this.hosts
      .get(key(ownerSessionId, hostEpochKey))
      ?.announcedTasks.get(providerTaskId);
  }

  completeItem(
    ownerSessionId: string,
    hostEpochKey: string,
    itemId: string,
  ): void {
    const host = this.hosts.get(key(ownerSessionId, hostEpochKey));
    const binding = host?.items.get(itemId);
    if (!host || !binding) return;
    this.removeBinding(host, binding);
  }

  activeItemCount(ownerSessionId: string, hostEpochKey: string): number {
    return this.hosts.get(key(ownerSessionId, hostEpochKey))?.items.size ?? 0;
  }

  registeredHostCount(ownerSessionId: string): number {
    return [...this.hosts.values()].filter(
      (host) => host.controller.ownerSessionId === ownerSessionId,
    ).length;
  }

  activeBindings(
    ownerSessionId: string,
    hostEpochKey: string,
  ): Array<{ itemId: string; providerTaskId?: string }> {
    const host = this.hosts.get(key(ownerSessionId, hostEpochKey));
    return [...(host?.items.values() ?? [])].map((binding) => ({
      itemId: binding.itemId,
      ...(binding.providerTaskId
        ? { providerTaskId: binding.providerTaskId }
        : {}),
    }));
  }

  firstActiveItemId(
    ownerSessionId: string,
    hostEpochKey: string,
  ): string | undefined {
    const host = this.hosts.get(key(ownerSessionId, hostEpochKey));
    return host?.items.keys().next().value ?? host?.lastCompletedItemId;
  }

  stopAllWasRequested(ownerSessionId: string, hostEpochKey: string): boolean {
    return (
      this.hosts.get(key(ownerSessionId, hostEpochKey))?.stopAllRequested ??
      true
    );
  }

  launch(
    request: BackgroundWorkLaunchRequest,
  ): Promise<BackgroundWorkLaunchAck> {
    const epoch = request.target.hostEpochKey;
    if (!epoch)
      return Promise.resolve({
        launched: false,
        reason: "the Claude item has no host epoch",
      });
    const host = this.hosts.get(key(request.target.ownerSessionId, epoch));
    return Promise.resolve({
      launched: Boolean(host?.items.has(request.target.itemId)),
      ...(!host?.items.has(request.target.itemId)
        ? { reason: "the retained Claude host no longer owns this launch" }
        : {}),
    });
  }

  async stop(
    request: BackgroundWorkStopRequest,
  ): Promise<BackgroundWorkStopAck> {
    const epoch = request.target.hostEpochKey;
    if (!epoch)
      return {
        acknowledged: false,
        evidence: "the Claude item has no host epoch",
      };
    const host = this.hosts.get(key(request.target.ownerSessionId, epoch));
    const binding = host?.items.get(request.target.itemId);
    if (!host || !binding?.providerTaskId)
      return {
        acknowledged: false,
        evidence: "the provider task has not been bound",
      };
    try {
      await host.controller.stopProviderTask(binding.providerTaskId);
      this.removeBinding(host, binding);
      return { acknowledged: true };
    } catch (error) {
      return {
        acknowledged: false,
        evidence:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Claude did not acknowledge Stop",
      };
    }
  }

  async stopAll(
    request: BackgroundWorkStopAllRequest,
  ): Promise<BackgroundWorkStopAllAck> {
    const hosts = [...this.hosts.values()].filter(
      (host) => host.controller.ownerSessionId === request.ownerSessionId,
    );
    const acknowledgedItemIds: string[] = [];
    const unconfirmedItemIds: string[] = [];
    await Promise.all(
      hosts.map(async (host) => {
        host.stopAllRequested = true;
        // A caller-owned Stop-all is inside the very provider/tool turn that
        // must survive. Human Stop-all keeps its special ability to interrupt
        // a background-origin turn; the controller self-checks whether the
        // current turn is provider-origin, as it did before this caller guard.
        if (request.callerSessionId !== request.ownerSessionId)
          await host.controller
            .interruptBackgroundTurn(request.reason)
            .catch(() => undefined);
        await Promise.all(
          [...host.items.values()].map(async (binding) => {
            if (!binding.providerTaskId) {
              unconfirmedItemIds.push(binding.itemId);
              return;
            }
            try {
              await host.controller.stopProviderTask(binding.providerTaskId);
              this.removeBinding(host, binding);
              acknowledgedItemIds.push(binding.itemId);
            } catch {
              unconfirmedItemIds.push(binding.itemId);
            }
          }),
        );
      }),
    );
    return { acknowledgedItemIds, unconfirmedItemIds };
  }

  async closeHost(
    request: BackgroundWorkHostCloseRequest,
  ): Promise<BackgroundWorkHostCloseAck> {
    const host = this.hosts.get(
      key(request.ownerSessionId, request.hostEpochKey),
    );
    if (!host) return { closed: true };
    try {
      await host.controller.close(request.reason);
      return { closed: true };
    } catch (error) {
      return {
        closed: false,
        reason:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Claude host close failed",
      };
    }
  }

  private removeBinding(host: HostState, binding: ItemBinding): void {
    host.items.delete(binding.itemId);
    host.lastCompletedItemId = binding.itemId;
    if (binding.toolUseId) host.itemByToolUse.delete(binding.toolUseId);
    if (binding.providerTaskId) {
      host.itemByProviderTask.delete(binding.providerTaskId);
      host.announcedTasks.delete(binding.providerTaskId);
      host.completedProviderTasks.add(binding.providerTaskId);
    }
  }

  private requireHost(ownerSessionId: string, hostEpochKey: string): HostState {
    const host = this.hosts.get(key(ownerSessionId, hostEpochKey));
    if (!host)
      throw new Error(`Claude background host ${hostEpochKey} is unavailable`);
    return host;
  }
}

export const claudeBackgroundWorkBackend = new ClaudeBackgroundWorkBackend();
let registered = false;

/** Register the process singleton once. Constructors call this for test parity. */
export function registerClaudeBackgroundWorkBackend(): void {
  if (registered) return;
  backgroundWorkSupervisor.registerBackend(claudeBackgroundWorkBackend);
  registered = true;
}
