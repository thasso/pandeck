import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/label.tsx";
import * as InputUI from "../../../src/components/ui/input.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Label</h1>
      <div className="grid w-full max-w-sm gap-2">
        <UI.Label htmlFor="workspace">Workspace name</UI.Label>
        <InputUI.Input id="workspace" defaultValue="Pandeck" />
      </div>
    </main>
  );
}

const meta = { title: "UI/Label", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
