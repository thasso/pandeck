import { Spinner } from "./ui/load.tsx";

/**
 * A turn's live progress line inside the transcript ("Thinking", a tool's
 * phase). The glyph is the shared `Spinner`; the label keeps the `shimmer`
 * text treatment, which `index.css` stills under `prefers-reduced-motion`
 * (R6). It carries no `role="status"` on purpose: the transcript announces
 * through the content it streams, and a live region on a line that changes
 * with every step of a turn would talk over it.
 */
export function ProgressIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1 text-caption">
      <Spinner size="sm" className="text-accent" />
      <span className="shimmer font-medium">{label}</span>
    </div>
  );
}
