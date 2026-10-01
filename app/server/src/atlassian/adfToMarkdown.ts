/**
 * Atlassian Document Format → Markdown / plain text.
 *
 * Jira issue descriptions use a narrow slice of ADF; Confluence pages use far
 * more of it (tables, panels, expands, layouts, task lists, and macros as
 * `extension` nodes). Both read through this module, so every node type either
 * renders or leaves a visible placeholder. Nothing that was authored may come
 * out as an empty string: a dropped macro or table reads as a page that says
 * less than it does, which is worse than an ugly rendering.
 */

type AdfValue = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: unknown;
  content?: unknown;
};

type RenderContext = { listDepth: number };

/** Flatten an ADF document to plain text, losing all structure. */
export function adfToText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  const parts: string[] = [];
  collectText(value, parts);
  const text = parts
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

/** Render an ADF document as Markdown, falling back to plain text when empty. */
export function adfToMarkdown(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  const markdown = renderNode(value, { listDepth: 0 })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return markdown || adfToText(value);
}

function renderNode(node: unknown, context: RenderContext): string {
  if (!node || typeof node !== "object") return "";
  const item = node as AdfValue;
  const children = () => renderChildren(item.content, context);

  if (typeof item.text === "string")
    return applyMarks(escapeMarkdownText(item.text), item.marks);
  if (item.type === "hardBreak") return "\n";
  if (item.type === "paragraph") return `${children()}\n\n`;
  if (item.type === "heading")
    return `${"#".repeat(clampLevel(item.attrs?.["level"]))} ${children().trim()}\n\n`;
  if (item.type === "blockquote") return quote(children());
  if (item.type === "codeBlock") {
    const language =
      typeof item.attrs?.["language"] === "string"
        ? item.attrs["language"]
        : "";
    return `\n\`\`\`${language}\n${plainText(item)}\n\`\`\`\n\n`;
  }
  if (item.type === "rule") return "\n---\n\n";
  if (item.type === "bulletList")
    return renderList(item.content, context, "bullet");
  if (item.type === "orderedList")
    return renderList(
      item.content,
      context,
      "ordered",
      Number(item.attrs?.["order"]) || 1,
    );
  if (item.type === "listItem") return children();
  if (item.type === "table") return renderTable(item, context);
  if (item.type === "panel") return renderPanel(item, context);
  if (item.type === "expand" || item.type === "nestedExpand")
    return renderExpand(item, context);
  if (item.type === "taskList" || item.type === "decisionList")
    return renderCheckList(item.content, context);
  if (item.type === "status") return renderStatus(item);
  if (item.type === "date") return renderDate(item);
  if (
    item.type === "extension" ||
    item.type === "bodiedExtension" ||
    item.type === "inlineExtension" ||
    item.type === "multiBodiedExtension"
  )
    return renderExtension(item, context);
  if (
    item.type === "media" ||
    item.type === "mediaInline" ||
    item.type === "mediaSingle" ||
    item.type === "mediaGroup"
  )
    return renderMedia(item, context);
  if (
    (item.type === "inlineCard" ||
      item.type === "blockCard" ||
      item.type === "embedCard") &&
    typeof item.attrs?.["url"] === "string"
  )
    return item.attrs["url"];
  if (item.type === "mention")
    return stringAttr(item, "text") || stringAttr(item, "displayName");
  if (item.type === "emoji")
    return stringAttr(item, "text") || stringAttr(item, "shortName");
  if (item.type === "placeholder") return "";
  if (item.type === "layoutSection" || item.type === "layoutColumn")
    return blocks(item.content);
  if (Array.isArray(item.content)) return children();
  return "";
}

function renderChildren(content: unknown, context: RenderContext): string {
  if (!Array.isArray(content)) return "";
  return content.map((child) => renderNode(child, context)).join("");
}

