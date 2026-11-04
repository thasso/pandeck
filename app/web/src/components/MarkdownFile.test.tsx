// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownFile } from "./MarkdownFile.tsx";

/** Opens a frontmatter section the way a reader's earlier toggle would. */
function remembersOpen(id: string) {
  window.localStorage.setItem(`inspector-section:document:${id}`, "open");
}

describe("MarkdownFile", () => {
  afterEach(() => window.localStorage.clear());

  it("starts the metadata section collapsed", () => {
    const html = renderToStaticMarkup(
      <MarkdownFile text={"---\ntitle: Release notes\n---\n# Heading\n"} />,
    );
    expect(html).toMatch(/aria-expanded="false"[^]*>Metadata</);
    expect(html).not.toContain("Release notes");
    expect(html).toContain("Heading</h1>");
  });

  it("draws frontmatter as a header instead of Markdown", () => {
    remembersOpen("markdown-metadata");
    const html = renderToStaticMarkup(
      <MarkdownFile
        text={
          "---\ntitle: Release notes\ntags: [release]\nstatus: draft\n---\n# Heading\n"
        }
      />,
    );
    expect(html).toContain('aria-label="Document metadata"');
    // One property list: each key read as a label, beside its value.
    const doc = new DOMParser().parseFromString(html, "text/html");
    const value = (label: string) =>
      [...doc.querySelectorAll('[aria-label="Document metadata"] span')].find(
        (span) => span.textContent === label,
      )?.nextElementSibling?.textContent;
    expect(value("Title")).toBe("Release notes");
    expect(value("Status")).toBe("Draft");
    expect(html).toMatch(/<li><span[^>]*>release<\/span><\/li>/);
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
    expect(html).toMatch(/aria-expanded="false"[^]*>Frontmatter</);
    expect(html).not.toContain("summary: |");
    expect(html).toContain("Body");
    remembersOpen("frontmatter");
    expect(
      renderToStaticMarkup(
        <MarkdownFile text={"---\nsummary: |\n  multi\n---\nBody\n"} />,
      ),
    ).toContain("summary: |");
  });

  it("renders a file without frontmatter like plain Markdown", () => {
    const html = renderToStaticMarkup(<MarkdownFile text={"# Only\n"} />);
    expect(html).not.toContain("Document metadata");
    expect(html).toContain("Only</h1>");
  });
});
