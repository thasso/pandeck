import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown.tsx";

describe("Markdown source positions", () => {
  it("stamps rendered blocks only when requested", () => {
    const positioned = renderToStaticMarkup(
      <Markdown text={"## Heading\n\nBody"} sourcePositions />,
    );
    expect(positioned).toContain('data-source-line-start="1"');
    expect(positioned).toContain('data-source-line-end="1"');
    expect(positioned).toContain('data-source-line-start="3"');

    const plain = renderToStaticMarkup(<Markdown text="Body" />);
    expect(plain).not.toContain("data-source-line-start");
  });
});

describe("Markdown tables", () => {
  it("keeps wide tables in a keyboard-scrollable region", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={
          "| Capture | Ticket | Scored |\n| --- | --- | --- |\n| one | PA-1 | 2 |"
        }
        sourcePositions
      />,
    );

    expect(html).toContain('class="markdown-table-scroll"');
    expect(html).not.toContain("markdown-table-breakout");
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Scrollable table"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(
      '<table data-source-line-start="1" data-source-line-end="3">',
    );
    expect(
      html.match(/<div class="markdown-table-scroll"[^>]*>/)?.[0],
    ).not.toContain("data-source-line");
    expect(html).toContain("<th>Capture</th>");

    const withoutPositions = renderToStaticMarkup(
      <Markdown text={"| Column |\n| --- |\n| Value |"} />,
    );
    expect(withoutPositions).toContain("<table>");
    expect(withoutPositions).not.toContain("data-source-line");
  });

  it("marks tables for breakout only when requested", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={"| Column |\n| --- |\n| Value |"}
        tableLayout="breakout"
      />,
    );

    expect(html).toContain(
      'class="markdown-table-scroll markdown-table-breakout"',
    );
  });
});

describe("Markdown raw HTML", () => {
  it("renders inline ins/del marks (used by the history rendered diff)", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"The <del>old</del><ins>new</ins> value."} />,
    );
    expect(html).toContain("<ins>new</ins>");
    expect(html).toContain("<del>old</del>");
  });

  it("strips dangerous HTML (scripts and event handlers)", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={'Hi <script>alert(1)</script><img src=x onerror="alert(1)">'}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });
});

describe("Markdown pa:// links", () => {
  it("infers titles for empty pa links", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text="See [](pa://task/257)."
        paObjectReferences={[
          {
            uri: "pa://task/257",
            objectType: "task",
            knownType: true,
            id: "257",
            href: "/tasks/257",
            title:
              "KB 02: Implement generic pa:// object links and title resolution",
            typeLabel: "Task",
            existence: "exists",
          },
        ]}
      />,
    );
    expect(html).toContain(
      "KB 02: Implement generic pa:// object links and title resolution",
    );
    expect(html).toContain('href="/tasks/257"');
  });

  it("autolinks bare pa text", () => {
    const html = renderToStaticMarkup(
      <Markdown text="Open pa://project/time-tracking-automation." />,
    );
    expect(html).toContain('href="/projects/time-tracking-automation"');
    expect(html).toContain("Project time-tracking-automation");
  });

  it("uses id-only references for links with fragments while preserving the target fragment", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text="See [](pa://knowledge/kb-entry#Heading)."
        paObjectReferences={[
          {
            uri: "pa://knowledge/kb-entry",
            objectType: "knowledge",
            knownType: true,
            id: "kb-entry",
            href: "/knowledge/kb-entry",
            title: "Knowledge entry",
            typeLabel: "Knowledge",
            existence: "exists",
          },
        ]}
      />,
    );
    expect(html).toContain("Knowledge entry");
    expect(html).toContain('href="/knowledge/kb-entry#Heading"');
  });

  it("marks unresolved known objects as broken when supplied by the resolver", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text="See <pa://task/missing>."
        paObjectReferences={[
          {
            uri: "pa://task/missing",
            objectType: "task",
            knownType: true,
            id: "missing",
            href: "/tasks/missing",
            title: "Task missing",
            typeLabel: "Task",
            existence: "missing",
          },
        ]}
      />,
    );
    expect(html).toContain('href="#"');
    expect(html).toContain("text-danger");
  });
});

/**
 * What is NOT math, which is the half of the syntax contract that costs
 * something when it breaks: a single `$` must stay prose. `Markdown.math.test`
 * covers the rendering of what IS math.
 *
 * These render without effects, so KaTeX never loads here and each formula stays
 * at its placeholder — enough to tell math from prose, which is all these ask.
 */
describe("Markdown math syntax", () => {
  it("leaves single-dollar amounts as prose", () => {
    const html = renderToStaticMarkup(
      <Markdown text="It costs $5, on sale for $3 today." />,
    );
    expect(html).toContain("It costs $5, on sale for $3 today.");
  });

  it("leaves math delimiters inside code as code", () => {
    const fenced = renderToStaticMarkup(
      <Markdown text={"```\n$$x^2$$\n```"} />,
    );
    expect(fenced).toContain("$$x^2$$");

    const inline = renderToStaticMarkup(
      <Markdown text="a `$$x^2$$` literal" />,
    );
    expect(inline).toContain("<code>$$x^2$$</code>");
  });
});
