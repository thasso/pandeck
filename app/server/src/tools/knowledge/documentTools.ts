/**
 * Document conversion tools shared by every persona. `convert_pdf` turns a PDF
 * from a session attachment or a KB asset into Markdown, resolving bytes
 * server-side (raw binary never routes through the model context). Born-digital
 * PDFs convert offline via pdfjs/pdf2md; scanned PDFs (empty text layer) can
 * fall back to a Claude document block, capped at 30 pages. See
 * `../documentConversion.ts`.
 */
import {
  defineAgentTool,
  jsonResult,
  type ToolCallContext,
} from "../../mcp/tool.ts";
import { convertPdfToMarkdown, PDF_MIME } from "../../documentConversion.ts";
import { readSessionAttachmentBytes } from "../../sessionAttachments.ts";
import {
  readKnowledgeAsset,
  writeKnowledgeAssetExtract,
} from "../../knowledgeBaseAssets.ts";
import {
  KnowledgeBaseStore,
  type KbCommitMeta,
} from "../../knowledgeBaseStore.ts";

const DEFAULT_MAX_CHARS = 40_000;
const MAX_MAX_CHARS = 200_000;
/** Read the whole asset for conversion; a truncated PDF cannot be parsed. */
const ASSET_READ_MAX_BYTES = 64 * 1024 * 1024;

let storeFactory = () => new KnowledgeBaseStore();

/** Test-only seam so tool tests can run against an isolated temp KB repo. */
export function setDocumentToolsStoreFactoryForTests(
  factory: (() => KnowledgeBaseStore) | null,
): void {
  storeFactory = factory ?? (() => new KnowledgeBaseStore());
}

type ConvertPdfParams = {
  attachmentId?: string;
  entryId?: string;
  entryPath?: string;
  assetPath?: string;
  allowClaudeFallback?: boolean;
  persistToExtract?: boolean;
  maxChars?: number;
  reason?: string;
  taskId?: string;
};

export const convertPdfTool = defineAgentTool<ConvertPdfParams>({
  name: "convert_pdf",
  label: "Documents: PDF to Markdown",
  description:
    "Convert a PDF (a session attachment or a KB asset) to Markdown, resolving bytes server-side. Born-digital PDFs convert offline; scanned PDFs (no text layer) fall back to Claude for up to 30 pages. Optionally persist the result into a KB asset's text extract.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      attachmentId: {
        type: "string",
        description:
          "Session attachment id from list_attachments. Use instead of a KB asset.",
      },
      entryId: {
        type: "string",
        description: "KB entry stable kb.id (with assetPath).",
      },
      entryPath: {
        type: "string",
        description: "KB entry folder or index.md path (with assetPath).",
      },
      assetPath: {
        type: "string",
        description: "Entry-local KB asset path such as assets/source.pdf.",
      },
      allowClaudeFallback: {
        type: "boolean",
        description:
          "Route scanned PDFs (empty text layer) to Claude, ≤30 pages. Defaults true.",
      },
      persistToExtract: {
        type: "boolean",
        description:
          "Write the Markdown into the KB asset's generated text extract. KB asset source only. Defaults false.",
      },
      maxChars: {
        type: "number",
        description:
          "Maximum Markdown characters returned to context. Defaults to 40,000; maximum 200,000.",
      },
      reason: {
        type: "string",
        description: "Commit reason, required when persistToExtract is true.",
      },
      taskId: {
        type: "string",
        description: "Optional related Task id for the persist commit.",
      },
    },
  },
  async execute(params, ctx) {
    const hasAttachment = Boolean(params.attachmentId?.trim());
    const hasAsset = Boolean(params.assetPath?.trim());
    if (hasAttachment === hasAsset) {
      throw new Error(
        "Provide exactly one source: an attachmentId, or a KB asset (entryId/entryPath + assetPath).",
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
    let persist: {
      entryId?: string;
      entryPath?: string;
      assetPath: string;
    } | null = null;

    if (hasAttachment) {
      if (params.persistToExtract) {
        throw new Error(
          "persistToExtract applies only to a KB asset source; an attachment has no asset to attach an extract to.",
        );
      }
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
      const assetPath = params.assetPath!.trim();
      const store = storeFactory();
      const read = await readKnowledgeAsset(store, {
        ...(params.entryId !== undefined ? { entryId: params.entryId } : {}),
        ...(params.entryPath !== undefined
          ? { entryPath: params.entryPath }
          : {}),
        assetPath,
        maxBytes: ASSET_READ_MAX_BYTES,
      });
      if (read.truncated)
        throw new Error(
          `KB asset "${assetPath}" is larger than ${ASSET_READ_MAX_BYTES} bytes and cannot be converted.`,
        );
      if (!isPdf(read.asset.mimeType, read.asset.path)) {
        throw new Error(
          `KB asset "${read.asset.path}" is not a PDF; convert_pdf only handles PDF documents.`,
        );
      }
      bytes = read.content;
      source = {
        kind: "kb_asset",
        entryId: read.entry.id,
        assetPath: read.asset.path,
      };
      if (params.persistToExtract)
        persist = { entryId: read.entry.id, assetPath: read.asset.path };
    }

    const result = await convertPdfToMarkdown({ bytes, allowClaudeFallback });

    let persisted = false;
    let extractPath: string | undefined;
    const notes = result.note ? [result.note] : [];
    if (persist) {
      if (!result.markdown.trim()) {
        notes.push(
          "Nothing was persisted: the conversion produced no Markdown.",
        );
      } else {
        const reason =
          params.reason?.trim() ||
          "Store converted PDF Markdown as asset extract";
        const written = await writeKnowledgeAssetExtract(
          storeFactory(),
          {
            ...(persist.entryId !== undefined
              ? { entryId: persist.entryId }
              : {}),
            assetPath: persist.assetPath,
            extractText: result.markdown,
          },
          persistMeta(ctx, reason, params.taskId, persist.entryId),
        );
        persisted = true;
        extractPath = written.extractPath;
      }
    }

    const truncated = result.markdown.length > maxChars;
    return jsonResult({
      capability: "convert_pdf",
      source,
      engine: result.engine,
      pageCount: result.pageCount,
      usedClaudeFallback: result.usedClaudeFallback,
      lowText: result.lowText,
      persisted,
      ...(extractPath ? { extractPath } : {}),
      markdown: truncated
        ? `${result.markdown.slice(0, maxChars - 1)}…`
        : result.markdown,
      truncated,
      ...(notes.length ? { note: notes.join(" ") } : {}),
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

function persistMeta(
  ctx: ToolCallContext,
  reason: string,
  taskId: string | undefined,
  entryId?: string,
): KbCommitMeta {
  const taskIdValue = taskId?.trim() || undefined;
  return {
    actor: {
      kind: "agent",
      id: `${ctx.session.harness}:${ctx.session.agentType}:${ctx.session.sessionId}`,
      name: ctx.session.title?.trim() || `${ctx.session.agentType} agent`,
    },
    reason,
    sessionId: ctx.session.sessionId,
    ...(taskIdValue !== undefined ? { taskId: taskIdValue } : {}),
    ...(entryId ? { entryIds: [entryId] } : {}),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Number(value) || min)));
}
