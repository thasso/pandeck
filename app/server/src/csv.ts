/** RFC 4180 CSV writing shared by the export/report tools. */

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("; ") : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

/** Objects → CSV with the union of keys (first-seen order) as the header. */
export function tableToCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [csvLine(columns)];
  for (const row of rows) lines.push(csvLine(columns.map((c) => row[c])));
  return `${lines.join("\n")}\n`;
}