/** Children rendered as block siblings: a layout column restarts list depth. */
function blocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((child) => renderNode(child, { listDepth: 0 }).trim())
    .filter(Boolean)
    .join("\n\n")
    .concat("\n\n");
}

function renderList(
  content: unknown,
  context: RenderContext,
  kind: "bullet" | "ordered",
  start = 1,
): string {
  if (!Array.isArray(content)) return "";
  const indent = "  ".repeat(context.listDepth);
  const lines: string[] = [];
  content.forEach((child, index) => {
    const body = renderNode(child, {
      listDepth: context.listDepth + 1,
    }).trimEnd();
    const marker = kind === "ordered" ? `${start + index}.` : "-";
    const [first = "", ...rest] = body.split("\n");
    lines.push(`${indent}${marker} ${first}`);
    for (const line of rest) lines.push(`${indent}  ${line}`);
  });
  return `${lines.join("\n")}\n\n`;
}

/**
 * A GFM table. ADF marks header cells per cell rather than per row, so the
 * first row becomes the header whether or not it is one: GFM has no
 * header-less table, and a table rendered without its first row would lose it.
 * Cell content is flattened to one line, since a Markdown cell cannot hold
 * block structure. `colspan`/`rowspan` are not representable and are dropped.
 */
function renderTable(item: AdfValue, context: RenderContext): string {
  const rows = (Array.isArray(item.content) ? item.content : [])
    .filter((row) => (row as AdfValue)?.type === "tableRow")
    .map((row) =>
      (Array.isArray((row as AdfValue).content)
        ? ((row as AdfValue).content as unknown[])
        : []
      ).map((cell) => flattenCell(cell, context)),
    );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  if (width === 0) return "";
  const pad = (row: string[]) =>
    Array.from({ length: width }, (_, i) => row[i] ?? "");
  const [header = [], ...body] = rows;
  const lines = [
    `| ${pad(header).join(" | ")} |`,
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map((row) => `| ${pad(row).join(" | ")} |`),
  ];
  return `\n${lines.join("\n")}\n\n`;
}

