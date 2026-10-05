// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownFile } from "./MarkdownFile.tsx";

describe("MarkdownFile", () => {
  it("draws frontmatter as a header instead of Markdown", () => {
    const html = renderToStaticMarkup(
      <MarkdownFile
        text={
          "---\ntitle: Release notes\ntags: [release]\nstatus: draft\n---\n# Heading\n"
        }
      />,
    );
    expect(html).toContain('aria-label="Document metadata"');
    expect(html).toContain("Release notes");
    expect(html).toContain(">release</li>");
    expect(html).toContain("<dt");
    expect(html).toContain(">status</dt>");
    expect(html).toContain(">draft</dd>");
    // The fences no longer render as a rule and a setext heading.
    expect(html).not.toContain("<hr");
    expect(html).toContain("Heading</h1>");
  });

  it("keeps body blocks on the file's own source lines", () => {
    const html = renderToStaticMarkup(
      <MarkdownFile
        text={"---\ntitle: Plan\n---\n\nFirst paragraph\n"}
        sourcePositions
      />,
    );
    expect(html).toContain('data-source-line-start="5"');
  });

  it("collapses unparseable frontmatter into a raw disclosure", () => {
    const html = renderToStaticMarkup(
      <MarkdownFile text={"---\nsummary: |\n  multi\n---\nBody\n"} />,
    );
    expect(html).toContain("<details");
    expect(html).toContain("summary: |");
    expect(html).toContain("Body");
  });

  it("renders a file without frontmatter like plain Markdown", () => {
    const html = renderToStaticMarkup(<MarkdownFile text={"# Only\n"} />);
    expect(html).not.toContain("Document metadata");
    expect(html).toContain("Only</h1>");
  });
});
