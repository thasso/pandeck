import { basename, extname } from "node:path";

const INLINE_RASTER_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
]);

/** Headers that keep active artifact content from executing on the API origin. */
export function sessionArtifactDeliveryHeaders(
  path: string,
  requestUrl: URL,
): Record<string, string> {
  const explicitDownload = requestUrl.searchParams.get("download") === "1";
  const inlineRaster = INLINE_RASTER_EXTENSIONS.has(
    extname(path).toLowerCase(),
  );
  const forceDownload = explicitDownload || !inlineRaster;
  if (!forceDownload) return { "x-content-type-options": "nosniff" };

  const requestedName = requestUrl.searchParams.get("name")?.trim();
  return {
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "content-disposition": attachmentContentDisposition(
      requestedName || basename(path),
    ),
  };
}

function attachmentContentDisposition(name: string): string {
  const clean = name.replace(/[\r\n\0]/g, "_").slice(0, 255) || "download";
  const fallback = clean.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(clean).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