function flattenCell(cell: unknown, context: RenderContext): string {
  // Text marks already escape a literal pipe; only an unescaped one (from a
  // link href, say) would break the row, so leave the escaped ones alone.
  return renderNode(cell, context)
    .replace(/(?<!\\)\|/g, "\\|")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

/** A Confluence info/note/warning panel, labelled so its severity survives. */
function renderPanel(item: AdfValue, context: RenderContext): string {
  const type = stringAttr(item, "panelType") || "info";
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  return quote(`**${label}**\n\n${renderChildren(item.content, context)}`);
}

function renderExpand(item: AdfValue, context: RenderContext): string {
  const title = stringAttr(item, "title") || "Details";
  return quote(
    `**Expand: ${title}**\n\n${renderChildren(item.content, context)}`,
  );
}

/** Confluence task lists and decision lists, as Markdown task items. */
function renderCheckList(content: unknown, context: RenderContext): string {
  if (!Array.isArray(content)) return "";
  const lines = content.map((child) => {
    const item = child as AdfValue;
    const state = stringAttr(item, "state").toUpperCase();
    const marker =
      item.type === "decisionItem" ? "-" : state === "DONE" ? "- [x]" : "- [ ]";
    return `${marker} ${renderChildren(item.content, context).trim()}`;
  });
  return `${lines.join("\n")}\n\n`;
}

function renderStatus(item: AdfValue): string {
  const text = stringAttr(item, "text");
  return text ? `\`${text}\`` : "";
}

function renderDate(item: AdfValue): string {
  const timestamp = Number(item.attrs?.["timestamp"]);
  if (!Number.isFinite(timestamp)) return "";
  // A finite number can still be out of Date's range, and `toISOString` throws
  // RangeError there — which would fail the whole issue or page being read
  // over one malformed date node.
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

/**
 * A Confluence macro. Markdown cannot express one, so it is named instead of
 * dropped: an agent reading the page learns a macro is there, and an edit that
 * round-trips through Markdown shows the user what it would replace.
 */
function renderExtension(item: AdfValue, context: RenderContext): string {
  const key =
    stringAttr(item, "extensionKey") ||
    stringAttr(item, "extensionType") ||
    "macro";
  const parameters = macroParameters(item);
  const label = `[macro: ${key}${parameters ? ` ${parameters}` : ""}]`;
  const body = renderChildren(item.content, context).trim();
  if (item.type === "inlineExtension") return label;
  return body ? `${label}\n\n${body}\n\n` : `${label}\n\n`;
}

/** The macro parameters Confluence stores under `attrs.parameters.macroParams`. */
function macroParameters(item: AdfValue): string {
  const parameters = item.attrs?.["parameters"];
  if (!parameters || typeof parameters !== "object") return "";
  const macroParams = (parameters as Record<string, unknown>)["macroParams"];
  if (!macroParams || typeof macroParams !== "object") return "";
  const pairs = Object.entries(macroParams as Record<string, unknown>)
    .map(([name, value]) => {
      const raw = (value as { value?: unknown })?.value;
      return raw === undefined || raw === null || raw === ""
        ? ""
        : `${name}=${String(raw)}`;
    })
    .filter(Boolean);
  return pairs.join(" ");
}

/**
 * Attachments and embedded images. ADF names the media by id, not by URL, so
 * there is nothing to link to without a second Confluence call; the alt text
 * or file id is kept so the reader knows an image sits here.
 */
function renderMedia(item: AdfValue, context: RenderContext): string {
  if (item.type === "mediaSingle" || item.type === "mediaGroup") {
    const inner = renderChildren(item.content, context).trim();
    return inner ? `${inner}\n\n` : "";
  }
  const alt = stringAttr(item, "alt") || stringAttr(item, "id") || "attachment";
  const url = stringAttr(item, "url");
  return url ? `[${alt}](${url})` : `[attachment: ${alt}]`;
}

function quote(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return `${trimmed
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")}\n\n`;
}

function applyMarks(text: string, marks: unknown): string {
  if (!Array.isArray(marks) || !text) return text;
  let out = text;
  for (const mark of marks) {
    const item = mark as { type?: string; attrs?: Record<string, unknown> };
    if (item.type === "code") out = `\`${out.replace(/`/g, "\\`")}\``;
    else if (item.type === "strong") out = `**${out}**`;
    else if (item.type === "em") out = `_${out}_`;
    else if (item.type === "strike") out = `~~${out}~~`;
    else if (item.type === "link" && typeof item.attrs?.["href"] === "string")
      out = `[${out}](${item.attrs["href"]})`;
  }
  return out;
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\*_{}[\]()#+.!|-])/g, "\\$1");
}

function clampLevel(value: unknown): number {
  return Math.min(6, Math.max(1, Number(value) || 1));
}

function stringAttr(item: AdfValue, name: string): string {
  const value = item.attrs?.[name];
  return typeof value === "string" ? value : "";
}

function plainText(node: unknown): string {
  const parts: string[] = [];
  collectText(node, parts);
  return parts.join("").trimEnd();
}

function collectText(node: unknown, parts: string[]): void {
  if (!node || typeof node !== "object") return;
  const item = node as AdfValue;
  if (typeof item.text === "string") parts.push(item.text);
  if (item.type === "hardBreak") parts.push("\n");
  if (
    item.type === "paragraph" &&
    parts.length > 0 &&
    parts[parts.length - 1] !== "\n"
  )
    parts.push("\n");
  if (Array.isArray(item.content)) {
    for (const child of item.content) collectText(child, parts);
  }
  if (
    ["paragraph", "heading", "blockquote", "listItem"].includes(
      item.type ?? "",
    ) &&
    parts.length > 0 &&
    parts[parts.length - 1] !== "\n"
  )
    parts.push("\n");
}
