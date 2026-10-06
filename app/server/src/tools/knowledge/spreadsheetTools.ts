/**
 * `convert_xlsx`: read an Excel workbook (session attachment, host file or KB
 * file) into tables. Every sheet is persisted as a CSV session artifact the
 * user can download and later turns can read; the reply carries only a bounded
 * preview so a large history workbook never lands in chat whole.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";
import { stageSessionArtifact } from "../../mcp/toolGroups/packRuntime.ts";
import { readSessionAttachmentBytes } from "../../sessionAttachments.ts";
import { knowledgeBaseEnabled } from "../../knowledgeBaseSettings.ts";
import { KnowledgeBaseStore } from "../../knowledgeBaseStore.ts";
import { isXlsx, readXlsx, type XlsxSheet } from "../../xlsxConversion.ts";
import { csvLine } from "../../csv.ts";

const DEFAULT_PREVIEW_ROWS = 40;
const MAX_PREVIEW_ROWS = 500;
const MAX_PREVIEW_CELL_CHARS = 120;
/** A workbook is read whole; this bounds the bytes decompressed into memory. */
const MAX_WORKBOOK_BYTES = 64 * 1024 * 1024;

type ConvertXlsxParams = {
  attachmentId?: string;
  path?: string;
  kbPath?: string;
  sheet?: string;
  maxRows?: number;
  persistCsv?: boolean;
};

