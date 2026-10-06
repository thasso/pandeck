import { knowledgeFileLink } from "@assistant/shared/objectLinks";
import type { CommentTarget, SelectorBundle } from "@assistant/shared/comments";

/** A comment on a passage of the session transcript. */
export interface PendingTranscriptComment {
  id: string;
  anchor: Extract<CommentTarget, { kind: "session" }>;
  selectors: SelectorBundle;
  quote: string;
  body: string;
  /** Stable position in the rendered transcript, separate from anchor identity. */
  transcriptPosition: {
    rowCreatedAt: string;
    rowId: string;
    blockIndex: number;
  };
  entryCreatedAt?: string;
}

/**
 * A document a comment can be collected on (`docs/comments.md`). Whatever
 * names it here is what the agent is told, so it carries the path or id the
 * agent reads the document by.
 */
export type CommentDocument =
  | { kind: "hostFile"; path: string }
  /** A file in the Knowledge Base, by its path there (`pa://knowledge/<path>`). */
  | { kind: "knowledgeFile"; path: string };

/** A comment on a document: a quoted passage, or the whole document. */
export interface PendingDocumentComment {
  id: string;
  anchor: { kind: "document"; document: CommentDocument };
  /** The passage, as rendered. Absent for a comment on the whole document. */
  quote?: string;
  /** Rendered-text selectors, so the viewer can paint the passage again. */
  selectors?: SelectorBundle;
  /** 1-based source lines of the passage, when the renderer could name them. */
  lines?: { start: number; end: number };
  body: string;
  createdAt: string;
}

/** Everything a composer can carry into its next prompt. */
export type PendingChatComment =
  PendingTranscriptComment | PendingDocumentComment;

export interface SerializeChatCommentOptions {
  formatTime?: (createdAt: string) => string;
}

const MAX_QUOTE_LENGTH = 300;

/** Keep both ends of a long quote: either edge may be the useful locator. */
export function truncateChatCommentQuote(
  quote: string,
  maxLength = MAX_QUOTE_LENGTH,
): string {
  const normalized = quote.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  const remaining = Math.max(2, maxLength - 1);
  const start = Math.ceil(remaining / 2);
  const end = Math.floor(remaining / 2);
  return `${normalized.slice(0, start)}…${normalized.slice(-end)}`;
}

export function isTranscriptComment(
  comment: PendingChatComment,
): comment is PendingTranscriptComment {
  return comment.anchor.kind === "session";
}

export function isDocumentComment(
  comment: PendingChatComment,
): comment is PendingDocumentComment {
  return comment.anchor.kind === "document";
}

/** A short human name for a document: its file name. */
export function commentDocumentLabel(document: CommentDocument): string {
  return document.path.split("/").filter(Boolean).pop() ?? document.path;
}

/** One key per document, shared by its tray and the prompt's grouping. */
export function commentDocumentKey(document: CommentDocument): string {
  return document.kind === "knowledgeFile"
    ? `kb:${document.path}`
    : `file:${document.path}`;
}

function compareTranscriptComments(
  a: PendingTranscriptComment,
  b: PendingTranscriptComment,
): number {
  return (
    a.transcriptPosition.rowCreatedAt.localeCompare(
      b.transcriptPosition.rowCreatedAt,
    ) ||
    a.transcriptPosition.rowId.localeCompare(b.transcriptPosition.rowId) ||
    a.transcriptPosition.blockIndex - b.transcriptPosition.blockIndex ||
    (a.selectors.position?.start ?? 0) - (b.selectors.position?.start ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

/** Whole-document comments first, then passages top to bottom. */
function compareDocumentComments(
  a: PendingDocumentComment,
  b: PendingDocumentComment,
): number {
  const lineOf = (comment: PendingDocumentComment) =>
    comment.quote === undefined ? -1 : (comment.lines?.start ?? 0);
  return (
    lineOf(a) - lineOf(b) ||
    (a.selectors?.position?.start ?? 0) - (b.selectors?.position?.start ?? 0) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function defaultFormatTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return createdAt;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function indentBody(body: string): string {
  return body
    .trim()
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
}

function documentHeading(document: CommentDocument): string {
  return document.kind === "knowledgeFile"
    ? `Comments on Knowledge Base file \`${document.path}\` (${knowledgeFileLink(document.path)}; read it with kb_read):`
    : `Comments on \`${document.path}\`:`;
}

function documentLocator(comment: PendingDocumentComment): string {
  if (comment.quote === undefined) return "On the whole document";
  const quote = `“${truncateChatCommentQuote(comment.quote)}”`;
  const lines = comment.lines;
  if (!lines) return `On ${quote}`;
  return lines.end > lines.start
    ? `Lines ${lines.start}–${lines.end}, ${quote}`
    : `Line ${lines.start}, ${quote}`;
}

/**
 * Serialize browser-local annotations as ordinary prompt prose: transcript
 * comments first, then one section per document. Numbering runs across every
 * section, so "comment 3" names one comment whichever section it is in.
 */
export function serializeChatCommentPrompt(
  overallMessage: string,
  comments: readonly PendingChatComment[],
  options: SerializeChatCommentOptions = {},
): string {
  const message = overallMessage.trim();
  if (comments.length === 0) return message;

  const transcript = comments
    .filter(isTranscriptComment)
    .sort(compareTranscriptComments);
  const documents = new Map<
    string,
    { document: CommentDocument; comments: PendingDocumentComment[] }
  >();
  for (const comment of comments.filter(isDocumentComment)) {
    const key = commentDocumentKey(comment.anchor.document);
    const group = documents.get(key) ?? {
      document: comment.anchor.document,
      comments: [],
    };
    group.comments.push(comment);
    documents.set(key, group);
  }

  let counter = 0;
  const sections: string[] = [];
  if (transcript.length > 0) {
    const spansEntries =
      new Set(
        transcript.map(
          (comment) =>
            `${comment.anchor.sessionId}\u0000${comment.anchor.entryId}`,
        ),
      ).size > 1;
    const formatTime = options.formatTime ?? defaultFormatTime;
    const items = transcript.map((comment) => {
      const quote = truncateChatCommentQuote(comment.quote);
      const entryReference =
        spansEntries && comment.entryCreatedAt
          ? `your message at ${formatTime(comment.entryCreatedAt)}, `
          : "";
      counter += 1;
      return `${counter}. On ${entryReference}“${quote}”:\n${indentBody(comment.body)}`;
    });
    sections.push(
      `Comments on your previous response:\n\n${items.join("\n\n")}`,
    );
  }
  for (const group of documents.values()) {
    const items = [...group.comments]
      .sort(compareDocumentComments)
      .map((comment) => {
        counter += 1;
        return `${counter}. ${documentLocator(comment)}:\n${indentBody(comment.body)}`;
      });
    sections.push(
      `${documentHeading(group.document)}\n\n${items.join("\n\n")}`,
    );
  }

  const body = sections.join("\n\n");
  return message ? `${message}\n\n${body}` : body;
}
