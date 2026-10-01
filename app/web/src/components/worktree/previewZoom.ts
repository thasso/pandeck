import type { DocumentZoomMode } from "../../lib/documentZoom.ts";

/** Which pane of a worktree file the reader is on. */
export type FilePivot = "file" | "preview" | "vs-base";

/** How a file can render beyond source: browser-native image, or a rendered document. */
export type PreviewKind = "raster" | "svg" | "markdown" | "html";

const RASTER_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
]);

export function previewKindForPath(path: string): PreviewKind | undefined {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (RASTER_EXTENSIONS.has(ext)) return "raster";
  if (ext === "svg") return "svg";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  return undefined;
}

/**
 * The zoom a worktree document answers to, decided by the renderer that is
 * ACTUALLY on screen rather than by the pivot's name. Changes and a source pane
 * are pierre text. Preview is whatever it previews: a rendered Markdown
 * document reflows through the typography roles like every other text body,
 * while an SVG or HTML document is scaled as a picture. An image is the case
 * where the pivot's name lies outright — it has no Preview pivot at all,
 * because its File pivot already IS the picture. Getting this wrong is silent:
 * the controls move a scale nothing on screen reads
 * (`docs/document-presentation.md`).
 */
export function worktreeZoomMode(
  view: "file" | "diff",
  pivot: FilePivot,
  previewKind: PreviewKind | undefined,
): DocumentZoomMode {
  if (view === "diff") return "text";
  // An image has no source worth reading, so it gets no separate Preview
  // pivot: the File pivot IS the picture, and zoom has to scale it.
  if (previewKind === "raster" && pivot !== "vs-base") return "visual";
  if (pivot !== "preview") return "text";
  return previewKind === "markdown" ? "text" : "visual";
}
