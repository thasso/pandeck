import type {
  BackgroundWorkBackend,
  BackgroundWorkState,
} from "@assistant/shared";
import {
  backgroundWorkStore,
  type BackgroundWorkItem,
} from "../db/backgroundWorkStore.ts";
import { removeSessionArtifact } from "../mcp/toolGroups/packRuntime.ts";
import type {
  BackgroundWorkActivity,
  BackgroundWorkActivityRateExceeded,
  BackgroundWorkBackendEvents,
  BackgroundWorkBackendPort,
  BackgroundWorkCompletion,
  BackgroundWorkHostCloseAck,
  BackgroundWorkHostCloseRequest,
  BackgroundWorkOutputCaptured,
  BackgroundWorkLaunchRequest,
  BackgroundWorkStopAck,
  BackgroundWorkStopAllAck,
  BackgroundWorkStopAllRequest,
  BackgroundWorkTarget,
} from "./backends.ts";
import {
  admitBackgroundWork,
  closeBackgroundWorkAdmissions,
  type BackgroundWorkAdmission,
  type BackgroundWorkAdmissionRequest,
} from "./service.ts";

export const BACKGROUND_STOP_ACK_DEADLINE_MS = 10_000;
const BACKGROUND_STOP_MAX_ATTEMPTS = 2;
export const BACKGROUND_DEPLOYMENT_STOP_REASON = "stopped-for-deployment";
const BACKGROUND_OWNER_TERMINAL_REASON = "stopped-by-owner";
/**
 * The one Stop nobody asked for. Exported so `deliveryPolicy.ts` can be told
 * WHICH kind of stop this was as a typed fact rather than by matching prose.
 */
export const BACKGROUND_EVENT_RATE_TERMINAL_REASON = "stopped-for-event-rate";

const TERMINAL_STATES = new Set<BackgroundWorkState>([
  "completed",
  "failed",
  "not-started",
  "stopped",
  "lost",
]);

export interface BackgroundWorkTimer {
  cancel(): void;
}

export interface BackgroundWorkClock {
  now(): number;
  schedule(delayMs: number, callback: () => void): BackgroundWorkTimer;
}

const systemBackgroundWorkClock: BackgroundWorkClock = {
  now: () => Date.now(),
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, Math.max(0, delayMs));
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

export interface BackgroundWorkStopOneRequest {
  itemId: string;
  ownerSessionId: string;
  sourceRequestId: string;
  reason: string;
}

export interface BackgroundWorkStopAllOwnerRequest {
  ownerSessionId: string;
  /** The caller identity, when this is a model/human owner request. */
  callerSessionId?: string;
  sourceRequestId: string;
  reason: string;
}

export type BackgroundWorkStopResult =
  | { state: "stopped" | "already-terminal"; item: BackgroundWorkItem }
  | { state: "awaiting-binding" | "stop-unconfirmed"; item: BackgroundWorkItem }
  | { state: "not-owner"; item?: BackgroundWorkItem };

export interface BackgroundWorkSupervisorOptions {
  ports?: Iterable<BackgroundWorkBackendPort>;
  clock?: BackgroundWorkClock;
  naturalCompletionGraceMs?: number;
  /** True only while an ordinary prompted turn is inside its safe boundary. */
  ordinaryTurnActive?: (ownerSessionId: string) => boolean;
  /** Called for a bounded lossy non-terminal batch. It may merely enqueue delivery. */
  activityRecorded?: (
    item: BackgroundWorkItem,
    activity: BackgroundWorkActivity,
  ) => void;
  /** Called after the completion fact is durable. It may merely enqueue delivery. */
  completionRecorded?: (item: BackgroundWorkItem) => void;
  reportError?: (message: string) => void;
}

function boundedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

function targetOf(item: BackgroundWorkItem): BackgroundWorkTarget {
  const host = item.hostId
    ? backgroundWorkStore.getHost(item.hostId)
    : undefined;
  return {
    itemId: item.id,
    ownerSessionId: item.ownerSessionId,
    kind: item.kind,
    ...(host ? { hostEpochKey: host.epochKey } : {}),
  };
}

function allActiveItems(): BackgroundWorkItem[] {
  const result: BackgroundWorkItem[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = backgroundWorkStore.listItems({
      state: "active",
      limit: 200,
      offset,
    });
    result.push(...page);
    if (page.length < 200) return result;
  }
}

