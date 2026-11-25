/**
 * The pure per-account alias rule (`docs/agent-harnesses.md`, models port):
 * which concrete Claude id an alias, pin and stored pin run on one listing.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
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

describe("refused ids (Task-1483)", () => {
  const refused = (...ids: string[]) => new Set(ids);

  test("an alias skips a refused candidate on a known and an unknown account", () => {
    assert.equal(
      resolveClaudeSdkModel(
        "fable",
        set(COMPANY),
        undefined,
        undefined,
        refused("claude-fable-5-2"),
      ),
      "claude-fable-5-1",
    );
    assert.equal(
      resolveClaudeSdkModel(
        "fable",
        undefined,
        undefined,
        undefined,
        refused("claude-fable-5-2"),
      ),
      "claude-fable-5-1",
    );
    // A refusal of an id the alias does not run changes nothing.
    assert.equal(
      resolveClaudeSdkModel(
        "fable",
        set(COMPANY),
        undefined,
        undefined,
        refused("claude-sonnet-5-5"),
      ),
      "claude-fable-5-2",
    );
  });

  test("every candidate refused: the alias is not offered", () => {
    const all = refused("claude-fable-5-2", "claude-fable-5-1");
    assert.equal(
      resolveClaudeSdkModel("fable", set(COMPANY), undefined, undefined, all),
      undefined,
    );
    assert.equal(
      resolveClaudeSdkModel("fable", undefined, undefined, undefined, all),
      undefined,
    );
  });

  test.each([
    ["known", set(COMPANY)],
    ["unknown", undefined],
  ] as const)("a refused pin is never repointed (%s account)", (_, listed) => {
    const marks = refused("claude-fable-5-2");
    assert.equal(
      resolveClaudeSdkModel(
        "fable",
        listed,
        "claude-fable-5-2",
        undefined,
        marks,
      ),
      undefined,
    );
    assert.equal(
      resolveClaudeSdkModel(
        "fable",
        listed,
        "claude-fable-5-1",
        undefined,
        marks,
      ),
      "claude-fable-5-1",
    );
  });

  test("a refused legacy persisted pin lacks; unrefused it still runs (D1-legacy)", () => {
    assert.equal(
      resolveClaudeSdkModel(
        "opus",
        undefined,
        "claude-opus-5",
        "claude-opus-5",
        refused("claude-opus-5"),
      ),
      undefined,
    );
    assert.equal(
      resolveClaudeSdkModel(
        "opus",
        undefined,
        "claude-opus-5",
        "claude-opus-5",
        refused("claude-opus-5-5"),
      ),
      "claude-opus-5",
    );
  });

  test("mythos stays not offered on an unknown account", () => {
    assert.equal(
      resolveClaudeSdkModel(
        "mythos",
        undefined,
        undefined,
        undefined,
        refused("claude-mythos-5-2"),
      ),
      undefined,
    );
    assert.equal(
      resolveClaudeSdkModel(
        "mythos",
        set(COMPANY),
        undefined,
        undefined,
        refused("claude-mythos-5-2"),
      ),
      "claude-mythos-5-1",
    );
  });
});
