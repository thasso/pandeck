/** Whether a PDF is readable inside a frame on this engine, and what it zooms. */

import type { DocumentZoomMode } from "./documentZoom.ts";

/**
 * WebKit on iOS/iPadOS draws a framed PDF as its FIRST PAGE at native size and
 * gives it no scrolling of its own — the rest of the document is simply
 * unreachable, whatever height the frame has. Every other engine (and macOS
 * WebKit, which keeps the desktop PDF plugin) embeds one properly, so the
 * viewer keeps its frame there and offers a native tab only here.
 *
 * The test is the CSS feature `index.css` already uses to tell iOS apart:
 * `-webkit-touch-callout` exists on iOS and iPadOS only — including an
 * installed Home Screen app and the iOS shell's WKWebView, which are the same
 * engine — and, unlike the user agent string, it is not rewritten by iPadOS's
 * "Request Desktop Website" default.
 */
export function embeddedPdfScrolls(): boolean {
  return !window.CSS?.supports?.("-webkit-touch-callout", "none");
}

/**
 * What a viewer showing a PDF registers as its zoom, which follows the renderer
 * ON SCREEN (`docs/document-presentation.md`): the embedded document scales as a
 * picture, while the open-in-your-browser panel is not the document at all — it
 * has nothing for the controls to scale, so it publishes none. A control that
 * moves a scale nothing reads fails silently, which is the whole reason the
 * mode is decided per renderer rather than per file type.
 */
export function pdfZoomMode(): DocumentZoomMode | null {
  return embeddedPdfScrolls() ? "visual" : null;
}