/**
 * Provider-neutral owner of launch, deadlines, Stop, completion and drain.
 * Provider adapters register ports; this class never imports either provider.
 */
export class BackgroundWorkSupervisor implements BackgroundWorkBackendEvents {
  private readonly ports = new Map<
    BackgroundWorkBackend,
    BackgroundWorkBackendPort
  >();
  private readonly clock: BackgroundWorkClock;
  private readonly naturalCompletionGraceMs: number;
  private ordinaryTurnActive: (ownerSessionId: string) => boolean;
  private activityRecorded:
    | ((item: BackgroundWorkItem, activity: BackgroundWorkActivity) => void)
    | undefined;
  private completionRecorded: ((item: BackgroundWorkItem) => void) | undefined;
  private readonly reportError: (message: string) => void;
  private readonly deadlineTimers = new Map<string, BackgroundWorkTimer>();
  private readonly pendingStopSources = new Map<string, string>();
  private draining = false;

  constructor(options: BackgroundWorkSupervisorOptions = {}) {
    this.clock = options.clock ?? systemBackgroundWorkClock;
    this.naturalCompletionGraceMs = options.naturalCompletionGraceMs ?? 10_000;
    this.ordinaryTurnActive = options.ordinaryTurnActive ?? (() => false);
    this.activityRecorded = options.activityRecorded;
    this.completionRecorded = options.completionRecorded;
    this.reportError =
      options.reportError ??
      ((message) => console.warn(`[background] ${message}`));
    for (const port of options.ports ?? []) this.registerBackend(port);
  }

  setActivityRecordedHandler(
    handler:
      | ((item: BackgroundWorkItem, activity: BackgroundWorkActivity) => void)
      | undefined,
  ): void {
    this.activityRecorded = handler;
  }

  setCompletionRecordedHandler(
    handler: ((item: BackgroundWorkItem) => void) | undefined,
  ): void {
    this.completionRecorded = handler;
  }

  setOrdinaryTurnActiveHandler(
    handler: (ownerSessionId: string) => boolean,
  ): void {
    this.ordinaryTurnActive = handler;
  }

  registerBackend(port: BackgroundWorkBackendPort): void {
    if (this.ports.has(port.backend))
      throw new Error(
        `background backend ${port.backend} is already registered`,
      );
    this.ports.set(port.backend, port);
  }

  admit(request: BackgroundWorkAdmissionRequest): BackgroundWorkAdmission {
    const admission = admitBackgroundWork({
      ...request,
      now: request.now ?? this.clock.now(),
    });
    if (admission.admitted && !TERMINAL_STATES.has(admission.item.state))
      this.armDeadline(admission.item);
    return admission;
  }

  async launch(
    admission: BackgroundWorkAdmission,
  ): Promise<BackgroundWorkItem | undefined> {
    if (!admission.admitted) return undefined;
    const current = backgroundWorkStore.getItem(admission.item.id);
    if (!current || current.state !== "pending-launch") return current;
    const port = this.requirePort(current.backend);
    const request: BackgroundWorkLaunchRequest = {
      target: targetOf(current),
      deadlineAt: current.deadlineAt,
      emptyHostGraceMs: admission.frozen.claudeEmptyHostGraceMs ?? 0,
    };
    let ack;
    try {
      ack = await port.launch(request);
    } catch (error) {
      return backgroundWorkStore.failLaunch({
        itemId: current.id,
        reason: boundedError(error),
        now: this.clock.now(),
      });
    }
    const afterLaunch = backgroundWorkStore.getItem(current.id);
    if (!afterLaunch || TERMINAL_STATES.has(afterLaunch.state))
      return afterLaunch;
    if (!ack.launched)
      return backgroundWorkStore.failLaunch({
        itemId: current.id,
        reason: ack.reason ?? "the background backend did not start the work",
        now: this.clock.now(),
      });
    let running = backgroundWorkStore.markRunning({
      itemId: current.id,
      now: this.clock.now(),
    });
    if (ack.binding) {
      running = backgroundWorkStore.bindProvider({
        ...ack.binding,
        now: this.clock.now(),
      });
      this.resumeStopAfterBinding(running);
    }
    this.armDeadline(running);
    return running;
  }

