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

export const RUNTIME_COMMAND_NAMES: readonly RuntimeCommandName[] = [
  "model",
  "effort",
  "account",
];

export function isRuntimeCommand(name: string): name is RuntimeCommandName {
  return (RUNTIME_COMMAND_NAMES as readonly string[]).includes(name);
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

/** A model's `provider/id`: one row even when two providers offer the id. */
const qualified = (model: ModelOption) => `${model.provider}/${model.id}`;

/** The models, one per `provider/id`. */
function distinct(models: readonly ModelOption[]): ModelOption[] {
  const seen = new Map<string, ModelOption>();
  for (const model of models) {
    const key = normalize(qualified(model));
    if (!seen.has(key)) seen.set(key, model);
  }
  return [...seen.values()];
}

/**
 * The models a typed text names by id, in either reading: as one model's
 * `provider/id`, or as another's bare id. An endpoint's id may itself hold a
 * slash (`openai/gpt-5.5`), so one text can be both.
 */
function namedById(
  models: readonly ModelOption[],
  text: string,
): ModelOption[] {
  const wanted = normalize(text);
  return models.filter(
    (model) =>
      normalize(qualified(model)) === wanted || normalize(model.id) === wanted,
  );
}

/**
 * The text that names `model` and no other, in every reading: its bare id
 * when that is unique, else its `provider/id` (two OpenAI-compatible
 * endpoints may both offer `llama3`). None when both are ambiguous.
 */
function modelArgument(
  model: ModelOption,
  models: readonly ModelOption[],
): string | undefined {
  return [model.id, qualified(model)].find((text) => {
    const named = namedById(models, text);
    return named.length === 1 && named[0] === model;
  });
}

const UNNAMEABLE =
  "No typed name picks only this model; choose it in the Runtime section";

/** The arguments a command offers, for the composer's autocomplete. */
export function runtimeArgumentOptions(
  name: RuntimeCommandName,
  context: RuntimeCommandContext,
): RuntimeArgumentOption[] {
  if (name === "model") {
    const models = distinct(context.models);
    return models.map((model) => {
      const value = modelArgument(model, models);
      if (value === undefined)
        return {
          value: qualified(model),
          label: model.name,
          detail: UNNAMEABLE,
          disabled: true,
        };
      return {
        value,
        label: model.name,
        // Same-named models are told apart by where they run.
        ...(value !== model.id
          ? { detail: model.providerName ?? model.provider }
          : {}),
      };
    });
  }
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
    const models = distinct(context.models);
    // By id first, as `provider/id` or bare id together, then by display
    // name. Text that names more than one model in any reading is refused,
    // never guessed: the first match could send the session to another
    // endpoint.
    const tiers = [
      namedById(models, wanted),
      models.filter((option) => normalize(option.name) === wanted),
    ];
    const matches = tiers.find((tier) => tier.length > 0) ?? [];
    if (matches.length === 0)
      return {
        kind: "error",
        message: `No model is named "${rawArgs.trim()}".`,
      };
    if (matches.length > 1)
      return {
        kind: "error",
        message: `More than one model is named "${rawArgs.trim()}"; name one as provider/id: ${matches.map(qualified).join(", ")}.`,
      };
    const model = matches[0]!;
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
