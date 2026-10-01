import type { DocumentTarget } from "./documentTargets.ts";

/**
 * How a served file is CLASSIFIED, in one table both halves read.
 *
 * The server decides delivery from it (`app/server/src/directFileHttp.ts`:
 * which content type, inline or attachment) and the web client decides
 * rendering from it (`app/web/src/lib/servedFiles.ts`: which card, which viewer
 * body). Two tables drifted apart once already — the server served `.py` and
 * `.css` as readable text while a card offered them only as a download, so the
 * prompt's promise that a text file gets a viewer was false for most text
 * files. Deriving both from one kind makes that disagreement unrepresentable.
 *
 * `docs/served-files.md` is the contract.
 */

export type ServedFileKind =
  /** Renders as a picture; safe as an `<img>` subresource. */
  | "image"
  /** Markdown, which the app renders itself. */
  | "markdown"
  /** Active content: runs only under a sandboxed grant, never on the API origin. */
  | "html"
  /** Readable as plain text: logs, data, source, config. */
  | "text"
  /** The browser's own viewer or player reads it (PDF, video, audio). */
  | "media"
  /** Nothing renders it; it is a download. */
  | "other";

/** Extension (no dot, lower-case) → kind. Anything absent is `other`. */
const KIND_BY_EXTENSION: Record<string, ServedFileKind> = {
  // Images
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  svg: "image",
  // Markdown
  md: "markdown",
  markdown: "markdown",
  // Active content
  html: "html",
  htm: "html",
  // Text: data and config
  txt: "text",
  log: "text",
  csv: "text",
  tsv: "text",
  json: "text",
  jsonl: "text",
  yaml: "text",
  yml: "text",
  xml: "text",
  toml: "text",
  ini: "text",
  cfg: "text",
  conf: "text",
  env: "text",
  diff: "text",
  patch: "text",
  sql: "text",
  // Text: source
  css: "text",
  js: "text",
  mjs: "text",
  cjs: "text",
  ts: "text",
  tsx: "text",
  jsx: "text",
  py: "text",
  rs: "text",
  go: "text",
  rb: "text",
  java: "text",
  c: "text",
  h: "text",
  cpp: "text",
  hpp: "text",
  sh: "text",
  bash: "text",
  zsh: "text",
  nix: "text",
  // Media
  pdf: "media",
  mp4: "media",
  webm: "media",
  mov: "media",
  m4v: "media",
  ogv: "media",
  ogg: "media",
  mp3: "media",
  wav: "media",
  m4a: "media",
  aac: "media",
  flac: "media",
};

/** Exact MIME for shared inline image/media kinds. Text is normalized below. */
const INLINE_CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  ogv: "video/ogg",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
};

function extensionOf(nameOrPath: string): string {
  const name = nameOrPath.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The kind of one file, by its name or path. */
export function servedFileKindOf(nameOrPath: string): ServedFileKind {
  const extension = extensionOf(nameOrPath);
  return extension ? (KIND_BY_EXTENSION[extension] ?? "other") : "other";
}

/** Native browser player element for every shared media extension except PDF. */
export function servedFileMediaElementOf(
  nameOrPath: string,
): "audio" | "video" | null {
  const extension = extensionOf(nameOrPath);
  if (["ogg", "mp3", "wav", "m4a", "aac", "flac"].includes(extension))
    return "audio";
  if (["mp4", "webm", "mov", "m4v", "ogv"].includes(extension)) return "video";
  return null;
}

/** MIME advertised by an inline response for one shared file kind. */
export function servedFileInlineContentTypeOf(nameOrPath: string): string {
  const kind = servedFileKindOf(nameOrPath);
  if (kind === "markdown" || kind === "text")
    return "text/plain; charset=utf-8";
  return (
    INLINE_CONTENT_TYPE_BY_EXTENSION[extensionOf(nameOrPath)] ??
    "application/octet-stream"
  );
}

/** How the server hands a kind to the browser. */
export type ServedFileDelivery = "image" | "text" | "media" | "download";

/** Bounds and response semantics encoded into a token-free file grant. */
export type FileGrantScope = "directory" | "file";
export type FileGrantDeliveryMode = "inline" | "attachment";

export interface MintFileGrantRequest {
  /** Typed source identity; the server resolves it through the owning root. */
  target: DocumentTarget;
  scope: FileGrantScope;
  delivery: FileGrantDeliveryMode;
  /** Explicit renewal/error recovery must mint a different capability URL. */
  fresh?: boolean;
}

export interface MintFileGrantResponse {
  url: string;
  expiresAt: number;
  delivery: FileGrantDeliveryMode;
}

/**
 * Markdown and text go out as `text/plain` — the one document type that cannot
 * execute — while HTML joins the unrenderable rest as a download. That is the
 * rule that keeps the token-bearing `/api/files/` route from ever running
 * agent-written script.
 */
export function servedFileDeliveryOf(kind: ServedFileKind): ServedFileDelivery {
  switch (kind) {
    case "image":
      return "image";
    case "markdown":
    case "text":
      return "text";
    case "media":
      return "media";
    case "html":
    case "other":
      return "download";
  }
}

/** Kinds the app itself renders, rather than handing over as a download. */
export function servedFileRendersInApp(kind: ServedFileKind): boolean {
  return kind !== "other";
}
