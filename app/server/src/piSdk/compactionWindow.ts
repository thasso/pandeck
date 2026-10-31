/**
 * The pi harness's compaction window (`docs/compaction-window.md`).
 *
 * pi compacts when the context passes the model's window minus a reserve, and
 * resolves that reserve from `compaction.modelOverrides["provider/id"]` first.
 * A window `W` is therefore written as that model's reserve,
 * `contextWindow − clamp(W, 1, nativeTrigger)`, through `applyOverrides` on the
 * session's OWN `SettingsManager` (pi creates one per session, since Pandeck
 * passes none). Overrides live in memory only and never reach disk.
 *
 * Every real settings rebuild drops in-memory overrides, so the controller
 * wraps the four methods of that instance which rebuild (pi 1.1.0:
 * `setProjectTrusted` only when trust changes, `reload`, `save`,
 * `saveProjectSettings`), re-reads the underlying reserve and re-applies. A pi
 * upgrade that changes that set needs this file revisited; the real-method
 * tests pin it.
 */
import type {
  AgentSession,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  COMPACTION_WINDOW_AGENT_FLOOR,
  type CompactionWindowLiveStatus,
} from "@assistant/shared";
import type {
  CompactionWindowApplyResult,
  CompactionWindowHarnessStatus,
  CompactionWindowLowerResult,
} from "../harness.ts";

export { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";

type CompactionModel = { provider: string; id: string; contextWindow: number };

/** The rebuild methods, two of which pi declares private. */
type RebuildingSettingsManager = {
  reload(): Promise<void>;
  save(): void;
  saveProjectSettings(settings: unknown): void;
  setProjectTrusted(trusted: boolean): void;
  isProjectTrusted(): boolean;
};

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PiCompactionWindow {
  private desired: number | null = null;
  /** The reserve each key resolved to before Pandeck first wrote it. */
  private readonly baselines = new Map<string, number>();
  private readonly touched = new Set<string>();
  private applied: { key: string; reserve: number } | "unknown" | null = null;
  private applyError: string | undefined;

  constructor(
    private readonly settings: SettingsManager,
    private readonly model: () => CompactionModel | undefined,
  ) {
    const manager = settings as unknown as RebuildingSettingsManager;
    const reload = manager.reload.bind(manager);
    const save = manager.save.bind(manager);
    const saveProjectSettings = manager.saveProjectSettings.bind(manager);
    const setProjectTrusted = manager.setProjectTrusted.bind(manager);
    // A throw from the original propagates before the hook: nothing rebuilt.
    manager.reload = async () => {
      await reload();
      this.onRebuild();
    };
    manager.save = () => {
      save();
      this.onRebuild();
    };
    manager.saveProjectSettings = (value) => {
      saveProjectSettings(value);
      this.onRebuild();
    };
    // pi returns early, without rebuilding, when trust does not change.
    manager.setProjectTrusted = (trusted) => {
      const before = manager.isProjectTrusted();
      setProjectTrusted(trusted);
      if (before !== trusted) this.onRebuild();
    };
  }

  /** Set the desired window (`null`: pi's own reserve) and apply it now. */
  apply(tokens: number | null): CompactionWindowApplyResult {
    this.desired = tokens;
    return this.write();
  }

  /** The session switched model: the window is written for the new key. */
  onModelChanged(): void {
    if (this.desired !== null) this.write();
  }

  /**
   * Defence before a turn: re-apply when the current model's reserve is not
   * the one last confirmed. Every rebuild path is already observed.
   */
  verify(): void {
    if (this.desired === null || !this.settings.getCompactionEnabled()) return;
    const model = this.model();
    if (!model) return;
    const applied = this.applied;
    try {
      if (
        applied === null ||
        applied === "unknown" ||
        applied.key !== modelKey(model) ||
        this.settings.getCompactionReserveTokens(model) !== applied.reserve
      )
        this.write();
    } catch {
      this.write();
    }
  }

  status(): CompactionWindowHarnessStatus {
    const model = this.model();
    const live = this.liveStatus(model);
    if (!model) return { live };
    try {
      return {
        live,
        contextWindow: model.contextWindow,
        underlyingReserve: this.underlyingReserve(model),
      };
    } catch {
      return { live, contextWindow: model.contextWindow };
    }
  }

  /** The agent path, in the precedence of `docs/compaction-window.md`. */
  lower(
    tokens: number,
    persist: (tokens: number) => void,
  ): CompactionWindowLowerResult {
    const model = this.model();
    if (!this.settings.getCompactionEnabled())
      return refused(
        "Compaction is turned off in this session's pi settings, so its window cannot be lowered.",
      );
    if (this.applied === "unknown")
      return refused(
        "This session's live compaction window is unknown after a failed change; ask the user to set it.",
      );
    if (!model) return refused("This session has no model yet.");
    let nativeTrigger: number;
    let currentTrigger: number;
    try {
      nativeTrigger = model.contextWindow - this.underlyingReserve(model);
      currentTrigger =
        model.contextWindow - this.settings.getCompactionReserveTokens(model);
    } catch (error) {
      return refused(
        `Reading pi's compaction settings failed: ${errorText(error)}`,
      );
    }
    if (tokens < COMPACTION_WINDOW_AGENT_FLOOR)
      return refused(
        `An agent can lower the compaction window to ${COMPACTION_WINDOW_AGENT_FLOOR.toLocaleString("en-US")} tokens at the least.`,
      );
    if (tokens > nativeTrigger)
      return refused(
        `The compaction window must be at most ${nativeTrigger.toLocaleString("en-US")} tokens.`,
      );
    if (tokens >= currentTrigger) {
      const largest = currentTrigger - 1;
      return largest >= COMPACTION_WINDOW_AGENT_FLOOR
        ? refused(
            `That would not lower the window: this session compacts at ${currentTrigger.toLocaleString("en-US")} tokens, so the largest window an agent can set is ${largest.toLocaleString("en-US")}.`,
            largest,
          )
        : refused(
            `This session already compacts at ${currentTrigger.toLocaleString("en-US")} tokens; an agent cannot lower it further.`,
          );
    }
    const previous = this.desired;
    this.desired = tokens;
    const result = this.write();
    if (result.applyError !== undefined)
      return this.restore(previous, result.applyError);
    try {
      persist(tokens);
    } catch (error) {
      return this.restore(
        previous,
        `Saving the compaction window failed: ${errorText(error)}`,
      );
    }
    return { ok: true, previous, applied: tokens };
  }

  /** Put back the window a lower replaced, refusing with `reason`. */
  restore(
    previous: number | null,
    reason: string,
  ): CompactionWindowLowerResult {
    this.desired = previous;
    this.write();
    return refused(
      this.applied === "unknown"
        ? `${reason} Restoring the previous window also failed, so the live window is unknown.`
        : reason,
    );
  }

  /** A real rebuild dropped every override: re-read and re-apply. */
  private onRebuild(): void {
    this.baselines.clear();
    this.touched.clear();
    this.applied = null;
    if (this.desired !== null) this.write();
  }

  private write(): CompactionWindowApplyResult {
    if (!this.settings.getCompactionEnabled()) return { disabled: true };
    const model = this.model();
    if (!model) return { pendingReason: "next-turn" };
    const key = modelKey(model);
    try {
      if (this.desired === null) {
        for (const touchedKey of this.touched)
          this.override(touchedKey, this.baselines.get(touchedKey)!);
        this.confirm(model, this.underlyingReserve(model));
      } else {
        const baseline = this.underlyingReserve(model);
        const nativeTrigger = model.contextWindow - baseline;
        if (nativeTrigger < 1)
          throw new Error(
            "this model's reserve already covers its whole context window",
          );
        const window = Math.min(Math.max(this.desired, 1), nativeTrigger);
        const reserve = model.contextWindow - window;
        this.baselines.set(key, baseline);
        this.touched.add(key);
        this.override(key, reserve);
        this.confirm(model, reserve);
      }
    } catch (error) {
      this.applied = "unknown";
      this.applyError = `Applying the compaction window failed: ${errorText(error)}`;
    }
    return this.applied === "unknown" ? { applyError: this.applyError! } : {};
  }

  private override(key: string, reserveTokens: number): void {
    this.settings.applyOverrides({
      compaction: { modelOverrides: { [key]: { reserveTokens } } },
    });
  }

  private confirm(model: CompactionModel, reserve: number): void {
    if (this.settings.getCompactionReserveTokens(model) !== reserve)
      throw new Error("pi did not take the new reserve");
    this.applied = { key: modelKey(model), reserve };
    this.applyError = undefined;
  }

  /** The key's reserve without Pandeck's override. */
  private underlyingReserve(model: CompactionModel): number {
    return (
      this.baselines.get(modelKey(model)) ??
      this.settings.getCompactionReserveTokens(model)
    );
  }

  private liveStatus(
    model: CompactionModel | undefined,
  ): CompactionWindowLiveStatus {
    if (!this.settings.getCompactionEnabled())
      return { applied: "pending", disabled: true };
    if (!model) return { applied: "pending", pendingReason: "next-turn" };
    let trigger: number | undefined;
    try {
      trigger =
        model.contextWindow - this.settings.getCompactionReserveTokens(model);
    } catch {
      trigger = undefined;
    }
    const reported = trigger !== undefined ? { providerTrigger: trigger } : {};
    const applied = this.applied;
    if (applied === "unknown")
      return {
        applied: "unknown",
        ...(this.applyError !== undefined
          ? { applyError: this.applyError }
          : {}),
        ...reported,
      };
    if (this.desired === null)
      return { applied: "confirmed", appliedTokens: null, ...reported };
    return applied?.key === modelKey(model)
      ? {
          applied: "confirmed",
          appliedTokens: model.contextWindow - applied.reserve,
          ...reported,
        }
      : { applied: "pending", pendingReason: "next-turn", ...reported };
  }
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

const controllers = new WeakMap<AgentSession, PiCompactionWindow>();

/**
 * Install the window controller on a freshly created session, before any
 * prompt, and apply the stored value. Create, reopen and staged failover all
 * build their session through here.
 */
export function installCompactionWindow(
  session: AgentSession,
  stored: number | undefined,
): PiCompactionWindow {
  const controller = new PiCompactionWindow(session.settingsManager, () =>
    session.model
      ? {
          provider: session.model.provider,
          id: session.model.id,
          contextWindow: session.model.contextWindow,
        }
      : undefined,
  );
  controllers.set(session, controller);
  if (stored !== undefined) controller.apply(stored);
  return controller;
}

export function compactionWindowFor(
  session: AgentSession,
): PiCompactionWindow | undefined {
  return controllers.get(session);
}
