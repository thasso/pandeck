import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  speechChunks,
  speechSegments,
  spokenMarkdown,
  isPlaybackEcho,
} from "./conversationText.ts";
import { ConversationResampler } from "./conversationCapture.ts";

const renderGfm = (markdown: string) =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown),
  );

describe("spoken prose", () => {
  it.each(["Done", "`ps | grep server`", "Escaped \\| cell"])(
    "M3-R4: GFM table body rows need no structural pipes: %s",
    (row) => {
      for (const header of [
        "| Task | Status |\n| --- | --- |",
        "Task | Status\n--- | ---",
      ]) {
        const markdown = `${header}\n${row}\n\nAfter.`;
        const rendered = renderGfm(markdown);
        expect(rendered).toContain("<tbody><tr><td>");
        expect(rendered).toMatch(/<\/tbody><\/table>\s*<p>After\.<\/p>$/);
        expect(spokenMarkdown(markdown)).toBe("After.");
        expect(spokenMarkdown(`${header}\n${row}`)).toBe("");
      }
    },
  );

  it.each([
    ["# Heading.\nAfter.", "<h1>", "Heading. After."],
    ["#\nAfter.", "<h1>", "After."],
    ["- Listed.\nAfter.", "<ul>", "Listed. After."],
    ["2. Ordered.\nAfter.", '<ol start="2">', "Ordered. After."],
    ["> Quoted.\nAfter.", "<blockquote>", "Quoted. After."],
    ["```ts\nsecret();\n```\nAfter.", "<pre>", "Code omitted. After."],
    ["~~~\nsecret();\n~~~\nAfter.", "<pre>", "Code omitted. After."],
    ["    secret();\n\nAfter.", "<pre>", "Code omitted. After."],
    ["---\nAfter.", "<hr/>", "After."],
    ["<div>Block.</div>\n\nAfter.", "&lt;div&gt;", "Block. After."],
  ])(
    "M3-R4: a new GFM block ends table suppression: %s",
    (suffix, tag, expected) => {
      const markdown = `| Task | Status |\n| --- | --- |\nDone\n${suffix}`;
      const rendered = renderGfm(markdown);
      expect(rendered).toContain("</table>");
      expect(rendered.indexOf(tag)).toBeGreaterThan(
        rendered.indexOf("</table>"),
      );
      expect(spokenMarkdown(markdown)).toBe(expected);
    },
  );

  it.each([
    "<span>Secret.</span>",
    "####### Secret.",
    "===",
    "[ref]: https://example.com",
  ])("M3-R4: inline-looking rows remain inside GFM tables: %s", (row) => {
    const markdown = `a | b\n--- | ---\n${row}\n\nAfter.`;
    expect(renderGfm(markdown)).toContain("<tbody><tr><td>");
    expect(spokenMarkdown(markdown)).toBe("After.");
  });

  it("M3-R4: quoted short rows and every streaming prefix stay silent until the table ends", () => {
    for (const markdown of [
      "| Task | Status |\n| --- | --- |\nSensitive. More data\nEscaped \\| cell\n`ps | grep server`\n\nAfter.",
      "> | Task | Status |\n> | --- | --- |\n> Sensitive. More data\n>\n> After.",
      "```md\n| Task | Status |\n| --- | --- |\nSensitive.\n```\n\nAfter.",
    ]) {
      let cursor = 0;
      const spoken: string[] = [];
      for (let length = 0; length <= markdown.length; length++) {
        const segments = speechSegments(
          markdown.slice(0, length),
          false,
          cursor,
        );
        spoken.push(...segments.map((segment) => segment.text));
        cursor = segments.at(-1)?.end ?? cursor;
      }
      spoken.push(
        ...speechSegments(markdown, true, cursor).map(
          (segment) => segment.text,
        ),
      );
      expect(spoken).toEqual(
        markdown.startsWith("```") ? ["Code omitted.", "After."] : ["After."],
      );
    }
  });
  it("M3-R1: withholds a trailing sentence that can still become a table header", () => {
    const markdown = "Header. | State\n--- | ---\nx | y\n\nAfter.";
    expect(speechChunks(markdown, true)).toEqual(["After."]);
    for (let length = 0; length <= markdown.length; length++) {
      const prefix = markdown.slice(0, length);
      expect(speechChunks(prefix, false), prefix).toEqual([]);
    }
    expect(speechChunks("Header. ", false)).toEqual([]);
    expect(speechChunks("First. Next sentence", false)).toEqual(["First."]);
  });
  it.each([
    "Before. Next.\nHeader. More prose | State\n--- | ---\nx | y\n\nAfter. Final.",
    "> Header. More | State\n> :--- | ---:\n> x | y\n\nAfter. Final.",
    "First. [documentation](https://example.com) helps. **Again. More** follows. First. Again.",
    "Before. Next.\n```ts\nprivate();\n```\nAfter. More.\n\n    secret();\n\nDone.",
    "Words &amp; **formatting**. More words. " + "long ".repeat(150) + "End.",
  ])("source cursors never repeat or skip later prose: %s", (markdown) => {
    let cursor = 0;
    const spoken: string[] = [];
    for (let length = 0; length <= markdown.length; length++) {
      const segments = speechSegments(markdown.slice(0, length), false, cursor);
      for (const segment of segments) {
        expect(segment.end).toBeGreaterThan(cursor);
        expect(segment.text.length).toBeLessThanOrEqual(500);
        cursor = segment.end;
        spoken.push(segment.text);
      }
    }
    const final = speechSegments(markdown, true, cursor);
    spoken.push(...final.map((segment) => segment.text));
    const output = spoken.join(" ");
    if (markdown.includes("State")) {
      expect(output).toContain("After.");
      expect(output).not.toMatch(/---|x \| y|State/);
      expect(
        spoken.filter((text) => text === "Header.").length,
      ).toBeLessThanOrEqual(1);
    } else {
      expect(output.replaceAll(" ", "")).toBe(
        speechChunks(markdown, true).join("").replaceAll(" ", ""),
      );
    }
    expect(speechSegments(markdown, true, final.at(-1)?.end ?? cursor)).toEqual(
      [],
    );
  });
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
    "speaks exactly once by source position across every token boundary: %s",
    (markdown) => {
      const complete = speechChunks(markdown, true);
      const spoken: string[] = [];
      let cursor = 0;
      for (let length = 0; length <= markdown.length; length++) {
        const segments = speechSegments(
          markdown.slice(0, length),
          false,
          cursor,
        );
        spoken.push(...segments.map((segment) => segment.text));
        cursor = segments.at(-1)?.end ?? cursor;
        expect(spoken, `prefix ${markdown.slice(0, length)}`).toEqual(
          complete.slice(0, spoken.length),
        );
      }
      spoken.push(
        ...speechSegments(markdown, true, cursor).map(
          (segment) => segment.text,
        ),
      );
      expect(spoken).toEqual(complete);
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
        "# Hello **world**.\n- Visit [our site](https://example.com).\n![photo](x)\n| a | b |\n|---|---|\n| x | y |\n\n[ref]: https://example.com\n`inline` is fine.",
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
