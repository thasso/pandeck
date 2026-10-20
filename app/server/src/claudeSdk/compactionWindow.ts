/**
 * The Claude harness's compaction window (`docs/compaction-window.md`).
 *
 * A query starts with the stored window as `autoCompactWindow`, and the CLI
 * fixes it for that query's life: `applyFlagSettings` accepts the key on a
 * running process but changes neither its threshold nor when it compacts
 * (verified live against agent SDK 0.3.296). So a change never reaches a
 * running process. It applies when the next process starts: the next turn of
 * an idle session (ordinary turns close their process), or the restart of a
 * process a turn or background work keeps open.
 *
 * Applied state is per query epoch: the value the epoch STARTED with is the
 * one in effect. It is `confirmed` while that equals the stored value, and
 * `pending` (`process-restart`) once the stored value moved on.
 */
import {
  COMPACTION_WINDOW_AGENT_FLOOR,
  HARNESSES,
  compactionWindowRange,
  effectiveCompactionWindow,
  type CompactionWindowLiveStatus,
} from "@assistant/shared";
import type {
  CompactionWindowApplyResult,
  CompactionWindowLowerResult,
} from "../harness.ts";
import type { ClaudeQuery } from "./sdkSeam.ts";

const CAPABILITY = HARNESSES["claude-sdk"].compactionWindow!;

/**
 * The CLI compacts below the window, by its buffer and output reservation:
 * the threshold is at most this far under it. A window an agent asks for must
 * stay below the reported threshold plus this offset, or it could raise the
 * effective trigger.
 */
const THRESHOLD_MIN_OFFSET = 13_000;

/** How long the agent path waits for the CLI's context report. */
const USAGE_READ_TIMEOUT_MS = 10_000;

type ContextUsage = Awaited<
  ReturnType<NonNullable<ClaudeQuery["getContextUsage"]>>
>;

export interface ClaudeCompactionWindowHost {
  /** The current query epoch, running a turn or retained; never `/compact`. */
  currentEpochKey(): string | undefined;
  modelId(): string;
  modelWindow(): number;
}

interface EpochWindow {
  epochKey: string;
  /** The value the epoch started with; `null` is the provider default. */
  started: number | null;
  trigger?: number;
  disabled?: boolean;
  /** The CLI reported this epoch's auto-compact switch. */
  switchReported?: boolean;
}

