import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

// jsdom does not lay out tables. These source guards need manual browser
// verification of wrapping and column sizing at transcript and phone widths.
describe("Markdown table layout styles", () => {
  it("wraps cell text without shrinking short-word columns to single characters", () => {
    const cells = css.match(/\.prose th,\s*\.prose td\s*\{([^}]+)\}/)?.[1];
    expect(cells).toBeDefined();
    expect(cells).toMatch(/white-space:\s*normal\s*;/);
    expect(cells).toMatch(/overflow-wrap:\s*break-word\s*;/);
    expect(cells).not.toMatch(/white-space:\s*nowrap/);
  });

  it("keeps the bounded wider layout for top-level assistant tables", () => {
    const breakout = css.match(
      /\.prose > \.markdown-table-scroll\.markdown-table-breakout\s*\{([^}]+)\}/,
    )?.[1];
    expect(breakout).toBeDefined();
    expect(breakout).toMatch(/width:\s*max-content\s*;/);
    expect(breakout).toMatch(/max-width:\s*min\(70rem,/);
  });
});
