import { useLayoutEffect, type ReactNode } from "react";
import type { LayoutMode } from "../../hooks/usePrefs.ts";
import { MobileLayoutContext, useMobileLayout } from "./useMobileLayout.ts";

/** One resolved layout for the shell, its descendants and body-portaled chrome. */
export function LayoutProvider({
  mode,
  children,
}: {
  mode: LayoutMode;
  children: ReactNode;
}) {
  const automaticMobile = useMobileLayout();
  const mobile = mode === "mobile" || (mode !== "desktop" && automaticMobile);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-layout", mobile ? "mobile" : "desktop");
    return () => root.removeAttribute("data-layout");
  }, [mobile]);

  return (
    <MobileLayoutContext.Provider value={mobile}>
      {children}
    </MobileLayoutContext.Provider>
  );
}
