import { describe, expect, it } from "vitest";
import {
  appendTranscript,
  MAX_RECENT_TRANSCRIPTS,
  MAX_TRANSCRIPT_CHARS,
  parseStoredTranscripts,
  transcriptAge,
  type RecentTranscript,
} from "./recentTranscripts.ts";

/** Build a list newest-first by appending in chronological order. */
function listOf(...texts: string[]): RecentTranscript[] {
  return texts.reduce<RecentTranscript[]>(
    (acc, text, i) => appendTranscript(acc, text, i + 1),
    [],
  );
}

describe("appendTranscript", () => {
  it("puts the newest first", () => {
    expect(listOf("first", "second").map((e) => e.text)).toEqual([
      "second",
      "first",
    ]);
  });

  it("ignores an immediate repeat, so re-dictating a phrase does not fill the list", () => {
    expect(listOf("same words", "same words")).toHaveLength(1);
  });

  it("keeps a repeat that is not consecutive", () => {
    expect(listOf("alpha", "beta", "alpha").map((e) => e.text)).toEqual([
      "alpha",
      "beta",
      "alpha",
    ]);
  });

  it("bounds the list so it cannot grow without limit", () => {
    const many = listOf(
      ...Array.from({ length: 40 }, (_, i) => `utterance ${i}`),
    );
    expect(many).toHaveLength(MAX_RECENT_TRANSCRIPTS);
    expect(many[0]!.text).toBe("utterance 39");
  });

  it("truncates a long dictation — rules are made of words, not paragraphs", () => {
    expect(appendTranscript([], "x".repeat(1000), 1)[0]!.text).toHaveLength(
      MAX_TRANSCRIPT_CHARS,
    );
  });

  it("trims, and drops a blank transcript without disturbing the list", () => {
    const existing = listOf("kept");
    expect(appendTranscript(existing, "   ", 2)).toBe(existing);
    expect(appendTranscript(existing, "  padded  ", 2)[0]!.text).toBe("padded");
  });

  it("records when the entry was captured, for the age label", () => {
    expect(appendTranscript([], "spoken", 1_700_000_000_000)[0]!.at).toBe(
      1_700_000_000_000,
    );
  });
});

describe("parseStoredTranscripts", () => {
  it("round-trips what we write", () => {
    const stored = listOf("alpha", "beta");
    expect(parseStoredTranscripts(JSON.stringify(stored))).toEqual(stored);
  });

  it("survives corrupt storage rather than breaking the settings page", () => {
    expect(parseStoredTranscripts("{not json")).toEqual([]);
    expect(parseStoredTranscripts(null)).toEqual([]);
    expect(parseStoredTranscripts('"a string"')).toEqual([]);
  });

  it("drops entries of the wrong shape", () => {
    const raw = JSON.stringify([
      { text: 5 },
      "nope",
      null,
      { at: 1 },
      { text: "ok", at: 1 },
    ]);
    expect(parseStoredTranscripts(raw).map((e) => e.text)).toEqual(["ok"]);
  });

  it("bounds what it reads, not just what it writes", () => {
    const raw = JSON.stringify(
      Array.from({ length: 50 }, (_, i) => ({ text: `t${i}`, at: i })),
    );
    expect(parseStoredTranscripts(raw)).toHaveLength(MAX_RECENT_TRANSCRIPTS);
  });
});

describe("transcriptAge", () => {
  it("reads as a compact relative age", () => {
    const now = 1_000_000_000_000;
    expect(transcriptAge(now - 5_000, now)).toBe("just now");
    expect(transcriptAge(now - 14 * 60_000, now)).toBe("14m");
    expect(transcriptAge(now - 3 * 3_600_000, now)).toBe("3h");
    expect(transcriptAge(now - 2 * 86_400_000, now)).toBe("2d");
  });

  it("never shows a negative age from clock skew", () => {
    const now = 1_000_000_000_000;
    expect(transcriptAge(now + 60_000, now)).toBe("just now");
  });
});
