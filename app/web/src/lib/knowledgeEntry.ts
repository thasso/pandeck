/**
 * Pure helpers for the main-pane Knowledge entry viewer. Kept framework-free and
 * deterministic so rendering logic (asset link rewriting) is unit-testable
 * without a browser or network.
 */

/**
 * When `url` is a relative entry-local asset reference (e.g. `assets/foo.png` or
 * `./assets/foo.png`), return the normalized entry-local path (`assets/foo.png`).
 * Absolute URLs, scheme URIs (`http:`, `pa:`, `mailto:`), protocol-relative
 * URLs, root-absolute paths, and pure fragments/queries return null so the
 * caller falls back to default URL handling.
 */
export function entryLocalAssetHref(url: string): string | null {
  let raw = url.trim();
  if (!raw) return null;
  if (raw.startsWith("#") || raw.startsWith("?")) return null;
  if (raw.startsWith("/") || raw.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // any scheme, incl. pa://, http://
  if (raw.startsWith("./")) raw = raw.slice(2);
  if (!raw.startsWith("assets/")) return null;
  const clean = raw.replace(/[?#].*$/, "");
  return clean.length > "assets/".length ? clean : null;
}
