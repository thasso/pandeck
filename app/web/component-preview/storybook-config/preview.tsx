import type { Preview } from "@storybook/react-vite";
import { PaPreviewRoot, type PreviewAppearance } from "../PaPreviewRoot.tsx";
import type { PreviewTextScale, PreviewTheme } from "../storyCatalog.ts";
import {
  ACCENTS,
  compareFrames,
  PALETTES,
  RADII,
  ThemeCompare,
  type CompareMode,
} from "./ThemeCompare.tsx";
import "../preview.css";

function pick<T extends string>(value: unknown, options: readonly T[]): T {
  return options.includes(value as T) ? (value as T) : options[0];
}

const preview: Preview = {
  decorators: [
    (Story, context) => {
      const { globals } = context;
      const theme = pick<PreviewTheme>(globals.theme, ["light", "dark"]);
      const textScale = pick<PreviewTextScale>(globals.textScale, [
        "100",
        "110",
        "120",
        "130",
      ]);
      const appearance: PreviewAppearance = {
        palette: pick(globals.palette, PALETTES),
        accent: pick(globals.accent, ACCENTS),
        radius: pick(globals.radius, RADII),
      };
      const compare = pick<CompareMode>(globals.compare, [
        "off",
        "modes",
        "palettes",
        "accents",
        "all",
      ]);
      if (compare === "off") {
        return (
          <PaPreviewRoot
            theme={theme}
            textScale={textScale}
            appearance={appearance}
          >
            <Story />
          </PaPreviewRoot>
        );
      }
      // The page itself stays on the app's light theme; each frame themes itself.
      return (
        <PaPreviewRoot theme="light" textScale={textScale}>
          <ThemeCompare
            frames={compareFrames(compare, theme, appearance)}
            render={() => <Story />}
          />
        </PaPreviewRoot>
      );
    },
  ],
  globalTypes: {
    theme: {
      description: "PA color theme",
      toolbar: {
        icon: "mirror",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
      },
    },
    palette: {
      description: "Base color palette (app = src/index.css)",
      toolbar: { icon: "paintbrush", items: PALETTES, dynamicTitle: true },
    },
    accent: {
      description: "Accent color for primary / ring / charts",
      toolbar: { icon: "circle", items: ACCENTS, dynamicTitle: true },
    },
    radius: {
      description: "--radius in rem (app = src/index.css)",
      toolbar: { icon: "component", items: RADII, dynamicTitle: true },
    },
    compare: {
      description: "Render the story in several themes side by side",
      toolbar: {
        icon: "sidebyside",
        dynamicTitle: true,
        items: [
          { value: "off", title: "Compare: off" },
          { value: "modes", title: "Light + dark" },
          { value: "palettes", title: "All palettes" },
          { value: "accents", title: "All accents" },
          { value: "all", title: "All palettes, light + dark" },
        ],
      },
    },
    textScale: {
      description: "PA browser text scale",
      toolbar: {
        icon: "paragraph",
        items: ["100", "110", "120", "130"],
      },
    },
  },
  initialGlobals: {
    theme: "light",
    palette: "app",
    accent: "none",
    radius: "app",
    compare: "off",
    textScale: "100",
    viewport: { value: "paDesktop", isRotated: false },
  },
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true },
    viewport: {
      options: {
        paDesktop: {
          name: "PA desktop canvas",
          styles: { width: "1024px", height: "720px" },
          type: "desktop",
        },
        paPhone: {
          name: "PA phone",
          styles: { width: "390px", height: "720px" },
          type: "mobile",
        },
      },
    },
  },
};

export default preview;
