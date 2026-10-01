import { useEffect, useState } from "react";

/**
 * The single breakpoint below which the shell collapses to the main pane and
 * side panels render as full-screen overlays (see app/web/docs/ui-shell.md).
 */
export const MOBILE_LAYOUT_QUERY = "(max-width: 767px)";

/** Reactive flag for the shell's mobile (single-pane) layout mode. */
export function useMobileLayout(): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia(MOBILE_LAYOUT_QUERY).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return mobile;
}