/** What the last finished epoch reported, shown while no process runs. */
interface LastReport {
  value: number | null;
  modelId: string;
  trigger?: number;
  disabled?: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function format(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

function refused(
  message: string,
  largestAcceptable?: number,
): CompactionWindowLowerResult {
  return {
    ok: false,
    message,
    ...(largestAcceptable !== undefined ? { largestAcceptable } : {}),
  };
}

export class ClaudeCompactionWindow {
  private epoch: EpochWindow | undefined;
  private lastReport: LastReport | undefined;

  constructor(private readonly host: ClaudeCompactionWindowHost) {}

  /**
   * The value a query starts with for a stored window: clamped into the
   * current model's range, `undefined` for none (or no range).
   */
  startWindow(stored: number | undefined): number | undefined {
    if (stored === undefined) return undefined;
    const available = compactionWindowRange(CAPABILITY, {
      contextWindow: this.host.modelWindow(),
    });
    return "range" in available
      ? effectiveCompactionWindow(available.range, stored)
      : undefined;
  }

  queryStarted(epochKey: string, value: number | undefined): void {
    this.epoch = { epochKey, started: value ?? null };
  }

  /** The epoch was torn down; what it reported stays for display. */
  queryEnded(epochKey: string): void {
    const epoch = this.epoch;
    if (epoch?.epochKey !== epochKey) return;
    this.lastReport = this.reportOf(epoch);
    this.epoch = undefined;
  }

  /** The CLI's context report for an epoch: display and the agent's check. */
  usageReported(epochKey: string, usage: ContextUsage): void {
    const epoch = this.epoch;
    if (epoch?.epochKey !== epochKey) return;
    if (typeof usage.autoCompactThreshold === "number")
      epoch.trigger = usage.autoCompactThreshold;
    if (typeof usage.isAutoCompactEnabled === "boolean") {
      epoch.disabled = !usage.isAutoCompactEnabled;
      epoch.switchReported = true;
    }
  }

  /**
   * Whether `epochKey` is the running epoch, and whether the agent path must
   * read the CLI's report first: the epoch has not reported its switch, or
   * (switched on) started with no value and has no threshold to bound it.
   */
  agentCheck(epochKey: string): { current: boolean; needsRead: boolean } {
    const epoch = this.currentEpoch();
    if (epoch?.epochKey !== epochKey)
      return { current: false, needsRead: false };
    return {
      current: true,
      needsRead:
        !epoch.switchReported ||
        (!epoch.disabled &&
          epoch.started === null &&
          epoch.trigger === undefined),
    };
  }

  /**
   * Whether the agent path's own read answers what `agentCheck` asked for:
   * the switch, and (switched on, no start value) the threshold. Judged on
   * the reply alone, never on what other reports already merged.
   */
  readAnswers(epochKey: string, usage: ContextUsage): boolean {
    const epoch = this.currentEpoch();
    if (epoch?.epochKey !== epochKey) return false;
    if (typeof usage.isAutoCompactEnabled !== "boolean") return false;
    return (
      !usage.isAutoCompactEnabled ||
      epoch.started !== null ||
      typeof usage.autoCompactThreshold === "number"
    );
  }

  status(stored: number | undefined): CompactionWindowLiveStatus {
    const expected = this.startWindow(stored) ?? null;
    const epoch = this.currentEpoch();
    if (epoch) {
      const reported = {
        ...(epoch.trigger !== undefined
          ? { providerTrigger: epoch.trigger }
          : {}),
        ...(epoch.disabled ? { disabled: true as const } : {}),
      };
      return epoch.started === expected
        ? { applied: "confirmed", appliedTokens: epoch.started, ...reported }
        : { applied: "pending", pendingReason: "process-restart", ...reported };
    }
    // A closing epoch reports like an ended one: nothing reaches it any more.
    const last = this.lastReportNow();
    const current =
      last !== undefined &&
      last.modelId === this.host.modelId() &&
      last.value === expected;
    return {
      applied: "pending",
      pendingReason: "next-turn",
      ...(current && last.trigger !== undefined
        ? { providerTrigger: last.trigger }
        : {}),
      ...(current && last.disabled ? { disabled: true } : {}),
    };
  }

  /** The value is stored; say when it takes effect. Nothing is sent live. */
  apply(stored: number | null): CompactionWindowApplyResult {
    const epoch = this.currentEpoch();
    if (!epoch) return { pendingReason: "next-turn" };
    const expected =
      stored === null ? null : (this.startWindow(stored) ?? null);
    return epoch.started === expected
      ? {}
      : { pendingReason: "process-restart" };
  }

  /**
   * The agent path, in the precedence of `docs/compaction-window.md`: the
   * provider's own switch, the floor and range, then the non-raising check.
   * The value must be below the window the current process runs with, and
   * below the stored value the next process would start with. The stored
   * value only ever tightens the bound: it never authorizes on its own. The
   * session calls it only for the running epoch, once `agentCheck` passes.
   * On success `persist` stores it; it applies when the next process starts.
   */
  lower(
    tokens: number,
    stored: number | undefined,
    persist: (tokens: number) => void,
  ): CompactionWindowLowerResult {
    const report = this.lastReportNow();
    if (report?.disabled)
      return refused(
        "Auto-compaction is turned off for this session, so its window cannot be lowered.",
      );
    const available = compactionWindowRange(CAPABILITY, {
      contextWindow: this.host.modelWindow(),
    });
    if (tokens < COMPACTION_WINDOW_AGENT_FLOOR || !("range" in available))
      return refused(
        `An agent can lower the compaction window to ${format(COMPACTION_WINDOW_AGENT_FLOOR)} tokens at the least.`,
      );
    if (tokens > available.range.max)
      return refused(
        `The compaction window must be at most ${format(available.range.max)} tokens.`,
      );
    // The window the process runs with: its start value, else bounded by
    // the threshold the CLI reported for it.
    const running =
      report?.value ??
      (report?.trigger !== undefined
        ? report.trigger + THRESHOLD_MIN_OFFSET
        : undefined);
    if (running === undefined)
      return refused(
        "This session has not reported its compaction threshold yet, so lowering cannot be checked; ask the user.",
      );
    const current = this.startWindow(stored);
    const largest = Math.min(running, current ?? running) - 1;
    if (tokens > largest)
      return largest >= COMPACTION_WINDOW_AGENT_FLOOR
        ? refused(
            `That would not lower the window: the largest window an agent can set now is ${format(largest)}.`,
            largest,
          )
        : refused(
            "This session's window is already at the lowest an agent can set.",
          );
    try {
      persist(tokens);
    } catch (error) {
      return refused(
        `Saving the compaction window failed: ${errorText(error)}`,
      );
    }
    return {
      ok: true,
      previous: current ?? null,
      applied: tokens,
      pendingReason: this.currentEpoch() ? "process-restart" : "next-turn",
    };
  }

  private currentEpoch(): EpochWindow | undefined {
    const key = this.host.currentEpochKey();
    return key !== undefined && this.epoch?.epochKey === key
      ? this.epoch
      : undefined;
  }

  private lastReportNow(): LastReport | undefined {
    return this.epoch ? this.reportOf(this.epoch) : this.lastReport;
  }

  private reportOf(epoch: EpochWindow): LastReport {
    return {
      value: epoch.started,
      modelId: this.host.modelId(),
      ...(epoch.trigger !== undefined ? { trigger: epoch.trigger } : {}),
      ...(epoch.disabled ? { disabled: true } : {}),
    };
  }
}

/**
 * One summary context report for the agent path, or `undefined` when the
 * query cannot answer, fails, or stays silent past the bound.
 */
export async function readContextUsage(
  query: ClaudeQuery,
): Promise<ContextUsage | undefined> {
  const read = query.getContextUsage?.({ detail: "summary" });
  if (!read) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), USAGE_READ_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([read.catch(() => undefined), silence]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
