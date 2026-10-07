import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/badge.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Badge</h1>
      <div className="flex gap-2">
        {(["default", "secondary", "outline", "destructive"] as const).map(
          (v, i) => (
            <UI.Badge key={v} variant={v}>
              {["Running", "Queued", "main", "Failed"][i]}
            </UI.Badge>
          ),
        )}
      </div>
    </main>
  );
}

const meta = { title: "UI/Badge", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
