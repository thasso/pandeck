/**
 * The Confluence page mutation display types (`confluence_mutate_page`
 * proposals, approval bodies and results). An import-free leaf so the server's
 * shared mutation core, which the gateway's edge may import, reaches them
 * without the whole wire model (Task-1463); `protocol.ts` re-exports them
 * unchanged.
 */

/**
 * replace/append/prepend rewrite the body; comment adds a footer comment;
 * delete trashes the page. uploadAttachment adds a file to the page, or a new
 * version of one it already has; deleteAttachment trashes one.
 */
export type ConfluencePageMutationOperation =
  | "create"
  | "edit"
  | "comment"
  | "delete"
  | "uploadAttachment"
  | "deleteAttachment";

/** Where an edit's Markdown lands relative to the page's existing body. */
export type ConfluenceBodyPlacement = "replace" | "append" | "prepend";

export interface ConfluencePageMutationItemDisplay {
  clientId: string;
  operation: ConfluencePageMutationOperation;
  /** Existing page id for edit/comment/delete; absent on create until the page exists. */
  pageId?: string;
  pageUrl?: string | null;
  /** Current title for an existing page, or the title a create will use. */
  title?: string | null;
  /** edit: a new title, when the proposal renames the page. */
  newTitle?: string | null;
  spaceKey?: string | null;
  spaceName?: string | null;
  parentId?: string | null;
  parentTitle?: string | null;
  /** CommonMark/GFM source converted to Atlassian Document Format when executed. */
  body?: string;
  placement?: ConfluenceBodyPlacement;
  /**
   * The page's current body as Markdown, so the card shows what an edit
   * replaces rather than only what it writes.
   */
  currentBody?: string;
  /** Page version the proposal was built against; the write refuses on drift. */
  baseVersion?: number;
  /**
   * ADF node types present in the current page that Markdown cannot carry back
   * (macros, layouts, media). A replace would drop them, so the card says so.
   */
  lossyNodes?: string[];
  labelsAdded?: string[];
  labelsRemoved?: string[];
  /** edit and uploadAttachment: the version comment Confluence records. */
  versionMessage?: string;
  /** uploadAttachment/deleteAttachment: the file the item writes or removes. */
  attachment?: ConfluenceAttachmentMutationDisplay;
  resultPageId?: string | null;
  resultPageUrl?: string | null;
  resultVersion?: number | null;
  /** Non-fatal partial-execution diagnostic, e.g. page written but a label failed. */
  warning?: string;
  error?: string;
}

export interface ConfluenceAttachmentMutationDisplay {
  /** File name on the page, which is how Confluence tells attachments apart. */
  fileName: string;
  /** The attachment a new version replaces, or the one a delete removes. */
  existingId?: string;
  /** Its version when proposed; the write refuses when it moved. */
  baseVersion?: number;
  mediaType?: string | null;
  size?: number | null;
  /** upload: where the bytes came from — a host path or a session attachment name. */
  source?: string;
  /**
   * upload: the session attachment holding the exact bytes that were
   * proposed, and their SHA-256. A host path is copied there at proposal time,
   * so what uploads is what the user approved even if the file changes.
   */
  stagedAttachmentId?: string;
  sha256?: string;
  resultId?: string | null;
  resultVersion?: number | null;
}
