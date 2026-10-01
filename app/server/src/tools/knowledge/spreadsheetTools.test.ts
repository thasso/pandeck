import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { DATA_DIR } from "../../config.ts";
import { sampleWorkbook } from "../../xlsxConversion.test.ts";
import { convertXlsxTool } from "./spreadsheetTools.ts";

const dir = mkdtempSync(join(tmpdir(), "xlsx-tool-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ctx = {
  toolCallId: "call-1",
  session: { sessionId: "xlsx-session", harness: "pi", agentType: "assistant" },
} as never;

describe("convert_xlsx", () => {
  test("converts a host file: CSV artifact per sheet plus a bounded preview", async () => {
    const path = join(dir, "Activation_Hours_Details_CP.xlsx");
    writeFileSync(path, sampleWorkbook());
    const result = await convertXlsxTool.execute({ path, maxRows: 2 }, ctx);
    const payload = result.details as {
      sheets: Array<{ name: string; rowCount: number; csv: { url: string } }>;
      preview: {
        sheet: string;
        rows: string[][];
        truncated: boolean;
        markdown: string;
      };
    };
    expect(payload.sheets.map((s) => s.name)).toEqual([
      "Details",
      "Policy & Notes",
    ]);
    expect(payload.sheets[0]!.rowCount).toBe(3);
    expect(payload.sheets[0]!.csv.url).toMatch(
      /^\/api\/session-artifacts\/xlsx-session\/spreadsheets\/.*\?download=1/,
    );
    expect(payload.preview.sheet).toBe("Details");
    expect(payload.preview.rows).toHaveLength(2);
    expect(payload.preview.truncated).toBe(true);
    expect(payload.preview.markdown).toContain(
      "| WEB-12 | 2025-01-01 | 7.5 | TRUE |",
    );

    const stored = join(
      DATA_DIR,
      "session-artifacts",
      "xlsx-session",
      "spreadsheets",
    );
    const csvName = decodeURIComponent(
      payload.sheets[0]!.csv.url.split("/")[5]!.split("?")[0]!,
    );
    expect(readFileSync(join(stored, csvName), "utf8")).toBe(
      "Issue,Date,Hours,Approved?\nWEB-12,2025-01-01,7.5,TRUE\nSDK-7,2025-02-01 12:00:00,3,\n",
    );
  });

  test("selects a sheet by name or index and refuses unknown ones", async () => {
    const path = join(dir, "book.xlsx");
    writeFileSync(path, sampleWorkbook());
    const byName = (
      await convertXlsxTool.execute(
        { path, sheet: "policy & notes", persistCsv: false },
        ctx,
      )
    ).details as {
      preview: { sheet: string };
      sheets: Array<{ csv?: unknown }>;
    };
    expect(byName.preview.sheet).toBe("Policy & Notes");
    expect(byName.sheets[0]!.csv).toBeUndefined();
    await expect(
      convertXlsxTool.execute({ path, sheet: "missing" }, ctx),
    ).rejects.toThrow(/No sheet "missing"/);
  });

  test("requires exactly one source and an .xlsx path", async () => {
    await expect(convertXlsxTool.execute({}, ctx)).rejects.toThrow(
      /exactly one source/,
    );
    await expect(
      convertXlsxTool.execute({ path: join(dir, "x.csv") }, ctx),
    ).rejects.toThrow(/not an \.xlsx/);
  });
});
