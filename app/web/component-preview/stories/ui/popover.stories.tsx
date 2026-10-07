import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/popover.tsx";
import * as ButtonUI from "../../../src/components/ui/button.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Popover</h1>
      <UI.Popover defaultOpen>
        <UI.PopoverTrigger render={<ButtonUI.Button variant="outline" />}>
          Session details
        </UI.PopoverTrigger>
        <UI.PopoverContent>
          <UI.PopoverHeader>
            <UI.PopoverTitle>Fix task sync</UI.PopoverTitle>
            <UI.PopoverDescription>Running in task-sync</UI.PopoverDescription>
          </UI.PopoverHeader>
          <p>Last update: pnpm test passed.</p>
        </UI.PopoverContent>
      </UI.Popover>
    </main>
  );
}

const meta = { title: "shadcn/Popover", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
