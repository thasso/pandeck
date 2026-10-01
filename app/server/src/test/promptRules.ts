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
 * several such lists. A list holds only the declared acts (a literal phrase,
 * optionally after a/an/the/any, or a pattern for a phrase with optional
 * words), so "Commit and push; do not open a pull request" forbids only the
 * last, and "Never skip checks before you commit" forbids none of them.
 */
export function forbidden(...acts: (string | RegExp)[]): PromptRule {
  const patterns = acts.map((act) =>
    typeof act === "string"
      ? new RegExp(act.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iy")
      : new RegExp(act.source, `${act.flags.replace(/[gy]/g, "")}y`),
  );
  /** The index of the declared act ending at a word boundary, and its end. */
  const actAt = (text: string, at: number): [number, number] | undefined => {
    let best: [number, number] | undefined;
    patterns.forEach((pattern, index) => {
      pattern.lastIndex = at;
      const end = pattern.exec(text) ? pattern.lastIndex : -1;
      if (
        end > at &&
        !/[\w-]/.test(text.charAt(end)) &&
        end > (best?.[1] ?? -1)
      )
        best = [index, end];
    });
    return best;
  };
  const sticky = (pattern: RegExp, text: string, at: number): number => {
    pattern.lastIndex = at;
    return pattern.exec(text) ? pattern.lastIndex : at;
  };
  return (text) => {
    const negated = new Set<number>();
    for (const negation of text.matchAll(NEGATION)) {
      let at = negation.index + negation[0].length;
      for (;;) {
        at = sticky(DETERMINER, text, at);
        const act = actAt(text, at);
        if (!act) break;
        negated.add(act[0]);
        const next = sticky(LIST_SEPARATOR, text, act[1]);
        if (next === act[1]) break;
        at = next;
      }
    }
    return negated.size === acts.length;
  };
}

const CLAUSE_BOUNDARY = /[.;:!?\n]|\s—\s|,\s+but\b/g;
/**
 * Negation is spotted by TOKEN, not by what it governs: any of these in the
 * text leading up to a key word counts, so the check errs toward failing.
 */
const NEGATED =
  /\b(?:not|never|no longer|no|cannot|without|neither|nor)\b|n't\b/i;

/** Where the clause holding `at` starts. */
function clauseStart(text: string, at: number): number {
  let start = 0;
  for (const boundary of text.slice(0, at).matchAll(CLAUSE_BOUNDARY))
    start = boundary.index + boundary[0].length;
  return start;
}

/**
 * A rule stated affirmatively: `pattern` must match where no negation governs
 * it. Each named group is a word whose polarity carries the rule, and the
 * clause text leading up to it (from the clause start, or from the previous
 * group) may hold no negation — so "never optional", "is no longer your ONLY
 * channel" and "is never recorded as accepted" fail. Text INSIDE a named group
 * is not checked: a premise such as `(?<premise>NOT restate)` may negate. With
 * no named group, the whole match is the key word.
 *
 * This is lexical and deliberately conservative, not a parser of English.
 * Double negatives ("Never fail to consolidate") and negated conditional
 * antecedents ("If there is no room, consolidate", "No matter what,
 * consolidate") are unsupported unless the row marks that part as a named
 * premise group, so they fail even though the rule holds. A failure like that
 * is a false failure, never a missed rule: rephrase the prompt, or mark the
 * premise in the row's pattern.
 */
export function affirmed(pattern: RegExp): PromptRule {
  const flags = `${pattern.flags.replace(/[gyd]/g, "")}gd`;
  return (text) => {
    for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
      const spans = Object.values(match.indices?.groups ?? {})
        .filter((span): span is [number, number] => span !== undefined)
        .sort((a, b) => a[0] - b[0]);
      if (spans.length === 0)
        spans.push([match.index, match.index + match[0].length]);
      let previousEnd = 0;
      const negated = spans.some(([start, end]) => {
        const lead = text.slice(
          Math.max(previousEnd, clauseStart(text, start)),
          start,
        );
        previousEnd = end;
        return NEGATED.test(lead);
      });
      if (!negated) return true;
    }
    return false;
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
