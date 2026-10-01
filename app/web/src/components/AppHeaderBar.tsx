import type { ReactNode } from "react";

/**
 * @component AppHeaderBar
 * @purpose Shared compact header shell for the global app Header Bar, full-screen pages, and panel headers.
 * @useWhen A surface needs the standard 2.25rem toolbar row, bottom border, translucent blurred desktop background, and optional notch-safe top padding.
 * @avoidWhen Rendering a sub-section header inside scrolling content (use a plain row instead) or adding route-specific actions to the global Header Bar.
 * @intent One coherent, low-height header treatment across surfaces. The global app Header Bar and true full-screen surfaces keep safeAreaTop enabled; panels that live below the app topbar disable it to avoid double notch spacing. Use transparent chrome only to reserve header height over an already-visible matching header.
 * @related Topbar, SettingsPage, TaskManagementPage.
 */
export function AppHeaderBar({
  className = "gap-2",
  safeAreaTop = true,
  chrome = "default",
  ariaHidden = false,
  dragRegion = false,
  children,
}: {
  className?: string;
  safeAreaTop?: boolean;
  chrome?: "default" | "transparent";
  ariaHidden?: boolean;
  /**
   * Make the bar itself drag the native window (see `lib/nativeShell.ts`). Only
   * the bar: the native handler acts on its own element, so children stay
   * clickable without opting out one by one. Inert in a browser.
   */
  dragRegion?: boolean;
  children?: ReactNode;
}) {
  const topPadding = safeAreaTop
    ? "pt-[calc(0.125rem_+_var(--app-safe-area-top))]"
    : "pt-0.5";
  const chromeClass =
    chrome === "transparent"
      ? "border-b border-transparent bg-transparent sm:bg-transparent sm:backdrop-blur-none"
      : "border-b border-line bg-surface sm:bg-surface/80 sm:backdrop-blur";
  return (
    <header
      aria-hidden={ariaHidden || undefined}
      data-tauri-drag-region={dragRegion || undefined}
      className={`flex min-h-9 items-center px-2 pb-0.5 ${topPadding} sm:h-9 sm:py-0 ${chromeClass} ${className}`}
    >
      {children}
    </header>
  );
}
