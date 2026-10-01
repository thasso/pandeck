/**
 * The thinking-level vocabulary, as a LEAF module.
 *
 * It lives apart from `protocol.ts` for one reason: every other shared domain
 * module (peer runtimes, and whatever follows) needs the ladder and the
 * per-model support rule as VALUES, and importing them from `protocol.ts` —
 * which re-exports those modules in turn — closes an import cycle. Types cycle
 * harmlessly; functions do not. `protocol.ts` re-exports everything here, so
 * consumers keep importing it from the package root.
 */
export type ThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Whether an untrusted value names a thinking level this build knows. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    THINKING_LEVELS.includes(value as ThinkingLevel)
  );
}

/** The subset of a model option this rule reads; `ModelOption` satisfies it. */
export interface ThinkingCapableModel {
  /** Whether the model supports a thinking/reasoning budget. */
  reasoning: boolean;
  /** Levels the provider/model can actually accept, when the server states them. */
  supportedThinkingLevels?: ThinkingLevel[];
}

/**
 * Levels this model really accepts. An older server may state none, so a
 * reasoning model falls back to the whole ladder and everything else to `off`.
 */
export function supportedThinkingLevelsForModel(
  model: ThinkingCapableModel | undefined,
): ThinkingLevel[] {
  if (!model) return ["off"];
  if (
    Array.isArray(model.supportedThinkingLevels) &&
    model.supportedThinkingLevels.length > 0
  ) {
    const unique = THINKING_LEVELS.filter((level) =>
      model.supportedThinkingLevels?.includes(level),
    );
    return unique.length > 0 ? unique : ["off"];
  }
  return model.reasoning ? THINKING_LEVELS : ["off"];
}
