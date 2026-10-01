/**
 * XLSX → tables without a spreadsheet dependency. An .xlsx is a ZIP of
 * SpreadsheetML parts; this reads the central directory with `node:zlib`,
 * resolves shared strings, and renders every cell as text (numbers as written,
 * date-formatted numbers as ISO dates, booleans as TRUE/FALSE). Formulas
 * contribute their cached value; there is no recalculation. Good enough for
 * the report/exports Excel and Google Sheets produce; not a general Excel
 * engine (no ZIP64, no encrypted workbooks).
 */
import { inflateRawSync } from "node:zlib";

/** Uncompressed bytes one ZIP part may expand to, and all parts together. */
const MAX_PART_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
/** Excel's own sheet limits; anything beyond is malformed, not big. */
const MAX_ROWS = 1_048_576;
const MAX_COLUMNS = 16_384;
/** Cells a sheet may materialize once ragged rows are padded. */
const MAX_CELLS = 5_000_000;

export interface XlsxSheet {
  name: string;
  /** Rows as text cells, ragged rows padded to the sheet's widest row. */
  rows: string[][];
}

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function isXlsx(
  mimeType: string | null | undefined,
  name: string,
): boolean {
  return mimeType === XLSX_MIME || /\.xlsx$/i.test(name);
}

/** Every worksheet of the workbook, in workbook order. */
export function readXlsx(bytes: Uint8Array): XlsxSheet[] {
  const zip = readZip(bytes);
  const text = (path: string): string | null => {
    const entry = zip.get(path);
    return entry ? Buffer.from(entry).toString("utf8") : null;
  };
  const workbook = text("xl/workbook.xml");
  if (!workbook)
    throw new Error("Not an XLSX workbook (xl/workbook.xml is missing).");
  const rels = parseRels(text("xl/_rels/workbook.xml.rels") ?? "");
  const shared = parseSharedStrings(text("xl/sharedStrings.xml") ?? "");
  const dateStyles = parseDateStyles(text("xl/styles.xml") ?? "");
  const date1904 = /<workbookPr[^>]*date1904="(1|true)"/.test(workbook);

  const sheets: XlsxSheet[] = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = match[1]!;
    const name = decodeXml(
      attrValue(attrs, "name") ?? `Sheet${sheets.length + 1}`,
    );
    const rid = attrValue(attrs, "r:id") ?? attrValue(attrs, "id");
    const target = rid ? rels.get(rid) : undefined;
    const path = target
      ? target.startsWith("/")
        ? target.slice(1)
        : `xl/${target}`
      : `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const xml = text(path);
    sheets.push({
      name,
      rows: xml ? parseSheet(xml, shared, dateStyles, date1904) : [],
    });
  }
  return sheets;
}

/* ------------------------------- ZIP ---------------------------------- */

/**
 * The ZIP parts, read through the central directory. Every offset and length
 * is checked against the input before it is dereferenced, and inflation is
 * capped per part and in total, so a malformed or deliberately hostile
 * attachment fails with an error instead of an out-of-bounds read or a
 * multi-gigabyte allocation.
 */
function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(buf);
  if (eocd < 0)
    throw new Error("Not a ZIP archive (no end-of-central-directory).");
  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Corrupt ZIP central directory.");
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const declaredSize = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength > buf.length)
      throw new Error("Corrupt ZIP central directory.");
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (
      localOffset + 30 > buf.length ||
      buf.readUInt32LE(localOffset) !== 0x04034b50
    )
      throw new Error(`Corrupt ZIP local header for ${name}.`);
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buf.length)
      throw new Error(`Corrupt ZIP entry for ${name}: data past end of file.`);
    if (declaredSize > MAX_PART_BYTES)
      throw new Error(
        `ZIP part ${name} declares ${declaredSize} bytes; the limit is ${MAX_PART_BYTES}.`,
      );
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    let part: Uint8Array;
    if (method === 0) part = data;
    else if (method === 8) {
      try {
        part = inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES });
      } catch (error) {
        throw new Error(
          `ZIP part ${name} could not be inflated within ${MAX_PART_BYTES} bytes: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else
      throw new Error(
        `Unsupported ZIP compression method ${method} for ${name}.`,
      );
    totalBytes += part.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES)
      throw new Error(
        `Workbook expands past ${MAX_TOTAL_BYTES} bytes; refusing to read it.`,
      );
    out.set(name, part);
  }
  return out;
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let index = buf.length - 22; index >= min; index -= 1) {
    if (buf.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

/* ---------------------------- workbook parts --------------------------- */

function parseRels(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attrValue(match[1]!, "Id");
    const target = attrValue(match[1]!, "Target");
    if (id && target) out.set(id, target);
  }
  return out;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g))
    out.push(textOf(match[1]!));
  return out;
}

