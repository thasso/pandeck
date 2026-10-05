import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { DocumentTarget } from "@assistant/shared/documentTargets";
import type { MintFileGrantRequest } from "@assistant/shared/servedFiles";
import { DATA_DIR } from "./config.ts";
import { mintDocumentGrant, type MintedDocument } from "./directFileGrants.ts";
import { containedRealPath } from "./worktrees/worktreeDiff.ts";
import { resolveReadableWorktreeRow } from "./worktrees/knowledgeCheckout.ts";

interface ResolvedGrantSource {
  filePath: string;
  /** Canonical source authority the selected file must remain within. */
  root: string;
  /** Source identity participates in grant reuse; aliases never merge powers. */
  sourceKey: string;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(
  value: unknown,
  label: string,
  options: { absolute?: boolean } = {},
): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    (options.absolute === true && !isAbsolute(value))
  )
    throw new Error(`Invalid ${label}.`);
  return value;
}

/** Validate the authenticated wire request before it reaches any source root. */
export function parseMintFileGrantRequest(
  value: unknown,
): MintFileGrantRequest {
  const request = recordOf(value);
  const target = recordOf(request?.target);
  if (!request || !target) throw new Error("A document target is required.");
  const scope = request.scope;
  const delivery = request.delivery;
  if (request.fresh !== undefined && request.fresh !== true)
    throw new Error("Invalid grant freshness request.");
  if (scope !== "file" && scope !== "directory")
    throw new Error("Invalid file grant scope.");
  if (delivery !== "inline" && delivery !== "attachment")
    throw new Error("Invalid file grant delivery.");
  if (delivery === "attachment" && scope !== "file")
    throw new Error("Attachment grants require file scope.");

  const path = requiredString(target.path, "document path", {
    absolute: target.kind === "hostFile",
  });
  let parsedTarget: DocumentTarget;
  switch (target.kind) {
    case "hostFile":
      parsedTarget = { kind: "hostFile", path };
      break;
    case "sessionArtifact":
      parsedTarget = {
        kind: "sessionArtifact",
        sessionId: requiredString(target.sessionId, "session id"),
        path,
      };
      break;
    case "worktreeFile":
      if (target.view !== "file" && target.view !== "diff")
        throw new Error("Invalid worktree document view.");
      parsedTarget = {
        kind: "worktreeFile",
        worktreeId: requiredString(target.worktreeId, "worktree id"),
        path,
        view: target.view,
      };
      break;
    default:
      throw new Error("Invalid document target source.");
  }

  if (scope === "directory" && !/\.html?$/i.test(path))
    throw new Error("Directory grants are available only for runnable HTML.");
  return {
    target: parsedTarget,
    scope,
    delivery,
    ...(request.fresh === true ? { fresh: true } : {}),
  };
}

function containedPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const back = relative(root, absolute);
  if (!back || back.startsWith("..") || isAbsolute(back))
    throw new Error("Invalid document path.");
  return absolute;
}

export interface DocumentGrantResolverDependencies {
  dataDir: string;
  resolveWorktree: typeof resolveReadableWorktreeRow;
}

const DEFAULT_RESOLVER_DEPENDENCIES: DocumentGrantResolverDependencies = {
  dataDir: DATA_DIR,
  resolveWorktree: resolveReadableWorktreeRow,
};

/**
 * A session id names ONE direct child of `session-artifacts` and nothing else.
 * Either slash style would make it a path rather than a name, and `.`/`..`
 * would name the artifacts root or its parent. Every resolver that opens an
 * artifact — the grant resolver below, `show_files` — asks this one question,
 * because a source authority the two halves disagree about is not one.
 */
export function assertArtifactSessionId(sessionId: string): void {
  if (
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId === "." ||
    sessionId === ".."
  )
    throw new Error("Invalid session id.");
}

/** Resolve a typed source through its authoritative registry/root, never the client. */
async function resolveDocumentGrantSource(
  target: DocumentTarget,
  dependencies: DocumentGrantResolverDependencies = DEFAULT_RESOLVER_DEPENDENCIES,
): Promise<ResolvedGrantSource> {
  switch (target.kind) {
    case "hostFile":
      return { filePath: target.path, root: "/", sourceKey: "host" };
    case "sessionArtifact": {
      assertArtifactSessionId(target.sessionId);
      const artifactsRoot = await realpath(
        join(dependencies.dataDir, "session-artifacts"),
      );
      const root = await realpath(join(artifactsRoot, target.sessionId));
      // A session folder is an authority boundary, not an alias to another
      // session (or outside DATA_DIR).
      if (
        dirname(root) !== artifactsRoot ||
        basename(root) !== target.sessionId ||
        root !== join(artifactsRoot, target.sessionId)
      )
        throw new Error("Artifact session root escapes its source authority.");
      return {
        filePath: containedPath(root, target.path),
        root,
        sourceKey: `artifact:${target.sessionId}`,
      };
    }
    case "worktreeFile": {
      const row = await dependencies.resolveWorktree(target.worktreeId);
      if (!row || row.status !== "active") throw new Error("Unknown worktree.");
      return {
        filePath: containedRealPath(row.path, target.path),
        root: row.path,
        sourceKey: `worktree:${row.id}`,
      };
    }
  }
}

/**
 * The absolute path a document target names, resolved through its owning root
 * or registry exactly as a grant would be — never a client-supplied path.
 */
export async function resolveDocumentTargetPath(
  target: DocumentTarget,
): Promise<string> {
  return (await resolveDocumentGrantSource(target)).filePath;
}

/** Mint the minimum source-bound capability represented by one wire request. */
export async function mintDocumentTargetGrant(
  request: MintFileGrantRequest,
  dependencies: DocumentGrantResolverDependencies = DEFAULT_RESOLVER_DEPENDENCIES,
): Promise<MintedDocument> {
  const resolved = await resolveDocumentGrantSource(
    request.target,
    dependencies,
  );
  // Canonicalizing the authority here lets the generic grant layer compare the
  // same filesystem spelling it uses for the document and every sibling.
  const root = await realpath(resolved.root);
  return mintDocumentGrant(resolved.filePath, request.scope, request.delivery, {
    root,
    sourceKey: resolved.sourceKey,
    ...(request.fresh === true ? { fresh: true } : {}),
  });
}
