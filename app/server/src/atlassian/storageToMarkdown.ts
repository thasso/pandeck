/**
 * Confluence storage format (XHTML with `<ac:*>` macro tags) → Markdown.
 *
 * This is the FALLBACK read path. Confluence normally answers
 * `body-format=atlas_doc_format` and `adfToMarkdown` handles the result, but a
 * page whose content predates the current editor can come back with an empty
 * ADF body; asking for `storage` always returns something. Turndown alone
 * flattens tables and silently drops the `<ac:structured-macro>` elements that
 * carry half of an older page, so both get explicit rules here for the same
 * reason the ADF reader names macros instead of dropping them.
 */
import TurndownService from "turndown";

/**
 * Attachment and page references are empty elements, and Turndown replaces
 * every empty element with nothing before any rule sees it. Rewriting them to
 * text up front is the only way to keep them.
 */
function markReferences(storage: string): string {
  return storage
    .replace(
      /<ri:attachment\b[^>]*\bri:filename="([^"]*)"[^>]*\/?>/gi,
      (_match, filename: string) => `<span>[attachment: ${filename}]</span>`,
    )
    .replace(
      /<ri:page\b[^>]*\bri:content-title="([^"]*)"[^>]*\/?>/gi,
      (_match, title: string) => `<span>[page: ${title}]</span>`,
    );
}

/** Convert a Confluence storage-format body to Markdown. */
export function storageToMarkdown(storage: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  turndown.addRule("confluenceTable", {
    filter: "table",
    replacement: (_content, node) => renderTable(node as Element),
  });
  // Parameters are metadata and appear in the macro's own label; without this
  // they would also leak into the macro body as loose text.
  turndown.addRule("confluenceMacroParameter", {
    filter: (node) => node.nodeName.toLowerCase() === "ac:parameter",
    replacement: () => "",
  });
  turndown.addRule("confluenceMacro", {
    filter: (node) => node.nodeName.toLowerCase() === "ac:structured-macro",
    replacement: (content, node) => renderMacro(content, node as Element),
  });
  return (
    turndown
      .turndown(markReferences(storage))
      // Turndown escapes the brackets of our own markers as ordinary text;
      // they are markers, not links, so they read as written.
      .replace(/\\\[(attachment|page|macro): ([^\n]*?)\\\]/g, "[$1: $2]")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * A GFM table. The first row becomes the header, as GFM has no header-less
 * table. Turndown parses with domino, whose NodeList is array-LIKE but not
 * iterable, so every collection here goes through `Array.from`.
 */
function renderTable(table: Element): string {
  const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
    Array.from(row.querySelectorAll("th, td")).map((cell) =>
      (cell.textContent ?? "")
        .replace(/\s+/g, " ")
        .replace(/\|/g, "\\|")
        .trim(),
    ),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  if (width === 0) return "";
  const pad = (row: string[]) =>
    Array.from({ length: width }, (_, i) => row[i] ?? "");
  const [header = [], ...body] = rows;
  return `\n\n${[
    `| ${pad(header).join(" | ")} |`,
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map((row) => `| ${pad(row).join(" | ")} |`),
  ].join("\n")}\n\n`;
}

/** Name the macro and keep whatever body it wrapped. */
function renderMacro(content: string, node: Element): string {
  const name = node.getAttribute("ac:name") ?? "macro";
  const parameters = Array.from(node.childNodes)
    .filter(
      (child): child is Element =>
        child.nodeName.toLowerCase() === "ac:parameter",
    )
    .map((child) => {
      const key = child.getAttribute("ac:name");
      const value = (child.textContent ?? "").trim();
      return key && value ? `${key}=${value}` : "";
    })
    .filter(Boolean)
    .join(" ");
  const label = `[macro: ${name}${parameters ? ` ${parameters}` : ""}]`;
  const body = content.trim();
  return body ? `\n\n${label}\n\n${body}\n\n` : `\n\n${label}\n\n`;
}
