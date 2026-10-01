import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { buildTestPdf } from "./test/pdfFixtures.ts";
import {
  CLAUDE_FALLBACK_MAX_PAGES,
  convertPdfToMarkdown,
  setPdfClaudeFallback,
} from "./documentConversion.ts";

afterEach(() => {
  setPdfClaudeFallback(null);
});

describe("convertPdfToMarkdown", () => {
  test("born-digital PDF converts offline via pdf2md", async () => {
    const text =
      "Quarterly Report Summary for the 2026 fiscal year covering revenue and outlook";
    const result = await convertPdfToMarkdown({
      bytes: buildTestPdf({ pages: 1, firstPageText: text }),
    });
    assert.equal(result.engine, "pdf2md");
    assert.equal(result.usedClaudeFallback, false);
    assert.equal(result.lowText, false);
    assert.equal(result.pageCount, 1);
    assert.match(result.markdown, /Quarterly Report Summary/);
  });

  test("scanned PDF with fallback disabled returns low-text with a note", async () => {
    const result = await convertPdfToMarkdown({
      bytes: buildTestPdf({ pages: 2 }),
      allowClaudeFallback: false,
    });
    assert.equal(result.lowText, true);
    assert.equal(result.engine, "pdf2md");
    assert.equal(result.usedClaudeFallback, false);
    assert.match(result.note ?? "", /disabled/i);
  });

  test("scanned PDF routes to the injected Claude fallback", async () => {
    let seenPages = 0;
    setPdfClaudeFallback(async ({ pageCount }) => {
      seenPages = pageCount;
      return { markdown: `# OCR transcription (${pageCount} pages)` };
    });
    const result = await convertPdfToMarkdown({
      bytes: buildTestPdf({ pages: 3 }),
    });
    assert.equal(result.engine, "claude");
    assert.equal(result.usedClaudeFallback, true);
    assert.equal(result.lowText, true);
    assert.equal(seenPages, 3);
    assert.match(result.markdown, /OCR transcription \(3 pages\)/);
  });

  test("scanned PDF over the page cap skips the fallback", async () => {
    let called = false;
    setPdfClaudeFallback(async () => {
      called = true;
      return { markdown: "should not run" };
    });
    const pages = CLAUDE_FALLBACK_MAX_PAGES + 1;
    const result = await convertPdfToMarkdown({
      bytes: buildTestPdf({ pages }),
    });
    assert.equal(called, false, "fallback must not run past the page cap");
    assert.equal(result.usedClaudeFallback, false);
    assert.equal(result.pageCount, pages);
    assert.match(
      result.note ?? "",
      new RegExp(`${CLAUDE_FALLBACK_MAX_PAGES}-page`),
    );
  });
});
