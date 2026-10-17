import { useLayoutEffect, useRef } from "react";
import { cn } from "cn";

/**
 * Lucide's `LoaderCircle`, turning as a whole `<svg>` so the browser runs it on
 * the compositor. Turning the path INSIDE a still `<svg>` instead (#107) is
 * never composited in Chrome: every frame re-ran style, layout and paint on the
 * main thread, which with a session running cost an idle tab ~35% of a core at
 * 120 Hz.
 *
 * WebKit (Safari, the Tauri shell) snaps a spinning box to the device-pixel
 * grid but turns it about its unsnapped center, so at a fractional offset the
 * glyph orbits by up to a pixel. `snapToDevicePixels` moves the box onto the
 * grid with opposing margins (a layout offset, which the snap sees; a
 * `translate` would be applied after it), so snapped and unsnapped coincide.
 */
function Spinner({
  className,
  ...props
}: Omit<React.ComponentProps<"svg">, "ref">) {
  const ref = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    snapToDevicePixels(svg);
    // A row can move without resizing (a list re-sorts), so re-check once per
    // turn: one rect read a second, and a write only when the offset changed.
    const resnap = () => snapToDevicePixels(svg);
    svg.addEventListener("animationiteration", resnap);
    return () => svg.removeEventListener("animationiteration", resnap);
  }, []);
  return (
    <svg
      ref={ref}
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-4 motion-safe:animate-spin", className)}
      {...props}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

const SNAP_X = "--spinner-snap-x";
const SNAP_Y = "--spinner-snap-y";

/**
 * Shift `svg` by under a device pixel so its box starts on the grid. Opposing
 * margins move the box without changing the space it takes, in inline, flex and
 * absolute layouts alike. The rect's center is used because a turning box's
 * rect is its rotated bounds; the center does not move with the rotation.
 */
function snapToDevicePixels(svg: SVGSVGElement) {
  const dpr = window.devicePixelRatio || 1;
  const rect = svg.getBoundingClientRect();
  const { clientWidth: width, clientHeight: height } = svg;
  if (!width || !height) return;
  const style = svg.style;
  const prevX = Number.parseFloat(style.getPropertyValue(SNAP_X)) || 0;
  const prevY = Number.parseFloat(style.getPropertyValue(SNAP_Y)) || 0;
  const left = (rect.left + rect.right) / 2 - width / 2 - prevX;
  const top = (rect.top + rect.bottom) / 2 - height / 2 - prevY;
  const x = toGrid(left, dpr);
  const y = toGrid(top, dpr);
  if (Math.abs(x - prevX) < 0.01 && Math.abs(y - prevY) < 0.01) return;
  style.setProperty(SNAP_X, `${x}px`);
  style.setProperty(SNAP_Y, `${y}px`);
  style.setProperty("margin", `${y}px ${-x}px ${-y}px ${x}px`);
}

/** The shift onto the grid, rounded so the margin stays a short literal. */
function toGrid(at: number, dpr: number) {
  return Number((Math.round(at * dpr) / dpr - at).toFixed(3));
}

export { Spinner };
