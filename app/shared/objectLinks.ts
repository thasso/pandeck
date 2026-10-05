/**
 * Generic first-class object links for the personal-assistant app.
 *
 * `pa://<object-type>/<id>` links are durable Markdown/app references whose
 * visible labels can be resolved at render time without rewriting stored text.
 * A Knowledge Base link names a FILE PATH instead of an id —
 * `pa://knowledge/projects/plan.md` — so its "id" may span several segments.
 */
export const PA_OBJECT_TYPES = [
  "knowledge",
  "task",
  "project",
  "session",
  "worktree",
  "approval",
] as const;

export type PaObjectType = (typeof PA_OBJECT_TYPES)[number];
export type PaObjectExistence = "exists" | "missing" | "unknown";

export interface PaObjectLink {
  /** Original URI, normalized only by callers that explicitly format it. */
  uri: string;
  /** Object type segment from the URI host, lower-cased. */
  objectType: string;
  /** True when objectType is one of the app's known first-class object types. */
  knownType: boolean;
  /**
   * Decoded path segment identifying the app object; for `knowledge`, the
   * file's path inside the Knowledge Base, segments joined by `/`.
   */
  id: string;
  /** URI query string without the leading `?`, preserved for future extensions. */
  query?: string;
  /** URI fragment without the leading `#`, preserved for anchors. */
  fragment?: string;
}

export interface PaObjectLinkResolution extends PaObjectLink {
  /** Canonical in-app route for the referenced object. */
  href: string;
  /** Human title suitable for inferred Markdown link text. */
  title: string;
  /** Compact type label, e.g. `Task` or `Project`. */
  typeLabel: string;
  /** Existence state, so renderers can distinguish broken links from unknown placeholders. */
  existence: PaObjectExistence;
  /**
   * Short live state a renderer shows after the label, e.g. an approval's
   * `pending approval`. Absent for objects whose title says enough.
   */
  detail?: string;
}

const PA_SCHEME = "pa:";
const MAX_OBJECT_TYPE_LENGTH = 40;
const MAX_OBJECT_ID_LENGTH = 256;
const MAX_KNOWLEDGE_PATH_LENGTH = 1024;
const OBJECT_TYPE_RE = /^[a-z][a-z0-9._-]*$/;
const PA_URI_PATTERN =
  /\bpa:\/\/[A-Za-z][A-Za-z0-9._-]*\/[\w.%~:+-]+(?:\/[\w.%~:+-]+)*(?:\?[^\s<>()[\]{}]*)?(?:#[^\s<>()[\]{}]*)?/g;
const KNOWN_TYPES = new Set<string>(PA_OBJECT_TYPES);

export function isPaObjectType(value: string): value is PaObjectType {
  return KNOWN_TYPES.has(value);
}

export function parsePaObjectLink(input: string): PaObjectLink | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== PA_SCHEME) return null;
  if (url.username || url.password || url.port) return null;
  const objectType = url.hostname.toLowerCase();
  if (
    !OBJECT_TYPE_RE.test(objectType) ||
    objectType.length > MAX_OBJECT_TYPE_LENGTH
  )
    return null;
  // The path as written: `URL` would resolve `a/../b` to `b` silently.
  const encodedPath = /^pa:\/\/[^/?#]*\/([^?#]*)/i.exec(raw)?.[1] ?? "";
  if (!encodedPath) return null;
  const id =
    objectType === "knowledge"
      ? decodeKnowledgePath(encodedPath)
      : decodeObjectId(encodedPath);
  if (id === null) return null;
  let fragment: string | undefined;
  try {
    fragment = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;
  } catch {
    return null;
  }
  return {
    uri: raw,
    objectType,
    knownType: isPaObjectType(objectType),
    id,
    ...(url.search ? { query: url.search.slice(1) } : {}),
    ...(fragment !== undefined ? { fragment } : {}),
  };
}