  providerBound(binding: {
    itemId: string;
    providerTaskId: string;
    providerTaskType?: string;
  }): void {
    const item = backgroundWorkStore.bindProvider({
      ...binding,
      now: this.clock.now(),
    });
    this.resumeStopAfterBinding(item);
  }

  activity(activity: BackgroundWorkActivity): void {
    if (this.draining) return;
    const item = backgroundWorkStore.getItem(activity.itemId);
    if (!item || TERMINAL_STATES.has(item.state)) return;
    this.activityRecorded?.(item, activity);
  }

  activityRateExceeded(event: BackgroundWorkActivityRateExceeded): void {
    if (this.draining) return;
    const item = backgroundWorkStore.getItem(event.itemId);
    if (!item || TERMINAL_STATES.has(item.state)) return;
    void this.stopOne(
      {
        itemId: item.id,
        ownerSessionId: item.ownerSessionId,
        sourceRequestId: event.eventId,
        reason: `this monitor produced more than ${event.notificationCount - 1} notifications in ${Math.round(event.windowMs / 1000)}s and was stopped. Restart it with a filter that emits only the lines you would act on.`,
      },
      BACKGROUND_EVENT_RATE_TERMINAL_REASON,
    )
      .then((result) => {
        // A targeted Stop terminalizes the row ITSELF and the backend suppresses
        // its own `completed` event once stopping, so this is the only path that
        // can hand the fact to delivery. Every other Stop has a requester holding
        // the answer already; this one has none, which is the whole reason the
        // rate limit stops rather than merely muting. Only `stopped` notifies:
        // `already-terminal` means `completed` beat us here and has notified,
        // and `stop-unconfirmed` leaves a nonterminal row with no fact to send.
        if (result.state !== "stopped" || !result.item || this.draining) return;
        this.completionRecorded?.(result.item);
      })
      .catch((error) =>
        this.reportAsyncFailure(
          `event-rate Stop failed for ${item.id}: ${boundedError(error)}`,
        ),
      );
  }

  outputCaptured(output: BackgroundWorkOutputCaptured): void {
    const before = backgroundWorkStore.getItem(output.itemId);
    const artifactId = output.evidence.artifactId;
    if (!before || TERMINAL_STATES.has(before.state)) {
      if (before && artifactId)
        removeSessionArtifact(before.ownerSessionId, artifactId);
      return;
    }
    const recorded = backgroundWorkStore.recordEvidence({
      itemId: output.itemId,
      eventId: output.eventId,
      evidence: output.evidence,
      now: this.clock.now(),
    });
    if (artifactId && recorded.evidence?.artifactId !== artifactId)
      removeSessionArtifact(before.ownerSessionId, artifactId);
  }

  completed(completion: BackgroundWorkCompletion): void {
    const before = backgroundWorkStore.getItem(completion.itemId);
    const state =
      completion.state === "completed"
        ? "completed"
        : completion.state === "failed"
          ? "failed"
          : "stopped";
    const item = backgroundWorkStore.terminalize({
      itemId: completion.itemId,
      state,
      ...(completion.exitCode !== undefined
        ? { exitCode: completion.exitCode }
        : {}),
      ...(completion.outcomeSummary !== undefined
        ? { outcomeSummary: completion.outcomeSummary }
        : {}),
      ...(completion.eventId !== undefined
        ? { eventId: completion.eventId }
        : {}),
      ...(completion.sequence !== undefined
        ? { sequence: completion.sequence }
        : {}),
      now: this.clock.now(),
    });
    if (!TERMINAL_STATES.has(item.state)) return;
    this.cancelDeadline(item.id);
    this.pendingStopSources.delete(item.id);
    if (before && !TERMINAL_STATES.has(before.state) && !this.draining)
      this.completionRecorded?.(item);
  }

