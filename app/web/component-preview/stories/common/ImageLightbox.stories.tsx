import type { Meta, StoryObj } from "@storybook/react-vite";
import { ImageLightbox } from "../../../src/components/common/ImageLightbox.tsx";
const meta = {
  title: "Common/ImageLightbox",
  component: ImageLightbox,
} satisfies Meta<typeof ImageLightbox>;
export default meta;
export const Screenshot = {
  args: {
    src: "https://images.unsplash.com/photo-1557683316-973673baf926?w=1200",
    alt: "Abstract blue gradient used as a session attachment",
    caption: "Session 84 — console screenshot",
    onClose: () => {},
  },
} satisfies StoryObj<typeof meta>;
