import {
  documentTargetRawUrl,
  resolveInternalDocumentTarget,
} from "./documentTargets.ts";

/**
 * The canonical served path for a `show_files` row's address, or null when it
 * is not an internal host-file or session-artifact target. Handed to the
 * shared `show_files` parser (`@assistant/shared/toolCards`), whose rule is
 * otherwise the server's too; the origin-checked resolver is what makes it the
 * WEB's (`docs/document-presentation.md`): a foreign origin, a lookalike
 * pathname on someone else's host, an app-relative path the app does not
 * serve, and a Knowledge or worktree address this tool never produces are all
 * dropped rather than rendered.
 */
export function resolveShowFilesTarget(url: string): string | null {
  const target = resolveInternalDocumentTarget(url);
  if (target?.kind !== "hostFile" && target?.kind !== "sessionArtifact")
    return null;
  return documentTargetRawUrl(target);
}