  async stopOne(
    request: BackgroundWorkStopOneRequest,
    terminalReason: string = BACKGROUND_OWNER_TERMINAL_REASON,
  ): Promise<BackgroundWorkStopResult> {
    const before = backgroundWorkStore.getItem(request.itemId);
    if (!before || before.ownerSessionId !== request.ownerSessionId)
      return { state: "not-owner", ...(before ? { item: before } : {}) };
    const reservation = backgroundWorkStore.requestStop({
      itemId: request.itemId,
      reason: request.reason,
      sourceRequestId: request.sourceRequestId,
      ackDeadlineMs: BACKGROUND_STOP_ACK_DEADLINE_MS,
      now: this.clock.now(),
    });
    if (TERMINAL_STATES.has(reservation.item.state)) {
      this.cancelDeadline(reservation.item.id);
      return {
        state: reservation.preventedLaunch ? "stopped" : "already-terminal",
        item: reservation.item,
      };
    }
    if (!reservation.reserved) {
      return {
        state:
          reservation.item.stopState === "unconfirmed"
            ? "stop-unconfirmed"
            : "awaiting-binding",
        item: reservation.item,
      };
    }
    this.pendingStopSources.set(request.itemId, request.sourceRequestId);
    if (reservation.item.stopState === "awaiting-binding")
      return { state: "awaiting-binding", item: reservation.item };
    return this.runTargetedStop(request, terminalReason);
  }

  async stopAllOwner(
    request: BackgroundWorkStopAllOwnerRequest,
    terminalReason: string = BACKGROUND_OWNER_TERMINAL_REASON,
  ): Promise<BackgroundWorkStopResult[]> {
    const active = allActiveItems().filter(
      (item) => item.ownerSessionId === request.ownerSessionId,
    );
    const byBackend = new Map<BackgroundWorkBackend, BackgroundWorkItem[]>();
    const results: BackgroundWorkStopResult[] = [];
    for (const item of active) {
      const sourceRequestId = `${request.sourceRequestId}:${item.id}`;
      const reservation = backgroundWorkStore.requestStop({
        itemId: item.id,
        reason: request.reason,
        sourceRequestId,
        ackDeadlineMs: BACKGROUND_STOP_ACK_DEADLINE_MS,
        now: this.clock.now(),
      });
      if (reservation.preventedLaunch) {
        this.cancelDeadline(item.id);
        results.push({ state: "stopped", item: reservation.item });
        continue;
      }
      if (!reservation.reserved) {
        results.push({
          state:
            reservation.item.stopState === "unconfirmed"
              ? "stop-unconfirmed"
              : "awaiting-binding",
          item: reservation.item,
        });
        continue;
      }
      this.pendingStopSources.set(item.id, sourceRequestId);
      const list = byBackend.get(item.backend) ?? [];
      list.push(reservation.item);
      byBackend.set(item.backend, list);
    }

    const host = backgroundWorkStore.hostForOwner(request.ownerSessionId);
    if (host) {
      backgroundWorkStore.requestHostStopAll({
        hostId: host.id,
        reason: request.reason,
        now: this.clock.now(),
      });
      if (!byBackend.has(host.backend)) byBackend.set(host.backend, []);
    }

    for (const [backend, reserved] of byBackend) {
      const effectTargets = reserved.filter((reservedItem) => {
        const current = backgroundWorkStore.getItem(reservedItem.id);
        return (
          current?.ownerSessionId === request.ownerSessionId &&
          current.backend === backend &&
          !TERMINAL_STATES.has(current.state) &&
          current.stopState !== "awaiting-binding"
        );
      });
      for (const item of reserved)
        if (!effectTargets.some((target) => target.id === item.id))
          results.push({ state: "awaiting-binding", item });
      const port = this.requirePort(backend);
      let acknowledged = new Set<string>();
      let unconfirmed = new Set(effectTargets.map((item) => item.id));
      for (
        let attempt = 1;
        attempt <= BACKGROUND_STOP_MAX_ATTEMPTS;
        attempt += 1
      ) {
        const ack = await this.stopAllWithDeadline(port, {
          ownerSessionId: request.ownerSessionId,
          ...(request.callerSessionId
            ? { callerSessionId: request.callerSessionId }
            : {}),
          sourceRequestId: request.sourceRequestId,
          attempt: attempt as 1 | 2,
          reason: request.reason,
          protectOrdinaryTurn:
            request.callerSessionId === request.ownerSessionId ||
            this.ordinaryTurnActive(request.ownerSessionId),
        });
        if (!ack) continue;
        acknowledged = new Set(
          ack.acknowledgedItemIds.filter((id) =>
            effectTargets.some((item) => item.id === id),
          ),
        );
        unconfirmed = new Set(
          effectTargets
            .map((item) => item.id)
            .filter(
              (id) =>
                !acknowledged.has(id) || ack.unconfirmedItemIds.includes(id),
            ),
        );
        break;
      }
      for (const item of effectTargets) {
        const current = backgroundWorkStore.getItem(item.id);
        if (!current || TERMINAL_STATES.has(current.state)) {
          if (current)
            results.push({ state: "already-terminal", item: current });
          continue;
        }
        backgroundWorkStore.recordStopAttempt({
          itemId: item.id,
          unconfirmed: unconfirmed.has(item.id),
          ...(unconfirmed.has(item.id)
            ? { evidence: "the backend did not confirm Stop-all" }
            : {}),
          now: this.clock.now(),
        });
        if (acknowledged.has(item.id) && !unconfirmed.has(item.id)) {
          const stopped = backgroundWorkStore.terminalize({
            itemId: item.id,
            state: "stopped",
            reason: terminalReason,
            now: this.clock.now(),
          });
          this.cancelDeadline(item.id);
          results.push({ state: "stopped", item: stopped });
        } else {
          results.push({
            state: "stop-unconfirmed",
            item: backgroundWorkStore.getItem(item.id)!,
          });
        }
      }
    }
    if (
      host &&
      request.callerSessionId !== request.ownerSessionId &&
      !this.ordinaryTurnActive(request.ownerSessionId)
    )
      await this.closeStopAllHost(
        request.ownerSessionId,
        host.epochKey,
        request.reason,
      );
    return results;
  }

