import assert from "node:assert/strict";
import { test } from "vitest";
import {
  absent,
  affirmed,
  assertPromptRules,
  forbidden,
  type PromptRule,
} from "./promptRules.ts";

/** The `surface › rule id` lines a failing table reports. */
function brokenRules(run: () => void): string[] {
  try {
    run();
  } catch (error) {
    return (error as { actual: string[] }).actual;
  }
  return [];
}

test("a global or sticky pattern answers the same on every surface it is reused on", () => {
  const global = /rule/g;
  const sticky = /rule/y;
  const surfaces = Object.fromEntries(
    ["a", "b", "c"].map((name) => [
      name,
      { text: "rule", rules: { global, sticky } },
    ]),
  );
  assert.deepEqual(
    brokenRules(() => assertPromptRules(surfaces)),
    [],
  );
});

test("absent() refuses a prohibited rule however often it is asked", () => {
  const forbid = absent(/rule/g);
  const surfaces = { a: { text: "rule", rules: { forbid } } };
  assert.deepEqual(
    brokenRules(() => assertPromptRules(surfaces)),
    ["a › forbid"],
  );
  assert.deepEqual(
    brokenRules(() => assertPromptRules(surfaces)),
    ["a › forbid"],
  );
  assert.deepEqual(
    brokenRules(() =>
      assertPromptRules({ a: { text: "other", rules: { forbid } } }),
    ),
    [],
  );
});

test("forbidden() holds only acts listed directly under a negation, in any order", () => {
  const rule = forbidden("commit", "push", "open a pull request");
  const check = (text: string) =>
    brokenRules(() => assertPromptRules({ s: { text, rules: { rule } } }));
  const kept: string[] = [];
  const lost = ["s › rule"];
  assert.deepEqual(check("Do not commit, push, or open a pull request."), kept);
  assert.deepEqual(check("Never open a pull request, push or commit."), kept);
  assert.deepEqual(
    check("Do not push; do not commit, and never open a pull request."),
    kept,
  );
  // The acts are present, but the negation governs something else.
  assert.deepEqual(check("Commit and push; do not open a pull request."), lost);
  assert.deepEqual(
    check(
      "Never skip checks before you commit, push, and open a pull request.",
    ),
    lost,
  );
  assert.deepEqual(check("Commit, push, and open a pull request."), lost);
  // A word that merely starts with an act is not that act.
  assert.deepEqual(
    check("Do not commits, pushes, or open a pull request."),
    lost,
  );
});

test("forbidden() takes a pattern for an act with optional words", () => {
  const rule = forbidden(/create (any )?extra commits/i, "push");
  const check = (text: string) =>
    brokenRules(() => assertPromptRules({ s: { text, rules: { rule } } }));
  assert.deepEqual(
    check("Do not create any extra commits, push, or merge."),
    [],
  );
  assert.deepEqual(check("Do not create extra commits or push."), []);
  assert.deepEqual(check("Create extra commits; do not push."), ["s › rule"]);
});

/** Whether `rule` holds for `text`, as a one-row table. */
function holds(rule: PromptRule, text: string): boolean {
  return (
    brokenRules(() => assertPromptRules({ s: { text, rules: { rule } } }))
      .length === 0
  );
}

test("affirmed() refuses a rule whose own clause negates it, in any negation form", () => {
  // Each pair: the rule as stated, then an inversion that keeps every word
  // the pattern looks for. The patterns are the agentExecutor rows'.
  const cases: [PromptRule, string, string][] = [
    [
      affirmed(
        /observations[^.\n]*?(?<key>only if|need not|at your discretion|optional)/i,
      ),
      "The reviewer also recorded observations; act on one only if you judge it worth doing now.",
      "The reviewer also recorded observations; they are never optional and must all be addressed.",
    ],
    [
      affirmed(
        /(?<verb>restate)[^.\n]*?(?<how>exactly|verbatim|word for word)/i,
      ),
      "Restate an unresolved finding with its severity and text EXACTLY as listed.",
      "Never restate an unresolved finding with its severity and text EXACTLY as listed.",
    ],
    [
      affirmed(
        /(?<premise>(not|never) restate|unrestated)[^.\n]*?(?<key>(recorded|counted|treated) as accepted)/i,
      ),
      "Every finding you do NOT restate is recorded as accepted by you.",
      "Every finding you do NOT restate is never recorded as accepted by you.",
    ],
    [
      affirmed(/only channel/i),
      "This is your ONLY channel to the agent that does the work.",
      "This is no longer your ONLY channel to the agent that does the work.",
    ],
    [
      affirmed(/consolidate/i),
      "If your report exceeds that, consolidate related points.",
      "If your report exceeds that, never consolidate related points.",
    ],
  ];
  for (const [rule, stated, inverted] of cases) {
    assert.ok(holds(rule, stated), stated);
    assert.ok(!holds(rule, inverted), inverted);
  }
  // Every negation form, and only inside the clause that carries the rule.
  const channel = affirmed(/only channel/i);
  for (const inverted of [
    "This is not your only channel.",
    "This is never your only channel.",
    "This is no longer your only channel.",
    "This isn't your only channel.",
  ])
    assert.ok(!holds(channel, inverted), inverted);
  assert.ok(holds(channel, "Do not guess; this is your only channel."));
  assert.ok(
    holds(channel, "It does not narrow anything — this is your only channel."),
  );
});

test("every broken row is reported together, with its surface", () => {
  assert.deepEqual(
    brokenRules(() =>
      assertPromptRules({
        first: { text: "kept", rules: { kept: /kept/, lost: /lost/ } },
        second: {
          text: "too long",
          rules: { short: (text) => text.length < 3, lost: /lost/ },
        },
      }),
    ),
    ["first › lost", "second › short", "second › lost"],
  );
});
