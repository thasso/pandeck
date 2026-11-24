/**
 * `/model`, `/effort` and `/account`: what one typed line asks for. Without an
 * argument the command opens the inspector's Runtime section; with one it is
 * a change to the session's pending selection, sent at once, even mid-turn,
 * and never queued (`docs/session-runtime-switching.md`). The server re-judges
 * every change; this only names the target and refuses what it cannot name.
 */
import {
  supportedThinkingLevelsForModel,
  THINKING_LEVELS,
  type ModelOption,
  type SessionRuntimeChange,
  type ThinkingLevel,
} from "@assistant/shared";

export type RuntimeCommandName = "model" | "effort" | "account";

export function isRuntimeCommand(name: string): name is RuntimeCommandName {
  return name === "model" || name === "effort" || name === "account";
}

/** One argument the composer may complete, and the text it inserts. */
export interface RuntimeArgumentOption {
  value: string;
  label: string;
  /** Shown beside the label; a disabled option says why. */
  detail?: string;
  disabled?: boolean;
}

export interface RuntimeCommandContext {
  /**
   * Every model the pickers know. One of another harness or account kind is
   * an engine switch at the next turn, never refused here.
   */
  models: readonly ModelOption[];
  /** The model the next turn starts on: pending, else current. */
  targetModel: ModelOption | undefined;
  /** Accounts that could run the target model, by name; empty when fixed. */
  accounts: readonly { id: string; name: string }[];
}

const normalize = (text: string) => text.trim().toLowerCase();

/** The arguments a command offers, for the composer's autocomplete. */
export function runtimeArgumentOptions(
  name: RuntimeCommandName,
  context: RuntimeCommandContext,
): RuntimeArgumentOption[] {
  if (name === "model")
    return context.models.map((model) => ({
      value: model.id,
      label: model.name,
    }));
  if (name === "effort")
    return effortLevels(context.targetModel).map((level) => ({
      value: level,
      label: level,
    }));
  return [
    { value: "automatic", label: "Automatic" },
    ...context.accounts.map((account) => ({
      value: account.name,
      label: account.name,
    })),
  ];
}

function effortLevels(model: ModelOption | undefined): ThinkingLevel[] {
  return model ? supportedThinkingLevelsForModel(model) : [...THINKING_LEVELS];
}

/**
 * What a typed command asks for: open the Runtime section, send a change, or
 * the inline error the composer shows.
 */
export function resolveRuntimeCommand(
  name: RuntimeCommandName,
  rawArgs: string,
  context: RuntimeCommandContext,
):
  | { kind: "open" }
  | { kind: "change"; change: SessionRuntimeChange }
  | { kind: "error"; message: string } {
  const wanted = normalize(rawArgs);
  if (!wanted) return { kind: "open" };
  if (name === "model") {
    const model =
      context.models.find((option) => normalize(option.id) === wanted) ??
      context.models.find((option) => normalize(option.name) === wanted);
    if (!model)
      return {
        kind: "error",
        message: `No model is named "${rawArgs.trim()}".`,
      };
    return {
      kind: "change",
      change: { model: { provider: model.provider, id: model.id } },
    };
  }
  if (name === "effort") {
    const level = effortLevels(context.targetModel).find(
      (candidate) => candidate === wanted,
    );
    if (!level)
      return {
        kind: "error",
        message: `Effort must be one of: ${effortLevels(context.targetModel).join(", ")}.`,
      };
    return { kind: "change", change: { thinkingLevel: level } };
  }
  if (wanted === "automatic" || wanted === "auto")
    return { kind: "change", change: { account: { kind: "automatic" } } };
  const matches = context.accounts.filter(
    (account) =>
      normalize(account.name) === wanted || account.id === rawArgs.trim(),
  );
  if (matches.length !== 1)
    return {
      kind: "error",
      message:
        matches.length === 0
          ? `No account that can run this model is named "${rawArgs.trim()}".`
          : `More than one account is named "${rawArgs.trim()}".`,
    };
  return {
    kind: "change",
    change: { account: { kind: "account", id: matches[0]!.id } },
  };
}
