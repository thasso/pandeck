/**
 * Path rules of the Knowledge Base folder (docs/knowledge-base.md).
 *
 * The KB is a plain folder of files in a Git repository: no entry schema, no
 * required frontmatter, no reserved layout. What this module owns is the one
 * thing every reader and writer must agree on — which paths a caller may name.
 */

export const KB_REPO_DIR_NAME = "knowledge";

/**
 * A caller's KB-relative path, normalized: forward slashes, no empty, `.` or
 * `..` segments. Absolute paths and traversal throw instead of being clamped,
 * so a bad path is a visible error rather than a write somewhere else.
 */
export function normalizeKnowledgeRelativePath(input: string): string {
  const raw = input.trim();
  if (/^\/|^[A-Za-z]:[\\/]/.test(raw))
    throw new Error(
      "Knowledge paths must be relative and must not contain traversal segments.",
    );
  const parts = raw.replace(/\\/g, "/").split("/").filter(Boolean);
  if (
    parts.some((part) => part === "." || part === ".." || part.includes("\0"))
  ) {
    throw new Error(
      "Knowledge paths must be relative and must not contain traversal segments.",
    );
  }
  return parts.join("/");
}

/**
 * Whether a path is outside what the tools list, search and write: anything
 * under a dot-segment — git's own `.git`, `.gitignore`, the retired `.kb`
 * control folder, an editor's `.obsidian`. The browser still shows them under
 * "Show ignored and hidden files"; agents leave them alone.
 */
export function isHiddenKnowledgePath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}
