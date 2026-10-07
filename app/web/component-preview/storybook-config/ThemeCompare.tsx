import type { ReactNode } from "react";
import {
  appearanceAttributes,
  type PreviewAppearance,
} from "../PaPreviewRoot.tsx";
import type { PreviewTheme } from "../storyCatalog.ts";

export const PALETTES = [
  "app",
  "neutral",
  "zinc",
  "slate",
  "gray",
  "stone",
  "mauve",
  "olive",
  "mist",
  "taupe",
];
export const ACCENTS = [
  "none",
  "blue",
  "indigo",
  "violet",
  "teal",
  "green",
  "orange",
  "rose",
];
export const RADII = ["app", "0", "0.25", "0.375", "0.5", "0.75", "1"];

export type CompareMode = "off" | "modes" | "palettes" | "accents" | "all";

interface Frame {
  theme: PreviewTheme;
  appearance: PreviewAppearance;
}

export function compareFrames(
  mode: CompareMode,
  theme: PreviewTheme,
  appearance: PreviewAppearance,
): Frame[] {
  const both: PreviewTheme[] = ["light", "dark"];
  switch (mode) {
    case "modes":
      return both.map((t) => ({ theme: t, appearance }));
    case "palettes":
      return PALETTES.map((palette) => ({
        theme,
        appearance: { ...appearance, palette },
      }));
    case "accents":
      return ACCENTS.map((accent) => ({
        theme,
        appearance: { ...appearance, accent },
      }));
    case "all":
      return PALETTES.flatMap((palette) =>
        both.map((t) => ({ theme: t, appearance: { ...appearance, palette } })),
      );
    case "off":
      return [];
  }
}

function frameLabel({ theme, appearance }: Frame) {
  const parts = [appearance.palette, theme];
  if (appearance.accent !== "none") parts.push(appearance.accent);
  if (appearance.radius !== "app") parts.push(`r ${appearance.radius}`);
  return parts.join(" · ");
}

/**
 * Renders the story once per frame, each frame scoped to its own theme. Portaled
 * content (popovers, dialogs, toasts) renders on <body> and so shows the page
 * theme, not the frame's: compare those one theme at a time.
 */
export function ThemeCompare({
  frames,
  render,
}: {
  frames: Frame[];
  render: () => ReactNode;
}) {
  return (
    <div className="h-dvh overflow-auto bg-muted p-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(26rem,1fr))] gap-4">
        {frames.map((frame) => {
          const { radius, ...attrs } = appearanceAttributes(frame.appearance);
          return (
            <section
              key={frameLabel(frame)}
              {...attrs}
              className={`${frame.theme === "dark" ? "dark " : ""}flex min-w-0 flex-col overflow-hidden rounded-lg border bg-background text-foreground`}
              style={radius ? { ["--radius" as string]: radius } : undefined}
            >
              <header className="border-b px-3 py-1.5 font-mono text-xs text-muted-foreground">
                {frameLabel(frame)}
              </header>
              {/* Stories fill the canvas (`min-h-screen`); a frame sizes to content. */}
              <div className="relative min-h-40 flex-1 overflow-auto *:min-h-0!">
                {render()}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
