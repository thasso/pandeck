/**
 * The pure per-account alias rule (`docs/agent-harnesses.md`, models port):
 * which concrete Claude id an alias, pin and stored pin run on one listing.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { COMPANY, PRIVATE, Y, Z } from "../test/claudeListings.ts";
import { resolveClaudeSdkModel } from "./modelResolution.ts";

const set = (ids: readonly string[]): ReadonlySet<string> => new Set(ids);

test("a known account runs the first candidate it lists", () => {
  assert.equal(
    resolveClaudeSdkModel("fable", set(COMPANY)),
    "claude-fable-5-2",
  );
  assert.equal(
    resolveClaudeSdkModel("mythos", set(COMPANY)),
    "claude-mythos-5-2",
  );
  assert.equal(
    resolveClaudeSdkModel(
      "mythos",
      set(COMPANY.filter((id) => id !== "claude-mythos-5-2")),
    ),
    "claude-mythos-5-1",
  );
  assert.equal(resolveClaudeSdkModel("mythos", set(PRIVATE)), undefined);
  assert.equal(resolveClaudeSdkModel("fable", set(Y)), "claude-fable-5-1");
  assert.equal(resolveClaudeSdkModel("fable", set(Z)), undefined);
  assert.equal(resolveClaudeSdkModel("opus", set(Z)), "claude-opus-5-5");
});

test("an unknown account runs the newest candidate of an alias offered without a listing", () => {
  assert.equal(resolveClaudeSdkModel("fable", undefined), "claude-fable-5-2");
  assert.equal(resolveClaudeSdkModel("opus", undefined), "claude-opus-5-5");
  assert.equal(resolveClaudeSdkModel("mythos", undefined), undefined);
});

test("a pin on a known account runs only when the account lists it", () => {
  assert.equal(
    resolveClaudeSdkModel("fable", set(Y), "claude-fable-5-2"),
    undefined,
  );
  assert.equal(
    resolveClaudeSdkModel("fable", set(Y), "claude-fable-5-1"),
    "claude-fable-5-1",
  );
  assert.equal(
    resolveClaudeSdkModel(
      "opus",
      set(COMPANY),
      "claude-opus-5",
      "claude-opus-5",
    ),
    "claude-opus-5",
  );
});

test("a pin on an unknown account runs when it is a candidate, never mythos", () => {
  assert.equal(
    resolveClaudeSdkModel("fable", undefined, "claude-fable-5-1"),
    "claude-fable-5-1",
  );
  assert.equal(
    resolveClaudeSdkModel("mythos", undefined, "claude-mythos-5-2"),
    undefined,
  );
});

test("an unknown account keeps exactly the session's own stored legacy pin", () => {
  assert.equal(
    resolveClaudeSdkModel("opus", undefined, "claude-opus-5", "claude-opus-5"),
    "claude-opus-5",
  );
  // A new pin (no stored one) is not a candidate, so it is refused.
  assert.equal(
    resolveClaudeSdkModel("opus", undefined, "claude-opus-5"),
    undefined,
  );
  assert.equal(
    resolveClaudeSdkModel("opus", undefined, "claude-opus-5", "claude-opus-4"),
    undefined,
  );
});

test("a stored pair whose pin is mythos or another family is refused on an unknown account", () => {
  assert.equal(
    resolveClaudeSdkModel(
      "opus",
      undefined,
      "claude-mythos-5-1",
      "claude-mythos-5-1",
    ),
    undefined,
  );
  assert.equal(
    resolveClaudeSdkModel("fable", undefined, "claude-opus-5", "claude-opus-5"),
    undefined,
  );
});
