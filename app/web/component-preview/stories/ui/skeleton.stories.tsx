import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/skeleton.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Skeleton</h1>
      <div className="flex w-full max-w-md gap-4">
        <UI.Skeleton className="size-10 rounded-full" />
        <div className="grid flex-1 gap-2">
          <UI.Skeleton className="h-4 w-2/5" />
          <UI.Skeleton className="h-3 w-4/5" />
          <UI.Skeleton className="h-3 w-3/5" />
        </div>
      </div>
    </main>
  );
}

const meta = { title: "UI/Skeleton", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
