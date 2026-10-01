/**
 * Minimal but structurally valid PDF fixtures for document-conversion tests.
 *
 * A correct xref table and stream `/Length` are emitted so pdfjs parses the
 * document directly (no lossy "indexing all objects" recovery). Text is drawn
 * with a Type1 base font on page one only; other pages are intentionally
 * text-free to exercise the scanned/low-text path.
 */
import { Buffer } from "node:buffer";

export function buildTestPdf(opts: {
  pages: number;
  firstPageText?: string;
}): Uint8Array {
  const bodies = new Map<number, string>();
  const pageStart = 3;
  const pageIds = Array.from({ length: opts.pages }, (_, i) => pageStart + i);
  let nextId = pageStart + opts.pages;

  bodies.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  bodies.set(
    2,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${opts.pages} >>`,
  );

  for (const [idx, id] of pageIds.entries()) {
    if (idx === 0 && opts.firstPageText) {
      const contentId = nextId++;
      const fontId = nextId++;
      const lines = wrapWords(opts.firstPageText, 32);
      const shows = lines
        .map(
          (line, line_i) =>
            `${line_i === 0 ? "72 720 Td" : "0 -18 Td"} (${escapePdfText(line)}) Tj`,
        )
        .join(" ");
      const stream = `BT /F1 14 Tf ${shows} ET`;
      bodies.set(
        contentId,
        `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
      );
      bodies.set(
        fontId,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      );
      bodies.set(
        id,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
      );
    } else {
      bodies.set(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`);
    }
  }

  const maxId = nextId - 1;
  const offsets = new Map<number, number>();
  let pdf = "%PDF-1.4\n";
  for (let id = 1; id <= maxId; id++) {
    offsets.set(id, Buffer.byteLength(pdf, "latin1"));
    pdf += `${id} 0 obj\n${bodies.get(id)}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) {
    xref += `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `${xref}trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

/** Escape the characters that are structural inside a PDF literal string. */
function escapePdfText(text: string): string {
  return text.replace(/([\\()])/g, "\\$1");
}

function wrapWords(text: string, maxLen: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + 1 + word.length > maxLen) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
