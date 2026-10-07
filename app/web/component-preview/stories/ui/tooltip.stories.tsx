import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/tooltip.tsx";
import * as ButtonUI from "../../../src/components/ui/button.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Tooltip</h1>
      <UI.TooltipProvider>
        <div className="flex gap-3">
          <UI.Tooltip defaultOpen>
            <UI.TooltipTrigger render={<ButtonUI.Button variant="outline" />}>
              Pause session
            </UI.TooltipTrigger>
            <UI.TooltipContent>
              Stop the agent after its current turn.
            </UI.TooltipContent>
          </UI.Tooltip>
          <UI.Tooltip>
            <UI.TooltipTrigger render={<ButtonUI.Button variant="ghost" />}>
              ⌘ K
            </UI.TooltipTrigger>
            <UI.TooltipContent>Search sessions</UI.TooltipContent>
          </UI.Tooltip>
        </div>
      </UI.TooltipProvider>
    </main>
  );
}

const meta = { title: "shadcn/Tooltip", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
