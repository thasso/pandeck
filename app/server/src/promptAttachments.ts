/**
 * Harness-neutral helpers for presenting user-attached prompt files to a model.
 *
 * Both the pi and Claude SDK harnesses drive attachments the same way through
 * here: images are threaded to the model as image content blocks, and every
 * other file is persisted to the addressable session attachment store and
 * represented in a prompt suffix — inline decoded text for text-like files,
 * otherwise a saved-path reference the model can read via `read_attachment` or
 * copy via `kb_write`. A leading comment-wrapped manifest lets a reloaded
 * transcript rebuild the attachment chips (and recover the clean prompt text).
 *
 * The durable/display attachment chips are recorded separately by the runtime
 * (`session/runtime/liveSession.ts`) from the structured `PromptAttachment`
 * list; this module only builds the MODEL-facing prompt text + image content.
 */
import type { PromptAttachment } from "@assistant/shared";
import {
  persistUploadedAttachment,
  type SessionAttachmentRecord,
} from "./sessionAttachments.ts";
import { buildAttachmentManifest } from "./serialize.ts";

/** An image content block in the harness-neutral shape both harnesses map from. */
export interface ImageContentLike {
  type: "image";
  data: string;
  mimeType: string;
}

const MAX_INLINE_ATTACHMENT_CHARS = 200_000;
const TEXT_MIME_RE =
  /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml))/i;
const TEXT_EXT_RE =
  /\.(txt|md|markdown|json|jsonl|csv|ts|tsx|js|jsx|mjs|cjs|css|scss|html|xml|yml|yaml|toml|ini|log|sql|py|rb|rs|go|java|kt|swift|c|cc|cpp|h|hpp|sh|bash|zsh|fish)$/i;

function maybeDecodeText(a: PromptAttachment): string | null {
  if (!TEXT_MIME_RE.test(a.mimeType) && !TEXT_EXT_RE.test(a.name)) return null;
  try {
    return Buffer.from(a.data, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Persist every prompt attachment (including images) to the addressable session
 * attachment store, so a later tool call can copy or read it by id. Returns the
 * saved records keyed by attachment id for the prompt-suffix path text.
 */
function persistPromptAttachments(
  sessionId: string,
  attachments: PromptAttachment[],
): Map<string, SessionAttachmentRecord> {
  const records = new Map<string, SessionAttachmentRecord>();
  for (const a of attachments)
    records.set(a.id, persistUploadedAttachment(sessionId, a));
  return records;
}

function attachmentPromptSuffix(
  saved: Map<string, SessionAttachmentRecord>,
  attachments: PromptAttachment[],
): string {
  const parts: string[] = [];
  const manifest: {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    role?: NonNullable<PromptAttachment["role"]>;
  }[] = [];
  for (const a of attachments) {
    if (a.mimeType.startsWith("image/")) continue;
    manifest.push({
      id: a.id,
      name: a.name,
      mimeType: a.mimeType,
      size: a.size,
      ...(a.role !== undefined ? { role: a.role } : {}),
    });
    const savedPath = saved.get(a.id)?.path ?? "";
    const text = maybeDecodeText(a);
    if (text != null) {
      const truncated = text.length > MAX_INLINE_ATTACHMENT_CHARS;
      const body = truncated
        ? text.slice(0, MAX_INLINE_ATTACHMENT_CHARS)
        : text;
      parts.push(
        [
          `Attached file: ${a.name} (${a.mimeType || "unknown type"}, ${a.size} bytes, attachment id ${a.id}).`,
          `Saved on the server at: ${savedPath}`,
          truncated
            ? `Inline content is truncated to ${MAX_INLINE_ATTACHMENT_CHARS} characters.`
            : "Inline content:",
          "```",
          body,
          "```",
        ].join("\n"),
      );
    } else {
      parts.push(
        `Attached file: ${a.name} (${a.mimeType || "unknown type"}, ${a.size} bytes, attachment id ${a.id}) saved on the server at: ${savedPath}. ` +
          "Use read_attachment to inspect it or kb_write with sourceAttachmentId to copy the raw file into the Knowledge Base; the bytes never pass through your context.",
      );
    }
  }
  // Lead with a comment-wrapped manifest so a reloaded transcript can rebuild the
  // attachment chips (and recover the clean prompt text) for all attachment kinds.
  return parts.length
    ? `\n\n${buildAttachmentManifest(manifest)}\n${parts.join("\n\n")}`
    : "";
}

/** Image attachments as harness-neutral image content blocks for the model turn. */
function imageAttachmentContents(
  attachments: PromptAttachment[],
): ImageContentLike[] {
  return attachments
    .filter((a) => a.mimeType.startsWith("image/"))
    .map((a): ImageContentLike => ({
      type: "image",
      data: a.data,
      mimeType: a.mimeType,
    }));
}

/**
 * Persist attachments and build the model-facing prompt in one step: the caller's
 * text with an appended file suffix for non-image attachments, plus the image
 * content blocks to thread alongside it.
 */
export function buildModelPromptWithAttachments(
  sessionId: string,
  promptText: string,
  attachments: PromptAttachment[],
): { promptWithFiles: string; images: ImageContentLike[] } {
  const saved = persistPromptAttachments(sessionId, attachments);
  const promptWithFiles = `${promptText}${attachmentPromptSuffix(saved, attachments)}`;
  return { promptWithFiles, images: imageAttachmentContents(attachments) };
}
