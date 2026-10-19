import { createContext, useContext, useEffect, useState } from "react";

/** Shared resolved layout. Null lets isolated previews follow window width. */
export const MobileLayoutContext = createContext<boolean | null>(null);

/**
 * Automatic layout's breakpoint. Explicit Desktop and Mobile choices ignore
 * it (see app/web/docs/ui-shell.md).
 */
export const MOBILE_LAYOUT_QUERY = "(max-width: 767px)";

/** Resolved shell layout, or reactive window width outside LayoutProvider. */
export function useMobileLayout(): boolean {
  const provided = useContext(MobileLayoutContext);
  const [mobile, setMobile] = useState(
    () =>
      provided ??
      (typeof window !== "undefined" &&
        window.matchMedia(MOBILE_LAYOUT_QUERY).matches),
  );

  useEffect(() => {
    if (provided !== null) return;
    const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [provided]);

  return provided ?? mobile;
}
