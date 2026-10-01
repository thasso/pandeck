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

const NEGATION = /\b(?:do not|don't|never|must not|may not|no)\s+/gi;
const LIST_SEPARATOR = /\s*(?:,\s*(?:(?:or|and|nor)\s+)?|(?:or|and|nor)\s+)/iy;
const DETERMINER = /(?:a|an|the|any)\s+/iy;

/**
 * A prohibition: every act sits in a list directly governed by a negation —
 * "Do not commit, push, or open a pull request" — in any order, and across
 * several such lists. A list holds only the declared acts (each a literal
 * phrase, optionally after a/an/the/any), so "Commit and push; do not open a
 * pull request" forbids only the last, and "Never skip checks before you
 * commit" forbids none of them.
 */
export function forbidden(...acts: string[]): PromptRule {
  const longestFirst = [...acts].sort((a, b) => b.length - a.length);
  /** The declared act starting exactly at `at`, ending on a word boundary. */
  const actAt = (text: string, at: number): string | undefined =>
    longestFirst.find(
      (act) =>
        text.slice(at, at + act.length).toLowerCase() === act.toLowerCase() &&
        !/[\w-]/.test(text.charAt(at + act.length)),
    );
  const sticky = (pattern: RegExp, text: string, at: number): number => {
    pattern.lastIndex = at;
    return pattern.exec(text) ? pattern.lastIndex : at;
  };
  return (text) => {
    const negated = new Set<string>();
    for (const negation of text.matchAll(NEGATION)) {
      let at = negation.index + negation[0].length;
      for (;;) {
        at = sticky(DETERMINER, text, at);
        const act = actAt(text, at);
        if (!act) break;
        negated.add(act);
        const next = sticky(LIST_SEPARATOR, text, at + act.length);
        if (next === at + act.length) break;
        at = next;
      }
    }
    return acts.every((act) => negated.has(act));
  };
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
