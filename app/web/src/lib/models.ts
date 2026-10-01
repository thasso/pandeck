import {
  type AppSettings,
  type ModelOption,
  modelKey,
} from "@assistant/shared";

/**
 * Apply the user's model settings to the live registry list:
 * explicitly ordered models first (in their saved order), then any remaining
 * available models in default order, with hidden models removed.
 *
 * Used for the picker. The settings page works off the raw list so it can show
 * hidden models too.
 */
export function visibleModels(
  models: ModelOption[],
  settings: AppSettings,
): ModelOption[] {
  const { hidden, order } = settings.models;
  const hiddenSet = new Set(hidden);
  const rank = new Map(order.map((key, i) => [key, i]));
  return models
    .filter((m) => !hiddenSet.has(modelKey(m)))
    .sort((a, b) => {
      const ra = rank.get(modelKey(a)) ?? Infinity;
      const rb = rank.get(modelKey(b)) ?? Infinity;
      return ra - rb; // stable for equal ranks → preserves the incoming order
    });
}