/** Concatenated `<t>` runs of a shared/inline string (rich text flattened). */
function textOf(xml: string): string {
  let out = "";
  for (const match of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g))
    out += decodeXml(match[1]!);
  return out;
}

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

/** Cell style indexes (`s`) whose number format renders a date/time. */
function parseDateStyles(xml: string): Set<number> {
  const customDate = new Set<number>();
  for (const match of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = Number(attrValue(match[1]!, "numFmtId"));
    const code = decodeXml(attrValue(match[1]!, "formatCode") ?? "");
    if (isDateFormatCode(code)) customDate.add(id);
  }
  const out = new Set<number>();
  const cellXfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  let index = 0;
  for (const match of cellXfs.matchAll(/<xf\b([^>]*)\/?>/g)) {
    const id = Number(attrValue(match[1]!, "numFmtId") ?? "0");
    if (BUILTIN_DATE_FORMATS.has(id) || customDate.has(id)) out.add(index);
    index += 1;
  }
  return out;
}

function isDateFormatCode(code: string): boolean {
  // Strip quoted literals, colors and escapes, then look for date/time tokens.
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  return /[dmyhs]/i.test(bare) && !/[#0?]/.test(bare);
}

/* ------------------------------- sheets -------------------------------- */

function parseSheet(
  xml: string,
  shared: string[],
  dateStyles: Set<number>,
  date1904: boolean,
): string[][] {
  const rows: string[][] = [];
  let width = 0;
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowIndex =
      Number(attrValue(rowMatch[1]!, "r") ?? rows.length + 1) - 1;
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= MAX_ROWS)
      throw new Error(`Malformed worksheet: row reference ${rowIndex + 1}.`);
    while (rows.length < rowIndex) rows.push([]);
    const cells: string[] = [];
    for (const cellMatch of rowMatch[2]!.matchAll(
      /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const attrs = cellMatch[1]!;
      const body = cellMatch[2] ?? "";
      const ref = attrValue(attrs, "r") ?? "";
      const column = columnIndex(ref.replace(/\d+$/, ""));
      const at = column >= 0 ? column : cells.length;
      if (at >= MAX_COLUMNS)
        throw new Error(`Malformed worksheet: cell reference ${ref}.`);
      const value = cellText(attrs, body, shared, dateStyles, date1904);
      while (cells.length < at) cells.push("");
      cells[at] = value;
    }
    rows[rowIndex] = cells;
    width = Math.max(width, cells.length);
    if (rows.length * width > MAX_CELLS)
      throw new Error(
        `Worksheet exceeds ${MAX_CELLS} cells (${rows.length} rows × ${width} columns); split it before converting.`,
      );
  }
  return rows.map((row) => {
    const padded = row.slice();
    while (padded.length < width) padded.push("");
    return padded;
  });
}

function cellText(
  attrs: string,
  body: string,
  shared: string[],
  dateStyles: Set<number>,
  date1904: boolean,
): string {
  const type = attrValue(attrs, "t");
  if (type === "inlineStr") return textOf(body);
  const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
  if (raw === undefined) return "";
  const value = decodeXml(raw);
  switch (type) {
    case "s":
      return shared[Number(value)] ?? "";
    case "str":
    case "e":
    case "d":
      return value;
    case "b":
      return value === "1" ? "TRUE" : "FALSE";
    default: {
      const style = Number(attrValue(attrs, "s") ?? "-1");
      if (dateStyles.has(style)) {
        const serial = Number(value);
        if (Number.isFinite(serial)) return serialToIso(serial, date1904);
      }
      return value;
    }
  }
}

/** Excel serial day → ISO date, with a time part when the serial has one. */
function serialToIso(serial: number, date1904: boolean): string {
  // 1900 system: an 1899-12-30 epoch absorbs Excel's phantom 1900-02-29 for
  // every serial from 61 on; the first 59 days need the day back.
  const epochMs = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const days = date1904 ? serial : serial < 60 ? serial + 1 : serial;
  const at = new Date(epochMs + Math.round(days * 86_400_000));
  if (Number.isNaN(at.getTime())) return String(serial);
  const iso = at.toISOString();
  const hasTime = Math.abs(serial - Math.floor(serial)) > 1e-9;
  return hasTime ? iso.slice(0, 19).replace("T", " ") : iso.slice(0, 10);
}

function columnIndex(letters: string): number {
  if (!letters || letters.length > 3) return letters ? MAX_COLUMNS : -1;
  let index = 0;
  for (const char of letters.toUpperCase())
    index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function attrValue(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match?.[1];
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}
