import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/progress.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Progress</h1>
      <div className="grid w-full max-w-md gap-5">
        <UI.Progress value={68}>
          <UI.ProgressLabel>Workspace setup</UI.ProgressLabel>
          <UI.ProgressValue />
        </UI.Progress>
        <UI.Progress value={100}>
          <UI.ProgressLabel>Tests complete</UI.ProgressLabel>
          <UI.ProgressValue />
        </UI.Progress>
      </div>
    </main>
  );
}

const meta = { title: "shadcn/Progress", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
