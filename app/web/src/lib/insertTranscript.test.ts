import { describe, expect, it } from "vitest";
import { insertTranscript } from "./insertTranscript.ts";

describe("insertTranscript", () => {
  it("fills an empty draft without leading or trailing space", () => {
    const result = insertTranscript("", "Hello there.", 0);
    expect(result.text).toBe("Hello there.");
    expect(result.selectionStart).toBe("Hello there.".length);
  });

  it("adds the space a recognizer never emits when appending", () => {
    const draft = "First sentence.";
    const result = insertTranscript(draft, "Second sentence.", draft.length);
    expect(result.text).toBe("First sentence. Second sentence.");
  });

  it("does not double an existing space", () => {
    const draft = "First sentence. ";
    const result = insertTranscript(draft, "Second sentence.", draft.length);
    expect(result.text).toBe("First sentence. Second sentence.");
  });

  it("inserts mid-draft with spaces on both sides", () => {
    const draft = "before after";
    const result = insertTranscript(draft, "middle", "before".length);
    expect(result.text).toBe("before middle after");
    // Caret sits right after the spoken words, before the trailing space.
    expect(result.text.slice(0, result.selectionStart)).toBe("before middle");
  });

  it("replaces a selection, like typing over it would", () => {
    const draft = "keep replace-me keep";
    const start = "keep ".length;
    const end = start + "replace-me".length;
    const result = insertTranscript(draft, "spoken", start, end);
    expect(result.text).toBe("keep spoken keep");
  });

  it("never pushes punctuation away from the word before it", () => {
    const draft = ", trailing";
    const result = insertTranscript(draft, "word", 0);
    expect(result.text).toBe("word, trailing");
  });

  it("does not insert a space after an opening bracket", () => {
    const draft = "()";
    const result = insertTranscript(draft, "inside", 1);
    expect(result.text).toBe("(inside)");
  });

  it("trims recognizer padding and ignores an empty transcript", () => {
    expect(insertTranscript("draft", "   ", 5).text).toBe("draft");
    expect(insertTranscript("", "  spoken  ", 0).text).toBe("spoken");
  });

  it("clamps a selection beyond the draft instead of corrupting it", () => {
    const result = insertTranscript("short", "spoken", 999, 1000);
    expect(result.text).toBe("short spoken");
  });

  it("keeps a newline before the insertion intact", () => {
    const draft = "line one\n";
    const result = insertTranscript(draft, "line two", draft.length);
    expect(result.text).toBe("line one\nline two");
  });
});
