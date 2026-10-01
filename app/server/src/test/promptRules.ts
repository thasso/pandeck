/**
 * Rules tables for model-facing prose: prompts and tool descriptions.
 *
 * A rules test names the RULES a surface must state, one row each, instead of
 * pinning its sentences. A row's pattern matches the rule, not the wording, so
 * a rewrite stays green while a trim that drops the rule fails, naming the rule
 * id.
 */
import assert from "node:assert/strict";

/** A pattern the text must match, or a check it must pass. */
export type PromptRule = RegExp | ((text: string) => boolean);

/** The check form of a rule the text must NOT state. */
export function absent(pattern: RegExp): PromptRule {
  return (text) => !pattern.test(text);
}

/** Fails once, listing every `surface › rule id` the text no longer satisfies. */
export function assertPromptRules(
  surfaces: Record<string, { text: string; rules: Record<string, PromptRule> }>,
): void {
  const broken = Object.entries(surfaces).flatMap(
    ([surface, { text, rules }]) =>
      Object.entries(rules)
        .filter(([, rule]) =>
          typeof rule === "function" ? !rule(text) : !rule.test(text),
        )
        .map(([id]) => `${surface} › ${id}`),
  );
  assert.deepEqual(broken, [], `rules no longer stated:\n${broken.join("\n")}`);
}
