/**
 * Session attachment tools. Uploaded files and server-fetched binaries live in
 * the addressable session attachment store (`../sessionAttachments.ts`); these
 * tools let the agent discover them and read bounded text. Raw binary bytes are
 * never returned inline — copy those into the Knowledge Base with kb_add_asset
 * (sourceAttachmentId), which transfers server-side.
 */
import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";
import {
  listSessionAttachments,
  resolveSessionAttachment,
  readSessionAttachmentBytes,
  type SessionAttachmentRecord,
} from "../../sessionAttachments.ts";

const TEXT_MIME_RE =
  /^(text\/|application\/(json|ld\+json|xml|x-ndjson|yaml|x-yaml|javascript|sql)|[a-z]+\+(json|xml)$)/i;
const MAX_READ_CHARS = 100_000;

export const listAttachmentsTool = defineAgentTool<Record<string, never>>({
  name: "list_attachments",
  label: "Attachments: List",
  description:
    "List files attached to this session, uploaded by the user or staged by a tool. Metadata only.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async execute(_params, ctx) {
    const attachments = listSessionAttachments(ctx.session.sessionId).map(
      publicRecord,
    );
    return jsonResult({
      capability: "list_attachments",
      count: attachments.length,
      attachments,
    });
  },
});

export const readAttachmentTool = defineAgentTool<{
  attachmentId: string;
  maxCharacters?: number;
}>({
  name: "read_attachment",
  label: "Attachments: Read",
  // The binary case ends in a result that NAMES kb_add_asset as the way to
  // carry the file into the KB, so the description only has to say that raw
  // bytes never come back inline (Task-285).
  description:
    "Read bounded UTF-8 text from a session attachment by id; binary files (PDF, images, docs) return metadata only.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["attachmentId"],
    properties: {
      attachmentId: {
        type: "string",
        description: "From list_attachments or a staging tool.",
      },
      // Clamped to MAX_READ_CHARS at runtime, so no schema maximum: an
      // over-ask should truncate, not fail validation.
      maxCharacters: { type: "number", default: 20_000 },
    },
  },
  async execute(params, ctx) {
    const id = params.attachmentId?.trim();
    if (!id) throw new Error("attachmentId is required.");
    const record = resolveSessionAttachment(ctx.session.sessionId, id);
    if (!record)
      throw new Error(
        `No session attachment found for id "${id}". Use list_attachments to see available attachments.`,
      );
    if (!isTextLike(record)) {
      return jsonResult({
        capability: "read_attachment",
        attachment: publicRecord(record),
        status: "binary",
        hint: "Use kb_add_asset with sourceAttachmentId to copy this file into the Knowledge Base.",
      });
    }
    const maxCharacters = clamp(
      params.maxCharacters ?? 20_000,
      1,
      MAX_READ_CHARS,
    );
    const bytes = readSessionAttachmentBytes(ctx.session.sessionId, id)!.bytes;
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const truncated = decoded.length > maxCharacters;
    return jsonResult({
      capability: "read_attachment",
      attachment: publicRecord(record),
      status: "content",
      content: truncated ? `${decoded.slice(0, maxCharacters - 1)}…` : decoded,
      contentTruncated: truncated,
    });
  },
});

export const assistantAttachmentTools = [
  listAttachmentsTool,
  readAttachmentTool,
];

function publicRecord(record: SessionAttachmentRecord) {
  return {
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    source: record.source,
    createdAt: record.createdAt,
    ...(record.role ? { role: record.role } : {}),
  };
}

function isTextLike(record: SessionAttachmentRecord): boolean {
  return TEXT_MIME_RE.test(record.mimeType);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Number(value) || min)));
}
