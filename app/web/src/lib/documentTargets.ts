import {
  parseDocumentTarget,
  type DocumentTarget,
} from "@assistant/shared/documentTargets";
import { directFileApiPath } from "./servedFiles.ts";
import { serverHttpOrigin } from "./serverOrigin.ts";
import { worktreeFileRawUrl } from "./worktrees.ts";

/**
 * Resolve an internal target from a route, pa:// URI, or an absolute URL to the
 * configured app server. A foreign http(s) origin always remains external.
 */
export function resolveInternalDocumentTarget(
  input: string,
): DocumentTarget | null {
  const direct = parseDocumentTarget(input);
  if (direct) return direct;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const pageOrigin = typeof location === "undefined" ? "" : location.origin;
  if (url.origin !== serverHttpOrigin() && url.origin !== pageOrigin)
    return null;
  return parseDocumentTarget(`${url.pathname}${url.search}${url.hash}`);
}

export function sameDocumentIdentity(
  left: DocumentTarget,
  right: DocumentTarget,
): boolean {
  const { anchor: _leftAnchor, ...leftIdentity } = left;
  const { anchor: _rightAnchor, ...rightIdentity } = right;
  return JSON.stringify(leftIdentity) === JSON.stringify(rightIdentity);
}

/** Authenticated API path for bytes belonging to a resolved internal target. */
export function documentTargetRawUrl(target: DocumentTarget): string {
  switch (target.kind) {
    case "hostFile":
      return directFileApiPath(target.path);
    case "sessionArtifact":
      return `/api/session-artifacts/${encodeURIComponent(target.sessionId)}/${target.path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
    case "worktreeFile":
      return worktreeFileRawUrl(target.worktreeId, target.path);
  }
}
