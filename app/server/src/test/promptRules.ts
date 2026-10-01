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

/**
 * A fresh copy per check: `test` on a /g or /y pattern advances its
 * `lastIndex`, so a pattern reused across rows would answer differently each
 * time it is asked.
 */
function matches(pattern: RegExp, text: string): boolean {
  return new RegExp(pattern.source, pattern.flags).test(text);
}

/** The check form of a rule the text must NOT state. */
export function absent(pattern: RegExp): PromptRule {
  return (text) => !matches(pattern, text);
}

/**
 * A prohibition: one sentence that negates and names every act, in any order
 * ("Do not commit, push, or open a pull request").
 */
export function forbidden(...acts: string[]): PromptRule {
  return (text) =>
    text
      .split(/(?<=[.!?])\s+/)
      .some(
        (sentence) =>
          /\b(do not|don't|never|must not|may not)\b/i.test(sentence) &&
          acts.every((act) =>
            sentence.toLowerCase().includes(act.toLowerCase()),
          ),
      );
}

/** Fails once, listing every `surface › rule id` the text no longer satisfies. */
export function assertPromptRules(
  surfaces: Record<string, { text: string; rules: Record<string, PromptRule> }>,
): void {
  const broken = Object.entries(surfaces).flatMap(
    ([surface, { text, rules }]) =>
      Object.entries(rules)
        .filter(([, rule]) =>
          typeof rule === "function" ? !rule(text) : !matches(rule, text),
        )
        .map(([id]) => `${surface} › ${id}`),
  );
  assert.deepEqual(broken, [], `rules no longer stated:\n${broken.join("\n")}`);
}
