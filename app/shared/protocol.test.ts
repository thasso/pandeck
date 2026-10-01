import { describe, expect, test } from "vitest";
import {
  applyPatch,
  CLAUDE_SDK_PROVIDER,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  PEER_PROMPT_EXCERPT_CHARS,
  peerPromptExcerpt,
  providerLabel,
  type Patch,
} from "./protocol.ts";

/**
 * `applyPatch` is the only semantic change `exactOptionalPropertyTypes` brought
 * with it, and `typecheck` cannot cover it: its body ends in a cast, so
 * replacing it with the very bug it exists to prevent —
 * `return { ...base, ...patch } as T` — compiles clean AND passed the whole
 * suite before these tests existed.
 *
 * So every case below is written to FAIL against that spread. In particular the
 * clearing tests assert key ABSENCE (`"k" in out`), never `out.k === undefined`
 * — the latter is true under the bug too, which makes it decoration rather than
 * a control.
 */
interface Card {
  id: string;
  label?: string;
  count?: number;
  flag?: boolean;
  parent?: string | null;
}

describe("applyPatch", () => {
  test("a key set to undefined is REMOVED, not left present-and-undefined", () => {
    const out = applyPatch<Card>(
      { id: "a", label: "hi" },
      { label: undefined },
    );
    expect("label" in out).toBe(false);
    expect(Object.keys(out)).toEqual(["id"]);
  });

  test("an absent key leaves the base value alone", () => {
    const out = applyPatch<Card>({ id: "a", label: "hi" }, { count: 1 });
    expect(out.label).toBe("hi");
    expect(out.count).toBe(1);
  });

  test("clearing one key does not disturb its siblings", () => {
    const out = applyPatch<Card>(
      { id: "a", label: "hi", count: 2 },
      { label: undefined },
    );
    expect("label" in out).toBe(false);
    expect(out).toEqual({ id: "a", count: 2 });
  });

  // The distinction the flag is about: `undefined` means "clear", but every
  // OTHER falsy value is a value. `null` is the one that matters most — a patch
  // carrying `parent: null` means "move to root", and deleting it instead would
  // silently mean "leave the parent alone".
  test("falsy but DEFINED values are set, not deleted", () => {
    const out = applyPatch<Card>(
      { id: "a", label: "hi", count: 9, flag: true, parent: "p" },
      { label: "", count: 0, flag: false, parent: null },
    );
    expect("label" in out).toBe(true);
    expect(out.label).toBe("");
    expect(out.count).toBe(0);
    expect(out.flag).toBe(false);
    expect(out.parent).toBeNull();
  });

  test("null is stored, never treated as a clear", () => {
    const out = applyPatch<Card>({ id: "a", parent: "p" }, { parent: null });
    expect("parent" in out).toBe(true);
    expect(out.parent).toBeNull();
  });

  test("the base is not mutated", () => {
    const base: Card = { id: "a", label: "hi", count: 3 };
    const out = applyPatch(base, { label: undefined, count: 4 });
    expect(base).toEqual({ id: "a", label: "hi", count: 3 });
    expect("label" in base).toBe(true);
    expect(out).not.toBe(base);
  });

  test("an empty patch is a plain copy", () => {
    const base: Card = { id: "a", label: "hi" };
    const out = applyPatch(base, {});
    expect(out).toEqual(base);
    expect(out).not.toBe(base);
  });

  test("clearing a key the base never had is a no-op, not a new key", () => {
    const out = applyPatch<Card>({ id: "a" }, { label: undefined });
    expect("label" in out).toBe(false);
    expect(Object.keys(out)).toEqual(["id"]);
  });

  // The shape the settings writers rely on: a conditional-literal spread builds
  // the patch, so "clear" and "set" arrive through the same call.
  test("a patch assembled from conditional spreads clears and sets together", () => {
    const clear = true;
    const patch: Patch<Card> = {
      ...(clear ? { label: undefined } : {}),
      count: 1,
    };
    const out = applyPatch<Card>({ id: "a", label: "old", count: 0 }, patch);
    expect("label" in out).toBe(false);
    expect(out.count).toBe(1);
  });
});

/**
 * The peer-prompt history projection carries excerpts, not messages: a
 * coordinator's `SessionState` rode 130 KB of full agent briefs on every
 * `state` broadcast so a collapsed panel could draw two clamped lines. The
 * excerpt is built once, server-side, and rendered verbatim — so it has to be
 * BOUNDED (or the bytes come back) and already FLAT (or the client would have
 * to reshape it, which is where the second ellipsis came from).
 */
describe("peerPromptExcerpt", () => {
  test("collapses every run of whitespace to one space and trims", () => {
    expect(peerPromptExcerpt("please review\n\nthe lease sweep")).toBe(
      "please review the lease sweep",
    );
    expect(peerPromptExcerpt("  padded\t\tmessage  ")).toBe("padded message");
  });

  test("bounds the result, ellipsis included", () => {
    const long = "x".repeat(PEER_PROMPT_EXCERPT_CHARS * 10);
    const excerpt = peerPromptExcerpt(long);
    expect(excerpt.length).toBe(PEER_PROMPT_EXCERPT_CHARS);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  test("is idempotent, so a re-excerpt never adds a second ellipsis", () => {
    const once = peerPromptExcerpt("y".repeat(1_000));
    expect(peerPromptExcerpt(once)).toBe(once);
  });

  test("leaves a message that already fits exactly as it is", () => {
    const short = "approved";
    expect(peerPromptExcerpt(short)).toBe(short);
    const exact = "z".repeat(PEER_PROMPT_EXCERPT_CHARS);
    expect(peerPromptExcerpt(exact)).toBe(exact);
  });
});

describe("providerLabel", () => {
  test("prefers a provider's own display name over its id", () => {
    expect(providerLabel(OPENAI_COMPATIBLE_PROVIDER_ID, " Team LLM ")).toBe(
      "Team LLM",
    );
    expect(providerLabel(OPENAI_COMPATIBLE_PROVIDER_ID, "  ")).toBe(
      OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    expect(providerLabel(CLAUDE_SDK_PROVIDER)).toBe("Claude SDK");
    expect(providerLabel("github-copilot")).toBe("github-copilot");
  });
});
