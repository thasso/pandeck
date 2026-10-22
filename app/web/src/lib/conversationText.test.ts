import { describe, expect, it } from "vitest";
import {
  speechChunks,
  spokenMarkdown,
  isPlaybackEcho,
} from "./conversationText.ts";
import { ConversationResampler } from "./conversationCapture.ts";

describe("spoken prose", () => {
  it("strips markdown, speaks link text and skips images, tables and references", () => {
    expect(
      spokenMarkdown(
        "# Hello **world**.\n- Visit [our site](https://example.com).\n![photo](x)\n| a | b |\n|---|---|\n| x | y |\n[ref]: https://example.com\n`inline` is fine.",
      ),
    ).toBe("Hello world. Visit our site. inline is fine.");
  });
  it("replaces closed, open and tilde fences once, never leaking code", () => {
    expect(
      spokenMarkdown("Before.\n```ts\nsecret();\n```\nAfter.\n~~~\nmore code"),
    ).toBe("Before. Code omitted. After. Code omitted.");
    expect(spokenMarkdown("```python\nprint('one. two.')")).toBe(
      "Code omitted.",
    );
    expect(
      spokenMarkdown("```\n```not a closing fence\nprivate code\n```\nDone."),
    ).toBe("Code omitted. Done.");
    expect(spokenMarkdown("````\n```\ninner\n````\nDone.")).toBe(
      "Code omitted. Done.",
    );
  });
  it("omits indented code blocks too", () => {
    expect(
      spokenMarkdown(
        "Here is code.\n\n    secret();\n    more();\n\nAfterwards.",
      ),
    ).toBe("Here is code. Code omitted. Afterwards.");
  });
  it("waits for a complete sentence, flushes final tails and preserves decimals and abbreviations", () => {
    expect(speechChunks("Hello. Still talk", false)).toEqual(["Hello."]);
    expect(speechChunks("Hello.", false)).toEqual([]);
    expect(speechChunks("Dr. Smith has 1.2 apples. Fine!", true)).toEqual([
      "Dr. Smith has 1.2 apples.",
      "Fine!",
    ]);
    expect(speechChunks("No punctuation", true)).toEqual(["No punctuation"]);
    expect(speechChunks('She said "Hello." Then left.', true)).toEqual([
      'She said "Hello."',
      "Then left.",
    ]);
  });
  it("keeps chunks within the server limit, including unbroken text", () => {
    for (const text of ["word ".repeat(400), "a".repeat(1200)]) {
      const chunks = speechChunks(text, true);
      expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
      expect(chunks.join("").replaceAll(" ", "")).toBe(
        text.replaceAll(" ", ""),
      );
      expect(speechChunks(text, false)).toEqual(chunks.slice(0, -1));
    }
  });
  it("never releases unfinished link destinations", () => {
    expect(speechChunks("Read [a link](https://private.", false)).toEqual([]);
    expect(
      speechChunks("Read [a link](https://private.test). Yes.", true),
    ).toEqual(["Read a link.", "Yes."]);
  });
  it("distinguishes matching speaker feedback from real interruption", () => {
    expect(isPlaybackEcho("Hello WORLD", "Hello, world. How are you?")).toBe(
      true,
    );
    expect(isPlaybackEcho("stop", "Hello, world.")).toBe(false);
    expect(isPlaybackEcho("he", "the world")).toBe(false);
    expect(isPlaybackEcho("", "Hello")).toBe(false);
  });
});

it("resamples arbitrary rates continuously across frame boundaries", () => {
  const frame = Int16Array.from({ length: 44100 }, (_, index) => index % 30000);
  const whole = new ConversationResampler(44100).push(frame);
  const fragmented = new ConversationResampler(44100);
  const parts = [];
  for (let i = 0; i < frame.length; i += 8820)
    parts.push(...fragmented.push(frame.subarray(i, i + 8820)));
  expect(parts).toEqual(Array.from(whole));
  expect(whole.length).toBe(16000);
  expect(new ConversationResampler(16000).push(frame)).toBe(frame);
});
