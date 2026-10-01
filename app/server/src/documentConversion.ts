/**
 * PDF → Markdown conversion for the on-demand `convert_pdf` agent tool.
 *
 * The primary path is fully offline and deterministic: `unpdf` (pdfjs) reads the
 * page count and text layer, and `@opendocsg/pdf2md` turns a born-digital PDF
 * into Markdown with heading/list heuristics. When the text layer is
 * effectively empty (a scanned/image-only PDF) the converter can hand the raw
 * bytes to an injected Claude fallback — but only for PDFs up to
 * {@link CLAUDE_FALLBACK_MAX_PAGES} pages, to keep token cost bounded.
 *
 * pdfjs transfers (detaches) the ArrayBuffer it is handed to its worker, so
 * every pdfjs consumer here receives its OWN fresh copy of the bytes.
 */
import * as pdf2mdModule from "@opendocsg/pdf2md";
import { extractText, getDocumentProxy } from "unpdf";

// pdf2md is a CJS default export (`module.exports = pdf2md`); its upstream
// `export default` types resolve to a namespace here, so bind the callable.
type Pdf2md = (pdf: Uint8Array) => Promise<string>;
const pdf2mdInterop = pdf2mdModule as unknown as { default?: Pdf2md };
const pdf2md: Pdf2md =
  pdf2mdInterop.default ?? (pdf2mdModule as unknown as Pdf2md);

export const PDF_MIME = "application/pdf";
/** Scanned/image PDFs above this page count are not sent to the Claude fallback. */
export const CLAUDE_FALLBACK_MAX_PAGES = 30;
/** Below this average characters-per-page the text layer is treated as empty. */
const MIN_TEXT_CHARS_PER_PAGE = 50;

type PdfConversionEngine = "pdf2md" | "claude";

export interface PdfConversionInput {
  bytes: Uint8Array;
  /** Route scanned PDFs (empty text layer) to the Claude fallback. Defaults true. */
  allowClaudeFallback?: boolean;
}

export interface PdfConversionResult {
  markdown: string;
  engine: PdfConversionEngine;
  pageCount: number;
  usedClaudeFallback: boolean;
  /** True when the born-digital text layer looked empty (likely scanned). */
  lowText: boolean;
  /** Human-readable explanation when a fallback was skipped. */
  note?: string;
}

/**
 * Injected scanned-PDF fallback (a Claude document block). Runs server-side.
 * Returns null to decline (e.g. disabled in settings or produced no text), so
 * the caller degrades to the low-text result with a note instead of erroring.
 */
export type PdfClaudeFallback = (input: {
  bytes: Uint8Array;
  pageCount: number;
}) => Promise<{ markdown: string } | null>;

let claudeFallback: PdfClaudeFallback | null = null;

/** Wire (or clear) the scanned-PDF Claude fallback used by {@link convertPdfToMarkdown}. */
export function setPdfClaudeFallback(fn: PdfClaudeFallback | null): void {
  claudeFallback = fn;
}

/** Independent byte copy: each pdfjs call detaches the buffer it receives. */
function freshCopy(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

export async function convertPdfToMarkdown(
  input: PdfConversionInput,
): Promise<PdfConversionResult> {
  const allowFallback = input.allowClaudeFallback ?? true;

  const doc = await getDocumentProxy(freshCopy(input.bytes));
  const pageCount = doc.numPages;
  const extracted = await extractText(doc, { mergePages: true });
  const rawText = (
    Array.isArray(extracted.text) ? extracted.text.join("\n\n") : extracted.text
  ).trim();
  const lowText = rawText.length < pageCount * MIN_TEXT_CHARS_PER_PAGE;

  if (lowText) {
    // Scanned / image-only PDF: pdf2md would yield almost nothing. Route to the
    // Claude fallback when it is allowed, configured, and within the page cap.
    if (!allowFallback) {
      return lowTextResult(
        pageCount,
        rawText,
        "PDF text layer looks empty (likely scanned); Claude fallback was disabled.",
      );
    }
    if (pageCount > CLAUDE_FALLBACK_MAX_PAGES) {
      return lowTextResult(
        pageCount,
        rawText,
        `PDF text layer looks empty (likely scanned) and has ${pageCount} pages, over the ${CLAUDE_FALLBACK_MAX_PAGES}-page Claude fallback cap.`,
      );
    }
    if (!claudeFallback) {
      return lowTextResult(
        pageCount,
        rawText,
        "PDF text layer looks empty (likely scanned); no Claude fallback is configured.",
      );
    }
    const fallback = await claudeFallback({
      bytes: freshCopy(input.bytes),
      pageCount,
    });
    if (!fallback || !fallback.markdown.trim()) {
      return lowTextResult(
        pageCount,
        rawText,
        "PDF text layer looks empty (likely scanned) and the Claude fallback is disabled or returned no text.",
      );
    }
    return {
      markdown: fallback.markdown.trim(),
      engine: "claude",
      pageCount,
      usedClaudeFallback: true,
      lowText: true,
    };
  }

  const markdown = (await pdf2md(freshCopy(input.bytes))).trim();
  return {
    markdown,
    engine: "pdf2md",
    pageCount,
    usedClaudeFallback: false,
    lowText: false,
  };
}

function lowTextResult(
  pageCount: number,
  rawText: string,
  note: string,
): PdfConversionResult {
  return {
    markdown: rawText,
    engine: "pdf2md",
    pageCount,
    usedClaudeFallback: false,
    lowText: true,
    note,
  };
}
