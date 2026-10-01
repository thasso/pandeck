import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

type MarkdownNode = {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  url?: string;
  title?: string | null;
  alt?: string | null;
  identifier?: string;
  label?: string;
  lang?: string | null;
  children?: MarkdownNode[];
};

type AdfMark = { type: string; attrs?: Record<string, unknown> };
export type AdfNode = {
  type: string;
  version?: number;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
};

type ConversionContext = {
  definitions: Map<string, { url: string; title?: string | null }>;
};

/**
 * Convert CommonMark + GitHub-flavoured Markdown to Atlassian Document Format.
 *
 * ADF is the body format of both Jira issues and Confluence pages, so this
 * converter is product-neutral: Jira sends the result as an issue field,
 * Confluence sends it stringified as an `atlas_doc_format` body. Standard/GFM
 * constructs map to native ADF where possible; unsupported raw HTML is
 * preserved as a code block and images become linked alt text so no authored
 * content silently disappears.
 */
export function markdownToAdf(markdown: string): AdfNode {
  const root = fromMarkdown(normalizeNewlines(markdown), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as MarkdownNode;
  const context: ConversionContext = { definitions: collectDefinitions(root) };
  const content = blockNodes(root.children ?? [], context);
  return {
    version: 1,
    type: "doc",
    content: content.length > 0 ? content : [{ type: "paragraph" }],
  };
}

function collectDefinitions(
  root: MarkdownNode,
): ConversionContext["definitions"] {
  const definitions = new Map<string, { url: string; title?: string | null }>();
  visit(root, (node) => {
    if (node.type === "definition" && node.identifier && node.url) {
      definitions.set(normalizeIdentifier(node.identifier), {
        url: node.url,
        ...(node.title !== undefined ? { title: node.title } : {}),
      });
    }
  });
  return definitions;
}

function visit(
  node: MarkdownNode,
  callback: (node: MarkdownNode) => void,
): void {
  callback(node);
  for (const child of node.children ?? []) visit(child, callback);
}

function blockNodes(
  nodes: MarkdownNode[],
  context: ConversionContext,
): AdfNode[] {
  return nodes.flatMap((node) => blockNode(node, context));
}

function blockNode(node: MarkdownNode, context: ConversionContext): AdfNode[] {
  switch (node.type) {
    case "paragraph":
      return [
        withInlineContent(
          "paragraph",
          inlineNodes(node.children ?? [], context),
        ),
      ];
    case "heading":
      return [
        {
          type: "heading",
          attrs: { level: clamp(node.depth ?? 1, 1, 6) },
          ...contentProperty(inlineNodes(node.children ?? [], context)),
        },
      ];
    case "blockquote": {
      // Jira rejects nested blockquote ADF even though Markdown permits it.
      // Keep every authored block but collapse nested quote containers into the
      // nearest outer quote so the document remains valid without losing text.
      const content = flattenNestedBlockquotes(
        blockNodes(node.children ?? [], context),
      );
      return [
        {
          type: "blockquote",
          content: content.length > 0 ? content : [{ type: "paragraph" }],
        },
      ];
    }
    case "list":
      return [listNode(node, context)];
    case "code":
      return [
        {
          type: "codeBlock",
          ...(node.value
            ? { content: [{ type: "text", text: node.value }] }
            : {}),
          ...(node.lang ? { attrs: { language: node.lang } } : {}),
        },
      ];
    case "thematicBreak":
      return [{ type: "rule" }];
    case "table":
      return [tableNode(node, context)];
    case "html":
      return [
        {
          type: "codeBlock",
          attrs: { language: "html" },
          ...(node.value
            ? { content: [{ type: "text", text: node.value }] }
            : {}),
        },
      ];
    case "footnoteDefinition":
      return [footnoteDefinitionNode(node, context)];
    case "definition":
      return [];
    default: {
      const children = node.children ?? [];
      if (children.length > 0) return blockNodes(children, context);
      if (node.value)
        return [
          withInlineContent("paragraph", [{ type: "text", text: node.value }]),
        ];
      return [];
    }
  }
}

function flattenNestedBlockquotes(nodes: AdfNode[]): AdfNode[] {
  return nodes.flatMap((node) =>
    node.type === "blockquote"
      ? flattenNestedBlockquotes(node.content ?? [])
      : [node],
  );
}

function listNode(node: MarkdownNode, context: ConversionContext): AdfNode {
  const type = node.ordered ? "orderedList" : "bulletList";
  const items = (node.children ?? []).map((child) =>
    listItemNode(child, context),
  );
  return {
    type,
    ...(node.ordered && node.start && node.start !== 1
      ? { attrs: { order: node.start } }
      : {}),
    content:
      items.length > 0
        ? items
        : [{ type: "listItem", content: [{ type: "paragraph" }] }],
  };
}

function listItemNode(node: MarkdownNode, context: ConversionContext): AdfNode {
  const blocks = blockNodes(node.children ?? [], context);
  const content = blocks.length > 0 ? blocks : [{ type: "paragraph" }];
  if (typeof node.checked === "boolean") {
    const marker: AdfNode = {
      type: "text",
      text: node.checked ? "☑ " : "☐ ",
    };
    const first = content[0]!;
    if (first.type === "paragraph")
      first.content = [marker, ...(first.content ?? [])];
    else content.unshift({ type: "paragraph", content: [marker] });
  }
  return { type: "listItem", content };
}

function tableNode(node: MarkdownNode, context: ConversionContext): AdfNode {
  const rows = (node.children ?? []).map(
    (row, rowIndex) =>
      ({
        type: "tableRow",
        content: (row.children ?? []).map((cell) => {
          const inline = inlineNodes(cell.children ?? [], context);
          return {
            type: rowIndex === 0 ? "tableHeader" : "tableCell",
            content: [withInlineContent("paragraph", inline)],
          } satisfies AdfNode;
        }),
      }) satisfies AdfNode,
  );
  return {
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content:
      rows.length > 0
        ? rows
        : [
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph" }] },
              ],
            },
          ],
  };
}

