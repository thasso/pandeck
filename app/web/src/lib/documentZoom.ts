export type DocumentZoomMode = "text" | "visual";

export const DOCUMENT_ZOOM_DEFAULT = 1;
const DOCUMENT_ZOOM_STEP = 0.25;
export const DOCUMENT_ZOOM_BOUNDS: Record<
  DocumentZoomMode,
  { min: number; max: number }
> = {
  text: { min: 0.75, max: 2 },
  visual: { min: 0.5, max: 4 },
};

export function clampDocumentZoom(
  mode: DocumentZoomMode,
  value: number,
): number {
  const { min, max } = DOCUMENT_ZOOM_BOUNDS[mode];
  if (!Number.isFinite(value)) return DOCUMENT_ZOOM_DEFAULT;
  return Math.min(max, Math.max(min, value));
}

export function steppedDocumentZoom(
  mode: DocumentZoomMode,
  scale: number,
  direction: -1 | 1,
): number {
  return clampDocumentZoom(mode, scale + direction * DOCUMENT_ZOOM_STEP);
}
