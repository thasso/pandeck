import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/toggle-group.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">ToggleGroup</h1>
      <div className="grid gap-4">
        <UI.ToggleGroup defaultValue={["all"]}>
          <UI.ToggleGroupItem value="all">All</UI.ToggleGroupItem>
          <UI.ToggleGroupItem value="active">Active</UI.ToggleGroupItem>
          <UI.ToggleGroupItem value="attention">
            Needs attention
          </UI.ToggleGroupItem>
        </UI.ToggleGroup>
        <UI.ToggleGroup defaultValue={[]} variant="outline">
          <UI.ToggleGroupItem value="bug">Bug</UI.ToggleGroupItem>
          <UI.ToggleGroupItem value="feature">Feature</UI.ToggleGroupItem>
          <UI.ToggleGroupItem value="docs">Docs</UI.ToggleGroupItem>
        </UI.ToggleGroup>
      </div>
    </main>
  );
}

const meta = { title: "shadcn/ToggleGroup", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
