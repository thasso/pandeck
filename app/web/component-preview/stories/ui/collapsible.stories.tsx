import type { Meta, StoryObj } from "@storybook/react-vite";
import * as UI from "../../../src/components/ui/collapsible.tsx";

function Gallery() {
  return (
    <main className="flex min-h-screen flex-col items-start gap-6 bg-background p-8 text-foreground">
      <h1 className="text-xl font-semibold">Collapsible</h1>
      <UI.Collapsible defaultOpen>
        <UI.CollapsibleTrigger>Recent tool output</UI.CollapsibleTrigger>
        <UI.CollapsibleContent className="mt-2 rounded-md bg-muted p-4">
          pnpm test: 148 passed · 3.2s
        </UI.CollapsibleContent>
      </UI.Collapsible>
    </main>
  );
}

const meta = { title: "shadcn/Collapsible", component: Gallery } satisfies Meta<
  typeof Gallery
>;
export default meta;
export const Default = {} satisfies StoryObj<typeof meta>;
