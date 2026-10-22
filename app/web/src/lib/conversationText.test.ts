import { describe, expect, it } from "vitest";
import {
  speechChunks,
  spokenMarkdown,
  isPlaybackEcho,
} from "./conversationText.ts";
import { ConversationResampler } from "./conversationCapture.ts";

describe("spoken prose", () => {
  it("M3-C4: keeps ordinary prose and inline code containing pipes", () => {
    expect(
      spokenMarkdown("Run `ps | grep server` to check whether it is running."),
    ).toBe("Run ps | grep server to check whether it is running.");
    expect(spokenMarkdown("Choose red | blue. Both are valid.")).toBe(
      "Choose red | blue. Both are valid.",
    );
  });
  it("keeps only real tables out of prose, including optional outer pipes and alignment", () => {
    expect(
      spokenMarkdown(
        "Before.\nname | state\n:--- | ---:\napp | ready\n\nAfter.",
      ),
    ).toBe("Before. After.");
    expect(
      spokenMarkdown(
        "| name | state |\n| not a delimiter | still prose |\nNext.",
      ),
    ).toContain("not a delimiter");
    expect(spokenMarkdown("Run `ps | grep server`.\nNo table here.")).toBe(
      "Run ps | grep server. No table here.",
    );
    expect(spokenMarkdown("A \\| B.\n--- | ---\nNot a table.")).toContain(
      "A \\| B.",
    );
    expect(spokenMarkdown("```\n| a | b |\n|---|---|\n```\nDone.")).toBe(
      "Code omitted. Done.",
    );
    expect(
      spokenMarkdown("> | a | b |\n> |---|---|\n> | x | y |\n\nDone."),
    ).toBe("Done.");
    expect(spokenMarkdown("> Choose a | b.\n\nDone.")).toBe(
      "Choose a | b. Done.",
    );
  });
  it.each([
    "First. [documentation](https://example.com) helps. [More](https://other.test) follows.",
    "First. `inline. code` works. **Bold. Words** follow. _Last. part_ ends.",
    "First. ***Nested. emphasis*** works. ~~Old. text~~ ends.",
    "First. ``code with `nested` ticks.`` works. [label][ref] follows.",
    "First. ![picture](https://image.test) <b>Second.</b> More.",
  ])(
    "emits only a monotonic stable prefix across every token boundary: %s",
    (markdown) => {
      const complete = speechChunks(markdown, true);
      let previous: string[] = [];
      for (let length = 0; length <= markdown.length; length++) {
        const chunks = speechChunks(markdown.slice(0, length), false);
        expect(chunks, `prefix ${markdown.slice(0, length)}`).toEqual(
          complete.slice(0, chunks.length),
        );
        expect(chunks.slice(0, previous.length)).toEqual(previous);
        previous = chunks;
      }
    },
  );
  it("holds unfinished formatting and table candidates without leaking destinations", () => {
    expect(speechChunks("First. [documentation]", false)).toEqual(["First."]);
    expect(speechChunks("First. `Second. unfinished", false)).toEqual([
      "First.",
    ]);
    expect(speechChunks("First. **Second. unfinished", false)).toEqual([
      "First.",
    ]);
    expect(speechChunks("Header. | State\n|---", false)).toEqual([]);
    expect(speechChunks("Run `ps | grep server` to check.", true)).toEqual([
      "Run ps | grep server to check.",
    ]);
  });
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
    expect(
      isPlaybackEcho("local test resp", "local test responder", true),
    ).toBe(true);
    expect(isPlaybackEcho("local test resp", "local test responder")).toBe(
      false,
    );
    expect(isPlaybackEcho("he", "the world", true)).toBe(false);
    expect(isPlaybackEcho("stop", "Hello, world.", true)).toBe(false);
    expect(isPlaybackEcho("stop", "stopping soon", true)).toBe(false);
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
