import { parsePaObjectLink } from "./objectLinks.ts";

export interface DocumentLineAnchor {
  /** First 1-based line in the addressed range. */
  start: number;
  /** Inclusive last line. Omitted for a single-line anchor. */
  end?: number;
}

type Anchored = { anchor?: DocumentLineAnchor };

/** A document the app can open without leaving for an external URL. */
export type DocumentTarget =
  | ({ kind: "hostFile"; path: string } & Anchored)
  | ({ kind: "sessionArtifact"; sessionId: string; path: string } & Anchored)
  | ({ kind: "knowledgeFile"; path: string } & Anchored)
  | ({
      kind: "knowledgeAsset";
      entryId: string;
      path: string;
    } & Anchored)
  | ({
      kind: "worktreeFile";
      worktreeId: string;
      path: string;
      view: "file" | "diff";
    } & Anchored);

export type DocumentSourceContext = DocumentTarget;

const LINE_ANCHOR_RE = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/;

/** Both endpoints of a usable anchor: 1-based, exact, and in order. */
function validLineAnchor(anchor: DocumentLineAnchor): boolean {
  return (
    Number.isSafeInteger(anchor.start) &&
    anchor.start >= 1 &&
    (anchor.end === undefined ||
      (Number.isSafeInteger(anchor.end) && anchor.end >= anchor.start))
  );
}

/**
 * The most lines one anchor may draw and mark at once. A `#L1-L500000` range
 * is a legitimate address, but rendering it is not: a renderer shows this many
 * lines from the first addressed one and says the rest is not shown.
 */
export const MAX_DOCUMENT_ANCHOR_LINES = 500;

/**
 * The addressed range as a renderer may draw it: the whole range when it fits
 * in {@link MAX_DOCUMENT_ANCHOR_LINES}, otherwise that many lines from the
 * first addressed one, with `truncated` so the surface can say so.
 */
export function boundedDocumentLineRange(anchor: DocumentLineAnchor): {
  start: number;
  end: number;
  truncated: boolean;
} {
  const start = anchor.start;
  const end = Math.max(anchor.end ?? start, start);
  const capped = Math.min(end, start + MAX_DOCUMENT_ANCHOR_LINES - 1);
  return { start, end: capped, truncated: capped < end };
}

