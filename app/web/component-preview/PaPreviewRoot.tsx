import { TooltipProvider } from "../src/components/ui/tooltip.tsx";
import { useLayoutEffect, type ReactNode } from "react";
import { DialogProvider } from "../src/components/common/dialogs.tsx";
import { ShortcutsProvider } from "../src/components/common/shortcuts.tsx";
import type { PreviewTextScale, PreviewTheme } from "./storyCatalog.ts";

/** Storybook-only theme experiments (component-preview/themes.css). */
export interface PreviewAppearance {
  /** A base-color palette, or "app" for the tokens in src/index.css. */
  palette: string;
  /** A colored primary, or "none". */
  accent: string;
  /** `--radius` in rem, or "app" for the index.css value. */
  radius: string;
}

const APP_APPEARANCE: PreviewAppearance = {
  palette: "app",
  accent: "none",
  radius: "app",
};

/** The attributes that put an element (the root or a compare frame) in a theme. */
export function appearanceAttributes(appearance: PreviewAppearance) {
  return {
    "data-palette":
      appearance.palette === "app" ? undefined : appearance.palette,
    "data-accent": appearance.accent === "none" ? undefined : appearance.accent,
    radius: appearance.radius === "app" ? undefined : `${appearance.radius}rem`,
  };
}

function setOrRemove(el: HTMLElement, name: string, value: string | undefined) {
  if (value === undefined) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

/** The same document-level appearance switches the production app applies. */
export function PaPreviewRoot({
  theme,
  textScale,
  appearance = APP_APPEARANCE,
  children,
}: {
  theme: PreviewTheme;
  textScale: PreviewTextScale;
  appearance?: PreviewAppearance;
  children: ReactNode;
}) {
  const { palette, accent, radius } = appearance;
  useLayoutEffect(() => {
    const root = document.documentElement;
    const wasDark = root.classList.contains("dark");
    const previousScale = root.getAttribute("data-text-scale");
    const attrs = appearanceAttributes({ palette, accent, radius });
    root.classList.toggle("dark", theme === "dark");
    root.setAttribute("data-text-scale", textScale);
    setOrRemove(root, "data-palette", attrs["data-palette"]);
    setOrRemove(root, "data-accent", attrs["data-accent"]);
    if (attrs.radius) root.style.setProperty("--radius", attrs.radius);
    else root.style.removeProperty("--radius");
    return () => {
      root.classList.toggle("dark", wasDark);
      if (previousScale === null) root.removeAttribute("data-text-scale");
      else root.setAttribute("data-text-scale", previousScale);
      root.removeAttribute("data-palette");
      root.removeAttribute("data-accent");
      root.style.removeProperty("--radius");
    };
  }, [textScale, theme, palette, accent, radius]);

  return (
    <TooltipProvider delay={400}>
      <ShortcutsProvider>
        <DialogProvider>{children}</DialogProvider>
      </ShortcutsProvider>
    </TooltipProvider>
  );
}
