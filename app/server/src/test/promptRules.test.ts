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

test("forbidden() needs one negated sentence naming every act, in any order", () => {
  const rule = forbidden("push", "commit");
  const check = (text: string) =>
    brokenRules(() => assertPromptRules({ s: { text, rules: { rule } } }));
  assert.deepEqual(check("Never commit or push. Then stop."), []);
  assert.deepEqual(check("Do not push; do not commit either."), []);
  assert.deepEqual(check("Commit your work. Do not push."), ["s › rule"]);
  assert.deepEqual(check("Commit and push."), ["s › rule"]);
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
