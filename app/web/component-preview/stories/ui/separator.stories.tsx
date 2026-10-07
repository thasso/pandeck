import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/separator.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Separator</h1>
      <div className="w-full max-w-md">
        <div>
          <p>Task-42</p>
          <p className="text-sm text-muted-foreground">
            Fix task event ordering
          </p>
        </div>
        <UI.Separator className="my-4" />
        <div className="flex items-center gap-3">
          <span>3 updates</span>
          <UI.Separator orientation="vertical" className="h-4" />
          <span>2 sessions</span>
        </div>
      </div>
    </main>
  );
}

const meta = { title: "shadcn/Separator", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
