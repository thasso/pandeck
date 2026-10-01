import { describe, expect, test } from "vitest";
import { storageToMarkdown } from "./storageToMarkdown.ts";

describe("storageToMarkdown", () => {
  test("converts ordinary markup", () => {
    expect(
      storageToMarkdown(
        "<h2>Runbook</h2><p>Deploy on <strong>Monday</strong>, see <a href='https://x.test'>docs</a>.</p><ul><li>one</li><li>two</li></ul>",
      ),
    ).toBe(
      [
        "## Runbook",
        "",
        "Deploy on **Monday**, see [docs](https://x.test).",
        "",
        "*   one",
        "*   two",
      ].join("\n"),
    );
  });

  test("renders a table as GFM instead of flattening it", () => {
    const markdown = storageToMarkdown(
      "<table><tbody><tr><th>Env</th><th>Host</th></tr><tr><td>prod</td><td>pa.example.net</td></tr></tbody></table>",
    );
    expect(markdown).toBe(
      ["| Env | Host |", "| --- | --- |", "| prod | pa.example.net |"].join(
        "\n",
      ),
    );
  });

  test("names a macro and keeps its body, without leaking its parameters", () => {
    const markdown = storageToMarkdown(
      '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Heads up</ac:parameter><ac:rich-text-body><p>Read this first</p></ac:rich-text-body></ac:structured-macro>',
    );
    expect(markdown).toContain("[macro: info title=Heads up]");
    expect(markdown).toContain("Read this first");
    // The parameter appears in the label, not loose in the body text.
    expect(markdown.split("[macro: info title=Heads up]")[1]).not.toContain(
      "Heads up",
    );
  });

  test("keeps an attachment reference visible", () => {
    expect(
      storageToMarkdown(
        '<p><ac:image><ri:attachment ri:filename="diagram.png" /></ac:image></p>',
      ),
    ).toContain("[attachment: diagram.png]");
  });

  test("an empty body stays empty", () => {
    expect(storageToMarkdown("")).toBe("");
  });
});
