import { KNOWLEDGE_WORKTREE_ID } from "@assistant/shared";
import {
  documentTargetHref,
  type DocumentTarget,
} from "@assistant/shared/documentTargets";

/** What "Start session with this file" stages for the document on screen. */
interface FileSessionStart {
  /** The document's canonical viewer route, without the reader's line anchor. */
  href: string;
  /** Its name, for the composer chip. */
  title: string;
  /**
   * The checkout the session should run in, for a file inside one. Never the
   * Knowledge Base: it is no session's working directory.
   */
  worktreeId: string | null;
}

/**
 * The file a session would start from: the anchor is how the reader arrived,
 * not part of the file, and a worktree diff hands over the file itself.
 */
export function fileSessionStart(target: DocumentTarget): FileSessionStart {
  const { anchor: _anchor, ...bare } = target;
  const file: DocumentTarget =
    bare.kind === "worktreeFile" ? { ...bare, view: "file" } : bare;
  return {
    href: documentTargetHref(file),
    title: bare.path.split("/").filter(Boolean).at(-1) ?? bare.path,
    worktreeId:
      bare.kind === "worktreeFile" && bare.worktreeId !== KNOWLEDGE_WORKTREE_ID
        ? bare.worktreeId
        : null,
  };
}