  closeAdmissions(): void {
    this.draining = true;
    closeBackgroundWorkAdmissions();
  }

  /** Provider backends use this to refuse an unsolicited turn during drain. */
  get isDraining(): boolean {
    return this.draining;
  }

  /**
   * Close an empty retained host after its frozen quiet grace. The supervisor
   * rechecks durable membership immediately before the provider effect, so a
   * concurrent admission keeps the host alive.
   */
  async closeIdleHost(
    ownerSessionId: string,
    hostEpochKey: string,
    reason: string,
  ): Promise<boolean> {
    const host = backgroundWorkStore.hostForOwner(ownerSessionId);
    if (!host || host.epochKey !== hostEpochKey) return true;
    const active = backgroundWorkStore
      .listItems({ ownerSessionId, state: "active", limit: 200 })
      .some((item) => item.hostId === host.id);
    if (active) return false;
    const port = this.requirePort(host.backend);
    if (!port.closeHost) return false;
    const current = backgroundWorkStore.hostForOwner(ownerSessionId);
    if (!current || current.id !== host.id) return true;
    const ack = await this.closeHostWithDeadline(port, {
      ownerSessionId,
      hostEpochKey,
      reason,
    });
    if (!ack?.closed) return false;
    backgroundWorkStore.setHostState({
      hostId: host.id,
      state: "closed",
      reason,
      now: this.clock.now(),
    });
    return true;
  }

  /** Close a host whose durable Stop-all reservation reached a safe boundary. */
  async closeStopAllHost(
    ownerSessionId: string,
    hostEpochKey: string,
    reason: string,
  ): Promise<boolean> {
    const host = backgroundWorkStore.hostForOwner(ownerSessionId);
    if (
      !host ||
      host.epochKey !== hostEpochKey ||
      host.stopAllRequestedAt === undefined
    )
      return false;
    const port = this.requirePort(host.backend);
    if (!port.closeHost) return false;
    const ack = await this.closeHostWithDeadline(port, {
      ownerSessionId,
      hostEpochKey,
      reason,
    });
    if (!ack?.closed) return false;
    backgroundWorkStore.setHostState({
      hostId: host.id,
      state: "stopped",
      reason,
      now: this.clock.now(),
    });
    return true;
  }

  /** Record fatal provider-process loss and fan it out to every active child. */
  hostLost(ownerSessionId: string, hostEpochKey: string, reason: string): void {
    const host = backgroundWorkStore.hostForOwner(ownerSessionId);
    if (!host || host.epochKey !== hostEpochKey) return;
    const before = backgroundWorkStore
      .listItems({ ownerSessionId, state: "active", limit: 200 })
      .filter((item) => item.hostId === host.id);
    backgroundWorkStore.setHostState({
      hostId: host.id,
      state: "lost",
      reason,
      now: this.clock.now(),
    });
    for (const previous of before) {
      this.cancelDeadline(previous.id);
      this.pendingStopSources.delete(previous.id);
      const item = backgroundWorkStore.getItem(previous.id);
      if (item && !this.draining) this.completionRecorded?.(item);
    }
  }