function footnoteDefinitionNode(
  node: MarkdownNode,
  context: ConversionContext,
): AdfNode {
  const label = node.label ?? node.identifier ?? "note";
  const body = blockNodes(node.children ?? [], context);
  return {
    type: "blockquote",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: `[${label}]`, marks: [{ type: "strong" }] },
        ],
      },
      ...body,
    ],
  };
}

function inlineNodes(
  nodes: MarkdownNode[],
  context: ConversionContext,
): AdfNode[] {
  return nodes.flatMap((node) => inlineNode(node, context));
}

function inlineNode(node: MarkdownNode, context: ConversionContext): AdfNode[] {
  switch (node.type) {
    case "text":
      return node.value ? [{ type: "text", text: node.value }] : [];
    case "emphasis":
      return addMark(inlineNodes(node.children ?? [], context), { type: "em" });
    case "strong":
      return addMark(inlineNodes(node.children ?? [], context), {
        type: "strong",
      });
    case "delete":
      return addMark(inlineNodes(node.children ?? [], context), {
        type: "strike",
      });
    case "inlineCode":
      return node.value
        ? [
            {
              type: "text",
              text: node.value.replace(/\r?\n/g, " "),
              marks: [{ type: "code" }],
            },
          ]
        : [];
    case "break":
      return [{ type: "hardBreak" }];
    case "link":
      return addMark(
        inlineNodes(node.children ?? [], context),
        linkMark(node.url ?? "", node.title),
      );
    case "linkReference": {
      const definition = context.definitions.get(
        normalizeIdentifier(node.identifier ?? ""),
      );
      const content = inlineNodes(node.children ?? [], context);
      return definition
        ? addMark(content, linkMark(definition.url, definition.title))
        : content;
    }
    case "image":
      return imageNodes(node.alt, node.url, node.title);
    case "imageReference": {
      const definition = context.definitions.get(
        normalizeIdentifier(node.identifier ?? ""),
      );
      return definition
        ? imageNodes(node.alt, definition.url, definition.title)
        : textNode(node.alt ? `[image: ${node.alt}]` : "[image]");
    }
    case "footnoteReference":
      return textNode(`[^${node.label ?? node.identifier ?? "note"}]`);
    case "html":
      return textNode(node.value ?? "");
    default: {
      const children = node.children ?? [];
      if (children.length > 0) return inlineNodes(children, context);
      return textNode(node.value ?? "");
    }
  }
}

function imageNodes(
  alt: string | null | undefined,
  url: string | undefined,
  title: string | null | undefined,
): AdfNode[] {
  const text = alt ? `[image: ${alt}]` : url ? "[image]" : "[image]";
  return url
    ? [{ type: "text", text, marks: [linkMark(url, title)] }]
    : textNode(text);
}

function addMark(nodes: AdfNode[], mark: AdfMark): AdfNode[] {
  return nodes.map((node) => {
    if (node.type !== "text") return node;
    const marks = [...(node.marks ?? [])];
    if (
      !marks.some(
        (candidate) => JSON.stringify(candidate) === JSON.stringify(mark),
      )
    )
      marks.push(mark);
    return { ...node, marks };
  });
}

function linkMark(href: string, title?: string | null): AdfMark {
  return { type: "link", attrs: { href, ...(title ? { title } : {}) } };
}

function textNode(text: string): AdfNode[] {
  return text ? [{ type: "text", text }] : [];
}

function withInlineContent(type: string, content: AdfNode[]): AdfNode {
  return { type, ...contentProperty(content) };
}

function contentProperty(content: AdfNode[]): Pick<AdfNode, "content"> {
  return content.length > 0 ? { content } : {};
}

function normalizeIdentifier(identifier: string): string {
  return identifier.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
