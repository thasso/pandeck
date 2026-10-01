import assert from "node:assert/strict";
import { test } from "vitest";
import { absent, assertPromptRules, forbidden } from "./promptRules.ts";

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
