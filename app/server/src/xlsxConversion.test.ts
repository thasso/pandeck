import { deflateRawSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { isXlsx, readXlsx } from "./xlsxConversion.ts";

/** A minimal but real ZIP (deflate, central directory, EOCD) of the given parts. */
export function buildZip(parts: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(parts)) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(content, "utf8");
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralStart = offset;
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(parts).length, 8);
  eocd.writeUInt16LE(Object.keys(parts).length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

export function sampleWorkbook(): Uint8Array {
  return buildZip({
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="Details" sheetId="1" r:id="rId1"/><sheet name="Policy &amp; Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst><si><t>Issue</t></si><si><t>Date</t></si><si><t>Hours</t></si><si><r><t>WEB-</t></r><r><t>12</t></r></si><si><t>Approved?</t></si></sst>`,
    "xl/styles.xml": `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="0.00"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>4</v></c></row>
      <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"><v>45658</v></c><c r="C2" s="2"><v>7.5</v></c><c r="D2" t="b"><v>1</v></c></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t>SDK-7</t></is></c><c r="B3" s="3"><v>45689.5</v></c><c r="C3"><f>SUM(1,2)</f><v>3</v></c></row>
    </sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="B1" t="str"><v>a &lt; b</v></c></row></sheetData></worksheet>`,
  });
}

describe("readXlsx", () => {
  test("reads sheets in workbook order with shared strings, dates, booleans and cached formulas", () => {
    const sheets = readXlsx(sampleWorkbook());
    expect(sheets.map((s) => s.name)).toEqual(["Details", "Policy & Notes"]);
    expect(sheets[0]!.rows).toEqual([
      ["Issue", "Date", "Hours", "Approved?"],
      ["WEB-12", "2025-01-01", "7.5", "TRUE"],
      ["SDK-7", "2025-02-01 12:00:00", "3", ""],
    ]);
    // A cell in column B with nothing in A still lands in column B.
    expect(sheets[1]!.rows).toEqual([["", "a < b"]]);
  });

  test("rejects non-workbook bytes", () => {
    expect(() => readXlsx(new Uint8Array([1, 2, 3]))).toThrow(/ZIP/);
    expect(() => readXlsx(buildZip({ "hello.txt": "x" }))).toThrow(/workbook/);
  });

  test("refuses malformed structure and oversized sheets instead of allocating", () => {
    const workbook = (sheet: string) =>
      buildZip({
        "xl/workbook.xml": `<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
        "xl/worksheets/sheet1.xml": sheet,
      });
    expect(() =>
      readXlsx(
        workbook(
          `<worksheet><sheetData><row r="1000000000"><c r="A1000000000"><v>1</v></c></row></sheetData></worksheet>`,
        ),
      ),
    ).toThrow(/row reference/);
    expect(() =>
      readXlsx(
        workbook(
          `<worksheet><sheetData><row r="1"><c r="ZZZZ1"><v>1</v></c></row></sheetData></worksheet>`,
        ),
      ),
    ).toThrow(/cell reference/);
    expect(() =>
      readXlsx(
        workbook(
          `<worksheet><sheetData><row r="1"><c r="XFD1"><v>1</v></c></row><row r="400"><c r="A400"><v>1</v></c></row></sheetData></worksheet>`,
        ),
      ),
    ).toThrow(/exceeds 5000000 cells/);

    // A central directory pointing past the end of the file.
    const zip = Buffer.from(buildZip({ "xl/workbook.xml": "<workbook/>" }));
    zip.writeUInt32LE(zip.length + 100, zip.length - 22 + 16);
    expect(() => readXlsx(zip)).toThrow(/Corrupt ZIP/);
  });

  test("caps inflated bytes so a zip bomb fails fast", () => {
    // 70 MiB of zeros deflates to ~70 KiB; the declared size trips the limit
    // before inflation is even attempted.
    const zip = Buffer.from(
      buildZip({ "xl/workbook.xml": "0".repeat(70 * 1024 * 1024) }),
    );
    expect(() => readXlsx(zip)).toThrow(/limit is 67108864/);
    // Lie about the declared size: the inflate cap still catches it.
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(1, central + 24);
    expect(() => readXlsx(zip)).toThrow(/could not be inflated within/);
  });

  test("isXlsx accepts the MIME type or the extension", () => {
    expect(
      isXlsx(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "x.bin",
      ),
    ).toBe(true);
    expect(isXlsx("application/octet-stream", "Activation.XLSX")).toBe(true);
    expect(isXlsx("text/csv", "x.csv")).toBe(false);
  });
});
