import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/aspect-ratio.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">AspectRatio</h1>
      <UI.AspectRatio
        ratio={16 / 9}
        className="grid max-w-lg place-items-center rounded-lg border bg-muted"
      >
        Session preview · 16:9
      </UI.AspectRatio>
    </main>
  );
}

const meta = { title: "shadcn/AspectRatio", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
