import assert from "node:assert/strict";
import { test } from "vitest";
import { scannerSystemPrompt } from "./meetingMinutesScannerTools.ts";

test("the scanner prompt names the profile user when a name is set", () => {
  const prompt = scannerSystemPrompt("  Ada   Lovelace ");
  assert.match(prompt, /extract the user \(Ada Lovelace\)'s follow-up actions/);
  assert.doesNotMatch(prompt, /Alice/);
});

test("the scanner prompt reads 'the user' without a name, gender-neutrally", () => {
  const prompt = scannerSystemPrompt("");
  assert.match(prompt, /extract the user's follow-up actions/);
  assert.doesNotMatch(prompt, /\(\)/);
  assert.doesNotMatch(prompt, /Alice/);
  assert.doesNotMatch(prompt, /\b(his|him|he|her|she)\b/i);
});
