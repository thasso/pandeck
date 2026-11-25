/**
 * The remembered model refusals (Task-1483, C3 with the D-2 amendment): one
 * case per clearing rule, and the change listener fires once per actual
 * change, never for a no-op.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import {
  clearAccount,
  clearAll,
  clearListedModels,
  clearModelUnavailable,
  markModelUnavailable,
  modelMarkedUnavailable,
  modelUnavailabilityNow,
  resetModelUnavailabilityForTests,
  subscribeModelUnavailabilityChanged,
  unavailableModelIds,
} from "./modelUnavailability.ts";

const CLAUDE = "claude-sdk";
const CODEX = "openai-codex";
let clock = 1_000;
let changes = 0;
let unsubscribe: () => void = () => {};

beforeEach(() => {
  clock = 1_000;
  changes = 0;
  resetModelUnavailabilityForTests({ now: () => clock });
  unsubscribe = subscribeModelUnavailabilityChanged(() => (changes += 1));
});

afterEach(() => {
  unsubscribe();
  resetModelUnavailabilityForTests();
});

test("a mark is per (account, provider, concrete id) and a repeat is no change", () => {
  markModelUnavailable("x", CLAUDE, "claude-fable-5-2");
  assert.equal(changes, 1);
  markModelUnavailable("x", CLAUDE, "claude-fable-5-2");
  assert.equal(changes, 1, "a repeated mark notifies nobody");
  assert.equal(modelMarkedUnavailable("x", CLAUDE, "claude-fable-5-2"), true);
  assert.equal(modelMarkedUnavailable("y", CLAUDE, "claude-fable-5-2"), false);
  assert.equal(modelMarkedUnavailable("x", CODEX, "claude-fable-5-2"), false);
  assert.equal(modelMarkedUnavailable("x", CLAUDE, "claude-fable-5-1"), false);
  assert.deepEqual([...unavailableModelIds("x", CLAUDE)], ["claude-fable-5-2"]);
  assert.deepEqual([...unavailableModelIds("x", CODEX)], []);
});

test("time passing never clears a mark", () => {
  markModelUnavailable("x", CODEX, "gpt-4o");
  clock += 365 * 24 * 60 * 60_000;
  assert.equal(modelMarkedUnavailable("x", CODEX, "gpt-4o"), true);
});

test("(i) a listing naming the id clears it only when its read started after the mark", () => {
  const before = modelUnavailabilityNow();
  clock += 1;
  markModelUnavailable("x", CLAUDE, "claude-fable-5-2");
  markModelUnavailable("x", CLAUDE, "claude-mythos-5-2");
  changes = 0;
  clearListedModels("x", CLAUDE, new Set(["claude-fable-5-2"]), before);
  assert.equal(modelMarkedUnavailable("x", CLAUDE, "claude-fable-5-2"), true);
  assert.equal(changes, 0, "a listing older than the mark changes nothing");
  // The same instant is not after the mark: the listing may predate it.
  clearListedModels("x", CLAUDE, new Set(["claude-fable-5-2"]), clock);
  assert.equal(modelMarkedUnavailable("x", CLAUDE, "claude-fable-5-2"), true);
  clock += 1;
  const after = modelUnavailabilityNow();
  clearListedModels("x", CLAUDE, new Set(["claude-fable-5-1"]), after);
  assert.equal(changes, 0, "a listing without the id changes nothing");
  clearListedModels("x", CLAUDE, new Set(["claude-fable-5-2"]), after);
  assert.equal(modelMarkedUnavailable("x", CLAUDE, "claude-fable-5-2"), false);
  assert.equal(
    modelMarkedUnavailable("x", CLAUDE, "claude-mythos-5-2"),
    true,
    "an unlisted id stays",
  );
  assert.equal(changes, 1);
  // Another account's or provider's listing clears nothing here.
  clearListedModels("y", CLAUDE, new Set(["claude-mythos-5-2"]), after);
  clearListedModels("x", CODEX, new Set(["claude-mythos-5-2"]), after);
  assert.equal(changes, 1);
});

test("(ii) a successful run clears exactly its (provider, id)", () => {
  markModelUnavailable("x", CODEX, "gpt-4o");
  markModelUnavailable("x", CODEX, "gpt-6.1-sol");
  changes = 0;
  clearModelUnavailable("x", CODEX, "gpt-6.2-sol");
  clearModelUnavailable("x", CLAUDE, "gpt-4o");
  clearModelUnavailable("y", CODEX, "gpt-4o");
  assert.equal(changes, 0);
  clearModelUnavailable("x", CODEX, "gpt-4o");
  assert.equal(changes, 1);
  assert.deepEqual([...unavailableModelIds("x", CODEX)], ["gpt-6.1-sol"]);
});

test("(iii, v) a completed login or deletion clears every mark of that account only", () => {
  markModelUnavailable("x", CODEX, "gpt-4o");
  markModelUnavailable("x", CLAUDE, "claude-fable-5-2");
  markModelUnavailable("y", CODEX, "gpt-4o");
  changes = 0;
  clearAccount("x");
  assert.equal(changes, 1);
  assert.deepEqual([...unavailableModelIds("x", CODEX)], []);
  assert.deepEqual([...unavailableModelIds("x", CLAUDE)], []);
  assert.equal(modelMarkedUnavailable("y", CODEX, "gpt-4o"), true);
  clearAccount("x");
  assert.equal(changes, 1, "an account without marks is no change");
});

test("(iv) the user's Refresh clears every mark", () => {
  markModelUnavailable("x", CODEX, "gpt-4o");
  markModelUnavailable("y", CLAUDE, "claude-fable-5-2");
  changes = 0;
  clearAll();
  assert.equal(changes, 1);
  assert.equal(modelMarkedUnavailable("x", CODEX, "gpt-4o"), false);
  assert.equal(modelMarkedUnavailable("y", CLAUDE, "claude-fable-5-2"), false);
  clearAll();
  assert.equal(changes, 1, "an empty store is no change");
});

test("a mark with no account, provider or id records nothing", () => {
  markModelUnavailable("", CODEX, "gpt-4o");
  markModelUnavailable("x", "", "gpt-4o");
  markModelUnavailable("x", CODEX, "");
  assert.equal(changes, 0);
});
