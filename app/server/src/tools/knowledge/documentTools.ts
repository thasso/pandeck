/**
 * Document conversion tools shared by every persona. `convert_pdf` turns a PDF
 * from a session attachment or a Knowledge Base file into Markdown, resolving
 * bytes server-side (raw binary never routes through the model context).
 * Born-digital PDFs convert offline via pdfjs/pdf2md; scanned PDFs (empty text
 * layer) can fall back to a Claude document block, capped at 30 pages. See
 * `../documentConversion.ts`.
 */
import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";
import { convertPdfToMarkdown, PDF_MIME } from "../../documentConversion.ts";
import { readSessionAttachmentBytes } from "../../sessionAttachments.ts";
import { knowledgeBaseEnabled } from "../../knowledgeBaseSettings.ts";
import { KnowledgeBaseStore } from "../../knowledgeBaseStore.ts";

const DEFAULT_MAX_CHARS = 40_000;
const MAX_MAX_CHARS = 200_000;
/** Read the whole file for conversion; a truncated PDF cannot be parsed. */
const KB_READ_MAX_BYTES = 64 * 1024 * 1024;

let storeFactory = () => new KnowledgeBaseStore();

/** Test-only seam so tool tests can run against an isolated temp KB repo. */
export function setDocumentToolsStoreFactoryForTests(
  factory: (() => KnowledgeBaseStore) | null,
): void {
  storeFactory = factory ?? (() => new KnowledgeBaseStore());
}

type ConvertPdfParams = {
  attachmentId?: string;
  kbPath?: string;
  allowClaudeFallback?: boolean;
  maxChars?: number;
};

export const convertPdfTool = defineAgentTool<ConvertPdfParams>({
  name: "convert_pdf",
  label: "Documents: PDF to Markdown",
  description:
    "Convert a PDF (a session attachment or a Knowledge Base file) to Markdown, resolving bytes server-side. Born-digital PDFs convert offline; scanned PDFs (no text layer) fall back to Claude for up to 30 pages. To keep the text, write it beside the PDF with kb_write.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      attachmentId: {
        type: "string",
        description:
          "Session attachment id from list_attachments. Use instead of kbPath.",
      },
      kbPath: {
        type: "string",
        description:
          "Knowledge Base file path such as projects/acme/brief.pdf.",
      },
      allowClaudeFallback: {
        type: "boolean",
        description:
          "Route scanned PDFs (empty text layer) to Claude, ≤30 pages. Defaults true.",
      },
      maxChars: {
        type: "number",
        description:
          "Maximum Markdown characters returned to context. Defaults to 40,000; maximum 200,000.",
      },
    },
  },
  async execute(params, ctx) {
    const hasAttachment = Boolean(params.attachmentId?.trim());
    const hasKbFile = Boolean(params.kbPath?.trim());
    if (hasAttachment === hasKbFile) {
      throw new Error(
        "Provide exactly one source: an attachmentId or a kbPath.",
      );
    }

    const maxChars = clamp(
      params.maxChars ?? DEFAULT_MAX_CHARS,
      1,
      MAX_MAX_CHARS,
    );
    const allowClaudeFallback = params.allowClaudeFallback ?? true;

    let bytes: Uint8Array;
    let source: Record<string, unknown>;
    if (hasAttachment) {
      const attachment = readSessionAttachmentBytes(
        ctx.session.sessionId,
        params.attachmentId!.trim(),
      );
      if (!attachment)
        throw new Error(
          `No session attachment found for id "${params.attachmentId}". Use list_attachments to see available attachments.`,
        );
      if (!isPdf(attachment.record.mimeType, attachment.record.name)) {
        throw new Error(
          `Attachment "${attachment.record.name}" is not a PDF (${attachment.record.mimeType}); convert_pdf only handles PDF documents.`,
        );
      }
      bytes = attachment.bytes;
      source = {
        kind: "attachment",
        attachmentId: attachment.record.id,
        name: attachment.record.name,
      };
    } else {
      if (!knowledgeBaseEnabled())
        throw new Error("The Knowledge Base is turned off in Settings.");
      const read = await storeFactory().readBytes(
        params.kbPath!.trim(),
        KB_READ_MAX_BYTES,
      );
      if (read.truncated)
        throw new Error(
          `KB file "${read.path}" is larger than ${KB_READ_MAX_BYTES} bytes and cannot be converted.`,
        );
      if (!isPdf(undefined, read.path))
        throw new Error(
          `KB file "${read.path}" is not a PDF; convert_pdf only handles PDF documents.`,
        );
      bytes = read.content;
      source = { kind: "kb_file", kbPath: read.path };
    }

    const result = await convertPdfToMarkdown({ bytes, allowClaudeFallback });
    const truncated = result.markdown.length > maxChars;
    return jsonResult({
      capability: "convert_pdf",
      source,
      engine: result.engine,
      pageCount: result.pageCount,
      usedClaudeFallback: result.usedClaudeFallback,
      lowText: result.lowText,
      markdown: truncated
        ? `${result.markdown.slice(0, maxChars - 1)}…`
        : result.markdown,
      truncated,
      ...(result.note ? { note: result.note } : {}),
    });
  },
});

export const assistantDocumentTools = [convertPdfTool];

function isPdf(
  mimeType: string | undefined,
  name: string | undefined,
): boolean {
  if (mimeType && mimeType.split(";", 1)[0]!.trim().toLowerCase() === PDF_MIME)
    return true;
  return Boolean(name && /\.pdf$/i.test(name));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Number(value) || min)));
}