function decodeObjectId(encoded: string): string | null {
  if (encoded.includes("/")) return null;
  let id: string;
  try {
    id = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  return id && id.length <= MAX_OBJECT_ID_LENGTH && !/[\0/]/.test(id)
    ? id
    : null;
}

/** A Knowledge Base file path: plain relative segments, never `.`/`..`. */
function decodeKnowledgePath(encoded: string): string | null {
  const segments: string[] = [];
  for (const part of encoded.split("/")) {
    const segment = decodeObjectId(part);
    if (segment === null || segment === "." || segment === "..") return null;
    segments.push(segment);
  }
  const path = segments.join("/");
  return path.length <= MAX_KNOWLEDGE_PATH_LENGTH ? path : null;
}

/** The `pa://knowledge/<path>` link to one Knowledge Base file. */
export function knowledgeFileLink(path: string): string {
  return formatPaObjectLink({ objectType: "knowledge", id: path });
}

export function formatPaObjectLink(input: {
  objectType: string;
  id: string;
  query?: string | URLSearchParams;
  fragment?: string;
}): string {
  const objectType = input.objectType.trim().toLowerCase();
  if (
    !OBJECT_TYPE_RE.test(objectType) ||
    objectType.length > MAX_OBJECT_TYPE_LENGTH
  ) {
    throw new Error(
      "pa:// object type must start with a letter and contain only letters, digits, '.', '_', or '-'.",
    );
  }
  const id = input.id.trim();
  const encoded =
    objectType === "knowledge"
      ? id.split("/").map(encodeURIComponent).join("/")
      : encodeURIComponent(id);
  const valid =
    objectType === "knowledge"
      ? decodeKnowledgePath(encoded) === id
      : decodeObjectId(encoded) === id;
  if (!valid)
    throw new Error(
      objectType === "knowledge"
        ? "pa://knowledge path must be a relative file path without empty, '.' or '..' segments."
        : "pa:// object id must be a non-empty single path segment.",
    );
  const query =
    input.query instanceof URLSearchParams
      ? input.query.toString()
      : input.query?.replace(/^\?/, "");
  const fragment = input.fragment?.replace(/^#/, "");
  return `pa://${objectType}/${encoded}${query ? `?${query}` : ""}${fragment ? `#${encodeURIComponent(fragment)}` : ""}`;
}

export function findPaObjectLinkUris(text: string): string[] {
  const uris: string[] = [];
  for (const match of text.matchAll(PA_URI_PATTERN)) {
    const uri = trimTrailingPaPunctuation(match[0]);
    if (parsePaObjectLink(uri)) uris.push(uri);
  }
  return uris;
}

export function extractPaObjectLinkUris(text: string): string[] {
  return [...new Set(findPaObjectLinkUris(text))];
}

function trimTrailingPaPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/, "");
}

export function paObjectPath(type: string, id: string): string {
  const encoded = encodeURIComponent(id);
  switch (type) {
    case "knowledge":
      return `/knowledge/files?path=${encoded}`;
    case "task":
      return `/tasks/${encoded}`;
    case "project":
      return `/projects/${encoded}`;
    case "session":
      return `/sessions/${encoded}`;
    case "worktree":
      return `/worktrees/${encoded}`;
    // No route of its own: a card lives in its session's transcript, which the
    // bare id cannot name. Resolvers that know the session use
    // `approvalCardHref` instead.
    case "approval":
    default:
      return `#unresolved-pa-link:${encodeURIComponent(`${type}/${id}`)}`;
  }
}

export function paObjectTypeLabel(type: string): string {
  switch (type) {
    case "knowledge":
      return "Knowledge";
    case "task":
      return "Task";
    case "project":
      return "Project";
    case "session":
      return "Session";
    case "worktree":
      return "Worktree";
    case "approval":
      return "Approval";
    default:
      return "Object";
  }
}

/**
 * An approval card's transcript row id: what `#m-<entryId>` addresses and a
 * reveal lands on. A card is a store-backed overlay rather than a log entry,
 * so its row id is derived from the card instead of assigned by the log.
 */
export function approvalMessageId(approvalId: string): string {
  return `approval-${approvalId}`;
}

/** The approval a {@link approvalMessageId} row id names, or null for any other row. */
export function approvalIdFromMessageId(entryId: string): string | null {
  const match = entryId.match(/^approval-(.+)$/);
  return match ? match[1]! : null;
}

/** Where an approval card is shown: its row in the session that proposed it. */
export function approvalCardHref(
  sessionId: string,
  approvalId: string,
): string {
  return `${paObjectPath("session", sessionId)}#m-${encodeURIComponent(approvalMessageId(approvalId))}`;
}

export function paObjectHref(
  link: Pick<PaObjectLink, "objectType" | "id" | "query" | "fragment">,
): string {
  const path = paObjectPath(link.objectType, link.id);
  if (path.startsWith("#")) return path;
  const join = path.includes("?") ? "&" : "?";
  return `${path}${link.query ? `${join}${link.query}` : ""}${link.fragment ? `#${encodeURIComponent(link.fragment)}` : ""}`;
}

export function paObjectKey(
  link: Pick<PaObjectLink, "objectType" | "id">,
): string {
  return `${link.objectType}:${link.id}`;
}

export function fallbackPaObjectTitle(
  link: Pick<PaObjectLink, "objectType" | "id">,
): string {
  // A Knowledge Base file reads best by its name.
  if (link.objectType === "knowledge")
    return link.id.split("/").pop() ?? link.id;
  return `${paObjectTypeLabel(link.objectType)} ${link.id}`;
}

export function paWorktreeTitle(
  worktree: Pick<PaObjectLinkResolution, "id"> & {
    branch: string;
    isMain?: boolean;
  },
  projectName?: string,
): string {
  const isMain = worktree.isMain || worktree.id.startsWith("main:");
  return isMain
    ? `Main checkout${projectName ? ` · ${projectName}` : ""}`
    : worktree.branch;
}

export function fallbackPaObjectResolution(
  link: PaObjectLink,
): PaObjectLinkResolution {
  return {
    ...link,
    href: paObjectHref(link),
    title: fallbackPaObjectTitle(link),
    typeLabel: paObjectTypeLabel(link.objectType),
    existence: link.knownType ? "unknown" : "missing",
  };
}
