import type { Preview } from "@storybook/react-vite";
import { PaPreviewRoot } from "../PaPreviewRoot.tsx";
import "../preview.css";

const preview: Preview = {
  decorators: [
    (Story, context) => (
      <PaPreviewRoot
        theme={context.globals.theme === "dark" ? "dark" : "light"}
        textScale={
          ["100", "110", "120", "130"].includes(context.globals.textScale)
            ? context.globals.textScale
            : "100"
        }
      >
        <Story />
      </PaPreviewRoot>
    ),
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