  async drain(): Promise<void> {
    this.closeAdmissions();
    const sampled = allActiveItems();
    if (sampled.length === 0) return;
    await this.delay(this.naturalCompletionGraceMs);
    const remaining = allActiveItems();
    const owners = new Set(remaining.map((item) => item.ownerSessionId));
    for (const item of remaining)
      backgroundWorkStore.recordPlannedDrain({
        itemId: item.id,
        reason: BACKGROUND_DEPLOYMENT_STOP_REASON,
        now: this.clock.now(),
      });
    await Promise.all(
      [...owners].map((ownerSessionId) =>
        this.stopAllOwner(
          {
            ownerSessionId,
            sourceRequestId: `deployment:${ownerSessionId}:${this.clock.now()}`,
            reason: BACKGROUND_DEPLOYMENT_STOP_REASON,
          },
          BACKGROUND_DEPLOYMENT_STOP_REASON,
        ),
      ),
    );

    await Promise.all(
      [...owners].map(async (ownerSessionId) => {
        const host = backgroundWorkStore.hostForOwner(ownerSessionId);
        if (!host) return;
        const port = this.ports.get(host.backend);
        if (!port?.closeHost) return;
        const current = backgroundWorkStore.hostForOwner(ownerSessionId);
        if (!current || current.id !== host.id) return;
        const ack = await this.closeHostWithDeadline(port, {
          ownerSessionId,
          hostEpochKey: host.epochKey,
          reason: BACKGROUND_DEPLOYMENT_STOP_REASON,
        });
        if (ack?.closed)
          backgroundWorkStore.setHostState({
            hostId: host.id,
            state: "stopped",
            reason: BACKGROUND_DEPLOYMENT_STOP_REASON,
            now: this.clock.now(),
          });
      }),
    );
  }

  private reportAsyncFailure(message: string): void {
    try {
      this.reportError(message);
    } catch {
      // A diagnostic sink may not turn a contained Stop failure back into an
      // unhandled rejection.
    }
  }

  private requirePort(
    backend: BackgroundWorkBackend,
  ): BackgroundWorkBackendPort {
    const port = this.ports.get(backend);
    if (!port)
      throw new Error(`background backend ${backend} is not registered`);
    return port;
  }

  private armDeadline(item: BackgroundWorkItem): void {
    if (TERMINAL_STATES.has(item.state) || this.deadlineTimers.has(item.id))
      return;
    const timer = this.clock.schedule(
      Math.max(0, item.deadlineAt - this.clock.now()),
      () => {
        this.deadlineTimers.delete(item.id);
        void this.stopOne({
          itemId: item.id,
          ownerSessionId: item.ownerSessionId,
          sourceRequestId: `deadline:${item.id}:${item.deadlineAt}`,
          reason: "background work reached its frozen deadline",
        }).catch((error) =>
          this.reportAsyncFailure(
            `deadline Stop failed for ${item.id}: ${boundedError(error)}`,
          ),
        );
      },
    );
    this.deadlineTimers.set(item.id, timer);
  }

  private cancelDeadline(itemId: string): void {
    this.deadlineTimers.get(itemId)?.cancel();
    this.deadlineTimers.delete(itemId);
  }

  private resumeStopAfterBinding(item: BackgroundWorkItem): void {
    if (item.stopState !== "requested") return;
    const sourceRequestId = this.pendingStopSources.get(item.id);
    if (!sourceRequestId) return;
    void this.runTargetedStop(
      {
        itemId: item.id,
        ownerSessionId: item.ownerSessionId,
        sourceRequestId,
        reason: item.stopReason ?? "background work Stop was requested",
      },
      BACKGROUND_OWNER_TERMINAL_REASON,
    ).catch((error) =>
      this.reportAsyncFailure(
        `bound Stop failed for ${item.id}: ${boundedError(error)}`,
      ),
    );
  }

