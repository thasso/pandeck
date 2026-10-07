import { TooltipProvider } from "../src/components/ui/tooltip.tsx";
import { useLayoutEffect, type ReactNode } from "react";
import { DialogProvider } from "../src/components/common/dialogs.tsx";
import { ShortcutsProvider } from "../src/components/common/shortcuts.tsx";
import type { PreviewTextScale, PreviewTheme } from "./storyCatalog.ts";

/** The same document-level appearance switches the production app applies. */
export function PaPreviewRoot({
  theme,
  textScale,
  children,
}: {
  theme: PreviewTheme;
  textScale: PreviewTextScale;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const wasDark = root.classList.contains("dark");
    const previousScale = root.getAttribute("data-text-scale");
    root.classList.toggle("dark", theme === "dark");
    root.setAttribute("data-text-scale", textScale);
    return () => {
      root.classList.toggle("dark", wasDark);
      if (previousScale === null) root.removeAttribute("data-text-scale");
      else root.setAttribute("data-text-scale", previousScale);
    };
  }, [textScale, theme]);

  return (
    <TooltipProvider delay={400}>
      <ShortcutsProvider>
        <DialogProvider>{children}</DialogProvider>
      </ShortcutsProvider>
    </TooltipProvider>
  );
}
