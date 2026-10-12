import { cn } from "cn";

/**
 * Lucide's `LoaderCircle`, with the arc turning INSIDE a still `<svg>`. WebKit
 * (Safari, the Tauri shell) paints a spinning `<svg>` snapped to the pixel grid
 * but rotates it about its unsnapped center, so at a fractional offset the
 * whole glyph orbits by about a pixel. Rotating the path in the icon's own
 * coordinates keeps that snap constant from frame to frame.
 */
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-4", className)}
      {...props}
    >
      <path
        d="M21 12a9 9 0 1 1-6.219-8.56"
        className="origin-center [transform-box:view-box] motion-safe:animate-spin"
      />
    </svg>
  );
}

export { Spinner };