  private async runTargetedStop(
    request: BackgroundWorkStopOneRequest,
    terminalReason: string,
  ): Promise<BackgroundWorkStopResult> {
    for (
      let attempt = 1;
      attempt <= BACKGROUND_STOP_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const current = backgroundWorkStore.getItem(request.itemId);
      if (!current || current.ownerSessionId !== request.ownerSessionId)
        return { state: "not-owner", ...(current ? { item: current } : {}) };
      if (TERMINAL_STATES.has(current.state))
        return { state: "already-terminal", item: current };
      if (current.stopState === "awaiting-binding")
        return { state: "awaiting-binding", item: current };

      const outcome = await this.stopWithDeadline(
        this.requirePort(current.backend),
        current,
        request.sourceRequestId,
        attempt as 1 | 2,
        request.reason,
      );
      const afterEffect = backgroundWorkStore.getItem(current.id);
      if (!afterEffect || TERMINAL_STATES.has(afterEffect.state))
        return afterEffect
          ? { state: "already-terminal", item: afterEffect }
          : { state: "not-owner" };
      const lastAttempt = attempt === BACKGROUND_STOP_MAX_ATTEMPTS;
      backgroundWorkStore.recordStopAttempt({
        itemId: current.id,
        unconfirmed: !outcome.acknowledged && lastAttempt,
        ...(!outcome.acknowledged && lastAttempt
          ? {
              evidence:
                outcome.evidence ??
                "the backend did not acknowledge the targeted Stop",
            }
          : {}),
        now: this.clock.now(),
      });
      if (outcome.acknowledged) {
        const stopped = backgroundWorkStore.terminalize({
          itemId: current.id,
          state: "stopped",
          reason: terminalReason,
          now: this.clock.now(),
        });
        this.cancelDeadline(current.id);
        this.pendingStopSources.delete(current.id);
        return { state: "stopped", item: stopped };
      }
    }
    return {
      state: "stop-unconfirmed",
      item: backgroundWorkStore.getItem(request.itemId)!,
    };
  }

  private closeHostWithDeadline(
    port: BackgroundWorkBackendPort,
    request: BackgroundWorkHostCloseRequest,
  ): Promise<BackgroundWorkHostCloseAck | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = this.clock.schedule(BACKGROUND_STOP_ACK_DEADLINE_MS, () => {
        if (settled) return;
        settled = true;
        resolve(undefined);
      });
      void port.closeHost!(request)
        .then((ack) => {
          if (settled) return;
          settled = true;
          timer.cancel();
          resolve(ack);
        })
        .catch(() => {
          if (settled) return;
          settled = true;
          timer.cancel();
          resolve(undefined);
        });
    });
  }

  private stopAllWithDeadline(
    port: BackgroundWorkBackendPort,
    request: BackgroundWorkStopAllRequest,
  ): Promise<BackgroundWorkStopAllAck | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = this.clock.schedule(BACKGROUND_STOP_ACK_DEADLINE_MS, () => {
        if (settled) return;
        settled = true;
        resolve(undefined);
      });
      void port
        .stopAll(request)
        .then((ack) => {
          if (settled) return;
          settled = true;
          timer.cancel();
          resolve(ack);
        })
        .catch(() => {
          if (settled) return;
          settled = true;
          timer.cancel();
          resolve(undefined);
        });
    });
  }

  private stopWithDeadline(
    port: BackgroundWorkBackendPort,
    item: BackgroundWorkItem,
    sourceRequestId: string,
    attempt: 1 | 2,
    reason: string,
  ): Promise<BackgroundWorkStopAck> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = this.clock.schedule(BACKGROUND_STOP_ACK_DEADLINE_MS, () => {
        if (settled) return;
        settled = true;
        resolve({
          acknowledged: false,
          evidence: "the targeted Stop acknowledgement deadline elapsed",
        });
      });
      void port
        .stop({
          target: targetOf(item),
          sourceRequestId,
          attempt,
          reason,
        })
        .then((ack) => {
          if (settled) return;
          settled = true;
          timer.cancel();
          resolve(ack);
        })
        .catch((error) => {
          if (settled) return;
          settled = true;
          timer.cancel();
          resolve({ acknowledged: false, evidence: boundedError(error) });
        });
    });
  }

  private delay(delayMs: number): Promise<void> {
    if (delayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => this.clock.schedule(delayMs, resolve));
  }
}

/** Process singleton. Provider packages register adapters into this port registry. */
export const backgroundWorkSupervisor = new BackgroundWorkSupervisor();