export function parseDocumentLineAnchor(
  fragment: string | undefined,
): DocumentLineAnchor | undefined {
  if (!fragment) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(fragment.replace(/^#/, ""));
  } catch {
    return undefined;
  }
  const match = LINE_ANCHOR_RE.exec(decoded);
  if (!match?.[1]) return undefined;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  // A digit run long enough to lose precision is not a line number: `1e21`
  // lines is neither addressable nor formattable, so the whole anchor is
  // dropped rather than carried as an approximation.
  const anchor = { start, ...(end !== undefined ? { end } : {}) };
  return validLineAnchor(anchor) ? anchor : undefined;
}

/**
 * The `#L…` fragment for an anchor, or `""` for one no address can express.
 * Never throws: this runs while building an href during render, and a target
 * assembled in code with a nonsense range must lose the anchor, not the page.
 */
export function formatDocumentLineAnchor(
  anchor: DocumentLineAnchor | undefined,
): string {
  if (!anchor || !validLineAnchor(anchor)) return "";
  return `#L${anchor.start}${anchor.end === undefined ? "" : `-L${anchor.end}`}`;
}

function decodePath(value: string): string | null {
  const segments = value.split("/");
  if (segments.length === 0 || segments.some((segment) => segment === ""))
    return null;
  try {
    return segments.map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
}

function parseAppUrl(input: string): URL | null {
  // Origin trust is a browser/runtime decision. Shared code parses app-relative
  // addresses only, so an absolute URL can never become internal by losing its
  // authority here.
  if (!input.startsWith("/") || input.startsWith("//")) return null;
  try {
    return new URL(input, "https://document-target.invalid");
  } catch {
    return null;
  }
}

function anchored<T extends Omit<DocumentTarget, "anchor">>(
  target: T,
  hash: string,
): T & Anchored {
  const anchor = parseDocumentLineAnchor(hash);
  return { ...target, ...(anchor ? { anchor } : {}) };
}

/** Parse a durable app/API/pa:// document address. External URLs return null. */
export function parseDocumentTarget(input: string): DocumentTarget | null {
  const pa = parsePaObjectLink(input);
  if (pa?.objectType === "worktree") {
    const params = new URLSearchParams(pa.query ?? "");
    const path = params.get("path");
    if (!path) return null;
    return anchored(
      {
        kind: "worktreeFile",
        worktreeId: pa.id,
        path,
        view:
          params.get("view") === "diff" ? ("diff" as const) : ("file" as const),
      },
      pa.fragment ?? "",
    );
  }
  if (pa?.objectType === "knowledge") {
    const params = new URLSearchParams(pa.query ?? "");
    const path = params.get("asset");
    if (!path) return null;
    return anchored(
      { kind: "knowledgeAsset", entryId: pa.id, path },
      pa.fragment ?? "",
    );
  }

  const url = parseAppUrl(input);
  if (!url) return null;
  const anchor = url.hash;
  const path = url.pathname;

  const hostPrefix = path.startsWith("/api/files/")
    ? "/api/files/"
    : path.startsWith("/files/")
      ? "/files/"
      : null;
  if (hostPrefix) {
    const encoded = path.slice(hostPrefix.length);
    // `/api/files//etc/passwd` is not another identity for `/etc/passwd`.
    if (encoded.startsWith("/")) return null;
    const decoded = decodePath(encoded);
    return decoded
      ? anchored({ kind: "hostFile", path: `/${decoded}` }, anchor)
      : null;
  }

  const artifactPrefix = path.startsWith("/api/session-artifacts/")
    ? "/api/session-artifacts/"
    : path.startsWith("/artifacts/")
      ? "/artifacts/"
      : null;
  if (artifactPrefix) {
    const decoded = decodePath(path.slice(artifactPrefix.length));
    const [sessionId, ...segments] = decoded?.split("/") ?? [];
    return sessionId && segments.length > 0
      ? anchored(
          {
            kind: "sessionArtifact",
            sessionId,
            path: segments.join("/"),
          },
          anchor,
        )
      : null;
  }

  if (path.startsWith("/knowledge/~file/")) {
    const decoded = decodePath(path.slice("/knowledge/~file/".length));
    return decoded
      ? anchored({ kind: "knowledgeFile", path: decoded }, anchor)
      : null;
  }
  if (path === "/api/knowledge/file") {
    const filePath = url.searchParams.get("path");
    return filePath
      ? anchored({ kind: "knowledgeFile", path: filePath }, anchor)
      : null;
  }
  if (path === "/api/knowledge/asset") {
    const entryId = url.searchParams.get("id");
    const assetPath = url.searchParams.get("path");
    return entryId && assetPath
      ? anchored({ kind: "knowledgeAsset", entryId, path: assetPath }, anchor)
      : null;
  }
  const knowledgeAsset = path.match(/^\/knowledge\/([^/]+)\/?$/);
  const knowledgeAssetPath = url.searchParams.get("asset");
  if (knowledgeAsset?.[1] && knowledgeAssetPath) {
    try {
      return anchored(
        {
          kind: "knowledgeAsset",
          entryId: decodeURIComponent(knowledgeAsset[1]),
          path: knowledgeAssetPath,
        },
        anchor,
      );
    } catch {
      return null;
    }
  }

  const worktree = path.match(
    /^\/worktrees\/([^/]+)(?:\/(files|changes))?\/?$/,
  );
  if (worktree?.[1]) {
    const filePath = url.searchParams.get("path");
    if (!filePath) return null;
    let worktreeId: string;
    try {
      worktreeId = decodeURIComponent(worktree[1]);
    } catch {
      return null;
    }
    return anchored(
      {
        kind: "worktreeFile",
        worktreeId,
        path: filePath,
        view:
          worktree[2] === "changes" || url.searchParams.get("view") === "diff"
            ? ("diff" as const)
            : ("file" as const),
      },
      anchor,
    );
  }
  return null;
}

function encodedPath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/** Canonical in-app viewer route for a typed target. */
export function documentTargetHref(target: DocumentTarget): string {
  const anchor = formatDocumentLineAnchor(target.anchor);
  switch (target.kind) {
    case "hostFile":
      return `/files/${encodedPath(target.path)}${anchor}`;
    case "sessionArtifact":
      return `/artifacts/${encodeURIComponent(target.sessionId)}/${encodedPath(target.path)}${anchor}`;
    case "knowledgeFile":
      return `/knowledge/~file/${encodedPath(target.path)}${anchor}`;
    case "knowledgeAsset":
      return `/knowledge/${encodeURIComponent(target.entryId)}?asset=${encodeURIComponent(target.path)}${anchor}`;
    case "worktreeFile": {
      const params = new URLSearchParams({ path: target.path });
      if (target.view === "diff") params.set("view", "diff");
      const view = target.view === "diff" ? "changes" : "files";
      return `/worktrees/${encodeURIComponent(target.worktreeId)}/${view}?${params.toString()}${anchor}`;
    }
  }
}

/** Durable Markdown URI for sources with a first-class pa:// object identity. */
export function documentTargetPaUri(target: DocumentTarget): string | null {
  const anchor = formatDocumentLineAnchor(target.anchor);
  if (target.kind === "worktreeFile") {
    const params = new URLSearchParams({ path: target.path });
    if (target.view === "diff") params.set("view", "diff");
    return `pa://worktree/${encodeURIComponent(target.worktreeId)}?${params.toString()}${anchor}`;
  }
  if (target.kind === "knowledgeAsset") {
    return `pa://knowledge/${encodeURIComponent(target.entryId)}?asset=${encodeURIComponent(target.path)}${anchor}`;
  }
  return null;
}

function sourceWithPathAndAnchor(
  source: DocumentSourceContext,
  path: string,
  anchor: DocumentLineAnchor | undefined,
  sameDocument = false,
): DocumentTarget {
  const anchored = anchor ? { anchor } : {};
  switch (source.kind) {
    case "hostFile":
      return { kind: "hostFile", path: `/${path}`, ...anchored };
    case "sessionArtifact":
      return {
        kind: "sessionArtifact",
        sessionId: source.sessionId,
        path,
        ...anchored,
      };
    case "knowledgeFile":
      return { kind: "knowledgeFile", path, ...anchored };
    case "knowledgeAsset":
      return {
        kind: "knowledgeAsset",
        entryId: source.entryId,
        path,
        ...anchored,
      };
    case "worktreeFile":
      return {
        kind: "worktreeFile",
        worktreeId: source.worktreeId,
        path,
        view: sameDocument ? source.view : "file",
        ...anchored,
      };
  }
}

/** Resolve one relative document link without changing its source identity. */
export function resolveDocumentReference(
  source: DocumentSourceContext,
  reference: string,
): DocumentTarget | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith("/"))
    return parseDocumentTarget(reference);

  const anchor = parseDocumentLineAnchor(reference.split("#")[1]);
  if (reference.startsWith("#")) {
    return sourceWithPathAndAnchor(
      source,
      source.path.replace(/^\/+/, ""),
      anchor,
      true,
    );
  }

  try {
    // Encode the already-decoded source, then let URL resolve dot segments and
    // decode each resulting segment exactly once. `%2520` therefore names a
    // literal `%20`; `%20` names one space and is never decoded a second time.
    const base = `https://document-relative.invalid/${encodedPath(source.path)}`;
    const resolved = new URL(reference, base);
    const path = decodePath(resolved.pathname.slice(1));
    if (!path) return null;
    return sourceWithPathAndAnchor(source, path, anchor);
  } catch {
    return null;
  }
}
