import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/scroll-area.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">ScrollArea</h1>
      <UI.ScrollArea className="h-52 w-full max-w-sm rounded-md border p-4">
        {Array.from({ length: 12 }, (_, i) => (
          <p key={i} className="border-b py-3">
            Task-{42 - i}:{" "}
            {i % 2 ? "Review provider settings" : "Fix task event ordering"}
          </p>
        ))}
      </UI.ScrollArea>
    </main>
  );
}

const meta = { title: "shadcn/ScrollArea", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
