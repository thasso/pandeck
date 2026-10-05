import { Buffer } from "node:buffer";
import { basename } from "node:path";
import type { PromptAttachment } from "@assistant/shared";
import {
  documentTargetHref,
  parseDocumentTarget,
} from "@assistant/shared/documentTargets";
import { resolveDocumentTargetPath } from "./documentGrantTargets.ts";

function safeAttachmentIdPart(value: string): string {
  // Attachment ids are validated by isSafeId: [A-Za-z0-9_-], max 64.
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(-48) || "file"
  );
}

/**
 * Build the context attachment for a session started from a document.
 *
 * `href` is the document's canonical viewer route (`/files/...`,
 * `/worktrees/<id>/files?path=...`, ...). The server resolves it through the
 * document's own authority, so the attachment names a path the client could
 * not have invented. It carries the file's name, absolute path and route — never
 * its content: the agent reads the file when it needs it, and a large file
 * costs nothing until then. An unresolvable target yields no attachment.
 */
export async function buildFileContextAttachment(
  href: string,
): Promise<PromptAttachment | undefined> {
  const parsed = parseDocumentTarget(href);
  if (!parsed) return undefined;
  // A line anchor is how the reader arrived, not part of what is attached.
  const { anchor: _anchor, ...target } = parsed;
  let path: string;
  try {
    path = await resolveDocumentTargetPath(target);
  } catch {
    return undefined;
  }
  const name = basename(path) || "File";
  const markdown = [
    "# File context",
    "",
    `- File: ${name}`,
    `- Path: ${path}`,
    `- Opened from: ${documentTargetHref(target)}`,
    "",
    "The session was started from this file. Its content is not included: read it from the path above when you need it.",
  ].join("\n");
  return {
    id: `filectx-${safeAttachmentIdPart(path)}`,
    name,
    mimeType: "text/markdown",
    size: Buffer.byteLength(markdown, "utf8"),
    data: Buffer.from(markdown, "utf8").toString("base64"),
    role: "file-context",
  };
}
