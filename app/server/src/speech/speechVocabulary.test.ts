import assert from "node:assert/strict";
import { test } from "vitest";
import { applySpeechVocabulary } from "@assistant/shared";

test("rewrites a spoken phrase to its written form, case-insensitively", () => {
  const rules = [{ from: "forge joe", to: "Forgejo" }];
  assert.equal(
    applySpeechVocabulary("Push it to Forge Joe now.", rules),
    "Push it to Forgejo now.",
  );
  assert.equal(
    applySpeechVocabulary("forge joe is down", rules),
    "Forgejo is down",
  );
});

test("only whole words match, so a rule cannot corrupt a longer word", () => {
  const rules = [{ from: "jira", to: "Jira" }];
  assert.equal(applySpeechVocabulary("jiraffe", rules), "jiraffe");
  assert.equal(
    applySpeechVocabulary("check jira please", rules),
    "check Jira please",
  );
});

test("tolerates the extra whitespace a recognizer may emit inside a phrase", () => {
  assert.equal(
    applySpeechVocabulary("ack  me ships it", [{ from: "ack me", to: "Acme" }]),
    "Acme ships it",
  );
});

test("longer phrases win over shorter overlapping ones regardless of rule order", () => {
  const rules = [
    { from: "sherpa", to: "Sherpa" },
    { from: "sherpa onyx", to: "sherpa-onnx" },
  ];
  assert.equal(
    applySpeechVocabulary("we use sherpa onyx here", rules),
    "we use sherpa-onnx here",
  );
});

test("rewrites every occurrence, not just the first", () => {
  assert.equal(
    applySpeechVocabulary("jeera then jeera again", [
      { from: "jeera", to: "Jira" },
    ]),
    "Jira then Jira again",
  );
});

test("empty text, empty rules, and blank rules are no-ops", () => {
  assert.equal(applySpeechVocabulary("", [{ from: "a", to: "b" }]), "");
  assert.equal(applySpeechVocabulary("unchanged", []), "unchanged");
  assert.equal(
    applySpeechVocabulary("unchanged", [{ from: "   ", to: "x" }]),
    "unchanged",
  );
});

test("regex metacharacters in a rule are matched literally", () => {
  assert.equal(
    applySpeechVocabulary("what about c++ then", [{ from: "c++", to: "C++" }]),
    "what about C++ then",
  );
  assert.equal(
    applySpeechVocabulary("a.b stays", [{ from: "a.b", to: "AB" }]),
    "AB stays",
  );
  assert.equal(
    applySpeechVocabulary("axb untouched", [{ from: "a.b", to: "AB" }]),
    "axb untouched",
  );
});
