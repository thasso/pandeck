/**
 * The Settings vocabulary editor previews rules with `applySpeechVocabulary`
 * imported from `@assistant/shared` — the exact function the server applies
 * after decoding. These tests assert the browser can reach it through the web
 * package's `@assistant/shared` alias and that its behaviour is the literal,
 * single-pass one the editor's copy promises. A reimplementation on either side
 * would make the preview lie, which is the whole reason the engine is shared.
 */
import { describe, expect, it } from "vitest";
import { applySpeechVocabulary } from "@assistant/shared";

describe("vocabulary preview in Settings", () => {
  it("rewrites whole words case-insensitively and keeps the written casing", () => {
    expect(
      applySpeechVocabulary("push it to Forge Joe", [
        { from: "forge joe", to: "Forgejo" },
      ]),
    ).toBe("push it to Forgejo");
  });

  it("leaves text alone when nothing matches, so the editor can say so", () => {
    expect(
      applySpeechVocabulary("nothing to fix here", [
        { from: "forge joe", to: "Forgejo" },
      ]),
    ).toBe("nothing to fix here");
  });

  it("never rewrites its own output, so a preview cannot cascade", () => {
    const rules = [
      { from: "sherpa", to: "Sherpa" },
      { from: "sherpa onyx", to: "sherpa-onnx" },
    ];
    expect(applySpeechVocabulary("we use sherpa onyx", rules)).toBe(
      "we use sherpa-onnx",
    );
  });

  it("treats a half-typed rule as inert rather than throwing mid-keystroke", () => {
    // The editor saves on every keystroke, so blank and regex-ish input must be safe.
    expect(applySpeechVocabulary("some text", [{ from: "", to: "x" }])).toBe(
      "some text",
    );
    expect(applySpeechVocabulary("a(b", [{ from: "a(", to: "A-" }])).toBe(
      "A-b",
    );
  });
});