export const convertXlsxTool = defineAgentTool<ConvertXlsxParams>({
  name: "convert_xlsx",
  label: "Documents: XLSX to tables",
  description:
    "Read an Excel .xlsx workbook — a session attachment, a file on this host, or a Knowledge Base file — into tables. Each sheet is written as a CSV session artifact (download link returned) and the reply previews one sheet's first rows, so read the CSV with file tools for anything beyond the preview rather than asking for more rows. Cell values are text: numbers as stored, date-formatted cells as ISO dates, formulas as their cached result.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      attachmentId: {
        type: "string",
        description: "Session attachment id from list_attachments.",
      },
      path: {
        type: "string",
        description: "Absolute path of an .xlsx file on this host.",
      },
      kbPath: {
        type: "string",
        description:
          "Knowledge Base file path such as projects/acme/history.xlsx.",
      },
      sheet: {
        type: "string",
        description:
          "Sheet to preview: its name or 1-based index. Defaults to the first sheet; every sheet is still exported to CSV.",
      },
      maxRows: {
        type: "number",
        description: `Preview rows returned (default ${DEFAULT_PREVIEW_ROWS}, max ${MAX_PREVIEW_ROWS}).`,
      },
      persistCsv: {
        type: "boolean",
        description:
          "Write one CSV artifact per sheet (default true). false returns only the preview.",
      },
    },
  },
  async execute(params, ctx) {
    const sources = [
      params.attachmentId?.trim(),
      params.path?.trim(),
      params.kbPath?.trim(),
    ].filter(Boolean);
    if (sources.length !== 1)
      throw new Error(
        "Provide exactly one source: attachmentId, path, or kbPath.",
      );

    let bytes: Uint8Array;
    let name: string;
    let source: Record<string, unknown>;
    if (params.attachmentId?.trim()) {
      const attachment = readSessionAttachmentBytes(
        ctx.session.sessionId,
        params.attachmentId.trim(),
      );
      if (!attachment)
        throw new Error(
          `No session attachment found for id "${params.attachmentId}". Use list_attachments to see available attachments.`,
        );
      if (!isXlsx(attachment.record.mimeType, attachment.record.name))
        throw new Error(
          `Attachment "${attachment.record.name}" is not an .xlsx workbook (${attachment.record.mimeType}).`,
        );
      bytes = attachment.bytes;
      name = attachment.record.name;
      source = {
        kind: "attachment",
        attachmentId: attachment.record.id,
        name,
      };
    } else if (params.path?.trim()) {
      const path = params.path.trim();
      if (!isAbsolute(path))
        throw new Error("path must be an absolute path on this host.");
      const resolved = resolve(path);
      if (!isXlsx(null, resolved))
        throw new Error(`"${resolved}" is not an .xlsx file.`);
      const size = statSync(resolved).size;
      if (size > MAX_WORKBOOK_BYTES)
        throw new Error(
          `"${resolved}" is ${size} bytes; workbooks above ${MAX_WORKBOOK_BYTES} bytes are not read.`,
        );
      bytes = readFileSync(resolved);
      name = basename(resolved);
      source = { kind: "file", path: resolved };
    } else {
      if (!knowledgeBaseEnabled())
        throw new Error("The Knowledge Base is turned off in Settings.");
      const read = await new KnowledgeBaseStore().readBytes(
        params.kbPath!.trim(),
        MAX_WORKBOOK_BYTES,
      );
      if (read.truncated)
        throw new Error(
          `KB file "${read.path}" is larger than ${MAX_WORKBOOK_BYTES} bytes and cannot be read.`,
        );
      if (!isXlsx(null, read.path))
        throw new Error(`KB file "${read.path}" is not an .xlsx file.`);
      bytes = read.content;
      name = basename(read.path);
      source = { kind: "kb_file", kbPath: read.path };
    }

    const sheets = readXlsx(bytes);
    if (sheets.length === 0) throw new Error(`"${name}" has no worksheets.`);
    const selected = selectSheet(sheets, params.sheet);
    const maxRows = clamp(
      Math.floor(params.maxRows ?? DEFAULT_PREVIEW_ROWS),
      1,
      MAX_PREVIEW_ROWS,
    );
    const persistCsv = params.persistCsv !== false;
    const stem = name.replace(/\.xlsx$/i, "");

    const sheetSummaries = sheets.map((sheet, index) => {
      const summary: Record<string, unknown> = {
        index: index + 1,
        name: sheet.name,
        rowCount: sheet.rows.length,
        columnCount: sheet.rows[0]?.length ?? 0,
      };
      if (persistCsv) {
        const artifact = stageSessionArtifact(ctx.session.sessionId, {
          name: `${stem} - ${safeName(sheet.name)}.csv`,
          mimeType: "text/csv; charset=utf-8",
          bytes: Buffer.from(sheetToCsv(sheet), "utf8"),
          kind: "file",
          label: `XLSX sheet "${sheet.name}" of ${name}`,
          sourceTool: "convert_xlsx",
          directory: "spreadsheets",
          download: true,
        });
        summary.csv = { url: artifact.url, artifactId: artifact.id };
      }
      return summary;
    });

    const previewRows = selected.rows.slice(0, maxRows);
    return jsonResult({
      capability: "convert_xlsx",
      source,
      workbook: name,
      sheets: sheetSummaries,
      preview: {
        sheet: selected.name,
        rowCount: selected.rows.length,
        rows: previewRows.map((row) => row.map(clipCell)),
        truncated: selected.rows.length > maxRows,
        markdown: markdownTable(previewRows),
      },
      ...(persistCsv
        ? {
            presentationGuidance:
              "Link the CSV artifact(s) for the user; read the CSV with file tools to work with rows beyond the preview.",
          }
        : {}),
    });
  },
});

export const assistantSpreadsheetTools = [convertXlsxTool];

function selectSheet(sheets: XlsxSheet[], selector: string | undefined) {
  const wanted = selector?.trim();
  if (!wanted) return sheets[0]!;
  if (/^\d+$/.test(wanted)) {
    const sheet = sheets[Number(wanted) - 1];
    if (sheet) return sheet;
  }
  const byName = sheets.find(
    (sheet) => sheet.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (byName) return byName;
  throw new Error(
    `No sheet "${wanted}". Sheets: ${sheets.map((sheet, index) => `${index + 1}=${sheet.name}`).join(", ")}.`,
  );
}

function sheetToCsv(sheet: XlsxSheet): string {
  return `${sheet.rows.map(csvLine).join("\n")}\n`;
}

function markdownTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const cell = (value: string | undefined) =>
    clipCell(value ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, " ");
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cell(row[i])).join(" | ")} |`;
  const [header, ...body] = rows;
  return [
    line(header!),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}

function clipCell(value: string): string {
  return value.length > MAX_PREVIEW_CELL_CHARS
    ? `${value.slice(0, MAX_PREVIEW_CELL_CHARS - 1)}…`
    : value;
}

function safeName(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, "_").trim() || "sheet";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
